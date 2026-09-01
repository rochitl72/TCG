/**
 * pm2 process definition for the TCGA backend.
 *
 * The no-Docker deployment: nginx on the host serves the static assets out of
 * /var/www/html, pm2 keeps gunicorn alive, PostgreSQL+PostGIS is installed
 * natively (scripts/setup_postgres_native.sh) and OSRM is built from source and
 * run by systemd (scripts/setup_osrm_native.sh). Nothing here needs a container.
 *
 * Paths resolve from this file, so the repo can be cloned anywhere:
 *
 *     python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
 *     pm2 start ecosystem.config.js && pm2 save
 *
 * Override any of the env values below by exporting them before `pm2 start`,
 * or by editing this file on the server — pm2 reads it at start time.
 */
const path = require("path");

const ROOT = __dirname;
const VENV = process.env.TCGA_VENV || path.join(ROOT, ".venv");

module.exports = {
  apps: [
    {
      name: "tcga-backend",
      // The venv's gunicorn is a real executable, so pm2 must not try to run it
      // through node. interpreter: "none" is what makes pm2 exec it directly.
      script: path.join(VENV, "bin", "gunicorn"),
      interpreter: "none",
      // --timeout 300 for the same reason the container uses it: a district's
      // first grid/road analysis makes live OSRM calls and can run 1-2 minutes.
      // gunicorn's 30s default would kill the worker mid-request.
      args: "--bind 127.0.0.1:5050 --workers 4 --timeout 300 app:app",
      cwd: path.join(ROOT, "dashboard"),
      env: {
        PYTHONUNBUFFERED: "1",
        FLASK_DEBUG: "0",
        // 5432 is native PostgreSQL's own port (scripts/setup_postgres_native.sh).
        // If you are running Postgres as a container instead, that compose file
        // publishes it on 5433 — export DATABASE_URL before `pm2 start` to
        // override, or edit this line.
        DATABASE_URL:
          process.env.DATABASE_URL ||
          "postgresql://mapsr:mapsr@127.0.0.1:5432/mapsr",
        OSRM_BASE: process.env.OSRM_BASE || "http://127.0.0.1:5000",
        OSRM_SLEEP: process.env.OSRM_SLEEP || "0",
        // Empty unless the edge publishes the API under a prefix, e.g. /bkd.
        API_BASE_PATH: process.env.API_BASE_PATH || "",
      },
      autorestart: true,
      max_restarts: 10,
      // The analytics caches are held in memory per worker; 1 GB is generous
      // headroom and still catches a genuine leak.
      max_memory_restart: "1G",
      out_file: path.join(ROOT, "logs", "backend-out.log"),
      error_file: path.join(ROOT, "logs", "backend-err.log"),
      merge_logs: true,
      time: true,
    },
  ],
};
