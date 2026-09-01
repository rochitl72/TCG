"""Trauma network analytics — the shared engine behind the three deliverables.

  1. Grid -> hospital proximity  (every 2025 grid, hospitals within 60 km,
     with hospital id/name/type/GPS/TPL and road distance + drive time)
  2. Coverage gaps + underserved corridors  (grids out of reach of Tertiary /
     Secondary / Primary care, and the contiguous chains they form)
  3. Ambulance reach gaps                 (see grid_ambulance.py)

The expensive part — road distance from 6,785 grid centroids to 1,208
hospitals — is precomputed once by scripts/precompute_network_analytics.py and
cached in data/analytics/. Everything in this module reads that cache and is
fast enough to run per request, so thresholds stay interactive.

WHY WE KEEP NEAREST-N *PER HOSPITAL TYPE*
A flat "nearest 25 hospitals" list is wrong for tier analysis: in a town the 25
nearest could all be PHCs, hiding the district hospital 8 km away and making the
grid look devoid of tertiary care. We therefore keep the nearest
KEEP_PER_TYPE hospitals of EACH hosp_type. Any tier, private/public or
type-filtered query is then answered exactly from the cache, because every tier
is a union of types.
"""

from __future__ import annotations

import csv
import json
import math
import os
from collections import defaultdict
from typing import Any, Iterable

import districts
import rbg_grids
import tpl as tpl_mod

DATA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))
ANALYTICS_DIR = os.path.join(DATA_DIR, "analytics")

# --- tunables -------------------------------------------------------------
PROXIMITY_KM = 60.0        # the radius the requirement asks for
KEEP_PER_TYPE = 12         # nearest N of each hosp_type retained per grid
EXPORT_TOP_N = 10          # rows per grid in the CSV export

# Haryana bounding box. The RBG feed contains corrupt cells — two sit at
# (13.067, 80.279), which is Chennai — plus 15 with a blank district. They are
# excluded from every analysis; `load_grids` reports how many it dropped.
HARYANA_BBOX = (27.60, 30.99, 74.40, 77.70)  # lat_min, lat_max, lon_min, lon_max

HOSP_TYPES = ["DCH", "CH_SDH", "CHC", "PHC", "Empanelled Private Hospital"]
PRIVATE_TYPE = "Empanelled Private Hospital"

# --- threshold presets ----------------------------------------------------
# SPEC is the literal requirement: "grids not in the proximity of 60 kms from
# Tertiary, secondary and primary hospitals". This is what the UI opens on, so
# the deliverable matches the brief exactly. Be aware it is a near-empty map —
# Haryana has 1,208 facilities across ~250 km, so at 60 km road distance the
# tertiary gap is 0.0% and only 3 genuine cells in the state qualify.
SPEC_KM = {"Tertiary": 60.0, "Secondary": 60.0, "Primary": 60.0}

# Where each tier actually shows signal, measured against real geometry.
# See README_ANALYTICS.md for the full sweep.
DEFAULT_KM = {"Tertiary": 30.0, "Secondary": 10.0, "Primary": 5.0}

# Drive-time thresholds (minutes) — the golden-hour framing clinicians use.
DEFAULT_MIN = {"Tertiary": 60.0, "Secondary": 30.0, "Primary": 15.0}

# Only distance presets are exposed in the UI. Drive-time analysis (mode="time")
# still works through the API and will be genuinely useful once the cache is
# rebuilt against real OSRM — but while the cache is the --offline stand-in,
# duration is a flat 40 km/h applied to straight-line distance, so a "60 minute"
# threshold is just "40 km" wearing a clinical label. Presenting that as
# golden-hour analysis would be fabricated precision, so it stays out of the UI
# until the numbers mean something.
PRESETS = {
    "spec": {"mode": "distance", "thresholds": SPEC_KM,
             "label": "Spec — 60 km all tiers"},
    "recommended": {"mode": "distance", "thresholds": DEFAULT_KM,
                    "label": "Recommended — 30/10/5 km"},
}

TIER_ORDER = ["Tertiary", "Secondary", "Primary"]


# --------------------------------------------------------------------------
# Geometry
# --------------------------------------------------------------------------
def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


# --------------------------------------------------------------------------
# Inputs
# --------------------------------------------------------------------------
def load_grids(year: str = "2025") -> tuple[list[dict], dict]:
    """Clean RBG grid cells for the year, plus a dropped-row report."""
    collection = rbg_grids.get_grids(year=year)
    lat_lo, lat_hi, lon_lo, lon_hi = HARYANA_BBOX
    grids, dropped_blank, dropped_bbox = [], 0, 0
    seen: dict[Any, int] = {}       # grid_id -> index in `grids`
    duplicate_ids = 0
    # Cells whose district is blank but which sit inside Haryana. The district
    # comes from a point-in-polygon join in rbg_grids.py, and border cells can
    # fall just outside every polygon. Dropping them would discard real accident
    # data — grid 3067212 carries severity 20 — so we hold them back and label
    # them from their nearest labelled neighbour once the main pass is done.
    orphans: list[dict] = []

    for feat in collection.get("features") or []:
        p = feat.get("properties") or {}
        district = (p.get("DISTRICT") or "").strip()
        lat, lon = p.get("centroid_lat"), p.get("centroid_lon")
        if lat is None or lon is None:
            dropped_bbox += 1
            continue
        if not (lat_lo <= lat <= lat_hi and lon_lo <= lon <= lon_hi):
            dropped_bbox += 1
            continue
        if not district:
            orphans.append(
                {
                    "grid_id": p.get("grid_id"),
                    "lat": float(lat),
                    "lon": float(lon),
                    "district": "",
                    "severity_score": float(p.get("severity_score") or 0.0),
                    "geometry": feat.get("geometry"),
                }
            )
            continue
        gid = p.get("grid_id")
        severity = float(p.get("severity_score") or 0.0)

        # The RBG feed emits 22 grid_ids twice, at identical coordinates but with
        # conflicting severity (grid 749087 arrives as both 22.0 and 7.0). Left
        # alone these cells are counted twice in every statistic and their
        # severity is whichever row happened to land last. We keep one row per
        # id and take the MAX severity — some duplicate pairs are byte-identical
        # (749592 is 2.0 twice), which points at a duplicated export rather than
        # two partial counts, so summing would inflate the risk.
        if gid in seen:
            duplicate_ids += 1
            prev = grids[seen[gid]]
            prev["severity_score"] = max(prev["severity_score"], severity)
            continue

        seen[gid] = len(grids)
        grids.append(
            {
                "grid_id": gid,
                "lat": float(lat),
                "lon": float(lon),
                "district": district,
                "severity_score": severity,
                "geometry": feat.get("geometry"),
            }
        )

    # Recover the border cells by inheriting the district of the nearest cell
    # that the polygon join did resolve. With ~6,700 labelled neighbours on a
    # 1 km lattice the nearest one is almost always immediately adjacent.
    recovered = 0
    for o in orphans:
        if o["grid_id"] in seen:
            duplicate_ids += 1
            prev = grids[seen[o["grid_id"]]]
            prev["severity_score"] = max(prev["severity_score"], o["severity_score"])
            continue
        nearest, best_km = None, 1e9
        for g in grids:
            km = haversine_km(o["lat"], o["lon"], g["lat"], g["lon"])
            if km < best_km:
                nearest, best_km = g, km
        if nearest is None or best_km > 25.0:
            dropped_blank += 1
            continue
        o["district"] = nearest["district"]
        o["district_source"] = "nearest_neighbour"
        seen[o["grid_id"]] = len(grids)
        grids.append(o)
        recovered += 1

    report = {
        "kept": len(grids),
        "recovered_blank_district": recovered,
        "dropped_blank_district": dropped_blank,
        "dropped_outside_haryana": dropped_bbox,
        "merged_duplicate_grid_ids": duplicate_ids,
        "year": year,
    }
    return grids, report


def _copy_block_from_sql(table: str) -> list[dict]:
    """Parse one COPY block out of the canonical geolocations dump.

    Fallback when PostGIS isn't reachable. Same source the database is loaded
    from, so the rows are identical — this lets the precompute, the scripts and
    the tests run on a machine with no DB up.
    """
    import re

    path = os.path.join(os.path.dirname(DATA_DIR), "latest data", "geolocations latest.sql")
    text = open(path, encoding="utf-8", errors="replace").read()
    m = re.search(
        rf"^COPY public\.{re.escape(table)} \((.+?)\) FROM stdin;\n(.*?)^\\\.$",
        text,
        re.M | re.S,
    )
    if not m:
        raise RuntimeError(f"{table} COPY block not found in {path}")
    cols = [c.strip() for c in m.group(1).split(",")]
    return [
        dict(zip(cols, line.split("\t")))
        for line in m.group(2).strip("\n").split("\n")
        if line
    ]


def _hospitals_from_sql() -> list[dict]:
    return _copy_block_from_sql("haryana_hosp")


# --------------------------------------------------------------------------
# Blood storage (BS) — the "GPS of BS" the brief asks for alongside deliverable A
# --------------------------------------------------------------------------
_bloodbank_cache: list[dict] | None = None


def load_bloodbanks() -> list[dict]:
    """Blood storage centres with GPS, district-normalised.

    Small (108 rows) and static, so cached for the process lifetime. Reads the
    database when it is up and falls back to the SQL dump when it is not.
    """
    global _bloodbank_cache  # noqa: PLW0603 — module-level memo, same as hospitals
    if _bloodbank_cache is not None:
        return _bloodbank_cache

    try:
        from db import fetch_all

        rows = fetch_all(
            "SELECT s_no, district_name, blood_centre_name, blood_centre_address, "
            "latitude, longitude FROM public.haryana_bloodbanks "
            "WHERE latitude IS NOT NULL AND longitude IS NOT NULL"
        )
    except Exception:  # noqa: BLE001 — DB optional, see _copy_block_from_sql
        rows = _copy_block_from_sql("haryana_bloodbanks")

    out = []
    for r in rows:
        try:
            lat, lon = float(r["latitude"]), float(r["longitude"])
        except (TypeError, ValueError, KeyError):
            continue
        # The dump's first cell carries a UTF-8 BOM; strip it or s_no is "﻿1".
        out.append(
            {
                "s_no": str(r["s_no"]).lstrip("﻿").strip(),
                "name": (r.get("blood_centre_name") or "").strip(),
                "address": (r.get("blood_centre_address") or "").strip(),
                "district": districts.normalize((r.get("district_name") or "").strip()),
                "district_raw": (r.get("district_name") or "").strip(),
                "latitude": lat,
                "longitude": lon,
            }
        )
    out.sort(key=lambda b: (b["district"], b["name"]))
    _bloodbank_cache = out
    return out


# The hospital table is small (1,208 rows) and changes only when the DB is
# reloaded, but building it can mean parsing a 100 MB SQL dump. Cache it —
# without this, every grid-detail click re-reads the file and the request hangs.
_hospital_cache: list[dict] | None = None
_hospital_cache_lock = __import__("threading").Lock()


def invalidate_hospital_cache() -> None:
    global _hospital_cache
    with _hospital_cache_lock:
        _hospital_cache = None


def load_hospitals() -> list[dict]:
    """All hospitals with TPL score, tier and provenance attached (cached)."""
    global _hospital_cache
    with _hospital_cache_lock:
        if _hospital_cache is not None:
            return _hospital_cache
        _hospital_cache = _load_hospitals_uncached()
        return _hospital_cache


def _tpl_only_hospitals(known: set[str]) -> list[dict]:
    """Rows present in hospital_tpl.csv but absent from the hospital table."""
    path = os.path.join(DATA_DIR, "hospital_tpl.csv")
    if not os.path.exists(path):
        return []
    extra = []
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for r in csv.DictReader(fh):
            sno = (r.get("s_no") or "").strip()
            if not sno or sno in known:
                continue
            try:
                lat, lon = float(r["latitude"]), float(r["longitude"])
            except (TypeError, ValueError, KeyError):
                continue
            extra.append(
                {
                    "s_no": sno,
                    "hospital_name": (r.get("hospital_name") or "").strip(),
                    "district_name": (r.get("district_name") or "").strip(),
                    "hosp_type": (r.get("hosp_type") or "").strip(),
                    "latitude": lat,
                    "longitude": lon,
                }
            )
    return extra


def _load_hospitals_uncached() -> list[dict]:
    try:
        from db import fetch_all

        rows = fetch_all(
            "SELECT s_no, district_name, hospital_name, latitude, longitude, hosp_type "
            "FROM public.haryana_hosp "
            "WHERE latitude IS NOT NULL AND longitude IS NOT NULL"
        )
    except Exception:  # noqa: BLE001 — DB optional, see _hospitals_from_sql
        rows = _hospitals_from_sql()

    hospitals = []
    for r in rows:
        try:
            lat, lon = float(r["latitude"]), float(r["longitude"])
        except (TypeError, ValueError):
            continue
        h = {
            "s_no": str(r["s_no"]).lstrip("﻿").strip(),
            "hospital_name": (r["hospital_name"] or "").strip(),
            "district_name": (r["district_name"] or "").strip(),
            "hosp_type": (r["hosp_type"] or "").strip(),
            "latitude": lat,
            "longitude": lon,
        }
        hospitals.append(h)

    # Facilities present in hospital_tpl.csv but absent from haryana_hosp.
    # Historically this is where the six mocked government medical colleges
    # landed (removed 20 Aug 2026 — see build_tpl.py); every hospital_tpl.csv
    # row now traces back to a real haryana_hosp s_no, so this is currently
    # always empty. Left in place as a safety net, not dead weight: a future
    # dump introducing a facility our table genuinely lacks should still
    # surface here rather than silently vanish.
    hospitals.extend(_tpl_only_hospitals({h["s_no"] for h in hospitals}))

    tpl_mod.attach(hospitals)
    for h in hospitals:
        h["is_private"] = h["hosp_type"] == PRIVATE_TYPE
        # haryana_hosp holds 44 spellings for 22 districts (private rows are
        # UPPERCASE, public rows Title Case, and some use the old HQ town name —
        # 'Narnaul' for Mahendragarh). Carry a canonical key so district filters
        # don't silently return only half the network. See districts.py.
        h["district_norm"] = districts.normalize(h["district_name"])
        if not h.get("tier"):
            h["tier"] = tpl_mod.tier_of(h)
    return hospitals


