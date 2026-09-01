# TCGA — Trauma Care Gap Analysis

A Flask + PostGIS + Leaflet analytics platform for Haryana road-safety data: it
cross-references accident locations against real hospital, ambulance, and
blood bank locations using actual road-route distance (not straight-line), so
you can see where trauma care coverage genuinely has gaps.

Live deployment target: **tcg.coers.in**

## Views

- **Boundaries & Facilities** — state/district boundaries, Haryana facility
  layers (ambulances, blood banks, hospitals), and the 10 km radar grid (hex,
  circle, or road-network cells).
- **Accident · Hospital Reach / Ambulance Reach / Blood Bank Reach** — every
  accident plotted with a green/red status ring based on real OSRM road-route
  distance to the nearest facility, against a threshold you can drag, scroll,
  or type to change instantly (no recompute needed — distances are
  precomputed as a candidate list per accident up to 75 km).
- **Severity Heatmap** — density of accidents, optionally weighted by
  severity, with an adjustable heat spread.
- **District Scorecard** — choropleth of accident/hospital-reach metrics per
  district, with the exact formula for each metric shown in the UI.
- **Grid Analysis** — the same road-route reach analysis applied to 10 km
  grid cells (hex or circle) for a selected district, not just accident
  points — lets you see coverage gaps across an entire area, not only where
  an accident happened to occur.
- **Trauma Network Analytics** — three analytics deliverables behind one
  sidebar entry: (1) every 2025 grid cell with the hospitals within 60 km,
  including type, GPS and TPL (Trauma Preparedness Level) score; (2) coverage
  gaps and underserved corridors per service tier (Tertiary/Secondary/Primary),
  by drive time or road distance; (3) dynamic ambulance repositioning, showing
  which vehicles to move and what gaps remain. See **README_ANALYTICS.md**.
- **Distance scale** (available on every map) — click two points to measure
  straight-line and real road-route distance/drive time.

All accident data shown by default is **synthetic**, generated to match a
real-world schema. A team lead or admin can upload a replacement CSV with the
same columns from the Boundaries & Facilities page; every view recomputes
against whichever dataset is active.

## Architecture

Single Flask app serves both the API and the server-rendered frontend
(Jinja2 templates + vanilla JS + Leaflet) — there's no separate SPA build, so
the frontend never needs its own "API base URL" config; all JS calls are
relative paths (`/api/...`) and work at any hostname automatically.

```
Browser
  │
  ▼
nginx (frontend container, :80)  — reverse proxy, tcg.coers.in
  │
  ▼
Flask + gunicorn (backend container, :5050)
  │
  ▼
PostGIS (db container, :5433 host-mapped)
```

Road-route distances (reach analyses, the district scorecard, grid analysis,
and the distance-measure tool) use **self-hosted OSRM** against an India
**northern-zone** OpenStreetMap extract (covers Haryana and neighbouring states).
~35k accident dataset. `./start.sh` builds and starts it automatically via
`scripts/setup_osrm.sh` (first run downloads ~210 MB and builds the graph in
~10–20 minutes). The public demo server (`router.project-osrm.org`) is only
used as a fallback if `OSRM_BASE` is not set.

- Distances/times are free-flow estimates from a static OSM snapshot — no
  live traffic.

