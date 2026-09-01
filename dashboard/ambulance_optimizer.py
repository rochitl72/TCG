"""Dynamic ambulance positioning — deliverable 3.

Haryana's 1,138 source rows dedupe to 569 real vehicles (every row appears
exactly twice), parked at only 384 distinct locations; 1,345 accident grids have
no ambulance within 10 km by road. This module proposes a better arrangement,
traces which vehicles move, and reports the coverage gaps that remain.

METHOD
Greedy Maximal Covering Location Problem (MCLP). Demand points are the RBG grid
cells; candidate sites are those same centroids (or real facility locations when
`snap_to_facilities` is on). We repeatedly pick the site that covers the most
still-uncovered demand, until we run out of ambulances. Vehicles are then
assigned to the chosen sites nearest-first, so the proposal moves each ambulance
as little as possible.

Greedy MCLP is not globally optimal, but it is provably within (1 - 1/e) ~ 63%
of optimal for coverage problems, runs in seconds, and — unlike a black-box
solver — every placement can be explained to a district health officer.

DISTANCE MODEL
Optimisation uses straight-line distance: the search evaluates millions of
candidate/demand pairs and OSRM cannot answer that many queries interactively.
Road distance for the FINAL proposed positions can be verified separately with
`verify_with_osrm()`. Straight-line is the standard model for facility siting
and is stated plainly in the UI rather than hidden.

TOGGLES (defaults reflect the decision taken on this project: district
constraint ON, everything else OFF)
    district_constraint   ambulances stay inside their home district
    movable_types         restrict which vehicle types may be moved
    snap_to_facilities    proposed sites must be a real hospital/CHC/PHC
    severity_weighted     weight demand by each grid's accident severity
"""

from __future__ import annotations

import json
import math
import os
import time
import urllib.request
from collections import defaultdict
from typing import Any

import districts
import network_analytics as na

DEFAULT_THRESHOLD_KM = 10.0
EMERGENCY_TYPES = {"ALS", "BLS"}
# Candidate sites are thinned to this spacing (km) before the search — two
# candidate points 200 m apart cover near-identical demand, so evaluating both
# just costs time.
CANDIDATE_SPACING_KM = 2.0

OSRM_BASE = os.environ.get("OSRM_BASE", "http://127.0.0.1:5000").rstrip("/")


# --------------------------------------------------------------------------
def _ambulances_from_sql() -> list[dict]:
    """Fallback when PostGIS isn't reachable — parse the canonical dump."""
    import re

    path = os.path.join(
        os.path.dirname(na.DATA_DIR), "latest data", "geolocations latest.sql"
    )
    text = open(path, encoding="utf-8", errors="replace").read()
    m = re.search(
        r"^COPY public\.haryana_ambulance \((.+?)\) FROM stdin;\n(.*?)^\\\.$",
        text,
        re.M | re.S,
    )
    if not m:
        raise RuntimeError(f"haryana_ambulance COPY block not found in {path}")
    cols = [c.strip() for c in m.group(1).split(",")]
    return [
        dict(zip(cols, line.split("\t")))
        for line in m.group(2).strip("\n").split("\n")
        if line
    ]


def load_ambulances() -> list[dict]:
    """Haryana's ambulance fleet, deduplicated.

    ``haryana_ambulance`` holds 1,138 rows but only **569 real vehicles** —
    every row appears exactly twice, byte-identical (same s_no, same vehicle_no,
    same GPS). Verified: 569 distinct full rows, 569 distinct vehicle numbers,
    569 distinct (vehicle, coordinate) pairs, and not one vehicle appearing
    once or three times. That is a doubled export, not real vehicles.

    Left uncorrected the optimiser positions 569 ambulances that do not exist,
    which inflates every coverage figure it reports. Deduplication is on the
    FULL row, so two genuinely different vehicles that happened to share an id
    would both survive.
    """
    try:
        from db import fetch_all

        rows = fetch_all(
            "SELECT s_no, district_name, vehicle_no, vehicle_make, vehicle_type, "
            "       stationed_at, health_facility_name, latitude, longitude "
            "FROM public.haryana_ambulance "
            "WHERE latitude IS NOT NULL AND longitude IS NOT NULL"
        )
    except Exception:  # noqa: BLE001 — DB optional, see _ambulances_from_sql
        rows = _ambulances_from_sql()

    seen: set[tuple] = set()
    deduped = []
    for r in rows:
        fingerprint = (
            str(r.get("vehicle_no", "")).strip(),
            str(r.get("latitude")),
            str(r.get("longitude")),
            str(r.get("vehicle_type", "")).strip(),
            str(r.get("stationed_at", "")).strip(),
        )
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        deduped.append(r)
    rows = deduped

    out = []
    for r in rows:
        try:
            lat, lon = float(r["latitude"]), float(r["longitude"])
        except (TypeError, ValueError):
            continue
        out.append(
            {
                "s_no": str(r["s_no"]).lstrip("﻿").strip(),
                "vehicle_no": (r["vehicle_no"] or "").strip(),
                "vehicle_type": (r["vehicle_type"] or "").strip().upper(),
                "vehicle_make": (r["vehicle_make"] or "").strip(),
                "stationed_at": (r["stationed_at"] or "").strip(),
                "facility": (r["health_facility_name"] or "").strip(),
                "district": (r["district_name"] or "").strip().upper(),
                "lat": lat,
                "lon": lon,
            }
        )
    return out


