# Trauma Network Analytics

The three analytics deliverables, served from one sidebar entry
(**Trauma Network Analytics**, `/network-analytics`) with a tab per deliverable.

| # | Requirement | Where it lives |
|---|---|---|
| 1 | Every 2025 grid + hospitals within 60 km, with hospital id/name/type/GPS/TPL and grid id/GPS/distance | Tab 1 · `/api/analytics/grid/<id>`, `/api/analytics/export/proximity.csv` |
| 2 | Grids **not** within reach of Tertiary / Secondary / Primary hospitals — coverage gaps and underserved corridors | Tab 2 · `/api/analytics/coverage`, `/api/analytics/export/gaps.csv` |
| 3 | Ambulance repositioning traces + residual gaps (>10 km to grid) | Tab 3 · `/api/analytics/ambulance`, `/api/analytics/export/ambulance.csv` |

---

## Setup

```bash
# 1. Build the TPL table (all 1,208 hospitals)
python3 scripts/build_tpl.py

# 2. Precompute the grid x hospital road matrix (needs PostGIS + OSRM up)
OSRM_BASE=http://127.0.0.1:5000 \
DATABASE_URL=postgresql://mapsr:mapsr@localhost:5433/mapsr \
    python3 scripts/precompute_network_analytics.py --year 2025
```

Step 2 takes a few minutes and writes `data/analytics/grid_hospital_2025.json`
(~18 MB). Add `--offline` to smoke-test the pipeline with straight-line
distances before OSRM is up — the artifact is stamped
`distance_model=straight_line_offline` and the UI shows a warning banner, so
offline output can never be mistaken for road routing.

**Raise the OSRM table limit first.** Both compose files now pass
`--max-table-size 8000` (default is 100). This lets the precompute send all
1,208 hospitals as destinations in one request, cutting ~15,000 OSRM round-trips
down to ~230.

---

## TPL — Trauma Preparedness Level

`data/hospital_tpl.csv`, built by `scripts/build_tpl.py` from your team lead's
dump. One row per hospital in `haryana_hosp`.

### The supplied dump does not line up with our hospital table

| Problem | Detail |
|---|---|
| `hospid` is a foreign ID | Not our `s_no`. Of 609 testable ids, **zero** matched the same hospital — `hospid` 1 is in Ambala, `s_no` 1 is in Mewat, 283 km apart. **We join on lat/lon**, which matches to <1 m. |
| Half the network is missing | 544 of 1,208 hospitals got a real score. Worst gap: 405 of 614 empanelled private. |
| Massive duplication | 1,478 rows, 696 distinct `hospid`. `hospid` 880 alone appears **637 times** across 18 different coordinate/score combinations. |
| Out-of-state rows | 38 Tamil Nadu, 31 West Bengal, 3 Maharashtra, 13 `"Test State"`, 2 with `state` = `"13"` (a state code in a name field). |
| `0.00` means unscored | 20 hospitals appear with **both** a `0.0` row and a real score (District Civil Hospital Kurukshetra: `[0.0, 78.54]`). Zeros are ignored, not averaged in. |
| `hosp_level` can't tier | L1/L2/L3 collapses our taxonomy: CH_SDH→L3 (31/31), CHC→L3 (63/63), PHC→L3 (234/234). All three public tiers become L3. **Tiering uses `hosp_type`, not `hosp_level`.** |

### Provenance

Every row carries `tpl_source`:

- **`real`** (544) — from the dump
- **`estimated`** (664) — drawn from the real per-type distribution, clipped to
  the real observed range, seeded so a hospital's score never changes between
  reloads

Measured real distributions used for synthesis:

| Type | n | mean | sd | range |
|---|---|---|---|---|
| PHC | 249 | 16.73 | 9.74 | 0.48–58.71 |
| CHC | 68 | 26.40 | 11.07 | 3.46–56.68 |
| CH_SDH | 33 | 38.88 | 16.68 | 0.48–72.54 |
| DCH | 13 | 53.80 | 20.47 | 16.26–83.36 |
| Empanelled Private | 181 | 51.73 | 19.56 | 1.95–92.17 |