The "Road 10 km" grid type additionally uses **osmnx** (which pulls road
network data from OpenStreetMap's Overpass API) to build grid cells along
actual roads, per district, on first request.

## Repository layout

```
dashboard/              Flask app
  app.py                Routes (pages + JSON API)
  db.py                 All PostGIS queries
  districts.py          District name normalisation (one spelling, everywhere)
  network_analytics.py  Grid-hospital proximity, tier coverage gaps, corridors
  grid_ambulance.py     Ambulance reach per grid cell (Old dataset, 569 vehicles)
  ambulance_v2.py       Ambulance reach for the New workbook dataset (sightings)
  ambulance_optimizer.py  Dynamic ambulance positioning (greedy MCLP)
  grid_routes.py        Cached OSRM route geometry for grid -> facility branches
  rbg_grids.py          Accident grid cells fetched from the partner API
  rbg_live.py           Live facility lookups against the same API
  tpl.py                Trauma Preparedness Level lookup + provenance
  reach_pipeline.py     Accident-level OSRM reach (legacy; see note in step 4)
  road_grid_generator.py  OSM road-network grid cells (osmnx)
  dataset_manager.py    Active accidents CSV (default vs. uploaded)
  templates/            network_analytics.html + partials (_rail, _app_header,
                         _measure_panel) — the app is one page with three tabs
  static/{css,js}/      network_analytics.js is the whole client; charts.js,
                         radar_overlay.js and map_measure.js support it
  Dockerfile            Backend image (gunicorn)
frontend/Dockerfile     Frontend image (nginx + baked-in config and assets)
nginx/nginx.conf        Reverse proxy config, copied into the frontend image
nginx/tcga-host.conf    Host nginx site for the pm2 deployment (no frontend
                         container; assets served from /var/www/html)
ecosystem.config.js     pm2 definition for running gunicorn on the host
data/                   Seed data + precomputed reach JSON (see .gitignore for
                         what is excluded and why)
  analytics/            The five precomputed reach caches the app reads on boot
latest data/            Canonical facility + accident dumps (read-only mount)
scripts/                One-time setup, precompute and data-build scripts
docker-compose.yml      Production stack: db + backend + frontend + osrm
docker-compose.dev.yml  Local dev: PostGIS + OSRM (start.sh runs Flask on host)
osrm-data/              OSM extract + compiled OSRM graph (gitignored, built
                         per machine by scripts/setup_osrm.sh)
```

A few files are intentionally **not** in this repo (see `.gitignore` for the
full list with reasoning): an orphaned local-cache code path from an earlier
implementation (`grid_generator.py` and its output), superseded pre-v2
precompute files, and the output of a "3D readiness" view that was removed
from the app. None of this affects the live app; it's just not shipped in
the organized repo.

The two large one-time boundary SQL dumps (`district.sql` ~172MB, `state
1.sql` ~45MB) **are** in the repo, tracked via **Git LFS** (see
`.gitattributes`) since a plain git blob over ~100MB gets hard-rejected by
GitHub. That means:

- `git-lfs` needs to be installed wherever you `clone`, `push`, or `pull`
  this repo — `brew install git-lfs` (macOS) or `apt-get install git-lfs`
  (Debian/Ubuntu), then run `git lfs install` once per machine.
- A normal `git clone` will fetch the LFS content automatically once
  git-lfs is installed — no separate step needed.
- They're still excluded from the **Docker build context** (`.dockerignore`)
  and the container image itself, since they're only needed once, for the
  host-side DB bootstrap in step 4 below — not by the running app.

## Local development

```bash
cp .env.example .env   # optional — start.sh has the same default baked in
./start.sh
```

This brings up PostGIS + self-hosted OSRM via `docker-compose.dev.yml`, runs
the one-time DB bootstrap (`scripts/setup_database.sh` — needs `district.sql`,
`state 1.sql`, and `latest data/` with geolocations + accidents), kicks off
reach/scorecard recompute in the background for large datasets, then runs the
Flask dev server at `http://127.0.0.1:5050`.

Monitor recompute progress:

```bash
tail -f data/recompute.log
```

## Deploying to a server

The production stack is four containers, all defined in `docker-compose.yml`:
`frontend` (nginx on port 80 — serves static assets, proxies everything else),
`backend` (this Flask app under gunicorn on 5050), `db` (PostGIS on 5433 — the
port stays published so the one-time data load can reach it from the host), and
`osrm` (self-hosted routing, reachable only inside the compose network). A fifth
service, `artifacts`, sits behind the `tools` profile and never starts on its own.

Both images are self-contained: `dashboard/Dockerfile` builds the backend and
`frontend/Dockerfile` bakes `nginx/nginx.conf` and `dashboard/static/` into the
nginx image, so neither one depends on files being present on the host at run
time. (Editing CSS/JS therefore needs a `docker compose build frontend` to show
up in the production stack; the dev stack runs Flask directly and is unaffected.)

1. **Install the host prerequisites.** Docker Engine and the Compose plugin, plus
   the three tools the one-time bootstrap scripts shell out to. `git-lfs` must be
   installed *before* cloning — `district.sql` and `state 1.sql` are LFS objects
   and a clone without it fetches pointer files instead of data.
   ```bash
   sudo apt-get update
   sudo apt-get install -y git git-lfs postgresql-client python3
   git lfs install
   ```

2. **Get the code onto the server.**
   ```bash
   git clone https://github.com/rochitl72/TCG.git
   cd TCG
   ```
   (Already cloned without git-lfs? Install it, then `git lfs pull`.)

3. **Declare the server's architecture.**
   ```bash
   printf 'OSRM_PLATFORM=linux/amd64\n' > .env
   ```
   The OSRM image defaults to `linux/arm64` because the development machines are
   Apple Silicon. On an x86 server, skipping this means the routing container
   runs under emulation, loads its 1.9 GB graph several times slower and never
   passes its healthcheck. Both `docker-compose.yml` and `scripts/setup_osrm.sh`
   read this one variable, so it only needs saying once.

4. **Build the road graph and load the database (one-time).**
   ```bash
   chmod +x scripts/setup_osrm.sh scripts/setup_database.sh

   # downloads a ~210 MB OSM extract, clips it to Haryana, compiles the graph
   ./scripts/setup_osrm.sh

   docker compose up -d db
   DATABASE_URL=postgresql://mapsr:mapsr@localhost:5433/mapsr ./scripts/setup_database.sh
   ```
   The graph build wants ~8 GB of free RAM and takes 10–20 minutes; `osrm-data/`
   is deliberately not in the repository because it is machine-specific build
   output. Both scripts are idempotent — safe to re-run, they skip work already
   done.

   `setup_database.sh` no longer auto-launches the accident-reach recompute. That
   artifact fed pages which no longer exist, and regenerating it costs one OSRM
   request per accident across ~35k rows. If you genuinely need it back:
   `TCGA_RECOMPUTE_REACH=1 ./scripts/setup_database.sh`.

5. **Build the images and bring the stack up.** This is also the only step that
   repeats on future deploys.
   ```bash
   docker compose build
   docker compose up -d
   ```

6. **Point DNS** at the server's IP with an A record. No nginx edit is needed —
   `server_name _` accepts any `Host`, so the same container works on a bare IP,
   a hostname or behind a load balancer.

7. **(Recommended) put TLS in front of it.** The frontend container serves plain
   HTTP on 80. Either terminate TLS at a reverse proxy / load balancer that
   forwards to this host's port 80, or swap the nginx container for one running
   certbot. The app already trusts `X-Forwarded-Proto` / `X-Forwarded-Host` (see
   `ProxyFix` in `dashboard/app.py`), so it reports the correct scheme and host
   once that is in place.

No API base URL needs changing anywhere in the frontend JS — every request
already uses a relative path (`/api/...`), so the same code works on any domain
with zero edits. What *did* need changing for hosting behind a domain: the app
trusts proxy headers (`ProxyFix`), gunicorn/nginx timeouts are raised to match
the app's genuinely slow first-load operations (grid/road analyses can take up
to ~1-2 minutes per district), and debug mode is off by default in the container
(`FLASK_DEBUG=0`) — the Flask dev server is never used in production; gunicorn is.

