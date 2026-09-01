#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

export DATABASE_URL="${DATABASE_URL:-postgresql://mapsr:mapsr@localhost:5433/mapsr}"
export OSRM_BASE="${OSRM_BASE:-http://127.0.0.1:5000}"
export OSRM_SLEEP="${OSRM_SLEEP:-0}"

echo "==> Checking dependencies..."
python3 -m pip install -q -r requirements.txt

if ! docker info >/dev/null 2>&1; then
  echo "==> Starting Docker Desktop..."
  open -a Docker 2>/dev/null || true
  for _ in $(seq 1 40); do
    docker info >/dev/null 2>&1 && break
    sleep 3
  done
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is required for PostGIS + OSRM. Start Docker Desktop and retry."
  exit 1
fi

echo "==> Starting PostgreSQL + PostGIS (Docker)..."
docker compose -f docker-compose.dev.yml up -d db

echo "==> Setting up self-hosted OSRM (Haryana road network)..."
chmod +x scripts/setup_osrm.sh scripts/setup_database.sh
./scripts/setup_osrm.sh

echo "==> Initializing database..."
./scripts/setup_database.sh

PORT=5050
if lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "==> Stopping existing server on port $PORT..."
  lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

echo "==> Starting dashboard at http://127.0.0.1:$PORT"
echo "    OSRM routing: $OSRM_BASE"
if [[ -f data/recompute.pid ]] && kill -0 "$(cat data/recompute.pid)" 2>/dev/null; then
  echo "    Reach/scorecard recompute still running — tail -f data/recompute.log"
fi
open "http://127.0.0.1:$PORT" 2>/dev/null || true
cd dashboard && exec env DATABASE_URL="$DATABASE_URL" OSRM_BASE="$OSRM_BASE" OSRM_SLEEP="$OSRM_SLEEP" python3 app.py
