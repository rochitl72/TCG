#!/usr/bin/env python3
"""Precompute road-route geometry for EVERY grid<->hospital pair of a small
region (e.g. Chamba), so the map draws real roads instead of a dashed
straight line.

Why every pair: Haryana's production OSRM server only has Haryana's road
graph, so a non-Haryana region cannot fall back to a live route call. Chamba
is 64 grids x 13 hospitals = 832 pairs, a small file, so storing all of them
means no click can ever miss.

Run against a routing server that has the region's graph, e.g. the Chamba
container from scripts/setup_osrm_chamba.sh:

    OSRM_BASE=http://127.0.0.1:5001 \
      python3 scripts/precompute_region_routes.py --year 2025 --region himachal_chamba

Writes data/analytics/grid_routes_<suffix>_<year>.json in the same format as
Haryana's grid_routes_<year>.json:  {"routes": {"<grid_id>-<s_no>": "<polyline>"}}
(OSRM encoded polyline, precision 5, overview=simplified).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "dashboard"))

import grid_routes  # noqa: E402
import network_analytics as na  # noqa: E402
import regions  # noqa: E402

OSRM_BASE = os.environ.get("OSRM_BASE", "http://127.0.0.1:5001").rstrip("/")


def route(glat, glon, hlat, hlon):
    url = (
        f"{OSRM_BASE}/route/v1/driving/{glon},{glat};{hlon},{hlat}"
        "?overview=simplified&geometries=polyline&alternatives=false&steps=false"
    )
    with urllib.request.urlopen(url, timeout=30) as resp:
        data = json.loads(resp.read())
    if data.get("code") != "Ok" or not data.get("routes"):
        return None, None
    r = data["routes"][0]
    return r.get("geometry"), r.get("distance")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", default="2025")
    ap.add_argument("--region", required=True, help="regions.py id, e.g. himachal_chamba")
    args = ap.parse_args()

    rid = regions.set_current(args.region)
    if rid == "haryana":
        raise SystemExit("Haryana routes come from scripts/precompute_grid_routes.py.")
    print(f"==> Region: {rid}   OSRM: {OSRM_BASE}")

    payload = na.load_proximity(args.year)  # same grids/hospitals the app serves
    grids = payload["grids"]
    hospitals = payload["hospitals"]
    pairs = [(g, s_no, h) for g in grids for s_no, h in hospitals.items()]
    print(f"==> {len(grids)} grids x {len(hospitals)} hospitals = {len(pairs)} pairs")

    # Fail fast if the server is not the region's graph.
    g0, (s0, h0) = grids[0], next(iter(hospitals.items()))
    try:
        poly, _ = route(g0["lat"], g0["lon"], h0["lat"], h0["lon"])
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"OSRM at {OSRM_BASE} is not answering: {exc}\n"
                         "Start it with:  bash scripts/setup_osrm_chamba.sh")
    if not poly:
        raise SystemExit("OSRM answered but found no route - is it the right region's graph?")

    t0 = time.time()
    routes: dict[str, str] = {}
    misses = []

    def one(item):
        g, s_no, h = item
        try:
            poly, _ = route(g["lat"], g["lon"], h["lat"], h["lon"])
        except Exception:  # noqa: BLE001
            poly = None
        return grid_routes.key(g["grid_id"], s_no), poly

    with ThreadPoolExecutor(max_workers=8) as ex:
        for k, poly in ex.map(one, pairs):
            if poly:
                routes[k] = poly
            else:
                misses.append(k)

    out = grid_routes.routes_path(args.year, rid)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as fh:
        json.dump(
            {
                "year": args.year,
                "region": rid,
                "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "osrm_base": OSRM_BASE,
                "geometry": "osrm encoded polyline, precision 5, overview=simplified",
                "routes": routes,
            },
            fh,
        )
    print(f"==> Wrote {out}  ({os.path.getsize(out) / 1e6:.2f} MB)")
    print(f"    {len(routes)} routes, {len(misses)} with no road route, {time.time() - t0:.0f}s")
    if misses:
        print("    no route:", ", ".join(misses[:10]), "..." if len(misses) > 10 else "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