# --------------------------------------------------------------------------
# Cached proximity artifact
# --------------------------------------------------------------------------
def artifact_path(year: str) -> str:
    return os.path.join(ANALYTICS_DIR, f"grid_hospital_{year}.json")


# The artifact is ~18 MB of JSON. Parsing it per request would dominate every
# response, so keep it in memory and reload only when the file changes on disk.
_proximity_cache: dict[str, tuple[float, dict]] = {}


def load_proximity(year: str = "2025") -> dict:
    path = artifact_path(year)
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"Proximity cache missing: {path}\n"
            "Run:  python3 scripts/precompute_network_analytics.py --year " + year
        )
    # The hospital facts baked into the artifact are whatever was true when the
    # (expensive) road matrix was built. Levels and TPL live in
    # hospital_tpl.csv and change far more often than the matrix does, so the
    # cache key covers BOTH files and the facts are re-merged on load.
    # Without this, editing the level mapping would silently do nothing until
    # someone re-ran an hour-long precompute.
    mtime = (os.path.getmtime(path), _tpl_mtime())
    hit = _proximity_cache.get(year)
    if hit and hit[0] == mtime:
        return hit[1]
    with open(path) as f:
        payload = json.load(f)
    _merge_hospital_facts(payload)
    _proximity_cache[year] = (mtime, payload)
    return payload


def _tpl_mtime() -> float:
    path = os.path.join(DATA_DIR, "hospital_tpl.csv")
    return os.path.getmtime(path) if os.path.exists(path) else 0.0


def _merge_hospital_facts(payload: dict) -> None:
    """Refresh the artifact's hospital dict from the current TPL table.

    Adds hosp_level (absent from older artifacts) and any hospital the matrix
    predates. (Until 20 Aug 2026 this was mainly the six mocked MCH rows,
    merged in by a now-retired scripts/add_mch_distances.py — real hospitals
    added since then go through the normal precompute like everything else.)
    """
    hospitals = payload.get("hospitals")
    if not isinstance(hospitals, dict):
        return
    for h in load_hospitals():
        cur = hospitals.get(h["s_no"])
        fresh = {
            "hospital_name": h["hospital_name"],
            "district_name": h["district_name"],
            "hosp_type": h["hosp_type"],
            "tier": h["tier"],
            "hosp_level": h.get("hosp_level", ""),
            "level_source": h.get("level_source", ""),
            "is_private": h["is_private"],
            "lat": h["latitude"],
            "lon": h["longitude"],
            "tpl": h.get("tpl_total"),
            "tpl_source": h.get("tpl_source"),
            "coord_status": h.get("coord_status", "ok"),
            "coord_note": h.get("coord_note", ""),
        }
        hospitals[h["s_no"]] = {**(cur or {}), **fresh}


# --------------------------------------------------------------------------
# Deliverable 1 — grid x hospital proximity
# --------------------------------------------------------------------------
def _candidate_filter(
    candidates: Iterable[dict],
    hospitals: dict[str, dict],
    types: set[str] | None,
    include_private: bool,
) -> list[dict]:
    out = []
    for c in candidates:
        h = hospitals.get(c["s_no"])
        if h is None:
            continue
        if not include_private and h["is_private"]:
            continue
        if types is not None and h["hosp_type"] not in types:
            continue
        out.append(c)
    out.sort(key=lambda c: c["road_km"])
    return out


# --- hospital-centric view (the requirement's actual shape) ---------------
# 1a lists hospital fields, 1b lists grid fields: "for each hospital, the grids
# it serves within 60 km". Built by the same OSRM pass but stored untruncated
# and indexed by hospital, because the grid-centric artifact keeps only the
# nearest N per type per grid and therefore loses most pairs.
_hospital_grid_cache: dict[str, tuple[float, dict]] = {}


def hospital_grid_path(year: str) -> str:
    return os.path.join(ANALYTICS_DIR, f"hospital_grid_{year}.json")


def load_hospital_grid(year: str = "2025") -> dict:
    path = hospital_grid_path(year)
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"Hospital-grid cache missing: {path}\n"
            "Run:  python3 scripts/precompute_network_analytics.py --year " + year
        )
    # Same reasoning as load_proximity: the artifact's hospital facts are
    # frozen at matrix-build time, but levels change with hospital_tpl.csv.
    # Key on both files and re-merge on load.
    mtime = (os.path.getmtime(path), _tpl_mtime())
    hit = _hospital_grid_cache.get(year)
    if hit and hit[0] == mtime:
        return hit[1]
    with open(path) as f:
        payload = json.load(f)
    _merge_hospital_facts(payload)
    _hospital_grid_cache[year] = (mtime, payload)
    return payload


def hospital_radius_km(h: dict) -> float:
    """The road-reach radius that applies to ONE hospital, from its level.

    Deliverable A is per-level, not a flat 60 km for everything: an L1 medical
    college serves grids within 60 km, an L2 district hospital 30 km, an L3
    CHC/PHC only 10 km. Using one radius for all of them credited a PHC with
    grids 55 km away, which is not a claim anyone would defend.

    Anything without a recognised level falls back to the cache radius, so an
    unclassified facility is never silently dropped from the export.

    Keyed on counts_at_level(), NOT on the raw hosp_level label. 561 empanelled
    private hospitals carry hosp_level "L2" — 386 of them only because
    build_tpl.derive_level() defaults an unclassified private facility to L2 —
    but the spec's L2 is "DH / DCH" and eligible_at_level() excludes them.
    Reading the label here handed every one of those a 30 km L2 catchment in the
    export while the reach analysis was simultaneously scoring the same facility
    as not an L2 at all. A facility that does not count at a level does not get
    that level's radius; it falls back to the cache radius, so it is still
    exported, just not as a tier provider.
    """
    lv = counts_at_level(h)
    # ALL_LEVEL_RADII, so an empanelled private hospital gets EP's 60 km as its
    # OWN level's radius rather than falling through to the cache radius by
    # coincidence. The number is the same today; the reason it is 60 is not.
    return ALL_LEVEL_RADII.get(lv, PROXIMITY_KM)


def clip_to_level(pairs: list, h: dict, per_level: bool) -> list:
    """Trim a hospital's nearest-first grid list to its own level's radius."""
    if not per_level:
        return pairs
    r = hospital_radius_km(h)
    # pairs are sorted nearest-first, so stop at the first one out of range.
    for i, (_gi, km) in enumerate(pairs):
        if km > r:
            return pairs[:i]
    return pairs


def hospital_coverage_summary(
    year: str = "2025",
    district: str | None = None,
    types: set[str] | None = None,
    per_level: bool = True,
    include_ep: bool = True,
) -> dict:
    """One row per hospital: how many grids it reaches within its radius.

    per_level=True (the deliverable's rule) scopes each hospital to its own
    level: L1 60 km, L2 30 km, L3 10 km. Pass False to get the old flat 60 km
    view, which is still useful for "who could reach this cell at all".
    """
    import districts as _d

    payload = load_hospital_grid(year)
    hospitals = payload["hospitals"]
    want = _d.normalize(district) if district else None

    rows = []
    total_pairs = 0
    for s_no, h in hospitals.items():
        if types is not None and h["hosp_type"] not in types:
            continue
        # The ignore-EP toggle excludes empanelled private hospitals from this
        # deliverable entirely, not just from the map — "how many grids does
        # each hospital reach" should not still be counting a population the
        # rest of the app has been told to leave out.
        if not include_ep and h["hosp_type"] == PRIVATE_TYPE:
            continue
        if want and _d.normalize(h["district_name"]) != want:
            continue
        pairs = clip_to_level(payload["hospital_grids"].get(s_no, []), h, per_level)
        total_pairs += len(pairs)
        rows.append(
            {
                "hospital_id": s_no,
                "hospital_name": h["hospital_name"],
                "hosp_type": h["hosp_type"],
                "tier": h["tier"],
                # THE VERDICT, not the dump's label (25 Aug 2026). The charts
                # that read this group facilities by level, and the raw label
                # still calls every empanelled private hospital "L1" — which
                # would rebuild, in the charts, exactly the conflation the EP
                # split removed from the map. The label is kept alongside for
                # provenance, under a name that says it is a claim.
                "hosp_level": counts_at_level(h),
                "hosp_level_labelled": h.get("hosp_level", ""),
                "radius_km": hospital_radius_km(h) if per_level else payload["radius_km"],
                "district": _d.normalize(h["district_name"]),
                "latitude": h["lat"],
                "longitude": h["lon"],
                "tpl": h.get("tpl"),
                "tpl_source": h.get("tpl_source"),
                "grids_within_radius": len(pairs),
                "nearest_grid_km": pairs[0][1] if pairs else None,
                "farthest_grid_km": pairs[-1][1] if pairs else None,
            }
        )
    rows.sort(key=lambda r: r["grids_within_radius"], reverse=True)
    totals = dict(payload["totals"])
    totals["pairs"] = total_pairs
    return {
        "year": year,
        "radius_km": payload["radius_km"],
        "per_level": per_level,
        "include_ep": include_ep,
        "level_radii": dict(ALL_LEVEL_RADII),
        "distance_model": payload.get("distance_model"),
        "hospitals": rows,
        "totals": totals,
    }


HOSPITAL_GRID_FIELDS = [
    # 1a — hospital
    "hospital_id",
    "hospital_name",
    "hospital_type",
    "hospital_tier",
    "hospital_level",
    "hospital_level_labelled",
    "level_radius_km",
    "hospital_latitude",
    "hospital_longitude",
    "tpl_score",
    "tpl_source",
    # 1b — grid
    "grid_rank",
    "grid_id",
    "grid_latitude",
    "grid_longitude",
    "grid_district",
    "grid_severity_score",
    "road_km_from_hospital",
]


def iter_hospital_grid_rows(
    year: str = "2025",
    hospital_id: str | None = None,
    district: str | None = None,
    types: set[str] | None = None,
    max_rows: int | None = None,
    top_per_hospital: int | None = None,
    per_level: bool = True,
    include_ep: bool = True,
):
    """Yield hospital -> grid rows, ONE HOSPITAL AT A TIME.

    Hospitals are emitted in ascending hospital_id, and within each hospital the
    grids run nearest-first with a `grid_rank` counter. So the file reads as
    "hospital 1 and all its grids, then hospital 2 and all of its grids…", which
    is the shape the requirement describes (1a hospital fields, then 1b grid
    fields).

    This is a generator because the unfiltered result is ~1.48 M rows / ~250 MB.
    Materialising that in a list before sending would spike memory and stall the
    response; streaming keeps it flat and starts the download immediately.
    """
    import districts as _d

    payload = load_hospital_grid(year)
    hospitals = payload["hospitals"]
    index = payload["grid_index"]
    want = _d.normalize(district) if district else None

    def sort_key(s: str):
        return (0, int(s)) if str(s).isdigit() else (1, str(s))

    emitted = 0
    for s_no in sorted(payload["hospital_grids"].keys(), key=sort_key):
        if hospital_id and str(s_no) != str(hospital_id):
            continue
        h = hospitals.get(s_no)
        if not h:
            continue
        if types is not None and h["hosp_type"] not in types:
            continue
        if not include_ep and h["hosp_type"] == PRIVATE_TYPE:
            continue
        if want and _d.normalize(h["district_name"]) != want:
            continue

        pairs = clip_to_level(payload["hospital_grids"][s_no], h, per_level)
        if top_per_hospital:
            pairs = pairs[:top_per_hospital]  # already sorted nearest-first
        for rank, (gi, km) in enumerate(pairs, start=1):
            g = index[gi]
            yield {
                "hospital_id": s_no,
                "hospital_name": h["hospital_name"],
                "hospital_type": h["hosp_type"],
                "hospital_tier": h["tier"],
                # The VERDICT level, so an empanelled private hospital exports
                # as EP rather than as the L1 the dump still labels it.
                "hospital_level": counts_at_level(h),
                "hospital_level_labelled": h.get("hosp_level", ""),
                # BOTH districts ride on every row, because this table joins two
                # things that live in different ones. The `district=` filter on
                # this function selects by HOSPITAL district, while the row is
                # about a grid that may well sit elsewhere — a Sonipat hospital
                # legitimately covers grids in Panipat. Carrying only one of the
                # two made "per district" ambiguous in exports.
                "hospital_district": _dn(h["district_name"]),
                "level_radius_km": hospital_radius_km(h) if per_level else PROXIMITY_KM,
                "hospital_latitude": h["lat"],
                "hospital_longitude": h["lon"],
                "tpl_score": h.get("tpl"),
                "tpl_source": h.get("tpl_source"),
                "grid_rank": rank,
                "grid_id": g["grid_id"],
                "grid_latitude": g["lat"],
                "grid_longitude": g["lon"],
                "grid_district": g["district"],
                "grid_severity_score": g["severity_score"],
                "road_km_from_hospital": km,
            }
            emitted += 1
            if max_rows and emitted >= max_rows:
                return


def hospital_grid_rows(
    year: str = "2025",
    hospital_id: str | None = None,
    district: str | None = None,
    types: set[str] | None = None,
    max_rows: int | None = None,
    top_per_hospital: int | None = None,
    per_level: bool = True,
    include_ep: bool = True,
) -> list[dict]:
    """List form of iter_hospital_grid_rows, for callers that need it in memory.

    `per_level` and `top_per_hospital` were missing from this signature while
    /api/analytics/hospital/<id>/grids was already passing per_level through,
    so that route raised TypeError on every call — which is what the Proximity
    tab uses to plot a selected hospital's catchment. Kept in step with
    iter_hospital_grid_rows deliberately: a wrapper that silently drops an
    argument is worse than no wrapper.
    """
    return list(
        iter_hospital_grid_rows(
            year=year,
            hospital_id=hospital_id,
            district=district,
            types=types,
            max_rows=max_rows,
            top_per_hospital=top_per_hospital,
            per_level=per_level,
            include_ep=include_ep,
        )
    )


# --- deliverable 2 -------------------------------------------------------
# "Grids which do not have ANY of the three hospital types within N km by road."
#
# STRICT / AND rule: a grid qualifies only when tertiary, secondary AND primary
# care are all beyond the threshold. Missing one tier is not enough.
#
# PUBLIC ONLY. "tertiary, secondary and primary hospital" means the classified
# public tiers — DCH, CH_SDH, CHC, PHC. The 614 empanelled private hospitals are
# excluded, which is also the defensible choice for a government coverage
# analysis: it measures what the state actually controls.
#
# At 60 km the answer is ZERO — every grid in Haryana has a PHC within 60 km by
# road. That is a real finding, not a bug, which is why the threshold is a slider:
# 40 km yields 2 grids, 20 km yields 41, 10 km yields 450. PHC density is the
# binding constraint (median grid is 6.6 km from one).
PUBLIC_TIER_BY_TYPE = {
    "DCH": "Tertiary",
    "CH_SDH": "Secondary",
    "CHC": "Secondary",
    "PHC": "Primary",
}
STRICT_GAP_DEFAULT_KM = 60.0


