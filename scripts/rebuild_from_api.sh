#!/usr/bin/env bash
#
# Full rebuild against the partner's RE-LAID grid  (written 2026-08-28)
#
# WHY THIS EXISTS
# The RBG partner re-tiled their accident grid. Every grid_id the app holds is
# stale upstream: of ~6,800 cells, 18 IDs still exist and ZERO cells match by
# position. The new tiling covers the same geography on a different origin --
# cells sit a median 455 m (max 1.15 km) from their old counterparts. That is
# why one_pager/grid_data answers "101 No data available" for every cell we ask
# about, including 716773, which returned 39 crashes when probed on 2026-08-20.
#
# Total severity moved +0.3% (82,196 -> 82,439), so this rebuild buys ID
# compatibility with the partner's live popups, NOT new accident data.
#
# WHAT IT DOES
#   0. preflight -- refuses to start unless OSRM and the partner feed are up
#   1. re-pulls the grid cache from acc_grid_data (force)
#   2. re-runs every precompute that is keyed by grid_id
#
# Steps 2+ need OSRM and take hours. If a step dies, fix the cause and re-run;
# earlier steps are cheap to redo except the routing ones.
#
# ROLLBACK
#   rm -rf data/analytics data/rbg_grids
#   cp -R data/_backup_pre_regrid_20260828/analytics  data/analytics
#   cp -R data/_backup_pre_regrid_20260828/rbg_grids  data/rbg_grids
#
# USAGE (from the repo root, with OSRM running)
#   OSRM_BASE=http://127.0.0.1:5000 \
#     bash scripts/rebuild_from_api.sh 2>&1 | tee "data/regrid_$(date +%Y%m%d_%H%M).log"

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

YEAR="${YEAR:-2025}"
OSRM_BASE="${OSRM_BASE:-http://127.0.0.1:5000}"
export OSRM_BASE

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight
# Every step below is long. Checking prerequisites now turns a two-hour
# failure into a two-second one.
say "Preflight"

python3 - <<'PY' || fail "missing Python dependency -- install it before rerunning"
import sys
missing = []
for m in ("shapely", "requests"):
    try:
        __import__(m)
    except ImportError:
        missing.append(m)
if missing:
    print("  MISSING:", ", ".join(missing))
    sys.exit(1)
print("  python deps ok")
PY

# OSRM must answer a real route, not merely accept a TCP connection -- a
# container that is up but still loading its graph 500s on every request, and
# the precompute would spend an hour retrying.
if ! curl -fsS --max-time 10 "${OSRM_BASE}/route/v1/driving/77.0,28.4;77.1,28.5" >/dev/null 2>&1; then
  fail "OSRM not answering at ${OSRM_BASE}
       start it with:  docker compose up -d osrm
       then wait for the graph to load and rerun."
fi
echo "  OSRM ok at ${OSRM_BASE}"

if ! curl -fsS --max-time 15 https://rbg.iitm.ac.in/ >/dev/null 2>&1; then
  fail "cannot reach rbg.iitm.ac.in -- check the network/VPN."
fi
echo "  partner API reachable"

BK="data/_backup_pre_regrid_20260828"
[ -d "$BK" ] || fail "backup $BK missing -- do not run without a rollback point."
echo "  backup present at $BK"

# ------------------------------------------------------------ 1. grid cache
# force=True is the whole point: build_collection() short-circuits on an
# existing file, which is why the Aug 7 cache survived three weeks of the
# partner changing underneath it.
say "1/5  Re-pulling the grid from acc_grid_data (force)"
python3 - "$YEAR" <<'PY' || fail "grid re-pull failed"
import sys, os, json
sys.path.insert(0, os.path.join(os.getcwd(), "dashboard"))
import rbg_grids

year = sys.argv[1]
path = rbg_grids._cache_path(year)
before = len(json.load(open(path)).get("features", [])) if os.path.exists(path) else None

coll = rbg_grids.build_collection(year, force=True)
n = len(coll.get("features", []))
print(f"  cells: {before} -> {n}")
if n < 5000:
    raise SystemExit(f"  only {n} cells -- that is not a whole state, aborting")
PY

# ----------------------------------------------- 2. grid <-> hospital reach
say "2/5  Grid <-> hospital reach (OSRM) -- the long one"
python3 scripts/precompute_network_analytics.py --year "$YEAR" \
  || fail "precompute_network_analytics failed"

# --------------------------------------------------------- 3. per-grid routes
say "3/5  Per-grid road routes (OSRM)"
python3 scripts/precompute_grid_routes.py --year "$YEAR" --force \
  || fail "precompute_grid_routes failed"

# ---------------------------------------------------- 4. ambulance reach (old)
say "4/5  Ambulance reach -- current fleet (OSRM)"
python3 scripts/precompute_ambulance_reach.py --year "$YEAR" \
  || fail "precompute_ambulance_reach failed"

# ----------------------------------------------------- 5. ambulance reach (v2)
say "5/5  Ambulance reach -- v2 workbook (OSRM)"
python3 scripts/precompute_ambulance_v2_reach.py --year "$YEAR" \
  || fail "precompute_ambulance_v2_reach failed"

# ---------------------------------------------------------------- verify
# The point of the rebuild is that our IDs match theirs again. Assert it
# rather than trusting that five green steps mean the right thing happened.
say "Verifying our grid IDs now exist upstream"
python3 - "$YEAR" <<'PY'
import json, sys, urllib.request, random
year = sys.argv[1]
grids = json.load(open(f"data/rbg_grids/haryana_{year}.json"))["features"]
ids = [str(f["properties"]["grid_id"]) for f in grids]
print(f"  {len(ids)} cells in the rebuilt cache")

def grid_data(gid):
    req = urllib.request.Request(
        "https://rbg.iitm.ac.in/one_pager/grid_data",
        data=json.dumps({"grid_id": gid, "year": year, "state": "13"}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

random.seed(0)
sample = random.sample(ids, min(12, len(ids)))
live = sum(1 for g in sample if str(grid_data(g).get("status_code")) == "200")
print(f"  partner returned data for {live}/{len(sample)} sampled cells")
if live == 0:
    print("  WARNING: still zero. The IDs did not line up -- do not ship this;")
    print("           roll back and re-check the feed shape before continuing.")
else:
    print("  OK -- live per-cell popups should work again.")
PY

say "Done. Restart the Flask app so it drops its in-memory caches,"
echo "    then hard-refresh the browser (the popup cache is client-side too)."
