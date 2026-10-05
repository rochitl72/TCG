#!/usr/bin/env python3
"""Precomputed OSRM road-route geometry for the Proximity tab's route branches.

WHY A FILE AND NOT A LIVE CALL
Modes 2 and 3 draw the ACTUAL road route between a grid centroid and a
hospital, not a straight line. Fetching those from OSRM on every click works,
but it makes the demo depend on the OSRM container being up and warm at the
moment someone clicks. The routes are static for a given data revision, so
they are precomputed once (scripts/precompute_grid_routes.py) and read from
here at request time. Nothing in this module touches the network.

STORAGE FORMAT
Geometry is stored as OSRM's ENCODED POLYLINE (precision 5), not GeoJSON.
That decision is what makes the file usable at all: the ~45,000 routes we
store run to roughly 450 MB as `overview=full` GeoJSON coordinate arrays and
about 25-30 MB as `overview=simplified` encoded polylines, for a difference
on screen that is invisible at any zoom the dashboard uses. The browser
decodes them with a ~20-line decoder in network_analytics.js.

Keys are "<grid_id>-<s_no>". A route is direction-agnostic here: the same
entry serves "grid -> hospital" (mode 2) and "hospital -> grid" (mode 3),
because a drawn branch is the same line either way.

MISSING FILE IS NOT AN ERROR
If the artifact has not been built, available() returns False and every
lookup returns None. The UI is expected to fall back to a straight line and
say so, rather than break — a missing precompute should degrade the map, not
take down the tab.
"""

from __future__ import annotations

import json
import os

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
ANALYTICS_DIR = os.path.join(DATA_DIR, "analytics")

_cache: dict[tuple, tuple[float, dict]] = {}


def _rid(region_id: str | None = None) -> str:
    import regions  # noqa: PLC0415

    return regions._norm(region_id) if region_id else regions.current_id()


def routes_path(year: str = "2025", region_id: str | None = None) -> str:
    """Per-region route file. Haryana keeps grid_routes_<year>.json; another
    region (e.g. Chamba) uses grid_routes_<suffix>_<year>.json, built by
    scripts/precompute_region_routes.py against that region's own OSRM graph."""
    import regions  # noqa: PLC0415

    suffix = regions.get(_rid(region_id))["artifact_suffix"]
    return os.path.join(ANALYTICS_DIR, f"grid_routes{suffix}_{year}.json")


def available(year: str = "2025", region_id: str | None = None) -> bool:
    return os.path.exists(routes_path(year, region_id))


def load_routes(year: str = "2025", region_id: str | None = None) -> dict:
    """Return {"<grid_id>-<s_no>": "<encoded polyline>"}; {} when not built."""
    rid = _rid(region_id)
    path = routes_path(year, rid)
    if not os.path.exists(path):
        return {}
    mtime = os.path.getmtime(path)
    hit = _cache.get((rid, year))
    if hit and hit[0] == mtime:
        return hit[1]
    with open(path) as fh:
        payload = json.load(fh)
    routes = payload.get("routes") or {}
    _cache[(rid, year)] = (mtime, routes)
    return routes


def key(grid_id, s_no) -> str:
    return f"{grid_id}-{s_no}"


def route_for(year: str, grid_id, s_no) -> str | None:
    """Encoded polyline for one grid<->hospital pair, or None if not stored."""
    return load_routes(year).get(key(grid_id, s_no))


def stats(year: str = "2025") -> dict:
    path = routes_path(year)  # current request's region
    if not os.path.exists(path):
        return {"available": False, "count": 0, "path": path}
    with open(path) as fh:
        payload = json.load(fh)
    return {
        "available": True,
        "count": len(payload.get("routes") or {}),
        "generated_at": payload.get("generated_at"),
        "year": payload.get("year"),
        "path": path,
        "megabytes": round(os.path.getsize(path) / 1e6, 1),
    }
