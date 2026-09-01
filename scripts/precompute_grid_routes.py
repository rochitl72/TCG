#!/usr/bin/env python3
"""Precompute the OSRM road-route geometry the Proximity tab draws as branches.

WHAT IT BUILDS
    data/analytics/grid_routes_<year>.json
        {"routes": {"<grid_id>-<s_no>": "<encoded polyline>"}}

WHICH PAIRS
    Mode 2 (Grid)      every grid -> its nearest L1, L2 and L3 facility.
                       Included even when that facility is BEYOND the spec
                       radius, because a red "too far" branch still has to be
                       drawn along a real road.
    Mode 3 (Hospital)  every L1/L2/L3 facility -> its nearest N grids inside
                       that level's radius (N = HOSPITAL_BRANCH_LIMIT, 25).

    The two sets overlap heavily and a route is direction-agnostic for drawing
    purposes, so they share one key space and are de-duplicated before any
    OSRM call is made.

WHY ENCODED POLYLINE, NOT GEOJSON
    `overview=full` + `geometries=geojson` for this many routes is ~450 MB.
    `overview=simplified` + `geometries=polyline` is ~25-30 MB for a
    difference invisible at dashboard zoom levels. The browser decodes it with
    a short decoder in network_analytics.js.

REQUIREMENTS
    A reachable OSRM with the Haryana graph loaded. Defaults to the local one
    that docker-compose brings up:
        export OSRM_BASE=http://localhost:5000
    This must run on a machine that can reach it — the assistant's sandbox
    cannot, same as scripts/probe_rbg_api.py and fetch_hosp_gps_cache.py.

RESUMABLE
    Writes a checkpoint every CHECKPOINT_EVERY routes and reloads any existing
    output on start, so an interrupted run picks up where it stopped instead
    of repeating tens of thousands of calls. Re-running after a data change is
    safe: stale keys are dropped, only missing ones are fetched.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "dashboard"))

OSRM_BASE = os.environ.get("OSRM_BASE", "http://localhost:5000").rstrip("/")
WORKERS = int(os.environ.get("ROUTE_WORKERS", "12"))
CHECKPOINT_EVERY = int(os.environ.get("ROUTE_CHECKPOINT_EVERY", "2000"))
TIMEOUT = float(os.environ.get("ROUTE_TIMEOUT", "20"))

_lock = threading.Lock()


def out_path(year: str) -> str:
    return os.path.join(ROOT, "data", "analytics", f"grid_routes_{year}.json")


def osrm_route(lon1, lat1, lon2, lat2) -> str | None:
    """Return the encoded polyline for one pair, or None if OSRM has no route."""
    url = (
        f"{OSRM_BASE}/route/v1/driving/"
        f"{lon1},{lat1};{lon2},{lat2}"
        "?overview=simplified&geometries=polyline&alternatives=false&steps=false"
    )
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as resp:
            payload = json.loads(resp.read())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None
    if payload.get("code") != "Ok" or not payload.get("routes"):
        return None
    return payload["routes"][0].get("geometry")


def preflight() -> bool:
    print(f"OSRM base: {OSRM_BASE}")
    geom = osrm_route(76.78, 29.95, 76.79, 29.96)
    if geom is None:
        print("  !! OSRM did not answer a trivial route.")
        print("     Start it first:  docker compose up -d osrm")
        print("     Then wait for the graph to load (can take minutes on a cold cache).")
        return False
    print("  OSRM answered; graph is loaded.\n")
    return True


def collect_pairs(year: str) -> tuple[dict, dict]:
    """Return ({key: (glon, glat, hlon, hlat)}, stats) for every pair we need."""
    import network_analytics as na

    radii = na._normalize_radii(None)

    print("==> Collecting mode 2 pairs (each grid -> nearest L1/L2/L3)")
    pairs: dict[str, tuple] = {}
    n_grid_branches = 0
    for g, nearest in na._grid_level_distances(year, None):
        for lv in na.LEVEL_ORDER:
            n = nearest[lv]
            if not n:
                continue
            pairs[f"{g['grid_id']}-{n['s_no']}"] = (g["lon"], g["lat"], n["lon"], n["lat"])
            n_grid_branches += 1
    print(f"    {n_grid_branches} grid branches -> {len(pairs)} unique pairs so far")

    print("==> Collecting mode 3 pairs (each facility -> nearest "
          f"{na.HOSPITAL_BRANCH_LIMIT} grids in its radius)")
    hg = na.load_hospital_grid(year)
    index = hg["grid_index"]
    hospitals = hg["hospitals"]
    n_hosp_branches = 0
    per_level = {lv: 0 for lv in na.LEVEL_ORDER}
    for s_no, plist in hg["hospital_grids"].items():
        h = hospitals.get(s_no)
        if not h:
            continue
        lv = (h.get("hosp_level") or "").strip().upper()
        if lv not in na.LEVEL_RADII or not na.eligible_at_level(h, lv):
            continue
        per_level[lv] += 1
        near = sorted((p for p in plist if p[1] <= radii[lv]), key=lambda p: p[1])
        for gi, _km in near[: na.HOSPITAL_BRANCH_LIMIT]:
            g = index[gi]
            pairs[f"{g['grid_id']}-{s_no}"] = (g["lon"], g["lat"], h["lon"], h["lat"])
            n_hosp_branches += 1
    print(f"    {n_hosp_branches} hospital branches from "
          f"{sum(per_level.values())} facilities {per_level}")

    return pairs, {
        "grid_branches": n_grid_branches,
        "hospital_branches": n_hosp_branches,
        "unique_pairs": len(pairs),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", default="2025")
    ap.add_argument("--force", action="store_true",
                    help="refetch every pair instead of resuming from the existing file")
    args = ap.parse_args()
    year = args.year

    if not preflight():
        return 1

    pairs, stats = collect_pairs(year)
    path = out_path(year)

    routes: dict[str, str] = {}
    if os.path.exists(path) and not args.force:
        try:
            routes = (json.load(open(path)).get("routes") or {})
            # Drop keys the current data no longer needs, so a stale artifact
            # cannot keep a route to a hospital that has since changed level.
            routes = {k: v for k, v in routes.items() if k in pairs}
            print(f"==> Resuming: {len(routes)} usable routes already on disk")
        except (OSError, json.JSONDecodeError):
            routes = {}

    todo = [k for k in pairs if k not in routes]
    print(f"==> {len(todo)} routes to fetch ({len(pairs)} needed, {len(routes)} cached)\n")
    if not todo:
        print("Nothing to do.")
        return 0

    done = 0
    failed = 0
    t0 = time.time()

    def save():
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".part"
        with open(tmp, "w") as fh:
            json.dump(
                {
                    "schema": 1,
                    "year": year,
                    "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "osrm_base": OSRM_BASE,
                    "geometry": "polyline5/simplified",
                    "stats": stats,
                    "routes": routes,
                },
                fh,
            )
        os.replace(tmp, path)

    def work(key: str):
        nonlocal done, failed
        glon, glat, hlon, hlat = pairs[key]
        geom = osrm_route(glon, glat, hlon, hlat)
        with _lock:
            if geom:
                routes[key] = geom
            else:
                failed += 1
            done += 1
            if done % 500 == 0:
                rate = done / max(time.time() - t0, 1e-6)
                eta = (len(todo) - done) / max(rate, 1e-6)
                print(f"    {done}/{len(todo)}  {rate:.0f}/s  eta {eta/60:.1f} min  "
                      f"({failed} no-route)")
            if done % CHECKPOINT_EVERY == 0:
                save()

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        list(pool.map(work, todo))

    save()
    mb = os.path.getsize(path) / 1e6
    print(f"\n==> Wrote {path}")
    print(f"    {len(routes)} routes, {failed} pairs OSRM could not route, {mb:.1f} MB")
    print(f"    took {(time.time()-t0)/60:.1f} min")
    if failed:
        print("    (unroutable pairs fall back to a straight line in the UI, "
              "labelled as such)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
