#!/usr/bin/env python3
"""RETIRED 20 Aug 2026 — kept as a documented no-op, not deleted.

This script used to merge six FABRICATED "MCH" medical-college facilities
into the precomputed proximity caches, because those six had hand-picked
coordinates and were never part of `haryana_hosp` — the main precompute
never saw them, so this bolted their distances on afterward.

The mock is gone (see scripts/build_tpl.py). L1 now comes from real PRIVATE
hospitals that were ALREADY in haryana_hosp all along and therefore already
went through the normal, full OSRM precompute like every other hospital —
there is nothing left to merge separately. The one-line fix that actually
matters lives in dashboard/network_analytics.py's `_grid_level_distances()`,
which used to hard-exclude every private facility from L1/L2/L3 and now
makes a single, level-scoped exception for L1.

If docker-compose.yml or a setup script still calls this file, running it is
harmless: it prints why it is a no-op and exits 0, so an old automation
pipeline that hasn't been updated yet does not fail out from under someone.
"""


def main() -> int:
    print("scripts/add_mch_distances.py is retired (20 Aug 2026).")
    print("The mock L1 facilities it used to merge no longer exist —")
    print("see scripts/build_tpl.py and dashboard/network_analytics.py's")
    print("_grid_level_distances(). Nothing to do here. Exiting 0.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