# ==========================================================================
# L1 / L2 / L3 facility levels — the trauma-network spec's own vocabulary
# ==========================================================================
# The spec fixes both the membership and the road-reach radius of each level:
#
#     L1  MCH / SSH                        60 km
#     L2  DH / DCH                         30 km
#     L3  CHC, SDH, SSH, PHC, UPHC         10 km
#
# Deliverable A asks for the grids that SATISFY all three at once; deliverable
# B asks for the grids that do not. Both run over PUBLIC facilities only —
# empanelled private hospitals are excluded by instruction.
#
# CAUTION ON L1. `haryana_hosp` contains no MCH or SSH rows whatsoever, and
# neither does the partner's own live hosp_gps feed for the whole state —
# checked directly, not assumed. L1 facilities in play are therefore real
# PRIVATE hospitals whose name or the TPL dump's own hosp_level column marks
# them L1 (SGT Medical College, Amrita Institute, and similar — see
# build_tpl.py's derive_level()). This module makes a single, level-scoped
# exception for them: private counts at L1 only, never L2/L3, which stay
# public-only exactly as the spec asks. (Until 20 Aug 2026 L1 was six
# fabricated government medical colleges with hand-picked coordinates — that
# mock is gone, and L1 numbers now reflect real facilities at real places.)
#
# EMPANELLED PRIVATE SPLIT OUT OF L1 (25 Aug 2026, team lead's instruction).
# Everything above describes how it USED to work: the 614 empanelled private
# hospitals were counted as L1 because Haryana has no public MCH/SSH, which
# made "L1 in reach" true for 6,737 of 6,760 grids and hid the fact that the
# STATE owns no L1 facility anywhere. They are now their own category, EP.
#
# The consequence is deliberate and is the point of the change:
#
#     L1  public MCH / SSH        60 km    ZERO facilities -> every grid fails
#     L2  DH / DCH                30 km    22 facilities
#     L3  CHC / SDH / PHC / UPHC  10 km    572 facilities
#     EP  Empanelled private      60 km    614 facilities
#
# EP keeps L1's old 60 km radius, so its numbers carry over unchanged from
# what L1 used to report — this is a re-labelling, not a re-measurement.
#
# SCORING STAYS ON THE THREE PUBLIC LEVELS. The four-colour grid ramp still
# counts how many of L1/L2/L3 a grid reaches (0-3), because that is the
# question about state provision. EP does not add a fourth point to that
# score; it paints PURPLE over grids whose only facility in reach is private
# (see _verdict_index), which is a different statement from "well covered".
EP_LEVEL = "EP"
EP_RADIUS_KM = 60.0

# The public scoring triple. Every "how many levels does this grid meet"
# calculation iterates THIS, and only this.
LEVEL_ORDER = ["L1", "L2", "L3"]
LEVEL_RADII = {"L1": 60.0, "L2": 30.0, "L3": 10.0}

# Everything the UI can toggle, filter or export by — the scoring triple plus
# EP. Consumers that enumerate levels for DISPLAY (toggles, popups, per-level
# exports, the nearest-facility index) iterate this one.
ALL_LEVEL_ORDER = [*LEVEL_ORDER, EP_LEVEL]
ALL_LEVEL_RADII = {**LEVEL_RADII, EP_LEVEL: EP_RADIUS_KM}


def _dn(name):
    """Canonical district label.

    A module-level shim over districts.normalize so the hot paths below are not
    each re-importing it inside a loop. Every district string this module HANDS
    OUT should go through here: the raw dump spells the same district several
    ways (Sonepat/SONIPAT, Hissar/HISAR, Mewat/NUH), and shipping the raw value
    is what made mode 3's facility search find nothing.
    """
    import districts as _d

    return _d.normalize(name)


# L1 is named for what it now CONTAINS, not for what the spec's L1 row says.
# Since 20 Aug 2026 every empanelled private hospital is L1 (see
# scripts/build_tpl.py). Calling that "Medical College / Super Speciality" on
# screen would put a claim in front of the reader that 614 facilities cannot
# support — Haryana has no public MCH/SSH in this data at all.
LEVEL_LABEL = {
    # L1 is back to the spec's own definition and now has ZERO members. That
    # empty set is the finding, so the label must state what L1 is supposed to
    # be rather than renaming itself after whatever happens to be in it.
    "L1": "L1 — Medical College / Super Speciality (public)",
    "L2": "L2 — District Hospital",
    "L3": "L3 — CHC / SDH / PHC / UPHC",
    EP_LEVEL: "EP — Empanelled Private Hospital",
}
# Shown wherever a level is named and the count would otherwise puzzle a reader.
LEVEL_NOTE = {
    "L1": "No public L1 facility exists anywhere in this data, so every grid "
          "fails L1 by 60 km. That absence is the gap, not a missing input.",
    EP_LEVEL: "Private capacity, measured at the same 60 km L1 used to use. "
              "Counted separately from state provision, never folded into it.",
}
# SSH appears in BOTH L1 and L3 in the spec as written. We treat it as L1, on
# the grounds that a super-speciality hospital's capability sits above a PHC's.
# Flagged for the team lead rather than silently resolved.
# None of these four types is an MCH or an SSH, which is exactly why L1 is
# empty — the state simply operates no facility at that tier in this data.
PUBLIC_LEVEL_TYPES = {"DCH", "CH_SDH", "CHC", "PHC"}


def eligible_at_level(h: dict, lv: str) -> bool:
    """Does this facility count as an L1/L2/L3 provider for reach analysis?

    ONE definition, used by every consumer — the Overall verdict, the per-grid
    branches and the per-level hospital view. They have to agree: if the
    hospital view called a grid green for L1 while the overall view scored the
    same grid as missing L1, the tab would be contradicting itself on screen.

    The two populations no longer overlap (25 Aug 2026). Public facilities
    count at whatever public level their type maps to and NEVER at EP; every
    empanelled private hospital counts at EP and NEVER at a public level, L1
    included. Before this split private counted at L1, which is what made L1
    look almost fully covered while the state itself owned nothing at that
    tier — see the EMPANELLED PRIVATE SPLIT note above.
    """
    if h.get("hosp_type") == PRIVATE_TYPE:
        return lv == EP_LEVEL
    return h.get("hosp_type") in PUBLIC_LEVEL_TYPES and lv != EP_LEVEL


def counts_at_level(h: dict) -> str:
    """The level this facility ACTUALLY counts at for reach, or "" if none.

    `hosp_level` is a LABEL. This is the VERDICT, and the two are not the same
    thing for 570 of the 1,208 facilities. build_tpl.derive_level() has to put
    some level on every row, so an empanelled private hospital it knows nothing
    else about is defaulted to L2 (`level_source = private_default`, 386 rows)
    or takes whatever the TPL dump said (175 more). The spec's L2 is "DH / DCH",
    so eligible_at_level() counts none of them — leaving the map painting 583
    facilities in L2 colours while the L2 analysis recognised 22.

    That is the contradiction eligible_at_level's own docstring warns about, and
    it was visible on screen: grid 743223 has a facility labelled L2 2.65 km
    away and the L2 branch routed 13.41 km past it to District Civil Hospital
    Sirsa. The route was right. The label was the lie.

    Every consumer that needs "what tier does this facility provide" must call
    THIS, never read hosp_level directly. hosp_level remains the raw label, for
    provenance and for showing the reader what the source data claimed.

    An empanelled private hospital short-circuits to EP whatever the dump's
    label says. The dump labels all 614 of them L1, and reading that label
    literally after the 25 Aug split would put them back into a public level
    the split exists to empty.
    """
    if h.get("hosp_type") == PRIVATE_TYPE:
        return EP_LEVEL
    lv = (h.get("hosp_level") or "").strip().upper()
    if lv not in LEVEL_RADII:  # public never counts at EP
        return ""
    return lv if eligible_at_level(h, lv) else ""


def _normalize_radii(radii) -> dict[str, float]:
    """Accept None, a scalar, or a partial dict; always return all four levels.

    EP defaults to its own 60 km rather than to a scalar caller's value unless
    that caller explicitly names it: the sliders on the Proximity tab move the
    three public radii, and silently dragging the private radius along with
    them would change what "private in reach" means without saying so.
    """
    if radii is None:
        return dict(ALL_LEVEL_RADII)
    if isinstance(radii, (int, float)):
        return {**{lv: float(radii) for lv in LEVEL_ORDER}, EP_LEVEL: EP_RADIUS_KM}
    return {lv: float(radii.get(lv, ALL_LEVEL_RADII[lv])) for lv in ALL_LEVEL_ORDER}


# The grid->hospital artifact keeps only the KEEP_PER_TYPE nearest facilities
# of each hosp_type per grid (12, at time of writing). For public levels that
# is harmless — L2 is DCH only and L3 is CHC/CH_SDH/PHC, so the nearest of the
# type is always inside the kept slice. For L1 it was silently WRONG: every L1
# is an "Empanelled Private Hospital", a type with 614 members, so a grid's 12
# nearest private facilities are almost always L2 privates and any L1 sitting
# 40-60 km out fell off the list entirely. That reported 4,199 grids with an L1
# in reach when the true figure is 6,605 — a headline number, wrong by half.
#
# The hospital->grid artifact does NOT truncate: it stores every grid within
# 60 km of each hospital. Inverting it gives the exact nearest facility per
# level. That is what this does. Both spec radii below 60 km (L2's 30, L3's 10)
# are fully covered by it; nothing beyond 60 km is knowable from either
# artifact, which is why a facility further out still reads as "none".
LEVEL_INDEX_MAX_KM = 60.0

_level_nearest_cache: dict[str, tuple[tuple, dict]] = {}


def _nearest_by_level(year: str) -> dict[int, dict[str, dict]]:
    """grid_index -> {level: nearest facility record}, exact within 60 km."""
    stamp = (
        os.path.getmtime(hospital_grid_path(year)),
        os.path.getmtime(artifact_path(year)),
        _tpl_mtime(),
    )
    hit = _level_nearest_cache.get(year)
    if hit and hit[0] == stamp:
        return hit[1]

    hg = load_hospital_grid(year)
    hospitals = hg["hospitals"]
    best: dict[int, dict[str, dict]] = {}

    for s_no, pairs in hg["hospital_grids"].items():
        h = hospitals.get(s_no)
        if not h:
            continue
        # counts_at_level, never the raw hosp_level label: it is the one place
        # that knows an empanelled private row labelled "L1" is an EP facility.
        lv = counts_at_level(h)
        if not lv:
            continue
        for gi, km in pairs:
            slot = best.setdefault(gi, {})
            cur = slot.get(lv)
            if cur is None or km < cur["road_km"]:
                slot[lv] = {
                    "s_no": s_no,
                    "name": h["hospital_name"],
                    "type": h["hosp_type"],
                    "level": lv,
                    # NORMALISED (24 Aug 2026). This was the raw dump value, so
                    # the same facility read "Sonepat" in a grid popup and
                    # "SONIPAT" everywhere else, and the verdict CSV shipped
                    # both spellings in adjacent columns. Same fix, same reason
                    # as proximity_level_view: one district vocabulary or the
                    # app quietly looks like it has two datasets.
                    "district": _dn(h["district_name"]),
                    "lat": h["lat"],
                    "lon": h["lon"],
                    "tpl": h.get("tpl"),
                    "tpl_source": h.get("tpl_source"),
                    # Carried so a grid popup can warn that the facility it is
                    # naming sits at a coordinate we already know is wrong
                    # (build_tpl.UNVERIFIED_COORDS) — the road distance below
                    # was measured FROM that wrong point, so the number itself
                    # is suspect and the reader has to be told.
                    "coord_status": h.get("coord_status", "ok"),
                    "road_km": km,
                    "drive_min": None,
                }

    _level_nearest_cache[year] = (stamp, best)
    return best


def _grid_level_distances(year: str, district: str | None):
    """Yield (grid, nearest-eligible-facility-per-LEVEL) for each grid.

    Distances come from the untruncated hospital->grid artifact (see the note
    above); `drive_min` is filled in from the grid's own candidate list where
    that same facility happens to appear there, and left None otherwise rather
    than being estimated from the distance.
    """
    import districts as _d

    payload = load_proximity(year)
    want = _d.normalize(district) if district else None

    by_level = _nearest_by_level(year)
    hg = load_hospital_grid(year)
    gi_of = {g["grid_id"]: i for i, g in enumerate(hg["grid_index"])}

    for g in payload["grids"]:
        if want and _d.normalize(g["district"]) != want:
            continue
        slot = by_level.get(gi_of.get(g["grid_id"], -1), {})
        drive = {c["s_no"]: c.get("drive_min") for c in g["candidates"]}
        nearest: dict[str, dict | None] = {}
        # ALL four, EP included. Scoring still only reads the public three; EP
        # rides along so popups, the purple override and the exports can all
        # answer "what private capacity is in reach" off the same single pass.
        for lv in ALL_LEVEL_ORDER:
            n = slot.get(lv)
            nearest[lv] = None if n is None else {**n, "drive_min": drive.get(n["s_no"])}
        yield g, nearest


def _level_record(g: dict, nearest: dict, radii: dict[str, float], levels=None) -> dict:
    """One grid's verdict: which levels it reaches, which it misses.

    `levels` restricts which of L1/L2/L3 count toward the verdict, so the UI can
    isolate a single level ("no L2 within 30 km") without the other two
    dragging grids into the result.
    """
    active = list(levels or LEVEL_ORDER)
    met, missed = [], []
    for lv in active:
        n = nearest[lv]
        (met if (n and n["road_km"] <= radii[lv]) else missed).append(lv)
    return {
        "grid_id": g["grid_id"],
        "lat": g["lat"],
        "lon": g["lon"],
        "district": g["district"],
        "severity_score": g["severity_score"],
        "nearest": nearest,
        "levels_met": met,
        "levels_missed": missed,
        "n_missed": len(missed),
        "in_reach": not missed,
        "closest_any_km": min(
            (nearest[lv]["road_km"] for lv in active if nearest[lv]), default=None
        ),
    }


