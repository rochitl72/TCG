#!/usr/bin/env bash
# Build a Chamba (Himachal Pradesh) OSRM graph and start a local routing
# container on its own port, so it can run alongside the Haryana one.
#
# Unlike setup_osrm.sh (which downloads the India northern-zone extract and
# clips it), this uses a pre-clipped Chamba extract that ships in osrm-data/:
#     osrm-data/chamba.osm.pbf   (~10 MB, Chamba district + margin)
# so you need only the osrm/osrm-backend Docker image you already use — no
# osmium, no 220 MB download.
#
# USAGE
#     bash scripts/setup_osrm_chamba.sh
# then, in another terminal, regenerate the Chamba road-distance artifacts:
#     OSRM_BASE=http://127.0.0.1:5001 \
#       python3 scripts/precompute_network_analytics.py --year 2025 --region himachal_chamba
#
# Re-run this script any time to rebuild from scratch (it is idempotent).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OSRM_DATA="$HERE/osrm-data"
PBF_NAME="chamba.osm.pbf"
PORT="${OSRM_CHAMBA_PORT:-5001}"
IMAGE="${OSRM_IMAGE:-osrm/osrm-backend:latest}"
CONTAINER="osrm-chamba"
READY="$OSRM_DATA/chamba.osrm.mldgr"

if [ ! -f "$OSRM_DATA/$PBF_NAME" ]; then
  echo "ERROR: $OSRM_DATA/$PBF_NAME not found."
  echo "It ships in the repo; restore it (or re-clip the northern zone to the"
  echo "Chamba bbox 75.40,32.00,77.10,33.30) before running this."
  exit 1
fi

echo "==> Stopping any previous $CONTAINER container..."
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# Build the graph (extract -> partition -> customize) with the MLD pipeline,
# the same profile (car.lua) the Haryana graph uses.
if [ ! -f "$READY" ]; then
  echo "==> Removing any stale chamba.osrm.* files..."
  rm -f "$OSRM_DATA"/chamba.osrm* 2>/dev/null || true

  echo "==> osrm-extract (car profile)..."
  docker run --rm -t -v "$OSRM_DATA:/data" "$IMAGE" \
    osrm-extract -p /opt/car.lua "/data/$PBF_NAME"

  echo "==> osrm-partition..."
  docker run --rm -t -v "$OSRM_DATA:/data" "$IMAGE" \
    osrm-partition "/data/chamba.osrm"

  echo "==> osrm-customize..."
  docker run --rm -t -v "$OSRM_DATA:/data" "$IMAGE" \
    osrm-customize "/data/chamba.osrm"
else
  echo "==> Graph already built ($READY); skipping build. Delete chamba.osrm.* to force a rebuild."
fi

echo "==> Starting osrm-routed on port $PORT (MLD algorithm)..."
docker run -d --name "$CONTAINER" -p "$PORT:5000" -v "$OSRM_DATA:/data" "$IMAGE" \
  osrm-routed --algorithm mld "/data/chamba.osrm"

# Wait for the server to answer a trivial route before declaring success.
echo "==> Waiting for OSRM to come up..."
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/route/v1/driving/76.12,32.55;76.13,32.56?overview=false" >/dev/null 2>&1; then
    echo "==> OSRM Chamba is up at http://127.0.0.1:$PORT"
    echo
    echo "Next, in another terminal:"
    echo "    OSRM_BASE=http://127.0.0.1:$PORT \\"
    echo "      python3 scripts/precompute_network_analytics.py --year 2025 --region himachal_chamba"
    echo
    echo "That overwrites data/analytics/grid_hospital_himachal_chamba_2025.json"
    echo "and hospital_grid_himachal_chamba_2025.json with real OSRM road distances"
    echo "(distance_model = osrm_road). Stop the server later with:  docker rm -f $CONTAINER"
    exit 0
  fi
  sleep 1
done

echo "!! OSRM did not answer on port $PORT in time. Check:  docker logs $CONTAINER"
exit 1
