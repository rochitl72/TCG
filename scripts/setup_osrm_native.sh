#!/usr/bin/env bash
# Build osrm-backend FROM SOURCE (no Docker) and produce the Haryana road
# graph, then install a systemd service that runs osrm-routed on 127.0.0.1:5000.
#
# Every dependency and version number below was verified by actually
# compiling this exact commit on a real Ubuntu 24.04 box, not copied from a
# guide — the two community walkthroughs for this (the project's own Ubuntu
# wiki page and a well-known third-party tutorial) both turned out to be
# incomplete or outdated against the current source:
#
#   - libarchive-dev is required and neither guide lists it.
#   - rapidjson-dev, sol2, and flatbuffers are required as CMake CONFIG
#     packages. Ubuntu's flatbuffers apt package (2.0.8) does NOT ship the
#     CMake config the build needs, and sol2 has no Ubuntu package at all —
#     both are built from source and installed below. vtzero is header-only
#     with no Ubuntu package either; it's just copied into place.
#   - The guides say Lua 5.2. Current osrm-backend requires Lua >= 5.4.
#   - CMakeLists.txt sets `cmake_policy(SET CMP0156 NEW)`, a policy CMake only
#     learned in 3.29. Ubuntu 24.04's own cmake (3.28) cannot configure this
#     project at all until a newer cmake is installed — this is what actually
#     blocks a build on stock Ubuntu, not a missing library.
#
#     sudo ./scripts/setup_osrm_native.sh
#
# ~15-30 min on 2 cores, most of it the compile. Safe to re-run: it skips
# whatever step already succeeded, same as the Docker-based setup_osrm.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: run as root (sudo ./scripts/setup_osrm_native.sh)." >&2
  exit 1
fi

# Pinned to the exact commit this script was verified against. Bump it once
# you've confirmed a newer commit still configures and builds the same way —
# osrm-backend has no regular release cadence, so "latest" is not a safe
# default for a script other people run unattended.
OSRM_REF="${OSRM_REF:-ccdf950b38fb02a73caba302173469d82f6f05bc}"
BUILD_DIR="${OSRM_BUILD_DIR:-/opt/osrm-backend}"
INSTALL_PREFIX="${OSRM_INSTALL_PREFIX:-/usr/local}"

OSRM_DATA="${OSRM_DATA_DIR:-$ROOT/osrm-data}"
ZONE_PBF="$OSRM_DATA/northern-zone-latest.osm.pbf"
PBF_NAME="haryana.osm.pbf"
PBF="$OSRM_DATA/$PBF_NAME"
OSRM_READY="$OSRM_DATA/haryana.osrm.mldgr"
MARKER="$OSRM_DATA/.built"
ZONE_URL="${OSRM_ZONE_URL:-https://download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf}"
HARYANA_BBOX="${OSRM_HARYANA_BBOX:-74.45,27.65,77.65,30.90}"
OSRM_IP="${OSRM_IP:-127.0.0.1}"
OSRM_PORT="${OSRM_PORT:-5000}"

mkdir -p "$OSRM_DATA"

echo "==> Installing build dependencies..."
apt-get update -qq
apt-get install -y \
  build-essential git cmake pkg-config gcc g++ \
  libbz2-dev libstxxl-dev libxml2-dev libzip-dev libarchive-dev \
  libboost-all-dev liblua5.4-dev lua5.4 libtbb-dev \
  rapidjson-dev libprotozero-dev libosmium2-dev \
  osmium-tool curl

# Ubuntu's cmake (3.28 on 24.04, older on 22.04) cannot configure this project
# at all — cmake_policy(SET CMP0156 NEW) needs a policy CMake only learned in
# 3.29. Installing a newer cmake from PyPI is faster and more reliable here
# than adding Kitware's apt repo, and it coexists fine with the distro's own
# cmake package.
NEED_CMAKE=1
if command -v cmake >/dev/null 2>&1; then
  CMAKE_VER="$(cmake --version | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
  CMAKE_MAJOR="${CMAKE_VER%%.*}"
  CMAKE_MINOR="$(echo "$CMAKE_VER" | cut -d. -f2)"
  if [[ "$CMAKE_MAJOR" -gt 3 || ( "$CMAKE_MAJOR" -eq 3 && "$CMAKE_MINOR" -ge 29 ) ]]; then
    NEED_CMAKE=0
  fi
fi
if [[ "$NEED_CMAKE" == "1" ]]; then
  echo "==> System cmake is too old for this build (needs >= 3.29) — installing a newer one via pip..."
  apt-get install -y python3-pip
  pip install --break-system-packages -q --upgrade "cmake>=3.29"
  hash -r
fi
echo "    Using: $(command -v cmake) ($(cmake --version | head -1))"

# --- sol2 (Lua/C++ binding): no Ubuntu package; header-only, quick to build ---
if [[ ! -f "$INSTALL_PREFIX/lib/cmake/sol2/sol2-config.cmake" ]]; then
  echo "==> Building sol2 (not packaged for Ubuntu)..."
  rm -rf /tmp/sol2-build && git clone --depth 1 --branch v3.3.0 https://github.com/ThePhD/sol2.git /tmp/sol2-build
  cmake -S /tmp/sol2-build -B /tmp/sol2-build/build -DSOL2_TESTS=OFF -DSOL2_EXAMPLES=OFF \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_PREFIX"
  cmake --install /tmp/sol2-build/build
  rm -rf /tmp/sol2-build
fi