def level_reach(
    year: str = "2025",
    radii=None,
    district: str | None = None,
    mode: str = "complement",
    levels: list[str] | None = None,
    include_ep: bool = True,
) -> dict:
    """Grids classified against the L1/L2/L3 road-reach rule.

    Returns BOTH sides in one pass, because deliverables A and B are two views
    of the same computation:

      in_reach   grids meeting ALL THREE conditions  (deliverable A)
      out_reach  grids failing the rule              (deliverable B), where
                 mode="complement" -> fails AT LEAST ONE level (the true
                     complement of A; every grid lands in exactly one bucket)
                 mode="strict"     -> fails ALL THREE levels (the literal
                     reading of "not proximal to 60/30/10"; leaves grids that
                     pass some levels in NEITHER bucket, so the two sets no
                     longer partition the state)

    The strict reading is much the smaller set — with 60/30/10 it is a couple
    of dozen cells against a couple of thousand — which is why the mode is
    exposed rather than chosen for you.
    """
    radii = _normalize_radii(radii)
    # EP is selectable here, so "grids with no empanelled private hospital
    # within 60 km" is a first-class gap query alongside the public levels —
    # UNLESS include_ep is False, in which case it is dropped even from an
    # explicit ?levels=EP: the ignore toggle overrides that request rather
    # than silently honouring a query for data the rest of the app has been
    # told to treat as absent.
    active = [lv for lv in (levels or LEVEL_ORDER) if lv in ALL_LEVEL_RADII] or list(LEVEL_ORDER)
    if not include_ep:
        active = [lv for lv in active if lv != EP_LEVEL] or list(LEVEL_ORDER)
    strict = str(mode).lower() == "strict"

    in_reach: list[dict] = []
    out_reach: list[dict] = []
    partial = 0
    missed_by_level = {lv: 0 for lv in active}
    by_district: dict[str, dict] = {}
    total = 0
    sev_total = sev_out = 0.0

    for g, nearest in _grid_level_distances(year, district):
        rec = _level_record(g, nearest, radii, active)
        total += 1
        sev = rec["severity_score"] or 0.0
        sev_total += sev
        for lv in rec["levels_missed"]:
            missed_by_level[lv] += 1

        d = by_district.setdefault(
            rec["district"], {"district": rec["district"], "in_reach": 0, "out_reach": 0}
        )
        if rec["in_reach"]:
            in_reach.append(rec)
            d["in_reach"] += 1
            continue

        is_out = rec["n_missed"] == len(active) if strict else True
        if is_out:
            out_reach.append(rec)
            d["out_reach"] += 1
            sev_out += sev
        else:
            partial += 1

    in_reach.sort(key=lambda r: -(r["severity_score"] or 0))
    out_reach.sort(key=lambda r: -(r["severity_score"] or 0))
    pct = lambda n: round(100.0 * n / total, 3) if total else 0.0  # noqa: E731

    return {
        "year": year,
        "radii": radii,
        "levels": active,
        "include_ep": include_ep,
        "mode": "strict" if strict else "complement",
        "scope": "public_levels_only_plus_separate_ep",  # empanelled private is EP, not L1
        "total_grids": total,
        "in_reach": in_reach,
        "out_reach": out_reach,
        "in_count": len(in_reach),
        "out_count": len(out_reach),
        "in_pct": pct(len(in_reach)),
        "out_pct": pct(len(out_reach)),
        # Non-zero only in strict mode: grids that pass some levels and fail
        # others therefore belong to neither deliverable.
        "unclassified": partial,
        "severity_out_pct": round(100.0 * sev_out / sev_total, 2) if sev_total else 0.0,
        "missed_by_level": missed_by_level,
        "by_district": sorted(
            by_district.values(), key=lambda d: -d["out_reach"]
        ),
        "l1_is_mocked": False,  # removed 20 Aug 2026 — see PUBLIC_LEVEL_TYPES
    }


LEVEL_ROW_FIELDS = [
    "grid_id",
    "latitude",
    "longitude",
    "district",
    "severity_score",
    "verdict",
    "levels_met",
    "levels_missed",
]


def level_rows(payload: dict, which: str = "out_reach") -> list[dict]:
    """Flatten one side of level_reach() into CSV rows, one per grid."""
    radii = payload["radii"]
    rows = []
    for r in payload[which]:
        row = {
            "grid_id": r["grid_id"],
            "latitude": round(r["lat"], 6),
            "longitude": round(r["lon"], 6),
            "district": r["district"],
            "severity_score": r["severity_score"],
            "verdict": "IN REACH" if r["in_reach"] else "OUT OF REACH",
            "levels_met": "+".join(r["levels_met"]) or "none",
            "levels_missed": "+".join(r["levels_missed"]) or "none",
        }
        # EP columns ride on every row, whether or not EP was one of the levels
        # under analysis: "this grid fails L3, and the only thing within 60 km
        # is a private hospital 41 km away" is the sentence the export exists
        # to let someone write.
        active = set(r["levels_met"]) | set(r["levels_missed"])
        # The ignore toggle rides on the payload rather than a second
        # parameter here, since level_rows only ever flattens a level_reach()
        # result — payload["include_ep"] IS the answer for this whole export.
        export_levels = ALL_LEVEL_ORDER if payload.get("include_ep", True) else LEVEL_ORDER
        for lv in export_levels:
            n = r["nearest"][lv]
            low = lv.lower()
            row[f"{low}_threshold_km"] = radii[lv]
            # Status is the DISTANCE TEST, not membership of levels_met.
            # levels_met only lists the levels this run was scoped to, so
            # reading it here stamped "missed" on every level outside the
            # scope — an EP facility 6.33 km away, well inside its 60 km
            # radius, exported as missed in the l3_not_covered file. A level
            # that was not part of the run says so instead of failing it.
            met = bool(n and n["road_km"] <= radii[lv])
            row[f"{low}_status"] = (
                ("met" if met else "missed")
                if lv in active
                else ("in reach (not under analysis)" if met
                      else "out of reach (not under analysis)")
            )
            row[f"{low}_nearest_hospital"] = n["name"] if n else ""
            row[f"{low}_hosp_type"] = n["type"] if n else ""
            row[f"{low}_road_km"] = n["road_km"] if n else ""
            row[f"{low}_drive_min"] = n.get("drive_min") if n else ""
            row[f"{low}_tpl"] = n.get("tpl") if n else ""
        rows.append(row)
    return rows


# --------------------------------------------------------------------------
# Facility-TYPE segmentation
# --------------------------------------------------------------------------
# level_reach() above answers "is this grid within reach of an L1/L2/L3
# facility". That is the spec question, but it hides which *kind* of facility
# is doing the work: an L3 verdict is satisfied by a PHC or a CHC and the map
# cannot tell you which. The functions below run the same pass keyed on
# hosp_type instead of hosp_level, so the UI can put "gaps against CHCs only"
# next to "gaps against L2 only" and have both be real computations rather than
# one being a relabelling of the other.
#
# Radii are per-type and deliberately tighter as the facility gets smaller — a
# PHC 60 km away is not primary care in any useful sense. Private is included
# here (unlike the level pass, which is public-only) because "what changes if
# we count empanelled private" is a question worth being able to ask.
TYPE_RADII = {
    "DCH": 60.0,
    "CH_SDH": 30.0,
    "CHC": 20.0,
    "PHC": 10.0,
    PRIVATE_TYPE: 30.0,
}

TYPE_LABEL = {
    "DCH": "District Civil Hospital",
    "CH_SDH": "Civil / Sub-District Hospital",
    "CHC": "Community Health Centre",
    "PHC": "Primary Health Centre",
    PRIVATE_TYPE: "Empanelled Private",
}

TYPE_SHORT = {
    "DCH": "DCH",
    "CH_SDH": "CH/SDH",
    "CHC": "CHC",
    "PHC": "PHC",
    PRIVATE_TYPE: "Private",
}


def _normalize_type_radii(radii) -> dict[str, float]:
    """Accept None, a scalar, or a partial dict; always return all five types."""
    if radii is None:
        return dict(TYPE_RADII)
    if isinstance(radii, (int, float)):
        return {t: float(radii) for t in HOSP_TYPES}
    return {t: float(radii.get(t, TYPE_RADII[t])) for t in HOSP_TYPES}


def _grid_type_distances(year: str, district: str | None):
    """Yield (grid, nearest-facility-per-TYPE) for each grid.

    Mirrors _grid_level_distances but keys on hosp_type and keeps private
    facilities, so the caller can segment gaps by the kind of hospital rather
    than by its assigned service level.
    """
    import districts as _d

    payload = load_proximity(year)
    hospitals = payload["hospitals"]
    want = _d.normalize(district) if district else None

    for g in payload["grids"]:
        if want and _d.normalize(g["district"]) != want:
            continue
        nearest: dict[str, dict | None] = {t: None for t in HOSP_TYPES}
        for c in g["candidates"]:
            h = hospitals.get(c["s_no"])
            if not h:
                continue
            ht = h["hosp_type"]
            if ht not in nearest:
                continue
            cur = nearest[ht]
            if cur is None or c["road_km"] < cur["road_km"]:
                nearest[ht] = {
                    "s_no": c["s_no"],
                    "name": h["hospital_name"],
                    "type": ht,
                    "level": counts_at_level(h),
                    "district": h["district_name"],
                    "lat": h["lat"],
                    "lon": h["lon"],
                    "tpl": h.get("tpl"),
                    "tpl_source": h.get("tpl_source"),
                    "road_km": c["road_km"],
                    "drive_min": c.get("drive_min"),
                }
        yield g, nearest


def type_reach(
    year: str = "2025",
    radii=None,
    district: str | None = None,
    types: list[str] | None = None,
    mode: str = "complement",
) -> dict:
    """Grids classified against per-facility-type road-reach radii.

    `types` restricts which facility types count toward the verdict. Passing a
    single type answers "which grids have no CHC within 20 km" — the per-segment
    view the Gaps tab exposes as toggles. Passing all of them answers the
    combined question. Semantics of `mode` match level_reach(): complement
    fails at least one selected type, strict fails every one of them.
    """
    radii = _normalize_type_radii(radii)
    active = [t for t in (types or HOSP_TYPES) if t in TYPE_RADII]
    if not active:
        active = list(HOSP_TYPES)
    strict = str(mode).lower() == "strict"

    in_reach: list[dict] = []
    out_reach: list[dict] = []
    partial = 0
    missed_by_type = {t: 0 for t in active}
    by_district: dict[str, dict] = {}
    total = 0
    sev_total = sev_out = 0.0

    for g, nearest in _grid_type_distances(year, district):
        total += 1
        met, missed = [], []
        for t in active:
            n = nearest[t]
            (met if (n and n["road_km"] <= radii[t]) else missed).append(t)
        for t in missed:
            missed_by_type[t] += 1

        sev = g["severity_score"] or 0.0
        sev_total += sev

        rec = {
            "grid_id": g["grid_id"],
            "lat": g["lat"],
            "lon": g["lon"],
            "district": g["district"],
            "severity_score": g["severity_score"],
            "nearest": {t: nearest[t] for t in active},
            "types_met": met,
            "types_missed": missed,
            "n_missed": len(missed),
            "in_reach": not missed,
            "closest_any_km": min(
                (nearest[t]["road_km"] for t in active if nearest[t]), default=None
            ),
        }

        d = by_district.setdefault(
            rec["district"], {"district": rec["district"], "in_reach": 0, "out_reach": 0}
        )
        if rec["in_reach"]:
            in_reach.append(rec)
            d["in_reach"] += 1
            continue

        is_out = rec["n_missed"] == len(active) if strict else True
        if is_out:
            out_reach.append(rec)
            d["out_reach"] += 1
            sev_out += sev
        else:
            partial += 1

    in_reach.sort(key=lambda r: -(r["severity_score"] or 0))
    out_reach.sort(key=lambda r: -(r["severity_score"] or 0))
    pct = lambda n: round(100.0 * n / total, 3) if total else 0.0  # noqa: E731

    return {
        "year": year,
        "radii": {t: radii[t] for t in active},
        "types": active,
        "mode": "strict" if strict else "complement",
        "scope": "all_types",
        "total_grids": total,
        "in_reach": in_reach,
        "out_reach": out_reach,
        "in_count": len(in_reach),
        "out_count": len(out_reach),
        "in_pct": pct(len(in_reach)),
        "out_pct": pct(len(out_reach)),
        "unclassified": partial,
        "severity_out_pct": round(100.0 * sev_out / sev_total, 2) if sev_total else 0.0,
        "missed_by_type": missed_by_type,
        "by_district": sorted(by_district.values(), key=lambda d: -d["out_reach"]),
    }


def type_rows(payload: dict, which: str = "out_reach") -> list[dict]:
    """Flatten one side of type_reach() into CSV rows, one per grid."""
    radii = payload["radii"]
    active = payload["types"]
    rows = []
    for r in payload[which]:
        row = {
            "grid_id": r["grid_id"],
            "latitude": round(r["lat"], 6),
            "longitude": round(r["lon"], 6),
            "district": r["district"],
            "severity_score": r["severity_score"],
            "verdict": "IN REACH" if r["in_reach"] else "OUT OF REACH",
            "types_met": "+".join(r["types_met"]) or "none",
            "types_missed": "+".join(r["types_missed"]) or "none",
        }
        for t in active:
            n = r["nearest"].get(t)
            key = t.lower().replace(" ", "_")
            row[f"{key}_threshold_km"] = radii[t]
            row[f"{key}_status"] = "met" if t in r["types_met"] else "missed"
            row[f"{key}_nearest_hospital"] = n["name"] if n else ""
            row[f"{key}_road_km"] = n["road_km"] if n else ""
            row[f"{key}_drive_min"] = n.get("drive_min") if n else ""
        rows.append(row)
    return rows


def locate_grid(grid_id: str, year: str = "2025") -> dict | None:
    """Cheap grid lookup for the search box: coordinates and district only.

    Deliberately separate from the /api/analytics/grid/<id> detail route, which
    runs a live OSRM join over every hospital within 60 km. The search box needs
    to answer "does this exist and where is it" in milliseconds; it must not pay
    for a routing pass the user did not ask for.
    """
    payload = load_proximity(year)
    want = str(grid_id).strip()
    if not want:
        return None
    for g in payload["grids"]:
        if str(g["grid_id"]) == want:
            return {
                "grid_id": g["grid_id"],
                "lat": g["lat"],
                "lon": g["lon"],
                "district": g["district"],
                "severity_score": g.get("severity_score"),
                "n_candidates": len(g.get("candidates") or []),
            }
    return None


