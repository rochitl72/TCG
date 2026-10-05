# Chamba (Himachal Pradesh) — multi-state build handoff

Adds **Chamba district, Himachal Pradesh** alongside Haryana, for the grid +
hospital proximity views and the full grid/hospital analytics (proximity, gaps,
tier-gaps, level-reach, district TSS, and the TPL-driven charts). Ambulance and
blood-bank layers are intentionally **not** added for Chamba.

Haryana is unchanged. Everything Chamba is additive and selected by a new
**State** dropdown; with no state chosen (or Haryana), the app behaves exactly
as before.

## What changed

**New files**
- `dashboard/regions.py` — the region registry + a request-scoped "current
  region". One place defines each state's bbox, data files, hospital source and
  label.
- `data/rbg_grids/himachal_chamba_2025.json` — Chamba's 64 accident-grid cells
  (pulled live from the RBG partner API, normalised into the same cache format
  as `haryana_2025.json`).
- `data/analytics/grid_hospital_himachal_chamba_2025.json` and
  `hospital_grid_himachal_chamba_2025.json` — the precomputed grid↔hospital
  road-distance matrices for Chamba (same JSON schema as the Haryana artifacts).
- `data/regions/hospitals_chamba.csv` — the 13 Chamba public hospitals
  (deduped) with level + TPL score baked in. This is Chamba's self-contained
  hospital table; **no database row is needed**.
- `data/regions/himachal_chamba_boundary.geojson` — the Chamba district
  boundary (from the partner `get_layer` endpoint).

**Edited files**
- `dashboard/network_analytics.py` — loaders (`load_grids`, `load_hospitals`,
  `load_proximity`, `load_hospital_grid`, `artifact_path`, `hospital_grid_path`)
  are now region-aware, defaulting to the current request's region. Added a CSV
  hospital loader for non-DB regions, a `region_tpl_summary()`, and extended
  `PUBLIC_LEVEL_TYPES` / tier / radius tables with `MCH` and `SSH` (Haryana has
  zero such rows, so this is a no-op for Haryana).
- `dashboard/rbg_grids.py` — per-region grid cache path; `get_grids` takes a
  region.
- `dashboard/app.py` — a `before_request` hook sets the region from the
  `?state=` query param; `/api/districts/boundaries` and `/api/analytics/meta`
  are region-aware (meta now also returns `states`, `map_center`, `map_zoom`).
- `dashboard/templates/network_analytics.html` — `window.apiUrl` now carries
  the selected state on every API call (Haryana adds nothing, so its URLs are
  unchanged); added the **State** `<select>` above the district control.
- `dashboard/static/js/network_analytics.js` — populates the State dropdown,
  reloads with `?state=` on change, and frames the map on the chosen region.
- `.gitignore` — added `!/data/rbg_grids/himachal_chamba_2025.json` so the
  Chamba grid cache is tracked (the folder is otherwise ignored).

## How the state switch works

The **only** thing that selects the dataset is the `?state=` query parameter.
`regions.resolve_from_state()` maps it to a region id; the data loaders default
to that region. The existing **district** filter keeps working as a sub-filter
within the region. No state, or `state=Haryana`, is the original Haryana path.

## Deploy — there is NO database step for Chamba

Chamba is entirely file-driven (hospitals from CSV, grid/boundary/analytics from
committed JSON), so **no SQL load or migration is required**. Steps:

1. **Commit from your real Mac terminal** (git-lfs runs there; the sandbox this
   was built in has no git-lfs, so commit was left to you):
   ```
   cd ~/Downloads/mapsR
   git add dashboard/regions.py dashboard/app.py dashboard/network_analytics.py \
           dashboard/rbg_grids.py dashboard/static/js/network_analytics.js \
           dashboard/templates/network_analytics.html .gitignore \
           data/rbg_grids/himachal_chamba_2025.json \
           data/analytics/grid_hospital_himachal_chamba_2025.json \
           data/analytics/hospital_grid_himachal_chamba_2025.json \
           data/regions/hospitals_chamba.csv \
           data/regions/himachal_chamba_boundary.geojson \
           dashboard/grid_ambulance.py scripts/precompute_network_analytics.py \
           scripts/setup_osrm_chamba.sh CHAMBA_HANDOFF.md
   git commit -m "Add Chamba (Himachal Pradesh) as a second state (grid + hospitals)"
   ```