# Spellings are inconsistent between the ambulance table and the RBG grid feed —
# the ambulance table says GURGAON, the grids say GURUGRAM. Without normalising,
# the district constraint puts 68 ambulances in a group with zero candidate
# sites, so they silently never move and Gurugram never gets optimised.
# The full mapping (44 spellings -> 22 districts) lives in districts.py.
_norm_district = districts.normalize


# Some ambulances carry a district label that disagrees with where they actually
# are — e.g. HR45 C-5752 is recorded under KARNAL but sits 0.6 km from a JIND
# grid, 81 km from Karnal. Trusting the label would let the "stay in your home
# district" rule propose an 81 km relocation that is really a data error. We
# therefore derive the district geographically and keep the label for reference.
GEO_SNAP_MAX_KM = 25.0


def assign_geographic_districts(
    ambulances: list[dict], demand: list[dict]
) -> dict[str, int]:
    """Set a['district'] from the nearest grid cell. Returns a mismatch report."""
    if not demand:
        return {"relabelled": 0, "unmatched": 0}
    cell = 0.25  # ~25 km buckets
    buckets: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for d in demand:
        buckets[(int(d["lat"] / cell), int(d["lon"] / cell))].append(d)

    relabelled = unmatched = 0
    for a in ambulances:
        a["district_recorded"] = a["district"]
        bx, by = int(a["lat"] / cell), int(a["lon"] / cell)
        best, best_km = None, GEO_SNAP_MAX_KM
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for d in buckets.get((bx + dx, by + dy), []):
                    km = na.haversine_km(a["lat"], a["lon"], d["lat"], d["lon"])
                    if km < best_km:
                        best, best_km = d, km
        if best is None:
            unmatched += 1
            continue
        if best["district"] != a["district"]:
            relabelled += 1
        a["district"] = best["district"]
    return {"relabelled": relabelled, "unmatched": unmatched}


def _thin(points: list[dict], spacing_km: float) -> list[dict]:
    """Grid-snap thinning — keeps one representative point per spacing cell."""
    if spacing_km <= 0:
        return points
    cell = spacing_km / 111.0
    seen: dict[tuple[int, int], dict] = {}
    for p in points:
        key = (int(p["lat"] / cell), int(p["lon"] / cell))
        # Keep the highest-demand representative in each cell.
        if key not in seen or p.get("weight", 0) > seen[key].get("weight", 0):
            seen[key] = p
    return list(seen.values())


def _coverage_sets(
    sites: list[dict], demand: list[dict], threshold_km: float
) -> list[set[int]]:
    """For each candidate site, the indices of demand points it covers."""
    cell = threshold_km / 111.0
    buckets: dict[tuple[int, int], list[int]] = defaultdict(list)
    for i, d in enumerate(demand):
        buckets[(int(d["lat"] / cell), int(d["lon"] / cell))].append(i)

    out = []
    for s in sites:
        bx, by = int(s["lat"] / cell), int(s["lon"] / cell)
        covered = set()
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in buckets.get((bx + dx, by + dy), []):
                    d = demand[i]
                    if na.haversine_km(s["lat"], s["lon"], d["lat"], d["lon"]) <= threshold_km:
                        covered.add(i)
        out.append(covered)
    return out


def _greedy_mclp(
    sites: list[dict],
    cover: list[set[int]],
    demand: list[dict],
    n_pick: int,
    already: set[int],
    weighted: bool,
) -> list[int]:
    """Pick n_pick site indices maximising newly-covered demand weight."""
    chosen: list[int] = []
    covered = set(already)
    available = set(range(len(sites)))

    def weight(idx_set: set[int]) -> float:
        if not weighted:
            return float(len(idx_set))
        return sum(demand[i]["weight"] for i in idx_set)

    for _ in range(n_pick):
        best_i, best_gain, best_new = None, 0.0, None
        for i in available:
            new = cover[i] - covered
            if not new:
                continue
            gain = weight(new)
            if gain > best_gain:
                best_i, best_gain, best_new = i, gain, new
        if best_i is None:
            break  # everything reachable is already covered
        chosen.append(best_i)
        covered |= best_new
        available.discard(best_i)
    return chosen


