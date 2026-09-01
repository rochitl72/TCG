#!/usr/bin/env bash
# Build a Haryana-focused OSRM graph and start the local routing container.
#
# Geofabrik has no Haryana-only extract. We download India northern-zone (~210 MB),
# clip to a bbox covering all accidents/facilities in latest data/, then run OSRM.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OSRM_DATA="${OSRM_DATA_DIR:-$ROOT/osrm-data}"
ZONE_PBF="$OSRM_DATA/northern-zone-latest.osm.pbf"
PBF_NAME="haryana.osm.pbf"
PBF="$OSRM_DATA/$PBF_NAME"
# OSRM writes many `haryana.osrm.*` files — there is no bare `haryana.osrm` path.
# `haryana.osrm.mldgr` is created only after partition + customize finish successfully.
OSRM_READY="$OSRM_DATA/haryana.osrm.mldgr"
MARKER="$OSRM_DATA/.built"
ZONE_URL="${OSRM_ZONE_URL:-https://download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf}"
OSRM_IMAGE="${OSRM_IMAGE:-ghcr.io/project-osrm/osrm-backend}"
OSMIUM_IMAGE="${OSMIUM_IMAGE:-iboates/osmium:latest}"
# Image architecture, in precedence order:
#   DOCKER_PLATFORM  explicit, this script only
#   OSRM_PLATFORM    environment or .env — the SAME variable docker-compose.yml
#                    reads, so a server declares its architecture in one place
#                    and both the graph build and the running container agree
#   host architecture
# On Apple Silicon the amd64 image runs under emulation and often OOMs during
# the graph build, so the native arm64 default matters there. On an x86 server
# that default is exactly backwards and the container never becomes healthy,
# which is why .env wins over the guess below.
if [[ -z "${OSRM_PLATFORM:-}" && -f .env ]]; then
  OSRM_PLATFORM="$(sed -n 's/^[[:space:]]*OSRM_PLATFORM[[:space:]]*=[[:space:]]*//p' .env \
    | tail -1 | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
fi
if [[ -n "${OSRM_PLATFORM:-}" ]]; then
  DOCKER_PLATFORM="${DOCKER_PLATFORM:-$OSRM_PLATFORM}"
elif [[ "$(uname -m)" == "arm64" || "$(uname -m)" == "aarch64" ]]; then
  DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/arm64}"
else
  DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"
fi
# Exported so the `docker compose up -d osrm` below substitutes the same value
# into the compose file's ${OSRM_PLATFORM} rather than falling back to arm64.
# Always DOCKER_PLATFORM, so the graph is built and served by the same arch.
export OSRM_PLATFORM="$DOCKER_PLATFORM"
echo "==> OSRM image platform: $DOCKER_PLATFORM"

DOCKER_RUN=(docker run --platform "$DOCKER_PLATFORM")
COMPOSE_FILE="${OSRM_COMPOSE_FILE:-docker-compose.dev.yml}"
OSRM_PORT="${OSRM_PORT:-5000}"
OSRM_HOST="${OSRM_HOST:-http://127.0.0.1:$OSRM_PORT}"
# Covers all accident + facility coordinates in latest data/ (with small padding).
HARYANA_BBOX="${OSRM_HARYANA_BBOX:-74.45,27.65,77.65,30.90}"

mkdir -p "$OSRM_DATA"

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker is required for self-hosted OSRM. Start Docker Desktop and retry."
  exit 1
fi

is_valid_pbf() {
  [[ -f "$1" ]] && file "$1" | grep -qi 'OpenStreetMap\|Protocolbuffer'
}

if [[ -f "$ZONE_PBF" ]] && ! is_valid_pbf "$ZONE_PBF"; then
  echo "==> Removing invalid northern-zone download..."
  rm -f "$ZONE_PBF"
fi

if [[ ! -f "$ZONE_PBF" ]]; then
  echo "==> Downloading India northern-zone OSM extract (~210 MB, one-time)..."
  curl -fsSL --retry 3 --retry-delay 5 -L -o "$ZONE_PBF" "$ZONE_URL"
fi

if [[ ! -f "$PBF" || "$ZONE_PBF" -nt "$PBF" ]]; then
  echo "==> Clipping to Haryana bbox ($HARYANA_BBOX)..."
  docker run --rm -v "$OSRM_DATA:/data" "$OSMIUM_IMAGE" \
    extract -b "$HARYANA_BBOX" -o "/data/$PBF_NAME" "/data/northern-zone-latest.osm.pbf"
  rm -f "$MARKER"
fi

if [[ ! -f "$MARKER" || ! -f "$OSRM_READY" ]]; then
  echo "==> Building OSRM road graph (first run: ~5–10 min; needs ~4 GB Docker RAM)..."
  rm -f "$MARKER"
  rm -f "$OSRM_DATA"/haryana.osrm* "$OSRM_DATA"/haryana-bbox.osrm* 2>/dev/null || true
  echo "    (platform: $DOCKER_PLATFORM)"
  if ! "${DOCKER_RUN[@]}" --rm -t -v "$OSRM_DATA:/data" "$OSRM_IMAGE" \
    osrm-extract -p /opt/car.lua -t 1 "/data/$PBF_NAME"; then
    echo ""
    echo "ERROR: osrm-extract failed (exit $?)."
    echo "  If it stopped around 'Generating edge-expanded edges ~10%', Docker likely ran out of memory."
    echo "  Fix: Docker Desktop → Settings → Resources → Memory → set to 8 GB+, quit heavy apps, retry:"
    echo "        ./scripts/setup_osrm.sh"
    rm -f "$MARKER"
    exit 1
  fi
  "${DOCKER_RUN[@]}" --rm -t -v "$OSRM_DATA:/data" "$OSRM_IMAGE" \
    osrm-partition "/data/haryana.osrm"
  "${DOCKER_RUN[@]}" --rm -t -v "$OSRM_DATA:/data" "$OSRM_IMAGE" \
    osrm-customize "/data/haryana.osrm"
  touch "$MARKER"
  echo "==> OSRM graph built."
else
  echo "==> OSRM graph already built (skipping rebuild)"
fi

echo "==> Starting OSRM routing server..."
docker compose -f "$COMPOSE_FILE" up -d osrm
docker compose -f "$COMPOSE_FILE" restart osrm >/dev/null 2>&1 || true

echo "==> Waiting for OSRM at $OSRM_HOST ..."
for _ in $(seq 1 60); do
  if curl -sf "$OSRM_HOST/route/v1/driving/76.78,29.95;76.79,29.96?overview=false" | grep -q '"code":"Ok"'; then
    echo "==> OSRM ready at $OSRM_HOST"
    exit 0
  fi
  sleep 2
done

echo "ERROR: OSRM did not become ready in time. Check: docker logs mapsr-osrm"
exit 1
