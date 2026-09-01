#!/usr/bin/env bash
# Publish the browser-side assets to the directory the host nginx serves.
#
# Only needed for the deployment where nginx on the host serves /static/ itself
# instead of a frontend container doing it. Re-run after every pull that touches
# dashboard/static/ — nginx serves whatever is on disk, so a stale copy here is
# a stale page for every visitor.
#
#     sudo ./scripts/deploy_static.sh                  # -> /var/www/html/static
#     STATIC_ROOT=/srv/tcga sudo ./scripts/deploy_static.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/dashboard/static"
DEST="${STATIC_ROOT:-/var/www/html}/static"

if [[ ! -d "$SRC" ]]; then
  echo "ERROR: $SRC not found — run this from a full clone." >&2
  exit 1
fi

mkdir -p "$DEST"
# --delete so a file removed from the repo stops being served. Nothing else is
# expected to live under $DEST/static, so this deletes only our own leftovers.
rsync -a --delete "$SRC/" "$DEST/"

# nginx runs unprivileged and only ever reads these.
chmod -R a+rX "$DEST"

echo "==> Published $(find "$DEST" -type f | wc -l | tr -d ' ') files to $DEST"
