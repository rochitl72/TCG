"""Road-distance reach from grid cells to ambulance stations.

Deliverable 3, restated: *identify the grids that are 10 km or more, BY ROAD,
from any ambulance spot.*

Two position sets, because the requirement covers both:

  current   the 569 vehicles, parked at 384 distinct sites -> precomputed & cached
  proposed  wherever the optimiser would put them      -> computed on demand

Straight-line distance is not good enough here. Road distance is always >=
straight-line, so a straight-line scan misses every grid that is nominally
8 km away but 12 km by road — canals, rail lines and motorway medians in
Haryana make that common. Those are exactly the grids the analysis exists to
find, so this module routes properly through OSRM.

WHY NEAREST-N PER VEHICLE TYPE
The UI toggles between "all 569 vehicles" and "emergency only (ALS + BLS)".
Keeping a flat nearest-N would give the wrong answer for the emergency-only
view whenever the closest vehicles happen to be patient-transport vans. Storing
the nearest N of EACH type means either question is answered exactly from cache.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Callable

import network_analytics as na

ANALYTICS_DIR = na.ANALYTICS_DIR
OSRM_BASE = os.environ.get("OSRM_BASE", "http://127.0.0.1:5000").rstrip("/")

DEFAULT_THRESHOLD_KM = 10.0
KEEP_PER_TYPE = 6
SEARCH_RADIUS_KM = 60.0     # beyond this a vehicle is irrelevant to a 10 km test
EMERGENCY_TYPES = {"ALS", "BLS"}

# Vehicle roles. PTA are patient-transport vans on scheduled dialysis and
# discharge runs; Kilkari and Neonate serve maternal and newborn duties. None
# respond to trauma, which is why "emergency only" exists as a toggle.
VEHICLE_TYPES = ["ALS", "BLS", "PTA", "KILKARI", "NEONATE"]


def artifact_path(year: str) -> str:
    return os.path.join(ANALYTICS_DIR, f"grid_ambulance_{year}.json")


# --------------------------------------------------------------------------
# OSRM
# --------------------------------------------------------------------------
def _osrm_table(sources: list[dict], dests: list[dict], timeout: int = 180):
    """One /table call. sources/dests use keys lat/lon. Returns (dist_m, dur_s)."""
    coords = ";".join(
        [f"{s['lon']:.6f},{s['lat']:.6f}" for s in sources]
        + [f"{d['lon']:.6f},{d['lat']:.6f}" for d in dests]
    )
    ns, nd = len(sources), len(dests)
    url = (
        f"{OSRM_BASE}/table/v1/driving/{coords}"
        f"?sources={';'.join(str(i) for i in range(ns))}"
        f"&destinations={';'.join(str(ns + i) for i in range(nd))}"
        f"&annotations=distance,duration"
    )
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=timeout) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", "replace")[:200]
        except Exception:
            pass
        if exc.code == 400 and "TooBig" in body:
            return None
        raise RuntimeError(f"OSRM HTTP {exc.code}: {body}") from exc
    if data.get("code") != "Ok":
        raise RuntimeError(f"OSRM error: {data.get('code')}")
    return data.get("distances"), data.get("durations")


class OSRMUnavailable(RuntimeError):
    """OSRM is not reachable — raised with actionable guidance, not a traceback."""


def preflight(timeout: int = 5, wait_s: int = 90) -> None:
    """Confirm OSRM is up and answering, waiting for it to finish loading.

    Two distinct failures, which need opposite advice:

    * **Connection refused** — nothing is listening. Almost always the
      PRODUCTION compose stack, whose osrm service publishes no host port (only
      the backend container reaches it over the internal Docker network). Fail
      immediately; waiting will not help.
    * **Connected then dropped** (RemoteDisconnected / timeout / non-Ok code) —
      the container is up but still memory-mapping the routing graph, which
      takes 10-60s for Haryana. Retrying IS the fix, so poll rather than fail.

    The earlier version treated both as "you used the wrong compose file",
    which was actively misleading when the real answer was "wait a moment".
    """
    import time as _time

    url = f"{OSRM_BASE}/route/v1/driving/76.78,29.95;76.79,29.96?overview=false"
    deadline = _time.time() + wait_s
    announced = False
    last: Exception | None = None

    while True:
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                data = json.loads(resp.read())
            if data.get("code") == "Ok":
                return
            last = RuntimeError(f"code={data.get('code')!r}")
        except urllib.error.URLError as exc:
            reason = getattr(exc, "reason", exc)
            if isinstance(reason, ConnectionRefusedError):
                raise OSRMUnavailable(
                    f"Nothing is listening on {OSRM_BASE}.\n"
                    "\n"
                    "  The PRODUCTION stack's osrm service publishes no host port —\n"
                    "  only the backend container reaches it over the Docker network.\n"
                    "\n"
                    "  Start the dev stack, which maps 5000:5000 and pins arm64:\n"
                    "      docker compose -f docker-compose.yml stop osrm\n"
                    "      docker compose -f docker-compose.dev.yml up -d osrm\n"
                    "\n"
                    "  Or re-run with --offline for a straight-line smoke test."
                ) from exc
            last = exc
        except Exception as exc:  # noqa: BLE001 — connected but not ready
            last = exc

        if _time.time() >= deadline:
            raise OSRMUnavailable(
                f"OSRM at {OSRM_BASE} accepted a connection but never became ready "
                f"within {wait_s}s (last: {type(last).__name__}: {last}).\n"
                "\n"
                "  The container is running but the routing graph did not finish\n"
                "  loading. Check it built correctly:\n"
                "      docker logs mapsr-osrm --tail 30\n"
                "      ls -la osrm-data/haryana.osrm*\n"
                "\n"
                "  If the graph is missing, rebuild it:  ./scripts/setup_osrm.sh"
            )

        if not announced:
            print(
                f"==> OSRM is up but still loading the routing graph — waiting "
                f"(up to {wait_s}s)...",
                flush=True,
            )
            announced = True
        _time.sleep(3)


def _probe_batch(grids: list[dict], points: list[dict]) -> int:
    for size in (200, 120, 60, 24, 8, 1):
        try:
            if _osrm_table(grids[:size], points) is not None:
                return size
        except RuntimeError:
            continue
    raise RuntimeError(
        "OSRM rejected even a 1 x N table request. Raise --max-table-size on the "
        "osrm service (see docker-compose.yml)."
    )


def scan(
    grids: list[dict],
    points: list[dict],
    keep_per_type: int = KEEP_PER_TYPE,
    radius_km: float = SEARCH_RADIUS_KM,
    progress: Callable[[int, int], None] | None = None,
) -> list[dict]:
    """Road distance from each grid to nearby ambulances, nearest-N per type.

    `points` need lat/lon/vehicle_type plus whatever identifying fields you want
    echoed back. Raises RuntimeError if OSRM is unreachable — the caller decides
    whether to fall back to straight-line and say so.
    """
    if not grids or not points:
        return []

    preflight()
    batch = _probe_batch(grids, points)
    out: list[dict] = []

    for start in range(0, len(grids), batch):
        chunk = grids[start : start + batch]
        result = _osrm_table(chunk, points)
        if result is None:
            raise RuntimeError("OSRM rejected a batch it previously accepted.")
        distances, durations = result

        for row_i, g in enumerate(chunk):
            drow = distances[row_i] if distances else []
            trow = durations[row_i] if durations else []
            per_type: dict[str, list[dict]] = defaultdict(list)
            for col, p in enumerate(points):
                d_m = drow[col] if col < len(drow) else None
                if d_m is None:
                    continue
                km = d_m / 1000.0
                if km > radius_km:
                    continue
                secs = trow[col] if col < len(trow) else None
                per_type[p.get("vehicle_type", "UNKNOWN")].append(
                    {
                        "id": p.get("s_no"),
                        "vehicle_no": p.get("vehicle_no"),
                        "vehicle_type": p.get("vehicle_type"),
                        "stationed_at": p.get("stationed_at"),
                        "lat": round(p["lat"], 6),
                        "lon": round(p["lon"], 6),
                        "road_km": round(km, 2),
                        "drive_min": round(secs / 60.0, 1) if secs is not None else None,
                    }
                )

            near: list[dict] = []
            for lst in per_type.values():
                lst.sort(key=lambda c: c["road_km"])
                near.extend(lst[:keep_per_type])
            near.sort(key=lambda c: c["road_km"])

            out.append(
                {
                    "grid_id": g["grid_id"],
                    "lat": round(g["lat"], 6),
                    "lon": round(g["lon"], 6),
                    "district": g["district"],
                    "severity_score": g["severity_score"],
                    "near": near,
                }
            )

        if progress:
            progress(min(start + batch, len(grids)), len(grids))

    return out


# --------------------------------------------------------------------------
# Straight-line fallback, used only when OSRM is unavailable
# --------------------------------------------------------------------------
def scan_offline(grids: list[dict], points: list[dict], keep_per_type: int = KEEP_PER_TYPE):
    out = []
    for g in grids:
        per_type: dict[str, list[dict]] = defaultdict(list)
        for p in points:
            km = na.haversine_km(g["lat"], g["lon"], p["lat"], p["lon"])
            if km > SEARCH_RADIUS_KM:
                continue
            per_type[p.get("vehicle_type", "UNKNOWN")].append(
                {
                    "id": p.get("s_no"),
                    "vehicle_no": p.get("vehicle_no"),
                    "vehicle_type": p.get("vehicle_type"),
                    "stationed_at": p.get("stationed_at"),
                    "lat": round(p["lat"], 6),
                    "lon": round(p["lon"], 6),
                    "road_km": round(km, 2),      # NOT road distance — see caller
                    "drive_min": None,
                }
            )
        near: list[dict] = []
        for lst in per_type.values():
            lst.sort(key=lambda c: c["road_km"])
            near.extend(lst[:keep_per_type])
        near.sort(key=lambda c: c["road_km"])
        out.append(
            {
                "grid_id": g["grid_id"],
                "lat": round(g["lat"], 6),
                "lon": round(g["lon"], 6),
                "district": g["district"],
                "severity_score": g["severity_score"],
                "near": near,
            }
        )
    return out


# --------------------------------------------------------------------------
# Cached scan for CURRENT stations
# --------------------------------------------------------------------------
_cache: dict[str, tuple[float, dict]] = {}


def load_current(year: str = "2025") -> dict:
    path = artifact_path(year)
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"Ambulance reach cache missing: {path}\n"
            "Run:  python3 scripts/precompute_ambulance_reach.py --year " + year
        )
    mtime = os.path.getmtime(path)
    hit = _cache.get(year)
    if hit and hit[0] == mtime:
        return hit[1]
    with open(path) as f:
        payload = json.load(f)
    _cache[year] = (mtime, payload)
    return payload


def build_current(year: str = "2025", offline: bool = False, progress=None) -> dict:
    """Compute and write the current-stations artifact."""
    import ambulance_optimizer as ao

    grids, report = na.load_grids(year)
    fleet = ao.load_ambulances()
    points = [
        {
            "s_no": a["s_no"],
            "vehicle_no": a["vehicle_no"],
            "vehicle_type": a["vehicle_type"],
            "stationed_at": a["stationed_at"],
            "lat": a["lat"],
            "lon": a["lon"],
        }
        for a in fleet
    ]

    rows = scan_offline(grids, points) if offline else scan(grids, points, progress=progress)
    payload = {
        "schema": "v1",
        "year": year,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "distance_model": "straight_line_offline" if offline else "osrm_road",
        "fleet_size": len(points),
        "search_radius_km": SEARCH_RADIUS_KM,
        "grid_report": report,
        "grids": rows,
    }
    os.makedirs(ANALYTICS_DIR, exist_ok=True)
    tmp = artifact_path(year) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.replace(tmp, artifact_path(year))
    return payload


# --------------------------------------------------------------------------
# Gap identification — the actual deliverable
# --------------------------------------------------------------------------
def find_gaps(
    rows: list[dict],
    threshold_km: float = DEFAULT_THRESHOLD_KM,
    emergency_only: bool = False,
    district: str | None = None,
) -> dict[str, Any]:
    """Grids whose nearest qualifying ambulance is >= threshold_km by road.

    Note the boundary: the requirement says "10 kms and above", so the test is
    `>=`, not `>`. A grid exactly 10.0 km from its nearest ambulance counts as
    a gap.
    """
    import districts

    want = districts.normalize(district) if district else None
    gaps, covered = [], 0
    covered_by_type: dict[str, int] = {}
    sev_gap = sev_total = 0.0

    for r in rows:
        if want and districts.normalize(r["district"]) != want:
            continue
        pool = [
            c
            for c in r["near"]
            if not emergency_only or (c.get("vehicle_type") or "").upper() in EMERGENCY_TYPES
        ]
        nearest = pool[0] if pool else None
        sev_total += r["severity_score"]

        if nearest is not None and nearest["road_km"] < threshold_km:
            covered += 1
            # WHAT is covering it, not just that something is. A grid whose
            # nearest vehicle is a patient-transport van sits inside the radius
            # but outside an emergency response, and the bare covered count
            # cannot say so.
            vt = (nearest.get("vehicle_type") or "UNKNOWN").upper()
            covered_by_type[vt] = covered_by_type.get(vt, 0) + 1
            continue

        sev_gap += r["severity_score"]
        gaps.append(
            {
                "grid_id": r["grid_id"],
                "latitude": r["lat"],
                "longitude": r["lon"],
                "district": r["district"],
                "severity_score": r["severity_score"],
                "nearest_vehicle_no": nearest["vehicle_no"] if nearest else None,
                "nearest_vehicle_type": nearest["vehicle_type"] if nearest else None,
                "nearest_stationed_at": nearest["stationed_at"] if nearest else None,
                "nearest_latitude": nearest["lat"] if nearest else None,
                "nearest_longitude": nearest["lon"] if nearest else None,
                "road_km": nearest["road_km"] if nearest else None,
                "drive_min": nearest["drive_min"] if nearest else None,
            }
        )

    # Sort worst-first: no vehicle at all, then furthest by road.
    gaps.sort(key=lambda g: (g["road_km"] is not None, -(g["road_km"] or 0)))
    total = covered + len(gaps)
    by_district: dict[str, int] = defaultdict(int)
    for g in gaps:
        by_district[g["district"]] += 1

    return {
        "threshold_km": threshold_km,
        "emergency_only": emergency_only,
        "district": district,
        "total_grids": total,
        "covered": covered,
        "gap_count": len(gaps),
        "gap_pct": round(100.0 * len(gaps) / total, 2) if total else 0.0,
        "covered_by_type": covered_by_type,
        "severity_in_gaps": round(sev_gap, 1),
        "severity_pct": round(100.0 * sev_gap / sev_total, 2) if sev_total else 0.0,
        "by_district": sorted(
            ({"district": k, "gaps": v} for k, v in by_district.items()),
            key=lambda x: x["gaps"],
            reverse=True,
        ),
        "gaps": gaps,
    }


# ==========================================================================
# Neighbour lookups for the map popups
# ==========================================================================
# Both directions read the SAME cached scan, so a popup can never disagree with
# the gap count on the same screen. The cache keeps the nearest KEEP_PER_TYPE
# vehicles of each type per grid, which is what makes the reverse lookup honest:
# "grids this vehicle is among the nearest few for" is exactly the question a
# station-level reader is asking, and it is answerable without re-routing.
def nearest_ambulances(
    grid_id: str,
    year: str = "2025",
    limit: int = 10,
    emergency_only: bool = False,
) -> dict | None:
    """The vehicles closest to one grid, nearest first."""
    cache = load_current(year)
    row = next((r for r in cache["grids"] if str(r["grid_id"]) == str(grid_id)), None)
    if row is None:
        return None

    pool = [
        c
        for c in row["near"]
        if not emergency_only or (c.get("vehicle_type") or "").upper() in EMERGENCY_TYPES
    ]
    pool.sort(key=lambda c: c["road_km"])
    return {
        "grid_id": row["grid_id"],
        "district": row["district"],
        "severity_score": row["severity_score"],
        "latitude": row["lat"],
        "longitude": row["lon"],
        "distance_model": cache.get("distance_model"),
        "emergency_only": emergency_only,
        "count": len(pool),
        "ambulances": pool[:limit],
    }


def nearest_grids(
    ambulance_id: str,
    year: str = "2025",
    limit: int = 10,
) -> dict | None:
    """The grids one vehicle is closest to, nearest first.

    Scans the cached rows for entries naming this vehicle. A grid only appears
    if this vehicle is among the nearest few OF ITS TYPE for that grid, so the
    list answers "what does this station actually cover" rather than "what is
    within some radius of it".
    """
    cache = load_current(year)
    hits: list[dict] = []
    vehicle: dict | None = None

    for row in cache["grids"]:
        for c in row["near"]:
            if str(c.get("id")) != str(ambulance_id):
                continue
            if vehicle is None:
                vehicle = {
                    "id": c.get("id"),
                    "vehicle_no": c.get("vehicle_no"),
                    "vehicle_type": c.get("vehicle_type"),
                    "stationed_at": c.get("stationed_at"),
                    "lat": c.get("lat"),
                    "lon": c.get("lon"),
                }
            hits.append(
                {
                    "grid_id": row["grid_id"],
                    "district": row["district"],
                    "latitude": row["lat"],
                    "longitude": row["lon"],
                    "severity_score": row["severity_score"],
                    "road_km": c["road_km"],
                    "drive_min": c.get("drive_min"),
                }
            )
            break

    if vehicle is None:
        return None
    hits.sort(key=lambda h: h["road_km"])
    return {
        "ambulance": vehicle,
        "distance_model": cache.get("distance_model"),
        "count": len(hits),
        "severity_total": round(sum(h["severity_score"] or 0 for h in hits), 1),
        "grids": hits[:limit],
    }