def district_bounds(year: str = "2025") -> dict:
    """Bounding box of the grid cells in each district, for zoom-to-district.

    Computed from the grid feed rather than district polygons because the map
    only ever renders grids — framing on the polygon would leave dead margin
    wherever a district has no accident cells near its border.
    """
    payload = load_proximity(year)
    acc: dict[str, list[float]] = {}
    for g in payload["grids"]:
        d = g["district"]
        if not d:
            continue
        b = acc.get(d)
        if b is None:
            acc[d] = [g["lat"], g["lat"], g["lon"], g["lon"], 1]
        else:
            b[0] = min(b[0], g["lat"])
            b[1] = max(b[1], g["lat"])
            b[2] = min(b[2], g["lon"])
            b[3] = max(b[3], g["lon"])
            b[4] += 1
    return {
        d: {
            "south": round(b[0], 6),
            "north": round(b[1], 6),
            "west": round(b[2], 6),
            "east": round(b[3], 6),
            "grid_count": int(b[4]),
        }
        for d, b in sorted(acc.items())
    }


def district_tss(year: str = "2025") -> dict:
    """TSS — Total Severity Score — per district.

    TSS is not a new measurement: it is the `severity_score` the RBG grid feed
    already attaches to every 1 km cell, summed over the cells in a district.
    The same figure drives the "% of accident severity" stats on the gap and
    ambulance tabs; this exposes it under the name the brief uses.

    TSS-per-cell is reported alongside the total because the two rank districts
    differently. Gurugram tops the state on total TSS partly by having 500
    cells; Panchkula has 112 cells but a high severity per cell. Presenting the
    total alone would conflate "large" with "dangerous".
    """
    grids, _ = load_grids(year)
    agg: dict[str, dict] = {}
    for g in grids:
        d = agg.setdefault(
            g["district"], {"district": g["district"], "tss": 0.0, "grid_cells": 0}
        )
        d["tss"] += g["severity_score"] or 0.0
        d["grid_cells"] += 1

    total = sum(d["tss"] for d in agg.values()) or 1.0
    rows = sorted(agg.values(), key=lambda d: -d["tss"])
    for i, d in enumerate(rows, 1):
        d["rank"] = i
        d["tss"] = round(d["tss"], 2)
        d["tss_per_cell"] = round(d["tss"] / d["grid_cells"], 2) if d["grid_cells"] else 0.0
        d["share_pct"] = round(100.0 * d["tss"] / total, 2)

    return {
        "year": year,
        "state_tss": round(total, 2),
        "total_grids": len(grids),
        "districts": rows,
    }


def _grid_tier_distances(year: str, district: str | None):
    """Yield (grid, nearest-public-facility-per-tier) for each grid."""
    import districts as _d

    payload = load_proximity(year)
    hospitals = payload["hospitals"]
    want = _d.normalize(district) if district else None

    for g in payload["grids"]:
        if want and _d.normalize(g["district"]) != want:
            continue
        nearest: dict[str, dict | None] = {t: None for t in TIER_ORDER}
        for c in g["candidates"]:
            h = hospitals.get(c["s_no"])
            if not h:
                continue
            tier = PUBLIC_TIER_BY_TYPE.get(h["hosp_type"])
            if not tier:
                continue  # private, or an unclassified type
            cur = nearest[tier]
            if cur is None or c["road_km"] < cur["road_km"]:
                nearest[tier] = {
                    "s_no": c["s_no"],
                    "name": h["hospital_name"],
                    "type": h["hosp_type"],
                    "district": h["district_name"],
                    "lat": h["lat"],
                    "lon": h["lon"],
                    "tpl": h.get("tpl"),
                    "tpl_source": h.get("tpl_source"),
                    "road_km": c["road_km"],
                    "drive_min": c.get("drive_min"),
                }
        yield g, nearest


def _grid_record(g: dict, nearest: dict) -> dict:
    return {
        "grid_id": g["grid_id"],
        "lat": g["lat"],
        "lon": g["lon"],
        "district": g["district"],
        "severity_score": g["severity_score"],
        "nearest": nearest,
        "closest_any_km": min(
            (n["road_km"] for n in nearest.values() if n), default=None
        ),
    }


def _normalize_thresholds(thresholds) -> dict[str, float]:
    if thresholds is None:
        return {t: STRICT_GAP_DEFAULT_KM for t in TIER_ORDER}
    if isinstance(thresholds, (int, float)):
        return {t: float(thresholds) for t in TIER_ORDER}
    return {t: float(thresholds.get(t, STRICT_GAP_DEFAULT_KM)) for t in TIER_ORDER}


def strict_tier_gaps(
    year: str = "2025",
    thresholds=None,
    district: str | None = None,
) -> dict:
    """Grids failing ALL THREE tiers at once (modes A and B).

    `thresholds` is either a single number — mode A, the same limit for every
    tier — or a per-tier dict, e.g. {"Tertiary": 20, "Secondary": 30,
    "Primary": 40} for mode B. Mode A is simply mode B with all three equal, so
    one code path serves both.

    A grid qualifies only when tertiary AND secondary AND primary are all out of
    range. Missing one tier is not enough. Public facilities only.
    """
    th = _normalize_thresholds(thresholds)
    gaps: list[dict] = []
    total = 0
    per_tier_missing = {t: 0 for t in TIER_ORDER}
    sev_gap = sev_total = 0.0

    for g, nearest in _grid_tier_distances(year, district):
        total += 1
        sev_total += g["severity_score"]
        missing = [
            t
            for t in TIER_ORDER
            if nearest[t] is None or nearest[t]["road_km"] > th[t]
        ]
        for t in missing:
            per_tier_missing[t] += 1
        if len(missing) < len(TIER_ORDER):
            continue
        sev_gap += g["severity_score"]
        gaps.append(_grid_record(g, nearest))

    gaps.sort(key=lambda x: -(x["closest_any_km"] or 0))
    by_district: dict[str, int] = defaultdict(int)
    for x in gaps:
        by_district[x["district"]] += 1

    return {
        "year": year,
        "mode": "strict",
        "thresholds": th,
        "uniform": len(set(th.values())) == 1,
        "threshold_km": next(iter(th.values())) if len(set(th.values())) == 1 else None,
        "scope": "public_only",
        "district": district,
        "total_grids": total,
        "gap_count": len(gaps),
        "gap_pct": round(100.0 * len(gaps) / total, 3) if total else 0.0,
        "severity_in_gaps": round(sev_gap, 1),
        "severity_pct": round(100.0 * sev_gap / sev_total, 2) if sev_total else 0.0,
        # Context: how many grids miss each tier individually. Explains WHY the
        # strict count is what it is — at 60 km only Tertiary has any misses.
        "missing_by_tier": per_tier_missing,
        "by_district": sorted(
            ({"district": k, "gaps": v} for k, v in by_district.items()),
            key=lambda x: x["gaps"],
            reverse=True,
        ),
        "grids": gaps,
    }


def independent_tier_gaps(
    year: str = "2025",
    thresholds=None,
    district: str | None = None,
) -> dict:
    """Mode C: each tier judged on its own, with its own limit.

    Returns three independent result sets. A grid can appear in all three, one,
    or none — unlike the strict rule, the tiers do not interact. Each set gets
    its own export.
    """
    th = _normalize_thresholds(thresholds)
    per_tier: dict[str, list[dict]] = {t: [] for t in TIER_ORDER}
    sev: dict[str, float] = {t: 0.0 for t in TIER_ORDER}
    total = 0
    sev_total = 0.0

    for g, nearest in _grid_tier_distances(year, district):
        total += 1
        sev_total += g["severity_score"]
        rec = None
        for t in TIER_ORDER:
            n = nearest[t]
            if n is None or n["road_km"] > th[t]:
                rec = rec or _grid_record(g, nearest)
                per_tier[t].append(rec)
                sev[t] += g["severity_score"]

    out_tiers = {}
    for t in TIER_ORDER:
        rows = sorted(
            per_tier[t],
            key=lambda x, _t=t: -((x["nearest"][_t] or {}).get("road_km") or 1e9),
        )
        by_d: dict[str, int] = defaultdict(int)
        for x in rows:
            by_d[x["district"]] += 1
        out_tiers[t] = {
            "threshold_km": th[t],
            "gap_count": len(rows),
            "gap_pct": round(100.0 * len(rows) / total, 3) if total else 0.0,
            "severity_pct": round(100.0 * sev[t] / sev_total, 2) if sev_total else 0.0,
            "by_district": sorted(
                ({"district": k, "gaps": v} for k, v in by_d.items()),
                key=lambda x: x["gaps"],
                reverse=True,
            ),
            "grids": rows,
        }

    return {
        "year": year,
        "mode": "independent",
        "thresholds": th,
        "scope": "public_only",
        "district": district,
        "total_grids": total,
        "tiers": out_tiers,
    }


def _gap_row(g: dict, th: dict[str, float], focus: str | None = None) -> dict:
    """One CSV row: the grid plus the nearest facility of every tier."""
    row = {
        "grid_id": g["grid_id"],
        "grid_latitude": g["lat"],
        "grid_longitude": g["lon"],
        "grid_district": g["district"],
        "grid_severity_score": g["severity_score"],
        "closest_public_hospital_km": g["closest_any_km"],
    }
    if focus:
        # Mode C: lead with the tier this file is about.
        n = g["nearest"].get(focus)
        row["missing_tier"] = focus
        row["missing_tier_threshold_km"] = th[focus]
        row["missing_tier_road_km"] = n["road_km"] if n else None
    for t in TIER_ORDER:
        n = g["nearest"].get(t)
        k = t.lower()
        row[f"{k}_threshold_km"] = th[t]
        row[f"{k}_hospital_id"] = n["s_no"] if n else None
        row[f"{k}_hospital_name"] = n["name"] if n else None
        row[f"{k}_hospital_type"] = n["type"] if n else None
        row[f"{k}_hospital_latitude"] = n["lat"] if n else None
        row[f"{k}_hospital_longitude"] = n["lon"] if n else None
        row[f"{k}_tpl_score"] = n["tpl"] if n else None
        row[f"{k}_tpl_source"] = n["tpl_source"] if n else None
        row[f"{k}_road_km"] = n["road_km"] if n else None
    return row


def strict_gap_rows(
    year: str = "2025",
    thresholds=None,
    district: str | None = None,
) -> list[dict]:
    """Modes A and B: the grids failing all three tiers, one CSV."""
    payload = strict_tier_gaps(year, thresholds, district)
    th = payload["thresholds"]
    return [_gap_row(g, th) for g in payload["grids"]]


def independent_gap_rows(
    year: str = "2025",
    thresholds=None,
    district: str | None = None,
    tier: str = "Tertiary",
) -> list[dict]:
    """Mode C: the grids failing ONE named tier, one CSV per tier."""
    payload = independent_tier_gaps(year, thresholds, district)
    th = payload["thresholds"]
    block = payload["tiers"].get(tier)
    if not block:
        return []
    return [_gap_row(g, th, focus=tier) for g in block["grids"]]