## Hosting the pieces separately

**What the two halves actually are.** `frontend` is nginx: it serves
`dashboard/static/` out of its own image and proxies everything else. It is not
a standalone SPA — there is no static `index.html` and no client-side router.
The page itself is a Jinja template rendered by Flask, so a request for `/` has
to reach the backend either way. Splitting the two is therefore a proxy
question, not an application rewrite: whatever sits in front routes some paths
to nginx and some to gunicorn.

### One domain, routed by path

The arrangement `tcg.coers.in/` for the app and `tcg.coers.in/bkd/...` for the
API needs two settings, and both already exist:

1. `API_BASE_PATH=/bkd` in `.env`. Flask passes it to the page, and the page
   prefixes its own API calls — every request becomes `/bkd/api/...`.
2. `location /bkd/` in `nginx/nginx.conf`. The trailing slash on its
   `proxy_pass` strips the prefix again, so Flask still receives
   `/api/analytics/coverage` and no route in `app.py` changes.

Because both halves answer on the same origin, there is nothing to configure
for CORS. If the organisation's own ingress does the `/bkd` routing instead of
this nginx, point it at the backend's `:5050` and have it strip the prefix the
same way; the app does not care which layer does it.

### Backend on its own machine

Change one line — the `upstream tcga_backend` block at the top of
`nginx/nginx.conf` — to that machine's address, and rebuild the frontend image.
Everything below it proxies through that name. The backend still needs to reach
PostGIS and OSRM from wherever it runs, and its `:5050` should not be open to
the public internet; the frontend is the only thing that needs to reach it.

Giving the backend a hostname of its own (`api.example.com`) works too, but then
the browser is making cross-origin requests and Flask needs CORS headers, which
it does not send today. Path routing under one domain avoids that entirely,
which is why it is the recommended shape.

### If the VM already serves the domain with its own nginx

This is the common case on an organisation server, and it needs two changes —
one of which is a hard failure if missed.

