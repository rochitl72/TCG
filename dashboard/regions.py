"""Region context for the multi-state build.

The app began life Haryana-only: one grid cache, one hospital table, one bbox,
the string "HARYANA" baked into the grid label. Stakeholders then asked for
Chamba district, Himachal Pradesh. Rather than thread a state/district argument
through all ~50 endpoints and every analytics function, we add ONE
request-scoped "current region" that the data loaders consult. Each region
names the files and parameters that make it self-contained; the loaders
(network_analytics.load_grids / load_hospitals / load_proximity /
load_hospital_grid and rbg_grids.get_grids) default their `region` argument to
whatever the current request selected, so existing call sites keep working and
Haryana stays the default when no state is given.

WHY A THREAD-LOCAL AND NOT flask.g
network_analytics and rbg_grids are imported by scripts that run with no Flask
app at all (the precompute, the tests). They cannot depend on a request
context. A plain thread-local defaults to Haryana and is set per request by a
before_request hook in app.py; off the web path it simply stays Haryana unless
a script sets it explicitly.
"""

from __future__ import annotations

import os
import threading

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR = os.path.join(ROOT, "data")

# Haryana keeps the ORIGINAL, unsuffixed filenames so nothing about the live
# Haryana deployment changes on disk. New regions get a suffixed set of files.
REGIONS: dict[str, dict] = {
    "haryana": {
        "id": "haryana",
        "state_name": "Haryana",
        "state_code": "13",            # RBG/IRAD state code
        "district_scope": None,         # None = the whole state, all districts
        # lat_min, lat_max, lon_min, lon_max — the Haryana envelope.
        "bbox": (27.60, 30.99, 74.40, 77.70),
        "grid_cache_basename": "haryana",          # data/rbg_grids/haryana_<year>.json
        "artifact_suffix": "",                       # grid_hospital_<year>.json
        "hospital_source": "db",                     # Postgres haryana_hosp (+ fallback)
        "boundary_file": "haryana_districts.geojson",
        "grid_state_label": "HARYANA",
    },
    "himachal_chamba": {
        "id": "himachal_chamba",
        "state_name": "Himachal Pradesh",
        "state_code": "12",
        "district_scope": {"CHAMBA"},   # only Chamba is onboarded for HP
        # Chamba district envelope (a little margin around the real extent).
        "bbox": (32.00, 33.30, 75.40, 77.10),
        "grid_cache_basename": "himachal_chamba",   # data/rbg_grids/himachal_chamba_<year>.json
        "artifact_suffix": "_himachal_chamba",       # grid_hospital_himachal_chamba_<year>.json
        "hospital_source": "csv:regions/hospitals_chamba.csv",
        "boundary_file": "regions/himachal_chamba_boundary.geojson",
        "grid_state_label": "HIMACHAL PRADESH",
    },
}

DEFAULT_REGION = "haryana"

_local = threading.local()


def _norm(region_id: str | None) -> str:
    rid = (region_id or "").strip().lower()
    return rid if rid in REGIONS else DEFAULT_REGION


def resolve_from_state(state: str | None) -> str:
    """Map a human state name (what the frontend sends) to a region id.

    Only the state decides which dataset loads; the district query parameter
    keeps working as a sub-filter WITHIN the region exactly as before. Anything
    that is not clearly Himachal resolves to Haryana, so a missing or unknown
    state can never break the existing default view.
    """
    s = (state or "").strip().lower()
    if not s:
        return DEFAULT_REGION
    if s.startswith("himachal") or s in {"hp", "12"}:
        return "himachal_chamba"
    if s.startswith("haryana") or s in {"13"}:
        return "haryana"
    return DEFAULT_REGION


def set_current(region_id: str | None) -> str:
    rid = _norm(region_id)
    _local.region_id = rid
    return rid


def current_id() -> str:
    return getattr(_local, "region_id", DEFAULT_REGION)


def current() -> dict:
    return REGIONS[current_id()]


def get(region_id: str | None) -> dict:
    return REGIONS[_norm(region_id)]


def list_states() -> list[dict]:
    """[{state, region_id, districts}] for the frontend's state dropdown.

    `districts` is None for a whole-state region (the frontend fills it from
    the meta payload as it always has) and an explicit list for a
    district-scoped region.
    """
    out = []
    for r in REGIONS.values():
        scope = r["district_scope"]
        out.append(
            {
                "state": r["state_name"],
                "region_id": r["id"],
                "districts": sorted(scope) if scope else None,
            }
        )
    # Haryana first so the default state is the first option.
    out.sort(key=lambda x: 0 if x["region_id"] == DEFAULT_REGION else 1)
    return out


def boundary_path(region_id: str | None = None) -> str:
    r = get(region_id) if region_id else current()
    return os.path.join(DATA_DIR, r["boundary_file"])