The UI badges every estimated score. **Never present one as measured.**

When the complete real file arrives, drop it in and re-run `build_tpl.py` —
rows flip from `estimated` to `real` with no code change.

### Open questions for the team lead

1. What ID system is `hospid`? Can we get a crosswalk to `s_no`?
2. Will the remaining 664 hospitals be scored?
3. Is `total_score` out of 100? What are the **component category sub-scores**?
   Requirement 1a asks for "category wise TPL score" but the dump has only a
   single `total_score` column — right now "category wise" is served by
   grouping/aggregating TPL by hospital type and tier.
4. Why is `hospid` 880 repeated 637 times?
5. Are the Tamil Nadu / West Bengal / "Test State" rows meant to be there?

---

## Service tiers

Derived from `hosp_type` (standard Indian public health structure):

| `hosp_type` | Tier | Count |
|---|---|---|
| DCH — District Civil Hospital | Tertiary | 22 |
| CH_SDH — Civil / Sub-District Hospital | Secondary | 47 |
| CHC — Community Health Centre | Secondary | 119 |
| PHC — Primary Health Centre | Primary | 406 |
| Empanelled Private | by `hosp_level` (L1/L2→Tertiary, L3→Secondary) | 614 |

The **include private** toggle matters a lot: private hospitals lift Tertiary
from 22 facilities to 218 and roughly halve the gaps. Default is public-only.

---

## ⚠️ Karnal's ambulance GPS is wrong — 19 of 24 vehicles

Karnal reports the worst ambulance coverage in the state (343 of 403 grids,
**85%**, beyond 10 km from an ALS/BLS unit). That figure is inflated by a
geocoding error, not by a real shortage.

19 of Karnal's 24 ambulances carry GPS coordinates that fall in **Jind**. Six of
them sit at exactly `29.4146, 76.5934` with `stationed_at = "Civil Hospital"` —
but the real District Civil Hospital Karnal is at `29.6964, 76.9935`, **49.8 km
away**. A generic "Civil Hospital" string has clearly been geocoded to the wrong
facility.

State-wide this affects 31 of 569 vehicles (5%), and 19 of those are Karnal's.
Every other district is broadly sound.

**Do not present Karnal's number without this caveat** — anyone from the
district health office will know it is wrong, and it undermines the rest of the
analysis. Either exclude Karnal, or state that its ambulance coordinates need
re-geocoding before the figure is usable. The optimiser is unaffected: it
assigns districts geographically (`assign_geographic_districts`), so it already
treats these as Jind vehicles.

## Why the thresholds are what they are

Measured on **real OSRM road distance**, 6,760 grids, public facilities only:

| Preset | Tertiary | Secondary | Primary | Missing 2 tiers | Missing all 3 |
|---|---|---|---|---|---|
| **Spec — 60 km** | **2.09%** (141 grids) | 0.00% | 0.00% | 0 | 0 |
| Recommended — 30/10/5 km | 28.85% | 40.95% | 67.35% | 2,170 | **627** |
| Recommended, private counted | 5.43% | 23.83% | 67.35% | 959 | 165 |

The 60 km spec **does** produce a result once road routing is used — 141 grids,
concentrated in Sirsa (69), Bhiwani (28), Hisar (21) and Fatehabad (14). On
straight-line distance the same query returned 3 grids and looked broken.

That difference is the single strongest argument for the road-routing work:

| | Straight-line | Real road | Change |
|---|---|---|---|
| Tertiary gap @30 km | 15.6% | **28.9%** | ×1.9 |
| Secondary gap @10 km | 18.5% | **41.0%** | ×2.2 |
| Grids missing all three tiers | 189 | **627** | ×3.3 |
| Underserved corridors | 52 | **87** | ×1.7 |

Drive-time mode is deliberately not exposed in the UI — see `PRESETS` in
`network_analytics.py` for why. It can be re-enabled now that durations are
genuine.

---

## Data quality findings baked into the code