**Move the frontend off port 80.** The host's nginx already owns it, so
`docker compose up` fails to bind. Publish the container somewhere else and let
the host nginx forward to it:

```bash
echo 'FRONTEND_PUBLISH=127.0.0.1:8080' >> .env
```

Loopback rather than `0.0.0.0:8080` on purpose — it keeps the stack reachable
only through the domain, instead of also answering on `<public-ip>:8080` and
bypassing whatever the host nginx enforces.

**Give the host nginx the app's timeouts.** Its defaults are wrong for this
workload in two specific ways, and both look like application bugs when they
bite:

```nginx
server {
    listen 443 ssl;
    server_name tcg.coers.in;
    # ssl_certificate / ssl_certificate_key as usual

    # Accident CSV uploads exceed nginx's 1 MB default.
    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # First load of a district can genuinely take 1-2 minutes. nginx's 60s
        # default returns 504 on a request that is working perfectly.
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Nothing else changes. The frontend container still serves the static assets and
still proxies the rest to gunicorn over the compose network — it does not care
that a second nginx sits in front of it. `X-Forwarded-Proto` is passed through
rather than overwritten (see the `map` at the top of `nginx/nginx.conf`), so
Flask sees `https` even though the inner hop is plain HTTP.

Leave `API_BASE_PATH` empty in this arrangement. The `/bkd` prefix is only
needed if the edge routes API traffic separately from page traffic; when
everything funnels through one `location /`, the default `/api/...` is correct.

### How OSRM fits

OSRM is an HTTP API — `osrm-routed` serving `/route/v1/driving/...` and
`/table/v1/driving/...` — but it is **called only by Python on the server**.
Nothing in the browser talks to it: the measure tool posts to
`/api/measure/route` and Flask makes the OSRM call. So OSRM never needs a
domain, a TLS certificate or a public route.

| Where OSRM runs | What to set |
|---|---|
| Same compose stack (default) | `OSRM_BASE=http://osrm:5000` — already the case |
| Its own machine | `OSRM_BASE=http://10.0.3.20:5000` over the private network |
| Behind the domain (only if policy demands it) | `OSRM_BASE=https://tcg.coers.in/osrm`, with an nginx `location /osrm/` restricted by IP allowlist to the backend |

Publishing OSRM openly is a bad idea and worth resisting: it has no
authentication and no rate limiting, and `--max-table-size 8000` means a single
`/table` request can occupy a core for seconds. Anyone who finds the URL can
flatten the server.

One practical constraint if OSRM moves to its own host: it memory-maps a ~1.9 GB
graph from local disk, so that machine needs its own `osrm-data/` built by
`scripts/setup_osrm.sh`. It is not something to serve off a network mount.

## Running the backend under pm2 (no app containers)

An alternative to the all-Docker stack: nginx on the host serves the static
assets from `/var/www/html`, pm2 keeps gunicorn alive, and only PostGIS and OSRM
stay as containers. OSRM has no practical non-Docker install, and running
PostGIS as a container avoids matching PostGIS extension versions against
whatever Postgres the distro ships.

**One thing to be clear about before starting.** `/var/www/html` holds the CSS
and JS *only*. The page itself is a Jinja template rendered by Flask — there is
no `index.html` to drop in, and nginx must still proxy `/` to gunicorn. What
moves to disk is the asset serving, which is worth doing on its own: this page
pulls a dozen assets per load, and each one served by Flask occupies one of only
four gunicorn workers for the round trip.

```bash
# 1. Prerequisites (pm2 needs node; Docker is still needed for db + osrm)
sudo apt-get update
sudo apt-get install -y git git-lfs postgresql-client python3 python3-venv rsync nginx nodejs npm
sudo npm install -g pm2
git lfs install

# 2. Clone
sudo mkdir -p /opt && cd /opt
sudo git clone https://github.com/rochitl72/TCG.git tcga
sudo chown -R "$USER:$USER" /opt/tcga
cd /opt/tcga
printf 'OSRM_PLATFORM=linux/amd64\n' > .env

# 3. Infrastructure containers, one-time data load
chmod +x scripts/setup_osrm.sh scripts/setup_database.sh scripts/deploy_static.sh
./scripts/setup_osrm.sh                          # ~10-20 min, wants ~8 GB free RAM
docker compose -f docker-compose.dev.yml down    # the builder leaves an OSRM running on :5000
docker compose up -d db osrm                     # NOTE: named services only — see below
DATABASE_URL=postgresql://mapsr:mapsr@127.0.0.1:5433/mapsr ./scripts/setup_database.sh

# 4. Python environment
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

# 5. Backend under pm2
mkdir -p logs
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # run the command it prints, once, so pm2 survives a reboot

# 6. Static assets to /var/www/html
sudo ./scripts/deploy_static.sh

# 7. nginx
sudo cp nginx/tcga-host.conf /etc/nginx/sites-available/tcga
sudo ln -sf /etc/nginx/sites-available/tcga /etc/nginx/sites-enabled/tcga
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d tcg.coers.in            # optional but recommended
```

