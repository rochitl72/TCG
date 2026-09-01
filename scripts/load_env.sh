# shellcheck shell=bash
#
# Single source of truth for the database connection, shared by every script
# and by ecosystem.config.js. Sourced, not executed.
#
# Precedence, highest first:
#   1. A variable already exported in the environment (one-off overrides:
#        DB_PASSWORD=... ./scripts/setup_postgres_native.sh)
#   2. The repo-root .env file
#   3. The built-in defaults each caller passes
#
# An explicit DATABASE_URL always wins over the DB_* parts — that is the escape
# hatch for pointing at an existing organisation database whose connection
# string does not decompose neatly.
#
# NOTE on .env values: this sources the file as shell, so a password containing
# $ ` \ or " needs single quotes around it in .env. Characters that are special
# in a URL (@ : / ? # space) are handled for you — the assembled DATABASE_URL
# percent-encodes the user and password.

tcga_load_env() {
  local root="${1:?tcga_load_env needs the repo root}"
  local envfile="$root/.env"

  # Snapshot anything the caller already exported, because sourcing .env below
  # would otherwise clobber it and invert the documented precedence.
  local pre_name="${DB_NAME:-}" pre_user="${DB_USER:-}" pre_pass="${DB_PASSWORD:-}"
  local pre_host="${DB_HOST:-}" pre_port="${DB_PORT:-}" pre_url="${DATABASE_URL:-}"

  if [[ -f "$envfile" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$envfile"
    set +a
  fi

  [[ -n "$pre_name" ]] && DB_NAME="$pre_name"
  [[ -n "$pre_user" ]] && DB_USER="$pre_user"
  [[ -n "$pre_pass" ]] && DB_PASSWORD="$pre_pass"
  [[ -n "$pre_host" ]] && DB_HOST="$pre_host"
  [[ -n "$pre_port" ]] && DB_PORT="$pre_port"
  [[ -n "$pre_url" ]]  && DATABASE_URL="$pre_url"

  DB_NAME="${DB_NAME:-mapsr}"
  DB_USER="${DB_USER:-mapsr}"
  DB_PASSWORD="${DB_PASSWORD:-mapsr}"
  DB_HOST="${DB_HOST:-127.0.0.1}"
  DB_PORT="${DB_PORT:-${TCGA_DEFAULT_DB_PORT:-5432}}"
  export DB_NAME DB_USER DB_PASSWORD DB_HOST DB_PORT

  # Percent-encode the credentials before they go into a URL. A password
  # containing @ : / ? # or a space is otherwise silently misparsed —
  # "p@ss word" would truncate the host and fail with a confusing error.
  if [[ -z "${DATABASE_URL:-}" ]]; then
    local enc_user enc_pass
    enc_user="$(printf '%s' "$DB_USER" | python3 -c 'import sys,urllib.parse; sys.stdout.write(urllib.parse.quote(sys.stdin.read(), safe=""))')"
    enc_pass="$(printf '%s' "$DB_PASSWORD" | python3 -c 'import sys,urllib.parse; sys.stdout.write(urllib.parse.quote(sys.stdin.read(), safe=""))')"
    DATABASE_URL="postgresql://${enc_user}:${enc_pass}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
  fi
  export DATABASE_URL
}
