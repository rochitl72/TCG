#!/usr/bin/env bash
# Install PostgreSQL 16 + PostGIS natively (no Docker) and create the mapsr
# role/database, matching what the postgis/postgis Docker image does at
# container init.
#
# Verified end-to-end on a real Ubuntu 24.04 box before this was written: the
# PGDG quickstart script, the exact package names, and the one real gap
# between "docker" and "native" here — CREATE EXTENSION postgis fails with
# "permission denied... must be superuser" when the app's own role tries it,
# because in the Docker image POSTGRES_USER=mapsr IS the bootstrap superuser,
# and a natively-created LOGIN role is not. Fixed below by creating the
# extension once as the postgres superuser; CREATE EXTENSION IF NOT EXISTS
# postgis, which scripts/setup_database.sh runs next as mapsr, then succeeds
# (verified: it just prints a NOTICE and no-ops once the extension exists).
#
#     sudo ./scripts/setup_postgres_native.sh
#
# Safe to re-run — every step below is idempotent.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: run as root (sudo ./scripts/setup_postgres_native.sh)." >&2
  exit 1
fi

PG_VERSION="${PG_VERSION:-16}"
DB_NAME="${DB_NAME:-mapsr}"
DB_USER="${DB_USER:-mapsr}"
DB_PASSWORD="${DB_PASSWORD:-mapsr}"

echo "==> Adding the official PostgreSQL apt repository (PGDG)..."
# Ubuntu's own repos ship Postgres 14 (22.04) or 16 (24.04, but without a
# guaranteed matching postgis build) — PGDG is what supplies PostgreSQL 16
# with a matched postgis package on either release. Already-present is a
# silent success; this is the documented quickstart from postgresql.org.
apt-get install -y postgresql-common ca-certificates
if [[ ! -f /etc/apt/sources.list.d/pgdg.sources && ! -f /etc/apt/sources.list.d/pgdg.list ]]; then
  /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
fi
apt-get update -qq

echo "==> Installing PostgreSQL $PG_VERSION and PostGIS..."
apt-get install -y \
  "postgresql-$PG_VERSION" \
  "postgresql-$PG_VERSION-postgis-3" \
  postgresql-contrib

echo "==> Starting PostgreSQL..."
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q postgresql; then
  systemctl enable --now "postgresql@${PG_VERSION}-main" 2>/dev/null || systemctl enable --now postgresql
else
  # No systemd on this host (e.g. a minimal container) — pg_ctlcluster is the
  # same mechanism `service postgresql start` calls under the hood.
  pg_ctlcluster "$PG_VERSION" main start 2>/dev/null || true
fi
for _ in $(seq 1 15); do
  pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 && break
  sleep 1
done
pg_isready -h 127.0.0.1 -p 5432

# The default pg_hba.conf shipped by these packages already has
#     host  all  all  127.0.0.1/32  scram-sha-256
# i.e. password auth over TCP to localhost is already enabled for every role
# — confirmed by reading it, not assumed. Nothing to edit there.

echo "==> Creating role and database (skips cleanly if they already exist)..."
sudo -u postgres psql -v ON_ERROR_STOP=1 -tAc \
  "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 || \
  sudo -u postgres psql -v ON_ERROR_STOP=1 \
    -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';"

sudo -u postgres psql -v ON_ERROR_STOP=1 -tAc \
  "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || \
  sudo -u postgres psql -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

echo "==> Enabling PostGIS (as superuser — ${DB_USER} does not have CREATE EXTENSION rights, by design)..."
sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS postgis;"

echo "==> Verifying the exact connection scripts/setup_database.sh and the app will use..."
PGPASSWORD="$DB_PASSWORD" psql -v ON_ERROR_STOP=1 \
  "postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}" \
  -c "SELECT postgis_version();"

echo ""
echo "==> PostgreSQL + PostGIS ready at 127.0.0.1:5432."
echo "    DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}"
echo "    Next: DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME} ./scripts/setup_database.sh"
