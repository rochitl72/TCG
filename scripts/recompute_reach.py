#!/usr/bin/env python3
"""Regenerate every precomputed reach artifact GENUINELY from the database.

Rebuilds reach + district scorecard from the canonical sources in
``latest data/`` (geolocations + accidents) plus live PostGIS/OSRM. This script:

  1. Clears the on-disk grid-reach cache so the Grid Analysis view recomputes
     each district from scratch against the real hospital table on next request.
  2. Runs the reach pipeline synchronously, rebuilding
        data/accident_hospital_safety_v2.json
        data/accident_ambulance_safety_v2.json
        data/accident_bloodbank_safety_v2.json
        data/district_scorecard_v2.json
     from live PostGIS data + real OSRM road-route distances — no mock data,
     no hardcoded values, no artificial adjustments.

Run it after the database is up (start.sh / setup_database.sh):

    DATABASE_URL=postgresql://mapsr:mapsr@localhost:5433/mapsr \
        python3 scripts/recompute_reach.py

Environment variables:
    OSRM_BASE   OSRM endpoint (default https://router.project-osrm.org). For a
                large dataset (e.g. the full ~35k rows in latest data/) point
                this at a SELF-HOSTED OSRM, e.g. http://localhost:5000 — the
                public demo server is rate-limited and will throttle/fail.
    OSRM_SLEEP  Seconds to pause between accidents (default 0.1). Set 0 for a
                local OSRM to run at full speed.
    REACH_CLEAR_GRID=1   Also clear the per-district grid-reach cache (off by
                default so re-running to RESUME a long job keeps grid progress).

The accident-reach precompute is RESUMABLE: it checkpoints every few hundred
accidents and, if re-run on the same dataset, skips work already done.
"""

from __future__ import annotations

import glob
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DASHBOARD = os.path.join(ROOT, "dashboard")
sys.path.insert(0, DASHBOARD)

import reach_pipeline  # noqa: E402  (import after sys.path setup)


def clear_grid_reach_cache() -> None:
    cache_dir = os.path.join(ROOT, "data", "grid_reach")
    removed = 0
    for path in glob.glob(os.path.join(cache_dir, "*.json")):
        os.remove(path)
        removed += 1
    print(f"==> Cleared {removed} cached grid-reach file(s) — will recompute on demand.")


def main() -> int:
    print(f"==> Recomputing reach artifacts via OSRM_BASE={reach_pipeline.OSRM_BASE} "
          f"(sleep={reach_pipeline.OSRM_SLEEP}s)...")
    if os.environ.get("REACH_CLEAR_GRID") == "1":
        clear_grid_reach_cache()
    # Run the pipeline in the foreground (not the daemon thread) so this script
    # blocks until the JSONs are fully written.
    reach_pipeline._run_pipeline()
    status = reach_pipeline.get_status()
    if status.get("state") == "error":
        print(f"!! Recompute failed: {status.get('error')}", file=sys.stderr)
        return 1
    print("==> Done. Accident-reach + district-scorecard JSONs rebuilt from live data.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
