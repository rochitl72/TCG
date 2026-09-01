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
  dataset_manager.py    Active accidents CSV (default vs. uploaded)
  reach_pipeline.py     Background OSRM recompute (accident-level reach)
  grid_reach.py         On-demand OSRM recompute (grid-cell-level reach)
  network_analytics.py  Grid-hospital proximity, tier coverage gaps, corridors
  ambulance_optimizer.py  Dynamic ambulance positioning (greedy MCLP)
  tpl.py                Trauma Preparedness Level lookup + provenance
  road_grid_generator.py  OSM road-network grid cells (osmnx)
  templates/            Jinja2 pages + shared partials (_rail, _app_header, _measure_panel)
  static/{css,js}/       Per-page JS, shared reach_view.js, map_measure.js
  Dockerfile             Backend image (gunicorn)
data/                   Seed data + precomputed reach JSON (small — see .gitignore
                         for what's excluded and why)
scripts/                One-time DB setup + grid generation
nginx/nginx.conf         Reverse proxy config for the frontend container
docker-compose.yml       Production stack: db + backend + frontend
docker-compose.dev.yml   Local dev: PostGIS + OSRM (start.sh runs Flask on host)
osrm-data/               Northern-zone OSM extract + OSRM graph (gitignored)
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
  host-side DB bootstrap in step 2 below — not by the running app.

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

## Deploying (tcg.coers.in)

The production stack is a separate `docker-compose.yml` with three
containers: `frontend` (nginx, port 80, proxies everything to `backend`),
`backend` (this Flask app under gunicorn, port 5050 — unchanged from local
dev), and `db` (PostGIS, port 5433 — unchanged, kept open so the one-time
bootstrap step below can reach it from the host).

1. **Get the code onto the server.**
   ```bash
   sudo apt-get install -y git-lfs   # required — district.sql / state 1.sql are LFS objects
   git lfs install
   git clone https://github.com/rochitl72/Trauma-Care-Gap-Analysis.git
   cd Trauma-Care-Gap-Analysis
   ```
   `district.sql`, `state 1.sql`, and `geolocations.sql` all come down as
   part of the clone — no separate transfer step, as long as git-lfs was
   installed *before* cloning. (If you already cloned without it: install
   git-lfs, then run `git lfs pull`.)

2. **Bring up the database, OSRM, and load data (one-time).**
   ```bash
   chmod +x scripts/setup_osrm.sh scripts/setup_database.sh
   ./scripts/setup_osrm.sh
   OSRM_BASE=http://127.0.0.1:5000 OSRM_SLEEP=0 DATABASE_URL=postgresql://mapsr:mapsr@localhost:5433/mapsr ./scripts/setup_database.sh
   ```
   This is idempotent — safe to re-run; it skips any table that's already
   loaded. Reach/scorecard recompute for ~35k accidents runs in the background;
   monitor with `tail -f data/recompute.log`.

3. **Bring up the backend and frontend.**
   ```bash
   docker compose up -d backend frontend osrm
   ```

4. **Point DNS.** `tcg.coers.in` → this server's IP, A record. nginx is
   already configured with `server_name tcg.coers.in` in `nginx/nginx.conf`.

5. **(Recommended) put TLS in front of it.** The frontend container only
   serves plain HTTP on 80. For HTTPS, either put another reverse proxy /
   load balancer in front that terminates TLS and forwards to this host's
   port 80, or swap the nginx container for one running certbot. Either way,
   the app already trusts `X-Forwarded-Proto`/`X-Forwarded-Host` (see
   `ProxyFix` in `dashboard/app.py`), so it'll report the correct scheme/host
   once you do.

No API base URL needs changing anywhere in the frontend JS — every request
already uses a relative path (`/api/...`), so the same code works at
`tcg.coers.in` with zero edits. What *did* need changing for hosting behind
a domain: the app now trusts proxy headers (`ProxyFix`), gunicorn/nginx
timeouts are raised to match the app's genuinely slow first-load operations
(grid/road analyses can take up to ~1-2 minutes per district), and debug
mode is off by default in the container (`FLASK_DEBUG=0`) — the Flask dev
server used for local development is never used in production; gunicorn is.

## Environment variables

| Variable | Used by | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | `db.py`, `reach_pipeline.py`, `road_grid_generator.py` | `postgresql://mapsr:mapsr@localhost:5433/mapsr` | Set to `postgresql://mapsr:mapsr@db:5432/mapsr` inside docker-compose (container-to-container hostname) |
| `OSRM_BASE` | `reach_pipeline.py`, `grid_reach.py`, measure API | `http://127.0.0.1:5000` when using `./start.sh` | Set to `http://osrm:5000` in the production backend container |
| `OSRM_SLEEP` | `reach_pipeline.py`, `grid_reach.py` | `0` with self-hosted OSRM | Seconds between OSRM requests during precompute; use `0.1` only for the public demo server |
| `PORT` | `app.py` (`__main__` only) | `5050` | Only affects the local dev server; the container always binds gunicorn to 5050 |
| `FLASK_DEBUG` | `app.py` (`__main__` only) | `1` locally, `0` in the container | Never affects the gunicorn/production path |

## Known limitations

- Accident + facility data must live under `latest data/`; reach/scorecard JSON is generated locally via OSRM precompute.
- No authentication on the dataset upload/reset endpoints — anyone who can
  reach the site can replace the active dataset. Fine for an internal/demo
  deployment; add auth in front of `/api/accidents/*` before wider release.
