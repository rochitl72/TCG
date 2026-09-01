# TCGA — Trauma Care Gap Analysis (Haryana)

> **This describes the zip-based handover to a laptop running Docker Desktop.**
> For deploying to a server from the git repository — the current path — follow
> [README.md § Deploying to a server](README.md#deploying-to-a-server) instead.
> The two differ: the server path clones with git-lfs, sets `OSRM_PLATFORM` for
> the host architecture, and builds the frontend image rather than relying on
> bind-mounted files.

Handoff package. Two zips, one folder, one command.

| | |
|---|---|
| **What it is** | A Flask + PostGIS + OSRM web app that measures how far every part of Haryana is from trauma care, by road, and shows where the gaps are. |
| **Scale** | 6,785 accident grid cells × 1,208 facilities, 35,278 accident records, road distances from a self-hosted OSRM graph. |
| **You need** | Docker Desktop. Nothing else — no Python, no PostgreSQL, no Node. |
| **Time to first screen** | ~25 minutes, almost all of it unattended (a 210 MB download and a road-graph build). |
| **Where it opens** | http://localhost |

---

## 1. Unzip both into the SAME folder

The two zips are one project split along its deployment seam, not two independent apps. `tcga-frontend.zip` holds what nginx serves and Flask renders; `tcga-backend.zip` holds everything else. Their paths do not overlap, so extracting both into one directory reassembles the original tree exactly.

```
tcga/
├── dashboard/
│   ├── static/        <- frontend zip
│   ├── templates/     <- frontend zip
│   └── *.py           <- backend zip
├── nginx/             <- frontend zip
├── data/              <- backend zip
├── scripts/           <- backend zip
├── latest data/       <- backend zip
├── docker-compose.yml <- backend zip
└── ...
```

If you extract only one, the app will not start. If a zip tool creates a nested `tcga-backend/` wrapper folder, move the contents up one level so `docker-compose.yml` sits at the top.

**Put the folder inside WSL, not on the Windows drive.** `\\wsl$\Ubuntu\home\you\tcga` is fine; `C:\Users\you\tcga` works but every database and OSRM file crosses the WSL filesystem bridge, and the setup runs several times slower.

---

## 2. Prerequisites

**Docker Desktop** with the WSL2 backend, and this distro enabled under *Settings → Resources → WSL Integration*.

**Raise Docker's memory to 8 GB** — *Settings → Resources → Memory*. This is not optional. Building the OSRM road graph is the memory-hungry step, and at the 2 GB default `osrm-extract` dies partway through with an out-of-memory error that reads like a corrupt download.

Then, in an Ubuntu/WSL shell:

```bash
sudo apt-get update && sudo apt-get install -y curl
```

**The browser needs internet access.** All the data and routing run locally, but the page pulls Leaflet (the map library) from `unpkg.com` and the Inter font from `fonts.googleapis.com`. On a machine behind a proxy that blocks those, the tiles and panels still work but the map will not draw — worth knowing before you conclude the setup failed.

---

## 3. Run setup

From the project folder, in an Ubuntu/WSL shell:

```bash
bash scripts/setup_windows.sh
```

That single script does everything:

1. Pins the OSRM container to `linux/amd64` in `.env` (the repo defaults to arm64 for the Apple Silicon machines it was built on — leave that default in place on an Intel/AMD box and OSRM runs under emulation, which is minutes per request instead of milliseconds).
2. Starts PostGIS and loads the boundary and facility dumps.
3. Downloads the northern-India OSM extract, clips it to Haryana, and builds the routing graph.
4. Builds the app image and brings up the full stack.

It is **idempotent** — every step checks for its own output first. If it fails partway (a dropped download, Docker running out of memory), fix the cause and re-run the same command; it picks up where it stopped rather than redoing the database load.

Expect roughly: 3–5 min for the database, 5 min for the download, 10 min for the graph build, 2 min for the image.

---

## 4. Verify

```bash
docker compose ps        # db, backend, osrm, frontend all "running"
```

Then open **http://localhost** and check:

- The map draws Haryana with coloured grid cells.
- The **Proximity** tab's left sidebar lists service levels L1 / L2 / L3 / EP.
- The **Gaps** tab shows district bars, not an empty panel.
- The **Ambulance** tab loads and its stat cards show percentages, not `undefined%`.

If the map is there but the analytics panels are empty, OSRM is still warming up — see below.

---

## 5. If something is wrong

**Blank page, or "backend unavailable"** — OSRM memory-maps a 1.9 GB graph before it answers anything, and a cold start on a laptop takes minutes. Watch it:
```bash
docker compose logs -f backend osrm
```

**`osrm-extract` fails around "Generating edge-expanded edges"** — Docker memory. Raise it to 8 GB and re-run the setup script.

**Port 80 already in use** (IIS, Skype, another nginx) — edit the `frontend` service in `docker-compose.yml`, change `"80:80"` to `"8080:80"`, then `docker compose up -d frontend` and use http://localhost:8080.

**Everything looks broken and you want a clean slate:**
```bash
docker compose down -v          # -v also drops the seeded database volume
rm -rf osrm-data                # only if you suspect a bad graph build
bash scripts/setup_windows.sh
```

**On a Mac instead of Windows** — ignore all of the above and run `./start.sh`, which is the original development path. It expects `psql` and Python 3.11 on the host; `scripts/setup_windows.sh` works there too if you would rather keep everything in Docker.

**Where the pieces listen** — nginx on `80` (this is the one you use), gunicorn on `5050`, PostGIS on `5433`. OSRM is internal to the compose network and is not published to the host.

---

## 6. What is in the box

### Backend zip

| Path | What it is |
|---|---|
| `dashboard/*.py` | The Flask app. `app.py` is the routes and exports; `network_analytics.py` is the coverage engine (proximity, gaps, reach bands); `grid_ambulance.py` / `ambulance_v2.py` are the ambulance models; `db.py`, `districts.py`, `rbg_grids.py` are the data layer. |
| `scripts/` | Setup and one-off precompute scripts. `setup_windows.sh` is the entry point; `precompute_*.py` regenerate the analytics artifacts. |
| `data/analytics/*.json` | **Precomputed grid × facility road matrices.** These are the expensive part of the project — regenerating them means hundreds of thousands of OSRM calls. Shipped so the app is fully populated on first load. |
| `data/accident_*_safety_v2.json` | Precomputed accident-reach results, same reasoning. |
| `data/rbg_grids/`, `data/hospital_tpl.csv`, `data/rbg_hosp_gps_haryana.json` | Cached upstream data, so first load needs no external API. |
| `latest data/` | The canonical source dumps: facilities SQL, accident CSV, TPL scores. |
| `district.sql`, `state 1.sql` | One-time PostGIS boundary dumps. |
| `docker-compose.yml` | The full stack (db / backend / osrm / frontend). `docker-compose.dev.yml` is the Mac dev variant — db and osrm only. |

### Frontend zip

| Path | What it is |
|---|---|
| `dashboard/static/js/` | `network_analytics.js` is the main application (map, tabs, filters, exports); `charts.js` is the chart renderer; `map_measure.js` and `radar_overlay.js` are map tools. |
| `dashboard/static/css/` | Styles, split by area. |
| `dashboard/static/images/` | Logos and marker assets. |
| `dashboard/templates/` | Jinja templates. `network_analytics.html` is the whole single-page UI. |
| `nginx/nginx.conf` | The reverse proxy. Serves `/static/` straight off disk and proxies everything else to gunicorn, with gzip on — the analytics JSON responses are several MB and compress about tenfold. |

### Deliberately not shipped

- **`osrm-data/`** (1.9 GB) — the road graph is machine- and architecture-specific. The setup script rebuilds it.
- **`.venv/`, `__pycache__/`, `dashboard/cache/`** — host-specific; regenerated.
- **`.git/`** (437 MB of history) — ask if you want the repository rather than a snapshot.

---

## 7. Regenerating the analytics (only if the source data changes)

The precomputed artifacts in `data/analytics/` match the shipped facility and accident data. If either changes, rebuild them — the stack must already be up, since these need both the database and OSRM:

```bash
docker compose run --rm artifacts
```

This runs the whole chain in order: resolve facility coordinates, assign service levels and TPL scores, build the grid × facility matrix, then the route geometry and ambulance reach. It takes hours. Order matters and is enforced by the command itself — see the comments on the `artifacts` service in `docker-compose.yml`.

---

## 8. Further reading

- `README.md` — full project documentation, architecture, and the deploy notes for tcg.coers.in.
- `README_ANALYTICS.md` — how the coverage analytics are defined and computed, including the scoring rules behind the grid colours.
