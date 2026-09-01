#!/usr/bin/env bash
#
# One-command setup for a fresh machine, written for Windows + Docker Desktop
# (WSL2 backend). Run it from an Ubuntu/WSL shell inside the project folder:
#
#     bash scripts/setup_windows.sh
#
# WHY THIS EXISTS, when start.sh already sets the project up:
#
#   start.sh is the macOS development path. It expects `psql` and a full
#   Python environment on the HOST, calls `open -a Docker`, and runs the Flask
#   dev server directly. On a Windows box none of that is a given, and asking
#   a reviewer to install PostgreSQL client tools and a Python 3.11 toolchain
#   before he can look at the app is a bad first five minutes.
#
#   This script needs nothing but Docker. Every database command is piped
#   through `docker compose exec db psql`, so the postgres client that is
#   already inside the PostGIS image does the work. The app itself runs from
#   dashboard/Dockerfile, so its Python dependencies live in the image and
#   never touch the host.
#
# It is idempotent: each step checks whether its output already exists, so a
# re-run after a failure resumes rather than starting over.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OSRM_DATA="$ROOT/osrm-data"
ZONE_PBF="$OSRM_DATA/northern-zone-latest.osm.pbf"
CLIPPED_PBF="haryana.osm.pbf"
# osrm-partition + osrm-customize write this last. Its presence is the only
# reliable "the graph finished building" signal — there is no bare
# `haryana.osrm` file, just a family of `haryana.osrm.*` siblings, and the
# early ones exist even when a build died halfway.
OSRM_READY="$OSRM_DATA/haryana.osrm.mldgr"
ZONE_URL="https://download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf"
OSRM_IMAGE="ghcr.io/project-osrm/osrm-backend"
OSMIUM_IMAGE="iboates/osmium:latest"
# Bounding box around every accident and facility coordinate in latest data/,
# plus a little padding. Geofabrik publishes no Haryana-only extract, so we
# take the northern-zone file and clip it — the difference is ~210 MB of
# download versus a graph small enough to build on a laptop.
HARYANA_BBOX="74.45,27.65,77.65,30.90"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 0. Docker

say "Checking Docker"
command -v docker >/dev/null 2>&1 || die "docker not found on PATH.
  Install Docker Desktop, then in Settings > Resources > WSL Integration
  enable this distro so the docker CLI appears inside WSL."
docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start Docker Desktop and retry."
docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) not available. Update Docker Desktop."
# curl is used to fetch the 210 MB OSM extract and to poll the app at the end.
# A minimal WSL image can ship without it, and finding that out 40 lines later
# — after the database has already been seeded — wastes the reviewer's time.
command -v curl >/dev/null 2>&1 || die "curl not found. Install it first:  sudo apt-get update && sudo apt-get install -y curl"
echo "    Docker OK"

# ------------------------------------------------------------------ 1. .env
#
# docker-compose.yml defaults the OSRM image to linux/arm64 because the
# machines this was developed on are Apple Silicon. On an Intel/AMD box that
# default makes OSRM run under QEMU emulation, where loading the 1.9 GB road
# graph goes from seconds to many minutes and often just OOMs. Pinning the
# platform here is the single most important line in this file.
say "Writing .env"
if [ ! -f .env ]; then
  cp .env.example .env
fi
if grep -qE '^\s*OSRM_PLATFORM=' .env; then
  sed -i 's|^\s*#*\s*OSRM_PLATFORM=.*|OSRM_PLATFORM=linux/amd64|' .env
else
  printf '\nOSRM_PLATFORM=linux/amd64\n' >> .env
fi
grep OSRM_PLATFORM .env | sed 's/^/    /'

# ------------------------------------------------------------- 2. Database

say "Starting PostGIS"
# Create the OSRM bind-mount target first. docker-compose.yml mounts
# ./osrm-data, and if it is missing when compose first runs, the Docker daemon
# creates it root-owned — which makes the graph download three steps below fail
# with a permission error that looks nothing like its cause.
mkdir -p "$OSRM_DATA"
docker compose up -d db

say "Waiting for PostgreSQL to accept connections"
for _ in $(seq 1 60); do
  if docker compose exec -T db pg_isready -U mapsr -d mapsr >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker compose exec -T db pg_isready -U mapsr -d mapsr >/dev/null \
  || die "PostgreSQL never came up. Check: docker compose logs db"
echo "    Database accepting connections"

# Every psql call goes through the container. Nothing is required on the host.
psqlc() { docker compose exec -T db psql -U mapsr -d mapsr -v ON_ERROR_STOP=1 "$@"; }

# These dumps were taken from a server whose postgres was newer, and were owned
# by a role that does not exist here. Both produce hard errors under
# ON_ERROR_STOP that have nothing to do with the data, so strip them on the way
# in. Same two filters scripts/setup_database.sh uses.
sanitize() { grep -v 'transaction_timeout' "$1" | grep -v 'OWNER TO postgres'; }

say "Enabling PostGIS"
psqlc -c "CREATE EXTENSION IF NOT EXISTS postgis;" >/dev/null
psqlc -c "CREATE SCHEMA IF NOT EXISTS india_admin_boundary;" >/dev/null

