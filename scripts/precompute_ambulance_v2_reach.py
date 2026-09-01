#!/usr/bin/env python3
"""Road-distance reach cache for the v2 (partner "new") ambulance dataset.

Input : data/ambulances_v2.json   (built by scripts/build_ambulances_v2.py)
Output: data/analytics/grid_ambulance_v2_<year>.json

HOW THIS REUSES THE EXISTING ENGINE
grid_ambulance.scan() already does the hard part — batched OSRM table calls,
preflight, per-grid nearest selection. It buckets candidates by the point's
`vehicle_type` and keeps the nearest N in each bucket. The v2 data has no
vehicle type, but it does have a Day and a Time Period, so this script sets

    vehicle_type = "<Day>|<Time Period>"        e.g. "Sat|03 PM - 06 PM"

and lets scan() keep the nearest station PER SLOT. That is not a trick, it is
exactly the index the UI needs: every filter the sidebar can express (a day, a
period, or All) is a union of whole slots, so the nearest station within any
such filter is the minimum over that union's per-slot nearest. The answer is
exact for every reachable filter combination, not an approximation.

Keeping 1 per slot would be enough for the gap test alone; we keep a few so the
popups can list alternatives without a second pass.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "dashboard"))

import grid_ambulance as ga  # noqa: E402
import network_analytics as na  # noqa: E402

SRC = os.path.join(ROOT, "data", "ambulances_v2.json")
KEEP_PER_SLOT = 3


def artifact_path(year: str) -> str:
    return os.path.join(ga.ANALYTICS_DIR, f"grid_ambulance_v2_{year}.json")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", default="2025")
    ap.add_argument(
        "--offline",
        action="store_true",
        help="Straight-line fallback when OSRM is unavailable. Marks the artifact so "
        "the UI can say the numbers are not road distances.",
    )
    args = ap.parse_args()

    if not os.path.exists(SRC):
        print(f"ERROR: {SRC} missing. Run scripts/build_ambulances_v2.py first.", file=sys.stderr)
        return 1

    src = json.load(open(SRC))
    fleet = src["ambulances"]

    grids, _report = na.load_grids(args.year)
    print(f"{len(grids)} grids x {len(fleet)} v2 stations")

    points = [
        {
            "s_no": a["id"],
            "vehicle_no": a["id"],
            # The slot IS the bucket key — see the module docstring.
            "vehicle_type": f"{a['day']}|{a['period']}",
            "stationed_at": a["city"] or a["district"],
            "lat": a["lat"],
            "lon": a["lon"],
        }
        for a in fleet
    ]

    t0 = time.time()

    def progress(done: int, total: int) -> None:
        pct = 100.0 * done / max(total, 1)
        print(f"  {done}/{total} grids ({pct:.0f}%)", flush=True)

    if args.offline:
        rows = ga.scan_offline(grids, points, keep_per_type=KEEP_PER_SLOT)
        mode = "straight_line"
    else:
        rows = ga.scan(grids, points, keep_per_type=KEEP_PER_SLOT, progress=progress)
        mode = "osrm_road"

    return _write(rows, src, fleet, args.year, mode, time.time() - t0)


def _write(rows, src, fleet, year, mode, elapsed) -> int:
    # The station table travels WITH the reach cache. The gap endpoint needs
    # day/period/district/address per station to filter and to fill popups, and
    # re-reading ambulances_v2.json alongside this file invites the two drifting
    # apart after a rebuild of only one of them.
    payload = {
        "year": year,
        "mode": mode,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "keep_per_slot": KEEP_PER_SLOT,
        "search_radius_km": ga.SEARCH_RADIUS_KM,
        "days": src["days"],
        "periods": src["periods"],
        "districts": src["districts"],
        "slot_counts": src["slot_counts"],
        "station_count": len(fleet),
        "stations": fleet,
        "grids": rows,
    }
    out = artifact_path(year)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as fh:
        json.dump(payload, fh)

    reached = sum(1 for r in rows if r["near"])
    size_mb = os.path.getsize(out) / 1e6
    print(f"wrote {out}  ({size_mb:.1f} MB, {elapsed:.0f}s, mode={mode})")
    print(f"  {len(rows)} grids, {reached} with at least one station inside "
          f"{ga.SEARCH_RADIUS_KM:.0f} km")
    if mode == "straight_line":
        print("  WARNING: straight-line distances, not road. Re-run without --offline "
              "once OSRM is up.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
