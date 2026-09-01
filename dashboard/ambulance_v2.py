"""Gap analysis for the v2 ("new") partner ambulance dataset.

The reach cache is built by scripts/precompute_ambulance_v2_reach.py, which
buckets each grid's nearby stations by their `day|period` slot (see that
script's docstring for why). This module turns that cache into the same shape
the Ambulance tab already consumes for the "old" dataset, so the frontend can
switch datasets without switching code paths.

WHY THE DAY/PERIOD FILTER IS EXACT
Every filter the UI can express is a union of whole slots — one day is a union
of its periods, one period a union of its days, All is everything. The cache
holds the nearest stations WITHIN each slot, so the nearest station in any union
is just the minimum across that union's entries. No interpolation, no
"approximately nearest".

WHAT THE NUMBERS MEAN — the caveat that has to reach the screen
Each station appears exactly once in the source workbook, stamped with one day
and one period. The file is 142 observations, not 142 ambulances each running a
weekly roster. Narrowing to a single day AND period leaves 1-7 stations, so the
gap count legitimately approaches "the whole state". `station_count` and
`thin_slice` are returned on every response so the UI can say that plainly
instead of letting a red map imply a collapse in coverage.
"""

from __future__ import annotations

import json
import os
from typing import Any

import districts
import grid_ambulance as ga

# Below this many stations the answer says more about the sample than about
# coverage. Chosen to sit just above the 1-7 range a single day+period slice
# yields, so the warning fires exactly when a slice is that thin.
THIN_SLICE_STATIONS = 10


def artifact_path(year: str) -> str:
    return os.path.join(ga.ANALYTICS_DIR, f"grid_ambulance_v2_{year}.json")


_cache: dict[str, tuple[float, dict]] = {}


def load(year: str = "2025") -> dict:
    """Reach cache, memoised on mtime so a rebuild is picked up without a restart."""
    path = artifact_path(year)
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"v2 ambulance reach cache missing: {path}\n"
            "Run:  python3 scripts/build_ambulances_v2.py && "
            f"python3 scripts/precompute_ambulance_v2_reach.py --year {year}"
        )
    mtime = os.path.getmtime(path)
    hit = _cache.get(year)
    if hit and hit[0] == mtime:
        return hit[1]
    with open(path) as fh:
        payload = json.load(fh)
    _cache[year] = (mtime, payload)
    return payload


def _slot_ok(slot: str, days: set[str] | None, periods: set[str] | None) -> bool:
    """Does a `day|period` bucket key survive the current filter?"""
    day, _, period = slot.partition("|")
    if days and day not in days:
        return False
    if periods and period not in periods:
        return False
    return True


def stations(year: str, days=None, periods=None, district=None) -> list[dict]:
    """The station rows surviving the filter, for the map layer and exports."""
    p = load(year)
    dset = set(days) if days else None
    pset = set(periods) if periods else None
    want = districts.normalize(district) if district else None
    out = []
    for s in p["stations"]:
        if dset and s["day"] not in dset:
            continue
        if pset and s["period"] not in pset:
            continue
        if want and s["district"] != want:
            continue
        out.append(s)
    return out