- **15 grid cells were being silently discarded at fetch time.** The RBG API
  returns 6,800 rows for Haryana 2025, but `rbg_grids._normalize_feature` only
  accepted `Polygon` geometry and dropped everything else. Those 15 are
  **MultiPolygon** (split footprints, typically cells straddling a boundary) and
  include some of the highest-severity cells in the state — grid 728051 carries
  severity **66**, grid 737554 carries **35**. Both geometry types are valid
  GeoJSON and shapely handles both, so both are now kept. `build_collection`
  also writes a `fetch_audit` block accounting for every API row, so a future
  silent drop is visible instead of invisible.
- **12 cells were being dropped for a blank district.** The district comes from
  a point-in-polygon join; border cells fall just outside every polygon. 12 of
  the 15 blank-district cells are genuinely inside Haryana — all on state edges
  (Sirsa on the Punjab/Rajasthan border, Gurugram/Faridabad on the Delhi border,
  Yamunanagar on the UP border). They now inherit the district of their nearest
  labelled neighbour instead of being discarded. Only 3 are truly foreign: two
  at (13.067, 80.279) — that is **Chennai** — and one in UP.
- **22 duplicated grid IDs.** The RBG feed emits the same `grid_id` twice at
  identical coordinates but with conflicting severity — grid 749087 arrives as
  both 22.0 and 7.0. Untreated, those cells are counted twice in every statistic
  and their severity is whichever row landed last. We keep one row per id and
  take the **max** severity; some duplicate pairs are byte-identical (749592 is
  2.0 twice), which points at a duplicated export rather than two partial
  counts, so summing would inflate risk. Worth raising with whoever owns the RBG
  feed.

### Full accounting of the API response

Every row is now accounted for — nothing is dropped without being counted:

```
API returns                        6,800 rows
  - duplicate grid_ids merged        -22   (same id, conflicting severity)
  - genuinely outside Haryana         -3   (2 in Chennai, 1 in UP)
  ------------------------------------------
  = working set                    6,775 grids
```

After changing the geometry filter you must re-fetch, with PostGIS up so the
district polygons are available:

```bash
cd dashboard && python3 -c "import rbg_grids; rbg_grids.build_collection('2025', force=True)"
python3 ../scripts/precompute_network_analytics.py --year 2025
```
- **GURGAON vs GURUGRAM.** The ambulance table says GURGAON, the grid feed says
  GURUGRAM. Without the alias, the "stay in your home district" rule put 68
  ambulances in a group with zero candidate sites — they silently never moved
  and Gurugram was never optimised.
- **62 ambulances have a district label that disagrees with their GPS.**
  HR45 C-5752 is recorded under KARNAL but sits 0.6 km from a JIND grid, 81 km
  from Karnal. Districts are therefore assigned **geographically** and the
  recorded label is kept in `district_recorded` for traceability.

---

## Deliverable 1 — proximity

The uncapped 60 km join is **1,488,851 rows** (median 229 hospitals per grid,
max 372) — roughly 250 MB of CSV that no spreadsheet will open. So:

- **Export** keeps the nearest N per grid (5 / 10 / 25 selectable; 10 → ~68k
  rows, ~9 MB).
- **Click any grid** for its full 60 km list, routed live through OSRM in one
  `/table` call. Falls back to the cache (nearest 12 per type) if OSRM is down —
  the response says which, via `source`.

The cache keeps nearest-N **per hospital type**, not a flat nearest-25. A flat
list would let 25 nearby PHCs hide the district hospital 8 km away and make a
grid look devoid of tertiary care. Every tier is a union of types, so any
tier/private/type query is answered exactly.

---

## Deliverable 3 — ambulance positioning

Greedy Maximal Covering Location Problem. Not globally optimal, but within
(1 − 1/e) ≈ 63% of optimal for coverage problems, runs in ~2–4 s, and every
placement can be explained to a district health officer.

Optimisation uses **straight-line** distance — the search evaluates millions of
candidate/demand pairs and OSRM cannot answer that interactively. The UI states
this; `verify_with_osrm()` re-measures the worst residual gaps by road.

### The ambulance table is duplicated — the real fleet is 569, not 1,138