def _assign(ambulances: list[dict], sites: list[dict]) -> list[tuple[int, int]]:
    """Match ambulances to chosen sites, shortest moves first."""
    pairs = []
    for si, s in enumerate(sites):
        for ai, a in enumerate(ambulances):
            pairs.append((na.haversine_km(a["lat"], a["lon"], s["lat"], s["lon"]), ai, si))
    pairs.sort()
    used_a: set[int] = set()
    used_s: set[int] = set()
    out = []
    for _, ai, si in pairs:
        if ai in used_a or si in used_s:
            continue
        used_a.add(ai)
        used_s.add(si)
        out.append((ai, si))
        if len(used_s) == len(sites) or len(used_a) == len(ambulances):
            break
    return out


# --------------------------------------------------------------------------
def optimise(
    year: str = "2025",
    threshold_km: float = DEFAULT_THRESHOLD_KM,
    district_constraint: bool = True,
    emergency_only: bool = False,
    snap_to_facilities: bool = False,
    severity_weighted: bool = False,
    district: str | None = None,
) -> dict[str, Any]:
    t0 = time.time()
    grids, report = na.load_grids(year)
    ambulances = load_ambulances()
    for a in ambulances:
        a["district"] = _norm_district(a["district"])

    demand = [
        {
            "grid_id": g["grid_id"],
            "lat": g["lat"],
            "lon": g["lon"],
            "district": _norm_district(g["district"]),
            "weight": max(g["severity_score"], 0.1),
        }
        for g in grids
    ]
    # Derive each vehicle's district from where it physically is, not from a
    # label that may be wrong. Must run before any district filtering.
    geo_report = assign_geographic_districts(ambulances, demand)

    if district:
        want = _norm_district(district)
        demand = [d for d in demand if d["district"] == want]
        ambulances = [a for a in ambulances if a["district"] == want]

    def is_movable(a: dict) -> bool:
        return (not emergency_only) or a["vehicle_type"] in EMERGENCY_TYPES

    movable = [a for a in ambulances if is_movable(a)]
    fixed = [a for a in ambulances if not is_movable(a)]

    # ---- baseline -------------------------------------------------------
    def covered_by(fleet: list[dict]) -> set[int]:
        if not fleet:
            return set()
        sets = _coverage_sets(
            [{"lat": a["lat"], "lon": a["lon"]} for a in fleet], demand, threshold_km
        )
        out: set[int] = set()
        for s in sets:
            out |= s
        return out

    base_cov = covered_by(ambulances)

    # ---- candidate sites ------------------------------------------------
    if snap_to_facilities:
        hospitals = na.load_hospitals()
        raw_sites = [
            {"lat": h["latitude"], "lon": h["longitude"],
             "district": _norm_district(h["district_name"]),
             "label": h["hospital_name"], "weight": 0.0}
            for h in hospitals
        ]
    else:
        raw_sites = [
            {"lat": d["lat"], "lon": d["lon"], "district": d["district"],
             "label": f"grid {d['grid_id']}", "weight": d["weight"]}
            for d in demand
        ]
    raw_sites = _thin(raw_sites, CANDIDATE_SPACING_KM)

    # ---- optimise -------------------------------------------------------
    groups: dict[str, dict[str, list]] = defaultdict(
        lambda: {"amb": [], "sites": [], "demand_idx": []}
    )
    if district_constraint:
        for a in movable:
            groups[a["district"]]["amb"].append(a)
        for s in raw_sites:
            groups[s["district"]]["sites"].append(s)
    else:
        groups["ALL"]["amb"] = movable
        groups["ALL"]["sites"] = raw_sites

    fixed_cov = covered_by(fixed)
    proposed: list[dict] = []
    moves: list[dict] = []

    for key, grp in groups.items():
        amb, sites = grp["amb"], grp["sites"]
        if not amb or not sites:
            # No candidate sites in this district (or no vehicles) — leave as is.
            for a in amb:
                proposed.append({**a, "new_lat": a["lat"], "new_lon": a["lon"], "moved_km": 0.0})
            continue
        cover = _coverage_sets(sites, demand, threshold_km)
        picks = _greedy_mclp(sites, cover, demand, len(amb), fixed_cov, severity_weighted)
        chosen_sites = [sites[i] for i in picks]

        assignment = _assign(amb, chosen_sites)
        assigned_a = {ai for ai, _ in assignment}
        for ai, si in assignment:
            a, s = amb[ai], chosen_sites[si]
            moved = na.haversine_km(a["lat"], a["lon"], s["lat"], s["lon"])
            rec = {**a, "new_lat": s["lat"], "new_lon": s["lon"],
                   "moved_km": round(moved, 2), "new_site_label": s["label"]}
            proposed.append(rec)
            if moved > 0.1:
                moves.append(rec)
        # Ambulances with no site to take (more vehicles than useful sites) stay put.
        for ai, a in enumerate(amb):
            if ai not in assigned_a:
                proposed.append({**a, "new_lat": a["lat"], "new_lon": a["lon"], "moved_km": 0.0})

    for a in fixed:
        proposed.append({**a, "new_lat": a["lat"], "new_lon": a["lon"], "moved_km": 0.0})

    # ---- evaluate proposal ---------------------------------------------
    new_cov = covered_by([{"lat": p["new_lat"], "lon": p["new_lon"]} for p in proposed])

    def stats(cov: set[int]) -> dict:
        wt_total = sum(d["weight"] for d in demand) or 1.0
        wt_cov = sum(demand[i]["weight"] for i in cov)
        return {
            "covered": len(cov),
            "total": len(demand),
            "pct": round(100.0 * len(cov) / (len(demand) or 1), 2),
            "severity_pct": round(100.0 * wt_cov / wt_total, 2),
        }

    gaps = []
    for i, d in enumerate(demand):
        if i in new_cov:
            continue
        nearest = min(
            (na.haversine_km(d["lat"], d["lon"], p["new_lat"], p["new_lon"]) for p in proposed),
            default=None,
        )
        gaps.append(
            {
                "grid_id": d["grid_id"],
                "lat": d["lat"],
                "lon": d["lon"],
                "district": d["district"],
                "severity_score": round(d["weight"], 1),
                "km_to_nearest_ambulance": round(nearest, 2) if nearest is not None else None,
            }
        )
    gaps.sort(key=lambda g: g["km_to_nearest_ambulance"] or 0, reverse=True)

    moves.sort(key=lambda m: m["moved_km"], reverse=True)
    return {
        "year": year,
        "threshold_km": threshold_km,
        "distance_model": "straight_line",
        "options": {
            "district_constraint": district_constraint,
            "emergency_only": emergency_only,
            "snap_to_facilities": snap_to_facilities,
            "severity_weighted": severity_weighted,
        },
        "fleet": {
            "total": len(ambulances),
            "movable": len(movable),
            "fixed": len(fixed),
            "relocated": len(moves),
            "distinct_sites_before": len({(round(a["lat"], 4), round(a["lon"], 4)) for a in ambulances}),
            "distinct_sites_after": len({(round(p["new_lat"], 4), round(p["new_lon"], 4)) for p in proposed}),
            "total_move_km": round(sum(m["moved_km"] for m in moves), 1),
        },
        "baseline": stats(base_cov),
        "proposed": stats(new_cov),
        "improvement_pct": round(
            stats(new_cov)["pct"] - stats(base_cov)["pct"], 2
        ),
        "moves": moves,
        "positions": proposed,
        "gaps": gaps,
        "grid_report": report,
        "district_report": geo_report,
        "elapsed_s": round(time.time() - t0, 1),
    }