def build_hospital_grid_bundle(
    zip_path: str,
    year: str = "2025",
    split_by: str = "district",
    top_per_hospital: int | None = None,
    district: str | None = None,
    types: set[str] | None = None,
    per_level: bool = True,
    include_ep: bool = True,
) -> dict:
    """Write a ZIP of hospital->grid CSVs, split so each opens on a laptop.

    The complete join is 958,704 rows / 139 MB — inside Excel's 1,048,576-row
    limit but slow and unpleasant to scroll. Splitting by the HOSPITAL's
    district gives 22 files, the largest ~83k rows, each opening in seconds.

    A hospital is never split across files: grouping is by the hospital's own
    district, so every hospital appears once with all of its grids. Note that
    means files are NOT geographic slices — a border hospital's grids can sit in
    a neighbouring district (see grid_district).

    Written to a temp file rather than memory: the CSVs total ~145 MB
    uncompressed, which is not something to buffer per request.
    """
    import csv as _csv
    import io as _io
    import zipfile

    import districts as _d

    payload = load_hospital_grid(year)
    hospitals = payload["hospitals"]
    index = payload["grid_index"]
    hg = payload["hospital_grids"]

    tpl_extra: dict[str, dict] = {}
    tpl_csv = os.path.join(DATA_DIR, "hospital_tpl.csv")
    if os.path.exists(tpl_csv):
        with open(tpl_csv, encoding="utf-8-sig") as f:
            for row in _csv.DictReader(f):
                tpl_extra[row["s_no"]] = row

    # This list is the DictWriter's fieldnames, so it must stay in step with
    # what the row builder below emits — a key present in the row and absent
    # here raises and takes the whole bundle down with a 500, which is how
    # `hospital_level_labelled` broke this export the day it was added.
    fields = [
        "hospital_id", "hospital_name", "hospital_type", "hospital_tier",
        "hospital_level", "hospital_level_labelled",
        "hospital_district", "hospital_latitude",
        "hospital_longitude", "tpl_score", "tpl_source", "tpl_source_hospid",
        "coord_status", "coord_note",
        "hospital_total_grids_in_60km", "grid_rank", "grid_id", "grid_latitude",
        "grid_longitude", "grid_district", "grid_severity_score",
        "road_km_from_hospital",
    ]

    def sort_key(s: str):
        return (0, int(s)) if str(s).isdigit() else (1, str(s))

    want = _d.normalize(district) if district else None
    groups: dict[str, list[str]] = {}
    for s_no in sorted(hg.keys(), key=sort_key):
        h = hospitals.get(s_no)
        if not h:
            continue
        if types is not None and h["hosp_type"] not in types:
            continue
        if not include_ep and h["hosp_type"] == PRIVATE_TYPE:
            continue
        hd = _d.normalize(h["district_name"])
        if want and hd != want:
            continue
        if split_by == "type":
            key = h["hosp_type"] or "UNKNOWN"
        elif split_by == "none":
            key = "ALL"
        else:
            key = hd or "UNKNOWN"
        groups.setdefault(key, []).append(s_no)

    manifest: list[dict] = []
    summary: list[dict] = []

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for n, (key, snos) in enumerate(sorted(groups.items()), start=1):
            safe = "".join(c if c.isalnum() else "_" for c in key)
            fname = f"{n:02d}_{safe}.csv" if split_by != "none" else "hospital_grid_coverage.csv"
            buf = _io.StringIO()
            w = _csv.DictWriter(buf, fieldnames=fields)
            w.writeheader()
            rows = 0
            for s_no in snos:
                h = hospitals[s_no]
                e = tpl_extra.get(str(s_no), {})
                pairs = clip_to_level(hg[s_no], h, per_level)
                if top_per_hospital:
                    pairs = pairs[:top_per_hospital]
                base = {
                    "hospital_id": s_no,
                    "hospital_name": h["hospital_name"],
                    "hospital_type": h["hosp_type"],
                    "hospital_tier": h["tier"],
                    # Verdict level, matching iter_hospital_grid_rows above, so
                    # the two hospital->grid exports agree on what an
                    # empanelled private hospital's level is.
                    "hospital_level": counts_at_level(h),
                    "hospital_level_labelled": e.get("hosp_level", ""),
                    "hospital_district": _d.normalize(h["district_name"]),
                    "hospital_latitude": h["lat"],
                    "hospital_longitude": h["lon"],
                    "tpl_score": h.get("tpl"),
                    "tpl_source": h.get("tpl_source"),
                    "tpl_source_hospid": e.get("dump_hospid", ""),
                    "coord_status": h.get("coord_status", "ok"),
                    "coord_note": h.get("coord_note", ""),
                    "hospital_total_grids_in_60km": len(pairs),
                }
                summary.append(
                    {
                        "hospital_id": s_no,
                        "hospital_name": h["hospital_name"],
                        "hospital_type": h["hosp_type"],
                        "hospital_tier": h["tier"],
                        "hospital_district": base["hospital_district"],
                        "tpl_score": h.get("tpl"),
                        "tpl_source": h.get("tpl_source"),
                        "grids_within_60km": len(pairs),
                        "nearest_grid_km": pairs[0][1] if pairs else "",
                        "farthest_grid_km": pairs[-1][1] if pairs else "",
                        "file": fname,
                    }
                )
                for rank, (gi, km) in enumerate(pairs, start=1):
                    g = index[gi]
                    row = dict(base)
                    row.update(
                        {
                            "grid_rank": rank,
                            "grid_id": g["grid_id"],
                            "grid_latitude": g["lat"],
                            "grid_longitude": g["lon"],
                            "grid_district": g["district"],
                            "grid_severity_score": g["severity_score"],
                            "road_km_from_hospital": km,
                        }
                    )
                    w.writerow(row)
                    rows += 1
            z.writestr(fname, buf.getvalue())
            manifest.append(
                {"file": fname, "group": key, "hospitals": len(snos), "rows": rows}
            )

        def _csv_str(records: list[dict]) -> str:
            b = _io.StringIO()
            ww = _csv.DictWriter(b, fieldnames=list(records[0].keys()))
            ww.writeheader()
            ww.writerows(records)
            return b.getvalue()

        if manifest:
            z.writestr("00_INDEX.csv", _csv_str(manifest))
        if summary:
            z.writestr("00_ALL_HOSPITALS_SUMMARY.csv", _csv_str(summary))
        z.writestr("00_README.txt", _bundle_readme(payload, manifest, split_by, top_per_hospital))

    return {
        "files": len(manifest) + 3,
        "rows": sum(m["rows"] for m in manifest),
        "hospitals": len(summary),
        "manifest": manifest,
    }


def _bundle_readme(payload: dict, manifest: list[dict], split_by: str, top: int | None) -> str:
    largest = max(manifest, key=lambda m: m["rows"]) if manifest else {"file": "-", "rows": 0}
    return f"""HOSPITAL -> GRID COVERAGE, HARYANA {payload.get('year')}
Every accident grid within {payload.get('radius_km')} km BY ROAD of each hospital.

WHY MULTIPLE FILES
The complete join is {sum(m['rows'] for m in manifest):,} rows. Split by
{'the hospital district' if split_by == 'district' else split_by}: {len(manifest)} files,
largest {largest['file']} at {largest['rows']:,} rows. Each opens in seconds.
A hospital is NEVER split - it appears in exactly one file with all its grids.
{'' if not top else f'Capped at the nearest {top} grids per hospital.'}

START HERE
  00_ALL_HOSPITALS_SUMMARY.csv  one row per hospital with its grid count and
                                which file to open
  00_INDEX.csv                  one row per file: group, hospitals, rows

ORDERING
  Ascending hospital_id. Within each hospital, grids run nearest-first by road
  distance; grid_rank restarts at 1 for every hospital.

NOTE grid_district may differ from hospital_district - a border hospital serves
grids across the line. Files group by the HOSPITAL's district, so they are not
geographic slices.

METHOD
  Real road routes from a self-hosted OSRM server built on an OpenStreetMap
  extract - not straight-line. Road distance averages about 1.4x straight-line
  here and exceeds 10x where canals, railways or motorway medians force a detour.
  distance_model = {payload.get('distance_model')}

IMPORTANT - TPL PROVENANCE
  tpl_source = "real"       from the supplied TPL dump
  tpl_source = "estimated"  generated from the real per-hospital-type
                            distribution because the dump did not cover them
  Never present an estimated score as measured. tpl_source_hospid is the
  original hospid from the dump; that ID system does NOT match ours, so the
  join was done on GPS coordinates.
"""


def uncovered_grids(year: str = "2025") -> dict:
    """Grids with NO hospital within the radius — the requirement's second ask."""
    payload = load_hospital_grid(year)
    index = payload["grid_index"]
    rows = [
        {
            "grid_id": index[i]["grid_id"],
            "latitude": index[i]["lat"],
            "longitude": index[i]["lon"],
            "district": index[i]["district"],
            "severity_score": index[i]["severity_score"],
        }
        for i in payload["uncovered_grid_indexes"]
    ]
    return {
        "year": year,
        "radius_km": payload["radius_km"],
        "total_grids": len(index),
        "uncovered": len(rows),
        "uncovered_pct": round(100.0 * len(rows) / len(index), 3) if index else 0.0,
        "grids": rows,
    }


def grid_hospital_rows(
    year: str = "2025",
    district: str | None = None,
    top_n: int = EXPORT_TOP_N,
    include_private: bool = True,
    types: set[str] | None = None,
) -> list[dict]:
    """Flat rows for the CSV export: one row per (grid, hospital) pair.

    Capped at `top_n` hospitals per grid — the uncapped 60 km join is
    1,488,851 rows (~250 MB), which no spreadsheet will open.
    """
    payload = load_proximity(year)
    hospitals = payload["hospitals"]
    want = district.strip().upper() if district else None

    rows = []
    for g in payload["grids"]:
        if want and g["district"].upper() != want:
            continue
        cands = _candidate_filter(g["candidates"], hospitals, types, include_private)
        for rank, c in enumerate(cands[:top_n], start=1):
            h = hospitals[c["s_no"]]
            rows.append(
                {
                    "grid_id": g["grid_id"],
                    "grid_latitude": round(g["lat"], 6),
                    "grid_longitude": round(g["lon"], 6),
                    "grid_district": g["district"],
                    "grid_severity_score": g["severity_score"],
                    "rank": rank,
                    "hospital_id": c["s_no"],
                    "hospital_name": h["hospital_name"],
                    "hospital_type": h["hosp_type"],
                    "hospital_tier": h["tier"],
                    "hospital_district": h["district_name"],
                    "hospital_latitude": round(h["lat"], 6),
                    "hospital_longitude": round(h["lon"], 6),
                    "tpl_score": h.get("tpl"),
                    "tpl_source": h.get("tpl_source"),
                    "road_km": c["road_km"],
                    "drive_min": c.get("drive_min"),
                }
            )
    return rows


# --------------------------------------------------------------------------
# Deliverable 2 — coverage gaps + underserved corridors
# --------------------------------------------------------------------------
def evaluate_coverage(
    year: str = "2025",
    mode: str = "time",
    thresholds: dict[str, float] | None = None,
    include_private: bool = False,
    district: str | None = None,
) -> dict:
    """Per-grid reachability for each service tier.

    mode: "time" -> thresholds in minutes, "distance" -> thresholds in km.
    """
    payload = load_proximity(year)
    hospitals = payload["hospitals"]
    metric = "drive_min" if mode == "time" else "road_km"
    limits = thresholds or (DEFAULT_MIN if mode == "time" else DEFAULT_KM)
    want = district.strip().upper() if district else None

    # tier -> set of hosp_types contributing to it, honouring the private toggle
    tier_types: dict[str, set[str]] = defaultdict(set)
    for h in hospitals.values():
        if not include_private and h["is_private"]:
            continue
        tier_types[h["tier"]].add(h["hosp_type"])

    results = []
    stats = {t: {"covered": 0, "gap": 0, "sev_covered": 0.0, "sev_gap": 0.0} for t in TIER_ORDER}

    for g in payload["grids"]:
        if want and g["district"].upper() != want:
            continue

        nearest: dict[str, dict | None] = {}
        status: dict[str, str] = {}
        for tier in TIER_ORDER:
            best, best_v = None, None
            for c in g["candidates"]:
                h = hospitals.get(c["s_no"])
                if h is None or h["tier"] != tier:
                    continue
                if not include_private and h["is_private"]:
                    continue
                v = c.get(metric)
                if v is None:
                    continue
                if best_v is None or v < best_v:
                    best, best_v = c, v
            nearest[tier] = (
                None
                if best is None
                else {
                    "s_no": best["s_no"],
                    "name": hospitals[best["s_no"]]["hospital_name"],
                    "type": hospitals[best["s_no"]]["hosp_type"],
                    "tpl": hospitals[best["s_no"]].get("tpl"),
                    "road_km": best["road_km"],
                    "drive_min": best.get("drive_min"),
                }
            )
            reachable = best_v is not None and best_v <= limits.get(tier, 1e9)
            status[tier] = "covered" if reachable else "gap"
            stats[tier]["covered" if reachable else "gap"] += 1
            stats[tier]["sev_covered" if reachable else "sev_gap"] += g["severity_score"]

        # How many tiers this cell is missing. A cell short of BOTH tertiary and
        # secondary care is materially worse off than one missing tertiary
        # alone, and colouring by "highest tier missing" alone hides that.
        gap_count = sum(1 for v in status.values() if v == "gap")
        results.append(
            {
                "grid_id": g["grid_id"],
                "lat": g["lat"],
                "lon": g["lon"],
                "district": g["district"],
                "severity_score": g["severity_score"],
                "status": status,
                "nearest": nearest,
                "gap_count": gap_count,
                "missing": [t for t in TIER_ORDER if status[t] == "gap"],
                # A grid is "fully underserved" when no tier reaches it.
                "all_gap": gap_count == len(TIER_ORDER),
            }
        )

    total = len(results) or 1
    for tier, s in stats.items():
        s["total"] = len(results)
        s["gap_pct"] = round(100.0 * s["gap"] / total, 2)
        sev_total = s["sev_covered"] + s["sev_gap"]
        s["sev_gap_pct"] = round(100.0 * s["sev_gap"] / sev_total, 2) if sev_total else 0.0
        s["sev_covered"] = round(s["sev_covered"], 1)
        s["sev_gap"] = round(s["sev_gap"], 1)

    # Distribution of how many tiers each cell is missing — 0 through 3.
    overlap = {n: 0 for n in range(len(TIER_ORDER) + 1)}
    for r in results:
        overlap[r["gap_count"]] += 1

    return {
        "year": year,
        "mode": mode,
        "unit": "min" if mode == "time" else "km",
        "thresholds": limits,
        "include_private": include_private,
        "district": district,
        "grids": results,
        "stats": stats,
        "overlap": {
            "none": overlap[0],
            "one_tier": overlap[1],
            "two_tiers": overlap[2],
            "all_tiers": overlap[3],
            "multi": overlap[2] + overlap[3],
        },
    }


# --- underserved corridors ------------------------------------------------
# Grid cells are ~1 km squares, so two cells whose centroids are within
# CORRIDOR_LINK_KM are neighbours. A "corridor" is a connected chain of gap
# cells — a stretch of road/territory that is underserved along its length,
# rather than one isolated cell. Ranked by accumulated accident severity.
CORRIDOR_LINK_KM = 1.6
CORRIDOR_MIN_CELLS = 4


def find_corridors(
    grids: list[dict],
    tier: str = "Tertiary",
    min_cells: int = CORRIDOR_MIN_CELLS,
) -> list[dict]:
    """Cluster contiguous gap cells for `tier` into underserved corridors."""
    gap = [g for g in grids if g["status"].get(tier) == "gap"]
    if not gap:
        return []

    # Spatial hash so we only compare nearby cells (O(n) not O(n^2)).
    cell = CORRIDOR_LINK_KM / 111.0
    buckets: dict[tuple[int, int], list[int]] = defaultdict(list)
    for i, g in enumerate(gap):
        buckets[(int(g["lat"] / cell), int(g["lon"] / cell))].append(i)

    parent = list(range(len(gap)))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for (bx, by), idxs in buckets.items():
        neigh = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                neigh.extend(buckets.get((bx + dx, by + dy), []))
        for i in idxs:
            for j in neigh:
                if i < j and haversine_km(
                    gap[i]["lat"], gap[i]["lon"], gap[j]["lat"], gap[j]["lon"]
                ) <= CORRIDOR_LINK_KM:
                    union(i, j)

    clusters: dict[int, list[int]] = defaultdict(list)
    for i in range(len(gap)):
        clusters[find(i)].append(i)

    corridors = []
    for members in clusters.values():
        if len(members) < min_cells:
            continue
        cells = [gap[i] for i in members]
        sev = sum(c["severity_score"] for c in cells)
        lats = [c["lat"] for c in cells]
        lons = [c["lon"] for c in cells]
        # Extent of the chain — a long thin cluster is a genuine corridor,
        # a blob is an underserved area. Both are useful; the ratio tells them apart.
        span_km = haversine_km(min(lats), min(lons), max(lats), max(lons))
        districts = sorted({c["district"] for c in cells})

        # A cell with NO facility of this tier anywhere within the 60 km search
        # radius is the WORST case, not the best. Scoring it `or 0` ranked it
        # last and let a corridor full of completely unreachable cells report a
        # small, reassuring worst_km. Rank unreachable as infinite instead.
        def _reach_km(c: dict) -> float:
            n = c["nearest"].get(tier)
            if not n or n.get("road_km") is None:
                return float("inf")
            return n["road_km"]

        worst = max(cells, key=_reach_km)
        worst_km = _reach_km(worst)
        unreachable = sum(1 for c in cells if _reach_km(c) == float("inf"))
        corridors.append(
            {
                "cells": len(cells),
                "severity_total": round(sev, 1),
                "span_km": round(span_km, 1),
                "districts": districts,
                "centroid_lat": round(sum(lats) / len(lats), 6),
                "centroid_lon": round(sum(lons) / len(lons), 6),
                # None means "no facility of this tier within the search radius"
                "worst_km": None if worst_km == float("inf") else worst_km,
                "unreachable_cells": unreachable,
                "grid_ids": [c["grid_id"] for c in cells],
            }
        )

    corridors.sort(key=lambda c: c["severity_total"], reverse=True)
    for rank, c in enumerate(corridors, start=1):
        c["rank"] = rank
    return corridors


