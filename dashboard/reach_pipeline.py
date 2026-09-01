"""Recomputes hospital/ambulance/blood-bank road-route reach + the district
scorecard against whichever accidents CSV is currently active.

Runs in a background thread so uploading a new dataset doesn't block the
request — the frontend polls get_status() until it reports "done".
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import socket
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

from db import fetch_all

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
DATA_DIR = os.path.abspath(DATA_DIR)

STRAIGHT_BUFFER_KM = 75.0
CANDIDATE_SEND_CAP = 25
# Keep every candidate we measured (not just the nearest 12). The Grid Analysis
# view lets the user filter reach by hospital type, so we must retain the nearest
# hospital of EACH type within range, not only the globally-nearest handful —
# otherwise a type filter could wrongly mark a cell unreachable. Same OSRM cost
# (we still only send CANDIDATE_SEND_CAP), just no post-hoc truncation.
CANDIDATE_KEEP_CAP = 25
# Coverage measured against the 22 District Hospitals only. At a 20 km road
# reach every district's rural periphery falls outside coverage, so unreachable
# (red) areas appear in all 22 Haryana districts.
DEFAULT_THRESHOLD_KM = 20.0

# OSRM endpoint is configurable so a full-scale precompute (e.g. 35k accidents)
# can point at a SELF-HOSTED OSRM instead of the public demo server, which is
# rate-limited to ~1 req/s and unsuitable for tens of thousands of requests.
#   export OSRM_BASE=http://localhost:5000        # self-hosted OSRM
#   export OSRM_SLEEP=0                            # no throttle when self-hosted
# Defaults keep the original public-server behaviour.
OSRM_BASE = os.environ.get("OSRM_BASE", "https://router.project-osrm.org").rstrip("/")
# Per-request pause between accidents. Public OSRM needs throttling; a local
# OSRM can set this to 0 for maximum throughput.
OSRM_SLEEP = float(os.environ.get("OSRM_SLEEP", "0.1"))
# Write the output file every N accidents so a long run can be resumed if it's
# interrupted (see _run_facility_job).
CHECKPOINT_EVERY = int(os.environ.get("REACH_CHECKPOINT_EVERY", "200"))
OSRM_URL = OSRM_BASE + "/table/v1/driving/{coords}?sources=0&annotations=distance"
OSRM_ROUTE_URL = OSRM_BASE + "/route/v1/driving/{coords}?overview=full&geometries=geojson"

# How far OSRM may drag a clicked point onto the road network before the answer
# stops being about the point that was clicked.
#
# THIS IS THE FIX FOR A SILENT WRONG ANSWER, not a tidy-up. OSRM snaps to the
# nearest node in its graph NO MATTER HOW FAR, and still replies code:"Ok".
# The graph here is clipped to Haryana, so two points clicked over Bikaner
# (~110 km west of the extract) were both snapped to the SAME boundary node:
# OSRM returned distance 0, the app printed "0.00 km road" for a 21 km leg, and
# drew the route as a stray line at the clip edge. Nothing in the response said
# anything was wrong.
#
# 5 km is deliberately generous — a genuine rural point in Haryana can sit a
# couple of kilometres from the nearest mapped road, and those are legitimate
# measurements. Beyond 5 km the snap is no longer a correction, it is a
# different location.
MAX_SNAP_KM = 5.0
OSRM_BBOX_LABEL = os.environ.get("OSRM_BBOX_LABEL", "74.45–77.65 E, 27.65–30.90 N")


def _max_snap_km(waypoints) -> float | None:
    """The furthest OSRM moved any input point, in km.

    OSRM reports this per waypoint as `distance` (metres from the requested
    coordinate to where it snapped). Absent on some builds, in which case there
    is nothing to check and None means "cannot tell" rather than "fine".
    """
    if not waypoints:
        return None
    seen = [w.get("distance") for w in waypoints if isinstance(w.get("distance"), (int, float))]
    return max(seen) / 1000.0 if seen else None

FACILITY_JOBS = [
    {
        "key": "hospital",
        "table": "public.haryana_hosp",
        "name_col": "hospital_name",
        "type_col": "hosp_type",
        "out_file": "accident_hospital_safety_v2.json",
    },
    {
        "key": "ambulance",
        "table": "public.haryana_ambulance",
        "name_col": "vehicle_no",
        "type_col": "vehicle_type",
        "out_file": "accident_ambulance_safety_v2.json",
    },
    {
        "key": "bloodbank",
        "table": "public.haryana_bloodbanks",
        "name_col": "blood_centre_name",
        "type_col": None,
        "out_file": "accident_bloodbank_safety_v2.json",
    },
]

DISTRICT_ALIASES = {
    "MEWAT": "NUH",
    "HISSAR": "HISAR",
    "SONEPAT": "SONIPAT",
    "NARNAUL": "MAHENDRAGARH",
    "N U H": "NUH",
    "JAGADHRI": "YAMUNANAGAR",
    "YAMUNA NAGAR": "YAMUNANAGAR",
}

SEVERITIES = [
    "Fatal",
    "Grievous Injury",
    "Minor Injury Hospitalized",
    "Minor Injury Non-Hospitalized",
    "Non-Injury",
]
SEVERITY_WEIGHTS = {"Fatal": 5, "Grievous Injury": 3, "Minor Injury Hospitalized": 2, "Minor Injury Non-Hospitalized": 1, "Non-Injury": 0.5}

_lock = threading.Lock()
_status: dict[str, Any] = {
    "state": "idle",
    "facility": None,
    "progress": {"done": 0, "total": 0},
    "started_at": None,
    "finished_at": None,
    "error": None,
}


def get_status() -> dict[str, Any]:
    with _lock:
        return dict(_status)


def _set_status(**kwargs) -> None:
    with _lock:
        _status.update(kwargs)


def _norm_district(name: str) -> str:
    n = (name or "").strip().upper()
    n = n.replace("YAMUNA NAGAR", "YAMUNANAGAR")
    return DISTRICT_ALIASES.get(n, n)


def _haversine_km(lat1, lon1, lat2, lon2) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _load_facilities(table: str) -> list[dict]:
    rows = fetch_all(
        f'SELECT * FROM {table} WHERE latitude IS NOT NULL AND longitude IS NOT NULL'
    )
    return [dict(r) for r in rows]


def measure_route(lat1: float, lon1: float, lat2: float, lon2: float) -> dict[str, Any]:
    """Straight-line and OSRM driving distance between two map points.

    WHY THIS REPORTS A REASON. The previous version wrapped the whole OSRM call
    in `except Exception: sleep(1)` and returned `road_km: None` with nothing
    else. Every possible failure — OSRM not running, wrong port, the public demo
    server rate-limiting us, a genuine no-route — collapsed into the same blank
    dash in the ruler panel, so "the road distance isn't showing up" was
    undiagnosable from the UI. The failure mode is now named and handed to the
    client, which prints it.

    Fail-fast, too. Three attempts at a 20 s timeout with a 1 s sleep between
    them meant a dead OSRM made the user wait up to 63 seconds per leg before
    showing nothing. A routing call that has not answered in 6 s is not going to.
    """
    straight_km = round(_haversine_km(lat1, lon1, lat2, lon2), 2)
    coords = f"{lon1},{lat1};{lon2},{lat2}"
    url = OSRM_ROUTE_URL.format(coords=coords)
    road_km: float | None = None
    duration_s: float | None = None
    route_geometry: dict | None = None
    reason: str | None = None
    # How far OSRM had to move the worst of the two points to reach a road.
    # Returned even on success so the ruler can distinguish "measured from
    # exactly where you clicked" from "measured from 3 km up the road".
    snap_km: float | None = None
    off_graph = False

    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=6) as resp:
                data = json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            # 429 from the public demo server is the single most likely cause
            # when OSRM_BASE was never exported — say so instead of retrying
            # into the same wall.
            if exc.code == 429:
                reason = (
                    f"OSRM at {OSRM_BASE} is rate-limiting this app (HTTP 429). "
                    "That is the public demo server's throttle — start the local "
                    "OSRM container and export OSRM_BASE=http://127.0.0.1:5000."
                )
                break
            reason = f"OSRM at {OSRM_BASE} returned HTTP {exc.code}."
        except urllib.error.URLError as exc:
            reason = (
                f"Cannot reach OSRM at {OSRM_BASE} ({exc.reason}). "
                "Start it with scripts/setup_osrm.sh, or export OSRM_BASE to a "
                "reachable router."
            )
        except (TimeoutError, socket.timeout):
            reason = f"OSRM at {OSRM_BASE} did not answer within 6 seconds."
        except Exception as exc:  # noqa: BLE001 — last resort, still named
            reason = f"OSRM request failed: {type(exc).__name__}: {exc}"
        else:
            code = data.get("code")
            if code == "Ok" and data.get("routes"):
                # SNAP CHECK — see MAX_SNAP_KM.
                snap_km = _max_snap_km(data.get("waypoints"))
                if snap_km is not None and snap_km > MAX_SNAP_KM:
                    off_graph = True
                    reason = (
                        f"Outside the routing area. The nearest road in the graph is "
                        f"{snap_km:.0f} km from the point you clicked, so OSRM moved it "
                        f"there before measuring. The graph covers Haryana only "
                        f"(roughly {OSRM_BBOX_LABEL}); a point beyond that cannot be "
                        f"measured by road."
                    )
                    break
                route = data["routes"][0]
                road_km = round(route["distance"] / 1000.0, 2)
                duration_s = round(route.get("duration", 0), 0)
                route_geometry = route.get("geometry")
                reason = None
                break
            if code == "NoRoute":
                # Not an outage: OSRM answered and said these two points are not
                # connected by the driving network it was built with. Retrying
                # cannot change that.
                reason = (
                    "OSRM found no driving route between these two points — "
                    "one of them is probably off the road network (in water, "
                    "or outside the Haryana extract)."
                )
                break
            reason = f"OSRM answered with code {code!r}."

        if attempt < 2:
            time.sleep(0.4)

    return {
        "straight_km": straight_km,
        "road_km": road_km,
        "duration_s": duration_s,
        "route_geometry": route_geometry,
        "osrm_ok": road_km is not None,
        # Present only on failure. The ruler prints it verbatim.
        "reason": reason,
        # How far the worst point was snapped, and whether that was far enough
        # to reject the answer. `off_graph` lets the client say "outside the
        # routing area" specifically, rather than lumping it in with an outage.
        "snap_km": round(snap_km, 2) if snap_km is not None else None,
        "off_graph": off_graph,
        "osrm_base": OSRM_BASE,
    }


def _osrm_table(lat: float, lon: float, candidates: list[dict]) -> list[float] | None:
    coords = [f"{lon},{lat}"] + [f"{h['longitude']},{h['latitude']}" for h in candidates]
    url = OSRM_URL.format(coords=";".join(coords))
    for _ in range(3):
        try:
            with urllib.request.urlopen(url, timeout=15) as resp:
                data = json.loads(resp.read())
            if data.get("code") == "Ok":
                return data["distances"][0][1:]
            return None
        except Exception:
            time.sleep(1.0)
    return None


def _read_active_accidents() -> list[dict]:
    from dataset_manager import iter_active_accidents

    return list(iter_active_accidents())


def _dataset_fingerprint(accidents: list[dict]) -> str:
    """Stable signature of the accident set so a resumed run only reuses work
    from the SAME dataset (a different CSV invalidates old partial output)."""
    ids = [str(a.get("accident_id_sp", "")) for a in accidents]
    h = hashlib.sha1("\n".join(ids).encode("utf-8")).hexdigest()[:16]
    return f"{len(ids)}:{h}"


def _candidates_for(job: dict, facilities: list[dict], alat: float, alon: float) -> list[dict]:
    scored = []
    for h in facilities:
        d = _haversine_km(alat, alon, h["latitude"], h["longitude"])
        if d <= STRAIGHT_BUFFER_KM:
            scored.append((d, h))
    scored.sort(key=lambda x: x[0])
    candidates = [h for _, h in scored[:CANDIDATE_SEND_CAP]]

    kept: list[dict] = []
    if candidates:
        road_distances = _osrm_table(alat, alon, candidates)
        if road_distances:
            paired = []
            for h, d_m in zip(candidates, road_distances):
                if d_m is None:
                    continue
                paired.append((d_m / 1000.0, h))
            paired.sort(key=lambda x: x[0])
            for road_km, h in paired[:CANDIDATE_KEEP_CAP]:
                kept.append(
                    {
                        "name": str(h.get(job["name_col"], "") or "").strip(),
                        "type": str(h.get(job["type_col"], "") or "") if job["type_col"] else "",
                        "district_name": h.get("district_name", ""),
                        "latitude": h["latitude"],
                        "longitude": h["longitude"],
                        "road_km": round(road_km, 2),
                    }
                )
    return kept


def _write_reach_payload(out_path: str, fingerprint: str, features: list[dict], complete: bool) -> None:
    payload = {
        "schema": "v2",
        "default_threshold_km": DEFAULT_THRESHOLD_KM,
        "max_threshold_km": STRAIGHT_BUFFER_KM,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dataset_fingerprint": fingerprint,
        "complete": complete,
        "features": features,
    }
    tmp = out_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f, indent=2)
    os.replace(tmp, out_path)  # atomic — a crash mid-write can't corrupt the file


def _run_facility_job(job: dict, accidents: list[dict]) -> None:
    facilities = _load_facilities(job["table"])
    out_path = os.path.join(DATA_DIR, job["out_file"])
    fingerprint = _dataset_fingerprint(accidents)

    # Resume support: if a prior run for the SAME dataset left a (possibly
    # partial) file, keep the accidents it already computed and only work
    # through the rest. This makes a multi-hour full-scale run restartable.
    done: dict[str, dict] = {}
    if os.path.exists(out_path):
        try:
            with open(out_path) as f:
                prev = json.load(f)
            if prev.get("dataset_fingerprint") == fingerprint:
                for feat in prev.get("features", []):
                    done[str(feat.get("accident_id_sp"))] = feat
        except (json.JSONDecodeError, OSError):
            done = {}

    total = len(accidents)
    if done:
        print(f"[{job['key']}] resuming: {len(done)}/{total} already computed", flush=True)

    features = [done[str(a["accident_id_sp"])] for a in accidents if str(a["accident_id_sp"]) in done]
    processed_since_ckpt = 0

    for i, acc in enumerate(accidents):
        _set_status(facility=job["key"], progress={"done": i, "total": total})
        aid = str(acc["accident_id_sp"])
        if aid in done:
            continue

        alat, alon = float(acc["latitude_sp"]), float(acc["longitude_sp"])
        kept = _candidates_for(job, facilities, alat, alon)
        features.append(
            {
                "accident_id_sp": acc["accident_id_sp"],
                "latitude": alat,
                "longitude": alon,
                "severity": acc["severity"],
                "district_name": acc["district_name"],
                "station_name": acc["station_name"],
                "candidates": kept,
            }
        )
        processed_since_ckpt += 1

        if processed_since_ckpt >= CHECKPOINT_EVERY:
            _write_reach_payload(out_path, fingerprint, features, complete=False)
            print(f"[{job['key']}] {len(features)}/{total} done (checkpoint)", flush=True)
            processed_since_ckpt = 0

        if OSRM_SLEEP:
            time.sleep(OSRM_SLEEP)

    _write_reach_payload(out_path, fingerprint, features, complete=True)
    print(f"[{job['key']}] complete: {len(features)}/{total}", flush=True)


def _recompute_district_scorecard(accidents: list[dict]) -> None:
    _set_status(facility="scorecard", progress={"done": 0, "total": 1})

    district_rows = fetch_all(
        'SELECT DISTINCT "DISTRICT" FROM india_admin_boundary.district WHERE UPPER("STATE_UT") = \'HARYANA\''
    )
    haryana_districts = sorted({r["DISTRICT"] for r in district_rows})

    hospitals = _load_facilities("public.haryana_hosp")

    with open(os.path.join(DATA_DIR, "accident_hospital_safety_v2.json")) as f:
        safety_v2 = json.load(f)["features"]

    per_district = {
        d: {
            "district": d,
            "accident_count": 0,
            "severity_counts": {s: 0 for s in SEVERITIES},
            "hospital_count": 0,
            "road_km_sum": 0.0,
            "road_km_n": 0,
            "unreachable_count": 0,
        }
        for d in haryana_districts
    }

    def _row_for(d):
        if d not in per_district:
            per_district[d] = {
                "district": d,
                "accident_count": 0,
                "severity_counts": {s: 0 for s in SEVERITIES},
                "hospital_count": 0,
                "road_km_sum": 0.0,
                "road_km_n": 0,
                "unreachable_count": 0,
            }
        return per_district[d]

    for a in accidents:
        row = _row_for(_norm_district(a["district_name"]))
        row["accident_count"] += 1
        if a["severity"] in row["severity_counts"]:
            row["severity_counts"][a["severity"]] += 1

    for h in hospitals:
        d = _norm_district(h.get("district_name", ""))
        if d in per_district:
            per_district[d]["hospital_count"] += 1

    for f in safety_v2:
        d = _norm_district(f["district_name"])
        if d not in per_district:
            continue
        candidates = f.get("candidates") or []
        if not candidates:
            per_district[d]["unreachable_count"] += 1
            continue
        nearest_km = candidates[0]["road_km"]
        per_district[d]["road_km_sum"] += nearest_km
        per_district[d]["road_km_n"] += 1
        if nearest_km > DEFAULT_THRESHOLD_KM:
            per_district[d]["unreachable_count"] += 1

    rows = []
    for d, row in per_district.items():
        weighted = sum(SEVERITY_WEIGHTS[s] * c for s, c in row["severity_counts"].items())
        avg_road_km = round(row["road_km_sum"] / row["road_km_n"], 2) if row["road_km_n"] else None
        accidents_per_hospital = round(row["accident_count"] / row["hospital_count"], 2) if row["hospital_count"] else None
        rows.append(
            {
                "district": d,
                "accident_count": row["accident_count"],
                "severity_counts": row["severity_counts"],
                "weighted_severity_score": round(weighted, 1),
                "hospital_count": row["hospital_count"],
                "avg_road_km_to_hospital": avg_road_km,
                "accidents_per_hospital": accidents_per_hospital,
                "unreachable_count": row["unreachable_count"],
            }
        )
    rows.sort(key=lambda r: r["district"])

    payload = {
        "schema": "v2",
        "unreachable_threshold_km": DEFAULT_THRESHOLD_KM,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "formula": {
            "weighted_severity_score": "Fatal x5 + Grievous Injury x3 + Minor Injury Hospitalized x2 + Minor Injury Non-Hospitalized x1 + Non-Injury x0.5, summed per district",
            "avg_road_km_to_hospital": "Mean, across the district's accidents, of each accident's nearest hospital by actual OSRM road distance",
            "accidents_per_hospital": "accident_count / hospital_count",
            "unreachable_count": f"Accidents whose nearest hospital by road is more than {DEFAULT_THRESHOLD_KM:.0f} km away (or has no candidate hospital at all)",
        },
        "districts": rows,
    }
    with open(os.path.join(DATA_DIR, "district_scorecard_v2.json"), "w") as f:
        json.dump(payload, f, indent=2)


def _run_pipeline() -> None:
    try:
        _set_status(
            state="running",
            facility=None,
            progress={"done": 0, "total": 0},
            started_at=datetime.now(timezone.utc).isoformat(),
            finished_at=None,
            error=None,
        )
        accidents = _read_active_accidents()
        for job in FACILITY_JOBS:
            _run_facility_job(job, accidents)
        _recompute_district_scorecard(accidents)
        _set_status(state="done", facility=None, finished_at=datetime.now(timezone.utc).isoformat())
    except Exception as exc:  # noqa: BLE001 — surface any failure to the UI
        _set_status(state="error", error=str(exc), finished_at=datetime.now(timezone.utc).isoformat())


def run_pipeline_async() -> bool:
    """Kick off a recompute in the background. Returns False if one's already running."""
    with _lock:
        if _status["state"] == "running":
            return False
    thread = threading.Thread(target=_run_pipeline, daemon=True)
    thread.start()
    return True