2. Deploy the backend + frontend as usual (restart Flask / redeploy the
   container). The five new data files must be present on the server — they ride
   along in the repo now (the grid-cache ignore exception is handled).
3. No OSRM change is needed on the server: Chamba's OSRM road distances are
   precomputed into the committed artifacts.

## Verify after deploy

- Open the app → the **State** dropdown shows *Haryana* and *Himachal Pradesh*.
- Pick *Himachal Pradesh* → map reframes on Chamba; District shows only
  *Chamba*; 64 grid cells render; grid popups and hospital popups work; the
  Gaps / charts tabs reflect Chamba.
- Switch back to *Haryana* → identical to before.

Sanity numbers for Chamba (2025, OSRM road routing): 64 grid cells, 13 public
hospitals (1 L1 medical college, 2 L2 district hospitals, 10 L3 CHC/SDH);
64/64 cells reach a hospital within 60 km by road; 321 grid-hospital pairs;
L1 reach 49/64 (77%), L2 15/64 (23%), L3 14/64 (22%); 8 cells meet no level's
radius; median nearest hospital 11 km by road.

## Road distances (OSRM)

Chamba's grid-to-hospital distances come from the same OSRM engine and car
profile as Haryana's, run on a Chamba-only road graph, and are stamped
`distance_model: "osrm_road"`. To regenerate them:

```
bash scripts/setup_osrm_chamba.sh          # builds graph from osrm-data/chamba.osm.pbf, serves on :5001
OSRM_BASE=http://127.0.0.1:5001 \
  python3 scripts/precompute_network_analytics.py --year 2025 --region himachal_chamba
docker rm -f osrm-chamba
```

`osrm-data/` is gitignored; the server does not need the graph, only the two
committed JSON artifacts. The precompute's OSRM health check now probes a point
inside the region being computed (Haryana's probe point is unchanged).

## State switch on Gaps, exports, and Haryana-only layers

- The **State** dropdown now appears on both the Proximity and Gaps controls;
  both drive the same `?state=` param, which survives switching views.
- **Ambulance and blood-bank data are Haryana-only.** For any other state the
  server refuses those endpoints (JSON and CSV/ZIP) with a clear 404 message
  instead of returning Haryana rows, and the UI hides the Ambulance rail button,
  the Blood storage layer and its CSV button.
- The live partner proxy (`/api/rbg/<name>`) now uses the region's own partner
  codes: Chamba = state 12, district 243 (Haryana unchanged: 13 + its table).
  This fixes the Chamba district outline and live grid severity, which were
  being asked of Haryana.
- The offline grid-stats popup fallback returns "unavailable" for non-Haryana
  cells instead of a false "No accidents recorded"; the live `grid_data` path
  serves Chamba cells.
- Chamba district names are upper-case (`CHAMBA`) everywhere, matching
  Haryana's convention (`AMBALA`), so filters and exports never mix spellings.
- The hospital->grid ZIP is named and titled for its region
  (`hospital-grid-proximity-60km-himachal_chamba.zip`, README "HIMACHAL PRADESH (CHAMBA)").

### Re-verify all downloads

```
python3 scripts/verify_exports.py                      # in-process
python3 scripts/verify_exports.py --base http://127.0.0.1:5050   # against a running server
```
It requests every export button's URL (same query the JS builds) for Haryana
(all + one district) and Himachal (all + Chamba), with EP on and off, and
cross-checks each file against the on-screen numbers (out/in counts, district
sums, grid counts, hospital-grid pairs, ZIP parts vs single CSV), checks no
file contains another state's districts, and that Haryana-only exports refuse
for Himachal. Output goes to `export_check/` (gitignored).