def grid_hospitals_live(
    grid: dict, hospitals: list[dict], radius_km: float = PROXIMITY_KM
) -> list[dict] | None:
    """EVERY hospital within `radius_km` of one grid, by live OSRM lookup.

    The cache deliberately keeps only KEEP_PER_TYPE per type (~46 rows/grid);
    the true 60 km count is ~229. Storing all of them for all 6,785 grids would
    be 1.49 M rows / ~250 MB, so for the "show me this cell's full list"
    interaction we route one grid on demand instead — a single /table call.

    Returns None if OSRM is unreachable, so the caller can fall back to cache.
    """
    import json as _json
    import urllib.request

    osrm = os.environ.get("OSRM_BASE", "http://127.0.0.1:5000").rstrip("/")
    near = [
        h
        for h in hospitals
        if haversine_km(grid["lat"], grid["lon"], h["latitude"], h["longitude"]) <= radius_km
    ]
    if not near:
        return []

    out: list[dict] = []
    # Chunked so this still works if --max-table-size was never raised.
    chunk = 90
    for start in range(0, len(near), chunk):
        batch = near[start : start + chunk]
        coords = ";".join(
            [f"{grid['lon']:.6f},{grid['lat']:.6f}"]
            + [f"{h['longitude']:.6f},{h['latitude']:.6f}" for h in batch]
        )
        url = (
            f"{osrm}/table/v1/driving/{coords}"
            f"?sources=0&annotations=distance,duration"
        )
        try:
            with urllib.request.urlopen(url, timeout=8) as resp:
                data = _json.loads(resp.read())
        except Exception:  # noqa: BLE001 — caller falls back to the cache
            return None
        if data.get("code") != "Ok":
            return None
        dists = (data.get("distances") or [[]])[0][1:]
        durs = (data.get("durations") or [[]])[0][1:]
        for i, h in enumerate(batch):
            d_m = dists[i] if i < len(dists) else None
            if d_m is None:
                continue
            km = d_m / 1000.0
            if km > radius_km:
                continue
            secs = durs[i] if i < len(durs) else None
            out.append(
                {
                    "hospital_id": h["s_no"],
                    "hospital_name": h["hospital_name"],
                    "hosp_type": h["hosp_type"],
                    "tier": h["tier"],
                    "hosp_level": counts_at_level(h),
                    "hosp_level_labelled": (h.get("hosp_level") or "").upper(),
                    "district": h["district_name"],
                    "latitude": round(h["latitude"], 6),
                    "longitude": round(h["longitude"], 6),
                    "tpl": h.get("tpl_total"),
                    "tpl_source": h.get("tpl_source"),
                    "road_km": round(km, 2),
                    "drive_min": round(secs / 60.0, 1) if secs is not None else None,
                }
            )
    out.sort(key=lambda r: r["road_km"])
    return out


def summarise_by_district(coverage: dict) -> list[dict]:
    """Per-district gap counts — feeds the sortable table in the UI."""
    per: dict[str, dict[str, Any]] = {}
    for g in coverage["grids"]:
        d = per.setdefault(
            g["district"],
            {
                "district": g["district"],
                "grids": 0,
                "severity_total": 0.0,
                **{f"gap_{t.lower()}": 0 for t in TIER_ORDER},
            },
        )
        d["grids"] += 1
        d["severity_total"] += g["severity_score"]
        for t in TIER_ORDER:
            if g["status"][t] == "gap":
                d[f"gap_{t.lower()}"] += 1

    rows = list(per.values())
    for r in rows:
        r["severity_total"] = round(r["severity_total"], 1)
        for t in TIER_ORDER:
            k = f"gap_{t.lower()}"
            r[f"{k}_pct"] = round(100.0 * r[k] / r["grids"], 1) if r["grids"] else 0.0
    rows.sort(key=lambda r: r["gap_tertiary"], reverse=True)
    return rows


