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
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const VENV = process.env.TCGA_VENV || path.join(ROOT, ".venv");

/**
 * Read the repo-root .env — the same file scripts/load_env.sh and
 * docker-compose.yml read, so the database connection is configured in exactly
 * one place. pm2 does not do this on its own.
 *
 * Deliberately hand-rolled rather than pulling in dotenv: this file has to work
 * on a fresh server before any npm install has happened.
 */
function readEnvFile() {
  const out = {};
  const file = path.join(ROOT, ".env");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out; // No .env is fine — the defaults below apply.
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes, the way a shell would.
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = readEnvFile();

// Precedence matches scripts/load_env.sh: real environment, then .env, then
// the default. An explicit DATABASE_URL beats the assembled DB_* parts, which
// is the escape hatch for an existing database whose URL does not decompose.
const cfg = (key, fallback) => process.env[key] || fileEnv[key] || fallback;

const DB_USER = cfg("DB_USER", "mapsr");
const DB_PASSWORD = cfg("DB_PASSWORD", "mapsr");
const DB_HOST = cfg("DB_HOST", "127.0.0.1");
const DB_PORT = cfg("DB_PORT", "5432");
const DB_NAME = cfg("DB_NAME", "mapsr");

// encodeURIComponent for the same reason scripts/load_env.sh does it: a
// password containing @ : / ? # or a space would otherwise produce a URL that
// parses to the wrong host and fails confusingly.
const DATABASE_URL = cfg(
  "DATABASE_URL",
  `postgresql://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}` +
    `@${DB_HOST}:${DB_PORT}/${DB_NAME}`
);

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
        DATABASE_URL,
        OSRM_BASE: cfg("OSRM_BASE", "http://127.0.0.1:5000"),
        OSRM_SLEEP: cfg("OSRM_SLEEP", "0"),
        // Empty unless the edge publishes the API under a prefix, e.g. /bkd.
        API_BASE_PATH: cfg("API_BASE_PATH", ""),
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