# --- flatbuffers: Ubuntu's package (2.0.8) has no CMake config; build from source ---
if [[ ! -f "$INSTALL_PREFIX/lib/cmake/flatbuffers/flatbuffers-config.cmake" ]]; then
  echo "==> Building flatbuffers (Ubuntu's package lacks the CMake config this needs)..."
  apt-get remove -y libflatbuffers-dev flatbuffers-compiler-dev 2>/dev/null || true
  rm -rf /tmp/flatbuffers-build
  git clone --depth 1 --branch v24.3.25 https://github.com/google/flatbuffers.git /tmp/flatbuffers-build
  cmake -S /tmp/flatbuffers-build -B /tmp/flatbuffers-build/build \
    -DCMAKE_BUILD_TYPE=Release -DFLATBUFFERS_BUILD_TESTS=OFF \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_PREFIX"
  cmake --build /tmp/flatbuffers-build/build -j"$(nproc)"
  cmake --install /tmp/flatbuffers-build/build
  rm -rf /tmp/flatbuffers-build
fi

# --- vtzero: header-only, no Ubuntu package at all ---
if [[ ! -f "$INSTALL_PREFIX/include/vtzero/vector_tile.hpp" ]]; then
  echo "==> Vendoring vtzero (no Ubuntu package)..."
  rm -rf /tmp/vtzero-src
  git clone --depth 1 https://github.com/mapbox/vtzero.git /tmp/vtzero-src
  cp -r /tmp/vtzero-src/include/vtzero "$INSTALL_PREFIX/include/"
  rm -rf /tmp/vtzero-src
fi

echo "==> Fetching osrm-backend @ $OSRM_REF..."
if [[ ! -d "$BUILD_DIR/.git" ]]; then
  git clone https://github.com/Project-OSRM/osrm-backend.git "$BUILD_DIR"
fi
git -C "$BUILD_DIR" fetch --depth 1 origin "$OSRM_REF"
git -C "$BUILD_DIR" checkout --quiet "$OSRM_REF"

BIN_READY="$INSTALL_PREFIX/bin/osrm-routed"
if [[ ! -x "$BIN_READY" ]] || [[ "$(cat "$BUILD_DIR/.built-ref" 2>/dev/null)" != "$OSRM_REF" ]]; then
  echo "==> Configuring and building osrm-backend (this is the ~15-30 min step)..."
  cmake -S "$BUILD_DIR" -B "$BUILD_DIR/build" -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_PREFIX"
  cmake --build "$BUILD_DIR/build" -j"$(nproc)"
  cmake --install "$BUILD_DIR/build"
  echo "$OSRM_REF" > "$BUILD_DIR/.built-ref"
else
  echo "==> osrm-backend binaries already built for this commit (skipping rebuild)."
fi
ldconfig

CAR_LUA="$BUILD_DIR/profiles/car.lua"
if [[ ! -f "$CAR_LUA" ]]; then
  echo "ERROR: $CAR_LUA not found — the source checkout is incomplete." >&2
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
  osmium extract -b "$HARYANA_BBOX" -o "$PBF" --overwrite "$ZONE_PBF"
  rm -f "$MARKER"
fi

if [[ ! -f "$MARKER" || ! -f "$OSRM_READY" ]]; then
  echo "==> Building OSRM road graph (needs a few GB of free RAM)..."
  rm -f "$MARKER"
  rm -f "$OSRM_DATA"/haryana.osrm* 2>/dev/null || true
  if ! "$INSTALL_PREFIX/bin/osrm-extract" -p "$CAR_LUA" -t "$(nproc)" "$PBF"; then
    echo "ERROR: osrm-extract failed. If it died partway through, this host is likely low on RAM." >&2
    rm -f "$MARKER"
    exit 1
  fi
  # osrm-extract writes its output next to the input PBF, not into $OSRM_DATA
  # if they differ — they're the same directory here, so no move is needed.
  "$INSTALL_PREFIX/bin/osrm-partition" "$OSRM_DATA/haryana.osrm"
  "$INSTALL_PREFIX/bin/osrm-customize" "$OSRM_DATA/haryana.osrm"
  touch "$MARKER"
  echo "==> OSRM graph built."
else
  echo "==> OSRM graph already built (skipping rebuild)."
fi

echo "==> Installing the osrm-routed systemd service..."
id -u osrm >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin osrm
chown -R osrm:osrm "$OSRM_DATA"

sed -e "s#{{OSRM_DATA}}#$OSRM_DATA#g" \
    -e "s#{{OSRM_IP}}#$OSRM_IP#g" \
    -e "s#{{OSRM_PORT}}#$OSRM_PORT#g" \
    -e "s#{{OSRM_BIN}}#$INSTALL_PREFIX/bin#g" \
    "$ROOT/scripts/systemd/osrm-routed.service.template" > /etc/systemd/system/osrm-routed.service

systemctl daemon-reload
systemctl enable --now osrm-routed

echo "==> Waiting for OSRM to answer..."
for _ in $(seq 1 40); do
  if curl -sf "http://$OSRM_IP:$OSRM_PORT/route/v1/driving/76.78,29.95;76.79,29.96?overview=false" \
      | grep -q '"code":"Ok"'; then
    echo "==> OSRM is up at $OSRM_IP:$OSRM_PORT."
    exit 0
  fi
  sleep 3
done
echo "ERROR: OSRM did not answer in time. Check: systemctl status osrm-routed && journalctl -u osrm-routed -e" >&2
exit 1