**Do not run a bare `docker compose up -d` on this server.** With no service
names it starts `backend` and `frontend` as well, and you end up with two
copies of the app — a containerised one and the pm2 one — fighting over the
same database. Always name the two you want: `docker compose up -d db osrm`.

Check what came up:

```bash
pm2 status
curl -sI http://127.0.0.1:5050/network-analytics | head -3
ss -tlnp | grep -E '5050|5433|5000'   # all three should be 127.0.0.1, not 0.0.0.0
```

### Updating this deployment

```bash
cd /opt/tcga
git pull
.venv/bin/pip install -r requirements.txt   # only if requirements.txt changed
sudo ./scripts/deploy_static.sh             # only if dashboard/static/ changed
pm2 restart tcga-backend
```

`deploy_static.sh` is easy to forget and fails quietly-ish: nginx keeps serving
the old assets, so the page loads but behaves like the previous release. The
`try_files $uri @backend` fallback in the site config covers a *missing* file by
asking Flask for it, but it cannot help with a *stale* one.

## Environment variables

| Variable | Used by | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | `db.py`, `reach_pipeline.py`, `road_grid_generator.py` | `postgresql://mapsr:mapsr@localhost:5433/mapsr` | Set to `postgresql://mapsr:mapsr@db:5432/mapsr` inside docker-compose (container-to-container hostname) |
| `OSRM_BASE` | `grid_ambulance.py`, `ambulance_v2.py`, the precompute scripts, measure API | `http://127.0.0.1:5000` when using `./start.sh` | Set to `http://osrm:5000` in the production backend container |
| `OSRM_SLEEP` | `reach_pipeline.py`, the precompute scripts | `0` with self-hosted OSRM | Seconds between OSRM requests during precompute; use `0.1` only for the public demo server |
| `OSRM_PLATFORM` | `docker-compose.yml`, `docker-compose.dev.yml`, `scripts/setup_osrm.sh` | `linux/arm64` | **Set to `linux/amd64` on an Intel/AMD server.** One variable drives both the graph build and the running container |
| `TCGA_RECOMPUTE_REACH` | `scripts/setup_database.sh` | unset (skip) | Set to `1` to regenerate the legacy accident-reach artifacts; nothing in the current app reads them |
| `API_BASE_PATH` | `app.py` -> the page's JS | empty (same origin) | Path prefix the API is published under, e.g. `/bkd`. The proxy strips it again, so Flask routes are unchanged |
| `FRONTEND_PUBLISH` | `docker-compose.yml` | `80` | Host side of the frontend's port mapping. Set to `127.0.0.1:8080` when the VM's own nginx owns port 80 |
| `DB_PUBLISH` | `docker-compose.yml` | `127.0.0.1:5433` | Loopback so Docker's iptables rules do not expose Postgres publicly |
| `BACKEND_PUBLISH` | `docker-compose.yml` | `127.0.0.1:5050` | Loopback; nginx reaches gunicorn over the compose network, not this port |
| `OSRM_PUBLISH` | `docker-compose.yml`, `docker-compose.dev.yml` | `127.0.0.1:5000` | Host side of OSRM's port. Loopback-only on purpose — OSRM has no auth. Needed by the pm2 deployment, where gunicorn runs outside the compose network |
| `TCGA_VENV` | `ecosystem.config.js` | `<repo>/.venv` | Where pm2 looks for the gunicorn executable |
| `PORT` | `app.py` (`__main__` only) | `5050` | Only affects the local dev server; the container always binds gunicorn to 5050 |
| `FLASK_DEBUG` | `app.py` (`__main__` only) | `1` locally, `0` in the container | Never affects the gunicorn/production path |

## Known limitations

- Accident + facility data must live under `latest data/`; reach/scorecard JSON is generated locally via OSRM precompute.
- No authentication on the dataset upload/reset endpoints — anyone who can
  reach the site can replace the active dataset. Fine for an internal/demo
  deployment; add auth in front of `/api/accidents/*` before wider release.