DISTRICT_TABLE=$(psqlc -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='india_admin_boundary' AND table_name='district';" | tr -d ' \r')
if [ "$DISTRICT_TABLE" = "0" ]; then
  say "Loading state boundaries (state 1.sql, ~45 MB)"
  sanitize "state 1.sql" | psqlc >/dev/null
  say "Loading district boundaries (district.sql, ~172 MB — takes a few minutes)"
  sanitize "district.sql" | psqlc >/dev/null
else
  ROWS=$(psqlc -tAc 'SELECT COUNT(*) FROM india_admin_boundary.district;' | tr -d ' \r')
  echo "    Boundaries already loaded ($ROWS districts) — skipping"
fi

say "Loading Haryana facilities (hospitals, ambulances, blood banks)"
GEO_SQL="latest data/geolocations latest.sql"
[ -f "$GEO_SQL" ] || die "Missing '$GEO_SQL'. The backend zip did not extract completely."
# Always reload rather than skip-if-present: this is the canonical facility
# dump, and a half-loaded or superseded copy is worse than a slow reload.
psqlc -c "DROP TABLE IF EXISTS public.haryana_ambulance, public.haryana_bloodbanks, public.haryana_hosp CASCADE;" >/dev/null
sanitize "$GEO_SQL" | psqlc >/dev/null
AMB=$(psqlc -tAc 'SELECT COUNT(*) FROM public.haryana_ambulance;' | tr -d ' \r')
HOSP=$(psqlc -tAc 'SELECT COUNT(*) FROM public.haryana_hosp;' | tr -d ' \r')
echo "    Loaded $HOSP hospitals, $AMB ambulances"

say "Applying schema migrations"
psqlc < scripts/sql/002_grid_schema.sql >/dev/null
psqlc < scripts/sql/003_road_grid_type.sql >/dev/null
psqlc < scripts/sql/004_geolocations_indexes.sql >/dev/null
# The legacy PostGIS hex/circle grid tables are kept for their schema only.
# Accident grids now come exclusively from the RBG API, cached under
# data/rbg_grids/ (shipped, so no network call is needed on first load).
psqlc -c "TRUNCATE india_admin_boundary.grid_cell RESTART IDENTITY;" >/dev/null
echo "    Schema ready"

# ----------------------------------------------------------------- 3. OSRM

if [ -f "$OSRM_READY" ]; then
  say "OSRM road graph already built — skipping"
else
  if [ ! -f "$ZONE_PBF" ]; then
    say "Downloading India northern-zone OSM extract (~210 MB, one time)"
    curl -fL --retry 3 --retry-delay 5 -o "$ZONE_PBF" "$ZONE_URL" \
      || die "Download failed. Retry, or fetch $ZONE_URL manually into osrm-data/"
  fi

  if [ ! -f "$OSRM_DATA/$CLIPPED_PBF" ]; then
    say "Clipping to the Haryana bounding box"
    docker run --rm -v "$OSRM_DATA:/data" "$OSMIUM_IMAGE" \
      extract -b "$HARYANA_BBOX" -o "/data/$CLIPPED_PBF" "/data/northern-zone-latest.osm.pbf"
  fi

  say "Building the OSRM road graph (~10 min, needs 8 GB of RAM available to Docker)"
  rm -f "$OSRM_DATA"/haryana.osrm.* 2>/dev/null || true
  docker run --rm -t --platform linux/amd64 -v "$OSRM_DATA:/data" "$OSRM_IMAGE" \
    osrm-extract -p /opt/car.lua -t 1 "/data/$CLIPPED_PBF" \
    || die "osrm-extract failed.
  If it stopped near 'Generating edge-expanded edges', Docker ran out of memory.
  Docker Desktop > Settings > Resources > Memory: raise to 8 GB, then re-run
  this script — completed steps are skipped automatically."
  docker run --rm -t --platform linux/amd64 -v "$OSRM_DATA:/data" "$OSRM_IMAGE" \
    osrm-partition "/data/haryana.osrm"
  docker run --rm -t --platform linux/amd64 -v "$OSRM_DATA:/data" "$OSRM_IMAGE" \
    osrm-customize "/data/haryana.osrm"
  [ -f "$OSRM_READY" ] || die "Graph build finished but $OSRM_READY is missing."
  echo "    Graph built"
fi

# ------------------------------------------------------------ 4. Full stack

say "Building the app image and starting the stack"
docker compose up -d --build

say "Waiting for the app to answer (OSRM memory-maps 1.9 GB first — up to 3 min cold)"
UP=0
for _ in $(seq 1 90); do
  if curl -sf -o /dev/null http://127.0.0.1/api/geolocations 2>/dev/null; then
    UP=1; break
  fi
  sleep 4
done

if [ "$UP" = "1" ]; then
  say "Ready — open http://localhost in your browser"
else
  say "Stack is up but the app has not answered yet"
  cat <<'MSG'
    This is usually just OSRM still loading the road graph. Watch it with:
        docker compose logs -f backend osrm
    Then open http://localhost
MSG
fi

docker compose ps