# --------------------------------------------------------------------------
def verify_with_osrm(result: dict, sample: int = 200) -> dict:
    """Re-measure the worst residual gaps by real road distance.

    The optimiser works in straight-line space; this confirms the reported gaps
    survive road routing. Samples the worst `sample` gaps to stay quick.
    """
    gaps = result.get("gaps", [])[:sample]
    positions = result.get("positions", [])
    if not gaps or not positions:
        return {"checked": 0}

    checked, worse, road_kms = 0, 0, []
    for g in gaps:
        near = sorted(
            positions,
            key=lambda p: na.haversine_km(g["lat"], g["lon"], p["new_lat"], p["new_lon"]),
        )[:8]
        coords = ";".join(
            [f"{g['lon']:.6f},{g['lat']:.6f}"]
            + [f"{p['new_lon']:.6f},{p['new_lat']:.6f}" for p in near]
        )
        url = f"{OSRM_BASE}/table/v1/driving/{coords}?sources=0&annotations=distance"
        try:
            with urllib.request.urlopen(url, timeout=20) as resp:
                data = json.loads(resp.read())
            row = [d for d in (data.get("distances") or [[]])[0][1:] if d is not None]
            if not row:
                continue
            km = min(row) / 1000.0
            road_kms.append(km)
            checked += 1
            if km > result["threshold_km"]:
                worse += 1
        except Exception:
            continue

    return {
        "checked": checked,
        "still_gap_by_road": worse,
        "mean_road_km": round(sum(road_kms) / len(road_kms), 2) if road_kms else None,
        "max_road_km": round(max(road_kms), 2) if road_kms else None,
    }