`haryana_ambulance` holds 1,138 rows, but every row appears **exactly twice,
byte-identical** — same `s_no`, same `vehicle_no`, same GPS, same type. The
evidence is unambiguous: 569 distinct full rows, 569 distinct vehicle numbers,
569 distinct (vehicle, coordinate) pairs, and not a single vehicle appearing
once or three times. It is a doubled export.

Uncorrected, the optimiser positions 569 vehicles that do not exist and every
coverage figure it reports is inflated. `load_ambulances()` now deduplicates on
the full row, so two genuinely distinct vehicles sharing an id would both
survive. The hospital and blood-bank tables were checked and are clean.

Corrected fleet: **569** — BLS 253, PTA 227, ALS 55, Kilkari 29, Neonate 5.

Baseline: 569 ambulances at only **372 distinct parking sites** (busiest holds
14 vehicles). 92.3% of grids are within 10 km.

### Grids out of ambulance reach — real road distance

The primary deliverable: grid cells whose nearest ambulance is **N km or more
away by road** (`>=`, per the requirement's "10 kms and above").

| Threshold | All 569 vehicles | ALS + BLS only (308) |
|---|---|---|
| ≥ 5 km | 4,135 (61.2%) | 4,843 (71.6%) |
| **≥ 10 km** | **1,346 (19.9%)** | **2,143 (31.7%)** |
| ≥ 15 km | 471 (7.0%) | 824 (12.2%) |

Severity-weighted, the ≥10 km ALS/BLS figure is **25.5% of Haryana's accident
severity**. Straight-line distance reported 15.3% / 12.7% for the same query —
road routing roughly doubles it, because canals, rail lines and motorway
medians make crow's-flight distance a fiction here.

Worst districts at ≥10 km (ALS/BLS): Karnal 343 **(see the GPS caveat above)**,
Bhiwani 166, Kaithal 155, Sirsa 135, Sonipat 129, Nuh 124.

Repositioning (straight-line optimisation, district constraint on):

| Radius | Coverage | Relocated |
|---|---|---|
| 5 km | 59.2% → 91.3% | 569 |
| **10 km** | **92.3% → 98.6%** | **410** |
| 15 km | 97.1% → 99.8% | 294 |

Headline: **Haryana can lift 10 km ambulance coverage substantially by
repositioning alone — no new vehicles.** Note the optimiser's percentages are
straight-line; switch the tab's source to "Proposed" to re-measure the surviving
gaps by road.

> Note: the app's other views (`/api/geolocations/ambulance`, the boundaries
> summary, the ambulance-reach page) still count raw rows and therefore still
> report 1,138. They share `db.py`, not this module. Worth correcting before
> any public presentation.

Toggles default to district-constraint-only, matching the project decision; the
other three are switchable live in the UI.

---

## API reference

| Endpoint | Purpose |
|---|---|
| `GET /api/analytics/meta` | Controls, districts, TPL provenance, cache status |
| `GET /api/analytics/coverage` | `mode=time\|distance`, `tertiary/secondary/primary`, `private`, `district`, `corridor_tier` |
| `GET /api/analytics/grid/<id>` | Full hospital list within 60 km (`live=0` forces cache) |
| `GET /api/analytics/ambulance` | `threshold`, `district_constraint`, `emergency_only`, `snap`, `weighted` |
| `GET /api/analytics/export/proximity.csv` | `top_n`, `private`, `district` |
| `GET /api/analytics/export/gaps.csv` | Same threshold params as coverage |
| `GET /api/analytics/export/ambulance.csv` | Every vehicle with `action` = RELOCATE / STAY |

---

## Known limitations

- Corridor detection links gap cells whose centroids are within 1.6 km and
  requires 4+ cells. Both are constants in `network_analytics.py`.
- The ambulance optimiser treats each vehicle as always available — no
  call-volume, shift or simultaneous-incident modelling.
- Drive times are free-flow from a static OSM snapshot. No live traffic, which
  matters for Gurugram/Faridabad peak hours.
- `evaluate_coverage` returns ~6 MB for all 6,770 grids. nginx now gzips it
  (~10x); the Flask dev server does not.