# ==========================================================================
# Radius sensitivity — how the gap count moves as each level's radius changes
# ==========================================================================
def level_sensitivity(
    year: str = "2025",
    district: str | None = None,
    max_km: float = 80.0,
    step_km: float = 2.0,
) -> dict:
    """For each level, the number of grids with no facility of that level within r km.

    Answers the question the single-threshold view cannot: *which* radius is
    actually binding. The curves are what make the spec radii legible — L3 at
    10 km sits on a steep part of its curve (small changes move hundreds of
    grids), while L1 at 60 km sits on a flat tail, so the L1 verdict is
    insensitive to the exact radius and the L3 verdict is not.

    Cheap: one pass to collect each grid's nearest distance per level, then a
    sorted-array count per radius. No re-routing.
    """
    import bisect

    per_level: dict[str, list[float]] = {lv: [] for lv in ALL_LEVEL_ORDER}
    total = 0
    for g, nearest in _grid_level_distances(year, district):
        total += 1
        for lv in ALL_LEVEL_ORDER:
            n = nearest[lv]
            # No facility of that level anywhere => never in reach at any radius.
            # L1's curve is now flat at `total` for every radius, because L1 has
            # no members at all. That flat line IS the finding.
            per_level[lv].append(n["road_km"] if n else float("inf"))

    for lv in ALL_LEVEL_ORDER:
        per_level[lv].sort()

    radii: list[float] = []
    r = step_km
    while r <= max_km + 1e-9:
        radii.append(round(r, 2))
        r += step_km

    series = []
    for lv in ALL_LEVEL_ORDER:
        arr = per_level[lv]
        # bisect_right gives how many are <= r, i.e. in reach; the rest are gaps.
        counts = [total - bisect.bisect_right(arr, rad) for rad in radii]
        series.append(
            {
                "level": lv,
                "label": LEVEL_LABEL[lv],
                "is_private": lv == EP_LEVEL,
                "spec_km": ALL_LEVEL_RADII[lv],
                "spec_gaps": total - bisect.bisect_right(arr, ALL_LEVEL_RADII[lv]),
                "never_reachable": sum(1 for v in arr if v == float("inf")),
                "median_km": arr[len(arr) // 2] if arr and arr[len(arr) // 2] != float("inf") else None,
                "points": [[rad, c] for rad, c in zip(radii, counts)],
            }
        )

    return {
        "year": year,
        "district": district,
        "total_grids": total,
        "max_km": max_km,
        "step_km": step_km,
        "scope": "public_levels_only_plus_separate_ep",  # empanelled private is EP, not L1
        "l1_is_mocked": False,  # removed 20 Aug 2026 — see PUBLIC_LEVEL_TYPES
        "series": series,
    }


# ==========================================================================
# Proximity tab — the three modes (Overall / Grid / Hospital)
# ==========================================================================
# The Proximity tab asks the same question three ways, and all three run off
# the SAME per-level verdict so they can never disagree on screen:
#
#   Mode 1 "Overall"   every grid coloured by HOW MANY of L1/L2/L3 it reaches
#   Mode 2 "Grid"      same colours; clicking a grid draws its three road
#                      routes, each green or red on its own level's rule
#   Mode 3 "Hospital"  one level at a time; grids are green or red on that
#                      level alone, and clicking a hospital draws its
#                      catchment
#
# The four-colour ramp is the partner's own palette (THEIR_COLORS in
# network_analytics.js), so a grid keeps the same meaning-to-colour mapping
# the rest of the product already uses.
LEVELS_MET_COLOR = {3: "lightyellow", 2: "yellow", 1: "orange", 0: "red"}
LEVELS_MET_LABEL = {
    3: "All three public levels in reach",
    2: "Two of three public levels in reach",
    1: "One public level in reach",
    0: "No public level in reach",
}
# PURPLE — the fifth state, added 25 Aug 2026 with the EP split.
#
# It is an OVERRIDE, not a fifth point on the ramp, and it fires on exactly one
# condition: the grid reaches NO public level and DOES reach an empanelled
# private hospital. Red would say "nothing is in reach", which is false — there
# is care within 60 km, it is simply not the state's. Painting it lightyellow
# would be the opposite lie. Purple says the specific true thing: the only
# facility this cell can reach is private.
#
# A grid that reaches both public and private capacity keeps its ramp colour;
# the private facility is additional there, not the whole story.
PRIVATE_ONLY_COLOR = "purple"
PRIVATE_ONLY_LABEL = "Only an empanelled private hospital in reach"
# Mode 2 branch colours and mode 3 grid colours. Deliberately NOT the four
# ramp colours: a branch answers a yes/no question ("is this one level within
# its own radius"), so it gets a yes/no palette.
BRANCH_OK = "#16a34a"      # green  — within this level's spec radius
BRANCH_FAIL = "#dc2626"    # red    — beyond it
HOSPITAL_BRANCH = "#111827"  # black — mode 3, where reach is already implied

# Mode 3 draws real road geometry per branch. An L1 hospital can reach 600+
# grids inside 60 km and drawing every one of them is thousands of polylines,
# which stalls the map for no analytical gain. The popup still reports the
# FULL reachable count and distance spread; only the DRAWN branches are cut.
HOSPITAL_BRANCH_LIMIT = 25

_verdict_cache: dict[tuple, tuple[float, dict]] = {}


def _radii_key(radii: dict[str, float]) -> tuple:
    # EP included: it decides the purple override, so two calls that differ
    # only in the EP radius are genuinely different verdicts and must not
    # share a cache entry.
    return tuple(round(radii[lv], 4) for lv in ALL_LEVEL_ORDER)


def _verdict_index(year: str, radii: dict[str, float], include_ep: bool = True) -> dict:
    """grid_id -> full verdict record, for every grid in the state.

    Built once per (year, radii, include_ep) and cached, because mode 2 needs
    to answer "this one grid" on every click and re-deriving all 6,760
    verdicts each time would put a visible delay on a map interaction.

    include_ep=False is the app-wide "ignore Empanelled Private" toggle. It is
    not a display filter — a grid that would have been purple (covered only by
    a private hospital) genuinely reverts to its real public-only colour, e.g.
    red if it reaches zero public levels, because that IS the honest answer to
    "what can this grid reach" once private capacity is off the table.
    `ep_within`/`ep_km`/`private_only` are blanked and `nearest[EP_LEVEL]` is
    dropped so nothing downstream — a popup, an export — can surface EP data
    while the toggle is off.
    """
    ck = (year, _radii_key(radii), include_ep)
    stamp = (os.path.getmtime(artifact_path(year)), _tpl_mtime())
    hit = _verdict_cache.get(ck)
    if hit and hit[0] == stamp:
        return hit[1]

    index: dict[str, dict] = {}
    for g, nearest in _grid_level_distances(year, None):
        met, missed = [], []
        # EP is walked with the public three so its record gets the same
        # `within` / `spec_km` / `straight_km` treatment, but it is appended to
        # neither met nor missed — the score stays a count out of three.
        for lv in ALL_LEVEL_ORDER:
            n = nearest[lv]
            within = bool(n and n["road_km"] <= radii[lv])
            if n:
                n["within"] = within
                n["spec_km"] = radii[lv]
                # Straight-line distance ALONGSIDE the road distance, never
                # instead of it. The spec is a ROAD reach rule, so road_km is
                # what decides `within`; straight_km is reported so a reader
                # can see how much the road network costs over the crow-flight
                # line (a 10 km spec breached by a river detour reads very
                # differently from one breached by sheer distance).
                n["straight_km"] = round(
                    haversine_km(g["lat"], g["lon"], n["lat"], n["lon"]), 2
                )
            if lv != EP_LEVEL:
                (met if within else missed).append(lv)
        if include_ep:
            ep = nearest[EP_LEVEL]
            ep_within = bool(ep and ep["road_km"] <= radii[EP_LEVEL])
            private_only = ep_within and not met
            ep_km = ep["road_km"] if ep else None
        else:
            # As if EP did not exist: no private reach, no purple override, and
            # no EP branch for a popup or export to find under `nearest`.
            ep_within = False
            private_only = False
            ep_km = None
            nearest = {**nearest, EP_LEVEL: None}
        index[str(g["grid_id"])] = {
            "grid_id": g["grid_id"],
            "lat": g["lat"],
            "lon": g["lon"],
            "district": g["district"],
            "severity_score": g["severity_score"],
            "levels_met": met,
            "levels_missed": missed,
            "n_met": len(met),
            "ep_within": ep_within,
            "ep_km": ep_km,
            "private_only": private_only,
            "color": PRIVATE_ONLY_COLOR if private_only else LEVELS_MET_COLOR[len(met)],
            "verdict": PRIVATE_ONLY_LABEL if private_only else LEVELS_MET_LABEL[len(met)],
            "nearest": nearest,
        }
    _verdict_cache[ck] = (stamp, index)
    return index


def proximity_overview(
    year: str = "2025",
    district: str | None = None,
    radii=None,
    include_ep: bool = True,
) -> dict:
    """Mode 1 — every grid, coloured by how many of L1/L2/L3 it can reach.

    Also the grid layer for mode 2, which uses identical colours and only adds
    click behaviour on top.

    include_ep=False is the app-wide ignore toggle (see _verdict_index). Here
    it also drops EP out of `missed_by_level`/`all_levels`, so a client that
    simply enumerates what this response names never learns EP existed.
    """
    import districts as _d

    radii = _normalize_radii(radii)
    want = _d.normalize(district) if district else None
    index = _verdict_index(year, radii, include_ep=include_ep)
    active_levels = ALL_LEVEL_ORDER if include_ep else LEVEL_ORDER

    grids = []
    counts = {n: 0 for n in (3, 2, 1, 0)}
    missed_by_level = {lv: 0 for lv in active_levels}
    private_only = ep_in_reach = 0
    for rec in index.values():
        if want and _d.normalize(rec["district"]) != want:
            continue
        counts[rec["n_met"]] += 1
        for lv in rec["levels_missed"]:
            missed_by_level[lv] += 1
        if include_ep:
            if rec["ep_within"]:
                ep_in_reach += 1
            else:
                missed_by_level[EP_LEVEL] += 1
        private_only += bool(rec["private_only"])
        grids.append(rec)

    grids.sort(key=lambda r: (r["n_met"], -(r["severity_score"] or 0)))
    return {
        "year": year,
        "district": district,
        "mode": "overall",
        "radii": radii,
        "include_ep": include_ep,
        "total": len(grids),
        "counts": counts,
        "colors": LEVELS_MET_COLOR,
        "labels": LEVELS_MET_LABEL,
        # The purple override, reported alongside the four ramp counts rather
        # than folded into them: `private_only` grids are a SUBSET of the
        # counts[0] bucket, so adding the five numbers would double-count.
        # Always 0 when include_ep is False.
        "private_only": private_only,
        "private_only_color": PRIVATE_ONLY_COLOR,
        "private_only_label": PRIVATE_ONLY_LABEL,
        "ep_in_reach": ep_in_reach,
        "missed_by_level": missed_by_level,
        "level_labels": LEVEL_LABEL,
        "level_notes": LEVEL_NOTE,
        "level_radii": dict(ALL_LEVEL_RADII),
        "all_levels": list(active_levels),
        "scoring_levels": list(LEVEL_ORDER),
        "scope": "public levels score the grid; empanelled private is EP, counted separately",
        "routes_available": _routes_available(year),
        "grids": grids,
    }


def _routes_available(year: str) -> bool:
    try:
        import grid_routes  # noqa: PLC0415 — optional artifact, imported lazily
        return grid_routes.available(year)
    except Exception:
        return False


def _polyline_for(year: str, grid_id, s_no) -> str | None:
    try:
        import grid_routes  # noqa: PLC0415
        return grid_routes.route_for(year, grid_id, s_no)
    except Exception:
        return None


# Successful LIVE OSRM lookups only -- never a "no route" miss, so a
# transient OSRM hiccup (container still warming up, one dropped request)
# gets to succeed on the next click instead of being remembered as
# permanently unroutable for the rest of the process's life.
_live_polyline_cache: dict[str, str] = {}


def _osrm_live_polyline(glat, glon, hlat, hlon, timeout: float = 6.0) -> str | None:
    """One live OSRM road-route polyline for a pair the precompute cache does
    not have. See the module note above _polyline_for_pair for which pairs
    that actually is. None on any failure (OSRM unreachable, no route found),
    so every caller already knows to fall back to a straight line exactly as
    it did before this existed.
    """
    import json as _json
    import urllib.error
    import urllib.request

    osrm = os.environ.get("OSRM_BASE", "http://127.0.0.1:5000").rstrip("/")
    url = (
        f"{osrm}/route/v1/driving/{glon},{glat};{hlon},{hlat}"
        "?overview=simplified&geometries=polyline&alternatives=false&steps=false"
    )
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            data = _json.loads(resp.read())
    except Exception:  # noqa: BLE001 — caller falls back to a straight line
        return None
    if data.get("code") != "Ok" or not data.get("routes"):
        return None
    return data["routes"][0].get("geometry")


def _polyline_for_pair(
    year: str, grid_id, s_no, glat=None, glon=None, hlat=None, hlon=None
) -> str | None:
    """`_polyline_for`, then a live OSRM call when the cache misses and both
    endpoints' coordinates are known.

    Two whole pair families are guaranteed to miss the precompute cache by
    design, not by accident: a grid's own EP branch, and an EP-level
    facility's entire catchment list (see the module note above this
    function's block for why). A Nearby-tab pick outside the two families
    scripts/precompute_grid_routes.py actually builds is a third, looser
    case. All three used to just draw a dashed straight line forever; this
    is what makes them draw the real road instead.
    """
    poly = _polyline_for(year, grid_id, s_no)
    if poly is not None:
        return poly
    if glat is None or glon is None or hlat is None or hlon is None:
        return None
    ck = f"{year}:{grid_id}-{s_no}"
    hit = _live_polyline_cache.get(ck)
    if hit is not None:
        return hit
    poly = _osrm_live_polyline(glat, glon, hlat, hlon)
    if poly:
        _live_polyline_cache[ck] = poly
    return poly


def proximity_grid_detail(year: str, grid_id, radii=None, include_ep: bool = True) -> dict:
    """Mode 2 — one grid, its verdict, and its road-route branches.

    Every PUBLIC level always yields a branch entry, even when the nearest
    facility is beyond the radius (that branch is simply red) and even when
    there is no facility of that level in the cache at all (`hospital: null`,
    which the UI renders as "none within the 60 km cache" rather than silently
    omitting a level and making the grid look better covered than it is).

    The EP branch draws too, so a purple cell can show WHY it is purple —
    UNLESS include_ep is False, in which case the branch is dropped entirely
    rather than drawn as a fake red "none": the ignore toggle means this
    facility population is not part of the answer at all, not that it was
    checked and failed.
    """
    radii = _normalize_radii(radii)
    rec = _verdict_index(year, radii, include_ep=include_ep).get(str(grid_id))
    if rec is None:
        raise KeyError(f"grid {grid_id} not found")

    branches = []
    branch_levels = ALL_LEVEL_ORDER if include_ep else LEVEL_ORDER
    for lv in branch_levels:
        n = rec["nearest"][lv]
        poly = (
            _polyline_for_pair(
                year, rec["grid_id"], n["s_no"], rec["lat"], rec["lon"], n["lat"], n["lon"]
            )
            if n
            else None
        )
        branches.append(
            {
                "level": lv,
                "level_label": LEVEL_LABEL[lv],
                "is_private": lv == EP_LEVEL,
                "counts_toward_score": lv != EP_LEVEL,
                "spec_km": radii[lv],
                "hospital": n,
                "road_km": n["road_km"] if n else None,
                "drive_min": n.get("drive_min") if n else None,
                "ok": bool(n and n["road_km"] <= radii[lv]),
                "color": BRANCH_OK if (n and n["road_km"] <= radii[lv]) else BRANCH_FAIL,
                "polyline": poly,
                "geometry": "osrm" if poly else "straight",
            }
        )

    return {"year": year, "mode": "grid", "radii": radii, "include_ep": include_ep,
            "grid": rec, "branches": branches}


def _level_hospitals(year: str, level: str) -> dict[str, dict]:
    """Every facility that counts at ONE level, keyed by s_no."""
    payload = load_proximity(year)
    out = {}
    for s_no, h in payload["hospitals"].items():
        # counts_at_level, not the raw label — see the EP split note. Reading
        # hosp_level here would list all 614 private hospitals under L1 again.
        if counts_at_level(h) != level:
            continue
        out[s_no] = h
    return out


def proximity_level_view(
    year: str = "2025",
    level: str = "L1",
    district: str | None = None,
    radii=None,
    include_ep: bool = True,
) -> dict:
    """Mode 3 — one level in isolation: grids are green or red on that level.

    Deliberately NOT the four-colour ramp. Restricted to a single level the
    question collapses to a binary — is there an L1 within 60 km or isn't
    there — and a four-colour scale would imply a gradation that does not
    exist here.
    """
    import bisect as _b
    import districts as _d

    level = (level or "L1").strip().upper()
    if level not in ALL_LEVEL_ORDER:
        raise ValueError(f"unknown level {level!r}; expected one of {ALL_LEVEL_ORDER}")
    if level == EP_LEVEL and not include_ep:
        raise ValueError(
            "Empanelled Private is currently excluded by the include/ignore "
            "toggle — turn it on to view this level."
        )

    radii = _normalize_radii(radii)
    spec = radii[level]
    want = _d.normalize(district) if district else None
    index = _verdict_index(year, radii, include_ep=include_ep)

    grids, n_ok = [], 0
    for rec in index.values():
        if want and _d.normalize(rec["district"]) != want:
            continue
        n = rec["nearest"][level]
        ok = bool(n and n["road_km"] <= spec)
        n_ok += ok
        grids.append(
            {
                "grid_id": rec["grid_id"],
                "lat": rec["lat"],
                "lon": rec["lon"],
                "district": rec["district"],
                "severity_score": rec["severity_score"],
                "ok": ok,
                "color": BRANCH_OK if ok else BRANCH_FAIL,
                "road_km": n["road_km"] if n else None,
                "nearest": n,
            }
        )

    # Hospital list for this level, each with how many grids it actually
    # covers. Counting by bisect on the nearest-first list is O(log n) per
    # hospital instead of a full scan of its 1,000+ pairs.
    hg = load_hospital_grid(year)
    hospitals = []
    for s_no, h in _level_hospitals(year, level).items():
        if want and _d.normalize(h.get("district_name", "")) != want:
            continue
        pairs = hg["hospital_grids"].get(s_no) or []
        n_reach = _b.bisect_right([p[1] for p in pairs], spec)
        hospitals.append(
            {
                "s_no": s_no,
                "name": h["hospital_name"],
                "type": h["hosp_type"],
                "level": level,
                # NORMALISED, not the raw dump value (fixed 24 Aug 2026). The
                # filter three lines up already compares _d.normalize(...), but
                # this emitted the raw name, so mode 3 shipped a different
                # district vocabulary from every other endpoint: "Sonepat" here
                # against "SONIPAT" in /api/analytics/hospitals, plus Hissar /
                # HISAR, Mewat / NUH, Jagadhari / YAMUNANAGAR, Narnaul /
                # MAHENDRAGARH. Typing a district into the sidebar filter
                # therefore found facilities in Overall mode and none in
                # Hospital mode, for the same district.
                "district": _d.normalize(h["district_name"]),
                "lat": h["lat"],
                "lon": h["lon"],
                "tpl": h.get("tpl"),
                "tpl_source": h.get("tpl_source"),
                "reachable_grids": n_reach,
            }
        )
    hospitals.sort(key=lambda x: -x["reachable_grids"])

    return {
        "year": year,
        "mode": "hospital",
        "level": level,
        "level_label": LEVEL_LABEL[level],
        "level_note": LEVEL_NOTE.get(level, ""),
        "is_private": level == EP_LEVEL,
        "include_ep": include_ep,
        "district": district,
        "spec_km": spec,
        "radii": radii,
        "total": len(grids),
        "in_reach": n_ok,
        "out_of_reach": len(grids) - n_ok,
        "hospital_count": len(hospitals),
        "routes_available": _routes_available(year),
        "hospitals": hospitals,
        "grids": grids,
    }


def proximity_hospital_detail(
    year: str,
    s_no: str,
    level: str | None = None,
    limit: int = HOSPITAL_BRANCH_LIMIT,
    radii=None,
    include_ep: bool = True,
) -> dict:
    """Mode 3 click — one hospital's catchment, with drawn branches capped.

    `reachable_total` is the honest full count; `branches` is the drawn subset.
    Reporting both, rather than quietly drawing 25 and letting the map imply
    that is all there is, is the difference between a cap and a lie.
    """
    import statistics as _st

    radii = _normalize_radii(radii)
    prox = load_proximity(year)
    h = prox["hospitals"].get(str(s_no))
    if h is None:
        raise KeyError(f"hospital {s_no} not found")

    # counts_at_level, not hosp_level: an empanelled private hospital is
    # labelled L1 in the dump but provides EP, and defaulting to the label
    # would draw a "60 km L1 catchment" for a facility L1 no longer contains.
    lv = (level or counts_at_level(h) or "").strip().upper()
    if lv not in ALL_LEVEL_RADII:
        raise ValueError(f"hospital {s_no} has no usable level (got {lv!r})")
    if lv == EP_LEVEL and not include_ep:
        raise ValueError(
            f"{h['hospital_name']} is an empanelled private facility, and "
            f"Empanelled Private is currently excluded by the include/ignore "
            f"toggle — turn it on to view this catchment."
        )
    # Eligibility, not just a well-formed label. Without this the endpoint drew
    # a 30 km "L2 catchment" over 139 grids for SUSHIL GARG HOSPITAL — an
    # empanelled private facility the L2 analysis does not count at all, so
    # every one of those grids was simultaneously being reported as having no
    # L2 in reach. Refusing is the honest answer: the facility is real and stays
    # on the map, it just has no catchment AT THIS LEVEL to draw.
    if not eligible_at_level(h, lv):
        raise ValueError(
            f"{h['hospital_name']} is labelled {lv} but does not count as an {lv} "
            f"provider ({h['hosp_type']}), so it has no {lv} catchment. "
            f"The spec's {lv} is {LEVEL_LABEL[lv].split('—')[1].strip()}."
        )
    spec = radii[lv]

    hg = load_hospital_grid(year)
    index = hg["grid_index"]
    pairs = [p for p in (hg["hospital_grids"].get(str(s_no)) or []) if p[1] <= spec]
    pairs.sort(key=lambda p: p[1])

    branches = []
    for rank, (gi, km) in enumerate(pairs[: max(0, int(limit))], start=1):
        g = index[gi]
        poly = _polyline_for_pair(
            year, g["grid_id"], str(s_no), g["lat"], g["lon"], h["lat"], h["lon"]
        )
        branches.append(
            {
                "rank": rank,
                "grid_id": g["grid_id"],
                "lat": g["lat"],
                "lon": g["lon"],
                "district": g["district"],
                "severity_score": g["severity_score"],
                "road_km": km,
                "color": HOSPITAL_BRANCH,
                "polyline": poly,
                "geometry": "osrm" if poly else "straight",
            }
        )

    kms = [p[1] for p in pairs]
    return {
        "year": year,
        "mode": "hospital",
        "level": lv,
        "level_label": LEVEL_LABEL[lv],
        "spec_km": spec,
        "hospital": {
            "s_no": str(s_no),
            "name": h["hospital_name"],
            "type": h["hosp_type"],
            "level": lv,
            "district": h["district_name"],
            "lat": h["lat"],
            "lon": h["lon"],
            "tpl": h.get("tpl"),
            "tpl_source": h.get("tpl_source"),
            "level_source": h.get("level_source"),
        },
        "reachable_total": len(pairs),
        "drawn": len(branches),
        "capped": len(pairs) > len(branches),
        "distance_km": {
            "min": round(min(kms), 2) if kms else None,
            "median": round(_st.median(kms), 2) if kms else None,
            "max": round(max(kms), 2) if kms else None,
        },
        "branches": branches,
    }