def find_gaps(
    year: str = "2025",
    threshold_km: float = ga.DEFAULT_THRESHOLD_KM,
    days: list[str] | None = None,
    periods: list[str] | None = None,
    district: str | None = None,
) -> dict[str, Any]:
    """Grids whose nearest v2 station is >= threshold_km by road.

    Same `>=` boundary as the v1 analysis (grid_ambulance.find_gaps): the
    requirement reads "10 kms and above", so a grid exactly 10.0 km out is a gap.
    Keeping the two identical matters — the tab lets you switch datasets, and a
    different boundary would make the two look like they disagree about reality.
    """
    p = load(year)
    dset = set(days) if days else None
    pset = set(periods) if periods else None
    want = districts.normalize(district) if district else None

    # The analysis measures against EVERY station that survives the day/period
    # filter, district selection or not: a station 3 km over the district line
    # still reaches a grid inside it, and dropping it would invent a gap that
    # does not exist. The map layer, by contrast, is district-filtered — so the
    # two counts differ whenever a district is picked, and the UI has to be able
    # to say which is which instead of showing them side by side unexplained.
    kept = stations(year, days, periods, None)
    n_stations = len(kept)
    n_in_district = (
        len(stations(year, days, periods, district)) if want else n_stations
    )

    gaps: list[dict] = []
    covered = 0
    sev_gap = sev_total = 0.0
    by_district: dict[str, dict[str, int]] = {}

    for r in p["grids"]:
        if want and districts.normalize(r["district"]) != want:
            continue

        # `near` is already sorted by road_km across all slots, so the first
        # entry whose slot survives the filter IS the nearest in that filter.
        nearest = None
        for c in r["near"]:
            if _slot_ok(c.get("vehicle_type") or "", dset, pset):
                nearest = c
                break

        sev_total += r["severity_score"]
        d = r["district"]
        bucket = by_district.setdefault(d, {"district": d, "gaps": 0, "covered": 0})

        if nearest is not None and nearest["road_km"] < threshold_km:
            covered += 1
            bucket["covered"] += 1
            continue

        sev_gap += r["severity_score"]
        bucket["gaps"] += 1
        gaps.append(_gap_row(r, nearest))

    return _summary(p, gaps, covered, sev_gap, sev_total, by_district,
                    threshold_km, days, periods, district, n_stations,
                    n_in_district)


def _gap_row(r: dict, nearest: dict | None) -> dict:
    """One uncovered grid, carrying why it is uncovered.

    `nearest` is None when no station in the current filter sits inside the
    60 km cache radius. That is reported as None rather than a large number:
    the cache genuinely does not know the distance, and inventing one (or
    printing the radius as though it were measured) would be a lie in a column
    people export and act on.
    """
    slot = (nearest or {}).get("vehicle_type") or ""
    day, _, period = slot.partition("|")
    return {
        "grid_id": r["grid_id"],
        "latitude": r["lat"],
        "longitude": r["lon"],
        "district": r["district"],
        "severity_score": r["severity_score"],
        "nearest_km": nearest["road_km"] if nearest else None,
        "nearest_id": nearest.get("id") if nearest else None,
        "nearest_at": nearest.get("stationed_at") if nearest else None,
        "nearest_day": day or None,
        "nearest_period": period or None,
        "drive_min": nearest.get("drive_min") if nearest else None,
        "beyond_cache": nearest is None,
    }


def _summary(p, gaps, covered, sev_gap, sev_total, by_district,
             threshold_km, days, periods, district, n_stations,
             n_in_district=None) -> dict:
    gaps.sort(key=lambda g: -g["severity_score"])
    total = len(gaps) + covered
    districts_out = sorted(by_district.values(), key=lambda d: -d["gaps"])
    return {
        "year": p["year"],
        "mode": p["mode"],
        "dataset": "v2",
        "threshold_km": threshold_km,
        "days": days or [],
        "periods": periods or [],
        "district": district,
        # Stations behind the ANSWER (day/period filter only).
        "station_count": n_stations,
        # Stations the map draws when a district is selected — the same number
        # /ambulance-v2/stations returns, so the badge and this note agree.
        "stations_in_district": n_stations if n_in_district is None else n_in_district,
        "station_total": p["station_count"],
        # The honest headline when a slice is too thin to mean much. The UI
        # shows this instead of letting a near-total red map speak for itself.
        "thin_slice": n_stations < THIN_SLICE_STATIONS,
        "thin_slice_threshold": THIN_SLICE_STATIONS,
        "grids_total": total,
        "grids_covered": covered,
        "grids_gap": len(gaps),
        "pct_gap": round(100.0 * len(gaps) / total, 1) if total else 0.0,
        "severity_in_gap": round(sev_gap, 2),
        "severity_total": round(sev_total, 2),
        "pct_severity_in_gap": round(100.0 * sev_gap / sev_total, 1) if sev_total else 0.0,
        "by_district": districts_out,
        "available_days": p["days"],
        "available_periods": p["periods"],
        "available_districts": p["districts"],
        "slot_counts": p["slot_counts"],
        "gaps": gaps,
    }
