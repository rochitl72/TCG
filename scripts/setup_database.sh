#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export DATABASE_URL="${DATABASE_URL:-postgresql://mapsr:mapsr@localhost:5433/mapsr}"

PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1)

echo "==> Waiting for PostgreSQL..."
for _ in $(seq 1 30); do
  if "${PSQL[@]}" -c "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
"${PSQL[@]}" -c "SELECT 1" >/dev/null

echo "==> Enabling PostGIS..."
"${PSQL[@]}" -c "CREATE EXTENSION IF NOT EXISTS postgis;"
"${PSQL[@]}" -c "CREATE SCHEMA IF NOT EXISTS india_admin_boundary;"

sanitize_sql() {
  grep -v 'transaction_timeout' "$1" | grep -v 'OWNER TO postgres'
}

DISTRICT_COUNT=$("${PSQL[@]}" -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='india_admin_boundary' AND table_name='district';" | tr -d ' ')

if [[ "$DISTRICT_COUNT" == "0" ]]; then
  echo "==> Loading state boundaries..."
  sanitize_sql "state 1.sql" | "${PSQL[@]}"
  echo "==> Loading district boundaries..."
  sanitize_sql district.sql | "${PSQL[@]}"
else
  ROWS=$("${PSQL[@]}" -tAc 'SELECT COUNT(*) FROM india_admin_boundary.district;' | tr -d ' ')
  echo "==> District table already loaded ($ROWS rows)"
fi

echo "==> Creating grid tables (legacy schema kept empty — grids now come from RBG API)..."
"${PSQL[@]}" -f scripts/sql/002_grid_schema.sql
"${PSQL[@]}" -f scripts/sql/003_road_grid_type.sql

# Drop any previously generated PostGIS hex/circle/road cells. Accident grids
# are sourced exclusively from the RBG API (see dashboard/rbg_grids.py).
"${PSQL[@]}" -c "TRUNCATE india_admin_boundary.grid_cell RESTART IDENTITY;"
echo "==> Cleared PostGIS grid_cell table (RBG API is the sole grid source)"

# Prefetch default-year RBG grids into data/rbg_grids/ (best-effort; also loads on first map request).
echo "==> Prefetching RBG accident grids (year 2025)..."
(cd dashboard && python3 -c "import rbg_grids; rbg_grids.ensure_default_cache()") || true

# Clear stale hex/circle OSRM grid-reach caches
if [[ -d data/grid_reach ]]; then
  rm -f data/grid_reach/*.json
  echo "==> Cleared data/grid_reach cache"
fi

# STRICT DATA SOURCING: facilities come only from latest data/.
GEO_SQL="latest data/geolocations latest.sql"
if [[ ! -f "$GEO_SQL" ]]; then
  echo "ERROR: Required '$GEO_SQL' not found. Place the facilities dump there and retry."
  exit 1
fi

echo "==> Loading Haryana geolocations from '$GEO_SQL' (ambulance, blood banks, hospitals)..."
# Always reload from the canonical latest dump so mock/duplicate SQL files cannot linger.
"${PSQL[@]}" -c "DROP TABLE IF EXISTS public.haryana_ambulance, public.haryana_bloodbanks, public.haryana_hosp CASCADE;"
sanitize_sql "$GEO_SQL" | "${PSQL[@]}"
AMB=$("${PSQL[@]}" -tAc 'SELECT COUNT(*) FROM public.haryana_ambulance;' | tr -d ' ')
HOSP=$("${PSQL[@]}" -tAc 'SELECT COUNT(*) FROM public.haryana_hosp;' | tr -d ' ')
echo "==> Loaded geolocations ($AMB ambulances, $HOSP hospitals)"
GEO_RELOADED=1

"${PSQL[@]}" -f scripts/sql/004_geolocations_indexes.sql

# Whenever the facility data was (re)loaded, regenerate every precomputed reach
# artifact GENUINELY from the DB + OSRM so nothing stale/mock survives. Also runs
# if the shipped accident-reach JSON is simply missing.
#
# BUT: the accident-reach precompute makes one OSRM request per accident. With a
# large accident dataset (~35k in latest data/) that is far too much for the
# public OSRM demo server (~1 req/s). So we only auto-run it when the dataset is
# small OR when a self-hosted OSRM is configured via OSRM_BASE; otherwise we
# print instructions to run it deliberately against a local OSRM.
ACC_CSV="data/accidents_active.csv"
[[ -f "$ACC_CSV" ]] || ACC_CSV="latest data/haryana latest.csv"
if [[ ! -f "$ACC_CSV" ]]; then
  echo "ERROR: Required accidents CSV not found (expected '$ACC_CSV')."
  exit 1
fi
ACC_ROWS=$(($(wc -l < "$ACC_CSV") - 1))
OSRM_HOST="${OSRM_BASE:-https://router.project-osrm.org}"
SELF_HOSTED=0
if [[ "$OSRM_HOST" != *"router.project-osrm.org"* ]]; then
  SELF_HOSTED=1
fi

# The accident-reach artifacts (data/accident_*_safety_v2.json and
# district_scorecard_v2.json) fed the accident-safety, severity-heatmap and
# district-scorecard pages. Those pages were removed when the app was
# consolidated into the single Network Analytics view, and nothing in the
# running code reads the files any more — grep dashboard/ and scripts/ for
# "safety" and the only hits are comments.
#
# This used to run whenever the file was simply absent, which on a fresh clone
# is always. That silently launched one OSRM request per accident across ~35k
# rows — hours of work on a new server, for output nobody consumes. It now
# runs only when asked for:
#
#     TCGA_RECOMPUTE_REACH=1 ./scripts/setup_database.sh
#
if [[ "${TCGA_RECOMPUTE_REACH:-0}" == "1" ]]; then
  if [[ "$SELF_HOSTED" == "0" && "$ACC_ROWS" -gt 3000 ]]; then
    echo "==> NOTE: $ACC_ROWS accidents is too many for the public OSRM demo server."
    echo "    Run ./start.sh (includes self-hosted OSRM) or:"
    echo "        ./scripts/setup_osrm.sh"
    echo "        OSRM_BASE=http://127.0.0.1:5000 OSRM_SLEEP=0 python3 scripts/recompute_reach.py"
  elif [[ "$ACC_ROWS" -gt 3000 ]]; then
    mkdir -p data
    if [[ -f data/recompute.pid ]] && kill -0 "$(cat data/recompute.pid)" 2>/dev/null; then
      echo "==> Reach/scorecard recompute already running (pid $(cat data/recompute.pid))."
      echo "    tail -f data/recompute.log"
    else
      echo "==> Starting reach/scorecard recompute in background for $ACC_ROWS accidents via $OSRM_HOST ..."
      echo "    tail -f data/recompute.log"
      nohup env DATABASE_URL="$DATABASE_URL" OSRM_BASE="$OSRM_HOST" OSRM_SLEEP="${OSRM_SLEEP:-0}" \
        python3 scripts/recompute_reach.py >> data/recompute.log 2>&1 &
      echo $! > data/recompute.pid
    fi
  else
    echo "==> Recomputing reach/scorecard for $ACC_ROWS accidents via $OSRM_HOST (resumable)..."
    python3 scripts/recompute_reach.py || echo "!! Recompute failed — re-run manually: python3 scripts/recompute_reach.py"
  fi
else
  echo "==> Skipping accident-reach/scorecard recompute (nothing in the app reads it)."
  echo "    To regenerate anyway: TCGA_RECOMPUTE_REACH=1 ./scripts/setup_database.sh"
fi

echo "==> Database ready."
