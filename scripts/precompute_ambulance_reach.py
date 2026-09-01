#!/usr/bin/env python3
"""Precompute road distance from every grid cell to Haryana's ambulance fleet.

Backs deliverable 3: "identify the grids that are 10 km and above, by road,
from any ambulance spot."

OUTPUT
    data/analytics/grid_ambulance_<year>.json

Straight-line distance under-reports here — road distance is always >= it, so a
grid 8 km away as the crow flies can be 12 km by road once a canal or a
motorway median gets in the way. Those grids are precisely what this analysis
is for, so the reach is routed through OSRM.

COST
With `--max-table-size 8000` on the osrm service (already set in both compose
files), all 569 ambulances go in as destinations and grid cells batch as
sources — roughly 35 requests for the whole state, a few seconds.

USAGE
    OSRM_BASE=http://127.0.0.1:5000 \
    DATABASE_URL=postgresql://mapsr:mapsr@localhost:5433/mapsr \
        python3 scripts/precompute_ambulance_reach.py --year 2025

    # smoke-test the pipeline before OSRM is up (straight-line, clearly stamped)
    python3 scripts/precompute_ambulance_reach.py --year 2025 --offline
"""

from __future__ import annotations

import argparse
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "dashboard"))

import grid_ambulance as ga  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", default="2025")
    ap.add_argument(
        "--offline",
        action="store_true",
        help="Straight-line instead of OSRM. Stamped straight_line_offline; the "
        "UI shows a warning banner. Never present offline output as road reach.",
    )
    args = ap.parse_args()

    if args.offline:
        print("==> OFFLINE MODE — straight-line distances, NOT road routes")
    else:
        print(f"==> OSRM: {ga.OSRM_BASE}")

    t0 = time.time()
    last = [0]

    def progress(done: int, total: int) -> None:
        if done - last[0] >= 1000 or done == total:
            last[0] = done
            rate = done / max(time.time() - t0, 1e-3)
            print(f"    {done}/{total} grids ({rate:.0f}/s)", flush=True)

    try:
        payload = ga.build_current(args.year, offline=args.offline, progress=progress)
    except ga.OSRMUnavailable as exc:
        print(f"\n!! {exc}", file=sys.stderr)
        return 2

    path = ga.artifact_path(args.year)
    size_mb = os.path.getsize(path) / 1e6
    print(f"\n==> Wrote {path}  ({size_mb:.1f} MB)")
    print(f"    {len(payload['grids'])} grids vs {payload['fleet_size']} ambulances")

    # Immediate read-out at the threshold the requirement names.
    for emergency_only in (False, True):
        res = ga.find_gaps(payload["grids"], 10.0, emergency_only=emergency_only)
        label = "ALS+BLS only" if emergency_only else "all vehicles"
        print(
            f"    >=10 km from any ambulance ({label:13}): "
            f"{res['gap_count']} grids ({res['gap_pct']}%), "
            f"{res['severity_pct']}% of accident severity"
        )
    print(f"    elapsed {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
