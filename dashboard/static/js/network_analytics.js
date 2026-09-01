// Trauma Network Analytics — three deliverables behind one sidebar entry:
//   1. grid -> hospital proximity within 60 km (with TPL)
//   2. tier coverage gaps
//   3. dynamic ambulance positioning
//
// The heavy grid x hospital road matrix is precomputed (see
// scripts/precompute_network_analytics.py); everything here re-renders from the
// cached payload, so thresholds stay interactive with no round trips.

const TIERS = ["Tertiary", "Secondary", "Primary"];
const TIER_COLOR = { Tertiary: "#7c3aed", Secondary: "#2563eb", Primary: "#0d9488" };

// Escalating severity by NUMBER of tiers a cell is missing. Deliberately a
// single hot ramp (amber -> orange -> blood red) rather than three unrelated
// hues, so "worse" reads instantly without consulting the legend.
const GAP_COUNT_COLOR = { 0: "#cbd5e1", 1: "#fbbf24", 2: "#f97316", 3: "#b91c1c" };
const GAP_COUNT_LABEL = {
  1: "Missing one tier",
  2: "Missing two tiers",
  3: "Missing all three tiers",
};

// Same palette the Grid Analysis view uses, so a hospital is the same colour
// everywhere in the app.
const HOSP_TYPES = [
  { code: "DCH", label: "District Civil Hospital", color: "#7c3aed" },
  { code: "CH_SDH", label: "Civil / Sub-District Hospital", color: "#2563eb" },
  { code: "CHC", label: "Community Health Centre", color: "#0d9488" },
  { code: "PHC", label: "Primary Health Centre", color: "#ea9010" },
  { code: "Empanelled Private Hospital", label: "Empanelled Private", color: "#db2777" },
];
const HOSP_COLOR = Object.fromEntries(HOSP_TYPES.map((t) => [t.code, t.color]));

// ONE icon for every facility: a map pin carrying the medical cross. It says
// "hospital" and nothing else, and it says it identically at L1, L2 and L3.
//
// COLOUR IS THE ONLY VARIABLE. Earlier revisions also varied the silhouette
// (star / square / disc) and the size, on the reasoning that a second and
// third channel makes the levels readable in mono. It backfired: three
// unrelated shapes read as three unrelated KINDS of thing — a star does not
// look like a hospital — and the map stopped saying "here are the hospitals,
// graded" and started saying "here are some symbols". One shape, three
// colours, is the clearer instrument.
//
// The palette is a dark -> light ramp across violet -> blue -> teal, chosen
// on three constraints:
//   1. Ordinal. L1 > L2 > L3 is a ranking, so the colours are a ranked ramp
//      rather than three arbitrary hues.
//   2. Separated on lightness as well as hue, so the levels stay tellable
//      apart for a viewer with a colour vision deficiency, who loses the hue
//      difference but keeps the light/dark one.
//   3. Clear of everything else on the page. The old L2 orange (#eb6834) sat
//      squarely inside the grid cells' own yellow -> orange -> red ramp, so an
//      L2 badge on an orange cell was near-invisible and read as part of the
//      choropleth. Violet/blue/teal collide with neither that ramp nor the
//      green/red of the route branches.
//
// `size` is uniform. It is kept per-level rather than hoisted to a constant so
// a future "make L1 bigger" is a data edit, not a refactor. `priority` is NOT
// uniform: it feeds zIndexOffset so the 66 L1/L2 pins always draw on top of
// the 572 L3s. Without that ordering a state-wide view buries every referral
// centre under the primary-care layer.
const HOSP_LEVEL_ICON_PX = 24;
const HOSP_LEVEL_STYLE = {
  L1: { color: "#5b21b6", ring: "#33127a", size: HOSP_LEVEL_ICON_PX, priority: 400 },
  L2: { color: "#2563eb", ring: "#16368f", size: HOSP_LEVEL_ICON_PX, priority: 300 },
  L3: { color: "#14b8a6", ring: "#0c6d63", size: HOSP_LEVEL_ICON_PX, priority: 200 },
  /* EP — empanelled private, split out of L1 on 25 Aug 2026. Magenta-leaning
     purple rather than L1's violet: they were one category until this change,
     so making them nearly the same colour would undo the split visually. It
     sits BELOW the public levels in priority because the public facility is
     the one a state coverage map should surface when two pins overlap. */
  EP: { color: "#9333ea", ring: "#6b21a8", size: HOSP_LEVEL_ICON_PX, priority: 150 },
  OTHER: { color: "#94a3b8", ring: "#64748b", size: HOSP_LEVEL_ICON_PX, priority: 100 },
};

// Teardrop on a 24x32 viewBox: circular head, tip at (12, 31.4). A constant so
// the silhouette is byte-identical everywhere a pin appears.
const HOSP_PIN_PATH =
  "M12 31.4C12 31.4 22.5 19.2 22.5 11.6A10.5 10.5 0 0 0 1.5 11.6C1.5 19.2 12 31.4 12 31.4Z";

/**
 * One facility icon as an inline SVG string. Identical shape at every level;
 * `lv` selects the colour and nothing else.
 *
 * The cross is knocked straight out of the solid pin rather than sitting on a
 * white disc inside it. With colour now the ONLY thing separating the levels,
 * the pin has to spend as much of its area as possible ON that colour — a
 * white disc eats the middle third, which is exactly the part the eye samples.
 *
 * `forLegend` clamps the height for a sidebar filter row and swaps the class
 * that pulls the icon out of document flow. A dashed outline marks a mocked
 * facility, so an approximate location can never be mistaken for a surveyed one.
 */
/* Pin size follows the ZOOM, and it has to.
   Haryana holds 1,208 facilities. Drawn at a fixed 24 px they tile the whole
   state solid at the default zoom — the four grid colours this tab exists to
   show end up completely hidden underneath their own facility layer, so the
   map answers "where are the hospitals" (everywhere) instead of "what is in
   reach". Shrinking with zoom keeps every facility on screen and honest while
   letting the cells read: state-wide the pins are coloured dots, and they
   resolve into full pins as you come in to where individual sites matter. */
function hospIconPx(base) {
  const z = typeof map !== "undefined" && map ? map.getZoom() : 11;
  if (z <= 7) return Math.max(7, Math.round(base * 0.3));
  if (z === 8) return Math.round(base * 0.4);
  if (z === 9) return Math.round(base * 0.55);
  if (z === 10) return Math.round(base * 0.75);
  return base;
}

function hospIconHtml(lv, mocked = false, forLegend = false, context = false) {
  const c = HOSP_LEVEL_STYLE[lv] || HOSP_LEVEL_STYLE.OTHER;
  const h = forLegend ? Math.min(c.size, 20) : hospIconPx(c.size);
  // Below ~14 px the cross is finer than a pixel and just muddies the fill,
  // turning a crisp coloured dot into a grey smudge. Drop it and let the
  // silhouette and colour carry the pin — the level is the only thing a pin
  // this small can legibly say, and it still says it.
  const tiny = h < 14;
  // Non-square viewBox, so the width has to track the height or the pin
  // renders squashed. 24:32 is the aspect of the path above.
  const w = Math.round((h * 24) / 32);
  const dash = mocked ? ' stroke-dasharray="3 2"' : "";

  /* CONTEXT pin — a real facility at a real location that provides no tier
     under the spec (an empanelled private hospital the TPL dump defaulted to
     "L2", overwhelmingly). Same silhouette and same size, because the level
     colours are the only thing that should separate the three tiers; what
     separates THIS is that it is hollow and grey. Filled-and-coloured has to
     mean "counts", or the map is making a capacity claim the analysis will
     contradict the moment anyone clicks a grid. */
  if (context) {
    return (
      `<svg class="hosp-svg hosp-svg-context${forLegend ? " hosp-svg-legend" : ""}" ` +
      `width="${w}" height="${h}" viewBox="0 0 24 32">` +
      `<path d="${HOSP_PIN_PATH}" fill="none" stroke="#ffffff" stroke-width="3.4" stroke-linejoin="round"/>` +
      `<path d="${HOSP_PIN_PATH}" fill="#ffffff" fill-opacity="0.88" stroke="#94a3b8" stroke-width="1.6" stroke-linejoin="round"${dash}/>` +
      `<path d="M12 7.4v8.4M7.8 11.6h8.4" stroke="#94a3b8" stroke-width="2.4" stroke-linecap="round"/>` +
      `</svg>`
    );
  }

  return (
    `<svg class="hosp-svg${forLegend ? " hosp-svg-legend" : ""}" ` +
    `width="${w}" height="${h}" viewBox="0 0 24 32">` +
    // A white casing under the fill lifts the pin off dark basemap tiles
    // without relying on the CSS drop-shadow, which does not survive printing.
    `<path d="${HOSP_PIN_PATH}" fill="none" stroke="#ffffff" stroke-width="${tiny ? 5 : 3.4}" stroke-linejoin="round"/>` +
    `<path d="${HOSP_PIN_PATH}" fill="${c.color}" stroke="${c.ring}" stroke-width="${tiny ? 2.4 : 1.4}" stroke-linejoin="round"${dash}/>` +
    (tiny ? "" : `<path d="M12 6.6v10M7 11.6h10" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>`) +
    `</svg>`
  );
}

// Defined locally on purpose. The other views declare their own copy in
// reach_view.js / grid_analysis.js / severity_heatmap.js, none of which load on
// this page — referencing theirs throws a ReferenceError and kills init().
// Vehicle capability, not vehicle count, is what makes a grid covered. ALS is
// the only tier that can manage a critical airway, so it gets the strongest
// colour; BLS is the workhorse; the transport types are deliberately muted
// grey so they never read as trauma cover on the map.
const VEHICLE_STYLE = {
  ALS: { color: "#b91c1c", ring: "#7f1d1d", glyph: "A", label: "ALS — Advanced Life Support", priority: 300 },
  BLS: { color: "#2563eb", ring: "#1e3a8a", glyph: "B", label: "BLS — Basic Life Support", priority: 200 },
  PTA: { color: "#94a3b8", ring: "#64748b", glyph: "P", label: "PTA — Patient Transport", priority: 100 },
  KILKARI: { color: "#a78bfa", ring: "#6d28d9", glyph: "K", label: "Kilkari — Maternal Transport", priority: 100 },
  NEONATE: { color: "#f59e0b", ring: "#b45309", glyph: "N", label: "Neonate Transport", priority: 100 },
  OTHER: { color: "#cbd5e1", ring: "#94a3b8", glyph: "?", label: "Unclassified", priority: 50 },
};
const VEHICLE_ORDER = ["ALS", "BLS", "PTA", "KILKARI", "NEONATE"];

const SEVERITY_COLORS = {
  Fatal: "#dc2626",
  "Grievous Injury": "#f97316",
  "Minor Injury Hospitalized": "#eab308",
  "Minor Injury Non-Hospitalized": "#84cc16",
  "Non-Injury": "#94a3b8",
};
const SEVERITIES = Object.keys(SEVERITY_COLORS);

const state = {
  tab: "proximity",
  // App-wide "include Empanelled Private" toggle — one switch in the header,
  // read by every Proximity/Gaps query and by every level-enumeration UI
  // helper (see visibleLevels() below). Ambulance is untouched: ambulance
  // reach is about ambulance stations, never hospital levels.
  includeEP: true,
  // Proximity tab mode: "overall" | "grid" | "hospital"; proxLevel applies to
  // the hospital mode's L1/L2/L3 sub-tabs only.
  proxMode: "overall",
  proxLevel: "L1",
  proxOverview: null,
  /* Overall/Grid grid colouring is the FOUR-BAND reach verdict, per the
     23 Aug 2026 spec: how many of the three conditions a grid satisfies —
     >=1 L1 within 60 km, >=1 L2 within 30 km, >=1 L3 within 10 km.
       3 met -> light yellow      1 met  -> orange
       2 met -> yellow            0 met  -> red
       "P"   -> purple, the override: no public level in reach, but an
                empanelled private hospital is. See PROX_BAND_KEYS.
     proxBandFilter is the clickable-legend filter holding the band keys
     currently drawn; clicking a legend band toggles its key in or out. */
  proxBandFilter: new Set([3, 2, 1, 0, "P"]),
  proxVerdict: null,
  proxLevelData: null,
  proxLevelVerdict: null,
  /* Hospital mode's own filter, same click-to-toggle idea as proxBandFilter
     but for the binary in-reach/not-in-reach split. Defaults to "ok" only —
     24 Aug 2026: the point of picking one level is to see what it actually
     reaches, so the grids that DON'T is the noise, not the story. Click the
     "not in reach" swatch to bring those back for comparison. */
  proxLevelFilter: new Set(["ok"]),
  proxSelection: null,
  proxRoutesAvailable: false,
  // Which grid (if any) is dimmed-and-highlighted for. Drives proxGridStyle's
  // fade of everything else and the bright ring on the selected cell. Kept
  // separate from proxSelection (which is about drawn branches) because
  // Overall mode selects a grid via its native popup with no branches at all.
  proxSelectedGridId: null,
  // The payload behind whichever detail view is open, kept so picking a row
  // can draw its route without a second fetch. proxGridDetail is Grid mode's
  // /proximity/grid/<id> response; proxHospDetail is Hospital mode's
  // /proximity/hospital/<s_no>. proxPicked is the index of the branch whose
  // route is on the map right now, or null when none is.
  proxGridDetail: null,
  proxHospDetail: null,
  proxPicked: null,
  // The popup body element for Hospital mode, so picking a row can restyle the
  // list in place. Rebuilding the content would make Leaflet re-anchor and
  // re-pan the popup on every click, which reads as the map twitching.
  proxHospListEl: null,
  // grid_id -> {shape, g, asCells, basePaint} for every currently-drawn grid.
  // Lets a selection change repaint in place with .setStyle() instead of
  // clearing and rebuilding the whole 6,760-shape layer, which would also
  // orphan whatever popup just triggered the selection.
  proxGridLayers: null,
  meta: null,
  coverage: null,
  mode: "time",
  thresholds: {},
  loading: false,
  // Optional overlays, fetched lazily the first time they're switched on.
  hospitals: null,
  accidents: null,
  hospTypes: new Set(HOSP_TYPES.map((t) => t.code)),
  hospLevels: new Set(["L1", "L2", "L3", "EP"]),
  /* Context pins — real facilities that provide no L1/L2/L3 under the spec.
     They have their own legend row, so they get their own filter rather than
     riding on the level set they are by definition not in. */
  hospContext: true,
  severities: new Set(SEVERITIES),
  // Remembers whether the all-grids backdrop was on before the in-reach layer
  // replaced it, so switching back restores what the user had.
  gridsWasOn: true,
  // Deliverable 3 state — gap identification only, against current stations.
  ambGaps: null,
  ambGapIds: null,
  ambulances: null,
  ambulanceCounts: null,
  ambColour: "distance",
  /* CLICKABLE LEGENDS (31 Aug 2026). Every legend that keys a colour to a
     category is now a multi-select filter, the same idea proxBandFilter
     already used on Proximity: the set holds the keys currently DRAWN, all of
     them at first, and clicking a row toggles its key in or out. Kept per
     colouring mode rather than one shared set, because "reach band 2" and
     "severity band 2" are different questions that happen to share a colour —
     hiding one must not silently hide the other when you switch modes. */
  ambBandFilter: new Set([3, 2, 1, 0]),
  ambTssFilter: new Set([3, 2, 1, 0]),
  /* Which ambulance feed the tab is showing: "old" = the 569-vehicle fleet this
     tab was built on, "new" = the partner's filtered workbook (142 stations
     with a day + time period each). Defaults to "old" so the tab opens on the
     dataset every existing number was quoted from. */
  ambDataset: "old",
  ambV2Stations: null,
  // Deliverable 1 state: hospital -> grids.
  hospCoverage: null,
  selectedHospital: null,
  uncovered: null,
  // Deliverables A + B: one L1/L2/L3 pass, two views. Radii default to the
  // spec (60/30/10) and are shared by both tabs.
  levelReach: null,
  levelKm: { L1: 60, L2: 30, L3: 10, EP: 60 },
  levelMode: "complement",
  gapColour: "levels",
  // Same idea as ambBandFilter, for the Gaps tab's two colourings.
  gapBandFilter: new Set([3, 2, 1, 0]),
  gapTssFilter: new Set([3, 2, 1, 0]),
  districtTss: null,
  // Deliverable A scopes each hospital to its own level's radius by default.
  perLevel: true,
  bloodbanks: null,
  bloodbanksMeta: null,
  // --- Gaps segmentation -------------------------------------------------
  // "level" runs the L1/L2/L3 pass; "type" runs the parallel per-facility-type
  // pass (/api/analytics/type-reach). segLevels/segTypes hold the active subset
  // within each; empty set means "all", which is what the All toggle sets.
  gapSegment: "level",
  segLevels: new Set(),
  segTypes: new Set(),
  typeReach: null,
  typeKm: {},
  // --- Radar -------------------------------------------------------------
  radarHospital: null,
  radarGrid: null,
  // The Gaps radar can be centred on a gap cell OR on a hospital icon —
  // whichever was clicked last. Keeping both targets means switching back and
  // forth does not lose the other one.
  radarGapHospital: null,
  gapRadarKind: "grid",
  // --- Grid ID search ----------------------------------------------------
  searchMarker: null,
  districtBounds: {},
  districtFocus: null,
  // Which district currently has its boundary drawn. Also the guard that lets
  // a slow boundary fetch tell it has been superseded.
  districtOutlined: null,
  // Which sidebar section each view is showing. Per view, not global: you may
  // well want Gaps on Charts while Proximity stays on Controls.
  sub: { proximity: "controls", gaps: "controls", ambulance: "controls" },
  // "old" = our colour rules, untouched. "new" = the reference app's palette.
  gridPalette: "old",
  // Which of the four reference bands is isolated, or null for all.
  theirBandFilter: null,
};

const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView([29.2, 76.3], 8);
initMapMeasure(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
L.control.zoom({ position: "topright" }).addTo(map);

/* The selected district is drawn in TWO panes, deliberately split around the
   data. The tinted fill sits BELOW the analysis cells (zIndex 350, above the
   tiles at 200) so it colours the basemap inside the district without washing
   out a single choropleth cell — a fill painted on top would mute exactly the
   colours the map exists to show. The outline sits ABOVE the vector overlays
   (455, below markerPane at 600) so it is never buried under a dense field of
   cells, while hospital and ambulance icons still draw over it.

   pointer-events:none on both. A district polygon covers thousands of grid
   cells; without this it would swallow every click meant for the data beneath
   it, and the popups would simply stop opening inside the selected district. */
[
  ["districtFillPane", 350],
  ["districtLinePane", 455],
].forEach(([name, z]) => {
  const pane = map.createPane(name);
  pane.style.zIndex = String(z);
  pane.style.pointerEvents = "none";
});

const layers = {
  districtShape: L.layerGroup().addTo(map),
  grids: L.layerGroup().addTo(map),
  // Proximity modes 2 and 3 draw road-route branches here. Its own group so a
  // grid repaint never wipes the routes, and clearing the routes never
  // disturbs the grids.
  proxBranches: L.layerGroup().addTo(map),
  // The halo ring around whichever facility is currently the endpoint of the
  // drawn route. Separate from proxBranches so re-picking a route can swap the
  // line without the ring flickering, and so clearing one never clears the
  // other by accident.
  proxHighlight: L.layerGroup().addTo(map),
  hospitals: L.layerGroup(),
  hospitalGrids: L.layerGroup(),
  inReach: L.layerGroup(),
  bloodbanks: L.layerGroup(),
  accidents: L.layerGroup(),
  ambCurrent: L.layerGroup(),
  ambGaps: L.layerGroup(),
  ambCovered: L.layerGroup(),
  gapAmbulances: L.layerGroup(),
  search: L.layerGroup(),
};

// Two independent radars so switching tabs doesn't destroy the other tab's
// centre — each remembers where it was pointed.
const radar = {
  /* gridLayers lets the radar light the cells the pulse passes over. It is a
     getter, not the Map itself, because renderGrids() REPLACES
     state.proxGridLayers on every repaint — handing over the object once would
     leave the radar glowing a set of paths that had already been torn out of
     the DOM. */
  proximity: createRadarOverlay(map, {
    color: "#0d9488",
    gridLayers: () => state.proxGridLayers,
  }),
  /* No gridLayers for the Gaps radar yet: renderTierGaps() builds its own
     layer and does not keep an id -> shape index the way renderGrids() does.
     The rings and pulse work there; only the per-cell glow is absent, and it
     degrades silently rather than pointing at a state key that does not
     exist. */
  gaps: createRadarOverlay(map, { color: "#dc2626" }),
};

// ---------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);

function setStatus(msg, isError = false) {
  const el = $("status-line");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

function fmt(n, d = 1) {
  return n === null || n === undefined || Number.isNaN(n) ? "—" : Number(n).toFixed(d);
}

// Green -> amber -> red. `t` is 0 (best) to 1 (worst).
function rampRisk(t) {
  const c = Math.max(0, Math.min(1, t));
  if (c < 0.5) {
    const k = c / 0.5;
    return `rgb(${Math.round(22 + k * 212)},${Math.round(163 - k * 19)},${Math.round(74 - k * 58)})`;
  }
  const k = (c - 0.5) / 0.5;
  return `rgb(${Math.round(234 - k * 14)},${Math.round(144 - k * 106)},${Math.round(16 + k * 22)})`;
}

/* Severity, quantised into the SAME four Proximity bands (PROX_MET_COLOR)
   instead of its own continuous ramp — one colour language across every tab
   and every colouring mode, not just the reach/distance ones. `p95` is the
   95th percentile of whatever's on screen (fitted per render, same as the
   old continuous ramp was), so the four bands are quartiles of that. Higher
   severity is worse, so it lands in the "red" band — same direction as
   "no levels/reach met". */
function severityBandIndex(score, p95) {
  const t = p95 > 0 ? Math.min((score || 0) / p95, 1) : 0;
  return t < 0.25 ? 3 : t < 0.5 ? 2 : t < 0.75 ? 1 : 0;
}
function bandColorForSeverity(score, p95) {
  return PROX_MET_COLOR[severityBandIndex(score, p95)];
}
// Legend companions for bandColorForSeverity -- same band keys (3=best..0=worst).
const SEVERITY_BAND_ORDER = [3, 2, 1, 0];
const SEVERITY_BAND_LABEL = { 3: "Low", 2: "Moderate", 1: "High", 0: "Highest" };
function severityBandRange(band, p95) {
  const lo = band === 3 ? 0 : band === 2 ? 0.25 : band === 1 ? 0.5 : 0.75;
  const hi = band === 3 ? 0.25 : band === 2 ? 0.5 : band === 1 ? 0.75 : 1;
  return band === 0 ? `${fmt(p95 * hi, 1)}+` : `${fmt(p95 * lo, 1)}–${fmt(p95 * hi, 1)}`;
}

async function getJSON(url) {
  const res = await fetch(apiUrl(url));
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// -------------------------------------------------------- grid ID search
/* MOVED OUT OF THE SIDEBAR, 24 Aug 2026. The markup lives in the template
   inside <main class="map-wrap"> (#grid-search-control); Leaflet adopts that
   exact node into its top-right control corner, immediately after the zoom
   control, so the search icon sits directly under the +/- buttons.

   Adopting the existing node rather than building one in JS keeps every id
   (#grid-search, #btn-grid-search, #grid-search-note, #grid-search-result)
   pointing at the same elements the search functions below already use, so
   none of them needed to change. */
function setGridSearchOpen(open) {
  const wrap = $("grid-search-control");
  const body = $("grid-search-body");
  const btn = $("grid-search-toggle");
  if (!wrap || !body || !btn) return;
  wrap.classList.toggle("is-open", open);
  body.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) $("grid-search")?.focus();
  else clearGridSearch();
}

function initGridSearchControl() {
  const el = document.getElementById("grid-search-control");
  if (!el || typeof map === "undefined" || !map) return;

  const Ctl = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      el.hidden = false;
      // Without these, typing in the field pans the map and the scroll wheel
      // zooms it out from under the results list.
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
      return el;
    },
    // Leaflet would otherwise remove the node from the DOM entirely; the ids
    // have to survive so a later re-add finds them.
    onRemove() {},
  });
  map.addControl(new Ctl());

  $("grid-search-toggle")?.addEventListener("click", () =>
    setGridSearchOpen(!$("grid-search-control")?.classList.contains("is-open"))
  );
}

// Shared by all three tabs. Hits the cheap locate endpoint (no OSRM join), so
// an unknown ID comes back as a fast 404 rather than a slow one.
async function searchGridId(raw) {
  const box = $("grid-search-result");
  const id = String(raw ?? "").trim();
  box.classList.remove("hidden", "ok", "error");

  if (!id) {
    box.classList.add("error");
    box.textContent = "Enter a grid ID first.";
    return;
  }

  box.textContent = "Searching…";
  let hit;
  try {
    hit = await getJSON(
      `/api/analytics/locate-grid/${encodeURIComponent(id)}?year=${state.meta?.year || 2025}`
    );
  } catch (err) {
    box.classList.add("error");
    // The endpoint returns this exact string on 404; anything else is a real
    // failure and should say so rather than claim the grid is missing.
    box.textContent = /doesn't exist/i.test(err.message)
      ? `Grid id doesn't exist — no cell ${id} in ${state.meta?.year || "the current year"}.`
      : err.message;
    layers.search.clearLayers();
    return;
  }

  layers.search.clearLayers();
  layers.search.addTo(map);

  // A pulsing ring plus a permanent label: findable after the zoom settles, and
  // obviously distinct from the analysis layers underneath it.
  layers.search.addLayer(
    L.circleMarker([hit.lat, hit.lon], {
      radius: 14,
      color: "#2563eb",
      weight: 3,
      fillColor: "#2563eb",
      fillOpacity: 0.15,
      className: "grid-search-pin",
    })
  );
  layers.search.addLayer(
    L.circleMarker([hit.lat, hit.lon], {
      radius: 4,
      color: "#1d4ed8",
      weight: 2,
      fillColor: "#fff",
      fillOpacity: 1,
    }).bindTooltip(`Grid ${hit.grid_id}`, {
      permanent: true,
      direction: "top",
      offset: [0, -10],
      className: "measure-point-label",
    })
  );

  map.flyTo([hit.lat, hit.lon], Math.max(map.getZoom(), 12), { duration: 0.8 });

  box.classList.add("ok");
  box.innerHTML = `
    <div class="detail-title">Grid ${hit.grid_id}</div>
    <dl>
      <dt>District</dt><dd>${hit.district || "—"}</dd>
      <dt>Coordinates</dt><dd>${fmt(hit.lat, 5)}, ${fmt(hit.lon, 5)}</dd>
      <dt>Severity</dt><dd>${hit.severity_score ?? "—"}</dd>
      <dt>Hospitals in cache</dt><dd>${hit.n_candidates ?? "—"}</dd>
    </dl>
    <p class="panel-note">Click the ringed cell on the map for its full record.</p>
    <button type="button" class="btn-ghost" id="btn-grid-search-clear">Clear pin</button>`;

  $("btn-grid-search-clear")?.addEventListener("click", clearGridSearch);
  setStatus(`Grid ${hit.grid_id} — ${hit.district}.`);
}

function clearGridSearch() {
  layers.search.clearLayers();
  map.removeLayer(layers.search);
  const box = $("grid-search-result");
  box.classList.add("hidden");
  box.classList.remove("ok", "error");
  box.innerHTML = "";
  $("grid-search").value = "";
}

// ------------------------------------------------------------------ radar
// Ring sets are chosen so each band means something: on Proximity they mirror
// the spec radii, on Gaps they are the live L1/L2/L3 sliders.
const RING_COLORS = ["#0d9488", "#0891b2", "#6366f1", "#a855f7", "#ec4899"];

function proximityRingSet() {
  const raw = $("prox-radar-rings")?.value || "10,30,60";
  return raw
    .split(",")
    .map((s) => parseFloat(s))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((km, i) => ({ km, label: `${km} km`, color: RING_COLORS[i % RING_COLORS.length] }));
}

function updateProximityRadar() {
  const on = $("prox-radar")?.checked;
  const note = $("prox-radar-note");
  if (!on || state.tab !== "proximity" || !state.radarHospital) {
    radar.proximity.hide();
    if (note) {
      note.textContent = !on
        ? "Radar off."
        : state.radarHospital
        ? "Radar shows on the Proximity tab."
        : "Pick a hospital above, or click any hospital icon on the map, to centre the radar.";
    }
    return;
  }
  const h = state.radarHospital;
  radar.proximity.setAnimate($("prox-radar-sweep")?.checked !== false);
  radar.proximity.show([h.lat, h.lon], proximityRingSet());
  if (note) {
    note.innerHTML =
      `Centred on <b>${h.name}</b>` +
      (h.level ? ` &mdash; ${h.level}, own reach ${state.levelKm[h.level] ?? "—"} km` : "") +
      `. Click any other hospital icon to move it.`;
  }
}

function updateGapRadar() {
  const on = $("gap-radar")?.checked;
  const note = $("gap-radar-note");
  const kind = state.gapRadarKind;
  const target = kind === "hospital" ? state.radarGapHospital : state.radarGrid;

  if (!on || state.tab !== "gaps" || !target) {
    radar.gaps.hide();
    if (note) {
      note.textContent = !on
        ? "Radar off."
        : "Click a gap cell — or any hospital icon — on the map to centre the radar.";
    }
    return;
  }

  const r = levelRadii();
  const own = kind === "hospital" ? (target.hosp_level || "").toUpperCase() : null;

  // Rings ARE the service levels here, so they wear the level colours rather
  // than a generic ring ramp — the L1 ring is L1's colour on the map, in the
  // legend and in every chart. A hospital's own level is drawn solid and the
  // other two recede: they are context for what this facility is NOT.
  radar.gaps.setAnimate($("gap-radar-sweep")?.checked !== false);
  radar.gaps.show(
    [target.lat, target.lon],
    visibleLevels().filter((lv) => r[lv] !== undefined).map((lv) => ({
      km: r[lv],
      label: `${lv} · ${r[lv]} km${own && lv === own ? " — this facility" : ""}`,
      color: own && lv !== own ? "#94a3b8" : LEVEL_COLOR[lv],
    }))
  );

  if (!note) return;
  if (kind === "hospital") {
    note.innerHTML =
      `Centred on <b>${target.name || "hospital"}</b> &mdash; ` +
      (own ? `<b style="color:${LEVEL_COLOR[own] || "#64748b"}">${own}</b>, ` : "") +
      `${target.hosp_type || "?"}, ${target.district || "?"}. ` +
      (own
        ? `Its own ring is ${r[own]} km; the greyed rings are the other levels for scale.`
        : `This facility carries no L1/L2/L3 assignment, so no ring is its own.`) +
      ` Click a gap cell to switch back.`;
  } else {
    note.innerHTML =
      `Centred on grid <b>${target.grid_id}</b> &mdash; ${target.district}. ` +
      `Click a hospital icon to centre on a facility instead.`;
  }
}

function syncRadars() {
  updateProximityRadar();
  updateGapRadar();
}

/* ------------------------------------------------- district highlighting
   The 22 Haryana outlines are fetched once and held for the session. The
   payload is ~200 KB, so refetching on every district change would be waste;
   caching a promise (not the result) means two near-simultaneous callers share
   one request instead of racing two.

   The highlight is deliberately ACHROMATIC — white casing under a dark slate
   line, over a barely-there slate wash. Every saturated hue on this map already
   means something specific (L1 violet, L2 orange, L3 teal, ALS red, BLS blue,
   plus the gap choropleth), so a coloured boundary would read as another data
   category. A dark line with a light casing is the standard cartographic
   treatment for an administrative edge: unmistakable against both the pale
   basemap and a dense red gap field, and it claims no meaning it does not have. */
const DISTRICT_STYLE = {
  casing: { color: "#ffffff", weight: 7, opacity: 0.95, fill: false, lineJoin: "round" },
  line: { color: "#1f2a3d", weight: 2.6, opacity: 0.95, fill: false, lineJoin: "round" },
  fill: { stroke: false, fillColor: "#334155", fillOpacity: 0.1 },
};

let districtShapesPromise = null;

function ensureDistrictShapes() {
  if (!districtShapesPromise) {
    districtShapesPromise = getJSON("/api/districts/boundaries").catch((err) => {
      // Do not cache a failure — a transient 500 should not disable the
      // highlight for the rest of the session.
      districtShapesPromise = null;
      throw err;
    });
  }
  return districtShapesPromise;
}

function districtFeature(shapes, name) {
  const want = String(name || "").trim().toUpperCase();
  return (shapes?.features || []).find(
    (f) => String(f.properties?.district || "").toUpperCase() === want
  );
}

/* ---------- is this facility ACTUALLY in the selected district? ----------
   The district filters used to compare hospital.district against the dropdown
   — a LABEL test. hospital_tpl.csv disagrees with itself on that: 36 rows
   carry a district_name normalising to FARIDABAD while their GPS is spread
   from lon 75.71 (Hisar) to lat 30.38 (Panchkula), and 22 of those 36 are
   empanelled private. The label filter did exactly what it was told and drew
   every one of them, which is why EP pins kept landing outside the outline.

   On a MAP the pin's position is the claim being made, so the boundary — the
   same polygon already drawn as the outline — is the honest test. Falls back
   to the label comparison when no polygon is loaded, so a failed boundary
   fetch degrades to the old behaviour rather than emptying the layer. */
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// polygon = [outerRing, ...holes]. A point in a hole is outside the polygon.
function pointInPolygonCoords(x, y, polygon) {
  if (!polygon?.length || !pointInRing(x, y, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) if (pointInRing(x, y, polygon[i])) return false;
  return true;
}

function pointInFeature(lon, lat, feature) {
  const g = feature?.geometry;
  if (!g) return false;
  if (g.type === "Polygon") return pointInPolygonCoords(lon, lat, g.coordinates);
  if (g.type === "MultiPolygon")
    return (g.coordinates || []).some((p) => pointInPolygonCoords(lon, lat, p));
  return false;
}

/** The cached boundary for `name`, or null if a different one is loaded. */
function districtPolyFor(name) {
  if (!name) return null;
  return normDistrict(state.districtPolyName) === normDistrict(name)
    ? state.districtPolyFeature || null
    : null;
}

/**
 * One district test for every pin layer. Returns true when the feature should
 * be DROPPED. Geometry when we have it, label when we do not.
 */
function outsideDistrict(lon, lat, labelDistrict, want) {
  if (!want) return false;
  const poly = districtPolyFor(want);
  if (poly) return !pointInFeature(lon, lat, poly);
  return normDistrict(labelDistrict) !== normDistrict(want);
}

/* ---------- get_layer: live district boundary --------------------------
   Their gis_layer/get_layer answers with the FeatureCollection for exactly the
   district requested, so there is no lookup-by-name the way the offline path
   needs districtFeature() — the one feature they send back IS the answer.
   Their envelope keys this `data`, not `details` (the only endpoint that
   differs), and `properties` on the feature is an empty STRING, not an object;
   the real fields are hoisted onto the feature. We read none of them, because
   one requested district means one feature and no matching is needed. */
async function districtShapeLive(name) {
  const raw = await rbgCall("get_layer", { district_name: name });
  const feature = raw?.data?.features?.[0];
  if (!feature) throw new Error("get_layer: no feature in response");
  return feature;
}

async function highlightDistrict(name) {
  layers.districtShape.clearLayers();
  state.districtOutlined = name || null;
  if (!name) {
    // Back to All districts: drop the cached polygon and repaint, or the pin
    // layers keep filtering against a boundary that is no longer selected.
    state.districtPolyName = null;
    state.districtPolyFeature = null;
    repaintDistrictScopedLayers();
    return;
  }

  let feature = null;

  if (partnerUsable()) {
    try {
      feature = await districtShapeLive(name);
    } catch (err) {
      // Identical geometry either way — this only failed to say "theirs"
      // instead of "ours". Fall back rather than leaving no outline at all.
      setLiveStatus("get_layer", "fallback", err.message);
      console.warn("get_layer unavailable, using offline boundary:", err.message);
    }
    // Picked a different district mid-fetch — drop the stale answer.
    if (state.districtOutlined !== name) return;
  }

  if (!feature) {
    let shapes;
    try {
      shapes = await ensureDistrictShapes();
    } catch (err) {
      // The map still works without an outline; say so once and move on rather
      // than throwing into a change handler that has other work to finish.
      console.warn("district boundaries unavailable:", err);
      return;
    }

    // A slower fetch may land after the user has already picked a different
    // district — drop the stale result instead of drawing the wrong outline.
    if (state.districtOutlined !== name) return;

    feature = districtFeature(shapes, name);
    if (!feature) {
      console.warn(`no boundary polygon for district "${name}"`);
      return;
    }
  }

  /* Cache the polygon the outline is drawn from, so the pin layers can test
     against the SAME geometry the user is looking at, then repaint them —
     highlightDistrict is async and the change handlers call the renderers
     before this resolves. */
  state.districtPolyName = name;
  state.districtPolyFeature = feature;
  repaintDistrictScopedLayers();

  layers.districtShape.addLayer(
    L.geoJSON(feature, {
      pane: "districtFillPane",
      interactive: false,
      renderer: L.svg({ pane: "districtFillPane" }),
      style: DISTRICT_STYLE.fill,
    })
  );
  // Casing first, line second — the white halo must sit UNDER the dark stroke.
  [DISTRICT_STYLE.casing, DISTRICT_STYLE.line].forEach((style) => {
    layers.districtShape.addLayer(
      L.geoJSON(feature, {
        pane: "districtLinePane",
        interactive: false,
        renderer: L.svg({ pane: "districtLinePane" }),
        style,
      })
    );
  });
}

/* ---------- partner reachability gate ----------------------------------
   Retiring the Old/New switch removed more than a colour choice: that switch
   was also the demo safety net. With no venue wifi you flipped to Old and
   every popup was instant. Without it, an unreachable partner API would make
   the district outline and every popup sit out the proxy's 8 s timeout before
   falling back — four clicks and you are a minute behind.

   So a single health probe now decides whether live calls are attempted at
   all. Unreachable means callers skip straight to the offline answer with no
   delay, which is exactly what Old mode used to give, without the user having
   to know to flip anything. `null` means not yet probed — treated as usable,
   so a slow probe never blocks the first paint. */
let partnerReachable = null;

function partnerUsable() {
  return liveOn() && partnerReachable !== false;
}

async function probePartner() {
  try {
    const h = await (await fetch(apiUrl("/api/rbg/health"))).json();
    partnerReachable = !!h.reachable;
    if (!h.reachable) {
      // Only the feeds we actually consume — marking an unwired endpoint as
      // failed would claim a failure that never happened.
      LIVE_FEEDS.forEach((f) => setLiveStatus(f, "fallback", h.reason));
    }
  } catch {
    partnerReachable = false;
  }
  renderLiveStatus();
}

// Bound to the Retry link in the status panel.
async function retryPartner() {
  partnerReachable = null;
  liveGridSeverity = null;
  liveGridSeverityKey = null;
  state.fpStatsCache = {};
  hospGpsPromise = null;
  renderLiveStatus();
  await probePartner();
  if (partnerReachable) {
    await refreshLiveGridSeverity();
    highlightDistrict(currentDistrict());
  }
}

/* ---------- acc_grid_data: live severity grid ---------------------------
   Swaps the COLOUR input for the Proximity map from our cached file to their
   live feed. Hospital-reach numbers (nearest hospital, road km, drive min)
   are our own analysis and never came from this endpoint — those stay on
   /api/analytics/coverage. Only severity_score, the value that decides which
   of the four bands a cell lands in, changes source.

   THEIR ENVELOPE HERE IS INFERRED, NOT VERIFIED. get_layer and grid_data have
   been confirmed against real responses (data/rbg_probe/); acc_grid_data has
   not. This shape — `details` as the envelope key, grid_id/severity_score
   hoisted onto the Feature rather than under .properties — is read off their
   source, the same pattern get_layer turned out to follow. Re-run
   scripts/probe_rbg_api.py and diff the real response before trusting this in
   a demo. If the shape differs the map degrades cell-by-cell to our cached
   numbers rather than breaking, but that fallback should not be the first
   time anyone checks. */
let liveGridSeverity = null;   // Map<grid_id, severity_score> | null
let liveGridSeverityKey = null; // "<district>|<year>" the map above covers

/* Read by gridColor() and recomputeTheirBands() so both agree. Falls back PER
   CELL, not per request: their grid and ours are not guaranteed to cover the
   same cells, and one cell missing from their scope should not go uncoloured
   because the rest of the district loaded fine. */
function liveGridSeverityFor(grid) {
  if (!liveGridSeverity) return grid.severity_score;
  const v = liveGridSeverity.get(String(grid.grid_id));
  return v !== undefined ? v : grid.severity_score;
}

async function refreshLiveGridSeverity() {
  if (!partnerUsable()) return;
  const district = state.tab === "proximity" ? $("prox-district")?.value : "";
  const year = state.meta?.year || "2025";
  const key = `${district || ""}|${year}`;

  if (liveGridSeverityKey === key && liveGridSeverity) {
    // Already loaded for this scope. Still repaint: this can be called right
    // after a load whose synchronous paint used the cached numbers.
    recomputeTheirBands();
    renderGrids();
    renderLegend();
    return;
  }

  try {
    const raw = await rbgCall("acc_grid_data", { district_name: district || "", year });
    const features = raw?.details?.features || [];
    const m = new Map();
    features.forEach((f) => {
      const gid = f.grid_id ?? f.properties?.grid_id;
      const sev = f.severity_score ?? f.properties?.severity_score;
      if (gid !== undefined && sev !== undefined && Number.isFinite(Number(sev))) {
        m.set(String(gid), Number(sev));
      }
    });

    // A slow answer can land after the user moved on — drop it rather than
    // painting one district's severity onto another's cells.
    if (state.tab === "proximity" && $("prox-district")?.value !== district) return;

    liveGridSeverity = m;
    liveGridSeverityKey = key;
  } catch (err) {
    // Keep whatever was loaded before. A transient timeout on a refresh must
    // not blank a map that is already showing good live data.
    setLiveStatus("acc_grid_data", "fallback", err.message);
  }

  recomputeTheirBands();
  renderGrids();
  renderLegend();
}

function applyNewModeChrome() {
  state.gridPalette = "new";

  const group = $("prox-colour-group");
  if (group) {
    group.classList.add("disabled");
    group.querySelectorAll("input").forEach((i) => (i.disabled = true));
  }
  document.querySelector(".palette-bar")?.classList.add("is-new");

  const note = $("palette-note");
  if (note) {
    note.innerHTML = `On the Proximity map the colour modes below are
      unavailable, because this view colours by severity only.`;
  }
}

// Whichever district select belongs to the tab in view. Each tab has its own,
// and they are independent on purpose — comparing district A on Gaps against
// district B on Proximity is a real workflow.
function currentDistrict() {
  const id =
    state.tab === "gaps" ? "gap-district" : state.tab === "ambulance" ? "amb-district" : "prox-district";
  return $(id)?.value || "";
}

// Called on every tab change so the outline follows the tab's own selection
// rather than lingering from the tab you just left.
function syncDistrictHighlight() {
  highlightDistrict(currentDistrict());
}

// ------------------------------------------------------- district framing
// Bounds ship with /api/analytics/meta, so selecting a district reframes the
// map without a round trip.
function zoomToDistrict(name) {
  if (!name) {
    state.districtFocus = null;
    map.flyToBounds(
      [
        [27.6, 74.4],
        [30.99, 77.7],
      ],
      { padding: [24, 24], duration: 0.7 }
    );
    return;
  }
  const b = state.districtBounds?.[name];
  state.districtFocus = name;
  if (!b) return;
  map.flyToBounds(
    [
      [b.south, b.west],
      [b.north, b.east],
    ],
    { padding: [36, 36], duration: 0.8 }
  );
}

// Out-of-district cells stay on the map but drop to a fraction of their normal
// opacity — context without competing for attention. Returns the multiplier a
// renderer should apply.
function districtDim(featureDistrict) {
  const focus = state.tab === "proximity" ? $("prox-district")?.value : "";
  if (!focus) return 1;
  return featureDistrict === focus ? 1 : 0.12;
}

// ------------------------------------------------------------------- tabs
/* The three views, as the rail and the URL know them. Kept beside showTab so a
   fourth view cannot be added to the rail without also being named here. */
const VIEWS = {
  proximity: {
    step: "1",
    name: "Proximity",
    path: "/proximity",
    blurb: "Nearest hospital to every accident grid, by road.",
  },
  gaps: {
    step: "2",
    name: "Coverage gaps",
    path: "/gaps",
    blurb: "Grids with no hospital of a given level within its radius.",
  },
  ambulance: {
    step: "3",
    name: "Ambulances",
    path: "/ambulances",
    blurb: "Grids beyond road reach of the nearest emergency vehicle.",
  },
};

const PATH_TO_VIEW = Object.fromEntries(
  Object.entries(VIEWS).map(([k, v]) => [v.path, k])
);


/* ==========================================================================
   Sidebar sub-tabs
   ==========================================================================
   Each view's sidebar is split into four sections — Controls, Charts, Data,
   Map — with the same four in the same order in all three views, so the layout
   is learned once rather than three times. The grouping lives in the TEMPLATE
   (data-sub on each .sub-panel); this file only switches between them, so
   moving a panel from Data to Charts is a template edit and nothing here needs
   to know.

   Everything stays live while hidden. A hidden sub-panel's inputs are still in
   the DOM and still wired, so a threshold set on Controls keeps driving the map
   while you read Charts. Nothing is torn down on switch — that is what makes
   the sections independent rather than modal.

   MAP MEMORY. Each (view, section) can remember where you left the map. It is
   captured ONLY for sections you actually panned, zoomed or re-layered — a
   section you merely looked at stores nothing, and switching to it therefore
   moves nothing. Without that rule, opening Charts for the first time would
   yank the map to wherever some default said, which is the behaviour people
   mean when they say a UI "fights" them. */

const SUBS = ["controls", "charts", "data", "map"];
const SUB_LABEL = { controls: "Controls", charts: "Charts", data: "Data", map: "Map" };

/* Layer toggles worth remembering per section. Deliberately an ALLOWLIST, not
   "every checkbox in the Map panel":
     - prox-private changes which hospitals are in the ANALYSIS and triggers a
       refetch; restoring it silently would re-run a query behind your back.
     - measure-toggle arms the ruler, i.e. it changes what a click on the map
       does. Restoring a tool mode is how you end up dropping a ruler point when
       you meant to open a popup. */
const SUB_LAYER_TOGGLES = {
  proximity: ["layer-grids", "layer-hospitals", "layer-bloodbanks", "layer-accidents",
              "prox-radar", "prox-radar-sweep"],
  gaps: ["gap-layer-hospitals", "gap-layer-ambulances", "gap-radar", "gap-radar-sweep"],
  ambulance: ["amb-layer-gaps", "amb-layer-covered", "amb-layer-current"],
};

const subMemory = {};        // "view/sub" -> { center, zoom, layers }
const subTouched = new Set(); // "view/sub" the user has actually changed the map on

const subKey = (view, sub) => `${view}/${sub}`;

function currentSub(view) {
  return state.sub[view] || "controls";
}

function subMemoryOn() {
  const el = $("sub-map-memory");
  return !el || el.checked;
}

function captureSubMap(view, sub) {
  const key = subKey(view, sub);
  if (!subTouched.has(key)) return; // untouched sections stay opinion-free
  const c = map.getCenter();
  const layers = {};
  (SUB_LAYER_TOGGLES[view] || []).forEach((id) => {
    const el = $(id);
    if (el) layers[id] = el.checked;
  });
  subMemory[key] = { center: [c.lat, c.lng], zoom: map.getZoom(), layers };
}

function restoreSubMap(view, sub) {
  if (!subMemoryOn()) return;
  const snap = subMemory[subKey(view, sub)];
  if (!snap) return;

  // Layers first, then the viewport: a layer that switches on triggers a render
  // which can fit bounds, and we want our own framing to win.
  Object.entries(snap.layers || {}).forEach(([id, want]) => {
    const el = $(id);
    if (el && el.checked !== want) {
      el.checked = want;
      // Dispatch rather than call the handler: these toggles are wired in
      // several places and only the event reaches all of them.
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  if (snap.center && snap.zoom != null) {
    map.setView(snap.center, snap.zoom, { animate: true, duration: 0.4 });
  }
}

/* Mark the section in view as one the user has shaped. `moveend` fires for
   programmatic setView too, so restores are fenced off with a flag — otherwise
   restoring a section would immediately re-mark the section we just left. */
let subRestoring = false;

function markSubTouched() {
  if (subRestoring) return;
  subTouched.add(subKey(state.tab, currentSub(state.tab)));
}

function showSub(view, sub, opts = {}) {
  if (!SUBS.includes(sub)) sub = "controls";
  const prev = currentSub(view);
  if (prev !== sub && view === state.tab) captureSubMap(view, prev);

  state.sub[view] = sub;

  document.querySelectorAll(`.sub-tab[data-view="${view}"]`).forEach((b) => {
    const on = b.dataset.sub === sub;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll(`.sub-panel[data-view="${view}"]`).forEach((p) => {
    p.classList.toggle("hidden", p.dataset.sub !== sub);
  });

  // The sidebar scrolls; landing halfway down the previous section's scroll
  // position on a section that is shorter reads as a rendering fault.
  const aside = document.querySelector(".sidebar-panel");
  if (aside && prev !== sub) aside.scrollTop = 0;

  if (view === state.tab && prev !== sub) {
    subRestoring = true;
    restoreSubMap(view, sub);
    // One frame is not enough — setView's moveend lands later. Release after
    // the animation window instead of guessing a frame count.
    setTimeout(() => { subRestoring = false; }, 550);
  }

  if (!opts.silent) syncViewChrome(view, opts);

  /* No chart redraw is needed here, and that is worth stating so nobody adds
     one. charts.js builds every SVG with a FIXED viewBox (306 wide) plus
     width:100% and preserveAspectRatio, so it never measures its container.
     A chart drawn while its section was display:none is therefore correct the
     moment the section is shown — the viewBox does the scaling. Charts that
     measure clientWidth would need a redraw hook; these do not. */
}

// Which section holds a given element id — used by openPanelFor so clicking a
// map icon can reveal a panel that lives in a section you are not looking at.
function revealSubFor(id) {
  const node = document.getElementById(id);
  const panel = node && node.closest(".sub-panel[data-sub]");
  if (!panel) return;
  const view = panel.dataset.view;
  if (view !== state.tab) showTab(view);
  if (currentSub(view) !== panel.dataset.sub) showSub(view, panel.dataset.sub);
}
window.revealSubFor = revealSubFor;

/* Chrome only: which rail button is lit, which panel is visible, the caption,
   the title, the URL. Deliberately free of data side effects so it can run
   during wiring, before /api/analytics/meta has been fetched — the full
   showTab() below kicks off loads that would fire against an empty state. */
function syncViewChrome(name, opts = {}) {
  const view = VIEWS[name];
  // .tab kept in the selector: the old in-page tab bar is gone, but any button
  // still carrying data-tab (or a future one) should stay in step with the rail.
  document
    .querySelectorAll(".tab, .rail-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".rail-btn").forEach((b) => {
    b.setAttribute("aria-current", b.dataset.tab === name ? "page" : "false");
  });
  document
    .querySelectorAll(".tab-panel")
    .forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== name));

  if ($("view-step")) $("view-step").textContent = view.step;
  if ($("view-name")) $("view-name").textContent = view.name;
  if ($("view-blurb")) $("view-blurb").textContent = view.blurb;
  document.title = `${view.name} — Trauma Network Analytics`;

  /* Push the URL so the rail behaves like navigation: the address bar names the
     view, Back returns to the previous one, and /gaps can be linked directly.
     `replace` is used when we are REACTING to a URL change (initial load,
     popstate) — pushing there would add a duplicate entry and make Back appear
     to do nothing. */
  if (!opts.silent && window.history) {
    // /proximity/charts — the section is part of the address, so a link can
    // point at "the Gaps charts" and not merely at Gaps.
    const sub = currentSub(name);
    const path = sub === "controls" ? view.path : `${view.path}/${sub}`;
    const url = path + window.location.search;
    const st = { tab: name, sub };
    if (opts.replace) history.replaceState(st, "", url);
    else if (window.location.pathname !== path) history.pushState(st, "", url);
  }
}

// Which view the current URL names. One place, so the rail, popstate and the
// initial render cannot disagree about what /gaps means.
function viewFromUrl() {
  return routeFromUrl().view;
}

/* "/gaps/charts" -> { view: "gaps", sub: "charts" }. Tolerant on purpose: an
   unknown or missing section falls back to Controls rather than 404-ing the
   client, because a stale bookmark should still open the view. */
function routeFromUrl() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  const view = PATH_TO_VIEW["/" + (parts[0] || "")] || "proximity";
  const sub = SUBS.includes(parts[1]) ? parts[1] : "controls";
  return { view, sub };
}

function showTab(name, opts = {}) {
  if (!VIEWS[name]) name = "proximity";
  // Leaving a view: bank the section you were on, so coming back to Gaps puts
  // you back on the Gaps chart you were reading, not at its Controls.
  if (state.tab && state.tab !== name) captureSubMap(state.tab, currentSub(state.tab));
  state.tab = name;
  if (opts.sub) state.sub[name] = SUBS.includes(opts.sub) ? opts.sub : "controls";
  syncViewChrome(name, opts);
  showSub(name, currentSub(name), { silent: true });

  // Each view keeps its own district selection, so the outline has to follow
  // the view rather than persist from the one just left.
  syncDistrictHighlight();

  /* Proximity's drawn route, its facility halo, its grid dimming and its
     detail panel are all tab-1 furniture, and nothing else tears them down.
     Without this they survive onto the Gaps and Ambulance maps: a road line
     and an opaque white slab describing a grid cell that is no longer drawn
     anywhere. Cleared BEFORE the grid layer goes, so the de-select repaint
     still has live shapes to repaint. */
  if (name !== "proximity") clearProxBranches();

  layers.grids.clearLayers();
  [layers.ambCurrent, layers.ambGaps, layers.ambCovered].forEach((l) => map.removeLayer(l));
  // Hospital/accident overlays belong to the proximity tab only — they would
  // just obscure the gap and ambulance maps.
  // Hospitals are useful on both the proximity and gap maps, so that layer
  // follows the tab rather than being torn down; accidents and catchments stay
  // tab-1 only, where they would otherwise bury the gap cells.
  if (name !== "proximity") {
    map.removeLayer(layers.accidents);
    map.removeLayer(layers.hospitalGrids);
    map.removeLayer(layers.inReach);
  } else {
    renderAccidents();
    renderInReachLayer();
  }
  if (name === "ambulance") {
    map.removeLayer(layers.hospitals);
    map.removeLayer(layers.bloodbanks);
  } else {
    // The Gaps tab ships with its hospital layer on, so the first visit to it
    // may be the first time anything needs the hospital list.
    if (hospitalLayerToggle()?.checked && !state.hospitals) {
      ensureHospitals().then(renderHospitals).catch(() => {});
    } else {
      renderHospitals();
    }
    renderBloodbanks();
  }

  // The Gaps ambulance layer is tab-2 only.
  if (name !== "gaps") map.removeLayer(layers.gapAmbulances);
  else renderGapAmbulances();

  if (name === "ambulance") {
    if (state.ambGaps) renderAmbulanceGaps();
    else loadAmbulanceGaps();
  } else if (name === "gaps") {
    // Tab 2 owns its own dataset; it does not share the proximity map.
    if (activeGapPayload()) renderGapReach();
    else reloadActiveGapSegment();
  } else if (state.coverage) {
    renderGrids();
    // Without this the status line keeps whatever the previous tab left behind
    // — e.g. "run the optimiser" while you are looking at the proximity map.
    setStatus(`${state.coverage.grids.length.toLocaleString()} grids loaded.`);
  }

  // Each radar belongs to one tab; syncing here hides the other one rather
  // than leaving a stale ring set floating over an unrelated map.
  syncRadars();
  renderLegend();
}

// ------------------------------------------------------------- tier sliders

// --------------------------------------------------------------- rendering
function nearestOverall(grid) {
  let best = null;
  TIERS.forEach((t) => {
    const n = grid.nearest[t];
    if (n && (best === null || n.road_km < best.road_km)) best = n;
  });
  return best;
}

// The colour ramp has to match the data, not a guessed constant. Haryana's
// median grid is 3.3 km from a hospital and p95 is 7.3 km — on a fixed 0-30 km
// ramp that puts 88% of cells in the first fifth and the whole map reads green.
// We stretch the ramp to the 95th percentile of whatever is actually loaded, so
// real variation is visible at every zoom and in every district.
const scaleDomain = { distance: 30, tpl: 80, severity: 40 };

function recomputeScales() {
  const grids = state.coverage?.grids || [];
  if (!grids.length) return;

  const pick = (fn) => {
    const v = grids.map(fn).filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
    if (!v.length) return null;
    v.sort((a, b) => a - b);
    return v[Math.floor(v.length * 0.95)];
  };

  const d95 = pick((g) => nearestOverall(g)?.road_km);
  const s95 = pick((g) => g.severity_score);
  // Round up to something legible on the legend, and never collapse to zero.
  scaleDomain.distance = Math.max(2, Math.ceil((d95 ?? 30) / 2) * 2);
  scaleDomain.severity = Math.max(5, Math.ceil((s95 ?? 40) / 5) * 5);
  // Same trigger, same data: the reference bands are quartiles of whatever set
  // is loaded, so they must be rebuilt wherever our own ramp is.
  recomputeTheirBands();
}

// One grid cell is 1 km. Below this zoom the true footprint is sub-pixel, so we
// draw scaled dots; at or above it we draw the actual cell square.
const CELL_ZOOM = 10;
const CELL_HALF_LAT = 0.0045; // ~500 m

/* ==========================================================================
   Grid palette: "old" (ours) vs "new" (the reference app's)
   ==========================================================================
   A toggle, not a replacement. OLD leaves every existing colour rule exactly as
   it was, so the numbers already reported against this map stay reproducible.
   NEW paints the reference app's four colours — lightyellow / yellow / orange /
   red at fillOpacity 0.7 over a 2px black stroke, their values verbatim.

   THE BAND EDGES ARE OURS, AND THAT IS ON PURPOSE. Their code medians the
   DISTINCT severity scores, which assumes those scores are evenly spread. Ours
   are not: 113 distinct values but 1,608 cells sit on exactly 10.0 and 1,283 on
   5.0. Ported literally, their maths puts 6,194 of our 6,760 cells in the
   palest band — 92% of Haryana one colour, which looks like a broken map rather
   than a finding. So NEW keeps their palette and their stroke, and splits on
   quartiles of CELLS instead. Recomputed per loaded set, as theirs is, so
   filtering to a district re-bins. */
const THEIR_COLORS = ["lightyellow", "yellow", "orange", "red"];

// Filled by recomputeTheirBands(); [{color, start, end, count}] palest first.
let theirBands = [];

function recomputeTheirBands() {
  const grids = state.coverage?.grids || [];
  theirBands = [];
  if (!grids.length) return;

  const vals = grids
    .map((g) => liveGridSeverityFor(g))
    .filter((v) => v !== null && v !== undefined && !Number.isNaN(v))
    .sort((a, b) => a - b);
  if (!vals.length) return;

  const at = (p) => vals[Math.min(vals.length - 1, Math.round(p * (vals.length - 1)))];
  const edges = [vals[0], at(0.25), at(0.5), at(0.75), vals[vals.length - 1]];

  theirBands = THEIR_COLORS.map((color, i) => ({
    color,
    start: edges[i],
    end: edges[i + 1],
    count: 0,
  }));

  grids.forEach((g) => {
    const b = theirBandFor(liveGridSeverityFor(g));
    if (b) b.count += 1;
  });
}

function theirBandFor(score) {
  if (!theirBands.length || score === null || score === undefined) return null;
  for (let i = 0; i < theirBands.length; i += 1) {
    const b = theirBands[i];
    // Last band closes on both ends, as in their code — otherwise the single
    // highest-scoring cell in the state falls through and is never drawn.
    if (i === theirBands.length - 1 ? score >= b.start && score <= b.end : score >= b.start && score < b.end) {
      return b;
    }
  }
  /* Out of range. This happens when the bands are momentarily stale against a
     newly loaded set — and the direction matters: falling back to bands[0]
     would paint the WORST cell in the state the palest colour, which is the
     most misleading possible answer. Clamp to the correct end instead. */
  return score > theirBands[theirBands.length - 1].end ? theirBands[theirBands.length - 1] : theirBands[0];
}

/* OLD MODE IS RETIRED (20 Aug 2026).
   A full snapshot of the app with the working Old/New switch is preserved at
   Archived/mapsR-old-toggle-2026-08-20.zip.

   What was retired is the user-facing SWITCH, not the engine. Every Old code
   path below is still here and still runs: /api/analytics/* supplies the grid
   cells this map paints, the whole sidebar, all the exports, and the fallback
   behind every live call. Retiring the switch changes which of the two answers
   is shown first, not whether the offline one still exists.

   To bring the toggle back: set this to false and un-hide `.palette-switch` in
   templates/network_analytics.html. Nothing else needs touching. */
const OLD_MODE_RETIRED = true;

function gridPalette() {
  if (OLD_MODE_RETIRED) return "new";
  return state.gridPalette === "new" ? "new" : "old";
}

// Tab 1 only. Tab 2 draws its own layer in renderTierGaps().
function gridColor(grid) {
  // The Proximity tab's three modes own their own colouring. Falls through to
  // the palettes below when the verdict for this grid has not loaded yet, so a
  // slow fetch shows the old colours rather than a blank map.
  if (state.tab === "proximity") {
    const px = proxGridStyle(grid);
    if (px) return px;
  }
  if (gridPalette() === "new") {
    const b = theirBandFor(liveGridSeverityFor(grid));
    const color = b ? b.color : THEIR_COLORS[0];
    // Their exact style: black hairline, 0.7 fill. Selecting one band hides the
    // rest outright rather than greying them, which is also their behaviour.
    const sel = state.theirBandFilter;
    const hidden = sel && color !== sel;
    return {
      color,
      radius: 3.6,
      opacity: hidden ? 0 : 0.7,
      outline: "black",
      outlineWeight: 2,
      hidden,
    };
  }

  const how = document.querySelector('input[name="prox-colour"]:checked')?.value || "distance";
  if (how === "severity") {
    const s = Math.min(grid.severity_score / scaleDomain.severity, 1);
    return { color: rampRisk(s), radius: 3 + s * 3, opacity: 0.9 };
  }
  const n = nearestOverall(grid);
  if (!n) return { color: "#dc2626", radius: 5, opacity: 0.95 };
  if (how === "tpl") {
    const tpl = n.tpl ?? null;
    if (tpl === null) return { color: "#94a3b8", radius: 3, opacity: 0.6 };
    return { color: rampRisk(1 - Math.min(tpl / scaleDomain.tpl, 1)), radius: 3.6, opacity: 0.9 };
  }
  return {
    color: rampRisk(Math.min(n.road_km / scaleDomain.distance, 1)),
    radius: 3.4,
    opacity: 0.9,
  };
}

// Dots need to grow as you zoom out or the state view turns into confetti;
// they need to shrink as you zoom in or neighbouring cells merge into a blob.
function dotScale() {
  const z = map.getZoom();
  if (z <= 7) return 0.75;
  if (z === 8) return 1;
  if (z === 9) return 1.5;
  return 2;
}

// The rectangle-cell and circle-dot paint objects, factored out of
// renderGrids so a selection change can recompute and re-apply them with
// .setStyle() on an EXISTING shape (repaintProxSelection) instead of tearing
// down and rebuilding all 6,760 shapes, which would orphan whatever popup
// just triggered the selection in the first place.
function proxCellPaint(style, dim) {
  return {
    color: style.outline || style.color,
    weight: style.outlineWeight ?? 0.6,
    opacity: style.hidden ? 0 : (style.outline ? 1 : 0.9) * dim,
    fillColor: style.color,
    fillOpacity: style.hidden ? 0 : (style.outline ? style.opacity : style.opacity * 0.7) * dim,
  };
}
function proxDotPaint(style, dim) {
  return {
    color: style.outline || style.color,
    weight: style.outline ? (style.outlineWeight ? 1 : 1.4) : 0,
    fillColor: style.color,
    fillOpacity: style.hidden ? 0 : style.opacity * dim,
    opacity: style.hidden ? 0 : dim,
  };
}

function renderGrids() {
  // Tab 1 owns this renderer. Guarding here as well as at every call site,
  // because a stray call from another tab repaints the shared `grids` layer
  // and silently replaces whatever that tab had drawn.
  if (state.tab !== "proximity") return;
  layers.grids.clearLayers();
  state.proxGridLayers = new Map();
  if (!state.coverage) return;
  if ($("layer-grids") && !$("layer-grids").checked && state.tab === "proximity") {
    map.removeLayer(layers.grids);
    $("badge-grids").textContent = 0;
    return;
  }
  const grids = state.coverage.grids;
  const asCells = map.getZoom() >= CELL_ZOOM;
  const scale = dotScale();
  let drawn = 0;


  grids.forEach((g) => {
    const id = String(g.grid_id);
    const style = gridColor(g);
    // Cells outside the selected district fade to context rather than vanish,
    // so the selection reads clearly without losing the surrounding geography.
    const dim = districtDim(g.district);
    const asCell = asCells && !style.covered;
    const basePaint = asCell ? proxCellPaint(style, dim) : proxDotPaint(style, dim);

    let shape;
    if (asCell) {
      // Real 1 km footprint. Longitude degrees shrink with latitude, so the
      // half-width is corrected by cos(lat) — otherwise cells look stretched.
      const halfLon = CELL_HALF_LAT / Math.cos((g.lat * Math.PI) / 180);
      shape = L.rectangle(
        [
          [g.lat - CELL_HALF_LAT, g.lon - halfLon],
          [g.lat + CELL_HALF_LAT, g.lon + halfLon],
        ],
        proxSelectionPaint(id, basePaint)
      );
    } else {
      shape = L.circleMarker([g.lat, g.lon], {
        radius: style.radius * scale,
        ...proxSelectionPaint(id, basePaint),
      });
    }
    state.proxGridLayers.set(id, { shape, g, asCells: asCell, basePaint });

    // On Proximity the Details pane is the mode's own verdict table (routing
    // lives in the Routes tab right alongside it -- see fpLoadRoutes)
    // instead of the generic feature record; everywhere else it stays the
    // generic feature popup. Both are run through the SAME fpShell tab
    // scaffolding so Routes, Nearby, Statistics and Charts all work from
    // either one.
    const proxDetails = state.tab === "proximity" ? proxGridDetails(g) : null;
    shape.bindPopup(
      proxDetails ? fpShell("grid", g, proxGridHead(g), proxDetails) : featurePopup("grid", g),
      { maxWidth: proxDetails ? 460 : 340, className: "feature-popup" }
    );
    // Every grid click opens the same popup now -- routing lives in its
    // Routes tab (fpLoadRoutes) instead of replacing the popup with a
    // separate fixed panel, so selection is driven by the popup's own
    // lifecycle in every colouring mode.
    shape.on("popupopen", () => {
      if (state.tab === "proximity") selectProxGrid(id);
    });
    shape.on("popupclose", () => {
      if (state.tab === "proximity") clearProxGridSelection();
    });
    layers.grids.addLayer(shape);
    drawn += 1;
  });

  layers.grids.addTo(map);
  const badge = $("count-grid-cells");
  if (badge) {
    badge.textContent = `${drawn.toLocaleString()} cells drawn${
      asCells ? " · true 1 km footprint" : " · zoom in past 10 for cell squares"
    }`;
  }
  if ($("badge-grids")) $("badge-grids").textContent = drawn.toLocaleString();
}

const PROX_RADIUS_NOTE = {
  1: "Each hospital claims only the grids inside its own level's radius — a PHC reaches 10 km, a district hospital 30, a medical college 60. This is the deliverable's rule.",
  0: "One flat 60 km radius for every hospital regardless of level. Useful for 'who could reach this cell at all', but it credits a PHC with grids 55 km away.",
};

function setPerLevel(on) {
  state.perLevel = on;
  $("prox-radius-mode")
    .querySelectorAll("button")
    .forEach((b) => b.classList.toggle("active", (b.dataset.perlevel === "1") === on));
  $("prox-radius-note").textContent = PROX_RADIUS_NOTE[on ? 1 : 0];
  clearHospitalSelection();
  loadHospitalCoverage();
}

// ---------------------------------- deliverable 1: hospital -> grid coverage
async function loadHospitalCoverage() {
  const d = $("prox-district").value;
  const q = new URLSearchParams({
    year: state.meta.year,
    per_level: state.perLevel ? "1" : "0",
    include_ep: state.includeEP ? "1" : "0",
  });
  if (d) q.set("district", d);
  try {
    const r = await getJSON(`/api/analytics/hospital-coverage?${q}`);
    state.hospCoverage = r;
    renderHospitalCoverage();
  } catch (err) {
    $("hosp-coverage-stats").innerHTML = `<p class="panel-note error">${err.message}</p>`;
  }
  // The "grids with no hospital in range" panel used to live here. It asked
  // Tab 2's question on Tab 1, so it moved out rather than being answered twice
  // with two different radii. /api/analytics/uncovered-grids still serves it.
}

function visibleHospitals() {
  const r = state.hospCoverage;
  if (!r) return [];
  const q = ($("hosp-search").value || "").trim().toLowerCase();
  const type = $("hosp-type-select").value;
  return r.hospitals.filter((h) => {
    if (type && h.hosp_type !== type) return false;
    if (q && !(h.hospital_name || "").toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderHospitalCoverage() {
  const r = state.hospCoverage;
  if (!r) return;
  const t = r.totals;
  const list = visibleHospitals();
  const shownPairs = list.reduce((a, h) => a + h.grids_within_radius, 0);

  $("hosp-coverage-stats").innerHTML = `
    <div class="stat-card"><span class="stat-value">${list.length.toLocaleString()}</span>
      <span class="stat-label">Hospitals shown</span></div>
    <div class="stat-card"><span class="stat-value">${
      list.length ? Math.round(shownPairs / list.length).toLocaleString() : "—"
    }</span>
      <span class="stat-label">Avg grids served each</span></div>
    <div class="stat-card"><span class="stat-value">${(t.pairs / 1e6).toFixed(2)}M</span>
      <span class="stat-label">Total hospital&ndash;grid pairs</span></div>
    <div class="stat-card"><span class="stat-value">${r.radius_km} km</span>
      <span class="stat-label">Road-distance radius</span></div>`;

  $("hosp-coverage-table").innerHTML =
    `<thead><tr><th>Hospital</th><th class="num">Grids</th><th class="num">TPL</th></tr></thead><tbody>` +
    (list.length
      ? list
          .slice(0, 80)
          .map(
            (h) => `<tr data-hid="${h.hospital_id}" class="${
              state.selectedHospital === String(h.hospital_id) ? "row-selected" : ""
            }">
          <td>${h.hospital_name || "Unnamed"}<br/>
            <span class="fp-sub">${h.hosp_type} · ${h.district}</span></td>
          <td class="num">${h.grids_within_radius.toLocaleString()}</td>
          <td class="num">${h.tpl === null ? "—" : fmt(h.tpl)}<br/>
            <span class="tpl-chip ${h.tpl_source}">${h.tpl_source === "real" ? "real" : "est"}</span></td>
        </tr>`
          )
          .join("")
      : `<tr><td colspan="3">No hospital matches that filter.</td></tr>`) +
    "</tbody>";

  $("hosp-coverage-table")
    .querySelectorAll("tr[data-hid]")
    .forEach((tr) => tr.addEventListener("click", () => selectHospital(tr.dataset.hid)));

  buildHospitalSelect();
  renderLevelStrip();
  renderCoverageTplScatter();

  // Predict the export size so the row count is never a surprise.
  const cap = Number($("grids-per-hospital").value) || 0;
  const est = cap
    ? list.reduce((a, h) => a + Math.min(h.grids_within_radius, cap), 0)
    : shownPairs;
  const scope = state.selectedHospital
    ? "the selected hospital"
    : [$("prox-district").value, $("hosp-type-select").value].filter(Boolean).join(" · ") ||
      "all 1,208 hospitals";
  $("hosp-export-note").innerHTML =
    `Export: <b>${scope}</b>, ${cap ? `nearest ${cap} grids each` : "every grid within " + r.radius_km + " km"}` +
    ` &rarr; approx <b>${est.toLocaleString()}</b> rows.` +
    (est > 1048576
      ? ` <span style="color:var(--danger)">Past Excel's 1,048,576-row limit — use pandas, or cap grids per hospital.</span>`
      : "") +
    (list.length > 80 ? ` Table shows the top 80 of ${list.length}; the export includes all.` : "");
}

function clearHospitalSelection() {
  state.selectedHospital = null;
  layers.hospitalGrids.clearLayers();
  map.removeLayer(layers.hospitalGrids);
  $("selected-hospital-panel").style.display = "none";
  $("layer-grids").checked = true;
  state.radarHospital = null;
  updateProximityRadar();
  renderGrids();
  renderHospitalCoverage();
}

async function selectHospital(hid) {
  state.selectedHospital = String(hid);
  layers.hospitalGrids.clearLayers();
  setStatus("Loading that hospital's catchment…");
  try {
    // limit is generous: the widest catchment in Haryana is ~2,100 grids.
    const d = await getJSON(
      `/api/analytics/hospital/${hid}/grids?limit=4000&per_level=${state.perLevel ? 1 : 0}` +
        `&include_ep=${state.includeEP ? 1 : 0}`
    );
    const rows = d.grids;
    const h0 = rows[0];
    const worst = Math.max(...rows.map((g) => g.road_km_from_hospital));

    rows.forEach((g) => {
      layers.hospitalGrids.addLayer(
        L.circleMarker([g.grid_latitude, g.grid_longitude], {
          radius: 3,
          weight: 0,
          fillColor: rampRisk(Math.min(g.road_km_from_hospital / (worst || 1), 1)),
          fillOpacity: 0.9,
        }).bindTooltip(
          `Grid ${g.grid_id} · ${g.grid_district}<br/>${fmt(
            g.road_km_from_hospital, 2
          )} km by road from ${h0.hospital_name}`,
          { direction: "top" }
        )
      );
    });

    // The hospital itself, drawn last so it sits on top.
    layers.hospitalGrids.addLayer(
      L.circleMarker([h0.hospital_latitude, h0.hospital_longitude], {
        radius: 9,
        color: "#111827",
        weight: 2.5,
        fillColor: "#facc15",
        fillOpacity: 1,
      }).bindTooltip(`${h0.hospital_name} — serves ${d.count} grids`, { permanent: false })
    );

    // Hide the all-grids backdrop so the catchment reads cleanly.
    $("layer-grids").checked = false;
    renderGrids();
    layers.hospitalGrids.addTo(map);

    const lats = rows.map((g) => g.grid_latitude);
    const lons = rows.map((g) => g.grid_longitude);
    map.fitBounds(
      [
        [Math.min(...lats), Math.min(...lons)],
        [Math.max(...lats), Math.max(...lons)],
      ],
      { padding: [30, 30] }
    );

    const dist = rows.map((g) => g.road_km_from_hospital).sort((a, b) => a - b);
    $("selected-hospital-panel").style.display = "";
    if (window.openPanelFor) window.openPanelFor("selected-hospital");
    renderDecayChart(rows, h0);
    $("selected-hospital").innerHTML = `
      <div class="detail-title">${h0.hospital_name}</div>
      <div class="detail-type">${h0.hospital_type} · ${h0.hospital_tier} · ${h0.grid_district ? "" : ""}</div>
      <dl>
        <dt>Hospital ID</dt><dd>${h0.hospital_id}</dd>
        <dt>GPS</dt><dd>${fmt(h0.hospital_latitude, 5)}, ${fmt(h0.hospital_longitude, 5)}</dd>
        <dt>TPL score</dt><dd>${h0.tpl_score === null ? "—" : fmt(h0.tpl_score)}
          <span class="tpl-chip ${h0.tpl_source}">${h0.tpl_source}</span></dd>
        <dt>Grids within 60 km</dt><dd><b>${d.count.toLocaleString()}</b></dd>
        <dt>Road distance</dt><dd>nearest ${fmt(dist[0], 2)} km · median ${fmt(
          dist[Math.floor(dist.length / 2)], 1
        )} km · farthest ${fmt(dist[dist.length - 1], 1)} km</dd>
      </dl>`;

    // Centre the radar on the hospital we just plotted.
    state.radarHospital = {
      lat: h0.hospital_latitude,
      lon: h0.hospital_longitude,
      name: h0.hospital_name,
      level: (h0.hospital_level || "").toUpperCase() || null,
    };
    updateProximityRadar();

    renderHospitalCoverage();
    setStatus(
      `${h0.hospital_name}: ${d.count.toLocaleString()} grids within 60 km by road. Cells shaded by distance from this hospital.`
    );
  } catch (err) {
    setStatus(err.message, true);
  }
}

// --------------------------------------------------------- feature popups
// One builder for every icon on the map. The Gaps tab asks that clicking any
// feature surfaces its full record — ID, category, type, district, coordinates
// — and doing that from a single function is the only way three separate
// renderers stay consistent as fields get added.
function popupRow(label, value) {
  if (value === null || value === undefined || value === "") return "";
  return `<dt>${label}</dt><dd>${value}</dd>`;
}

function copyableCoords(lat, lon) {
  // Shown to 5 dp (~1 m) and selectable, because the first thing anyone does
  // with a gap cell is paste its coordinates into something else.
  return `<code class="coord">${fmt(lat, 5)}, ${fmt(lon, 5)}</code>`;
}

function featurePopup(kind, f) {
  return fpShell(kind, f, featureHead(kind, f), featureDetails(kind, f));
}

// The head is rendered outside the tab shell so the identity of what you
// clicked stays visible whichever pane is open.
// Stroke icons at 15px, one per feature kind. Drawn rather than pulled from a
// font so they inherit currentColor and never arrive late.
const FP_ICONS = {
  grid:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/>' +
    '<rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>',
  hospital:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 21V8.5L12 3l8 5.5V21"/><path d="M12 12.2v4.6M9.7 14.5h4.6"/></svg>',
  ambulance:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M2 16V8.5A1.5 1.5 0 0 1 3.5 7h9.7v9H2Z"/><path d="M13.2 10h3.4l3.4 3.6V16h-6.8"/>' +
    '<circle cx="7" cy="18" r="1.9"/><circle cx="17" cy="18" r="1.9"/><path d="M7.6 11.5h2.6M8.9 10.2v2.6"/></svg>',
  bloodbank:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 3.2c3.7 4.4 6 7.3 6 10a6 6 0 0 1-12 0c0-2.7 2.3-5.6 6-10Z"/><path d="M12 11v4.4M9.8 13.2h4.4"/></svg>',
};

const FP_KIND_HUE = {
  grid: "#0f766e",
  hospital: "#1d4ed8",
  ambulance: "#b91c1c",
  bloodbank: "#be123c",
};

function fpHead(kind, kindLabel, title) {
  return `<div class="fp-head">
    <span class="fp-ico" style="--h:${FP_KIND_HUE[kind]}">${FP_ICONS[kind]}</span>
    <span class="fp-titles">
      <span class="fp-kind">${kindLabel}</span>
      <span class="fp-title">${title}</span>
    </span>
  </div>`;
}

/* Their grid popup titles itself "Grid #<id>" with the centroid underneath.
   Ours showed the id alone. In New mode the centroid line is added so the head
   matches theirs; in Old mode the coordinates already appear in the Details
   record, so repeating them in the head would be noise. */
function fpGridCentroidLine(f) {
  const { lat, lon } = fpLatLon(f);
  if (lat == null || lon == null) return "";
  return `<span class="fp-centroid">Centroid: ${fmt(lat, 4)}, ${fmt(lon, 5)}</span>`;
}

function featureHead(kind, f) {
  if (kind === "hospital") return fpHead(kind, "Hospital", f.name || "Unnamed");
  if (kind === "ambulance") return fpHead(kind, "Ambulance", f.vehicle_no || "Unknown vehicle");
  if (kind === "bloodbank") return fpHead(kind, "Blood storage", f.name || "Blood centre");
  // In New mode the head carries the centroid, matching their popup's header.
  return fpHead(
    "grid",
    "Grid cell",
    liveOn() ? `${f.grid_id}${fpGridCentroidLine(f)}` : f.grid_id
  );
}

function featureDetails(kind, f) {
  if (kind === "hospital") {
    const lv = (f.hosp_level || "").toUpperCase();
    const cfg = HOSP_LEVEL_STYLE[lv] || HOSP_LEVEL_STYLE.OTHER;
    // Dashed-outline pins now also flag a KNOWN-WRONG GPS pending
    // verification (build_tpl.UNVERIFIED_COORDS), not just a mocked facility
    // — either way the location on screen should not be trusted as surveyed.
    const mocked = f.level_source === "mock_mch" || f.coord_status === "unverified";
    const coordUnverified = f.coord_status === "unverified";
    /* Say the level AND whether it counts. A facility labelled L2 that provides
       no L2 is the single most confusing thing on this map, and the popup is
       where someone goes to resolve exactly that confusion — so it answers it
       outright instead of leaving the reader to infer it from a grey pin. */
    const provides = (f.counts_at_level ?? "").toUpperCase();
    const levelCell = provides
      ? `<b style="color:${(HOSP_LEVEL_STYLE[provides] || cfg).color}">${provides}</b>`
      : `<b style="color:#64748b">none</b>` +
        (lv ? ` <span class="fp-muted">(labelled ${lv})</span>` : "");
    // Reach radius is a property of the level, so state it next to the level
    // rather than making the reader carry 60/30/10 in their head between the
    // sidebar and here.
    const radiusCell = provides
      ? `${levelCell} <span class="fp-muted">&mdash; reaches ${PROX_LEVEL_SPEC[provides]} km by road</span>`
      : levelCell;
    return `
      <dl class="fp-list">
        ${popupRow("Hospital ID", `<code>${f.s_no}</code>`)}
        ${popupRow("Provides level", radiusCell)}
        ${popupRow("Category / type", f.hosp_type)}
        ${popupRow("Tier", f.tier)}
        ${popupRow("District", f.district)}
        ${popupRow("Coordinates", copyableCoords(f.lat, f.lon))}
        ${popupRow(
          "TPL",
          `${f.tpl === null || f.tpl === undefined ? "—" : Number(f.tpl).toFixed(1)}
           <span class="tpl-chip ${f.tpl_source}">${f.tpl_source || "—"}</span>`
        )}
      </dl>
      ${
        coordUnverified
          ? `<p class="fp-warn">&#9888; Coordinates approximate — pending verification.${
              f.coord_note ? ` <span class="fp-muted">${f.coord_note}</span>` : ""
            }</p>`
          : f.level_source === "mock_mch"
          ? '<p class="fp-warn">Mocked facility — approximate GPS.</p>'
          : ""
      }
      <div class="fp-prep" data-prep-id="${f.s_no ?? ""}"
           data-prep-lat="${f.lat ?? ""}" data-prep-lon="${f.lon ?? ""}"></div>`;
  }

  if (kind === "bloodbank") {
    return `
      <dl class="fp-list">
        ${popupRow("Centre", f.name)}
        ${popupRow("District", f.district)}
        ${popupRow("Address", f.address)}
        ${popupRow("Coordinates", copyableCoords(f.lat ?? f.latitude, f.lon ?? f.longitude))}
      </dl>`;
  }

  if (kind === "ambulance") {
    const type = (f.vehicle_type || "").toUpperCase();
    const cfg = VEHICLE_STYLE[type] || VEHICLE_STYLE.OTHER;
    return `
      <dl class="fp-list">
        ${popupRow("Ambulance ID", `<code>${f.s_no}</code>`)}
        ${popupRow("Vehicle no.", f.vehicle_no)}
        ${popupRow("Category / type", `<b style="color:${cfg.color}">${cfg.label}</b>`)}
        ${popupRow("Stationed at", f.stationed_at)}
        ${popupRow(
          "District",
          /* Geographic, not the recorded label — see the comment on
             /api/analytics/ambulances. When the two disagree the recorded one
             is shown alongside rather than dropped, so a data fault stays
             visible instead of being quietly corrected away. */
          f.district_recorded && f.district_recorded !== f.district
            ? `${f.district} <span class="fp-muted">(recorded as ${f.district_recorded})</span>`
            : f.district
        )}
        ${popupRow("Coordinates", copyableCoords(f.lat, f.lon))}
      </dl>`;
  }

  // Grid cell — used on both the Gaps and Ambulance maps.
  const missed = f.levels_missed || f.types_missed || [];
  const met = f.levels_met || f.types_met || [];
  const nearestRows = Object.entries(f.nearest || {})
    .filter(([, n]) => n)
    .map(
      ([k, n]) =>
        `<tr><td>${k}</td><td>${n.name || "—"}<br/><span class="fp-sub">${n.type || ""}</span></td><td class="num">${fmt(n.road_km, 2)} km</td></tr>`
    )
    .join("");

  const gLat = f.lat ?? f.latitude;
  const gLon = f.lon ?? f.longitude;

  /* Ambulance-tab gap cells carry a DIFFERENT shape from Gaps-tab cells: they
     come out of grid_ambulance.find_gaps as road_km / nearest_vehicle_no /
     nearest_vehicle_type / nearest_stationed_at / drive_min. This block used to
     read `f.amb_km`, a key nothing has ever produced, so every one of those
     rows evaluated to null and popupRow dropped it. Combined with levels_met /
     levels_missed also being absent on that payload, clicking a red cell on
     Tab 3 showed four lines — id, district, coordinates, severity — and hid the
     one number the tab exists to report. Read the real keys. */
  const ambKm = f.road_km ?? null;
  const ambType = (f.nearest_vehicle_type || "").toUpperCase();
  const ambRows =
    ambKm === null && !f.nearest_vehicle_no
      ? ""
      : `${popupRow(
          "Nearest vehicle",
          f.nearest_vehicle_no
            ? `${f.nearest_vehicle_no} ${ambType ? fpVehicleChip(ambType) : ""}`
            : null
        )}
         ${popupRow("Stationed at", f.nearest_stationed_at)}
         ${popupRow(
           "Road to vehicle",
           ambKm === null
             ? '<b class="fp-miss">no vehicle cached within reach</b>'
             : `<b>${fmt(ambKm, 2)} km</b>${
                 f.drive_min == null ? "" : ` &middot; ${fmt(f.drive_min, 0)} min`
               }`
         )}`;

  return `
    <dl class="fp-list">
      ${popupRow("Grid ID", `<code>${f.grid_id}</code>`)}
      ${popupRow("District", f.district)}
      ${popupRow("Coordinates", copyableCoords(gLat, gLon))}
      ${popupRow("Severity score", f.severity_score == null ? null : fmt(f.severity_score, 1))}
      ${popupRow("Meets", met.length ? met.join(", ") : null)}
      ${popupRow(
        "Misses",
        missed.length ? `<b class="fp-miss">${missed.join(", ")}</b>` : met.length ? "none" : null
      )}
      ${popupRow("Nearest facility", f.closest_any_km != null ? `${fmt(f.closest_any_km, 2)} km` : null)}
      ${ambRows}
    </dl>
    ${
      nearestRows
        ? `<table class="mini-table fp-table"><thead><tr><th>Seg</th><th>Nearest facility</th><th class="num">Road</th></tr></thead><tbody>${nearestRows}</tbody></table>`
        : ""
    }`;
}

// ------------------------------------------------- optional overlay layers
function buildSubFilters() {
  const hosp = $("hosp-type-filter");
  // Built once, injected into both tabs — the filter is shared state, so two
  // copies that could disagree would be a bug waiting to happen.
  const levelFilterHtml = visibleLevels().map(
    (lv) => `<label class="sub-toggle">
      <input type="checkbox" data-level="${lv}" checked />
      ${hospIconHtml(lv, false, true)}
      <span>${LEVEL_SHORT[lv]} <b class="hl-count" data-level="${lv}">0</b>${
        LEVEL_NOTE[lv]
          ? `<br/><span class="fp-muted" style="font-size:0.66rem">${LEVEL_NOTE[lv]}</span>`
          : ""
      }</span>
    </label>`
  ).join("");
  hosp.innerHTML = levelFilterHtml;
  const gapFilter = $("gap-hosp-filter");
  if (gapFilter) gapFilter.innerHTML = levelFilterHtml;

  document.querySelectorAll("input[data-level]").forEach((cb) =>
    cb.addEventListener("change", () => {
      const lv = cb.dataset.level;
      cb.checked ? state.hospLevels.add(lv) : state.hospLevels.delete(lv);
      // Keep the twin checkbox on the other tab in step.
      document
        .querySelectorAll(`input[data-level="${lv}"]`)
        .forEach((other) => (other.checked = cb.checked));
      renderHospitals();
    })
  );

  const sev = $("severity-filter");
  sev.innerHTML = SEVERITIES.map(
    (s) => `<label class="sub-toggle">
      <input type="checkbox" data-sev="${s}" checked />
      <i class="swatch" style="background:${SEVERITY_COLORS[s]}"></i>
      <span>${s}</span>
    </label>`
  ).join("");
  sev.querySelectorAll("input[data-sev]").forEach((cb) =>
    cb.addEventListener("change", () => {
      cb.checked ? state.severities.add(cb.dataset.sev) : state.severities.delete(cb.dataset.sev);
      renderAccidents();
    })
  );
}

async function ensureHospitals() {
  if (state.hospitals) return;
  // Fetched UNSCOPED, on purpose. This used to be scoped to the Proximity
  // district select, which was survivable while the hospital layer was off by
  // default everywhere. It is not survivable now that the Gaps tab ships with
  // its layer on: with Proximity filtered to one district and Gaps to another,
  // the cache held only the first district's rows and the Gaps map drew an
  // empty hospital layer. renderHospitals() already filters per tab via
  // hospitalDistrict(), so the whole list is the correct thing to hold — and
  // at ~1,200 rows it also means a district change no longer refetches.
  setStatus("Loading hospitals…");
  const res = await getJSON(`/api/analytics/hospitals?include_ep=${state.includeEP ? 1 : 0}`);
  state.hospitals = res.hospitals;
  setLevelCounts(res.by_level || {});
}

function setLevelCounts(counts) {
  document.querySelectorAll(".hl-count").forEach((el) => {
    el.textContent = (counts[el.dataset.level] || 0).toLocaleString();
  });
}

// --- blood storage (BS) ---------------------------------------------------
// Drawn as a red droplet so it reads as blood at a glance and cannot be
// confused with the square hospital badges or round ambulance pins.
async function ensureBloodbanks() {
  if (state.bloodbanks) return;
  const r = await getJSON("/api/analytics/bloodbanks");
  state.bloodbanks = r.bloodbanks;
  state.bloodbanksMeta = r;
}

function renderBloodbanks() {
  layers.bloodbanks.clearLayers();
  const on = $("layer-bloodbanks")?.checked && state.tab !== "ambulance";
  if (!on || !state.bloodbanks) {
    map.removeLayer(layers.bloodbanks);
    $("badge-bloodbanks").textContent = 0;
    $("bs-note").textContent = "";
    return;
  }
  const district = hospitalDistrict();
  let n = 0;
  state.bloodbanks.forEach((b) => {
    // Boundary test, same reasoning as renderHospitals().
    if (district && outsideDistrict(b.longitude, b.latitude, b.district, district)) return;
    n += 1;
    layers.bloodbanks.addLayer(
      L.marker([b.latitude, b.longitude], {
        icon: L.divIcon({
          className: "bs-icon",
          html:
            `<svg class="bs-svg" width="17" height="17" viewBox="0 0 24 24">` +
            `<path d="M12 2.5c4.2 5 6.8 8.3 6.8 11.4a6.8 6.8 0 1 1-13.6 0C5.2 10.8 7.8 7.5 12 2.5z" ` +
            `fill="#dc2626" stroke="#7f1d1d" stroke-width="1.5" stroke-linejoin="round"/>` +
            `<path d="M12 9.5v6M9 12.5h6" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/></svg>`,
          iconSize: [0, 0],
        }),
        zIndexOffset: 250,
      }).bindPopup(featurePopup("bloodbank", b), {
        maxWidth: 320,
        className: "feature-popup",
      })
    );
  });
  layers.bloodbanks.addTo(map);
  $("badge-bloodbanks").textContent = n.toLocaleString();

  const none = state.bloodbanksMeta?.districts_without || [];
  $("bs-note").innerHTML = none.length
    ? `<b>${none.join(", ")}</b> ${none.length === 1 ? "has" : "have"} no blood storage centre at all.`
    : "";
}

async function ensureAccidents() {
  if (state.accidents) return;
  setStatus("Loading accidents…");
  const res = await getJSON("/api/accidents");
  state.accidents = res.features || [];
}

// Hospitals are drawn as pins coloured by LEVEL, not by facility type — the
// level is what the 60/30/10 rule turns on, so it is the thing worth reading
// off the map at a glance. The glyph still carries the type, so nothing is
// lost. Mocked L1 facilities get a dashed ring so they can never be mistaken
// for real rows.
// The layer is available on tabs 1 and 2, each with its own checkbox and its
// own district select. Read whichever pair belongs to the tab in view rather
// than hard-coding tab 1's controls.
function hospitalLayerToggle() {
  return state.tab === "gaps" ? $("gap-layer-hospitals") : $("layer-hospitals");
}

function hospitalDistrict() {
  return (state.tab === "gaps" ? $("gap-district") : $("prox-district"))?.value || "";
}

function renderHospitals() {
  layers.hospitals.clearLayers();
  const on = hospitalLayerToggle()?.checked && state.tab !== "ambulance";
  if (!on || !state.hospitals) {
    map.removeLayer(layers.hospitals);
    document.querySelectorAll(".badge-hospitals").forEach((b) => (b.textContent = 0));
    return;
  }
  const district = hospitalDistrict();
  let n = 0;
  // `counts`   — pins actually DRAWN, per level.
  // `available` — pins that pass every test EXCEPT the level filter, which is
  //   what the filter chips and the clickable legend rows are labelled with.
  const counts = { L1: 0, L2: 0, L3: 0 };
  const available = { L1: 0, L2: 0, L3: 0, EP: 0 };

  let contextPins = 0;
  // Labelled as this district but sitting outside its boundary — a data fault
  // in hospital_tpl.csv, surfaced below rather than hidden by the new filter.
  let misplaced = 0;

  state.hospitals.forEach((h) => {
    /* THE LEVEL A FACILITY PROVIDES, NOT THE LEVEL IT IS LABELLED.
       These differ for 570 of 1,208 facilities. build_tpl has to stamp some
       level on every row, so an empanelled private hospital it knows nothing
       about is defaulted to "L2" — but the spec's L2 is DH/DCH, and the reach
       analysis counts only the 22 DCHs. Colouring by the label drew 583 L2 pins
       against an analysis that recognised 22, which is what put an "L2" 2.65 km
       from grid 743223 while its L2 route ran 13.41 km the other way.
       `counts_at_level` is the server's verdict, from the same
       eligible_at_level() the analysis uses. Older payloads without the field
       fall back to the label so a stale cache degrades to the old behaviour
       rather than blanking the map. */
    const lv = (h.counts_at_level ?? h.hosp_level ?? "").toUpperCase();
    const labelled = (h.hosp_level || "").toUpperCase();
    // Real facility, real location, but provides no tier under the spec. Still
    // drawn — it is genuine context and it is in the "hospitals within 60 km"
    // list — but hollow and grey, so it can never be read as tier capacity.
    const isContext = !lv;

    // Mode 3 isolates ONE level. The other two must not be drawn: a green grid
    // with an L2 pin sitting on it reads as though that L2 is what made it
    // green, when the green means "an L1 is within 60 km". Context pins are
    // dropped here too — mode 3 is a per-level view and they are in no level.
    if (state.tab === "proximity" && proxMode() === "hospital" && lv !== proxLevel()) return;
    /* Counted BEFORE the level filter (31 Aug 2026). These numbers label the
       filter chips in the sidebar and the clickable legend rows, and a chip
       that reads "L2 0" the moment you untick L2 tells you nothing about what
       unticking it did. What survives the district and mode tests is the
       honest denominator; `n`, the drawn total, is counted below as before.
       The district test still runs after this, so the chips follow a district
       selection the way they always did. */
    if (!isContext && !(district && outsideDistrict(h.lon, h.lat, h.district, district))) {
      available[lv] = (available[lv] || 0) + 1;
    }
    if (!isContext && !state.hospLevels.has(lv)) return;
    // Context pins follow the union of the level filters: if every level is
    // switched off the layer is meant to be empty, not quietly full of grey.
    if (isContext && state.hospLevels.size === 0) return;
    /* Tested against the district POLYGON, not the district label — see
       outsideDistrict(). Rows whose label says one district and whose GPS
       says another are counted so the data fault stays visible instead of
       being silently swallowed by the filter that now hides it. */
    if (district && outsideDistrict(h.lon, h.lat, h.district, district)) {
      if (normDistrict(h.district) === normDistrict(district)) misplaced += 1;
      return;
    }

    /* Facility pins stay coloured BY LEVEL in every Proximity mode. The four
       grid bands already answer "is this cell covered"; the pins answer the
       other half of the question — "covered BY WHAT" — and that is only
       legible if L1/L2/L3 keep distinct colours. Painting the pins by a
       pass/fail verdict too would say the same thing twice and lose the
       level, which is the per-level insight this tab exists for. */
    const cfg = HOSP_LEVEL_STYLE[lv] || HOSP_LEVEL_STYLE.OTHER;
    // Same dashed-outline treatment for a mocked facility (none exist as of
    // 20 Aug 2026) and for a facility whose GPS is known-wrong upstream and
    // still pending a verified replacement (build_tpl.UNVERIFIED_COORDS) —
    // in both cases the pin's location should not be read as surveyed.
    const mocked = h.level_source === "mock_mch" || h.coord_status === "unverified";
    if (isContext) contextPins += 1;
    else counts[lv] = (counts[lv] || 0) + 1;
    n += 1;

    const m = L.marker([h.lat, h.lon], {
      icon: L.divIcon({
        className: "hosp-icon",
        html: hospIconHtml(lv, mocked, false, isContext),
        iconSize: [0, 0],
      }),
      // Context pins sit under every tier provider, so a real L2 is never
      // hidden behind a private facility that does not count as one.
      zIndexOffset: isContext ? 50 : cfg.priority,
      opacity: districtDim(h.district),
    });
    // Carried onto the marker so the popup can say "labelled L2, counts as
    // none" rather than leaving the reader to wonder why it is grey.
    h._labelled_level = labelled;
    h._counts_level = lv;
    // Single level used to skip this popup entirely and fetch straight into
    // its own ad-hoc catchment popup. Its "Top N grids" Nearby list (see
    // fpHospitalGrids) does that job now, on this SAME popup, on every
    // colouring, so it is always bound -- and each of its rows draws a real
    // road route on click (see proxDrawRoute), same as the old catchment
    // list's rows did.
    m.bindPopup(featurePopup("hospital", h), { maxWidth: 320, className: "feature-popup" });
    // In Single level mode the Nearby tab opens itself as soon as the popup
    // does, matching the one-click feel the old dedicated catchment popup
    // had. A context pin still opens onto Details -- it has no reachable
    // grids to list at this level, which is not an error state to route
    // around, just the honest answer.
    const proxHospMode = state.tab === "proximity" && proxMode() === "hospital";
    m.on("popupopen", () => {
      if (!proxHospMode || isContext) return;
      m.getPopup()
        ?.getElement()
        ?.querySelector('.fp-tab[data-fp-pane="near"]')
        ?.click();
    });
    // Clicking a facility centres that tab's radar on it. Cheap — no fetch —
    // so it stays a browsing gesture rather than a commitment, unlike picking
    // a hospital from the dropdown, which loads its whole catchment.
    m.on("click", () => {
      if (proxHospMode) {
        // A context pin has no catchment at this level — the server refuses it,
        // correctly. Say so here rather than firing a request just to render
        // its error, which reads as a failure when it is the right answer.
        if (isContext) {
          setStatus(
            `${h.name} is labelled ${labelled || "—"} but does not count as an ` +
              `${proxLevel()} provider (${h.hosp_type}), so it has no ` +
              `${proxLevel()} catchment.`,
            true
          );
        }
        return;
      }
      if (state.tab === "gaps") {
        state.radarGapHospital = h;
        state.gapRadarKind = "hospital";
        if (window.openPanelFor) window.openPanelFor("gap-radar");
        updateGapRadar();
      } else {
        state.radarHospital = { lat: h.lat, lon: h.lon, name: h.name, level: lv };
        if (window.openPanelFor) window.openPanelFor("prox-radar");
        updateProximityRadar();
      }
    });
    layers.hospitals.addLayer(m);
  });

  layers.hospitals.addTo(map);
  document
    .querySelectorAll(".badge-hospitals")
    .forEach((b) => (b.textContent = n.toLocaleString()));
  // Only tier providers are counted against L1/L2/L3, so these badges now
  // agree with the reach figures. Before, the L2 badge said 583 while the L2
  // analysis was working from 22 — the badge was quietly the louder claim.
  setLevelCounts(available);
  state.hospLevelCounts = available;
  state.hospDrawnByLevel = counts;
  state.hospContextPins = contextPins;
  state.hospMisplaced = misplaced;

  /* Say it out loud. These rows are labelled with the selected district but
     their coordinates fall outside its boundary, so they are no longer drawn
     — that is a bug in the source data, and a silently shorter list would
     hide it. */
  // Class, not id: Proximity and Gaps each carry their own copy of this note
  // and only one is on screen at a time.
  const misHtml = misplaced
    ? `<b>${misplaced.toLocaleString()}</b> ${misplaced === 1 ? "facility is" : "facilities are"}
       labelled <b>${district}</b> in the source data but ${misplaced === 1 ? "its GPS falls" : "their GPS falls"}
       outside the district boundary, so ${misplaced === 1 ? "it is" : "they are"} not drawn.
       Mostly empanelled private rows &mdash; worth raising against
       <code>hospital_tpl.csv</code>.`
    : "";
  document.querySelectorAll(".hosp-misplaced-note").forEach((el) => (el.innerHTML = misHtml));
}

/* Pin layers filtered by the district POLYGON have to be repainted when that
   polygon arrives or is cleared, because highlightDistrict() resolves it
   asynchronously — after the change handlers have already drawn them once. */
function repaintDistrictScopedLayers() {
  if (typeof renderHospitals === "function" && state.hospitals) renderHospitals();
  if (typeof renderBloodbanks === "function" && state.bloodbanks) renderBloodbanks();
  if (typeof renderProxFacilityList === "function") renderProxFacilityList();
}

// --- hospital dropdown ----------------------------------------------------
// Mirrors the table's filters so the two can never disagree. The table caps at
// 80 rows for rendering cost; the dropdown carries the full filtered list, so
// a hospital outside the top 80 is still reachable without typing its name.
function buildHospitalSelect() {
  const sel = $("hosp-select");
  if (!sel) return;
  const list = visibleHospitals();
  const cur = state.selectedHospital;
  sel.innerHTML =
    `<option value="">${list.length.toLocaleString()} hospitals — pick one…</option>` +
    list
      .map(
        (h) =>
          `<option value="${h.hospital_id}"${
            cur === String(h.hospital_id) ? " selected" : ""
          }>${(h.hospital_name || "Unnamed").slice(0, 60)} — ${h.hosp_type} · ${
            h.district
          } (${h.grids_within_radius.toLocaleString()} grids)</option>`
      )
      .join("");
}

function renderAccidents() {
  layers.accidents.clearLayers();
  const on = $("layer-accidents")?.checked;
  if (!on || !state.accidents) {
    map.removeLayer(layers.accidents);
    $("badge-accidents").textContent = 0;
    $("accident-note").style.display = "none";
    return;
  }
  const district = $("prox-district").value;
  let n = 0;
  state.accidents.forEach((a) => {
    if (!state.severities.has(a.severity)) return;
    if (district && (a.district || a.district_name || "").toUpperCase() !== district) return;
    layers.accidents.addLayer(
      L.circleMarker([a.latitude, a.longitude], {
        radius: 2,
        color: SEVERITY_COLORS[a.severity] || "#f59e0b",
        weight: 0,
        fillColor: SEVERITY_COLORS[a.severity] || "#f59e0b",
        fillOpacity: 0.7,
      })
    );
    n += 1;
  });
  layers.accidents.addTo(map);
  $("badge-accidents").textContent = n.toLocaleString();
  $("accident-note").style.display = n > 8000 ? "" : "none";
}

/* The corridor machinery that used to live here (cluster hulls, the
   corridorCells layer) went with the deleted Grid Analysis view. Only its
   comments survived, describing functions that no longer exist — and the
   "Selected" card still invited you to "click a corridor", which nothing could
   satisfy. Removed 2026-08-19 rather than left as a promise the app cannot
   keep. */

const AMB_COLOUR_NOTE = {
  distance:
    "Cells shaded by road distance to the nearest ambulance in scope — darker is further.",
  tss: "Cells shaded by TSS, the RBG severity score for that 1 km cell. Scale fits the 95th percentile of the current result. Use this to rank stranded cells by how much injury they actually carry, not just how remote they are.",
};

// --- deliverable 3: grids >= threshold km BY ROAD from any ambulance -------

// Same treatment as the Tab 2 gap cells: draw the real 1 km footprint rather
// than an abstract dot, so what you see on the map IS the grid being counted.
function renderAmbulanceGaps() {
  const r = state.ambGaps;
  layers.ambGaps.clearLayers();
  layers.ambCovered.clearLayers();
  if (!r) return;

  const zoom = map.getZoom();
  const showIds =
    $("amb-show-ids")?.checked !== false && r.gap_count <= 400 && zoom >= 9;

  // Distance answers "how far is help"; TSS answers "how much does this cell
  // matter". A stranded cell nobody crashes in is a lower priority than a
  // marginally-stranded one on a black spot, and only the TSS view shows that.
  const ambByTss = state.ambColour === "tss";
  let ambTssP95 = 1;
  if (ambByTss) {
    const v = r.gaps.map((g) => g.severity_score || 0).sort((a, b) => a - b);
    ambTssP95 = v.length ? v[Math.floor(v.length * 0.95)] || 1 : 1;
  }
  state.ambTssP95 = ambTssP95;

  // Same true-1km-cell / zoomed-out-dot switch as Proximity, at the same
  // zoom threshold (CELL_ZOOM) and the identical paint helpers, so a
  // zoomed-out grid here looks pixel-for-pixel like it does on Proximity
  // instead of the old "always draw a rectangle, plus a translucent halo".
  const asCell = zoom >= CELL_ZOOM;
  const scale = dotScale();

  r.gaps.forEach((g) => {
    /* Distance now paints the SHARED four-band palette (see ambBand) instead
       of a continuous red ramp — one colour language across all three tabs.
       TSS keeps its own continuous ramp: severity is a magnitude, not a
       four-state verdict, and forcing it into the reach bands would say this
       cell passes a test that was never run on it. */
    const band = ambBand(g.road_km, r.threshold_km);
    /* Legend filter. The legend is the only place these bands are named, so
       it is also where they are switched off — see LEGEND_FILTER_GROUPS.
       Filtered per COLOURING MODE: hiding "2-3x the limit" while colouring by
       distance must not also hide "High severity" when you switch to TSS,
       even though both are painted band 1. */
    const tssBand = severityBandIndex(g.severity_score || 0, ambTssP95);
    if (ambByTss ? !state.ambTssFilter.has(tssBand) : !state.ambBandFilter.has(band)) return;
    const fill = ambByTss ? PROX_MET_COLOR[tssBand] : PROX_MET_COLOR[band];
    const style = { color: fill, radius: 3.6, opacity: 0.75, outline: "black", outlineWeight: 2 };
    const tip =
      `<b>Grid ${g.grid_id}</b> · ${g.district}<br/>` +
      `<b>${AMB_BAND_LABEL[band]}</b><br/>` +
      (g.road_km === null
        ? "No ambulance within 60 km"
        : `${fmt(g.road_km, 2)} km by road to ${g.nearest_vehicle_no || "nearest"}` +
          (g.nearest_vehicle_type ? ` (${g.nearest_vehicle_type})` : "")) +
      `<br/>TSS <b>${fmt(g.severity_score, 1)}</b>`;

    let shape;
    if (asCell) {
      const halfLon = CELL_HALF_LAT / Math.cos((g.latitude * Math.PI) / 180);
      shape = L.rectangle(
        [
          [g.latitude - CELL_HALF_LAT, g.longitude - halfLon],
          [g.latitude + CELL_HALF_LAT, g.longitude + halfLon],
        ],
        proxCellPaint(style, 1)
      );
    } else {
      shape = L.circleMarker([g.latitude, g.longitude], {
        radius: style.radius * scale,
        ...proxDotPaint(style, 1),
      });
    }

    layers.ambGaps.addLayer(
      shape
        .bindTooltip(tip, { direction: "top" })
        .bindPopup(featurePopup("grid", g), { maxWidth: 340, className: "feature-popup" })
    );

    if (showIds) {
      layers.ambGaps.addLayer(
        L.marker([g.latitude, g.longitude], {
          interactive: false,
          icon: L.divIcon({
            className: "grid-id-label",
            html: `<span>${g.grid_id}</span>`,
            iconSize: [0, 0],
          }),
        })
      );
    }
  });

  // Context layer: everything that IS within reach. Drawn at the SAME
  // quality as the gap cells above -- same cell/dot switch, same paint
  // helpers, lightyellow fill (PROX_MET_COLOR[3]) -- rather than a barely
  // visible faint dot, so toggling "Grids within reach" on actually shows a
  // real grid, matching what the legend's "Within reach" swatch promises.
  const inReachStyle = { color: PROX_MET_COLOR[3], radius: 3.6, opacity: 0.75, outline: "black", outlineWeight: 2 };
  /* Scope to THIS tab's district. state.coverage is fetched against the
     Proximity district select, so on this tab it is normally the whole state;
     without this test picking a district narrowed the gap cells (scoped
     server-side by the ambulance endpoint) but left the in-reach cells
     covering all of Haryana -- the two halves of one map answering two
     different questions. */
  const ambDistrict = $("amb-district")?.value || "";
  // "Within reach" is band 3 in both colouring modes — it is one legend row in
  // both, and switching it off has to empty this layer as well as recolour it.
  const showInReach = state.ambBandFilter.has(3);
  (state.coverage?.grids || []).forEach((g) => {
    if (!showInReach) return;
    if (ambDistrict && normDistrict(g.district) !== normDistrict(ambDistrict)) return;
    if (state.ambGapIds?.has(String(g.grid_id))) return;
    let inReachShape;
    if (asCell) {
      const halfLon = CELL_HALF_LAT / Math.cos((g.lat * Math.PI) / 180);
      inReachShape = L.rectangle(
        [
          [g.lat - CELL_HALF_LAT, g.lon - halfLon],
          [g.lat + CELL_HALF_LAT, g.lon + halfLon],
        ],
        proxCellPaint(inReachStyle, 1)
      );
    } else {
      inReachShape = L.circleMarker([g.lat, g.lon], {
        radius: inReachStyle.radius * scale,
        ...proxDotPaint(inReachStyle, 1),
      });
    }
    layers.ambCovered.addLayer(
      inReachShape
        .bindTooltip(`<b>Grid ${g.grid_id}</b> · ${g.district}<br/>Within reach`, { direction: "top" })
        .bindPopup(featurePopup("grid", g), { maxWidth: 340, className: "feature-popup" })
    );
  });

  $("amb-label-note").textContent =
    r.gap_count > 400
      ? `${r.gap_count.toLocaleString()} cells — too many to label. Narrow by district or lower the threshold.`
      : showIds
        ? ""
        : "Zoom in to level 9 or closer to see grid IDs.";

  renderAmbulanceGapStats();
  renderAmbulances();
  syncAmbulanceLayers();
}

/**
 * v2 stations. One style for all of them — inventing colour categories the
 * source does not have would imply a capability distinction that is not in the
 * data. The day and slot ride in the tooltip and popup instead, because that
 * IS the dimension this feed carries.
 */
function renderAmbV2Stations() {
  const list = state.ambV2Stations?.stations || [];
  const badge = $("badge-amb-stations");
  if (badge) badge.textContent = list.length.toLocaleString();
  renderAmbV2Breakdown(list);
  list.forEach((s) => {
    layers.ambCurrent.addLayer(
      L.marker([s.lat, s.lon], {
        icon: L.divIcon({
          className: "amb-icon",
          html: `<span class="amb-pin" style="background:#0f766e;border-color:#134e4a">A</span>`,
          iconSize: [0, 0],
        }),
        zIndexOffset: 300,
      })
        .bindTooltip(
          `<b>Sighting ${s.id}</b><br/>${s.day} &middot; ${s.period}<br/>` +
            `${s.city || "—"} &middot; ${s.district}`,
          { direction: "top" }
        )
        .bindPopup(
          `<div class="fp">
             <div class="fp-head" style="border-left:6px solid #0f766e">
               <b>Sighting ${s.id}</b>
               <div class="fp-muted">${s.city || "—"} &middot; ${s.district}</div>
             </div>
             <dl class="fp-list">
               <dt>Observed</dt><dd>${s.day} &middot; ${s.period}</dd>
               <dt>Postal code</dt><dd>${s.postal_code || "—"}</dd>
               <dt>GPS</dt><dd>${copyableCoords(s.lat, s.lon)}</dd>
               <dt>Address</dt><dd>${s.address || "—"}</dd>
             </dl>
             <p class="fp-muted" style="font-size:0.7rem">
               This row is a single observation, not a weekly roster — it appears
               once in the workbook, on this day and slot only.</p>
           </div>`,
          { maxWidth: 340, className: "feature-popup" }
        )
    );
  });
}

/**
 * The NEW dataset's sub-rows under "Ambulance stations".
 *
 * WHY THIS EXISTS. The five ALS/BLS/PTA/Kilkari/Neonate rows are the OLD
 * fleet's vehicle types and sum to 569. Left on screen in NEW mode they read
 * as a breakdown of the 142 stations above them, and 55+253+227+29+5 is not
 * 142 — which is exactly the contradiction reported on 31 Aug 2026. The
 * workbook carries no vehicle type at all, so the honest breakdown is the one
 * dimension it DOES carry: the time period each station was observed in.
 *
 * These rows are counts, not toggles. Filtering by period is already the
 * "Time period" select in Controls, and it filters the ANALYSIS as well as the
 * map; a second, map-only period filter here would let the badge and the gap
 * count disagree about which stations are in play. The rows sum to the badge
 * by construction — every station has exactly one period.
 */
function renderAmbV2Breakdown(list) {
  const host = $("amb-slot-filter");
  const note = $("amb-slot-filter-note");
  if (!host) return;
  if (!list.length) {
    host.innerHTML = "";
    if (note) note.textContent = "";
    return;
  }
  const order = state.ambV2Stations?.periods || [];
  const counts = new Map();
  list.forEach((s) => counts.set(s.period || "—", (counts.get(s.period || "—") || 0) + 1));
  // Chronological where the payload gives an order, then anything unexpected.
  const keys = order.filter((k) => counts.has(k));
  Array.from(counts.keys()).forEach((k) => {
    if (!keys.includes(k)) keys.push(k);
  });
  host.innerHTML = keys
    .map(
      (k) =>
        `<div class="sub-toggle sub-readout"><span class="swatch" style="background:#0f766e"></span>` +
        `<span>${k} <b>${(counts.get(k) || 0).toLocaleString()}</b></span></div>`
    )
    .join("");
  if (note) {
    note.innerHTML =
      `Observed time period &mdash; the only breakdown this feed carries. ` +
      `The rows sum to <b>${list.length.toLocaleString()}</b>, the count above.`;
  }
}

// --- ambulance stations, drawn as icons and coloured by capability ---------
// ALS and BLS are the trauma-relevant fleet and must be told apart at a
// glance; PTA/KILKARI/NEONATE are transport vehicles and are muted so they
// never read as emergency cover.
function renderAmbulances() {
  layers.ambCurrent.clearLayers();

  /* The v2 workbook has no vehicle types, so the ALS/BLS/PTA toggles do not
     apply to it and every station is drawn in one neutral style. Filtering has
     already happened server-side by day/period/district, so whatever came back
     is exactly what belongs on the map. */
  if (ambDataset() === "new") return renderAmbV2Stations();

  const list = state.ambulances || [];
  if (!list.length) return;

  const active = new Set(
    Array.from(document.querySelectorAll(".amb-type-toggle:checked")).map((c) => c.value)
  );

  let shown = 0;
  list.forEach((a) => {
    const type = (a.vehicle_type || "").toUpperCase();
    if (active.size && !active.has(type)) return;
    const cfg = VEHICLE_STYLE[type] || VEHICLE_STYLE.OTHER;
    shown += 1;
    layers.ambCurrent.addLayer(
      L.marker([a.lat, a.lon], {
        icon: L.divIcon({
          className: "amb-icon",
          html: `<span class="amb-pin" style="background:${cfg.color};border-color:${cfg.ring}">${cfg.glyph}</span>`,
          iconSize: [0, 0],
        }),
        zIndexOffset: cfg.priority,
      })
        .bindTooltip(
          `<b>${a.vehicle_no || "Ambulance"}</b><br/>` +
            `${cfg.label}<br/>${a.stationed_at || "—"} · ${a.district}`,
          { direction: "top" }
        )
        .bindPopup(featurePopup("ambulance", a), { maxWidth: 320, className: "feature-popup" })
    );
  });
  $("badge-amb-stations").textContent = shown.toLocaleString();
}

// The Gaps tab gets its own ambulance layer: same fleet, but drawn alongside
// the gap cells so you can see whether a coverage hole also lacks a vehicle.
function renderGapAmbulances() {
  layers.gapAmbulances.clearLayers();
  const on = $("gap-layer-ambulances")?.checked && state.tab === "gaps";
  if (!on || !state.ambulances) {
    map.removeLayer(layers.gapAmbulances);
    if ($("badge-gap-amb")) $("badge-gap-amb").textContent = 0;
    return;
  }
  const district = $("gap-district")?.value || "";
  let shown = 0;
  state.ambulances.forEach((a) => {
    if (district && a.district !== district) return;
    const type = (a.vehicle_type || "").toUpperCase();
    const cfg = VEHICLE_STYLE[type] || VEHICLE_STYLE.OTHER;
    shown += 1;
    layers.gapAmbulances.addLayer(
      L.marker([a.lat, a.lon], {
        icon: L.divIcon({
          className: "amb-icon",
          html: `<span class="amb-pin" style="background:${cfg.color};border-color:${cfg.ring}">${cfg.glyph}</span>`,
          iconSize: [0, 0],
        }),
        zIndexOffset: cfg.priority,
      }).bindPopup(featurePopup("ambulance", a), { maxWidth: 320, className: "feature-popup" })
    );
  });
  layers.gapAmbulances.addTo(map);
  if ($("badge-gap-amb")) $("badge-gap-amb").textContent = shown.toLocaleString();
}

async function ensureAmbulances() {
  if (state.ambulances) return;
  const p = new URLSearchParams({ year: state.meta.year });
  if ($("amb-district").value) p.set("district", $("amb-district").value);
  const r = await getJSON(`/api/analytics/ambulances?${p}`);
  state.ambulances = r.ambulances;
  state.ambulanceCounts = r.by_type;
  Object.entries(r.by_type || {}).forEach(([t, n]) => {
    const el = $(`amb-n-${t}`);
    if (el) el.textContent = n;
  });
}

function renderAmbulanceGapStats() {
  const r = state.ambGaps;
  if (!r) return;
  const unreachable = r.gaps.filter((g) => g.road_km === null).length;
  const model = r.meta?.distance_model;
  $("amb-gap-stats").innerHTML = `
    <div class="stat-card"><span class="stat-value stat-red">${r.gap_count.toLocaleString()}</span>
      <span class="stat-label">Grids &ge; ${r.threshold_km} km from an ambulance</span></div>
    <div class="stat-card"><span class="stat-value">${r.gap_pct}%</span>
      <span class="stat-label">of all grid cells</span></div>
    <div class="stat-card"><span class="stat-value stat-red">${r.severity_pct}%</span>
      <span class="stat-label">of accident severity stranded</span></div>
    <div class="stat-card"><span class="stat-value">${r.covered.toLocaleString()}</span>
      <span class="stat-label">Grids within reach</span></div>`;
  $("badge-amb-gaps").textContent = r.gap_count.toLocaleString();
  renderAmbCharts();

  $("amb-gap-table").innerHTML =
    `<thead><tr><th>Grid</th><th>District</th><th class="num">Road</th><th>Nearest</th></tr></thead><tbody>` +
    r.gaps
      .slice(0, 40)
      .map(
        (g) => `<tr><td>${g.grid_id}</td><td>${g.district}</td>
          <td class="num">${g.road_km === null ? "&gt;60" : fmt(g.road_km, 1)} km</td>
          <td>${g.nearest_vehicle_no || "—"}<br/><span class="fp-sub">${g.nearest_vehicle_type || ""}</span></td></tr>`
      )
      .join("") +
    "</tbody>";

  $("amb-district-table").innerHTML =
    `<thead><tr><th>District</th><th class="num">Out-of-reach grids</th></tr></thead><tbody>` +
    r.by_district
      .map((d) => `<tr><td>${d.district}</td><td class="num">${d.gaps}</td></tr>`)
      .join("") +
    "</tbody>";

  setStatus(
    `${r.gap_count.toLocaleString()} grids are ${r.threshold_km} km or more from an ambulance ` +
      `(${r.source} positions, ${r.emergency_only ? "ALS+BLS only" : "all vehicles"})` +
      (unreachable ? ` · ${unreachable} have none within 60 km` : "") +
      (model === "straight_line_offline" || model === "straight_line_fallback"
        ? " · STRAIGHT-LINE, not road"
        : "")
  );
}

function syncAmbulanceLayers() {
  const pairs = [
    ["amb-layer-current", layers.ambCurrent],
    ["amb-layer-gaps", layers.ambGaps],
    ["amb-layer-covered", layers.ambCovered],
  ];
  pairs.forEach(([id, layer]) => {
    const on = $(id)?.checked;
    if (on && state.tab === "ambulance") layer.addTo(map);
    else map.removeLayer(layer);
  });
}

// ------------------------------------------------------------------ panels
// showGridDetail() removed 31 Aug 2026 with the "Selected feature" panel —
// it wrote a "hospitals within 60 km" table into #feature-details, which no
// longer exists. The grid popup's Nearby pane already lists the same rows,
// and it raced mirrorSelected() for that panel while it did.


// Only shown when the layer is actually on, and only for the levels left
// ticked — a legend row for something not drawn is worse than no row.
function hospLegendHtml() {
  let out = "";
  if (hospitalLayerToggle()?.checked) {
    /* CLICKABLE (31 Aug 2026), and every level is listed whether it is on or
       off. Previously the list was filtered to the levels currently shown,
       which made a switched-off level disappear from its own legend — leaving
       no way to switch it back on from here, and no hint that it existed.
       Struck-through-but-present is the readable state, and it matches how the
       band rows above behave. The Set is the same one the sidebar checkboxes
       write to, so the two views of this filter cannot drift. */
    out += visibleLevels()
      .map((lv) =>
        legendFilter("hospLevel", lv, LEVEL_SHORT[lv], {
          icon: hospIconHtml(lv, false, true),
          count: state.hospLevelCounts?.[lv],
        })
      )
      .join("");
    // Only when some are actually on screen. A hollow grey pin with no
    // explanation is worse than no row; a row for pins that are not drawn is
    // worse than that.
    if (state.hospContextPins) {
      out +=
        `<span class="legend-item">${hospIconHtml("", false, true, true)} ` +
        `Not a tier provider <b>${state.hospContextPins.toLocaleString()}</b></span>` +
        `<span class="legend-item muted">Real facilities that provide no L1/L2/L3 ` +
        `under the spec — mostly empanelled private hospitals the TPL dump ` +
        `defaulted to L2. They are not counted in reach. They follow the level ` +
        `rows above: switch every level off and they go too.</span>`;
    }
  }
  if ($("layer-bloodbanks")?.checked && state.tab !== "ambulance") {
    out +=
      `<span class="legend-item"><svg class="bs-svg bs-svg-legend" width="13" height="13" viewBox="0 0 24 24">` +
      `<path d="M12 2.5c4.2 5 6.8 8.3 6.8 11.4a6.8 6.8 0 1 1-13.6 0C5.2 10.8 7.8 7.5 12 2.5z" fill="#dc2626" stroke="#7f1d1d" stroke-width="1.5"/>` +
      `</svg> Blood storage (BS)</span>`;
  }
  return out;
}

// Collapses the legend's explanatory prose (the "why" paragraphs and the
// hospital-context footnote) behind a small (i) toggle next to the title, so
// the legend itself stays short -- the full explanation is one click away,
// not gone. Re-attached on every renderLegend() call since innerHTML wipes
// out the previous button along with everything else; the open/closed state
// lives on #map-legend's own classList, which innerHTML does not touch, so
// it survives across re-renders (filtering a band, switching colour mode).
function attachLegendInfo(el) {
  const title = el.querySelector(".legend-title");
  if (!title) return;
  if (!el.querySelector(".legend-hint, .legend-item.muted")) return;
  const row = document.createElement("div");
  row.className = "legend-title-row";
  title.replaceWith(row);
  row.appendChild(title);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "legend-info-btn";
  btn.title = "What this legend means";
  btn.setAttribute("aria-label", "Show legend explanation");
  btn.setAttribute("aria-expanded", el.classList.contains("legend-info-open") ? "true" : "false");
  btn.textContent = "i";
  btn.addEventListener("click", () => {
    const open = el.classList.toggle("legend-info-open");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    fpSyncAutoPan();
  });
  row.appendChild(btn);
}

/* How many cells sit in each ambulance band right now, so the legend can say
   what a click is about to hide. Counted from the SAME payload the cells are
   drawn from, and before the filter is applied — a row's count must not drop
   to zero the moment you switch it off. */
function ambLegendCounts() {
  const r = state.ambGaps;
  const band = { 3: 0, 2: 0, 1: 0, 0: 0 };
  const tss = { 3: 0, 2: 0, 1: 0, 0: 0 };
  if (!r) return { band, tss };
  const p95 = state.ambTssP95 || 1;
  (r.gaps || []).forEach((g) => {
    band[ambBand(g.road_km, r.threshold_km)] += 1;
    tss[severityBandIndex(g.severity_score || 0, p95)] += 1;
  });
  // Cells within reach are not in `gaps` at all — they are the covered count,
  // drawn from state.coverage by the in-reach layer.
  band[3] = r.covered ?? 0;
  return { band, tss };
}

/* The Gaps tab's equivalent of ambLegendCounts(). `band` keys match the paint
   in renderLevelReach: levels MET out of levels tested when all three public
   levels are in play, and a flat 0 ("fails the one thing tested") otherwise.
   Band 3 is the in-reach backdrop, which is a count, not a list. */
function gapLegendCounts(r, fullSet) {
  const band = { 3: 0, 2: 0, 1: 0, 0: 0 };
  const tss = { 3: 0, 2: 0, 1: 0, 0: 0 };
  if (!r) return { band, tss };
  const tested = payloadSegKeys(r).length;
  const p95 = state.gapTssP95 || 1;
  (r.out_reach || []).forEach((g) => {
    band[gapCellBand(g, tested, fullSet)] += 1;
    tss[severityBandIndex(g.severity_score || 0, p95)] += 1;
  });
  band[3] = r.in_count ?? 0;
  return { band, tss };
}

/** The band renderLevelReach paints a cell — one definition, two readers. */
function gapCellBand(g, testedCount, fullSet) {
  if (!fullSet) return 0;
  const missed = g.n_missed ?? missedKeys(g).length;
  return Math.max(0, Math.min(3, testedCount - missed));
}

/* The vehicle rows under the ambulance reach bands.
   OLD: the five vehicle types, clickable, kept in step with the sub-toggles in
   the Map-layers panel — one filter, two places to reach it.
   NEW: the workbook has no vehicle types and every station is drawn in one
   neutral style, so five coloured rows here described pins that are not on the
   map. One row, matching what is actually drawn. */
function ambVehicleLegendHtml() {
  if (ambDataset() === "new") {
    const n = state.ambV2Stations?.stations?.length;
    return (
      `<span class="legend-item"><i class="amb-pin amb-pin-legend" ` +
      `style="background:#0f766e;border-color:#134e4a">A</i> Ambulance sighting` +
      (n === undefined ? "" : ` <b>${n.toLocaleString()}</b>`) +
      `</span>`
    );
  }
  const counts = state.ambulanceCounts || {};
  return VEHICLE_ORDER.map((t) => {
    const c = VEHICLE_STYLE[t];
    const on = ambTypeShown(t);
    return (
      `<button type="button" class="legend-item legend-filter${on ? "" : " is-off"}" ` +
      `data-amb-type="${t}" aria-pressed="${on}" ` +
      `title="Click to ${on ? "hide" : "show"} these vehicles">` +
      `<i class="amb-pin amb-pin-legend" style="background:${c.color};border-color:${c.ring}">${c.glyph}</i> ` +
      `${c.label}${counts[t] === undefined ? "" : ` <b>${Number(counts[t]).toLocaleString()}</b>`}</button>`
    );
  }).join("");
}

/** Is this vehicle type currently ticked in the Map-layers sub-filter? */
function ambTypeShown(type) {
  const cb = document.querySelector(`.amb-type-toggle[value="${type}"]`);
  return cb ? cb.checked : true;
}

/* ==========================================================================
   Clickable legends  (31 Aug 2026)
   ==========================================================================
   Every legend row that keys a colour to a CATEGORY is a filter: all keys are
   drawn at first, clicking a row hides that category, clicking it again brings
   it back, and any number can be off at once. Proximity's reach bands already
   worked this way; this generalises the same behaviour to the ambulance reach
   bands, the Gaps bands, the severity bands in both TSS modes, and the
   hospital-level pins on every tab, so a swatch means the same thing and
   behaves the same way wherever it appears.

   ONE builder and ONE wiring pass rather than a handler per legend. Each row
   carries its group and key in data attributes; `LEGEND_FILTER_GROUPS` says,
   per group, which Set holds the visible keys and what has to be redrawn when
   it changes. Adding a filterable legend is then a row in that table, not
   another copy of the click plumbing.

   A row that is off is struck through and faded, NOT removed: its count is
   still the answer to "how many did I just hide", and a legend row that
   vanishes when clicked reads as a bug.

   THE LAST ROW CANNOT BE SWITCHED OFF. Emptying the set would paint a blank
   map with a full legend above it, which looks like a failed load rather than
   a filter — so the final active key ignores the click and says why. */

const LEGEND_FILTER_GROUPS = {
  ambBand: {
    set: () => state.ambBandFilter,
    redraw: () => {
      renderAmbulanceGaps();
      syncAmbulanceLayers();
    },
  },
  ambTss: {
    set: () => state.ambTssFilter,
    redraw: () => {
      renderAmbulanceGaps();
      syncAmbulanceLayers();
    },
  },
  gapBand: { set: () => state.gapBandFilter, redraw: () => renderLevelReach(false) },
  gapTss: { set: () => state.gapTssFilter, redraw: () => renderLevelReach(false) },
  hospLevel: {
    set: () => state.hospLevels,
    redraw: () => {
      /* The sidebar has the same filter as checkboxes. They are one piece of
         state, so the legend has to move them too — otherwise a level hidden
         from the legend shows a ticked box in the panel below. */
      document.querySelectorAll("input[data-level]").forEach((cb) => {
        cb.checked = state.hospLevels.has(cb.dataset.level);
      });
      renderHospitals();
    },
  },
};

/** One clickable legend row. `count` is optional; `icon` overrides the swatch. */
function legendFilter(group, key, label, opts = {}) {
  const on = LEGEND_FILTER_GROUPS[group].set().has(key);
  const mark =
    opts.icon ||
    `<i class="swatch" style="background:${opts.color};outline:1px solid #111"></i>`;
  const tail =
    opts.count === undefined || opts.count === null
      ? ""
      : ` <b>${Number(opts.count).toLocaleString()}</b>`;
  const sub = opts.sub ? ` <span class="fp-muted">&middot; ${opts.sub}</span>` : "";
  return (
    `<button type="button" class="legend-item legend-filter${on ? "" : " is-off"}" ` +
    `data-lf-group="${group}" data-lf-key="${key}" aria-pressed="${on}" ` +
    `title="Click to ${on ? "hide" : "show"} these">${mark} ${label}${sub}${tail}</button>`
  );
}

/** Wire every legendFilter() row inside `el`. Called once per renderLegend. */
function wireLegendFilters(el) {
  el.querySelectorAll("[data-lf-group]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const group = LEGEND_FILTER_GROUPS[btn.dataset.lfGroup];
      if (!group) return;
      const raw = btn.dataset.lfKey;
      // Band keys are numbers; level keys ("L1", "EP") are not. Round-tripping
      // through a data attribute stringifies both, so put the numbers back or
      // Set.has() misses every one of them.
      const key = /^-?\d+$/.test(raw) ? Number(raw) : raw;
      const set = group.set();
      if (set.has(key)) {
        if (set.size === 1) {
          setStatus("That is the last category on the map — turn another on first.");
          return;
        }
        set.delete(key);
      } else {
        set.add(key);
      }
      group.redraw();
      renderLegend();
    });
  });

  /* Vehicle types are the one filter whose source of truth is a checkbox, not
     a Set — the Map-layers sub-toggles own it. The legend row drives that
     checkbox rather than keeping a parallel copy, so the two can never
     disagree about which vehicles are on the map. */
  el.querySelectorAll("[data-amb-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cb = document.querySelector(`.amb-type-toggle[value="${btn.dataset.ambType}"]`);
      if (!cb) return;
      const on = Array.from(document.querySelectorAll(".amb-type-toggle:checked"));
      if (cb.checked && on.length === 1) {
        setStatus("That is the last vehicle type on the map — turn another on first.");
        return;
      }
      cb.checked = !cb.checked;
      renderAmbulances();
      renderLegend();
    });
  });
}

function renderLegend() {
  const el = $("map-legend");

  /* PROXIMITY TAB — the legend must describe the SAME rule the cells are
     painted by. It used to render the reference app's severity quartiles
     ("Grid Density Breakdown", bands like 14-191) while the cells were already
     being coloured by the reach verdict, so the map and its own key were
     answering two different questions in the same four colours. That is worse
     than no legend: the colours look explained, and the explanation is wrong.

     Overall/Grid now key on the four-band reach verdict; Hospital mode keys on
     that one level's binary in-reach test. Both read straight off the payload
     the cells are drawn from. */
  if (state.tab === "proximity") {
    if (proxMode() === "hospital") {
      const d = state.proxLevelData;
      if (d) {
        const band = (key, color, label, count) => {
          const on = state.proxLevelFilter.has(key);
          return `<button type="button" class="legend-item legend-band${on ? "" : " is-off"}"
              data-reach-ok="${key}" title="Click to ${on ? "hide" : "show"} these cells">
            <i class="swatch" style="background:${color};outline:1px solid #111"></i>
            ${label} <b>${count.toLocaleString()}</b>
          </button>`;
        };
        el.innerHTML =
          `<h3 class="legend-title">${d.level} reach &mdash; ${d.spec_km} km by road</h3>` +
          band("ok", PROX_MET_COLOR[2], `${d.level} in reach`, d.in_reach) +
          band("fail", PROX_MET_COLOR[0], `no ${d.level} in reach`, d.out_of_reach) +
          `<p class="legend-hint">Focused to <b>in reach</b> by default &mdash; grids that don't
             have an ${d.level} within ${d.spec_km} km are hidden, and only ${d.level} facilities
             are shown (the other two levels are hidden too). Click a swatch to bring the hidden
             grids back. ${d.hospital_count.toLocaleString()} ${d.level} facilities. Click a
             facility to list the grids it reaches, then click a grid to draw that route.</p>`;
        fpSyncAutoPan();
        attachLegendInfo(el);
        wireLegendFilters(el);
        el.querySelectorAll("[data-reach-ok]").forEach((btn) =>
          btn.addEventListener("click", () => {
            const key = btn.dataset.reachOk;
            if (state.proxLevelFilter.has(key)) {
              if (state.proxLevelFilter.size === 1) {
                setStatus("That is the last category on the map — turn another on first.");
                return;
              }
              state.proxLevelFilter.delete(key);
            } else state.proxLevelFilter.add(key);
            renderGrids();
            renderLegend();
            renderProxStats();
            fitProxLevelBounds();
          })
        );
      }
      return;
    }

    const o = state.proxOverview;
    if (!o) return;
    const bc = proxBandCounts(o);
    const rad = o.radii || PROX_LEVEL_SPEC;
    el.innerHTML =
      `<h3 class="legend-title">Levels in reach</h3>` +
      PROX_BAND_KEYS.map((k) => {
        const on = state.proxBandFilter.has(k);
        return `<button type="button" class="legend-item legend-band${on ? "" : " is-off"}"
              data-reach-band="${k}" title="Click to ${on ? "hide" : "show"} these cells">
            <i class="swatch" style="background:${proxBandColor(k)};border:1px solid #333"></i>
            ${proxBandLabel(k)} <b>${(bc[k] ?? 0).toLocaleString()}</b>
          </button>`;
      }).join("") +
      `<p class="legend-hint">A grid counts a level when at least one facility of that
        level is within its road radius &mdash; <b>L1 ${rad.L1} km</b>, <b>L2 ${rad.L2} km</b>,
        <b>L3 ${rad.L3} km</b>. The colour is how many of those three <b>public</b>
        levels it satisfies. <b>Purple</b> overrides that count: no public level in
        reach, but an <b>empanelled private hospital within ${rad.EP ?? EP_SPEC_KM} km</b>.
        Click a band to hide it; click again to bring it back.</p>` +
      (bc[3] === 0
        ? `<p class="legend-hint legend-warn">L1 has <b>no facilities in this data</b>
             &mdash; Haryana operates no public medical college or super-speciality
             hospital &mdash; so no grid can satisfy all three levels, and the
             light-yellow band is empty by construction. That absence is the gap,
             not a missing input.</p>`
        : "") +
      hospLegendHtml();

    // The legend just changed height; the padding derived from it is stale.
    fpSyncAutoPan();
    attachLegendInfo(el);
    // hospLegendHtml() contributes clickable level rows here too.
    wireLegendFilters(el);
    el.querySelectorAll("[data-reach-band]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const raw = btn.dataset.reachBand;
        const n = raw === "P" ? "P" : Number(raw);
        if (state.proxBandFilter.has(n)) {
          if (state.proxBandFilter.size === 1) {
            setStatus("That is the last band on the map — turn another on first.");
            return;
          }
          state.proxBandFilter.delete(n);
        } else state.proxBandFilter.add(n);
        renderGrids();
        renderLegend();
        renderProxStats();
      })
    );
    return;
  }

  if (state.tab === "ambulance") {
    const th = state.ambGaps?.threshold_km ?? 10;
    const byTss = state.ambColour === "tss";
    const counts = ambLegendCounts();
    const ambBody = byTss
      /* Same four Proximity colours as every other mode, quartiles of the
         95th percentile of severity on screen -- not a continuous ramp,
         which was the one place left painting outside that shared palette. */
      ? SEVERITY_BAND_ORDER.map((b) =>
          legendFilter("ambTss", b, SEVERITY_BAND_LABEL[b], {
            color: PROX_MET_COLOR[b],
            sub: `TSS ${severityBandRange(b, state.ambTssP95 || 1)}`,
            count: counts.tss[b],
          })
        ).join("")
      /* The four reach bands, spelled out in kilometres at the CURRENT
         threshold rather than as abstract multiples — "20-30 km" is checkable
         against a cell, "2-3x" is arithmetic the reader has to do. */
      : [3, 2, 1, 0]
          .map((b) =>
            legendFilter("ambBand", b, AMB_BAND_LABEL[b], {
              color: PROX_MET_COLOR[b],
              sub:
                b === 3 ? `under ${th} km`
                : b === 2 ? `${th}–${th * 2} km`
                : b === 1 ? `${th * 2}–${th * 3} km`
                : `${th * 3} km+ or none within 60 km`,
              count: counts.band[b],
            })
          )
          .join("");
    el.innerHTML = `<h3 class="legend-title">Ambulance reach</h3>
      ${ambBody}
      ${byTss
        ? legendFilter("ambBand", 3, "Within reach", {
            color: PROX_MET_COLOR[3],
            count: counts.band[3],
          })
        : ""}
      ${ambVehicleLegendHtml()}
      <p class="legend-hint">Click a band to hide those cells; click again to bring them
        back, and any number can be off at once. Cells are the true 1 km grid footprint.
        Same four colours as the Proximity tab &mdash; there they count how many of three
        levels are in reach, here they band how far past the ${th} km limit the cell sits.</p>`;
    attachLegendInfo(el);
    wireLegendFilters(el);
  } else if (state.tab === "gaps") {
    const rad = state.levelReach?.radii || state.levelKm;
    /* The legend now describes the SAME rule the cells are painted by
       (renderLevelReach), the way the Proximity legend already did — see the
       big comment at the top of this function. "Misses one/two/three" is
       only a meaningful gradient when all three public levels are being
       tested at once; narrowed to a single level, type, or "all types"
       (five, not three), a grid here has failed the one thing being tested
       and gets one swatch, not a fabricated three. */
    const gr = activeGapPayload();
    const testedKeys = payloadSegKeys(gr);
    const isType = state.gapSegment === "type";
    const fullSet = !isType && testedKeys.length === LEVELS.length;
    const singleKey = testedKeys.length === 1 ? testedKeys[0] : null;
    const singleLabel = singleKey ? (isType ? typeShort(singleKey) : (LEVEL_SHORT[singleKey] || singleKey)) : "the selected segment";
    const title = fullSet ? "Out of L1 / L2 / L3 reach" : `Out of ${singleLabel} reach`;

    const counts = gapLegendCounts(gr, fullSet);
    const body =
      state.gapColour === "tss"
        ? SEVERITY_BAND_ORDER.map((b) =>
            legendFilter("gapTss", b, SEVERITY_BAND_LABEL[b], {
              color: PROX_MET_COLOR[b],
              sub: `TSS ${severityBandRange(b, state.gapTssP95 || 1)}`,
              count: counts.tss[b],
            })
          ).join("")
        : fullSet
          ? legendFilter("gapBand", 2, "Misses one level", { color: PROX_MET_COLOR[2], count: counts.band[2] }) +
            legendFilter("gapBand", 1, "Misses two levels", { color: PROX_MET_COLOR[1], count: counts.band[1] }) +
            legendFilter("gapBand", 0, "Misses all three", { color: PROX_MET_COLOR[0], count: counts.band[0] })
          : legendFilter("gapBand", 0, `Not in reach of ${singleLabel}`, {
              color: PROX_MET_COLOR[0],
              count: counts.band[0],
            });
    el.innerHTML = `<h3 class="legend-title">${title}</h3>
      ${body}
      ${legendFilter("gapBand", 3, `In reach${fullSet ? " of all three" : ""}`, {
        color: PROX_MET_COLOR[3],
        count: counts.band[3],
      })}
      ${hospLegendHtml()}
      <p class="legend-hint">Click a band to hide those cells; click again to bring them back,
        and any number can be off at once.
        ${isType ? "Gaps measured against each kind of facility on its own radius." : "Public facilities only."} L1 within ${rad.L1} km, L2 within ${rad.L2} km, L3 within ${rad.L3} km by road. Click a cell for its nearest facility per level.</p>`;
    attachLegendInfo(el);
    wireLegendFilters(el);
  }
  /* REMOVED 31 Aug 2026 — a fourth branch drawing the continuous distance /
     TPL / severity ramp. It was unreachable: there are exactly three tabs
     (VIEWS), the proximity branch above returns in every path, and gaps and
     ambulance are handled here — so nothing could fall through to it. It was
     the only legend in the app that could not be made a filter, and asking why
     turned up the reason: it had not been on screen since the Proximity tab
     moved to the four-band reach verdict. The ramp itself still exists in
     gridColor() as the pre-verdict fallback paint; only its dead legend is
     gone. */
}

// ============ deliverables A and B: L1 / L2 / L3 road reach ==============
// One computation, two views. A grid is IN REACH when it satisfies all three
// conditions at once (L1 within 60 km, L2 within 30, L3 within 10). Tab 1
// shows the grids that pass; Tab 2 shows the ones that do not.
//
// Two readings of "does not pass" are both supported, because the spec can be
// read either way and they differ by two orders of magnitude:
//   complement  fails at least one level  — the true complement of A, every
//               grid lands in exactly one bucket
//   strict      fails all three levels    — the literal "not proximal to
//               60/30/10", which leaves partially-served grids in neither
/* EP SPLIT (25 Aug 2026). Empanelled private hospitals used to be counted as
   L1. They are now their own category, EP, and L1 is back to the spec's public
   MCH/SSH — of which Haryana has NONE, so L1 has zero facilities and every
   grid fails it. That empty set is the gap the team lead asked to surface.

   LEVELS  = the three PUBLIC levels the 0-3 grid score counts. Unchanged.
   EP_LEVEL / ALL_LEVELS = what the toggles, legends and popups enumerate. */
const LEVELS = ["L1", "L2", "L3"];
const EP_LEVEL = "EP";
const ALL_LEVELS = [...LEVELS, EP_LEVEL];

/** ALL_LEVELS filtered by the ignore-EP toggle. Every UI enumeration site —
 * toggles, legends, popups, sliders, chip renderers — reads this instead of
 * ALL_LEVELS directly, so EP simply does not appear anywhere on screen while
 * state.includeEP is false. The server already computes the underlying data
 * as if EP did not exist (see network_analytics._verdict_index); this is
 * what keeps the UI from contradicting that by drawing an EP row anyway. */
function visibleLevels() {
  return state.includeEP ? ALL_LEVELS : LEVELS;
}
// L2 was #2563eb until an CVD check put it 0.4 deltaE from L1 violet under
// deuteranopia — the two levels were one colour for a red-green colourblind
// reader. Orange lifts the worst pair to 10.7 and leaves L1 and L3 untouched.
// EP takes the same purple as the private-only grid fill, so the facility
// marker and the cell it explains read as one thing.
const LEVEL_COLOR = { L1: "#7c3aed", L2: "#eb6834", L3: "#0d9488", EP: "#9333ea" };
const LEVEL_SHORT = {
  L1: "L1 — MCH / SSH (public)",
  L2: "L2 — DH / DCH",
  L3: "L3 — CHC / SDH / PHC",
  EP: "EP — Empanelled Private",
};
// Shown under a level wherever its count would otherwise puzzle a reader.
const LEVEL_NOTE = {
  L1: "No public L1 facility exists in this data — every grid fails L1.",
  EP: "Private capacity, measured at 60 km. Counted separately from state provision.",
};
const EP_SPEC_KM = 60;
const LEVEL_MODE_NOTE = {
  complement:
    "A grid counts if it fails ANY level — no L1 in range, or no L2, or no L3. Every grid is either in reach or out of reach, so this pairs exactly with Tab 1.",
  strict:
    "A grid counts only if it fails ALL THREE at once. Much the smaller set; grids that reach some levels but not others appear in neither Tab 1 nor here.",
};

// --- facility-TYPE segmentation ------------------------------------------
// The parallel pass to LEVELS. Same shape of answer, keyed on what kind of
// facility a grid can reach rather than what service level it is assigned.
const TYPE_ORDER = ["DCH", "CH_SDH", "CHC", "PHC", "Empanelled Private Hospital"];
const TYPE_COLOR = {
  DCH: "#7c3aed",
  CH_SDH: "#2563eb",
  CHC: "#0d9488",
  PHC: "#16a34a",
  "Empanelled Private Hospital": "#d97706",
};

function typeShort(t) {
  return state.meta?.type_short?.[t] || t;
}
function typeLabel(t) {
  return state.meta?.type_labels?.[t] || t;
}

// Empty set means "All" — the toggle row's default and its explicit All button.
function activeSegKeys() {
  return state.gapSegment === "type"
    ? Array.from(state.segTypes)
    : Array.from(state.segLevels);
}

function segmentIsAll() {
  return activeSegKeys().length === 0;
}

/** The payload the Gaps tab is currently displaying, whichever pass produced it. */
function activeGapPayload() {
  return state.gapSegment === "type" ? state.typeReach : state.levelReach;
}

/** Segment keys present in the active payload, in display order. */
function payloadSegKeys(r) {
  if (!r) return [];
  if (state.gapSegment === "type") return r.types || [];
  // The payload names the levels it actually ran, so an EP-only run charts EP
  // rather than three empty public bars.
  return r.levels?.length ? r.levels : LEVELS;
}

/** Per-grid missed list, whichever segmentation is active. */
function missedKeys(g) {
  return (state.gapSegment === "type" ? g.types_missed : g.levels_missed) || [];
}

function levelRadii() {
  return { ...state.levelKm };
}

function typeRadii() {
  return { ...state.typeKm };
}

function levelQuery() {
  const r = levelRadii();
  const p = new URLSearchParams({ year: state.meta.year, mode: state.levelMode });
  visibleLevels().forEach((lv) => {
    if (r[lv] !== undefined) p.set(lv.toLowerCase(), r[lv]);
  });
  p.set("include_ep", state.includeEP ? "1" : "0");
  if ($("gap-district").value) p.set("district", $("gap-district").value);
  // A single-level segment is expressed as "only this level counts", which the
  // complement rule then evaluates on its own.
  const picked = Array.from(state.segLevels);
  if (picked.length) p.set("levels", picked.join(","));
  return p;
}

/**
 * Query for the tier-gap exports (gaps-bundle.zip, gaps-districts.csv).
 *
 * Those routes read PER-TIER thresholds by tier name (tertiary/secondary/
 * primary), not the L1/L2/L3 names levelQuery() emits, so this maps between
 * them rather than reusing levelQuery and silently falling back to the
 * server's uniform 60 km default — which is a different question and would
 * quietly return two rows instead of the set on screen.
 */
function gapExportQuery() {
  const r = levelRadii();
  const p = new URLSearchParams({ year: state.meta.year });
  p.set("tertiary", r.L1);
  p.set("secondary", r.L2);
  p.set("primary", r.L3);
  if ($("gap-district")?.value) p.set("district", $("gap-district").value);
  return p;
}

function typeQuery() {
  const r = typeRadii();
  const p = new URLSearchParams({ year: state.meta.year, mode: state.levelMode });
  TYPE_ORDER.forEach((t) => {
    const key = `r_${t.toLowerCase().replace(/ /g, "_")}`;
    if (r[t] != null) p.set(key, r[t]);
  });
  if ($("gap-district").value) p.set("district", $("gap-district").value);
  const picked = Array.from(state.segTypes);
  if (picked.length) p.set("types", picked.join(","));
  return p;
}

// --- segment toggle rows --------------------------------------------------
function buildSegmentToggles() {
  const lvWrap = $("gap-level-toggles");
  if (lvWrap) {
    /* "All levels" stays the three PUBLIC levels. EP is a fourth button next
       to them, never folded into "all": the combined gap question is about
       state provision, and sweeping private capacity into it would make the
       gap disappear rather than measure it. Picking EP asks the separate
       question — which grids no empanelled private hospital reaches. */
    lvWrap.innerHTML =
      `<button type="button" class="seg-btn active" data-seg-level="">All public levels</button>` +
      visibleLevels().map(
        (lv) =>
          `<button type="button" class="seg-btn" data-seg-level="${lv}" style="--seg:${LEVEL_COLOR[lv]}"
             title="${LEVEL_SHORT[lv]}${LEVEL_NOTE[lv] ? ` — ${LEVEL_NOTE[lv]}` : ""}">${lv}</button>`
      ).join("");
    lvWrap.querySelectorAll("[data-seg-level]").forEach((b) =>
      b.addEventListener("click", () => {
        const v = b.dataset.segLevel;
        state.segLevels = v ? new Set([v]) : new Set();
        lvWrap
          .querySelectorAll(".seg-btn")
          .forEach((o) => o.classList.toggle("active", o.dataset.segLevel === v));
        loadLevelReach();
      })
    );
  }

  const tyWrap = $("gap-type-toggles");
  if (tyWrap) {
    tyWrap.innerHTML =
      `<button type="button" class="seg-btn active" data-seg-type="">All types</button>` +
      TYPE_ORDER.map(
        (t) =>
          `<button type="button" class="seg-btn" data-seg-type="${t}" style="--seg:${TYPE_COLOR[t]}">${typeShort(t)}</button>`
      ).join("");
    tyWrap.querySelectorAll("[data-seg-type]").forEach((b) =>
      b.addEventListener("click", () => {
        const v = b.dataset.segType;
        state.segTypes = v ? new Set([v]) : new Set();
        tyWrap
          .querySelectorAll(".seg-btn")
          .forEach((o) => o.classList.toggle("active", o.dataset.segType === v));
        loadTypeReach();
      })
    );
  }
}

function buildTypeSliders() {
  const wrap = $("type-sliders");
  if (!wrap) return;
  wrap.innerHTML = "";
  TYPE_ORDER.forEach((t) => {
    const row = document.createElement("div");
    row.className = "tier-slider";
    row.innerHTML = `
      <div class="tier-slider-head">
        <span class="tier-slider-name" style="color:${TYPE_COLOR[t]}">${typeLabel(t)}</span>
        <span class="tier-slider-gap" id="tymiss-${t.replace(/ /g, "_")}">—</span>
      </div>
      <div class="tier-slider-row">
        <input type="range" min="2" max="80" step="1" value="${state.typeKm[t]}" />
        <input type="number" min="2" max="80" step="1" value="${state.typeKm[t]}" />
        <span class="unit-label">km</span>
      </div>`;
    wrap.appendChild(row);
    const [range, num] = row.querySelectorAll("input");
    const sync = (v) => {
      const n = Math.max(2, Math.min(80, Number(v) || 2));
      state.typeKm[t] = n;
      range.value = n;
      num.value = n;
    };
    range.addEventListener("input", () => sync(range.value));
    range.addEventListener("change", loadTypeReach);
    num.addEventListener("change", () => {
      sync(num.value);
      loadTypeReach();
    });
  });
}

function setGapSegment(seg) {
  state.gapSegment = seg;
  $("gap-segment")
    ?.querySelectorAll("button")
    .forEach((b) => b.classList.toggle("active", b.dataset.segment === seg));
  $("gap-level-segment")?.classList.toggle("hidden", seg !== "level");
  $("gap-type-segment")?.classList.toggle("hidden", seg !== "type");
  const note = $("gap-segment-note");
  if (note) {
    note.textContent =
      seg === "type"
        ? "Gaps measured against each kind of facility on its own radius. Includes empanelled private."
        : "Gaps measured against the L1/L2/L3 service levels at 60/30/10 km. Public facilities only.";
  }
  if (seg === "type") loadTypeReach();
  else loadLevelReach();
}

async function loadTypeReach() {
  if (state.tab !== "gaps") return;
  const seg = segmentIsAll() ? "every facility type" : Array.from(state.segTypes).map(typeShort).join(", ");
  setStatus(`Measuring every grid against ${seg}…`);
  try {
    const r = await getJSON(`/api/analytics/type-reach?${typeQuery()}`);
    state.typeReach = r;
    renderGapReach();
  } catch (err) {
    setStatus(err.message, true);
  }
}

function buildLevelKeys() {
  const html = visibleLevels().map(
    (lv) =>
      `<span><i style="background:${LEVEL_COLOR[lv]}"></i> ${LEVEL_SHORT[lv]}` +
      `<b id="lvkey-${lv}">${state.levelKm[lv]} km</b></span>`
  ).join("");
  $("level-key").innerHTML = html;
  $("reach-level-key").innerHTML = html.replace(/id="lvkey-/g, 'id="rlvkey-');
}

function buildLevelSliders() {
  const wrap = $("level-sliders");
  wrap.innerHTML = "";
  // EP gets a slider of its own so the private radius can be moved without
  // dragging L1's along with it — they are separate populations now.
  visibleLevels().forEach((lv) => {
    const row = document.createElement("div");
    row.className = "tier-slider";
    row.innerHTML = `
      <div class="tier-slider-head">
        <span class="tier-slider-name" style="color:${LEVEL_COLOR[lv]}">${LEVEL_SHORT[lv]}</span>
        <span class="tier-slider-gap" id="lvmiss-${lv}">—</span>
      </div>
      <div class="tier-slider-row">
        <input type="range" min="2" max="80" step="1" value="${state.levelKm[lv]}" />
        <input type="number" min="2" max="80" step="1" value="${state.levelKm[lv]}" />
        <span class="unit-label">km</span>
      </div>`;
    wrap.appendChild(row);
    const [range, num] = row.querySelectorAll("input");
    const sync = (v) => {
      const n = Math.max(2, Math.min(80, Number(v) || 2));
      state.levelKm[lv] = n;
      range.value = n;
      num.value = n;
      const k = $(`lvkey-${lv}`);
      if (k) k.textContent = `${n} km`;
      const rk = $(`rlvkey-${lv}`);
      if (rk) rk.textContent = `${n} km`;
    };
    range.addEventListener("input", () => sync(range.value));
    range.addEventListener("change", loadLevelReach);
    num.addEventListener("change", () => {
      sync(num.value);
      loadLevelReach();
    });
  });
}

/** Refetch whichever segmentation the Gaps tab is currently showing. */
function reloadActiveGapSegment() {
  return state.gapSegment === "type" ? loadTypeReach() : loadLevelReach();
}

async function loadDistrictTss() {
  try {
    const r = await getJSON(`/api/analytics/district-tss?year=${state.meta.year}`);
    state.districtTss = r;
    const top = r.districts[0];
    $("tss-stats").innerHTML = `
      <div class="stat-card"><span class="stat-value">${Math.round(r.state_tss).toLocaleString()}</span>
        <span class="stat-label">State TSS</span></div>
      <div class="stat-card"><span class="stat-value stat-red">${top.share_pct}%</span>
        <span class="stat-label">carried by ${top.district}</span></div>`;

    $("tss-table").innerHTML =
      `<thead><tr><th>#</th><th>District</th><th class="num">TSS</th><th class="num">Per cell</th><th class="num">Share</th></tr></thead><tbody>` +
      r.districts
        .map(
          (d) => `<tr><td>${d.rank}</td><td>${d.district}</td>
            <td class="num">${Math.round(d.tss).toLocaleString()}</td>
            <td class="num">${fmt(d.tss_per_cell, 1)}</td>
            <td class="num">${d.share_pct}%</td></tr>`
        )
        .join("") +
      "</tbody>";
    renderTssCharts();
  } catch (err) {
    $("tss-stats").innerHTML = `<p class="panel-note error">${err.message}</p>`;
  }
}

const GAP_COLOUR_NOTE = {
  levels:
    "Cells shaded by how many levels they fail — amber one, orange two, red all three.",
  tss: "Cells shaded by TSS, the RBG severity score for that 1 km cell. Scale fits the 95th percentile of the current result, so it re-fits when you filter. Use this to rank gaps by how much traffic injury they actually carry.",
};

function setGapColour(mode) {
  state.gapColour = mode;
  $("gap-colour")
    .querySelectorAll("button")
    .forEach((b) => b.classList.toggle("active", b.dataset.colour === mode));
  $("gap-colour-note").textContent = GAP_COLOUR_NOTE[mode];
  renderLevelReach(false);
}

function setLevelMode(mode) {
  state.levelMode = mode;
  $("gap-mode")
    .querySelectorAll("button")
    .forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("gap-mode-note").textContent = LEVEL_MODE_NOTE[mode];
  reloadActiveGapSegment();
}

async function loadLevelReach() {
  setStatus("Measuring every grid against L1 / L2 / L3 road reach…");
  try {
    const r = await getJSON(`/api/analytics/level-reach?${levelQuery()}`);
    state.levelReach = r;
    renderLevelReach();
    renderInReachPanel();
  } catch (err) {
    setStatus(err.message, true);
    if (err.message.includes("cache missing")) {
      setStatus(
        "Cache missing — run: python3 scripts/precompute_network_analytics.py --year 2025",
        true
      );
    }
  }
}

// --- Tab 1 side: the grids that PASS -------------------------------------
function renderInReachPanel() {
  const r = state.levelReach;
  if (!r) return;
  $("reach-stats").innerHTML = `
    <div class="stat-card"><span class="stat-value stat-green">${r.in_count.toLocaleString()}</span>
      <span class="stat-label">Grids in reach of all three</span></div>
    <div class="stat-card"><span class="stat-value">${r.in_pct}%</span>
      <span class="stat-label">of ${r.total_grids.toLocaleString()} grid cells</span></div>`;
  $("badge-in-reach").textContent = r.in_count.toLocaleString();
  renderLevelStrip();
  if ($("layer-in-reach")?.checked) renderInReachLayer();
}

function renderInReachLayer() {
  layers.inReach.clearLayers();
  const r = state.levelReach;
  if (!r || !$("layer-in-reach")?.checked || state.tab !== "proximity") {
    map.removeLayer(layers.inReach);
    return;
  }
  // Shown on its own, so it can afford the true 1 km footprint once zoomed in
  // — same treatment as the gap cells, which keeps the two tabs comparable.
  const asCells = map.getZoom() >= CELL_ZOOM;
  r.in_reach.forEach((g) => {
    const tip = `<b>Grid ${g.grid_id}</b> · ${g.district}<br/>In reach of L1, L2 and L3`;
    if (asCells) {
      const halfLon = CELL_HALF_LAT / Math.cos((g.lat * Math.PI) / 180);
      layers.inReach.addLayer(
        L.rectangle(
          [
            [g.lat - CELL_HALF_LAT, g.lon - halfLon],
            [g.lat + CELL_HALF_LAT, g.lon + halfLon],
          ],
          { color: "#166534", weight: 1, fillColor: "#16a34a", fillOpacity: 0.8 }
        ).bindTooltip(tip, { direction: "top" })
      );
    } else {
      layers.inReach.addLayer(
        L.circleMarker([g.lat, g.lon], {
          radius: 3,
          weight: 0,
          fillColor: "#16a34a",
          fillOpacity: 0.8,
        }).bindTooltip(tip, { direction: "top" })
      );
    }
  });
  layers.inReach.addTo(map);
}

// --- Tab 2 side: the grids that FAIL -------------------------------------
// Entry point the Gaps tab calls regardless of which segmentation is active.
function renderGapReach(refit = true) {
  renderLevelReach(refit);
}

function renderLevelReach(refit = true) {
  const r = activeGapPayload();
  if (!r) return;

  layers.grids.clearLayers();

  /* Faint backdrop of every grid, so an empty result still shows the state.
     Lightyellow, not slate -- the same colour Proximity uses for "all three
     in reach", so an uncoloured cell here reads the same way it does there.
     It is the legend's "In reach" row, so that row switches it off. */
  (state.gapBandFilter.has(3) ? state.coverage?.grids || [] : []).forEach((g) => {
    layers.grids.addLayer(
      L.circleMarker([g.lat, g.lon], {
        radius: 1.4,
        weight: 0,
        fillColor: PROX_MET_COLOR[3],
        fillOpacity: 0.4,
      })
    );
  });

  const zoom = map.getZoom();
  const showIds =
    $("gap-show-ids")?.checked !== false && r.out_count <= 400 && zoom >= 9;

  // Two questions, two colourings. "Levels missed" answers HOW BADLY a cell is
  // served; "TSS" answers HOW MUCH IT MATTERS — a cell missing all three levels
  // in empty country is a lower priority than one missing a single level on a
  // motorway that injures people weekly. The TSS ramp is fitted to the p95 of
  // the cells actually on screen, because severity is heavily skewed and a
  // fixed domain would render almost everything at the bottom of the scale.
  const byTss = state.gapColour === "tss";
  let tssP95 = 1;
  if (byTss) {
    const v = r.out_reach
      .map((g) => g.severity_score || 0)
      .sort((a, b) => a - b);
    tssP95 = v.length ? v[Math.floor(v.length * 0.95)] || 1 : 1;
  }
  state.gapTssP95 = tssP95;

  // The Analyse segment currently on screen, and whether it's the classic
  // "all three public levels" case -- the ONLY case where "how many levels
  // missed" is a meaningful 1-of-3/2-of-3/3-of-3 gradient. Narrowed to one
  // level, one type, or "all types" (five, not three), a grid in this list
  // has failed the one thing being tested, full stop -- one colour, not four.
  const testedKeys = payloadSegKeys(r);
  const gapFullSet = state.gapSegment === "level" && testedKeys.length === LEVELS.length;
  state.gapFullSet = gapFullSet;

  // Same true-1km-cell / zoomed-out-dot switch as Proximity, at the same
  // zoom threshold (CELL_ZOOM), painted with the identical helpers
  // (proxCellPaint / proxDotPaint) so a zoomed-out grid looks pixel-for-pixel
  // like it does on the Proximity tab instead of the old "always draw a tiny
  // rectangle, plus a separate translucent halo circle" approach.
  const asCell = zoom >= CELL_ZOOM;
  const scale = dotScale();

  r.out_reach.forEach((g) => {
    // Same four-colour palette as Proximity (PROX_MET_COLOR), counted the
    // identical way -- levels MET out of levels tested -- when all three
    // public levels are in play. Narrowed to a single level/type, every
    // cell here fails that one condition, so it gets Proximity's own
    // single-condition "fail" colour (red), same as Hospital mode.
    /* Legend filter, per colouring mode — same reasoning as the ambulance
       tab: the two modes band on different questions and must not share a
       switch just because they share a palette. */
    const cellBand = gapCellBand(g, testedKeys.length, gapFullSet);
    const tssBand = severityBandIndex(g.severity_score || 0, tssP95);
    if (byTss ? !state.gapTssFilter.has(tssBand) : !state.gapBandFilter.has(cellBand)) return;
    const fill = byTss ? PROX_MET_COLOR[tssBand] : PROX_MET_COLOR[cellBand];
    const style = { color: fill, radius: 3.6, opacity: 0.75, outline: "black", outlineWeight: 2 };

    let shape;
    if (asCell) {
      const halfLon = CELL_HALF_LAT / Math.cos((g.lat * Math.PI) / 180);
      shape = L.rectangle(
        [
          [g.lat - CELL_HALF_LAT, g.lon - halfLon],
          [g.lat + CELL_HALF_LAT, g.lon + halfLon],
        ],
        proxCellPaint(style, 1)
      );
    } else {
      shape = L.circleMarker([g.lat, g.lon], {
        radius: style.radius * scale,
        ...proxDotPaint(style, 1),
      });
    }

    layers.grids.addLayer(
      shape
        .bindTooltip(
          `<b>Grid ${g.grid_id}</b> · ${g.district}<br/>` +
            `Misses: <b>${missedKeys(g).join(", ")}</b><br/>` +
            `TSS <b>${fmt(g.severity_score, 1)}</b>`,
          { direction: "top" }
        )
        // Full record on click, per the "every icon shows its details" ask.
        .bindPopup(featurePopup("grid", g), { maxWidth: 340, className: "feature-popup" })
        .on("click", () => {
          // Centre the gap radar so the failing thresholds are visible as rings.
          state.radarGrid = g;
          state.gapRadarKind = "grid";
          updateGapRadar();
        })
    );

    if (showIds) {
      layers.grids.addLayer(
        L.marker([g.lat, g.lon], {
          interactive: false,
          icon: L.divIcon({
            className: "grid-id-label",
            html: `<span>${g.grid_id}</span>`,
            iconSize: [0, 0],
          }),
        })
      );
    }
  });
  layers.grids.addTo(map);

  // Frame the result, unless the redraw came from a zoom — fitBounds fires
  // zoomend, which would redraw, which would fit again.
  if (r.out_count && refit) {
    const lats = r.out_reach.map((g) => g.lat);
    const lons = r.out_reach.map((g) => g.lon);
    map.fitBounds(
      [
        [Math.min(...lats), Math.min(...lons)],
        [Math.max(...lats), Math.max(...lons)],
      ],
      { padding: [60, 60], maxZoom: 11 }
    );
  }

  renderLevelStats(showIds);
  renderLegend();
}

function renderLevelStats(showIds) {
  const r = activeGapPayload();
  if (!r) return;
  const rad = r.radii;
  const isType = state.gapSegment === "type";
  const keys = payloadSegKeys(r);
  const missCounts = isType ? r.missed_by_type || {} : r.missed_by_level || {};
  const keyColor = (k) => (isType ? TYPE_COLOR[k] : LEVEL_COLOR[k]) || "#64748b";
  const keyName = (k) => (isType ? typeLabel(k) : LEVEL_SHORT[k]);
  // "all three" is wrong the moment a single segment is selected.
  const scope = segmentIsAll()
    ? isType ? "all types" : "all three"
    : keys.map((k) => (isType ? typeShort(k) : k)).join(" + ");

  $("gap-stats").innerHTML = `
    <div class="stat-card"><span class="stat-value ${r.out_count ? "stat-red" : "stat-green"}">${r.out_count.toLocaleString()}</span>
      <span class="stat-label">Grids out of reach</span></div>
    <div class="stat-card"><span class="stat-value">${r.out_pct}%</span>
      <span class="stat-label">of ${r.total_grids.toLocaleString()} grid cells</span></div>
    <div class="stat-card"><span class="stat-value stat-red">${r.severity_out_pct}%</span>
      <span class="stat-label">of accident severity</span></div>
    <div class="stat-card"><span class="stat-value stat-green">${r.in_count.toLocaleString()}</span>
      <span class="stat-label">In reach of ${scope}</span></div>`;

  renderGapCharts();

  // Strict mode leaves partially-served grids in neither bucket. Saying so
  // out loud stops the two tabs looking like they disagree.
  const note = $("gap-empty-note");
  if (r.unclassified) {
    note.style.display = "";
    note.innerHTML = `<p class="panel-note"><b>${r.unclassified.toLocaleString()} grids are in neither list.</b>
      They reach at least one of ${scope} but not all, so the strict rule
      excludes them while Tab 1 does not count them as in reach. Switch to
      <b>Complement</b> to place every grid in exactly one bucket.</p>`;
  } else {
    note.style.display = "none";
  }

  $("tier-miss-breakdown").innerHTML = keys
    .map((k) => {
      const n = missCounts[k] || 0;
      const pct = r.total_grids ? ((100 * n) / r.total_grids).toFixed(1) : "0.0";
      const el = $(isType ? `tymiss-${k.replace(/ /g, "_")}` : `lvmiss-${k}`);
      if (el) {
        el.textContent = `${n.toLocaleString()} miss`;
        el.style.color = keyColor(k);
      }
      return `<div class="overlap-row">
      <span class="ov-dot" style="background:${keyColor(k)}"></span>
      <span>${keyName(k)} &mdash; beyond ${rad[k]} km</span>
      <b>${n.toLocaleString()}</b><i>${pct}%</i></div>`;
    })
    .join("");

  $("gap-grid-table").innerHTML =
    `<thead><tr><th>Grid</th><th>District</th><th>Misses</th><th class="num">Nearest</th></tr></thead><tbody>` +
    r.out_reach
      .slice(0, 60)
      .map(
        (g) => `<tr><td>${g.grid_id}</td><td>${g.district}</td>
          <td>${missedKeys(g).map((k) => (isType ? typeShort(k) : k)).join(", ")}</td>
          <td class="num">${g.closest_any_km === null ? "—" : fmt(g.closest_any_km, 1) + " km"}</td></tr>`
      )
      .join("") +
    "</tbody>";

  $("district-table").innerHTML =
    `<thead><tr><th>District</th><th class="num">Out</th><th class="num">In</th></tr></thead><tbody>` +
    r.by_district
      .map(
        (d) =>
          `<tr><td>${d.district}</td><td class="num">${d.out_reach}</td><td class="num">${d.in_reach}</td></tr>`
      )
      .join("") +
    "</tbody>";

  $("gap-label-note").textContent =
    r.out_count > 400
      ? `${r.out_count.toLocaleString()} cells — too many to label. Narrow by district.`
      : showIds
        ? ""
        : "Zoom in to level 9 or closer to see grid IDs.";

  const radText = keys
    .map((k) => `${isType ? typeShort(k) : k} ${rad[k]} km`)
    .join(", ");

  $("btn-export-gaps").disabled = r.out_count === 0;
  $("gap-export-note").textContent = `${r.out_count.toLocaleString()} rows · ${radText} · ${r.mode} rule`;

  setStatus(
    `${r.out_count.toLocaleString()} grids out of reach, ${r.in_count.toLocaleString()} in reach ` +
      `(${radText}, ${r.mode})`
  );
}

// showLevelDetail() removed 31 Aug 2026 with the "Selected feature" panel —
// it wrote a per-level nearest-facility table into #feature-details, which no
// longer exists. The same table is the grid popup's own Details pane.


// -------------------------------------------------------------- data loads
function coverageQuery() {
  // Tab 1 only. Tab 2 has its own strict-gap endpoint (loadTierGaps).
  const district = $("prox-district").value;
  const p = new URLSearchParams({
    year: state.meta.year,
    mode: "distance",
    private: $("prox-private").checked ? "1" : "0",
  });
  TIERS.forEach((t) => p.set(t.toLowerCase(), 60));
  if (district) p.set("district", district);
  return p.toString();
}

// Frame the map on the data. Without this, a stray zoom-out (or a district
// filter) leaves you staring at the subcontinent wondering where the grids went.
let hasFitted = false;
function fitToData(force = false) {
  const grids = state.coverage?.grids || [];
  if (!grids.length) return;
  if (hasFitted && !force) return;
  const lats = grids.map((g) => g.lat);
  const lons = grids.map((g) => g.lon);
  map.fitBounds(
    [
      [Math.min(...lats), Math.min(...lons)],
      [Math.max(...lats), Math.max(...lons)],
    ],
    { padding: [24, 24] }
  );
  hasFitted = true;
}

async function loadCoverage() {
  if (state.loading) return;
  state.loading = true;
  setStatus("Evaluating coverage…");
  try {
    state.coverage = await getJSON(`/api/analytics/coverage?${coverageQuery()}`);
    recomputeScales();
    fitToData();
    // Tab 2 draws its own layer. This request can finish while the user has
    // already switched tabs, so never paint over whoever owns the map now.
    if (state.tab === "proximity") {
      // The Proximity tab paints through its mode pipeline, which fetches the
      // verdicts for the current mode and then calls the renderers itself.
      await refreshProximityMode();
      setStatus(`${state.coverage.grids.length.toLocaleString()} grid cells loaded.`);
    } else if (state.tab === "gaps" && state.levelReach) {
      renderLevelReach();
    }
  } catch (err) {
    setStatus(err.message, true);
    if (err.message.includes("Proximity cache missing")) {
      setStatus(
        "Proximity cache missing — run: python3 scripts/precompute_network_analytics.py --year 2025",
        true
      );
    }
  } finally {
    state.loading = false;
  }
}

/**
 * Trigger a file download, and surface a server refusal instead of swallowing it.
 *
 * `window.location = url` was the old pattern. When the endpoint answers 404
 * "Nothing to export for the current selection" — which it legitimately does
 * whenever a filter empties a panel — the browser silently discards the JSON
 * and the button looks broken. This checks the response first and reports the
 * reason, then hands the blob to the browser.
 *
 * The blob round-trip also means a ZIP built on the fly keeps the filename the
 * server put in Content-Disposition, rather than inheriting the query string.
 */
async function downloadExport(url) {
  setStatus("Preparing download…");
  try {
    const resp = await fetch(apiUrl(url));
    if (!resp.ok) {
      let msg = `Export failed (${resp.status}).`;
      try {
        const body = await resp.json();
        if (body.error) msg = body.error;
      } catch {
        /* non-JSON error body — keep the status-code message */
      }
      setStatus(msg, true);
      return;
    }
    const disp = resp.headers.get("Content-Disposition") || "";
    const named = /filename="?([^";]+)"?/.exec(disp);
    const blob = await resp.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = named ? named[1] : "export";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on a timeout rather than immediately: Safari cancels an in-flight
    // download when the object URL disappears in the same tick as the click.
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
    setStatus(`Downloaded ${a.download}`);
  } catch (err) {
    setStatus(`Export failed: ${err.message}`, true);
  }
}

/* ---------------------------------------------------------------- datasets
   "old" is the fleet this tab was built on. "new" is the partner's filtered
   workbook — 142 stations, each stamped with ONE day and ONE time period.
   Both answer the same question (grids whose nearest station is >= threshold
   km by road) against different inputs, so they share every renderer below and
   differ only in which endpoint fills state.ambGaps and which filters apply. */
function ambDataset() {
  return state.ambDataset === "new" ? "new" : "old";
}

function ambGapParams() {
  if (ambDataset() === "new") {
    const p = new URLSearchParams({
      year: state.meta.year,
      threshold_km: $("amb-threshold").value,
    });
    // Repeatable params: the endpoint accepts several days/periods so this can
    // grow to multi-select without a second URL shape.
    if ($("amb-day")?.value) p.set("day", $("amb-day").value);
    if ($("amb-period")?.value) p.set("period", $("amb-period").value);
    if ($("amb-district").value) p.set("district", $("amb-district").value);
    return p;
  }
  const scope = document.querySelector('input[name="amb-scope"]:checked')?.value || "all";
  const p = new URLSearchParams({
    year: state.meta.year,
    threshold: $("amb-threshold").value,
    emergency_only: scope === "emergency" ? "1" : "0",
  });
  if ($("amb-district").value) p.set("district", $("amb-district").value);
  return p;
}

/** Normalise the v2 payload onto the shape every ambulance renderer expects. */
function adaptAmbV2(r) {
  return {
    ...r,
    source: "v2 workbook",
    total_grids: r.grids_total,
    covered: r.grids_covered,
    gap_count: r.grids_gap,
    /* The two PERCENTAGES were missed when this adapter was written, so the
       new dataset's stat cards read "undefined% of all grid cells" and
       "undefined% of accident severity stranded" — the same class of
       field-name mismatch as road_km below, just quieter because a broken
       percentage renders as text instead of painting the map black. */
    gap_pct: r.pct_gap,
    severity_pct: r.pct_severity_in_gap,
    /* FIELD NAMES, not just totals. The v2 endpoint calls the distance
       `nearest_km` and the old one calls it `road_km`, and every renderer
       below reads `road_km`. Without this the colour ramp was fed `undefined`,
       produced NaN, and painted all 4,406 cells black — which is exactly what
       the map showed. Mapped here, once, rather than teaching each renderer
       about two field names. */
    gaps: (r.gaps || []).map((g) => ({
      ...g,
      road_km: g.nearest_km ?? null,
      nearest_vehicle_no: g.nearest_id ?? null,
      nearest_vehicle_type: g.nearest_day && g.nearest_period
        ? `${g.nearest_day} ${g.nearest_period}`
        : null,
      nearest_stationed_at: g.nearest_at ?? null,
    })),
    // v2 has no vehicle types, so the "what is covering the grids" mix chart
    // has nothing to say. Empty (not absent) so the renderer draws its own
    // empty state rather than throwing on a missing key.
    covered_by_type: {},
  };
}

/* ------------------------------------------------- ambulance reach bands
   The SAME four colours as the Proximity tab, because they mean the same
   thing to a reader: light yellow is fine, red is worst. What differs is what
   they are counting. Proximity has three conditions and colours by how many
   are met. An ambulance grid has ONE condition, so counting is not available —
   the bands come from how far PAST the threshold the cell sits:

     light yellow  inside the threshold          (in reach)
     yellow        threshold  to  2x threshold   (just outside)
     orange        2x  to  3x threshold
     red           3x threshold or beyond, or no ambulance in the 60 km cache

   Multiples of the threshold rather than fixed kilometres, so the bands
   re-scale with the slider instead of silently meaning something different at
   5 km than at 30 km. At the default 10 km that reads: <10, 10-20, 20-30, 30+.

   Returned as the same 3/2/1/0 index PROX_MET_COLOR uses, so both tabs paint
   from one palette and a legend swatch means one thing across the app. */
const AMB_BAND_LABEL = {
  3: "Within reach",
  2: "Just outside — up to 2× the limit",
  1: "2–3× the limit",
  0: "3×+ the limit, or none within 60 km",
};

function ambBand(roadKm, thresholdKm) {
  // No vehicle found in the whole 60 km search is worse than any finite
  // distance, so it lands in the bottom band rather than being left uncoloured.
  if (roadKm === null || roadKm === undefined || Number.isNaN(roadKm)) return 0;
  const t = thresholdKm || 10;
  if (roadKm < t) return 3;
  if (roadKm < t * 2) return 2;
  if (roadKm < t * 3) return 1;
  return 0;
}

async function loadAmbulanceGaps() {
  const isNew = ambDataset() === "new";
  setStatus(
    isNew
      ? "Scoring every grid against the filtered workbook sightings…"
      : "Routing every grid against the ambulance stations…"
  );
  try {
    if (isNew) {
      const [gaps, stations] = await Promise.all([
        getJSON(`/api/analytics/ambulance-v2/gaps?${ambGapParams()}`),
        getJSON(`/api/analytics/ambulance-v2/stations?${ambGapParams()}`),
      ]);
      state.ambV2Stations = stations;
      state.ambGaps = adaptAmbV2(gaps);
      populateAmbWhen(gaps);
    } else {
      await ensureAmbulances();
      state.ambGaps = await getJSON(`/api/analytics/ambulance-gaps?${ambGapParams()}`);
    }
    state.ambGapIds = new Set(state.ambGaps.gaps.map((g) => String(g.grid_id)));
    renderAmbulanceGaps();
    renderAmbSlotNote();
    // The legend now carries per-band counts and a vehicle-row set that
    // differs between datasets, so it has to be rebuilt with the data.
    renderLegend();
  } catch (err) {
    setStatus(err.message, true);
    if (err.message.includes("cache missing")) {
      const cmd = isNew
        ? "python3 scripts/build_ambulances_v2.py && python3 scripts/precompute_ambulance_v2_reach.py --year 2025"
        : "python3 scripts/precompute_ambulance_reach.py --year 2025";
      setStatus(`Ambulance reach cache missing — run: ${cmd}`, true);
    }
  }
}

/** Fill the Day / Time period dropdowns from the payload, preserving choice. */
function populateAmbWhen(r) {
  const fill = (id, values, allLabel) => {
    const el = $(id);
    if (!el || el.dataset.filled === "1") return;
    const keep = el.value;
    el.innerHTML =
      `<option value="">${allLabel}</option>` +
      values.map((v) => `<option value="${v}">${v}</option>`).join("");
    el.value = keep;
    el.dataset.filled = "1";
  };
  fill("amb-day", r.available_days || [], "All days");
  fill("amb-period", r.available_periods || [], "All time periods");
}

/**
 * Say how many stations are actually behind the current answer, and warn when
 * that number is too small to carry the conclusion.
 *
 * Without this the map simply turns red as you narrow the filter and reads as
 * "coverage collapses at night", when what has really happened is that the
 * sample fell to two rows. The server decides the threshold (thin_slice), not
 * the UI, so the export and the screen can never disagree about it.
 */
function renderAmbSlotNote() {
  const note = $("amb-slot-note");
  const warn = $("amb-slot-warn");
  const r = state.ambGaps;
  if (!note || !warn) return;
  if (ambDataset() !== "new" || !r) {
    note.textContent = "";
    warn.classList.add("hidden");
    return;
  }
  /* Two counts, because a district selection makes them differ and showing
     only one made the sidebar contradict the map badge: the badge counts the
     stations DRAWN (district-filtered), this used to count the stations the
     ANSWER is measured against (never district-filtered, because a station
     just over the line still reaches a grid inside it). */
  const inDistrict = r.stations_in_district ?? r.station_count ?? 0;
  const district = r.district;
  note.innerHTML =
    `<b>${(r.station_count ?? 0).toLocaleString()}</b> of ` +
    `${(r.station_total ?? 0).toLocaleString()} sightings match this day / time filter` +
    (district && inDistrict !== r.station_count
      ? `, of which <b>${inDistrict.toLocaleString()}</b> fall inside ${district} &mdash;
         the number on the map. Reach is measured against all
         ${(r.station_count ?? 0).toLocaleString()}, since an ambulance seen just over
         the district line still reaches a grid inside it.`
      : ".");
  if (r.thin_slice) {
    warn.classList.remove("hidden");
    warn.innerHTML =
      `<b>Thin slice.</b> Every row in this workbook is a single sighting ` +
      `stamped with one day and one time period, so this filter leaves only ` +
      `<b>${r.station_count}</b>. The gap count below is telling you about the ` +
      `size of the sample, not about coverage collapsing. Widen the filter to ` +
      `compare like with like.`;
  } else {
    warn.classList.add("hidden");
  }
}

/** Show the filters that belong to the active dataset, hide the others. */
function syncAmbDatasetChrome() {
  const isNew = ambDataset() === "new";
  document.querySelectorAll("#amb-dataset button").forEach((b) =>
    b.classList.toggle("active", b.dataset.dataset === ambDataset())
  );
  /* The New feed's 142 rows are ambulances SEEN at a place on one day in one
     three-hour slot — 142 rows at 133 distinct coordinates — not 142 permanent
     posts. "Stations" claimed the second thing. Old is left alone: those really
     are vehicles at their parking sites. */
  const currentLabel = $("amb-layer-current-label");
  if (currentLabel) {
    currentLabel.textContent = isNew ? "Ambulance sightings" : "Ambulance stations";
  }
  $("amb-scope-wrap")?.classList.toggle("hidden", isNew);
  $("amb-when-wrap")?.classList.toggle("hidden", !isNew);
  document.querySelectorAll(".amb-new-only").forEach((el) =>
    el.classList.toggle("hidden", !isNew)
  );
  /* The mirror of the line above, added 31 Aug 2026. Without it the vehicle-
     type sub-toggles and the vehicle-mix chart — both of which only exist for
     the 569-vehicle fleet — stayed on screen in NEW mode, where they read as a
     breakdown of 142 stations that sums to 569 and as "nothing is covered". */
  document.querySelectorAll(".amb-old-only").forEach((el) =>
    el.classList.toggle("hidden", isNew)
  );
  const note = $("amb-dataset-note");
  if (note) {
    note.innerHTML = isNew
      ? `<b>142 ambulance sightings</b>, each stamped with one day and one time
         period, road distances from OSRM. There are no vehicle types in this
         feed, so the ALS/BLS scope filter and the vehicle-type map rows do not
         apply and are hidden.
         <br/><b>Not comparable with Old.</b> Old counts 569 vehicles treated as
         always on station; this counts 142 point-in-time sightings. The higher
         gap figure here is mostly that difference, not a change on the ground.`
      : `The fleet this tab was built on &mdash; <b>569 ambulances</b> with vehicle
         types, unchanged. Deduplicated from 1,138 source rows, each of which
         appears exactly twice.`;
  }
  const exp = $("amb-export-note");
  if (exp) {
    exp.innerHTML = isNew
      ? `Exports carry the dataset, threshold, day, period and district they were
         taken under, plus a thin-slice warning when one applies.`
      : `Exports carry the threshold, vehicle scope and district they were taken under.`;
  }
}

async function setAmbDataset(which) {
  if (ambDataset() === which) return;
  state.ambDataset = which === "new" ? "new" : "old";
  syncAmbDatasetChrome();
  await loadAmbulanceGaps();
}

// -------------------------------------------------------------------- init
function wireEvents() {
  document.querySelectorAll(".tab, .rail-btn").forEach((b) =>
    b.addEventListener("click", () => showTab(b.dataset.tab))
  );

  /* The one app-wide toggle, in the header rather than either sidebar so it
     survives a tab switch untouched. Flipping it does not just repaint —
     _verdict_index on the server recomputes every grid's colour and every gap
     count as though empanelled private hospitals were not in the data at all,
     so every cache downstream of that has to be thrown away, not just the
     part currently on screen. Ambulance is left alone: nothing it shows comes
     from a hospital level. */
  $("global-include-ep")?.addEventListener("change", async (e) => {
    state.includeEP = e.target.checked;
    state.hospitals = null;
    state.proxOverview = null;
    state.proxVerdict = null;
    state.proxLevelData = null;
    state.proxLevelVerdict = null;
    state.proxGridDetail = null;
    state.proxHospDetail = null;
    state.hospCoverage = null;
    state.levelReach = null;
    clearProxBranches();
    setStatus(
      e.target.checked
        ? "Including Empanelled Private — recomputing…"
        : "Ignoring Empanelled Private — recomputing…"
    );
    try {
      if (state.tab === "proximity") {
        await refreshProximityMode();
        await loadHospitalCoverage();
      } else if (state.tab === "gaps") {
        await reloadActiveGapSegment();
      }
      if (hospitalLayerToggle()?.checked) {
        await ensureHospitals();
        renderHospitals();
      }
      buildSubFilters();
      renderLegend();
      setStatus(
        e.target.checked ? "Including Empanelled Private." : "Ignoring Empanelled Private."
      );
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  /* Back and Forward. Without this the rail pushes history entries that no one
     can return to — the URL would change and the Back button would silently do
     nothing, which is worse than never touching history at all. `silent` stops
     us re-pushing the entry the browser just popped. */
  // Sub-tab buttons. Delegated per bar rather than per button so the three
  // bars are wired by one pass and a template edit that adds a section needs no
  // change here.
  document.querySelectorAll(".sub-tabs").forEach((bar) => {
    bar.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".sub-tab");
      if (!btn) return;
      showSub(btn.dataset.view, btn.dataset.sub);
    });
  });

  /* What counts as "you shaped this section's map". Only these mark a section
     as remembered — merely opening it does not, so a section you never touched
     never moves the map when you return to it. */
  map.on("moveend zoomend", markSubTouched);
  Object.values(SUB_LAYER_TOGGLES).flat().forEach((id) => {
    $(id)?.addEventListener("change", markSubTouched);
  });

  window.addEventListener("popstate", (ev) => {
    const r = routeFromUrl();
    const name = ev.state?.tab || r.view;
    const sub = ev.state?.sub || r.sub;
    showTab(name, { silent: true, sub });
  });

  /* Chrome only at this point. The full showTab() triggers per-view data loads,
     and wireEvents() runs BEFORE loadCoverage() — firing them here would race
     the boot sequence and double-fetch. init() calls showTab() properly once
     the caches are in. What this does do is put the right panel and the right
     rail button on screen immediately, so a deep link to /gaps never flashes
     the Proximity panel first. */
  const boot = routeFromUrl();
  state.tab = boot.view;
  state.sub[boot.view] = boot.sub;
  syncViewChrome(state.tab, { replace: true });
  showSub(boot.view, boot.sub, { silent: true });





  document.querySelectorAll('input[name="prox-colour"]').forEach((r) =>
    r.addEventListener("change", () => {
      renderGrids();
      renderLegend();
    })
  );

  $("prox-private").addEventListener("change", loadCoverage);

  /* Old / New grid palette. Switching repaints from the SAME loaded data — no
     refetch — so the two are directly comparable on identical cells. */
  // Paint the bar's resting state on load, so it says "Old — no network is
  // used" from the first frame rather than staying blank until you touch it.
  renderLiveStatus();

  /* Old mode is retired, so this runs once at boot instead of on a click.
     The reference app has no distance or TPL colouring — its map is a severity
     choropleth — so those radios are disabled and told why, rather than left
     looking live but inert. */
  applyNewModeChrome();
  probePartner();
  initProximityModes();

  // --- Tabs 1 + 2: the shared L1/L2/L3 rule -------------------------------
  $("gap-district").addEventListener("change", (e) => {
    // Gaps and Ambulances used to filter the data but leave the map wherever it
    // was, so picking a district changed the numbers without changing the view.
    // Both now frame and outline the district, matching Proximity.
    highlightDistrict(e.target.value);
    zoomToDistrict(e.target.value);
    reloadActiveGapSegment();
    if ($("gap-layer-hospitals").checked) {
      ensureHospitals().then(renderHospitals).catch(() => {});
    }
    if ($("gap-layer-ambulances")?.checked) {
      ensureAmbulances().then(renderGapAmbulances).catch(() => {});
    }
  });

  $("gap-layer-hospitals").addEventListener("change", async (e) => {
    if (!e.target.checked) return renderHospitals();
    try {
      await ensureHospitals();
      renderHospitals();
      renderLegend();
    } catch (err) {
      setStatus(err.message, true);
      e.target.checked = false;
    }
  });

  $("gap-layer-ambulances")?.addEventListener("change", async (e) => {
    if (!e.target.checked) return renderGapAmbulances();
    try {
      await ensureAmbulances();
      renderGapAmbulances();
    } catch (err) {
      setStatus(err.message, true);
      e.target.checked = false;
    }
  });

  $("gap-show-ids").addEventListener("change", () => renderGapReach(false));

  // --- Gaps segmentation: level vs facility type --------------------------
  $("gap-segment")
    ?.querySelectorAll("button")
    .forEach((b) => b.addEventListener("click", () => setGapSegment(b.dataset.segment)));

  $("btn-type-reset")?.addEventListener("click", () => {
    state.typeKm = { ...(state.meta?.defaults?.type_km || state.typeKm) };
    buildTypeSliders();
    loadTypeReach();
  });

  // --- Radar --------------------------------------------------------------
  ["prox-radar", "prox-radar-sweep"].forEach((id) =>
    $(id)?.addEventListener("change", updateProximityRadar)
  );
  $("prox-radar-rings")?.addEventListener("change", updateProximityRadar);
  ["gap-radar", "gap-radar-sweep"].forEach((id) =>
    $(id)?.addEventListener("change", updateGapRadar)
  );

  // --- Grid ID search (all tabs) ------------------------------------------
  initGridSearchControl();
  $("btn-grid-search")?.addEventListener("click", () => searchGridId($("grid-search").value));
  $("grid-search")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      searchGridId(e.target.value);
    }
    // Escape collapses rather than only clearing the field — the control is an
    // overlay on the map, so "get this out of my way" is the likelier intent.
    if (e.key === "Escape") setGridSearchOpen(false);
  });

  $("gap-mode")
    .querySelectorAll("button")
    .forEach((b) => b.addEventListener("click", () => setLevelMode(b.dataset.mode)));

  $("gap-colour")
    .querySelectorAll("button")
    .forEach((b) => b.addEventListener("click", () => setGapColour(b.dataset.colour)));

  $("btn-level-spec").addEventListener("click", () => {
    state.levelKm = { ...(state.meta.defaults?.level_km || { L1: 60, L2: 30, L3: 10, EP: 60 }) };
    buildLevelSliders();
    buildLevelKeys();
    loadLevelReach();
  });

  const levelExportUrl = (which) => {
    const p = levelQuery();
    p.set("which", which);
    return `/api/analytics/export/level-reach.csv?${p}`;
  };
  // The gap export follows the active segmentation, so what you download is
  // always what the map is showing.
  $("btn-export-gaps").addEventListener("click", () => {
    if (state.gapSegment === "type") {
      const p = typeQuery();
      p.set("which", "out_reach");
      downloadExport(`/api/analytics/export/type-reach.csv?${p}`);
    } else {
      downloadExport(levelExportUrl("out_reach"));
    }
  });
  $("btn-export-in-reach").addEventListener("click", () =>
    downloadExport(levelExportUrl("in_reach"))
  );
  $("btn-export-tss").addEventListener("click", () =>
    downloadExport(`/api/analytics/export/district-tss.csv?year=${state.meta.year}`)
  );

  /* ------------------------------------------------------ new export buttons
     Each carries the filters its own tab is showing, via the same query
     builders the on-screen analysis uses (proxQuery / gapQuery), so a file can
     never describe a different slice from the panel it sits under. Oversized
     results come back as a ZIP of numbered parts — handled server-side, so
     nothing here needs to know which it will get. */
  $("btn-export-prox-verdicts")?.addEventListener("click", () =>
    downloadExport(`/api/analytics/export/proximity-verdicts.csv?${proxQuery()}`)
  );
  $("btn-export-prox-facilities")?.addEventListener("click", () =>
    downloadExport(`/api/analytics/export/proximity-facilities.csv?${proxQuery()}`)
  );
  $("btn-export-cov-tpl")?.addEventListener("click", () =>
    downloadExport(`/api/analytics/export/proximity-facilities.csv?${proxQuery()}`)
  );
  $("btn-export-level-reach")?.addEventListener("click", () =>
    downloadExport(levelExportUrl("in_reach"))
  );
  $("btn-export-prox-bundle")?.addEventListener("click", () => {
    // proxQuery() hands back a STRING, not a URLSearchParams — re-parse it
    // rather than calling .set() on it, which throws and leaves the button
    // looking dead.
    const p = new URLSearchParams(proxQuery());
    // Explicit either way: the server defaults this bundle to split, so "0" is
    // what actually turns it off.
    p.set("split_district", $("prox-bundle-split")?.checked ? "1" : "0");
    downloadExport(`/api/analytics/export/proximity-bundle.zip?${p}`);
  });

  $("btn-export-gap-districts")?.addEventListener("click", () =>
    downloadExport(`/api/analytics/export/gaps-districts.csv?${gapExportQuery()}`)
  );
  $("btn-export-gap-bundle")?.addEventListener("click", () => {
    const p = gapExportQuery();
    // Radii by L-name too: the bundle scopes each level with level_reach(),
    // which reads l1/l2/l3, while gaps-districts.csv reads the tier names.
    const r = levelRadii();
    visibleLevels().forEach((lv) => {
      if (r[lv] !== undefined) p.set(lv.toLowerCase(), r[lv]);
    });
    p.set("include_ep", state.includeEP ? "1" : "0");
    if ($("gap-bundle-split")?.checked) p.set("split_district", "1");
    downloadExport(`/api/analytics/export/gaps-bundle.zip?${p}`);
  });
  // The in-reach set is shown ON ITS OWN, not stacked on the distance
  // backdrop: both cover the whole state, so drawing them together just
  // repaints one over the other and neither reads. Swapping the base layer
  // out (and restoring it afterwards) is the same trick selectHospital uses.
  $("layer-in-reach").addEventListener("change", (e) => {
    if (e.target.checked) {
      state.gridsWasOn = $("layer-grids").checked;
      $("layer-grids").checked = false;
    } else {
      $("layer-grids").checked = state.gridsWasOn !== false;
    }
    renderGrids();
    renderInReachLayer();
    renderLegend();
  });



  // Changing the district invalidates the cached overlays — refetch scoped.
  $("prox-district").addEventListener("change", async (e) => {
    state.accidents = null;
    hasFitted = true; // zoomToDistrict owns the framing now, not fitToData
    highlightDistrict(e.target.value);
    zoomToDistrict(e.target.value);
    const note = $("prox-district-note");
    if (note) {
      note.innerHTML = e.target.value
        ? `Zoomed to <b>${e.target.value}</b>. Everything outside it is dimmed to context.`
        : "Pick a district to zoom to it and dim everything outside. Leave on <b>All districts</b> to see the whole state.";
    }
    await loadCoverage();
    await loadHospitalCoverage();
    await refreshLiveGridSeverity();
    if ($("layer-hospitals").checked) {
      await ensureHospitals();
      renderHospitals();
    }
    if ($("layer-accidents").checked) {
      await ensureAccidents();
      renderAccidents();
    }
  });

  $("layer-grids").addEventListener("change", renderGrids);

  $("layer-hospitals").addEventListener("change", async (e) => {
    if (!e.target.checked) return renderHospitals();
    try {
      await ensureHospitals();
      renderHospitals();
      renderLegend();
      setStatus(
        `${document.querySelector(".badge-hospitals")?.textContent || 0} hospitals shown.`
      );
    } catch (err) {
      setStatus(err.message, true);
      e.target.checked = false;
    }
  });

  $("layer-bloodbanks").addEventListener("change", async (e) => {
    if (!e.target.checked) return renderBloodbanks();
    try {
      await ensureBloodbanks();
      renderBloodbanks();
      renderLegend();
    } catch (err) {
      setStatus(err.message, true);
      e.target.checked = false;
    }
  });
  $("btn-export-bs").addEventListener("click", () =>
    downloadExport("/api/analytics/export/bloodbanks.csv")
  );

  $("layer-accidents").addEventListener("change", async (e) => {
    if (!e.target.checked) return renderAccidents();
    try {
      await ensureAccidents();
      renderAccidents();
      setStatus(`${$("badge-accidents").textContent} accidents shown.`);
    } catch (err) {
      setStatus(err.message, true);
      e.target.checked = false;
    }
  });

  const slider = $("amb-threshold");
  const num = $("amb-threshold-num");
  slider.addEventListener("input", () => (num.value = slider.value));
  slider.addEventListener("change", loadAmbulanceGaps);
  num.addEventListener("change", () => {
    slider.value = num.value;
    loadAmbulanceGaps();
  });

  document.querySelectorAll('input[name="amb-scope"]').forEach((r) =>
    r.addEventListener("change", loadAmbulanceGaps)
  );

  document.querySelectorAll("#amb-dataset button").forEach((b) =>
    b.addEventListener("click", () => setAmbDataset(b.dataset.dataset))
  );
  ["amb-day", "amb-period"].forEach((id) =>
    $(id)?.addEventListener("change", loadAmbulanceGaps)
  );
  // The station list is district-filtered server-side, so it has to be refetched.
  $("amb-district").addEventListener("change", (e) => {
    highlightDistrict(e.target.value);
    zoomToDistrict(e.target.value);
    state.ambulances = null;
    loadAmbulanceGaps();
  });
  $("amb-show-ids").addEventListener("change", () => renderAmbulanceGaps());

  $("amb-colour")
    .querySelectorAll("button")
    .forEach((b) =>
      b.addEventListener("click", () => {
        state.ambColour = b.dataset.colour;
        $("amb-colour")
          .querySelectorAll("button")
          .forEach((x) => x.classList.toggle("active", x === b));
        $("amb-colour-note").textContent = AMB_COLOUR_NOTE[state.ambColour];
        renderAmbulanceGaps();
        renderLegend();
      })
    );

  [
    "amb-layer-current",
    "amb-layer-gaps",
    "amb-layer-covered",
  ].forEach((id) => $(id).addEventListener("change", syncAmbulanceLayers));

  document.querySelectorAll(".amb-type-toggle").forEach((c) =>
    c.addEventListener("change", () => {
      renderAmbulances();
      // The legend shows the same five types, struck through when off.
      renderLegend();
    })
  );

  /* Every ambulance export goes through the SAME ambGapParams() the on-screen
     analysis used, so a downloaded file can never describe a different filter
     from the one the user is looking at. The v2 routes are separate endpoints
     because the two datasets take different filters. */
  $("btn-export-amb-gaps").addEventListener("click", () => {
    const url =
      ambDataset() === "new"
        ? "/api/analytics/export/ambulance-v2-gaps.csv"
        : "/api/analytics/export/ambulance-gaps.csv";
    downloadExport(`${url}?${ambGapParams()}`);
  });
  $("btn-export-amb-stations")?.addEventListener("click", () =>
    downloadExport(`/api/analytics/export/ambulance-v2-stations.csv?${ambGapParams()}`)
  );
  $("btn-export-amb-districts")?.addEventListener("click", () =>
    downloadExport(`/api/analytics/export/ambulance-v2-districts.csv?${ambGapParams()}`)
  );
  /* The old/new bundles are addressed explicitly rather than following the
     active dataset, so you can pull both without switching the tab back and
     forth — and so a file's name always says which source it came from. */
  const ambBundle = (which) => {
    const p = ambGapParams();
    p.set("dataset", which);
    if ($("amb-bundle-split")?.checked) p.set("split_district", "1");
    downloadExport(`/api/analytics/export/ambulance-bundle.zip?${p}`);
  };
  $("btn-export-amb-bundle-old")?.addEventListener("click", () => ambBundle("old"));
  $("btn-export-amb-bundle-new")?.addEventListener("click", () => ambBundle("new"));

  /* The pair repeated in the Controls panel. These DO follow the active
     dataset: they sit under the dataset switch, so "download what I am looking
     at" is the only reading available there — the explicit old/new pair stays
     on the Data sub-tab for pulling both at once. */
  $("btn-amb-quick-gaps")?.addEventListener("click", () =>
    $("btn-export-amb-gaps").click()
  );
  $("btn-amb-quick-bundle")?.addEventListener("click", () => ambBundle(ambDataset()));

  // Dot size is zoom-dependent and cells switch to their true 1 km footprint at
  // zoom 10, so a redraw is needed whenever the zoom level changes.
  let lastZoom = map.getZoom();
  map.on("zoomend", () => {
    const z = map.getZoom();
    const crossed = (lastZoom < CELL_ZOOM) !== (z < CELL_ZOOM);
    if (crossed || z !== lastZoom) {
      lastZoom = z;
      // A feature popup open right now is bound (via bindPopup) to one of
      // the very markers this redraw is about to clearLayers() away --
      // Leaflet wires every such layer's "remove" event straight to
      // closePopup(), so rebuilding the layer out from under an open popup
      // closes it on the spot. That is exactly what clicking a route inside
      // a Proximity popup used to do: the click reframes the map
      // (frameProxPair), reframing can cross a zoom level, and this redraw
      // then killed the very popup the reader just clicked in. Defer it
      // instead -- popupclose picks pendingZoomRedraw back up the moment
      // there is no open popup left to lose (see below).
      if (map._popup) {
        pendingZoomRedraw = true;
        return;
      }
      runZoomLevelRedraw();
    }
  });

  // Search and type filter are client-side over the already-loaded list.
  let searchTimer;
  $("hosp-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderHospitalCoverage, 150);
  });
  $("hosp-type-select").addEventListener("change", renderHospitalCoverage);
  $("prox-radius-mode")
    .querySelectorAll("button")
    .forEach((b) =>
      b.addEventListener("click", () => setPerLevel(b.dataset.perlevel === "1"))
    );
  $("btn-clear-hospital").addEventListener("click", clearHospitalSelection);

  $("hosp-select").addEventListener("change", (e) => {
    if (e.target.value) selectHospital(e.target.value);
    else clearHospitalSelection();
  });

  $("btn-export-hosp-grids").addEventListener("click", () => {
    const p = new URLSearchParams({
      year: state.meta.year,
      per_level: state.perLevel ? "1" : "0",
      include_ep: state.includeEP ? "1" : "0",
    });
    if ($("prox-district").value) p.set("district", $("prox-district").value);
    if ($("hosp-type-select").value) p.set("types", $("hosp-type-select").value);
    if (state.selectedHospital) p.set("hospital_id", state.selectedHospital);
    if ($("grids-per-hospital").value) p.set("top_per_hospital", $("grids-per-hospital").value);
    downloadExport(`/api/analytics/export/hospital-grids.csv?${p}`);
  });
  $("grids-per-hospital").addEventListener("change", renderHospitalCoverage);

  // The ZIP is built server-side from ~145 MB of CSV, so it takes a few
  // seconds. Give the button a busy state — a silent 10s wait reads as broken.
  $("btn-export-hosp-zip").addEventListener("click", async (e) => {
    const btn = e.target;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Building ZIP…";
    setStatus("Building the ZIP — splitting into per-district CSVs…");
    try {
      const p = new URLSearchParams({
        year: state.meta.year,
        split: "district",
        per_level: state.perLevel ? "1" : "0",
        include_ep: state.includeEP ? "1" : "0",
      });
      if ($("prox-district").value) p.set("district", $("prox-district").value);
      if ($("hosp-type-select").value) p.set("types", $("hosp-type-select").value);
      if ($("grids-per-hospital").value)
        p.set("top_per_hospital", $("grids-per-hospital").value);

      const res = await fetch(apiUrl(`/api/analytics/export/hospital-grids-bundle.zip?${p}`));
      if (!res.ok) throw new Error((await res.json()).error || `Failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        res.headers.get("Content-Disposition")?.match(/filename="?([^"]+)"?/)?.[1] ||
        "hospital-grid-proximity.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus(`ZIP downloaded (${(blob.size / 1e6).toFixed(1)} MB).`);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
}

async function init() {
  try {
    state.meta = await getJSON("/api/analytics/meta");
  } catch (err) {
    setStatus(`Could not load analytics metadata: ${err.message}`, true);
    return;
  }

  const m = state.meta;

  // A throw anywhere in setup used to abort init() silently, leaving the page
  // frozen on its initial "Loading…" with every count at zero and no clue why.
  // Everything that touches the meta payload or the DOM goes inside the guard.
  try {
    // Open on the literal requirement: 60 km road distance for all three tiers.
    state.mode = "distance";
    state.thresholds = {
      ...(m.defaults?.spec_km || { Tertiary: 60, Secondary: 60, Primary: 60 }),
    };
    $("prox-radius").textContent = m.proximity_radius_km ?? 60;

    ["prox-district", "gap-district", "amb-district"].forEach((id) => {
      const sel = $(id);
      (m.districts || []).forEach((d) => sel.add(new Option(d, d)));
    });

    // Ships with meta, so the first district change zooms without a round trip.
    state.districtBounds = m.district_bounds || {};

    if (m.cache?.available) {
      $("stat-grids").textContent = (m.cache.grid_count || 0).toLocaleString();
      $("stat-hospitals").textContent = m.cache.hospital_count ?? "—";
      if (m.cache.distance_model === "straight_line_offline") {
        $("offline-banner").classList.remove("hidden");
      }
    }
    if (m.tpl?.available) {
      $("stat-tpl-real").textContent = m.tpl.real;
      $("stat-tpl-est").textContent = m.tpl.estimated;
    }

    buildSubFilters();
    // Spec radii come from the server so the constant lives in one place.
    state.levelKm = { ...(m.defaults?.level_km || state.levelKm) };
    state.typeKm = {
      ...(m.defaults?.type_km || {
        DCH: 60,
        CH_SDH: 30,
        CHC: 20,
        PHC: 10,
        "Empanelled Private Hospital": 30,
      }),
    };
    buildLevelSliders();
    buildLevelKeys();
    buildSegmentToggles();
    buildTypeSliders();
    $("gap-mode-note").textContent = LEVEL_MODE_NOTE[state.levelMode];
    $("gap-colour-note").textContent = GAP_COLOUR_NOTE[state.gapColour];
    $("amb-colour-note").textContent = AMB_COLOUR_NOTE[state.ambColour];
    $("prox-radius-note").textContent = PROX_RADIUS_NOTE[state.perLevel ? 1 : 0];
    $("gap-segment-note").textContent =
      "Gaps measured against the L1/L2/L3 service levels at 60/30/10 km. Public facilities only.";
    wireEvents();
    syncAmbDatasetChrome();
    renderLegend();
  } catch (err) {
    setStatus(`Page setup failed: ${err.message}`, true);
    console.error("network_analytics setup failed", err);
    return;
  }

  if (!m.cache?.available) {
    setStatus(
      `No cached grid–hospital matrix for ${m.year} — run: ` +
        `python3 scripts/precompute_network_analytics.py --year ${m.year}`,
      true
    );
    return;
  }
  await loadCoverage();
  await loadHospitalCoverage();
  await refreshLiveGridSeverity();
  // Deliverable A lives on tab 1, so the level pass has to run at startup
  // rather than waiting for tab 2 to be opened.
  await loadLevelReach();
  await loadDistrictTss();
  await loadSensitivity();

  /* Now that the caches are in, run the REAL view switch for whatever the URL
     asked for. wireEvents() only set the chrome; this is what loads that view's
     own dataset. Harmless for /proximity (its data is already loaded above) and
     necessary for /gaps and /ambulances, which own datasets nothing else
     fetches. */
  const r = routeFromUrl();
  showTab(r.view, { replace: true, sub: r.sub });
}

init();

/* ==========================================================================
   Sidebar charts
   ==========================================================================
   Every chart here is a second reading of a number the sidebar already prints
   in a table, never the only place a value exists. That is deliberate: the
   tables are the accessible twin, so nothing is locked behind a hover.

   Forms were chosen against the data's job, and two obvious-looking options
   were rejected on purpose:

     * No dual-axis charts. "Total TSS and TSS-per-cell on one plot" would have
       been the compact way to show that the two rank districts differently,
       but the alignment of two y-scales is arbitrary and invents a correlation
       the data does not contain. They are two ranked charts instead, and the
       comparison the reader makes is a real one.
     * No value-ramp on nominal categories. Bars are one colour; darker-where-
       bigger would burn the only free channel restating the bar length.
   ========================================================================== */

const VIZ_GRAY = "#94a3b8";

function vizMedian(arr) {
  const a = arr.filter((v) => v !== null && v !== undefined && !Number.isNaN(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function normDistrict(d) {
  return String(d || "").trim().toUpperCase();
}

/* Share of state TSS per district, keyed for joining onto any gap payload.
   Lets a gap bar carry a severity figure as a direct label instead of a second
   axis. */
function tssShareMap() {
  const out = {};
  (state.districtTss?.districts || []).forEach((d) => {
    out[normDistrict(d.district)] = d.share_pct;
  });
  return out;
}

/* ---------- Tab 1 · level strip ------------------------------------------
   The requirement asks for a "category wise TPL score". The supplied dump
   (hospid, district, state, hosp_level, total_score, lat, lon) carries one
   total per hospital and no category columns, so a per-category breakdown is
   not derivable from it. This is the honest substitute: preparedness read by
   facility category, with the count and catchment it has to carry. */
function renderLevelStrip() {
  const host = $("viz-level-strip");
  if (!host) return;
  const r = state.hospCoverage;
  if (!r) return;

  const groups = { L1: [], L2: [], L3: [], EP: [] };
  let unclassified = 0;
  r.hospitals.forEach((h) => {
    const lv = (h.hosp_level || "").trim().toUpperCase();
    if (groups[lv]) groups[lv].push(h);
    else unclassified += 1;
  });

  host.innerHTML = visibleLevels().map((lv) => {
    const g = groups[lv] || [];
    const tpl = vizMedian(g.map((h) => h.tpl));
    const grids = vizMedian(g.map((h) => h.grids_within_radius));
    return `<div class="viz-strip-cell" style="--cell-accent:${LEVEL_COLOR[lv]}"
        title="${LEVEL_SHORT[lv]}${LEVEL_NOTE[lv] ? ` — ${LEVEL_NOTE[lv]}` : ""}">
      <span class="k">${lv} &middot; ${state.levelKm[lv]} km</span>
      <span class="v">${g.length.toLocaleString()}</span>
      <span class="s">facilities<br/>TPL ${tpl === null ? "&mdash;" : fmt(tpl, 1)} med.<br/>${
        grids === null ? "&mdash;" : Math.round(grids).toLocaleString()
      } grids med.</span>
    </div>`;
  }).join("");

  const note = $("viz-level-strip-note");
  if (note) {
    note.innerHTML =
      `Median rather than mean &mdash; a handful of very large catchments would drag a mean well off ` +
      `where most facilities of that level actually sit.` +
      (unclassified
        ? ` <b>${unclassified.toLocaleString()}</b> facilities carry no L1/L2/L3 assignment (private and unclassified types) and are not counted here.`
        : "");
    // The "L1 count is mocked" sentence that used to close this line was
    // removed on 25 Aug 2026 along with the Tab 2 warning it pointed at. The
    // six fabricated medical colleges were deleted on 20 Aug; L1 is real data.
  }
}

/* ---------- Tab 1 · load vs preparedness ---------------------------------
   Log x. Catchments run from single digits at L3's 10 km to well over two
   thousand at L1's 60 km. A linear axis collapses the entire L3 population into
   the left-hand pixel column; a square-root axis was tried and still rendered
   1,180 L3 facilities as one solid blob. Log separates all three levels into
   readable bands. The ticks are labelled with the real grid counts, so the
   scale is compressed but never misstated. */
function renderCoverageTplScatter() {
  const host = $("viz-cov-tpl");
  if (!host) return;
  const r = state.hospCoverage;
  if (!r) return;

  const list = visibleHospitals().filter((h) => h.tpl !== null && h.tpl !== undefined);
  if (!list.length) {
    host.innerHTML = '<p class="viz-empty">No hospital in the current filter carries a TPL score.</p>';
    if ($("viz-cov-tpl-legend")) $("viz-cov-tpl-legend").innerHTML = "";
    return;
  }

  const maxG = Math.max(...list.map((h) => h.grids_within_radius), 1);
  const medTpl = vizMedian(list.map((h) => h.tpl)) ?? 0;

  const shapeFor = (lv) =>
    lv === "L1" ? "star" : lv === "L2" ? "square" : lv === "EP" ? "diamond" : "circle";
  const pts = list.map((h) => {
    const lv = (h.hosp_level || "").trim().toUpperCase();
    const known = visibleLevels().includes(lv);
    return {
      raw: h,
      x: Math.log10(1 + h.grids_within_radius),
      y: h.tpl,
      color: known ? LEVEL_COLOR[lv] : VIZ_GRAY,
      shape: known ? shapeFor(lv) : "circle",
      hollow: h.tpl_source !== "real",
      r: lv === "L1" ? 4.8 : lv === "L2" ? 3.8 : 3.2,
      opacity: known ? 0.82 : 0.35,
      label: h.hospital_name,
      tip:
        `<b>${h.hospital_name}</b><br/>${h.hosp_type} &middot; ${known ? lv : "unclassified"} &middot; ${h.district}<br/>` +
        `Grids served: <b>${h.grids_within_radius.toLocaleString()}</b> within ${h.radius_km} km<br/>` +
        `TPL ${fmt(h.tpl, 1)} <i>(${h.tpl_source})</i>`,
      onClick: () => selectHospital(h.hospital_id),
    };
  });

  // One direct label: the heaviest catchment sitting below the median TPL.
  // That single mark is the chart's whole argument; labelling more would just
  // be a number on every point.
  const strained = pts
    .filter((p) => p.y < medTpl)
    .sort((a, b) => b.x - a.x)[0];

  vizScatter(host, {
    points: pts,
    height: 214,
    xMax: Math.log10(1 + maxG),
    xNice: false,
    yMax: Math.max(...list.map((h) => h.tpl), 10),
    xLabel: "Grids served (log scale)",
    yLabel: "TPL score",
    xTickLabel: (v) => Math.round(Math.pow(10, v) - 1).toLocaleString(),
    yDecimals: 0,
    labelled: strained ? [{ x: strained.x, y: strained.y, label: truncateName(strained.label) }] : [],
    aria: "Hospitals plotted by grids served against TPL score",
  });

  vizLegend($("viz-cov-tpl-legend"), [
    { label: "L1 (star)", color: LEVEL_COLOR.L1 },
    { label: "L2 (square)", color: LEVEL_COLOR.L2 },
    { label: "L3 (disc)", color: LEVEL_COLOR.L3 },
    { label: "estimated TPL", color: VIZ.ink2, hollow: true },
  ]);

  const note = $("viz-cov-tpl-note");
  if (note) {
    const est = list.filter((h) => h.tpl_source !== "real").length;
    note.innerHTML =
      `${list.length.toLocaleString()} hospitals plotted. <b>${est.toLocaleString()}</b> carry an estimated score ` +
      `synthesised from the real per-type distribution &mdash; drawn hollow, and never to be quoted as measured.` +
      (strained
        ? ` Widest catchment below the median TPL of ${fmt(medTpl, 1)}: <b>${strained.raw.hospital_name}</b> ` +
          `(${strained.raw.grids_within_radius.toLocaleString()} grids, TPL ${fmt(strained.raw.tpl, 1)}).`
        : "");
  }
}

function truncateName(s) {
  s = String(s || "");
  return s.length > 16 ? s.slice(0, 15) + "…" : s;
}

/* ---------- Tab 1 · catchment distance decay ----------------------------- */
function renderDecayChart(rows, h0) {
  const host = $("viz-decay");
  if (!host || !rows || !rows.length) return;

  const radius = Number(h0.level_radius_km) || Math.max(...rows.map((g) => g.road_km_from_hospital));
  const bandKm = radius <= 12 ? 1 : radius <= 35 ? 2.5 : 5;
  const nBands = Math.max(1, Math.ceil(radius / bandKm));
  const bins = [];
  for (let i = 0; i < nBands; i++) {
    bins.push({
      count: 0,
      label: `${(i * bandKm).toFixed(bandKm < 1 ? 1 : 0)}–${((i + 1) * bandKm).toFixed(bandKm < 1 ? 1 : 0)} km`,
      tick: i === 0 || i === nBands - 1 || i === Math.floor(nBands / 2) ? String(Math.round((i + 1) * bandKm)) : undefined,
    });
  }
  rows.forEach((g) => {
    const i = Math.min(nBands - 1, Math.floor(g.road_km_from_hospital / bandKm));
    if (i >= 0) bins[i].count += 1;
  });

  vizHistogram(host, {
    bins,
    height: 150,
    xLabel: `Road km from ${truncateName(h0.hospital_name)} (radius ${radius} km)`,
    valueLabel: "Grids",
    aria: "Distribution of catchment grids by road distance",
  });
}

/* ---------- Tab 1 · district TSS, as two ranked charts -------------------
   Two charts rather than one with two scales. The point is precisely that the
   orderings disagree, and a reader can only see a disagreement between two
   rankings if both rankings are actually drawn. */
function renderTssCharts() {
  const r = state.districtTss;
  if (!r || !r.districts?.length) return;

  const byTotal = r.districts.slice().sort((a, b) => b.tss - a.tss);
  const byCell = r.districts.slice().sort((a, b) => b.tss_per_cell - a.tss_per_cell);
  const cellRank = {};
  byCell.forEach((d, i) => (cellRank[normDistrict(d.district)] = i + 1));
  const totalRank = {};
  byTotal.forEach((d, i) => (totalRank[normDistrict(d.district)] = i + 1));

  const TOP = 10;
  if ($("viz-tss-total")) {
    vizBarH($("viz-tss-total"), {
      rows: byTotal.slice(0, TOP).map((d) => ({
        label: d.district,
        value: Math.round(d.tss),
        note: `${d.share_pct}%`,
        tipExtra: `${d.grid_cells.toLocaleString()} cells · ${fmt(d.tss_per_cell, 1)} per cell · #${
          cellRank[normDistrict(d.district)]
        } on intensity`,
      })),
      valueLabel: "Total TSS",
      noteWidth: 40,
      aria: "Districts ranked by total severity score",
    });
  }

  if ($("viz-tss-percell")) {
    vizBarH($("viz-tss-percell"), {
      rows: byCell.slice(0, TOP).map((d) => ({
        label: d.district,
        value: d.tss_per_cell,
        tipExtra: `${d.grid_cells.toLocaleString()} cells · ${Math.round(d.tss).toLocaleString()} total TSS · #${
          totalRank[normDistrict(d.district)]
        } on burden`,
      })),
      decimals: 1,
      valueLabel: "TSS per cell",
      aria: "Districts ranked by severity score per grid cell",
    });
  }

  const note = $("viz-tss-note");
  if (note) {
    const topSet = new Set(byTotal.slice(0, TOP).map((d) => normDistrict(d.district)));
    const movers = byCell
      .slice(0, TOP)
      .filter((d) => !topSet.has(normDistrict(d.district)))
      .map((d) => d.district);
    note.innerHTML = movers.length
      ? `<b>${movers.join(", ")}</b> ${movers.length === 1 ? "is" : "are"} top-10 on intensity but not on volume ` +
        `&mdash; a smaller share of the state's crashes concentrated into fewer cells. Ranking on the total alone would miss ${
          movers.length === 1 ? "it" : "them"
        }.`
      : `The two rankings agree in the top ${TOP}: the districts carrying the most severity are also the most intense per cell.`;
  }
}

/* ---------- Tab 2 · headline meters, level misses, districts ------------- */
function renderGapCharts() {
  const r = activeGapPayload();
  if (!r) return;

  // Two ratios, one scale each, stacked. Not a chart, and it should not be:
  // two numbers do not earn a plot.
  if ($("viz-gap-meter")) {
    const concentrated = r.severity_out_pct > r.out_pct;
    vizMeter($("viz-gap-meter"), [
      {
        label: "Grid cells out of reach",
        pct: r.out_pct,
        display: `${r.out_pct}%`,
        color: VIZ.status.critical,
        note: `${r.out_count.toLocaleString()} of ${r.total_grids.toLocaleString()} cells`,
      },
      {
        label: "State accident severity sitting in them",
        pct: r.severity_out_pct,
        display: `${r.severity_out_pct}%`,
        color: VIZ.status.serious,
        note: concentrated
          ? `Higher than the grid share, so the gaps sit disproportionately where crashes actually happen.`
          : `At or below the grid share, so the gaps fall on comparatively quiet cells.`,
      },
    ]);
  }

  // Exact combination of levels missed. One series, one colour — the label
  // says which combination, the bar says how many.
  if ($("viz-miss-bar")) {
    const combo = {};
    (r.out_reach || []).forEach((g) => {
      const missed = g.levels_missed || g.types_missed || [];
      const k = missed.map((x) => (state.gapSegment === "type" ? typeShort(x) : x)).join(" + ");
      if (!k) return;
      combo[k] = (combo[k] || 0) + 1;
    });
    const rows = Object.entries(combo)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({
        label: k,
        value: v,
        tipExtra: `${((100 * v) / (r.out_count || 1)).toFixed(1)}% of all out-of-reach grids`,
      }));
    vizBarH($("viz-miss-bar"), {
      rows,
      limit: 8,
      labelWidth: 104,
      labelChars: 17,
      valueLabel: "Grids",
      empty: "No grid is out of reach under the current rule.",
      aria: "Out-of-reach grids by which combination of levels they miss",
    });
  }

  // Gap count per district, with that district's share of state severity as a
  // direct label. Two measures, one axis — the second travels as text.
  if ($("viz-gap-districts")) {
    const share = tssShareMap();
    const rows = (r.by_district || [])
      .filter((d) => (d.out_reach || 0) > 0)
      .slice(0, 10)
      .map((d) => {
        const sh = share[normDistrict(d.district)];
        return {
          label: d.district,
          value: d.out_reach,
          note: sh === undefined ? "" : `${sh}% TSS`,
          tipExtra: sh === undefined ? "" : `Carries ${sh}% of the state's total severity`,
        };
      });
    vizBarH($("viz-gap-districts"), {
      rows,
      limit: 10,
      noteWidth: 52,
      valueLabel: "Out-of-reach grids",
      empty: "No district has an out-of-reach grid under the current rule.",
      aria: "Districts ranked by out-of-reach grid count",
    });
  }
}

/* ---------- Tab 2 · radius sensitivity ----------------------------------- */
async function loadSensitivity() {
  const host = $("viz-sens");
  if (!host) return;
  const district = $("gap-district")?.value || "";
  state.sensCache = state.sensCache || {};
  try {
    if (!state.sensCache[district]) {
      const q = new URLSearchParams({ year: state.meta.year, max_km: "80", step_km: "2" });
      if (district) q.set("district", district);
      state.sensCache[district] = await getJSON(`/api/analytics/level-sensitivity?${q}`);
    }
    renderSensitivity(state.sensCache[district]);
  } catch (err) {
    host.innerHTML = `<p class="panel-note error">${err.message}</p>`;
  }
}

function renderSensitivity(r) {
  const host = $("viz-sens");
  if (!host || !r?.series?.length) return;

  vizLines(host, {
    height: 196,
    series: r.series.map((s) => ({
      name: s.level,
      color: LEVEL_COLOR[s.level],
      points: s.points,
    })),
    xMin: 0,
    xMax: r.max_km,
    xTicks: [0, 20, 40, 60, 80],
    xLabel: "Radius, km by road",
    xUnit: "km",
    rules: r.series.map((s) => ({ x: s.spec_km, color: LEVEL_COLOR[s.level], label: "" })),
    aria: "Out-of-reach grid count against radius, one line per service level",
  });

  vizLegend(
    $("viz-sens-legend"),
    r.series.map((s) => ({ label: `${s.level} — spec ${s.spec_km} km`, color: LEVEL_COLOR[s.level] }))
  );

  // Which threshold is actually binding: measure the slope at the spec radius
  // rather than asserting it. Grids moved per extra kilometre, read off the
  // curve either side of the spec point.
  const slopes = r.series.map((s) => {
    const pts = s.points;
    let i = pts.findIndex((p) => p[0] >= s.spec_km);
    if (i < 1) i = 1;
    const lo = pts[Math.max(0, i - 1)];
    const hi = pts[Math.min(pts.length - 1, i + 1)];
    const dx = hi[0] - lo[0] || 1;
    return { level: s.level, spec: s.spec_km, gaps: s.spec_gaps, perKm: Math.abs((hi[1] - lo[1]) / dx) };
  });
  const binding = slopes.slice().sort((a, b) => b.perKm - a.perKm)[0];
  const flat = slopes.slice().sort((a, b) => a.perKm - b.perKm)[0];

  const note = $("viz-sens-note");
  if (note && binding) {
    note.innerHTML =
      `At the spec radii, <b>${binding.level}</b> is the binding constraint &mdash; around ` +
      `<b>${Math.round(binding.perKm)}</b> grids change verdict per extra kilometre at ${binding.spec} km, ` +
      `against ${flat.perKm < 1 ? "under 1" : Math.round(flat.perKm)} for ${flat.level} at ${flat.spec} km. ` +
      `Move ${binding.level}'s radius and the headline moves with it; move ${flat.level}'s and it barely does.` +
      (r.district ? ` Scoped to ${r.district}.` : "");
  }
}

/* ---------- Tab 3 · what covers the grids, worst-served, districts ------- */
function renderAmbCharts() {
  const r = state.ambGaps;
  if (!r) return;

  // Emergency vs not. Five vehicle types folded to three segments: past three
  // the fourth slot puts two adjacent hues on screen together, and the
  // distinction that matters here is emergency capability, not fleet trivia.
  if ($("viz-amb-mix")) {
    const by = r.covered_by_type || {};
    const als = by.ALS || 0;
    const bls = by.BLS || 0;
    const other = Object.entries(by)
      .filter(([k]) => k !== "ALS" && k !== "BLS")
      .reduce((a, [, v]) => a + v, 0);
    vizStack($("viz-amb-mix"), {
      segments: [
        { label: "ALS — advanced life support", value: als, color: VEHICLE_STYLE.ALS.color },
        { label: "BLS — basic life support", value: bls, color: VEHICLE_STYLE.BLS.color },
        { label: "Non-emergency (PTA / Kilkari / Neonate)", value: other, color: VIZ_GRAY },
      ],
      empty: "Nothing is counted as covered under the current filter.",
      aria: "Covered grids by the type of their nearest vehicle",
    });
    vizLegend($("viz-amb-mix-legend"), [
      { label: `ALS ${als.toLocaleString()}`, color: VEHICLE_STYLE.ALS.color },
      { label: `BLS ${bls.toLocaleString()}`, color: VEHICLE_STYLE.BLS.color },
      { label: `Non-emergency ${other.toLocaleString()}`, color: VIZ_GRAY },
    ]);
    const note = $("viz-amb-mix-note");
    if (note) {
      const tot = als + bls + other;
      note.innerHTML = r.emergency_only
        ? `Filtered to ALS + BLS, so every covered grid here is covered by an emergency vehicle by construction.`
        : tot
        ? `<b>${other.toLocaleString()}</b> of ${tot.toLocaleString()} covered grids (${(
            (100 * other) /
            tot
          ).toFixed(1)}%) have a non-emergency vehicle as their nearest &mdash; inside ${r.threshold_km} km, ` +
          `but not inside an emergency response. Switch the vehicle scope above to ALS + BLS to see what that ` +
          `does to the gap count.`
        : "";
    }
  }

  // Lollipop rather than bars: the extremes are the story and the bar mass in
  // between would just be ink. Cells with no vehicle at all are unreachable,
  // not merely distant, so they take the reserved critical token AND a label.
  if ($("viz-amb-worst")) {
    const finite = r.gaps.filter((g) => g.road_km !== null).map((g) => g.road_km);
    // Nudged past the worst measured distance so an unreachable cell does not
    // render as tied with the furthest cell that does have a vehicle.
    const cap = (finite.length ? Math.max(...finite) : r.threshold_km * 2) * 1.08;
    vizLollipop($("viz-amb-worst"), {
      rows: r.gaps.slice(0, 15).map((g) => ({
        label: `${g.grid_id}`,
        value: g.road_km === null ? cap : g.road_km,
        valueText: g.road_km === null ? "none" : fmt(g.road_km, 1),
        critical: g.road_km === null,
        tipExtra:
          `${g.district}` +
          (g.road_km === null
            ? `<br/>No qualifying vehicle within the cached radius`
            : `<br/>Nearest: ${g.nearest_vehicle_no || "—"} (${g.nearest_vehicle_type || "?"}) at ${g.nearest_stationed_at || "—"}` +
              (g.drive_min ? `<br/>${fmt(g.drive_min, 0)} min by road` : "")),
      })),
      limit: 15,
      valueLabel: "Road km",
      decimals: 1,
      rule: r.threshold_km,
      labelChars: 12,
      empty: "No grid is out of reach at this threshold.",
      aria: "Worst-served grids by road distance to the nearest ambulance",
    });
  }

  if ($("viz-amb-districts")) {
    const share = tssShareMap();
    vizBarH($("viz-amb-districts"), {
      rows: (r.by_district || []).slice(0, 10).map((d) => {
        const sh = share[normDistrict(d.district)];
        return {
          label: d.district,
          value: d.gaps,
          note: sh === undefined ? "" : `${sh}% TSS`,
          tipExtra: sh === undefined ? "" : `Carries ${sh}% of the state's total severity`,
        };
      }),
      limit: 10,
      noteWidth: 52,
      valueLabel: "Out-of-reach grids",
      empty: "No district has an out-of-reach grid at this threshold.",
      aria: "Districts ranked by ambulance coverage gaps",
    });
  }
}

/* ==========================================================================
   Two-pane feature popups
   ==========================================================================
   Every clickable feature on every tab opens the same shell:

       [ Details ]  [ Top 10 <something> ]

   Pane 1 is the record. Pane 2 is the ranked neighbour list, and WHAT it ranks
   depends on both what you clicked and which tab you are on — the same grid
   cell answers "which hospitals reach me" on Tabs 1 and 2 and "which vehicles
   reach me" on Tab 3, because those are the questions those tabs are asking.

   Pane 2 is lazy. Building it eagerly would fire a request for every marker
   the map draws; instead nothing happens until the tab is clicked, and the
   result is cached per (kind, id, tab) so reopening is instant.

   Leaflet rebuilds a popup's DOM from its HTML string on every open, so
   handlers cannot be attached at bind time — they would be attached to a node
   that is thrown away. One map-level `popupopen` listener rewires whatever
   just opened. That is also why the second tab's LABEL is set here rather than
   in the markup: the label depends on the tab in view at open time, not at
   bind time.
   ========================================================================== */

const FP_LIMIT = 10;

function fpNum(v, d = 1) {
  return v === null || v === undefined || v === "" ? "—" : fmt(v, d);
}

function fpKm(v) {
  return v === null || v === undefined ? "—" : `${fmt(v, 1)} km`;
}

/* A grid's identity differs by which renderer drew it — the proximity cache
   uses lat/lon, the ambulance cache uses latitude/longitude. Normalise once
   rather than teaching every caller both shapes. */
function fpLatLon(f) {
  return { lat: f.lat ?? f.latitude, lon: f.lon ?? f.longitude };
}

function fpTargetId(kind, f) {
  if (kind === "grid") return String(f.grid_id ?? "");
  return String(f.s_no ?? f.id ?? "");
}

function fpLevelChip(lv) {
  const up = (lv || "").toUpperCase();
  if (!visibleLevels().includes(up)) return `<span class="fp-chip fp-chip-none">n/a</span>`;
  return `<span class="fp-chip" style="--h:${LEVEL_COLOR[up]}">${up}</span>`;
}

function fpVehicleChip(t) {
  const up = (t || "").toUpperCase();
  const cfg = VEHICLE_STYLE[up] || VEHICLE_STYLE.OTHER;
  return `<span class="fp-chip" style="--h:${cfg.color}">${up || "?"}</span>`;
}

/* A verdict is a mark AND a word, never a colour on its own. */
const FP_TICK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5 9.5 18 20 6.5"/></svg>';
const FP_CROSS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

function fpVerdict(ok, okText, badText) {
  return ok
    ? `<span class="fp-ok">${FP_TICK}${okText}</span>`
    : `<span class="fp-bad">${FP_CROSS}${badText}</span>`;
}

function fpEmpty(msg) {
  return `<p class="fp-note">${msg}</p>`;
}

/* Grid ids of everything currently out of reach, so a hospital's grid list can
   flag which of its neighbours the Gaps tab is complaining about. Rebuilt only
   when the underlying payload object changes. */
function fpGapGridIds() {
  const r = activeGapPayload();
  if (!r) return null;
  if (state._fpGapSrc !== r) {
    state._fpGapSrc = r;
    state._fpGapIds = new Set((r.out_reach || []).map((g) => String(g.grid_id)));
  }
  return state._fpGapIds;
}

/* ==========================================================================
   The (what you clicked x which tab) -> ranked list matrix
   ========================================================================== */
function fpNearSpec(kind, tab) {
  if (kind === "grid" && (tab === "proximity" || tab === "gaps")) {
    return { key: `grid-hosp:${tab}`, label: "Top 10 hospitals", run: fpGridHospitals };
  }
  if (kind === "grid" && tab === "ambulance") {
    return { key: "grid-amb", label: "Top 10 ambulances", run: fpGridAmbulances };
  }
  if (kind === "hospital") {
    return { key: `hosp-grid:${tab}`, label: "Top 10 grids", run: fpHospitalGrids };
  }
  if (kind === "ambulance") {
    return { key: "amb-grid", label: "Top 10 grids", run: fpAmbulanceGrids };
  }
  if (kind === "bloodbank") {
    return { key: "bs-hosp", label: "Nearest hospitals", run: fpBloodbankHospitals };
  }
  return null;
}

/* ---------- grid -> hospitals (Tabs 1 and 2) ----------------------------- */
async function fpGridHospitals(id, f) {
  // live=0 forces the cached candidate list. The live OSRM path re-routes every
  // hospital within 60 km on demand, which is right for the full-list view and
  // far too slow for a popup someone opened by accident.
  const d = await getJSON(
    `/api/analytics/grid/${encodeURIComponent(id)}?year=${state.meta.year}&live=0`
  );
  const rows = (d.hospitals || []).slice().sort((a, b) => a.road_km - b.road_km);
  if (!rows.length) return fpEmpty("No hospital is cached within 60 km of this cell.");

  const radii = levelRadii();

  // "Categorically" first: the nearest facility OF EACH LEVEL, with its verdict
  // against that level's own radius. This is the part that answers the coverage
  // question — the ranked list below it is the evidence.
  // visibleLevels(), so the strip carries an EP cell when the toggle allows it —
  // has is part of the coverage answer, not a footnote to it.
  const perLevel = visibleLevels().map((lv) => {
    const best = rows.find((r) => (r.hosp_level || "").toUpperCase() === lv);
    return { lv, best };
  });

  const strip = perLevel
    .map(({ lv, best }) => {
      const km = best ? best.road_km : null;
      const ok = km !== null && km <= radii[lv];
      return `<div class="fp-lv-cell" style="--h:${LEVEL_COLOR[lv]}">
        <span class="fp-lv-k">${lv} &middot; ${radii[lv]} km</span>
        <span class="fp-lv-v">${fpKm(km)}</span>
        <span class="fp-lv-s">${
          km === null
            ? `<span class="fp-bad">${FP_CROSS}none cached</span>`
            : fpVerdict(ok, "in reach", "out of reach")
        }</span>
      </div>`;
    })
    .join("");

  const byType = {};
  rows.forEach((r) => {
    byType[r.hosp_type] = (byType[r.hosp_type] || 0) + 1;
  });

  const table = rows
    .slice(0, FP_LIMIT)
    .map(
      (r, i) => `<tr${fpRowAttrs(
        "hospital",
        r.latitude ?? r.lat,
        r.longitude ?? r.lon,
        r.hospital_name || `Hospital ${r.hospital_id}`,
        r.hospital_id
      )}>
        <td class="fp-rank">${i + 1}</td>
        <td><span class="fp-name">${r.hospital_name || "Unnamed"}</span>
          <span class="fp-sub"><code>${r.hospital_id}</code> &middot; ${r.hosp_type}</span></td>
        <td>${fpLevelChip(r.hosp_level)}</td>
        <td class="num">${fpKm(r.road_km)}</td>
      </tr>`
    )
    .join("");

  return `
    <p class="fp-note">Nearest of each service level, by road:</p>
    <div class="fp-lv-strip">${strip}</div>
    <p class="fp-note">Ten nearest facilities of any category:</p>
    <p class="fp-pick-hint">Click any row to pin it on the map.</p>
    <table class="mini-table fp-table">
      <thead><tr><th>#</th><th>Hospital &amp; ID</th><th>Lvl</th><th class="num">Road</th></tr></thead>
      <tbody>${table}</tbody>
    </table>
    <p class="fp-foot">${rows.length.toLocaleString()} cached within ${d.radius_km} km &mdash; ${Object.entries(
      byType
    )
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t} ${n}`)
      .join(", ")}.</p>`;
}

/* ---------- hospital -> grids (Tabs 1 and 2) ----------------------------- */
async function fpHospitalGrids(id, f) {
  // per_level must MIRROR the sidebar switch, not be hardcoded. With it pinned
  // to 1 while Proximity ran flat-60 km, the popup ranked a different set of
  // grids than the catchment drawn on the map underneath it.
  const perLevel = state.perLevel === false ? 0 : 1;
  const d = await getJSON(
    `/api/analytics/hospital/${encodeURIComponent(id)}/grids?limit=${FP_LIMIT}&per_level=${perLevel}` +
      `&include_ep=${state.includeEP ? 1 : 0}`
  );
  const rows = d.grids || [];
  if (!rows.length) return fpEmpty("This facility reaches no grid inside its level radius.");

  const gapIds = state.tab === "gaps" ? fpGapGridIds() : null;
  const table = rows
    .map(
      (g, i) => `<tr${fpRowAttrs(
        "grid",
        g.grid_latitude,
        g.grid_longitude,
        `Grid ${g.grid_id}`,
        g.grid_id
      )}>
        <td class="fp-rank">${i + 1}</td>
        <td><code>${g.grid_id}</code>
          <span class="fp-sub">${g.grid_district || "—"}</span></td>
        <td class="num">${fpKm(g.road_km_from_hospital)}</td>
        <td class="num">${fpNum(g.grid_severity_score, 1)}${
          gapIds && gapIds.has(String(g.grid_id))
            ? `<br/><span class="fp-bad fp-tiny">${FP_CROSS}gap</span>`
            : ""
        }</td>
      </tr>`
    )
    .join("");

  const tss = rows.reduce((a, g) => a + (g.grid_severity_score || 0), 0);
  const flagged = gapIds ? rows.filter((g) => gapIds.has(String(g.grid_id))).length : 0;

  const shown = rows.length;
  return `
    <p class="fp-note">Its ${shown} nearest accident grids, by road. Severity is
      the cell's own TSS.</p>
    <p class="fp-pick-hint">Click any row to pin it on the map.</p>
    <table class="mini-table fp-table">
      <thead><tr><th>#</th><th>Grid ID</th><th class="num">Road</th><th class="num">TSS</th></tr></thead>
      <tbody>${table}</tbody>
    </table>
    <p class="fp-foot">Reaches <b>${d.count.toLocaleString()}</b> grids in total;
      ${shown === d.count ? "they" : `these ${shown}`} carry <b>${fmt(tss, 1)}</b> TSS between them.${
    gapIds
      ? flagged
        ? ` <span class="fp-bad">${flagged}</span> of the ${shown} ${
            flagged === 1 ? "is" : "are"
          } still counted out of reach &mdash; this facility is near ${
            flagged === 1 ? "it" : "them"
          } but not of a level that satisfies the current rule.`
        : ` None of the ${shown} is out of reach under the current rule.`
      : ""
  }</p>`;
}

/* ---------- grid -> ambulances (Tab 3) ----------------------------------- */
async function fpGridAmbulances(id, f) {
  // Read the live control rather than a mirrored state key — the popup must
  // agree with whatever scope the gap count on screen was computed under.
  const emerg =
    (document.querySelector('input[name="amb-scope"]:checked')?.value || "all") === "emergency"
      ? 1
      : 0;
  const d = await getJSON(
    `/api/analytics/grid/${encodeURIComponent(id)}/ambulances?year=${state.meta.year}` +
      `&limit=${FP_LIMIT}&emergency_only=${emerg}`
  );
  const rows = d.ambulances || [];
  if (!rows.length) {
    return fpEmpty(
      `No ${emerg ? "ALS or BLS " : ""}vehicle is cached within reach of this cell — it is a gap at every threshold.`
    );
  }

  const th = Number($("amb-threshold")?.value) || 10;
  const table = rows
    .map(
      (a, i) => `<tr${fpRowAttrs(
        "ambulance",
        a.lat ?? a.latitude,
        a.lon ?? a.longitude,
        a.vehicle_no || "Vehicle"
      )}>
        <td class="fp-rank">${i + 1}</td>
        <td><span class="fp-name">${a.vehicle_no || "—"}</span>
          <span class="fp-sub">${a.stationed_at || "—"}</span></td>
        <td>${fpVehicleChip(a.vehicle_type)}</td>
        <td class="num">${fpKm(a.road_km)}<br/>
          <span class="fp-sub">${a.drive_min == null ? "—" : fmt(a.drive_min, 0) + " min"}</span></td>
      </tr>`
    )
    .join("");

  const nearest = rows[0];
  const emergencyFirst = rows.find((a) => ["ALS", "BLS"].includes((a.vehicle_type || "").toUpperCase()));

  return `
    <p class="fp-note">Its ten nearest vehicles, by road${
      emerg ? ", ALS and BLS only" : ""
    }.</p>
    <p class="fp-pick-hint">Click any row to pin it on the map.</p>
    <table class="mini-table fp-table">
      <thead><tr><th>#</th><th>Vehicle &amp; station</th><th>Type</th><th class="num">Road</th></tr></thead>
      <tbody>${table}</tbody>
    </table>
    <p class="fp-foot">Nearest is <b>${fpKm(nearest.road_km)}</b> away &mdash;
      ${fpVerdict(nearest.road_km < th, `inside ${th} km`, `at or past ${th} km, a gap`)}.
      ${
        emergencyFirst && emergencyFirst !== nearest
          ? `The nearest <b>emergency</b> vehicle is further out, at ${fpKm(
              emergencyFirst.road_km
            )} — the closest one is a ${(nearest.vehicle_type || "?").toUpperCase()}.`
          : ""
      }</p>`;
}

/* ---------- ambulance -> grids (Tab 3) ----------------------------------- */
async function fpAmbulanceGrids(id, f) {
  const d = await getJSON(
    `/api/analytics/ambulance/${encodeURIComponent(id)}/grids?year=${state.meta.year}&limit=${FP_LIMIT}`
  );
  const rows = d.grids || [];
  if (!rows.length) return fpEmpty("This vehicle is not the nearest of its type for any cached grid.");

  const table = rows
    .map(
      (g, i) => `<tr${fpRowAttrs(
        "grid",
        g.latitude,
        g.longitude,
        `Grid ${g.grid_id}`
      )}>
        <td class="fp-rank">${i + 1}</td>
        <td><code>${g.grid_id}</code>
          <span class="fp-sub">${g.district || "—"}</span></td>
        <td class="num">${fpKm(g.road_km)}<br/>
          <span class="fp-sub">${g.drive_min == null ? "—" : fmt(g.drive_min, 0) + " min"}</span></td>
        <td class="num">${fpNum(g.severity_score, 1)}</td>
      </tr>`
    )
    .join("");

  return `
    <p class="fp-note">The ten accident grids it sits closest to, by road.</p>
    <p class="fp-pick-hint">Click any row to pin it on the map.</p>
    <table class="mini-table fp-table">
      <thead><tr><th>#</th><th>Grid ID</th><th class="num">Road</th><th class="num">TSS</th></tr></thead>
      <tbody>${table}</tbody>
    </table>
    <p class="fp-foot">It is among the nearest vehicles of its type for
      <b>${d.count.toLocaleString()}</b> grids, carrying
      <b>${fmt(d.severity_total, 1)}</b> TSS in total.</p>`;
}

/* ---------- blood storage -> hospitals (Tab 1) ---------------------------
   Straight-line, and it says so. Blood storage is not in the road-distance
   precompute, so routing it would mean a live OSRM call per popup. For "which
   facilities does this centre sit near" a crow-flies ranking is honest as long
   as it is never labelled as road distance. */
async function fpBloodbankHospitals(id, f) {
  await ensureHospitals();
  const { lat, lon } = fpLatLon(f);
  if (lat == null || lon == null) return fpEmpty("This centre has no usable coordinates.");

  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const rows = (state.hospitals || [])
    .map((h) => {
      const dLat = rad(h.lat - lat);
      const dLon = rad(h.lon - lon);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(lat)) * Math.cos(rad(h.lat)) * Math.sin(dLon / 2) ** 2;
      return { h, km: 2 * R * Math.asin(Math.sqrt(a)) };
    })
    .sort((a, b) => a.km - b.km)
    .slice(0, FP_LIMIT);

  if (!rows.length) return fpEmpty("No hospitals loaded yet — turn on the hospital layer.");

  const table = rows
    .map(
      ({ h, km }, i) => `<tr${fpRowAttrs("hospital", h.lat, h.lon, h.name || "Hospital")}>
        <td class="fp-rank">${i + 1}</td>
        <td><span class="fp-name">${h.name || "Unnamed"}</span>
          <span class="fp-sub"><code>${h.s_no}</code> &middot; ${h.hosp_type}</span></td>
        <td>${fpLevelChip(h.hosp_level)}</td>
        <td class="num">${fpKm(km)}</td>
      </tr>`
    )
    .join("");

  return `
    <p class="fp-note">Ten nearest facilities, <b>straight-line</b> &mdash; blood
      storage is not in the road-distance precompute, so these are crow-flies
      distances and will read short against a real drive.</p>
    <table class="mini-table fp-table">
      <thead><tr><th>#</th><th>Hospital &amp; ID</th><th>Lvl</th><th class="num">Direct</th></tr></thead>
      <tbody>${table}</tbody>
    </table>`;
}

/* ==========================================================================
   Clicking a row inside a popup -> show that feature on the map
   ==========================================================================
   A ranked list that names ten hospitals and cannot point at any of them makes
   the reader do the join by eye across a field of thousands of cells. Clicking
   a row now pins its subject on the map and draws a leader line back to the
   feature whose popup you are reading, so "6.4 km to CHC Beri" becomes a thing
   you can see rather than a number you have to trust.

   The pin lives in its own pane above the outline and below the popups, with an
   SVG renderer forced: the map runs preferCanvas, and a canvas-rendered
   circleMarker silently drops the `className`, which is what the pulse
   animation is attached to. */
const layerPickPane = map.createPane("pickPane");
layerPickPane.style.zIndex = "480";
layerPickPane.style.pointerEvents = "none";
const pickRenderer = L.svg({ pane: "pickPane" });
layers.pick = L.layerGroup().addTo(map);

const FP_PICK_HUE = { hospital: "#1d4ed8", grid: "#0f766e", ambulance: "#b91c1c" };

/* Attributes that turn a <tr> into something clickable. Kept in one helper so
   the five renderers cannot drift on attribute names — a row that spells one of
   these differently just silently stops responding. */
function fpRowAttrs(kind, lat, lon, label, id) {
  if (lat == null || lon == null) return "";
  return (
    ` class="fp-row" data-pick-kind="${kind}" data-pick-lat="${lat}" data-pick-lon="${lon}"` +
    (id != null ? ` data-pick-id="${String(id).replace(/"/g, "&quot;")}"` : "") +
    ` data-pick-label="${String(label ?? "").replace(/"/g, "&quot;")}" tabindex="0"` +
    ` title="Show on the map"`
  );
}

function fpClearPick() {
  layers.pick.clearLayers();
  state.pickedRow = null;
}

/* `from` is the feature whose popup is open — the leader line's other end. */
function fpShowOnMap(kind, lat, lon, label, from) {
  layers.pick.clearLayers();
  const hue = FP_PICK_HUE[kind] || "#1d4ed8";

  if (from && from.lat != null && from.lon != null) {
    layers.pick.addLayer(
      L.polyline(
        [
          [from.lat, from.lon],
          [lat, lon],
        ],
        {
          pane: "pickPane",
          renderer: pickRenderer,
          interactive: false,
          color: hue,
          weight: 2,
          opacity: 0.85,
          dashArray: "7 6",
        }
      )
    );
  }

  layers.pick.addLayer(
    L.circleMarker([lat, lon], {
      pane: "pickPane",
      renderer: pickRenderer,
      interactive: false,
      radius: 13,
      color: hue,
      weight: 3,
      fillColor: hue,
      fillOpacity: 0.14,
      className: "fp-pick-pulse",
    })
  );
  layers.pick.addLayer(
    L.circleMarker([lat, lon], {
      pane: "pickPane",
      renderer: pickRenderer,
      interactive: false,
      radius: 4,
      color: hue,
      weight: 2,
      fillColor: "#fff",
      fillOpacity: 1,
    }).bindTooltip(label || "Selected", {
      permanent: true,
      direction: "top",
      offset: [0, -12],
      className: "measure-point-label",
    })
  );

  /* Only move the map when the target is actually off screen. Recentring on
     every click would yank the view out from under someone comparing rows, and
     it drags the open popup across the screen with it. */
  const pt = L.latLng(lat, lon);
  if (!map.getBounds().pad(-0.12).contains(pt)) {
    map.panTo(pt, { animate: true, duration: 0.6 });
  }
}

/* ==========================================================================
   Live partner feeds — active only while the grid palette is "New"
   ==========================================================================
   New mode is "their colours AND their data". Old mode is ours and stays fully
   offline, so the app still works with no network at all.

   Every live call goes through our own Flask proxy (/api/rbg/*), never straight
   to rbg.iitm.ac.in. The browser cannot POST cross-origin to their host — they
   send no CORS header for our origin — so a direct fetch would fail with an
   opaque CORS error that looks like our bug. The proxy also memoises the 4 MB
   grid payload and enforces a timeout.

   EVERY CALLER FALLS BACK. A dead endpoint must degrade to the offline answer,
   not to a spinner, and the sidebar must say which one you are looking at —
   once two data sources exist, "is this live?" is the only question that
   matters when a number looks surprising. */

/* Only the feeds this app ACTUALLY calls. The panel previously listed all five
   endpoints, including three that nothing ever requested — so those three sat
   on "not requested yet" forever and the whole panel read as broken. A status
   panel that lists work it never does is worse than no panel: it makes the two
   real rows look like they failed too. */
const LIVE_FEEDS = ["grid_data", "hosp_gps", "get_layer", "acc_grid_data"];

// Proxied and reachable, but no view consumes them yet. Listed separately so
// the gap is explicit rather than silently missing.
const PLANNED_FEEDS = ["acc_loc_data"];

// feed -> {state: "live"|"cache"|"fallback"|"idle", reason, ms}
const liveStatus = {};

function liveOn() {
  return gridPalette() === "new";
}

function setLiveStatus(feed, s, reason, ms) {
  liveStatus[feed] = { state: s, reason: reason || null, ms: ms ?? null };
  renderLiveStatus();
}

async function rbgCall(name, body) {
  const res = await fetch(apiUrl(`/api/rbg/${encodeURIComponent(name)}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
  const env = await res.json();
  if (!env.ok) throw new Error(env.reason || `${name} unavailable`);
  setLiveStatus(name, env.source, null, env.elapsed_ms);
  return env.data;
}

/* ---------- grid_data: the four stat cards, for real ---------------------
   This is the endpoint that removes the NA. Their response carries
   total_crashes / total_dead / total_injured / vehicle_count and their own
   categories[]; ours carries a real crash count and three nulls because our
   feed has no casualty or vehicle data. Same shape either way, so the panes
   render both without branching. */
/* NOT fpNum() — that name is already taken by the formatter above, which
   returns a display string. This returns a real number or null, for values
   that still have arithmetic ahead of them. */
function fpToNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* Thrown when the partner answers successfully but says it holds nothing for
   this cell. Not an error in the transport sense — which is exactly why it
   needed its own signal. Treated as a live answer it produced four NA cards
   and "No accidents recorded in this cell." on cells where THIS APP has the
   crash, the severity class and the reporting station. That is not a missing
   number, it is a wrong statement about the world. */
class RbgEmpty extends Error {}

async function fpGridStatsLive(id) {
  const raw = await rbgCall("grid_data", { grid_id: id, year: state.meta?.year || "2025" });
  // The proxy flags their {"status_code":"101","message":"No data available"}
  // envelope as empty:true rather than making every caller sniff for it.
  if (raw?.empty) throw new RbgEmpty("No detailed record exists for this cell.");
  const d = raw?.details ?? raw ?? {};
  return {
    grid_id: id,
    /* Their API sends every count as a STRING except total_dead. Left raw,
       fmt() prints them fine but any arithmetic (shares, totals) concatenates. */
    total_crashes: fpToNum(d.total_crashes),
    total_dead: fpToNum(d.total_dead),
    total_injured: fpToNum(d.total_injured),
    vehicle_count: fpToNum(d.vehicle_count),
    severity_score: fpToNum(d.severity_score),
    fatal_crashes: fpToNum(d.fatal_crashes),
    greivous_crashes: fpToNum(d.greivous_crashes),
    minor_injured_crashes: fpToNum(d.minor_injured_crashes),
    no_injured_crashes: fpToNum(d.no_injured_crashes),
    categories: d.categories || [],
    __source: "live",
  };
}

/* ---------- hosp_gps: the three preparedness scores ----------------------
   Keyed by hospid. Our own hospital rows use s_no, and the two ID spaces are
   not guaranteed to agree — so the merge is by ID *and* falls back to a
   coordinate match within ~150 m before giving up. A silently unmatched
   hospital would just look like a facility with no preparedness data, which is
   indistinguishable from one the API genuinely lacks. */
let hospGpsPromise = null;

function ensureHospGps(districtName) {
  const key = districtName || "__all__";
  if (!hospGpsPromise || hospGpsPromise.key !== key) {
    const p = rbgCall("hosp_gps", { district_name: districtName || "" })
      .then((raw) => {
        const details = raw?.details ?? {};
        const rows = Array.isArray(details) ? details : Object.values(details || {});
        const byId = new Map();
        const byPos = [];
        rows.forEach((h) => {
          if (h?.hospid != null) byId.set(String(h.hospid), h);
          const lat = Number(h?.latitude);
          const lon = Number(h?.longitude);
          if (Number.isFinite(lat) && Number.isFinite(lon)) byPos.push({ lat, lon, h });
        });
        return { byId, byPos, count: rows.length };
      })
      .catch((err) => {
        setLiveStatus("hosp_gps", "fallback", err.message);
        hospGpsPromise = null;
        return null;
      });
    p.key = key;
    hospGpsPromise = p;
  }
  return hospGpsPromise;
}

/* How far apart the two datasets may place the SAME facility before an ID
   match stops being believable. Generous — the two feeds disagree by a few
   hundred metres on plenty of real hospitals — but nowhere near enough to let
   two different towns pass. */
const HOSP_ID_CORROBORATE_KM = 3;

function hospKmApart(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function hospGpsMatch(idx, f) {
  if (!idx) return null;
  const lat = Number(f.lat ?? f.latitude);
  const lon = Number(f.lon ?? f.longitude);
  const hasPos = Number.isFinite(lat) && Number.isFinite(lon);

  /* AN ID MATCH IS NOT PROOF. Our rows are keyed by s_no and theirs by hospid,
     and those two ID spaces are unrelated — the docstring above says as much,
     but the code then trusted a bare ID hit anyway. Our s_no 1 is AL AFIA
     HOSPITAL MANDIKHERA; their hospid 1 is CHC SHAHZADPUR, ~90 km away. The
     popup put our header on their record and presented the pair as one
     facility, which is worse than showing nothing.

     So an ID hit now has to be corroborated by position. When the coordinates
     disagree the ID is treated as a coincidence and the positional search below
     runs instead, which is the only one of the two that can actually identify a
     facility. */
  const byId = idx.byId.get(String(f.s_no ?? f.id ?? ""));
  if (byId) {
    const a = Number(byId.latitude);
    const b = Number(byId.longitude);
    if (!hasPos || !Number.isFinite(a) || !Number.isFinite(b)) {
      // Nothing to check against. Returning it keeps the old behaviour rather
      // than silently dropping a match we have no evidence against.
      return byId;
    }
    if (hospKmApart(lat, lon, a, b) <= HOSP_ID_CORROBORATE_KM) return byId;
    // Falls through — deliberately not returning byId.
  }

  if (!hasPos) return null;
  // ~150 m. Tight enough that two distinct facilities cannot collide, loose
  // enough to survive rounding differences between the two datasets.
  const TOL = 0.0015;
  let best = null;
  let bestD = Infinity;
  idx.byPos.forEach(({ lat: a, lon: b, h }) => {
    const d = Math.abs(a - lat) + Math.abs(b - lon);
    if (d < TOL && d < bestD) {
      bestD = d;
      best = h;
    }
  });
  return best;
}

/* ---------- the sidebar's data-source panel ------------------------------ */
const LIVE_LABEL = {
  grid_data: "Grid statistics",
  hosp_gps: "Hospital preparedness",
  acc_grid_data: "Severity grid",
  get_layer: "District boundary",
  acc_loc_data: "Accident points",
};

function renderLiveStatus() {
  const host = $("live-status");
  /* The "Live data & grid colours" panel was removed from the sidebar on
     24 Aug 2026. Its per-feed rows went with it — they narrated requests the
     user had not made — but "partner unreachable" is a real operational fact,
     and a silent fallback to offline data is exactly the failure this app
     should never hide. With no panel to render into, it goes to the shared
     status line instead. */
  if (!host) {
    if (partnerReachable === false) {
      setStatus(
        "Showing this app's own data — nothing is waiting on the network.",
        false
      );
    }
    return;
  }
  /* Unreachable is a whole-panel state, not five identical rows. Old mode used
     to be the answer here — you flipped it and everything was instant. It is
     retired, so this has to say plainly that the app is running on its own data
     and offer the way back, or the next person assumes it is broken. */
  if (partnerReachable === false) {
    host.innerHTML =
      `<p class="panel-note warn"><b>Running on local data.</b> The map, the
        popups and the sidebar all work, and nothing is waiting on the network.
        <button type="button" class="live-retry" onclick="retryPartner()">Retry
        connection</button></p>`;
    return;
  }

  const rows = LIVE_FEEDS.map((f) => {
    const s = liveStatus[f] || { state: "idle" };
    const cls =
      s.state === "live" || s.state === "cache" ? "ok" : s.state === "fallback" ? "bad" : "idle";
    /* "loads when you open a popup", not "not requested yet". These two fire on
       clicking a cell or a hospital, so idle is the correct resting state and
       should not read as a failure. */
    const word =
      s.state === "live" ? `live${s.ms != null ? ` &middot; ${s.ms} ms` : ""}`
      : s.state === "cache" ? "live (cached)"
      : s.state === "fallback" ? "offline copy"
      : "loads when you open a popup";
    return `<div class="live-row ${cls}">
      <span class="live-dot"></span>
      <span class="live-name">${LIVE_LABEL[f] || f}</span>
      <span class="live-state">${word}</span>
      ${s.reason ? `<span class="live-why">${s.reason}</span>` : ""}
    </div>`;
  }).join("");

  const planned = PLANNED_FEEDS.map(
    (f) => `<div class="live-row planned">
      <span class="live-dot"></span>
      <span class="live-name">${LIVE_LABEL[f] || f}</span>
      <span class="live-state">not wired yet</span>
    </div>`
  ).join("");

  host.innerHTML =
    rows +
    planned +
    `<p class="panel-note"><b>offline copy</b> means that feed failed and this
      app's cached data was used instead. <b>not wired yet</b> means the endpoint
      is reachable, but no view consumes it yet &mdash; those layers still come
      from this app's own data.</p>`;
}

/* ==========================================================================
   Statistics / Charts panes — the partner app's grid_data, in our popup
   ==========================================================================
   Same four stat cards and the same "one card per category" body as their
   file, fed by /api/analytics/grid/<id>/stats.

   THREE OF THE FOUR CARDS READ "NA", AND THAT IS DELIBERATE. Their tiles are
   Total Accidents / Deaths / Injured / Vehicles. Our accident feed records a
   severity CLASS per crash — Fatal, Grievous, Minor — not casualty counts, and
   carries no vehicle data at all. So `total_crashes` is real and the other
   three come back null. Their own client renders `|| "NA"`, so keeping their
   labels and showing NA matches their format exactly without inventing a
   number. Do not "fix" this by counting Fatal crashes as deaths: one fatal
   crash is not one death. */

const FP_STAT_CARDS = [
  ["total_crashes", "Total Accidents"],
  ["total_dead", "Total Deaths"],
  ["total_injured", "Total Injured"],
  ["vehicle_count", "Total Vehicles"],
];

// Both panes come from ONE request, cached per grid, so switching between
// Statistics and Charts never refetches.
function fpStatsKey(id) {
  return `grid-stats|${id}`;
}

async function fpGridStats(id) {
  // Cache per (id, mode): the live and offline answers are different numbers
  // for the same cell, so one key for both would serve whichever was fetched
  // first and make the toggle look broken.
  const key = `${fpStatsKey(id)}|${gridPalette()}`;
  state.fpStatsCache = state.fpStatsCache || {};

  if (!state.fpStatsCache[key]) {
    const local = () =>
      getJSON(`/api/analytics/grid/${encodeURIComponent(id)}/stats?year=all`).then((d) => ({
        ...d,
        __source: "offline",
      }));

    state.fpStatsCache[key] = (liveOn()
      ? fpGridStatsLive(id).catch((err) => {
          // Degrade to our own answer rather than to an error pane. The banner
          // in the pane says which one you ended up with.
          //
          // An EMPTY partner answer degrades the same way, but is a different
          // fact and is labelled differently: the feed worked, it simply has no
          // record for this cell, and ours does. Reporting their silence as
          // "no accidents recorded" was asserting something false.
          const empty = err instanceof RbgEmpty;
          if (!empty) setLiveStatus("grid_data", "fallback", err.message);
          return local().then((d) => ({ ...d, __source: empty ? "offline_partner_empty" : "offline" }));
        })
      : local()
    ).catch((err) => {
      // Never cache a failure — reopening should retry.
      delete state.fpStatsCache[key];
      throw err;
    });
  }
  return state.fpStatsCache[key];
}

function fpStatCards(d) {
  return `<div class="fp-stat-row">${FP_STAT_CARDS.map(([k, label]) => {
    const v = d[k];
    const na = v === null || v === undefined;
    return `<div class="fp-stat${na ? " na" : ""}">
      <b>${na ? "NA" : Number(v).toLocaleString()}</b>
      <span>${label}</span>
    </div>`;
  }).join("")}</div>`;
}

// The one honest sentence that stops "NA" reading as a bug.
const FP_STAT_NOTE =
  `<p class="fp-note fp-stat-note">Deaths, injured and vehicle counts read
   <b>NA</b> because our accident feed records a severity class per crash, not
   casualty or vehicle counts. The severity breakdown below is the same
   information at the level the data actually supports.</p>`;

/* Their live `categories[].data` is an ARRAY of {count, type}; our offline one
   is a plain {label: value} map. Object.entries() on the array yields "0","1",…
   against [object Object], so both shapes go through one normaliser. Values
   also arrive as strings from their API ("39"), hence the Number() coercion. */
function fpCatRows(cat) {
  const d = cat && cat.data;
  if (!d) return [];
  const raw = Array.isArray(d)
    ? d.map((r) => [r.type ?? r.label ?? r.name ?? "—", r.count ?? r.value ?? 0])
    : Object.entries(d);
  return raw
    .map(([label, value]) => [String(label), Number(value) || 0])
    .filter(([, v]) => Number.isFinite(v))
    .sort((a, b) => b[1] - a[1]);
}

function fpCategoryTable(cat) {
  const rows = fpCatRows(cat);
  if (!rows.length) return "";
  const total = rows.reduce((a, [, v]) => a + v, 0);
  return `<div class="fp-cat">
    <p class="fp-cat-title">${cat.title}</p>
    <table class="mini-table fp-table">
      <thead><tr><th>Category</th><th class="num">Count</th><th class="num">Share</th></tr></thead>
      <tbody>${rows
        .map(
          ([k, v]) => `<tr>
            <td>${k}</td>
            <td class="num">${v.toLocaleString()}</td>
            <td class="num">${total ? ((v / total) * 100).toFixed(1) : "0.0"}%</td>
          </tr>`
        )
        .join("")}</tbody>
    </table>
  </div>`;
}

/* Charts reuse the sidebar's bar renderer rather than a second charting path,
   so a bar in a popup and a bar in the sidebar are the same object. */
function fpCategoryChart(cat, idx, id) {
  const rows = fpCatRows(cat);
  if (!rows.length) return "";
  const hostId = `fp-chart-${id}-${idx}`;
  return `<div class="fp-cat">
    <p class="fp-cat-title">${cat.title}</p>
    <div class="viz-host" id="${hostId}"></div>
  </div>`;
}

async function fpLoadStats(root, popup, which) {
  const pane = root.querySelector(`[data-pane="${which}"]`);
  if (!pane || pane.dataset.loaded === "1" || pane.dataset.loading === "1") return;
  const id = root.dataset.fpId;

  pane.dataset.loading = "1";
  pane.innerHTML = '<div class="fp-loading"><span class="fp-spin"></span> Loading…</div>';
  fpResize(popup);

  try {
    const d = await fpGridStats(id);
    const cats = d.categories || [];

    if (which === "stats") {
      /* The NA note belongs to the OFFLINE answer only. When the live feed
         supplies real deaths / injured / vehicles there is nothing to excuse,
         and leaving the note up would tell the reader their numbers are
         missing while they are looking straight at them. */
      const live = d.__source === "live";
      /* Three states, not two. In OLD mode the offline answer is the expected
         one and only needs the NA explanation. In NEW mode the offline answer
         means their feed failed — and since New is meant to show their data and
         nothing else, that substitution has to be stated, not slipped in. */
      const banner = live
        ? ""
        : d.__source === "offline_partner_empty" || liveOn()
        ? `<p class="fp-note fp-warn">No detailed record exists for this cell, so
             the figures below are the <b>summary figures for the same grid</b>.
             Deaths, injured and vehicle counts read NA because the accident data
             records a severity class per crash, not casualty or vehicle
             counts.</p>`
        : FP_STAT_NOTE;
      pane.innerHTML =
        fpStatCards(d) +
        banner +
        (cats.length
          ? cats.map(fpCategoryTable).join("")
          : fpEmpty("No accidents recorded in this cell."));
    } else {
      pane.innerHTML = cats.length
        ? cats.map((c, i) => fpCategoryChart(c, i, id)).join("")
        : fpEmpty("No accidents recorded in this cell.");
      // Charts must be drawn AFTER their hosts are in the DOM.
      cats.forEach((c, i) => {
        const host = pane.querySelector(`#fp-chart-${CSS.escape(id)}-${i}`);
        if (!host || typeof vizBarH !== "function") return;
        // vizBarH(host, {rows:[{label,value}]}) — the same renderer the sidebar
        // uses. It builds a fixed 306-wide viewBox at width:100%, so it scales
        // cleanly into the wider grid popup and needs no redraw on tab switch.
        vizBarH(host, {
          rows: fpCatRows(c).map(([label, value]) => ({ label, value })),
          labelWidth: 132,
          title: c.title,
        });
      });
    }
    pane.dataset.loaded = "1";
  } catch (err) {
    pane.innerHTML = `<p class="fp-note error">Could not load statistics: ${err.message}</p>`;
  } finally {
    pane.dataset.loading = "0";
    fpResize(popup);
  }
}

/* ==========================================================================
   Keep popups clear of the panels that float over the map
   ==========================================================================
   `.sidebar-panel` is position:absolute at z-index 500 on top of a FULL-WIDTH
   `#map`, and so is the legend. Leaflet's autoPan only knows the map's own
   rectangle, so it happily pans a popup into the left 386px that the sidebar
   covers — the popup opens "on screen" by Leaflet's reckoning and is invisible
   to the reader. That is what "the popup didn't move properly" is.

   Leaflet already supports the fix: autoPanPaddingTopLeft / BottomRight. It
   just has to be told the real numbers, and told again whenever the layout
   changes. Set on L.Popup.prototype so the FIRST pan is already correct —
   correcting it afterwards in `popupopen` would work but produces a visible
   double-pan on every open. */

function fpEdgePadding() {
  const mapEl = document.getElementById("map");
  if (!mapEl) return null;
  const m = mapEl.getBoundingClientRect();
  if (!m.width || !m.height) return null;

  const GAP = 16;
  const pad = { left: 20, top: 20, right: 20, bottom: 20 };

  const consider = (el) => {
    if (!el) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;

    /* Attribute the panel to whichever map edge it hugs, then pad that edge by
       how far it intrudes. This handles the responsive layout for free: the
       sidebar is left-anchored on desktop and bottom-anchored on narrow
       screens, and the same measurement pads the correct side either way. */
    const fromLeft = r.right - m.left;
    const fromRight = m.right - r.left;
    const fromTop = r.bottom - m.top;
    const fromBottom = m.bottom - r.top;
    const nearest = Math.min(fromLeft, fromRight, fromTop, fromBottom);

    if (nearest === fromLeft) pad.left = Math.max(pad.left, fromLeft + GAP);
    else if (nearest === fromRight) pad.right = Math.max(pad.right, fromRight + GAP);
    else if (nearest === fromTop) pad.top = Math.max(pad.top, fromTop + GAP);
    else pad.bottom = Math.max(pad.bottom, fromBottom + GAP);
  };

  consider(document.querySelector(".sidebar-panel"));
  consider(document.getElementById("map-legend"));
  const banner = document.getElementById("offline-banner");
  if (banner && !banner.classList.contains("hidden")) consider(banner);
  /* The Proximity detail panel is the same kind of obstacle as the sidebar —
     an opaque slab floating over the map — but it comes and goes, so it has to
     be measured at the moment a popup opens rather than once at load.
     `consider` already skips display:none, so passing it unconditionally is
     safe; showProxPanel/hideProxPanel call fpSyncAutoPan() to re-measure. */
  consider(document.getElementById("prox-panel"));

  /* Never ask for more padding than the map can give. Over-constrained padding
     makes Leaflet pan to a position that satisfies nothing, which looks worse
     than not panning at all. Leave at least a fifth of each axis free. */
  const maxX = m.width * 0.8;
  const maxY = m.height * 0.8;
  if (pad.left + pad.right > maxX) {
    const k = maxX / (pad.left + pad.right);
    pad.left = Math.floor(pad.left * k);
    pad.right = Math.floor(pad.right * k);
  }
  if (pad.top + pad.bottom > maxY) {
    const k = maxY / (pad.top + pad.bottom);
    pad.top = Math.floor(pad.top * k);
    pad.bottom = Math.floor(pad.bottom * k);
  }
  return pad;
}

function fpSyncAutoPan() {
  const pad = fpEdgePadding();
  if (!pad || !window.L || !L.Popup) return;
  // Prototype-level so it applies to every popup, including the ones bound
  // before this ran. Leaflet reads autoPanPaddingTopLeft in preference to
  // autoPanPadding, so setting these wins.
  L.Popup.prototype.options.autoPanPaddingTopLeft = L.point(pad.left, pad.top);
  L.Popup.prototype.options.autoPanPaddingBottomRight = L.point(pad.right, pad.bottom);
}

fpSyncAutoPan();
map.on("resize", fpSyncAutoPan);
window.addEventListener("resize", fpSyncAutoPan);

/* ==========================================================================
   Shell + wiring
   ========================================================================== */
const FP_TAB_ICON = {
  details:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.1"/></svg>',
  near:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 6h10M4 12h13M4 18h7"/><path d="M18 15.5 20.5 18 18 20.5"/></svg>',
  stats:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 19.5V4M4 19.5h16"/><rect x="7" y="11" width="3.2" height="5.5" rx=".8"/>' +
    '<rect x="13.3" y="7" width="3.2" height="9.5" rx=".8"/></svg>',
  charts:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 19.5V4M4 19.5h16"/><path d="m6.5 15 3.6-4.2 3 2.4 4.6-6"/></svg>',
};

/* Statistics and Charts are GRID-ONLY, exactly as in the partner app: their
   file puts those two tabs on the grid popup and nowhere else. A hospital has
   no accident record of its own to count, so offering the tab there would open
   onto nothing. */
function fpHasStats(kind) {
  return kind === "grid";
}

function fpShell(kind, f, headHtml, detailsHtml) {
  const id = fpTargetId(kind, f);
  // The payload rides on the node so the open handler does not have to find
  // the feature again through whichever layer happened to draw it.
  const payload = encodeURIComponent(JSON.stringify(fpLatLon(f)));
  // --k is the feature-kind hue, declared once on the root so the head band,
  // tab rail, table header, rank badges and row hover can all tint from it.
  // Colour therefore says "you are looking at a hospital" across the whole
  // sheet, instead of only inside a 26px icon tile.
  const kindHue = FP_KIND_HUE[kind] || "#0f766e";

  /* WHAT THE POPUP CONTAINS DEPENDS ON THE MODE.

     OLD is ours: Details (our record) + Nearby (our ranked proximity list),
     plus Statistics / Charts on grids.

     NEW is THEIRS, and only theirs. Their file's grid popup has exactly two
     tabs — Statistics and Charts — both fed by grid_data, and their hospital
     popup is a single table of the ten fields get_hosp_gps returns. Our
     Details pane restates what the sidebar already shows and our Nearby pane
     is our own proximity analysis; neither exists in their app, so neither
     belongs in New mode. Showing them would make New a mixture rather than a
     faithful comparison.

     Proximity is exempt. It was never part of this New/Old comparison to
     begin with -- gridColor() already carves it out of the New/Old PALETTE
     for the same reason (see its own `state.tab === "proximity"` early
     return) -- its grid/hospital popups just never used to run through this
     function at all, so the exemption never had to be written here. Now
     that they do (31 Aug 2026 merge, for the Routes/Catchment tabs), it has
     to be explicit, or a permanently-on New mode (OLD_MODE_RETIRED) would
     swallow Proximity's own analysis exactly like it swallows Gaps/
     Ambulance, which is the wrong behaviour for a tab that was always ours
     alone. */
  const partner = liveOn() && state.tab !== "proximity";
  const gridPartner = partner && kind === "grid";
  const hospPartner = partner && kind === "hospital";

  // Proximity's Overall/Grid/Hospital merge (31 Aug 2026): a hospital's
  // catchment is always computed at ITS OWN level, never whatever the
  // sidebar's colouring picker happens to be set to -- carried on the root
  // so fpLoadCatchment doesn't have to go looking for the record again.
  const fpHospLevel = kind === "hospital" ? (f.counts_at_level || "").toUpperCase() : "";

  const tabs = [];
  const panes = [];

  if (gridPartner) {
    // Their two tabs, in their order. Statistics opens first, as theirs does.
    tabs.push(`<button type="button" class="fp-tab active" data-fp-pane="stats" role="tab" aria-label="Statistics" title="Statistics">${FP_TAB_ICON.stats}<span>Statistics</span></button>`);
    tabs.push(`<button type="button" class="fp-tab" data-fp-pane="charts" role="tab" aria-label="Charts" title="Charts">${FP_TAB_ICON.charts}<span>Charts</span></button>`);
    panes.push(`<div class="fp-pane" data-pane="stats"></div>`);
    panes.push(`<div class="fp-pane hidden" data-pane="charts"></div>`);
  } else if (hospPartner) {
    // No tab bar at all: their hospital popup is one table, nothing to switch
    // between. A single-tab tab bar is furniture.
    panes.push(`<div class="fp-pane" data-pane="details"><div class="fp-loading"><span class="fp-spin"></span> Loading…</div></div>`);
  } else {
    tabs.push(`<button type="button" class="fp-tab active" data-fp-pane="details" role="tab" aria-label="Details" title="Details">${FP_TAB_ICON.details}<span>Details</span></button>`);
    tabs.push(`<button type="button" class="fp-tab" data-fp-pane="near" role="tab" aria-label="Nearby" title="Nearby">${FP_TAB_ICON.near}<span>Nearby</span></button>`);
    panes.push(`<div class="fp-pane" data-pane="details">${detailsHtml}</div>`);
    panes.push(`<div class="fp-pane hidden" data-pane="near"></div>`);
    if (fpHasStats(kind)) {
      tabs.push(`<button type="button" class="fp-tab" data-fp-pane="stats" role="tab" aria-label="Statistics" title="Statistics">${FP_TAB_ICON.stats}<span>Statistics</span></button>`);
      tabs.push(`<button type="button" class="fp-tab" data-fp-pane="charts" role="tab" aria-label="Charts" title="Charts">${FP_TAB_ICON.charts}<span>Charts</span></button>`);
      panes.push(`<div class="fp-pane hidden" data-pane="stats"></div>`);
      panes.push(`<div class="fp-pane hidden" data-pane="charts"></div>`);
    }
    // Routing used to be its own tab -- Routes on grids, Catchment on
    // facilities. Removed (31 Aug 2026) in favour of making the Details
    // table AND the Nearby list themselves clickable-to-route instead (see
    // proxDrawRoute), so the same capability is not spread across two tabs
    // that mostly repeated each other.
  }

  const wide = gridPartner || (!partner && fpHasStats(kind));

  return `<div class="fp fp-k-${kind}${wide ? " fp-wide" : ""}${partner ? " fp-partner" : ""}" data-fp-kind="${kind}" data-fp-id="${id}" data-fp-geo="${payload}" data-fp-level="${fpHospLevel}" style="--k:${kindHue}">
    ${headHtml}
    ${tabs.length ? `<div class="fp-tabs" role="tablist">${tabs.join("")}</div>` : ""}
    ${panes.join("")}
  </div>`;
}

/* Re-measure and re-anchor a popup after its content changed size.
   Deliberately NOT popup.update(): that calls _updateContent(), which resets
   the popup's DOM to the html string it was bound with and destroys anything
   rendered into it since. These three do the layout half of update() only. */
function fpResize(popup) {
  try {
    if (popup._updateLayout) popup._updateLayout();
    if (popup._updatePosition) popup._updatePosition();
    if (popup._adjustPan) popup._adjustPan();
  } catch (err) {
    /* private API — a Leaflet upgrade that renames these must not break the
       popup, it just stops auto-panning. */
  }
}

async function fpLoadNear(root, popup) {
  const pane = root.querySelector('[data-pane="near"]');
  if (!pane || pane.dataset.loaded === "1" || pane.dataset.loading === "1") return;

  const kind = root.dataset.fpKind;
  const id = root.dataset.fpId;
  const spec = fpNearSpec(kind, state.tab);
  if (!spec) return;

  const cacheKey = `${spec.key}|${id}`;
  state.fpCache = state.fpCache || {};
  if (state.fpCache[cacheKey]) {
    pane.innerHTML = state.fpCache[cacheKey];
    pane.dataset.loaded = "1";
    fpResize(popup);
    return;
  }

  pane.dataset.loading = "1";
  pane.innerHTML = '<div class="fp-loading"><span class="fp-spin"></span> Loading…</div>';
  fpResize(popup);

  let geo = {};
  try {
    geo = JSON.parse(decodeURIComponent(root.dataset.fpGeo || "{}"));
  } catch (err) {
    geo = {};
  }

  try {
    const html = await spec.run(id, geo);
    state.fpCache[cacheKey] = html;
    pane.innerHTML = html;
    pane.dataset.loaded = "1";
  } catch (err) {
    // Not cached: a transient failure should be retryable by reopening.
    pane.innerHTML = `<p class="fp-note error">Could not load: ${err.message}</p>`;
  } finally {
    pane.dataset.loading = "0";
    fpResize(popup);
  }
}

/** Grid popup's Routes tab: lazy-loads the three nearest-facility branches
 *  the same way Nearby/Statistics load, writing into this popup's own pane
 *  instead of the old fixed panel (see renderProxGridPanel). */
async function fpLoadRoutes(root, popup) {
  const pane = root.querySelector('[data-pane="routes"]');
  if (!pane) return;
  proxRoutesPane = pane;
  if (pane.dataset.loaded === "1" || pane.dataset.loading === "1") return;
  // Bound ONCE, here, to the pane container rather than to its rows --
  // renderProxGridPanel() replaces the pane's whole innerHTML on every pick
  // (to show the newly-drawn/cleared route), so per-row listeners would be
  // thrown away with the markup they were attached to. This guard only ever
  // runs once per pane, so delegation covers every re-render after it.
  bindProxPickRows(pane, pickGridBranch);
  pane.dataset.loading = "1";
  pane.innerHTML = '<div class="fp-loading"><span class="fp-spin"></span> Loading…</div>';
  fpResize(popup);
  const id = root.dataset.fpId;
  try {
    await openGridBranches({ grid_id: id });
    pane.dataset.loaded = "1";
  } catch (err) {
    pane.innerHTML = `<p class="fp-note error">Could not load: ${err.message}</p>`;
  } finally {
    pane.dataset.loading = "0";
    fpResize(popup);
  }
}

/** Facility popup's Catchment tab: lazy-loads the grids it reaches, always at
 *  the facility's OWN level (data-fp-level), regardless of which colouring
 *  mode is active -- writing into this popup's own pane instead of the old
 *  ad-hoc popup (see openHospitalBranches). */
async function fpLoadCatchment(root, popup) {
  const pane = root.querySelector('[data-pane="catchment"]');
  if (!pane) return;
  proxCatchmentPane = pane;
  if (pane.dataset.loaded === "1" || pane.dataset.loading === "1") return;
  const id = root.dataset.fpId;
  const lv = root.dataset.fpLevel;
  pane.dataset.loading = "1";
  pane.innerHTML = '<div class="fp-loading"><span class="fp-spin"></span> Loading…</div>';
  fpResize(popup);
  try {
    await openHospitalBranches({ s_no: id }, lv);
    pane.dataset.loaded = "1";
  } catch (err) {
    pane.innerHTML = `<p class="fp-note error">Could not load: ${err.message}</p>`;
  } finally {
    pane.dataset.loading = "0";
    fpResize(popup);
  }
}

/** Draw (or, on a second click of the SAME pair, clear) the real road route
 *  between a grid and a facility. Shared by the grid popup's Details table
 *  rows, the grid popup's Nearby "Top 10 hospitals" rows, and the hospital
 *  popup's Nearby "Top N grids" rows -- none of them has its own dedicated
 *  Routes/Catchment tab any more (31 Aug 2026: that capability moved onto
 *  whichever list you're already looking at, per explicit request). Falls
 *  back to a dashed straight line when this exact pair has no precomputed
 *  geometry, matching the language the app already uses for that elsewhere.
 *
 *  opts: { gridId, sNo, gridLatLon: [lat,lon], hospLatLon: [lat,lon],
 *          color?, label?, rowEl? } */
async function proxDrawRoute(opts) {
  const gridId = String(opts.gridId);
  const sNo = String(opts.sNo);
  const key = `${gridId}-${sNo}`;
  const clearPicked = () =>
    document
      .querySelectorAll(".fp-pick.is-picked, .fp-row.picked")
      .forEach((el) => el.classList.remove("is-picked", "picked"));

  if (state.proxRouteKey === key) {
    clearProxRoute();
    clearProxGridSelection();
    state.proxRouteKey = null;
    clearPicked();
    setStatus("Route cleared.");
    return;
  }

  clearProxRoute();
  state.proxRouteKey = key;
  clearPicked();
  opts.rowEl?.classList.add(opts.rowEl.classList.contains("fp-pick") ? "is-picked" : "picked");

  let poly = null;
  try {
    const r = await getJSON(
      `/api/analytics/proximity/route?grid_id=${encodeURIComponent(gridId)}` +
        `&s_no=${encodeURIComponent(sNo)}&year=${state.meta.year}` +
        // Both ends' own coordinates, so the backend can fall back to a LIVE
        // OSRM call (network_analytics._polyline_for_pair) the moment the
        // precomputed cache misses, instead of giving up on the spot.
        `&glat=${opts.gridLatLon[0]}&glon=${opts.gridLatLon[1]}` +
        `&hlat=${opts.hospLatLon[0]}&hlon=${opts.hospLatLon[1]}`
    );
    poly = r.polyline;
  } catch (err) {
    // Neither the cache nor a live OSRM call answering is not an error worth
    // surfacing -- the distance figure the reader clicked on is still
    // correct either way; the line just falls back to straight.
  }

  const pts = poly ? decodePolyline(poly) : [];
  const straight = pts.length < 2;
  const color = opts.color || PROX_HOSP_BRANCH;
  drawBranch(straight ? [opts.gridLatLon, opts.hospLatLon] : pts, color, straight, 4);
  highlightProxEnds({
    grid: { lat: opts.gridLatLon[0], lon: opts.gridLatLon[1] },
    facility: { lat: opts.hospLatLon[0], lon: opts.hospLatLon[1] },
    color,
  });
  selectProxGrid(gridId);
  frameProxPair(opts.gridLatLon, opts.hospLatLon);
  setStatus(
    `${opts.label || "Route"}${
      straight ? " — straight line, no road route found" : " — by road"
    }.`
  );
}

function fpWire(popup) {
  const elRoot = popup.getElement();
  const root = elRoot && elRoot.querySelector(".fp[data-fp-kind]");
  if (!root || root.dataset.wired === "1") return;
  root.dataset.wired = "1";

  // Leaflet already disables click propagation on the content node, but this
  // popup has real controls in it — one stray click reaching the map closes
  // the whole thing, so it is worth being explicit.
  if (window.L && L.DomEvent) {
    L.DomEvent.disableClickPropagation(root);
    L.DomEvent.disableScrollPropagation(root);
  }

  const spec = fpNearSpec(root.dataset.fpKind, state.tab);
  const nearBtn = root.querySelector('[data-fp-pane="near"]');

  /* No ranked list makes sense for this feature on this tab. Drop the Nearby
     tab rather than offering one that opens onto nothing — but only drop the
     whole BAR if nothing else lives on it. A grid always has Statistics and
     Charts, so removing the bar wholesale would take those with it. */
  if (!spec) {
    root.querySelector('.fp-tab[data-fp-pane="near"]')?.remove();
    root.querySelector('[data-pane="near"]')?.remove();
    if (!root.querySelector(".fp-tab:not([data-fp-pane='details'])")) {
      root.querySelector(".fp-tabs")?.remove();
      return;
    }
  }
  const nearLabel = spec && nearBtn && nearBtn.querySelector("span");
  if (nearLabel) {
    nearLabel.textContent = spec.label;
    // The visible text can be hidden at narrow widths, so the accessible name
    // has to carry the same words rather than a generic "Nearby".
    nearBtn.setAttribute("aria-label", spec.label);
  }

  /* Row clicks are DELEGATED to the popup root, not bound per <tr>. The ranked
     pane is written by innerHTML after this handler runs, so per-row listeners
     would have nothing to attach to; delegation survives the pane being
     replaced and re-replaced from cache. */
  const anchor = (() => {
    try {
      return JSON.parse(decodeURIComponent(root.dataset.fpGeo || "{}"));
    } catch (err) {
      return {};
    }
  })();

  const pickFromRow = (tr) => {
    if (!tr) return;
    const lat = Number(tr.dataset.pickLat);
    const lon = Number(tr.dataset.pickLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (state.tab === "proximity" && tr.dataset.pickId) {
      const kind = root.dataset.fpKind;
      if (kind === "grid" && tr.dataset.pickKind === "hospital") {
        proxDrawRoute({
          gridId: root.dataset.fpId,
          sNo: tr.dataset.pickId,
          gridLatLon: [anchor.lat, anchor.lon],
          hospLatLon: [lat, lon],
          label: tr.dataset.pickLabel,
          rowEl: tr,
        });
        return;
      }
      if (kind === "hospital" && tr.dataset.pickKind === "grid") {
        proxDrawRoute({
          gridId: tr.dataset.pickId,
          sNo: root.dataset.fpId,
          gridLatLon: [lat, lon],
          hospLatLon: [anchor.lat, anchor.lon],
          label: tr.dataset.pickLabel,
          rowEl: tr,
        });
        return;
      }
    }
    root.querySelectorAll(".fp-row.picked").forEach((r) => r.classList.remove("picked"));
    tr.classList.add("picked");
    fpShowOnMap(tr.dataset.pickKind, lat, lon, tr.dataset.pickLabel, anchor);
  };

  root.addEventListener("click", (ev) => pickFromRow(ev.target.closest(".fp-row")));
  // Keyboard parity: the rows carry tabindex, so Enter/Space must do what a
  // click does or they are a focus trap that leads nowhere.
  root.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const tr = ev.target.closest(".fp-row");
    if (!tr) return;
    ev.preventDefault();
    pickFromRow(tr);
  });

  // The Details table's own per-level rows (Proximity grid popups only) draw
  // the real road route on a click too -- see proxDrawRoute and
  // proxGridDetails. A second, separate delegation: these rows are not
  // .fp-row (that class carries the generic pin-only behaviour every other
  // kind/tab keeps), and the grid's own lat/lon (the route's OTHER end) is
  // the anchor this popup already opened with.
  if (root.dataset.fpKind === "grid" && state.tab === "proximity") {
    const pickLevelRow = (el) => {
      if (!el) return;
      const sNo = el.dataset.sNo;
      const lat = Number(el.dataset.lat);
      const lon = Number(el.dataset.lon);
      if (!sNo || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
      proxDrawRoute({
        gridId: root.dataset.fpId,
        sNo,
        gridLatLon: [anchor.lat, anchor.lon],
        hospLatLon: [lat, lon],
        color: el.dataset.color,
        label: el.dataset.label,
        rowEl: el,
      });
    };
    root.addEventListener("click", (ev) => pickLevelRow(ev.target.closest(".fp-pick[data-s-no]")));
    root.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const el = ev.target.closest(".fp-pick[data-s-no]");
      if (!el) return;
      ev.preventDefault();
      pickLevelRow(el);
    });
  }

  /* The default pane is normally Details, which is already rendered. In New
     mode a grid popup opens straight onto Statistics, and that pane is empty
     until something loads it — the click handler below only fires for tabs the
     user actually presses. */
  const active = root.querySelector(".fp-tab.active");
  if (active && (active.dataset.fpPane === "stats" || active.dataset.fpPane === "charts")) {
    fpLoadStats(root, popup, active.dataset.fpPane);
  }

  root.querySelectorAll(".fp-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const want = btn.dataset.fpPane;
      root.querySelectorAll(".fp-tab").forEach((b) => b.classList.toggle("active", b === btn));
      root
        .querySelectorAll(".fp-pane")
        .forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== want));
      if (want === "near") fpLoadNear(root, popup);
      else if (want === "stats" || want === "charts") fpLoadStats(root, popup, want);
      else fpResize(popup);
    });
  });
}

/* ==========================================================================
   REMOVED 31 Aug 2026 — the "Selected feature" card and its mirror
   ==========================================================================
   mirrorSelected() cloned the open popup's own DOM into a sidebar panel, so
   the two were the same content twice. That was tolerable when popups floated
   at the click point and vanished on the next one; it stopped being so once
   dockFeaturePopup() started relocating every popup into a fixed slab under
   the legend, where it stays put and closes on its own × . The card's one
   remaining behaviour — outliving the popup — did not earn a permanent second
   copy of every record on screen.

   Gone with it: remirrorSelected(), fpMirrorPopup, and the two renderers that
   only ever wrote into #feature-details (showGridDetail, showLevelDetail).
   The docked popup is now the single place a feature's record appears. */

/* ==========================================================================
   New mode: the hospital popup is THEIR record, not ours
   ==========================================================================
   Their `formatHospital()` names exactly ten fields off get_hosp_gps, and their
   popup shows those and nothing else. So in New mode we render those ten and
   drop our own record entirely — our TPL / tier / level-radius fields are our
   analysis, not theirs, and mixing the two would make New a hybrid rather than
   a like-for-like comparison.

   Their label list is reproduced verbatim EXCEPT the "Hosptial Name" typo,
   which is fixed here. Copying a misspelling into our own UI helps nobody, and
   the field is unambiguous. */
const FP_PARTNER_HOSPITAL_FIELDS = [
  ["hospid", "Hospital ID"],
  ["hospname", "Hospital Name"],
  ["category", "Hospital Category"],
  ["hosp_type", "Hospital Type"],
  ["hosp_level", "Hospital Level"],
  ["latitude", "Latitude"],
  ["longitude", "Longitude"],
  ["equip_prep", "Equipments Preparedness"],
  ["infra_prep", "Infrastructure Preparedness"],
  ["staff_prep", "Staff Zone Preparedness"],
];

async function fpFillPartnerHospital(popup) {
  const el = popup.getElement();
  const root = el && el.querySelector(".fp.fp-partner[data-fp-kind='hospital']");
  if (!root || root.dataset.partnerDone === "1") return;
  root.dataset.partnerDone = "1";

  const pane = root.querySelector('[data-pane="details"]');
  if (!pane) return;

  const idx = await ensureHospGps(hospitalDistrict());
  if (!idx) {
    pane.innerHTML = `<p class="fp-note error">No detailed facility record is
      available for this hospital right now.</p>`;
    fpResize(popup);
    return;
  }

  let geo = {};
  try {
    geo = JSON.parse(decodeURIComponent(root.dataset.fpGeo || "{}"));
  } catch (err) {
    geo = {};
  }
  const match = hospGpsMatch(idx, { s_no: root.dataset.fpId, lat: geo.lat, lon: geo.lon });

  if (!match) {
    pane.innerHTML = `<p class="fp-note">No detailed record for this facility
      &mdash; none of the ${idx.count.toLocaleString()} hospitals indexed for this
      district matched by ID or position.</p>`;
    fpResize(popup);
    return;
  }

  const rows = FP_PARTNER_HOSPITAL_FIELDS.map(([key, label]) => {
    const v = match[key];
    const blank = v === null || v === undefined || v === "";
    return `<dt>${label}</dt><dd>${blank ? '<span class="fp-na">—</span>' : v}</dd>`;
  }).join("");

  pane.innerHTML = `<dl class="fp-list">${rows}</dl>`;
  fpResize(popup);
}

/* Escape closes the open popup. A second way out that cannot be covered by
   anything, which is what the × turned out to need. */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // Don't steal Escape from the measure tool or a focused text field.
  if (document.getElementById("measure-toggle")?.checked) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
  if (map && map._popup) map.closePopup();
});

/* Autopan used to scroll the map to reveal a popup that opened off-screen.
   Every popup now gets relocated into the fixed dock below the map legend
   the instant it opens (dockFeaturePopup, right below), so there is nothing
   left for autopan to do except make the map jump for a moment first --
   switched off globally since every popup in this app shares the
   "feature-popup" pattern and none of them should still float at the click. */
L.Popup.mergeOptions({ autoPan: false });

/* Docks a feature popup (grid, hospital, ambulance, blood bank -- any kind,
   any tab) below the map legend instead of leaving it to float at whatever
   was clicked. Leaflet still owns the popup fully: this only moves its real
   DOM node out of the pannable popup pane, so a later pan/zoom can't drag it
   back toward the click point. Everything else about it -- tabs, the Nearby
   list, Statistics/Charts, the partner-hospital fetch, the close button --
   is untouched; only its on-screen position changes. */
function dockFeaturePopup(popup) {
  const dock = $("feature-popup-dock");
  const el = popup.getElement();
  if (!dock || !el) return;
  dock.innerHTML = "";
  dock.appendChild(el);
  dock.classList.remove("hidden");
}

// True between "a zoom-triggered layer redraw was skipped because an open
// feature popup would have been collateral-closed by it" and "that redraw
// has now run" -- set by the zoomend handler (dot/pin sizing, above), read
// and cleared by popupclose (below). Two different closures, one flag.
let pendingZoomRedraw = false;

/** The zoom-triggered grid/hospital-pin redraw, pulled out of the zoomend
 *  handler so popupclose can also run it once deferred. See both callers for
 *  why a redraw is ever deferred in the first place. */
function runZoomLevelRedraw() {
  // Each tab owns its own grid layer. Repainting with Tab 1's renderer while
  // Tab 2 is open silently overwrote the gap cells with the proximity colour
  // ramp — the map showed thousands of coloured dots while the sidebar
  // correctly said 9.
  if (state.tab === "proximity" && state.coverage) {
    renderGrids();
    renderInReachLayer();
  } else if (state.tab === "gaps" && state.levelReach) renderLevelReach(false);
  else if (state.tab === "ambulance" && state.ambGaps) renderAmbulanceGaps();
  // Facility pins are zoom-sized too (see hospIconPx), so they need the same
  // redraw — otherwise zooming in leaves 1,208 state-view dots that never
  // grow back into readable pins.
  if (state.hospitals) renderHospitals();
}

map.on("popupopen", (e) => {
  fpWire(e.popup);
  dockFeaturePopup(e.popup);
  // Warn rather than swallow. An empty partner card with a silent console is
  // indistinguishable from "the feed returned nothing", and this exact
  // swallow hid a missing-dependency error during testing.
  fpFillPartnerHospital(e.popup).catch((err) =>
    console.warn("facility record card failed:", err)
  );
});
// A pin that outlives the popup it was chosen from is orphaned context — the
// leader line points back at a feature the reader can no longer identify.
map.on("popupclose", (e) => {
  fpClearPick(e);
  // A grid's Routes tab or a facility's Catchment tab may have drawn a route
  // and ringed its two ends directly on the map (see fpLoadRoutes /
  // fpLoadCatchment) -- those live outside the popup's own DOM, so closing
  // the popup has to tear them down explicitly or they outlive the list that
  // explains them. clearProxBranches() is a no-op when neither tab was ever
  // opened, so this is safe to run on every Proximity popup close.
  if (state.tab === "proximity") {
    clearProxBranches();
    proxRoutesPane = null;
    proxCatchmentPane = null;
    state.proxRouteKey = null;
  }
  // A zoomend redraw skipped itself rather than kill this exact popup (see
  // the zoomend handler above) -- nothing left to protect now, so catch the
  // grid/hospital pins up to the zoom level the map is already sitting at.
  if (pendingZoomRedraw) {
    pendingZoomRedraw = false;
    runZoomLevelRedraw();
  }
  // Leaflet already removed the popup's own element from wherever it was
  // living (the dock, after dockFeaturePopup relocated it); this just hides
  // the now-empty dock and lets the legend drop back down.
  $("feature-popup-dock")?.classList.add("hidden");
});

// ==========================================================================
// PROXIMITY TAB — three analysis modes
// ==========================================================================
// Mode 1 "Overall"   every grid coloured by HOW MANY of L1/L2/L3 it reaches
//                    within that level's own road radius (60/30/10 km).
//                    Four colours, the partner's palette. Popups only.
//                    Every grid popup's Routes tab can draw any of its three
//                    real road routes, green or red on its own rule,
//                    regardless of which colouring is active.
// "Single level"     one level at a time. Grids collapse to green/red on that
//                    level alone and only that level's facility pins are
//                    drawn; every facility popup's Catchment tab draws its
//                    routes the same way in either colouring.
//
// Both read ONE server-side verdict (network_analytics.proximity_*), so a
// grid can never be lightyellow in "All levels" and red for L1 in "Single
// level".
const PROX_MODES = ["overall", "hospital"];
const PROX_MODE_NOTE = {
  overall:
    "Every grid scored against the three <b>public</b> conditions at once &mdash; an <b>L1 within 60&nbsp;km</b>, an <b>L2 within 30&nbsp;km</b>, an <b>L3 within 10&nbsp;km</b>, all by road. <b>Light yellow</b> satisfies all three, <b>yellow</b> any two, <b>orange</b> one, <b>red</b> none. <b>Purple</b> overrides all of those: the only facility that grid can reach is an <b>empanelled private hospital</b>. Note L1 currently has <b>no facilities at all</b>, so no grid can reach all three. Click a grid for its nearest facility at each level and to draw its road routes, or a facility for its own details and catchment.",
  hospital:
    "One level in isolation, so the question is binary: <b>yellow</b> if the grid reaches that level inside its radius, <b>red</b> if it does not &mdash; same reach palette as All levels, collapsed to the one condition being asked about, with every facility pin outside that level hidden. <b>Click a facility</b> to list the grids it reaches, then open its <b>Catchment</b> tab and click a grid to draw that one road route.",
};
const PROX_LEVEL_SPEC = { L1: 60, L2: 30, L3: 10, EP: EP_SPEC_KM };
const PROX_MET_COLOR = { 3: "lightyellow", 2: "yellow", 1: "orange", 0: "red" };
const PROX_MET_LABEL = {
  3: "All three public levels in reach",
  2: "Two of three public levels in reach",
  1: "One public level in reach",
  0: "No public level in reach",
};
/* PURPLE — the override, not a fifth rung on the ramp (25 Aug 2026).
   Fires on exactly one condition: the grid reaches NO public level AND does
   reach an empanelled private hospital. Red would claim nothing is in reach,
   which is false — there is care within 60 km, it is just not the state's.
   A grid that reaches both public and private keeps its ramp colour, because
   there the private facility is additional rather than the whole story.
   Mirrors PRIVATE_ONLY_COLOR in network_analytics.py; the server sends the
   final colour on every grid record, and this is the local fallback. */
const PROX_PRIVATE_ONLY_COLOR = "purple";
const PROX_PRIVATE_ONLY_LABEL = "Only an empanelled private hospital in reach";

/** The fill a grid record should paint, honouring the purple override. */
function proxGridColor(rec) {
  if (!rec) return PROX_MET_COLOR[0];
  if (rec.private_only) return PROX_PRIVATE_ONLY_COLOR;
  return rec.color || PROX_MET_COLOR[rec.n_met ?? 0];
}

/** The verdict sentence for a grid record, honouring the purple override. */
function proxGridVerdict(rec) {
  if (!rec) return PROX_MET_LABEL[0];
  if (rec.private_only) return PROX_PRIVATE_ONLY_LABEL;
  return rec.verdict || PROX_MET_LABEL[rec.n_met ?? 0];
}

/* THE LEGEND'S BANDS. Purple is a band you can click off like any other, so it
   needs a key alongside 3/2/1/0. "P" rather than 4, because it is not one more
   level met — a purple cell meets ZERO public levels, and numbering it above
   lightyellow would put it at the good end of a scale it is not on. */
const PROX_BAND_KEYS = [3, 2, 1, 0, "P"];
const proxBandKey = (rec) => (rec?.private_only ? "P" : rec?.n_met ?? 0);
const proxBandColor = (k) =>
  k === "P" ? PROX_PRIVATE_ONLY_COLOR : PROX_MET_COLOR[k];
const proxBandLabel = (k) =>
  k === "P" ? PROX_PRIVATE_ONLY_LABEL : PROX_MET_LABEL[k];

/** Band counts for the legend. Purple cells are MOVED out of the 0 bucket,
 *  not double-counted into a fifth one, so the five numbers still total. */
function proxBandCounts(o) {
  const raw = (n) => Number(o?.counts?.[n] ?? o?.counts?.[String(n)] ?? 0);
  const purple = Number(o?.private_only ?? 0);
  return { 3: raw(3), 2: raw(2), 1: raw(1), 0: Math.max(0, raw(0) - purple), P: purple };
}

/* The one-line explanation a grid popup owes the reader about private cover.
   Three distinct sentences, because the three situations mean different
   things and a single "private hospital nearby" line would blur them:
     purple    the ONLY thing in reach is private — the finding
     public+EP private is additional, and worth naming so nobody reads the
               ramp colour as "no private option here"
     no EP     said explicitly, so a blank space is never read as "fine" */
function epNoteHtml(rec) {
  if (!rec) return "";
  const ep = rec.nearest?.[EP_LEVEL];
  const km = rec.ep_km ?? ep?.road_km ?? null;
  if (rec.private_only) {
    return `<p class="fp-warn fp-private-note">No <b>public</b> facility reaches this grid at
      any level. The nearest care is an <b>empanelled private hospital</b>${
        ep ? ` &mdash; ${ep.name}` : ""
      }${km === null ? "" : `, ${fmt(km, 1)} km by road`}. That is why this cell is purple.</p>`;
  }
  if (rec.ep_within) {
    return `<p class="fp-muted fp-private-note">An <b>empanelled private hospital</b> is also
      in reach${ep ? ` (${ep.name}` : ""}${
        km === null ? (ep ? ")" : "") : `, ${fmt(km, 1)} km by road)`
      }. Private cover does not count toward the level score above.</p>`;
  }
  return `<p class="fp-muted fp-private-note">No empanelled private hospital within
    ${rec.radii?.[EP_LEVEL] ?? EP_SPEC_KM} km either.</p>`;
}
const PROX_OK = "#16a34a";
const PROX_FAIL = "#dc2626";
const PROX_HOSP_BRANCH = "#111827";
// Set by fpLoadRoutes/fpLoadCatchment to the currently-open popup's own
// Routes/Catchment pane element, so renderProxGridPanel/openHospitalBranches
// (still shared with their other caller) know where to write instead of the
// old fixed panel. Cleared by the global popupclose handler below.
let proxRoutesPane = null;
let proxCatchmentPane = null;
// Selection look: everything but the clicked grid fades to near-invisible: a
// literal blur filter would also soften the route branches and the popup's
// own grid, since all three currently share one canvas pane.
const PROX_SELECTED_OUTLINE = "#ffffff";
const PROX_SELECTED_WEIGHT = 4;
const PROX_DIM_OPACITY = 0.12;

// A branch whose geometry never made it into the precompute is still drawn,
// as a dashed straight line, and SAID to be a straight line. Silently drawing
// it solid would let a fallback masquerade as a measured road route.
const PROX_STRAIGHT_DASH = "6 5";

/** OSRM/Google encoded polyline (precision 5) -> [[lat, lon], ...]. */
function decodePolyline(str, precision = 5) {
  if (!str) return [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coords = [];
  const factor = 10 ** precision;
  while (index < str.length) {
    let result = 1;
    let shift = 0;
    let b;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 1;
    shift = 0;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}

/**
 * Fold the current selection state into a base Leaflet paint object.
 * Selected grid -> full opacity + a bright ring. Everything else, while a
 * selection is active -> faded almost to nothing. No selection -> unchanged.
 */
function proxSelectionPaint(id, base) {
  const sel = state.proxSelectedGridId;
  if (!sel) return base;
  if (String(id) === sel) {
    return {
      ...base,
      color: PROX_SELECTED_OUTLINE,
      weight: Math.max(base.weight || 0, PROX_SELECTED_WEIGHT),
      opacity: 1,
    };
  }
  return {
    ...base,
    opacity: (base.opacity ?? 1) * PROX_DIM_OPACITY,
    fillOpacity: (base.fillOpacity ?? 0) * PROX_DIM_OPACITY,
  };
}

/** Repaint every currently-drawn grid to match state.proxSelectedGridId, in
 * place — no rebuild, so it is safe to call from inside a popup event. */
function repaintProxSelection() {
  if (!state.proxGridLayers) return;
  state.proxGridLayers.forEach((entry, id) => {
    entry.shape.setStyle(proxSelectionPaint(id, entry.basePaint));
  });
}

function selectProxGrid(id) {
  state.proxSelectedGridId = String(id);
  repaintProxSelection();
}

function clearProxGridSelection() {
  if (!state.proxSelectedGridId) return;
  state.proxSelectedGridId = null;
  repaintProxSelection();
}

function proxMode() {
  return state.proxMode || "overall";
}
function proxLevel() {
  return state.proxLevel || "L1";
}

function proxQuery() {
  const p = new URLSearchParams({ year: state.meta?.year || "2025" });
  const d = $("prox-district")?.value;
  if (d) p.set("district", d);
  // Read by /proximity/overview, /grid/<id>, /level/<lv>, /hospital/<s_no> and
  // the proximity-bundle export — every one of them a caller of _verdict_index
  // on the server, so one flag here covers the whole tab.
  p.set("include_ep", state.includeEP ? "1" : "0");
  return p.toString();
}

/** Mode 1/2 verdicts, keyed by grid_id, for the whole current district scope. */
async function loadProxVerdicts() {
  const r = await getJSON(`/api/analytics/proximity/overview?${proxQuery()}`);
  state.proxOverview = r;
  state.proxVerdict = new Map(r.grids.map((g) => [String(g.grid_id), g]));
  state.proxRoutesAvailable = !!r.routes_available;
  return r;
}

/** Mode 3 view for ONE level, keyed by grid_id. */
async function loadProxLevel(lv) {
  const r = await getJSON(`/api/analytics/proximity/level/${lv}?${proxQuery()}`);
  state.proxLevelData = r;
  state.proxLevelVerdict = new Map(r.grids.map((g) => [String(g.grid_id), g]));
  state.proxRoutesAvailable = !!r.routes_available;
  return r;
}

/**
 * The colour a grid gets on the Proximity tab, or null to fall through to the
 * tab's other palettes. Called from gridColor().
 */
function proxGridStyle(g) {
  const id = String(g.grid_id);
  if (proxMode() === "hospital") {
    /* Same reach palette as Overall/Grid mode (PROX_MET_COLOR), not a
       separate green/red scheme — one level in isolation is just a one-
       condition version of the same question those modes ask about three.
       "yellow" (not "lightyellow") stands in for a met condition here: a
       single flat colour needs to actually READ against the basemap, and
       lightyellow is close to invisible on its own without the other three
       bands around it for contrast. "red" for missed is identical everywhere. */
    const rec = state.proxLevelVerdict?.get(id);
    if (!rec) return null;
    return {
      color: rec.ok ? PROX_MET_COLOR[2] : PROX_MET_COLOR[0],
      radius: 3.6,
      opacity: 0.75,
      outline: "black",
      outlineWeight: 1.2,
      // Focused by default to the grids that satisfy the chosen level's
      // radius — proxLevelFilter, toggled from the legend/stats swatches,
      // same mechanism as Overall mode's band filter.
      hidden: !state.proxLevelFilter.has(rec.ok ? "ok" : "fail"),
    };
  }
  /* Overall + Grid: the four-band reach verdict. n_met counts how many of the
     three spec conditions this grid satisfies (>=1 L1 <=60 km, >=1 L2 <=30 km,
     >=1 L3 <=10 km), and the band is that count — 3 light yellow, 2 yellow,
     1 orange, 0 red. Grid mode uses the identical paint and only adds the
     click-to-draw-routes behaviour on top, so the two modes can never show the
     same cell in two different colours. */
  const rec = state.proxVerdict?.get(id);
  if (!rec) return null;
  const hidden = !state.proxBandFilter.has(proxBandKey(rec));
  return {
    color: proxGridColor(rec),
    radius: 3.6,
    opacity: 0.75,
    outline: "black",
    outlineWeight: 2,
    hidden,
  };
}

// --- fixed detail panel (Grid mode) ---------------------------------------
// A Leaflet popup anchors to the map coordinate it was opened at, which for
// Grid mode is the very grid its own route branches fan out from — the
// branches disappear under their own popup half the time. Fixed to a map
// corner instead, it never overlaps what it is describing.
function showProxPanel(html) {
  const panel = $("prox-panel");
  const body = $("prox-panel-body");
  if (!panel || !body) return;
  body.innerHTML = html;
  panel.classList.remove("hidden");
  // Re-measure the map's usable rectangle now that this slab covers part of
  // it, so any popup opened while the panel is up still auto-pans into view
  // instead of behind it.
  fpSyncAutoPan();
}

function hideProxPanel() {
  $("prox-panel")?.classList.add("hidden");
  fpSyncAutoPan();
}

// --- route branches -------------------------------------------------------
/** Wipe the drawn route and its facility halo, keeping any open detail view. */
function clearProxRoute() {
  layers.proxBranches.clearLayers();
  layers.proxHighlight.clearLayers();
  state.proxPicked = null;
}

/** Wipe everything: route, halo, detail view and grid selection. */
function clearProxBranches() {
  clearProxRoute();
  state.proxSelection = null;
  state.proxGridDetail = null;
  state.proxHospDetail = null;
  state.proxHospListEl = null;
  hideProxPanel();
  clearProxGridSelection();
}

/**
 * Ring the facility that is one end of the drawn route.
 *
 * Drawn as a plain two-stroke ring rather than anything animated: the map runs
 * with preferCanvas, so a CSS-animated marker className has no DOM element to
 * attach to and would silently do nothing. It lands in the canvas overlay pane
 * (z 400), which is BELOW markerPane (z 600) — so the ring reads as a halo
 * behind the pin rather than a disc drawn over the top of it.
 */
function hasLatLon(p) {
  return !!p && p.lat !== null && p.lat !== undefined && p.lon !== null && p.lon !== undefined;
}

/**
 * Mark the two ends of the drawn route.
 *
 * A route is a claim about a JOURNEY — a casualty in this grid cell reaches
 * that hospital in this many km — so the two ends are not interchangeable and
 * are not drawn the same. The ORIGIN is the grid cell: a filled target disc,
 * because a 3.6 px grid dot with a 4 px outline was invisible under the route
 * line that starts on top of it. The DESTINATION is the facility: an open ring
 * that haloes the pin rather than covering it, since the pin already carries
 * the level colour and hiding it would throw that away.
 *
 * Roles are fixed by the geography, not by which end you happened to click:
 * the grid is always the origin, in both Grid mode and Hospital mode. A marker
 * that means "start" on one tab and "end" on another is not a legend, it is a
 * memory test.
 *
 * These are divIcons, not circleMarkers. The map runs preferCanvas, and canvas
 * silently drops the `className` a CSS pulse would hang off — the same reason
 * the popup pick-pin upstream builds its own L.svg renderer. A divIcon lands
 * in markerPane as real DOM, so the pulse just works, and it draws above the
 * canvas panes without a custom pane.
 */
function proxEndIcon(role, color) {
  return L.divIcon({
    className: `route-end route-end-${role}`,
    html:
      `<span class="route-end-pulse" style="--c:${color}"></span>` +
      `<span class="route-end-mark" style="--c:${color}"></span>`,
    iconSize: [0, 0],
  });
}

function highlightProxEnds({ grid = null, facility = null, color = "#111827" } = {}) {
  layers.proxHighlight.clearLayers();
  // Facility first, then grid: later layers draw on top, and where a PHC sits
  // inside its own grid cell the origin disc is the one that must stay legible.
  if (hasLatLon(facility)) {
    layers.proxHighlight.addLayer(
      L.marker([facility.lat, facility.lon], {
        icon: proxEndIcon("facility", color),
        interactive: false,
        // Behind the facility pin (priority 200-400) so it reads as a halo
        // around that pin rather than a disc stamped over it.
        zIndexOffset: 100,
      })
    );
  }
  if (hasLatLon(grid)) {
    layers.proxHighlight.addLayer(
      L.marker([grid.lat, grid.lon], {
        icon: proxEndIcon("grid", color),
        interactive: false,
        zIndexOffset: 600,
      })
    );
  }
}

/**
 * Frame both ends of the picked route.
 *
 * An L2 can sit 55 km from its grid, so without this the route you just asked
 * for is mostly off-screen and you are looking at one end of it. maxZoom stops
 * a 2 km hop from slamming the map to street level; the left-heavy padding
 * keeps the pair clear of the detail panel, which now lives at top-left.
 */
function frameProxPair(a, b) {
  if (!a || !b) return;
  /* The visible map is not the map element. The sidebar covers its left 386px
     and, in Grid mode, the detail panel covers a slab of its right — frame the
     route into the gap between them or half of it opens underneath furniture.
     fpEdgePadding() already measures exactly that, for the popups, including
     the over-constrained case on a narrow window. Reuse it rather than
     hand-rolling a second set of numbers that can drift from the first. */
  const pad = fpEdgePadding() || { left: 20, top: 20, right: 20, bottom: 20 };
  map.fitBounds(L.latLngBounds([a, b]).pad(0.15), {
    paddingTopLeft: [pad.left, pad.top],
    paddingBottomRight: [pad.right, pad.bottom],
    maxZoom: 13,
  });
}

function drawBranch(latlngs, color, dashed, weight = 4) {
  // Two strokes: a wide translucent casing so the line reads over any
  // basemap, then the coloured line on top. One stroke alone disappears
  // against dark satellite tiles and against the yellow grid fills.
  layers.proxBranches.addLayer(
    L.polyline(latlngs, { color: "#ffffff", weight: weight + 3, opacity: 0.75 })
  );
  layers.proxBranches.addLayer(
    L.polyline(latlngs, {
      color,
      weight,
      opacity: 0.95,
      dashArray: dashed ? PROX_STRAIGHT_DASH : null,
      lineCap: "round",
    })
  );
}

function proxTpl(v, src) {
  if (v === null || v === undefined) return "&mdash;";
  const tag = src === "real" ? "" : ` <span class="fp-est">(${src || "estimated"})</span>`;
  return `<b>${fmt(v, 1)}</b>${tag}`;
}

/**
 * Mode 2 — one grid and its three candidate facilities. Draws NOTHING yet.
 *
 * The old behaviour fired all three routes the instant a grid was clicked. It
 * looked impressive and answered nothing: three lines leaving the same cell in
 * three directions, crossing each other, with no way to tell which distance in
 * the table belonged to which line on the map. The table is now the control —
 * pick a level, get that level's route, alone.
 */
async function openGridBranches(g) {
  const id = String(g.grid_id);
  clearProxBranches();
  setStatus("Loading this grid's nearest L1, L2 and L3…");
  let r;
  try {
    r = await getJSON(`/api/analytics/proximity/grid/${id}?${proxQuery()}`);
  } catch (err) {
    setStatus(err.message, true);
    // Re-thrown (31 Aug 2026): the only caller now is fpLoadRoutes, whose
    // popup pane needs to know this failed instead of sitting on a spinner.
    throw err;
  }
  state.proxSelection = { kind: "grid", id };
  state.proxGridDetail = r;
  state.proxPicked = null;

  // The clicked grid is highlighted immediately, before any route is picked —
  // it is the subject of the panel, so it should be obvious which cell of 6,760
  // the panel is talking about.
  selectProxGrid(r.grid.grid_id);
  renderProxGridPanel();
  setStatus(
    `Grid ${r.grid.grid_id}: ${proxGridVerdict(r.grid).toLowerCase()}. ` +
      "Click a level to draw its road route."
  );
}

/** Rebuild Grid mode's panel from state, marking whichever level is picked. */
function renderProxGridPanel() {
  const r = state.proxGridDetail;
  if (!r) return;
  const v = r.grid;
  const picked = state.proxPicked;

  const rows = r.branches
    .map((b, i) => {
      const h = b.hospital;
      if (!h) {
        return `<tr class="fp-pick is-dead">
            <td><b>${b.level}</b><br/><span class="fp-muted">&le; ${b.spec_km} km</span></td>
            <td colspan="3" class="fp-muted">No ${b.level} facility within the 60 km cache</td>
          </tr>`;
      }
      const on = picked === i;
      return `<tr class="fp-pick${on ? " is-picked" : ""}" data-branch="${i}"
                  tabindex="0" role="button"
                  aria-pressed="${on ? "true" : "false"}"
                  title="${on ? "Click again to clear this route" : `Draw the road route to ${h.name}`}">
         <td><b>${b.level}</b><br/><span class="fp-muted">&le; ${b.spec_km} km</span></td>
         <td><span class="fp-hosp-icon">${hospIconHtml(b.level, false, true)}</span>${h.name}
             <br/><span class="fp-muted">${h.type} &middot; ${h.district}</span></td>
         <td class="fp-num" style="color:${b.color}"><b>${fmt(b.road_km, 1)} km</b><br/>
             <span class="fp-muted">${b.ok ? "in reach" : "beyond"}</span></td>
         <td class="fp-num">${proxTpl(h.tpl, h.tpl_source)}</td>
       </tr>`;
    })
    .join("");

  const pickedBranch = picked === null ? null : r.branches[picked];
  const note = pickedBranch
    ? `<p class="fp-picked-note">Showing <b>${pickedBranch.level}</b> route &mdash;
         ${pickedBranch.hospital.name}
         <button type="button" class="fp-clear" data-clear-route="1">Clear route</button></p>`
    : "";
  // The straight-line caveat only earns its space once a straight-line route is
  // actually on the map. Warning about a fallback nobody has triggered is noise.
  const straightNow =
    pickedBranch && decodePolyline(pickedBranch.polyline).length < 2
      ? `<p class="fp-warn">This branch is a dashed straight line &mdash; the road
         geometry for it is not in the precompute. Run
         <code>scripts/precompute_grid_routes.py</code>.</p>`
      : "";

  const html = `
    <div class="fp">
      <div class="fp-head" style="border-left:6px solid ${proxGridColor(v)}">
        <b>Grid ${v.grid_id}</b>
        <div class="fp-muted">${v.district} &middot; ${fmt(v.lat, 4)}, ${fmt(v.lon, 4)}</div>
      </div>
      <p class="fp-verdict"><b>${proxGridVerdict(v)}</b>
         &middot; TSS ${fmt(v.severity_score, 1)}</p>
      ${epNoteHtml(v)}
      <p class="fp-hint">Click a <b>level</b> below to draw that road route on its own.</p>
      <table class="fp-table">
        <thead><tr><th>Level</th><th>Nearest facility</th><th>Road</th><th>TPL</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${note}
      ${straightNow}
    </div>`;
  // Normally the current grid popup's Routes pane (see fpLoadRoutes); falls
  // back to the old fixed panel only if nothing ever set one, which should
  // not happen on the merged tab but keeps this function from doing nothing
  // if it somehow does.
  if (proxRoutesPane) proxRoutesPane.innerHTML = html;
  else showProxPanel(html);
}

/** Draw exactly one of the clicked grid's three branches, or toggle it off. */
function pickGridBranch(i) {
  const r = state.proxGridDetail;
  if (!r) return;
  const b = r.branches[i];
  if (!b || !b.hospital) return;

  // Clicking the level that is already drawn clears it. Without a toggle the
  // only way back to "no route" is closing the panel, which also throws away
  // the grid selection you were reading.
  if (state.proxPicked === i) {
    clearProxRoute();
    selectProxGrid(r.grid.grid_id);
    renderProxGridPanel();
    setStatus(`Grid ${r.grid.grid_id}: route cleared.`);
    return;
  }

  clearProxRoute();
  state.proxPicked = i;

  const h = b.hospital;
  const pts = decodePolyline(b.polyline);
  const straight = pts.length < 2;
  drawBranch(straight ? [[r.grid.lat, r.grid.lon], [h.lat, h.lon]] : pts, b.color, straight);
  highlightProxEnds({ grid: r.grid, facility: h, color: b.color });
  selectProxGrid(r.grid.grid_id);
  renderProxGridPanel();
  frameProxPair([r.grid.lat, r.grid.lon], [h.lat, h.lon]);
  setStatus(
    `${b.level}: grid ${r.grid.grid_id} to ${h.name} — ` +
      `${fmt(b.road_km, 1)} km by road (${b.ok ? "in reach" : "beyond"} the ${b.spec_km} km limit).`
  );
}

/**
 * Mode 3 — one facility and the grids it reaches. Draws NOTHING yet.
 *
 * The old behaviour drew up to 25 branches at once, which is a starburst, not
 * a route: you could see that the facility had a catchment but could not
 * follow any single grid's path through it. The list is now the control.
 */
async function openHospitalBranches(h, levelOverride) {
  const s_no = String(h.s_no ?? h.hospital_id ?? h.id ?? "");
  if (!s_no) return;
  clearProxBranches();
  // A facility's catchment is always computed at the level IT provides, not
  // whichever level the sidebar's colouring picker happens to show (31 Aug
  // 2026 merge) -- fpLoadCatchment always passes that explicitly; the old
  // proxLevel() fallback stays for the one caller that still doesn't.
  const lv = levelOverride || proxLevel();
  setStatus(`Loading ${h.name || "facility"}'s catchment…`);
  let r;
  try {
    // limit=20: this list is "top 20 grids", not "every grid within reach" --
    // the reachable_total figure above the list still reports the honest
    // full count regardless of how many rows are drawn.
    r = await getJSON(
      `/api/analytics/proximity/hospital/${s_no}?${proxQuery()}&level=${lv}&limit=20`
    );
  } catch (err) {
    setStatus(err.message, true);
    // Re-thrown: fpLoadCatchment's popup pane needs to know this failed.
    throw err;
  }
  state.proxSelection = { kind: "hospital", id: s_no };
  state.proxHospDetail = r;
  state.proxPicked = null;

  const hh = r.hospital;
  // The facility is ringed as soon as it is clicked, before any grid is picked
  // — it is the subject of the popup, and among 572 L3 discs the one you just
  // clicked is otherwise indistinguishable from its neighbours.
  highlightProxEnds({ facility: hh, color: HOSP_LEVEL_STYLE[hh.level]?.color });

  const rows = r.branches
    .map(
      (b, i) =>
        `<tr class="fp-pick" data-branch="${i}" tabindex="0" role="button"
             aria-pressed="false" title="Draw the road route to grid ${b.grid_id}">
           <td>${b.rank}</td>
           <td>Grid ${b.grid_id}<br/><span class="fp-muted">${b.district}</span></td>
           <td class="fp-num" style="color:${PROX_OK}">${fmt(b.road_km, 1)} km</td>
           <td class="fp-num">${fmt(b.severity_score, 1)}</td>
         </tr>`
    )
    .join("");

  // Written straight into the current popup's Catchment pane (see
  // fpLoadCatchment) instead of a standalone ad-hoc popup. Teardown when
  // that popup closes is handled once, centrally, by the global
  // map.on("popupclose") handler rather than a per-instance listener here.
  const html = `
      <div class="fp-head" style="border-left:6px solid ${HOSP_LEVEL_STYLE[hh.level]?.color || PROX_HOSP_BRANCH}">
        <b>${hh.name}</b>
        <div class="fp-muted">${hh.type} &middot; ${hh.district} &middot;
          <b>${hh.level}</b> (&le; ${r.spec_km} km)</div>
      </div>
      <p class="fp-verdict">
        Reaches <b>${r.reachable_total.toLocaleString()}</b> grids by road.
        TPL ${proxTpl(hh.tpl, hh.tpl_source)}.
      </p>
      <p class="fp-muted">Road distance to those grids &mdash;
        min ${fmt(r.distance_km.min, 1)} km &middot;
        median ${fmt(r.distance_km.median, 1)} km &middot;
        max ${fmt(r.distance_km.max, 1)} km</p>
      <p class="fp-hint">Click a <b>grid</b> below to draw that road route on its own.</p>
      <div class="fp-scroll">
        <table class="fp-table">
          <thead><tr><th>#</th><th>Grid</th><th>Road</th><th>TSS</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="fp-picked-note" data-picked-note hidden></p>
      ${
        r.capped
          ? `<p class="fp-muted">Listing the nearest <b>${r.drawn}</b> of
             <b>${r.reachable_total.toLocaleString()}</b> reachable grids. The counts
             above are the full figures, not the listed subset.</p>`
          : ""
      }`;
  if (proxCatchmentPane) {
    proxCatchmentPane.innerHTML = html;
    bindProxPickRows(proxCatchmentPane, pickHospitalGrid);
    state.proxHospListEl = proxCatchmentPane;
  }
  setStatus(
    `${hh.name}: ${r.reachable_total.toLocaleString()} grids within ${r.spec_km} km. ` +
      "Click a grid to draw its route."
  );
}

/** Draw exactly one grid's route from the open facility, or toggle it off. */
function pickHospitalGrid(i) {
  const r = state.proxHospDetail;
  if (!r) return;
  const b = r.branches[i];
  if (!b) return;
  const hh = r.hospital;
  const color = HOSP_LEVEL_STYLE[hh.level]?.color || PROX_HOSP_BRANCH;

  if (state.proxPicked === i) {
    layers.proxBranches.clearLayers();
    state.proxPicked = null;
    clearProxGridSelection();
    // The facility ring stays: the popup is still open and still about that
    // facility, so un-ringing it would leave the popup pointing at nothing.
    // The origin disc goes, because there is no longer a journey to have one.
    highlightProxEnds({ facility: hh, color });
    syncProxHospList();
    setStatus(`${hh.name}: route cleared.`);
    return;
  }

  layers.proxBranches.clearLayers();
  state.proxPicked = i;

  const pts = decodePolyline(b.polyline);
  const straight = pts.length < 2;
  drawBranch(straight ? [[hh.lat, hh.lon], [b.lat, b.lon]] : pts, PROX_HOSP_BRANCH, straight, 4);
  // `b` carries the grid's own lat/lon, so the origin disc lands on the cell
  // even though this mode was driven from the facility end.
  highlightProxEnds({ grid: b, facility: hh, color });
  // Highlighting the grid runs through the same selection the other modes use,
  // so the picked cell gets its bright ring and every other cell fades back.
  selectProxGrid(b.grid_id);
  syncProxHospList();
  frameProxPair([hh.lat, hh.lon], [b.lat, b.lon]);
  setStatus(
    `${hh.name} to grid ${b.grid_id} — ${fmt(b.road_km, 1)} km by road` +
      `${straight ? " (straight line — road geometry missing)" : ""}.`
  );
}

/** Restyle the facility popup's rows in place to match state.proxPicked. */
function syncProxHospList() {
  const el = state.proxHospListEl;
  const r = state.proxHospDetail;
  if (!el || !r) return;
  el.querySelectorAll(".fp-pick[data-branch]").forEach((tr) => {
    const on = Number(tr.dataset.branch) === state.proxPicked;
    tr.classList.toggle("is-picked", on);
    tr.setAttribute("aria-pressed", on ? "true" : "false");
  });
  const note = el.querySelector("[data-picked-note]");
  if (!note) return;
  const b = state.proxPicked === null ? null : r.branches[state.proxPicked];
  if (!b) {
    note.hidden = true;
    note.innerHTML = "";
    return;
  }
  note.hidden = false;
  note.innerHTML =
    `Showing the route to <b>grid ${b.grid_id}</b> &mdash; ${fmt(b.road_km, 1)} km ` +
    `<button type="button" class="fp-clear" data-clear-route="1">Clear route</button>`;
}

/**
 * Wire a container's pickable rows to `onPick(index)`.
 *
 * Delegated from the container, so rows re-rendered inside it stay live
 * without rebinding. Keyboard is handled explicitly because a <tr> gets none
 * of a <button>'s built-in Enter/Space activation, and a control that only
 * works with a mouse is not a control everyone can use.
 */
function bindProxPickRows(container, onPick) {
  if (!container) return;
  const fire = (ev) => {
    if (ev.target.closest("[data-clear-route]")) {
      if (state.proxPicked !== null) onPick(state.proxPicked); // toggles off
      return true;
    }
    const row = ev.target.closest(".fp-pick[data-branch]");
    if (!row || row.classList.contains("is-dead")) return false;
    onPick(Number(row.dataset.branch));
    return true;
  };
  container.addEventListener("click", (ev) => {
    if (fire(ev)) ev.stopPropagation();
  });
  container.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    // "Clear route" is a real <button>, so Enter/Space already synthesise a
    // click on it. Handling the keydown too would toggle the route off and
    // straight back on, and the button would appear to do nothing.
    if (ev.target.closest("[data-clear-route]")) return;
    // Space scrolls the page by default, which inside a scrollable catchment
    // list means the row you just activated jumps out from under the cursor.
    if (fire(ev)) ev.preventDefault();
  });
}

/** Mode 1 / mode 3 grid click — details, no routes. */
/** Border colour + identity line for a Proximity grid popup's head -- split
 *  out of the old proxGridPopup() so fpShell can render it separately from
 *  the tabbed body (31 Aug 2026 merge). Returns null in lock-step with
 *  proxGridDetails() below, for the same "no record yet" cases. */
function proxGridHead(g) {
  const mode = proxMode();
  if (mode === "hospital") {
    const rec = state.proxLevelVerdict?.get(String(g.grid_id));
    if (!rec) return null;
    // Same reach palette as the dot (see proxGridStyle) rather than the
    // backend's rec.color, which is still BRANCH_OK/BRANCH_FAIL green/red
    // — that constant also drives the drawn route lines, so this head
    // overrides it locally instead of changing it for every caller.
    const dotColor = rec.ok ? PROX_MET_COLOR[2] : PROX_MET_COLOR[0];
    return `<div class="fp-head" style="border-left:6px solid ${dotColor}">
      <b>Grid ${rec.grid_id}</b>
      <div class="fp-muted">${rec.district} &middot; TSS ${fmt(rec.severity_score, 1)}</div>
    </div>`;
  }
  const rec = state.proxVerdict?.get(String(g.grid_id));
  if (!rec) return null;
  return `<div class="fp-head" style="border-left:6px solid ${proxGridColor(rec)}">
    <b>Grid ${rec.grid_id}</b>
    <div class="fp-muted">${rec.district}</div>
  </div>`;
}

/** The Details pane for a Proximity grid popup -- Single level shows one
 *  level's pass/fail against its nearest facility, All levels shows every
 *  level's row. Both used to be the WHOLE popup (see the old proxGridPopup);
 *  now they are just its Details tab, with routing always living in the
 *  Routes tab beside it (fpLoadRoutes) regardless of which of these two is
 *  showing. */
function proxGridDetails(g) {
  const mode = proxMode();
  if (mode === "hospital") {
    const rec = state.proxLevelVerdict?.get(String(g.grid_id));
    if (!rec) return null;
    const n = rec.nearest;
    const dotColor = rec.ok ? PROX_MET_COLOR[2] : PROX_MET_COLOR[0];
    return `
      <p class="fp-verdict">
        <b>${proxLevel()}</b> &le; ${state.proxLevelData?.spec_km} km:
        <b style="color:${dotColor}">${rec.ok ? "in reach" : "not in reach"}</b>
      </p>
      ${
        n
          ? `<div class="fp-pick" tabindex="0" role="button" title="Click to draw the road route"
                data-s-no="${n.s_no}" data-lat="${n.lat}" data-lon="${n.lon}"
                data-color="${dotColor}"
                data-label="${proxLevel()}: ${String(n.name).replace(/"/g, "&quot;")}">
               <p><span class="fp-hosp-icon">${hospIconHtml(proxLevel(), false, true)}</span>
               Nearest ${proxLevel()}: <b>${n.name}</b><br/>
               <span class="fp-muted">${n.type} &middot; ${n.district}</span><br/>
               Road <b>${fmt(n.road_km, 1)} km</b> &middot; TPL ${proxTpl(n.tpl, n.tpl_source)}</p>
             </div>`
          : `<p class="fp-muted">No ${proxLevel()} facility within the 60 km cache.</p>`
      }`;
  }

  const rec = state.proxVerdict?.get(String(g.grid_id));
  if (!rec) return null;

  /* One row per level, ALWAYS all three — a level with no facility in the
     60 km cache still gets a row saying so. Dropping it would make the grid
     look better covered than it is, which is the exact failure this tab is
     supposed to surface.

     The road distance carries the verdict colour: GREEN when that level's
     nearest facility is inside its own spec radius (L1 60 km, L2 30 km,
     L3 10 km), RED when it is not. Straight-line sits beside it in neutral
     grey and never coloured — it is context for WHY a road distance is what
     it is, not a second pass/fail test. Only the road figure decides. */
  let anySnapped = false;
  // visibleLevels(), so the EP row is here too when the toggle allows it —
  // show WHICH private hospital it can reach, or the colour is an assertion
  // the popup cannot back up.
  const rows = visibleLevels()
    .map((lv) => {
      const n = rec.nearest?.[lv];
      const spec = rec.radii?.[lv] ?? PROX_LEVEL_SPEC[lv];
      if (!n) {
        return `<tr>
          <td><b>${lv}</b><br/><span class="fp-muted">&le; ${spec} km</span></td>
          <td colspan="3"><span style="color:${PROX_FAIL}"><b>None within 60 km</b></span>
            <br/><span class="fp-muted">no ${lv} facility in the precomputed cache</span></td>
          </tr>`;
      }
      const ok = n.within;
      const unverified = n.coord_status === "unverified";
      /* Straight-line CAN come out longer than the road distance, in about 1%
         of pairs. It is not an error in either number: OSRM measures between
         the points it SNAPS onto the road network, while the straight line is
         measured between the raw GPS points. A facility set back from the
         highway and a grid centroid out in a field can snap to spots on the
         same road that are closer together than the originals were. Marked
         rather than smoothed over — quietly clamping one figure to the other
         would be inventing a measurement neither source made. */
      const snapped = n.straight_km !== null && n.straight_km > n.road_km;
      if (snapped) anySnapped = true;
      const rowColor = ok ? PROX_OK : PROX_FAIL;
      return `<tr class="fp-pick" tabindex="0" role="button" title="Click to draw the road route"
                  data-s-no="${n.s_no}" data-lat="${n.lat}" data-lon="${n.lon}"
                  data-color="${rowColor}"
                  data-label="${lv}: ${String(n.name).replace(/"/g, "&quot;")}">
        <td><b>${lv}</b><br/><span class="fp-muted">&le; ${n.spec_km} km</span></td>
        <td><span class="fp-hosp-icon">${hospIconHtml(lv, false, true)}</span><b>${n.name}</b>
            <br/><span class="fp-muted">ID <code>${n.s_no}</code> &middot; ${n.type} &middot; ${n.district}</span>
            ${
              unverified
                ? `<br/><span class="fp-warn" style="font-size:0.68rem">&#9888; GPS pending verification</span>`
                : ""
            }</td>
        <td class="fp-num">
          <b style="color:${rowColor}">${fmt(n.road_km, 2)} km</b>
          <span class="fp-muted">road</span>
          <br/><span class="fp-muted">${fmt(n.straight_km, 2)} km straight${
            snapped ? '<sup title="Road distance is measured between road-snapped points; the straight line is between the raw GPS points.">&dagger;</sup>' : ""
          }</span></td>
        <td class="fp-num">${proxTpl(n.tpl, n.tpl_source)}</td></tr>`;
    })
    .join("");

  return `
    <p class="fp-verdict"><b>${proxGridVerdict(rec)}</b></p>
    ${epNoteHtml(rec)}
    <dl class="fp-list">
      ${popupRow("Grid ID", `<code>${rec.grid_id}</code>`)}
      ${popupRow("Grid GPS", copyableCoords(rec.lat, rec.lon))}
      ${popupRow("TSS (severity)", `<b>${fmt(rec.severity_score, 1)}</b>`)}
    </dl>
    <table class="fp-table">
      <thead><tr>
        <th>Level</th><th>Nearest facility</th><th>Distance</th><th>TPL</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${
      anySnapped
        ? `<p class="fp-muted" style="font-size:0.68rem">&dagger; Straight line reads longer than
           the road distance here. Both figures are correct: the road distance is measured
           between the points OSRM snaps onto the road network, the straight line between the
           raw GPS points.</p>`
        : ""
    }
    <p class="fp-hint">Click a <b>row</b> above to draw that road route on the map.</p>`;
}

// --- sidebar chrome -------------------------------------------------------
function renderProxStats() {
  const box = $("prox-verdict-stats");
  const key = $("prox-legend-key");
  const note = $("prox-mode-note");
  if (note) note.innerHTML = PROX_MODE_NOTE[proxMode()];
  if (!box || !key) return;

  if (proxMode() === "hospital") {
    const d = state.proxLevelData;
    if (!d) {
      box.innerHTML = "";
      key.innerHTML = "";
      return;
    }
    box.innerHTML = `
      <div class="stat-card"><span class="stat-value">${d.in_reach.toLocaleString()}</span>
        <span class="stat-label">Grids in reach</span></div>
      <div class="stat-card"><span class="stat-value">${d.out_of_reach.toLocaleString()}</span>
        <span class="stat-label">Grids not in reach</span></div>
      <div class="stat-card"><span class="stat-value">${d.hospital_count.toLocaleString()}</span>
        <span class="stat-label">${d.level} facilities</span></div>
      <div class="stat-card"><span class="stat-value">${d.spec_km}</span>
        <span class="stat-label">km road radius</span></div>`;
    const hospBand = (k, color, label, count) => {
      const on = state.proxLevelFilter.has(k);
      return `<button type="button" class="legend-item legend-filter${on ? "" : " is-off"}"
          data-reach-ok="${k}" title="Click to ${on ? "hide" : "show"} these cells">
        <i class="swatch" style="background:${color};outline:1px solid #111"></i>
        <span>${label} (${count.toLocaleString()})</span>
      </button>`;
    };
    key.innerHTML =
      hospBand("ok", PROX_MET_COLOR[2], `${d.level} within ${d.spec_km} km`, d.in_reach) +
      hospBand("fail", PROX_MET_COLOR[0], `no ${d.level} within ${d.spec_km} km`, d.out_of_reach);
    key.querySelectorAll("[data-reach-ok]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const k = btn.dataset.reachOk;
        if (state.proxLevelFilter.has(k)) state.proxLevelFilter.delete(k);
        else state.proxLevelFilter.add(k);
        renderGrids();
        renderLegend();
        renderProxStats();
        fitProxLevelBounds();
      })
    );
    return;
  }

  /* Overall + Grid: the four reach bands. The stat cards count grids per band
     and the key restates the RULE behind each band, spelled out rather than
     abbreviated — "two of three" means nothing without knowing which three
     and at what radius. Each key row is also the filter (same toggles as the
     map legend, one shared state.proxBandFilter, so they can never disagree). */
  const o = state.proxOverview;
  if (!o) {
    box.innerHTML = "";
    key.innerHTML = "";
    return;
  }
  const bc = proxBandCounts(o);
  const rad = o.radii || PROX_LEVEL_SPEC;
  const CARD_LABEL = { 3: "3 levels", 2: "2 levels", 1: "1 level", 0: "none", P: "private only" };
  box.innerHTML = PROX_BAND_KEYS.map(
    (k) =>
      `<div class="stat-card"><span class="stat-value">${(bc[k] ?? 0).toLocaleString()}</span>
           <span class="stat-label">${CARD_LABEL[k]}</span></div>`
  ).join("");
  const RULE = {
    3: `L1 &le;${rad.L1} &amp; L2 &le;${rad.L2} &amp; L3 &le;${rad.L3} km`,
    2: `any two of L1 &le;${rad.L1} / L2 &le;${rad.L2} / L3 &le;${rad.L3} km`,
    1: `only one of the three`,
    0: `none of the three, and no private hospital either`,
    P: `none of the three, but an empanelled private &le;${rad.EP ?? EP_SPEC_KM} km`,
  };
  key.innerHTML = PROX_BAND_KEYS.map((k) => {
    const on = state.proxBandFilter.has(k);
    return `<button type="button" class="legend-item legend-filter${on ? "" : " is-off"}"
          data-reach-band="${k}" title="Click to ${on ? "hide" : "show"} these cells">
        <i class="swatch" style="background:${proxBandColor(k)};outline:1px solid #111"></i>
        <span>${proxBandLabel(k)} (${(bc[k] ?? 0).toLocaleString()})
          <br/><span class="fp-muted" style="font-size:0.68rem">${RULE[k]}</span></span>
      </button>`;
  }).join("");
  key.querySelectorAll("[data-reach-band]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const raw = btn.dataset.reachBand;
      const n = raw === "P" ? "P" : Number(raw);
      if (state.proxBandFilter.has(n)) state.proxBandFilter.delete(n);
      else state.proxBandFilter.add(n);
      renderProxStats();
      renderGrids();
      renderLegend();
    });
  });
}

function renderProxRoutesNote() {
  const el = $("prox-routes-note");
  if (!el) return;
  // Used to blank out in Overall mode, when routing only existed in Grid
  // mode. Every grid's Routes tab (and every facility's Catchment tab) draws
  // real routes now regardless of which colouring is active (31 Aug 2026
  // merge), so this note is always relevant.
  el.innerHTML = state.proxRoutesAvailable
    ? "Branches follow the real road network (precomputed from OSRM)."
    : `<b>Road geometry not built.</b> Branches will be dashed straight lines until you run
       <code>python3 scripts/precompute_grid_routes.py</code>.`;
}

/* The filter text is echoed back into an innerHTML string ("3 of 572 match
   <query>"), so it has to be escaped — it is the one value on that line typed
   by a person rather than read from the payload. */
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Does one facility match the sidebar filter? Shared by both list renderers so
 * the same query can never mean two different things between modes.
 *
 * Every field a ROW DISPLAYS is searchable, which was the bug (24 Aug 2026):
 * the rows showed ID, type and level, and the filter looked at name and
 * district only. Typing "Empanelled" — a string printed on 614 visible rows —
 * returned nothing, and so did "L1".
 *
 * ID is prefix-matched, not exact. It used to be `String(s_no) === q`, so
 * typing "68" jumped to the single facility whose id IS 68 and hid the eleven
 * beginning 68 — the opposite of what a filter should do as you type.
 *
 * `lv` is passed in because the two callers disagree about where the level
 * lives: Overall/Grid derive it from counts_at_level, mode 3 has it on the
 * record as `level`.
 */
function hospMatchesQuery(h, q, lv) {
  if (!q) return true;
  return (
    (h.name || "").toLowerCase().includes(q) ||
    (h.district || "").toLowerCase().includes(q) ||
    (h.hosp_type || h.type || "").toLowerCase().includes(q) ||
    (lv || "").toLowerCase() === q ||
    String(h.s_no).toLowerCase().startsWith(q)
  );
}

/**
 * Overall/Grid sidebar list: every facility on the map right now, carrying the
 * fields the brief calls mandatory — hospital id, name, type, level, GPS and
 * TPL. Reads state.hospitals, the SAME array renderHospitals() draws from, and
 * applies the same level filter, so the list and the pins are always the same
 * set of facilities. Ranked by TPL so it opens on the best-prepared ones.
 */
function renderProxFacilityList() {
  const box = $("prox-hosp-list");
  if (!box) return;
  if (!state.hospitals) {
    box.innerHTML = "";
    return;
  }
  const q = ($("prox-hosp-search")?.value || "").trim().toLowerCase();
  const district = hospitalDistrict();
  const rows = state.hospitals.filter((h) => {
    const lv = (h.counts_at_level ?? h.hosp_level ?? "").toUpperCase();
    if (!lv || !state.hospLevels.has(lv)) return false;
    // Same boundary test as the pins, so the list and the map never disagree.
    if (district && outsideDistrict(h.lon, h.lat, h.district, district)) return false;
    return !q || hospMatchesQuery(h, q, lv);
  });
  rows.sort((a, b) => (b.tpl ?? -1) - (a.tpl ?? -1));

  const note = $("prox-hosp-note");
  if (note) {
    note.innerHTML = q
      ? `<b>${rows.length.toLocaleString()}</b> of ${state.hospitals.length.toLocaleString()}
         ${rows.length === 1 ? "facility matches" : "facilities match"}
         &ldquo;${escapeHtml(q)}&rdquo;. Click one for its full detail.`
      : `<b>${rows.length.toLocaleString()}</b> facilities in view &mdash;
         each row carries its ID, type, level, GPS and TPL.
         Click one here or on the map for its full detail.`;
  }
  if (!rows.length) {
    box.innerHTML = `<p class="panel-note">No facility matches that filter.</p>`;
    return;
  }
  // Capped for the DOM's sake — 1,208 rows makes the sidebar scroll like
  // treacle. The count above stays honest about what was cut.
  const shown = rows.slice(0, 120);
  box.innerHTML =
    shown
      .map((h) => {
        const lv = (h.counts_at_level ?? h.hosp_level ?? "").toUpperCase();
        const c = HOSP_LEVEL_STYLE[lv] || HOSP_LEVEL_STYLE.OTHER;
        return `
      <button type="button" class="hosp-row" data-sno="${h.s_no}">
        <span class="hosp-row-name">${h.name}
          ${h.coord_status === "unverified" ? '<span class="fp-warn" style="font-size:0.68rem">&#9888;</span>' : ""}</span>
        <span class="hosp-row-meta">ID <code>${h.s_no}</code> &middot; ${h.hosp_type}
          &middot; ${h.district}<br/><code class="coord">${fmt(h.lat, 4)}, ${fmt(h.lon, 4)}</code></span>
        <span class="hosp-row-count" style="color:${c.color}">${lv}
          <small>TPL ${h.tpl === null || h.tpl === undefined ? "&mdash;" : fmt(h.tpl, 1)}</small></span>
      </button>`;
      })
      .join("") +
    (rows.length > shown.length
      ? `<p class="panel-note">Showing the top ${shown.length} of
         ${rows.length.toLocaleString()} by TPL &mdash; use the filter above.</p>`
      : "");
  box.querySelectorAll(".hosp-row").forEach((b) => {
    b.addEventListener("click", () => {
      const h = state.hospitals.find((x) => String(x.s_no) === b.dataset.sno);
      if (!h) return;
      map.setView([h.lat, h.lon], Math.max(map.getZoom(), 10));
      L.popup({ maxWidth: 320, className: "feature-popup" })
        .setLatLng([h.lat, h.lon])
        .setContent(featurePopup("hospital", h))
        .openOn(map);
    });
  });
}

/** Mode 3 sidebar list: the facilities of the level under analysis. */
function renderProxHospitalList() {
  const box = $("prox-hosp-list");
  if (!box) return;
  const d = state.proxLevelData;
  if (proxMode() !== "hospital") {
    renderProxFacilityList();
    return;
  }
  if (!d) {
    box.innerHTML = "";
    return;
  }
  const q = ($("prox-hosp-search")?.value || "").trim().toLowerCase();
  const rows = d.hospitals.filter((h) => hospMatchesQuery(h, q, h.level || d.level));
  const note = $("prox-hosp-note");
  if (note) {
    /* Counts the FILTERED rows, not d.hospital_count (fixed 24 Aug 2026).
       Reporting the level total meant the line read "572 L3 facilities" no
       matter what you typed — including when the filter had matched nothing at
       all, which is exactly the moment the number has to move. */
    note.innerHTML = q
      ? `<b>${rows.length.toLocaleString()}</b> of ${d.hospital_count.toLocaleString()}
         ${d.level} facilities match &ldquo;${escapeHtml(q)}&rdquo;.
         Click one to draw its catchment.`
      : `<b>${d.hospital_count.toLocaleString()}</b> ${d.level} facilities
         &mdash; each reaches the grids within <b>${d.spec_km} km</b> by road.
         Click one here or on the map to draw its catchment.`;
  }
  if (!rows.length) {
    box.innerHTML = `<p class="panel-note">No ${d.level} facility matches that filter.</p>`;
    return;
  }
  // Capped for the DOM's sake — L3 has 572 facilities and rendering every row
  // makes the sidebar scroll like treacle. The count above stays honest.
  const shown = rows.slice(0, 120);
  box.innerHTML =
    shown
      .map(
        (h) => `
      <button type="button" class="hosp-row" data-sno="${h.s_no}">
        <span class="hosp-row-name">${h.name}</span>
        <span class="hosp-row-meta">${h.district} &middot; TPL ${
          h.tpl === null || h.tpl === undefined ? "&mdash;" : fmt(h.tpl, 1)
        }</span>
        <span class="hosp-row-count">${h.reachable_grids.toLocaleString()}<small>grids</small></span>
      </button>`
      )
      .join("") +
    (rows.length > shown.length
      ? `<p class="panel-note">Showing the top ${shown.length} of
         ${rows.length.toLocaleString()} by grids covered &mdash; use the filter above.</p>`
      : "");

  box.querySelectorAll(".hosp-row").forEach((b) => {
    b.addEventListener("click", () => {
      const h = d.hospitals.find((x) => String(x.s_no) === b.dataset.sno);
      if (!h) return;
      map.setView([h.lat, h.lon], Math.max(map.getZoom(), 10));
      // The reachable-grids list is the Nearby tab now (see fpHospitalGrids),
      // not its own ad-hoc popup. This list only ever shows ONE level
      // (d.level) so the payload doesn't always carry counts_at_level --
      // filled in here so the popup's own head/badge still reads correctly.
      h.counts_at_level = h.counts_at_level || d.level;
      const popup = L.popup({ maxWidth: 320, className: "feature-popup" })
        .setLatLng([h.lat, h.lon])
        .setContent(featurePopup("hospital", h))
        .openOn(map);
      popup
        .getElement()
        ?.querySelector('.fp-tab[data-fp-pane="near"]')
        ?.click();
    });
  });
}

function syncProxChrome() {
  document.querySelectorAll("#prox-mode button").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === proxMode());
  });
  document.querySelectorAll("#prox-level button").forEach((b) => {
    b.classList.toggle("active", b.dataset.level === proxLevel());
  });
  const tabs = $("prox-level-tabs");
  if (tabs) tabs.classList.toggle("hidden", proxMode() !== "hospital");
  // The chosen level's caveat, if it has one — L1's "there are none of these"
  // and EP's "this is private capacity, counted separately". Silence would let
  // an empty L1 map read as a loading failure.
  const lvNote = $("prox-level-note");
  if (lvNote) {
    const txt = LEVEL_NOTE[proxLevel()] || "";
    lvNote.innerHTML = txt;
    lvNote.classList.toggle("hidden", !txt);
    lvNote.classList.toggle("warn-note", proxLevel() === "L1");
  }
  const picker = $("prox-hospital-panel");
  // The ranked facility list is now shown in all three modes — Overall/Grid
  // get the hospital-centric compliance list, Hospital mode keeps its own
  // level-scoped list. Both render through the same #prox-hosp-list box.
  if (picker) picker.classList.remove("hidden");
  // All three modes want facility pins visible: Overall and Grid so the
  // icons a popup names are actually findable on the map, Hospital because
  // it is driven by clicking facilities directly. Without this the tab
  // silently loses that context if the layer happened to be off from
  // whatever the user last did on another tab.
  if (state.tab === "proximity") {
    const t = hospitalLayerToggle();
    if (t && !t.checked) {
      t.checked = true;
      renderHospitals();
    }
  }
  renderProxRoutesNote();
}

async function refreshProximityMode({ reload = true } = {}) {
  if (state.tab !== "proximity") return;
  clearProxBranches();
  syncProxChrome();
  try {
    if (reload) {
      if (proxMode() === "hospital") await loadProxLevel(proxLevel());
      else await loadProxVerdicts();
    }
  } catch (err) {
    setStatus(err.message, true);
    return;
  }
  renderProxStats();
  renderProxHospitalList();
  syncProxChrome();
  renderGrids();
  renderHospitals();
  renderLegend();
  if (reload) fitProxLevelBounds();
}

async function setProxMode(mode) {
  if (!PROX_MODES.includes(mode)) return;
  state.proxMode = mode;
  // Fresh mode, fresh focus — a filter left over from the last level (or from
  // Overall/Grid, which doesn't use this Set at all) shouldn't quietly decide
  // what's on screen for a mode the user just switched into.
  state.proxLevelFilter = new Set(["ok"]);
  await refreshProximityMode();
}

async function setProxLevel(lv) {
  if (!PROX_LEVEL_SPEC[lv]) return;
  state.proxLevel = lv;
  state.proxLevelFilter = new Set(["ok"]);
  await refreshProximityMode();
}

/**
 * Hospital mode's "focus": after a level loads (or its in-reach/not-in-reach
 * filter is toggled), fit the map to what's actually on screen — the grids
 * currently passing proxLevelFilter plus that level's own facility pins —
 * instead of leaving the view wherever the last mode/level happened to sit,
 * which for a single level's reach usually orphans most of it off-screen.
 */
function fitProxLevelBounds() {
  if (state.tab !== "proximity" || proxMode() !== "hospital") return;
  const pts = [];
  (state.proxLevelData?.grids || []).forEach((g) => {
    const key = g.ok ? "ok" : "fail";
    if (state.proxLevelFilter.has(key) && hasLatLon(g)) pts.push([g.lat, g.lon]);
  });
  const lv = proxLevel();
  (state.hospitals || []).forEach((h) => {
    const hlv = (h.counts_at_level ?? h.hosp_level ?? "").toUpperCase();
    if (hlv === lv && hasLatLon(h)) pts.push([h.lat, h.lon]);
  });
  if (!pts.length) return;
  if (pts.length === 1) {
    map.setView(pts[0], 12);
    return;
  }
  const pad = fpEdgePadding() || { left: 20, top: 20, right: 20, bottom: 20 };
  map.fitBounds(L.latLngBounds(pts).pad(0.08), {
    paddingTopLeft: [pad.left, pad.top],
    paddingBottomRight: [pad.right, pad.bottom],
    maxZoom: 11,
  });
}

function initProximityModes() {
  document.querySelectorAll("#prox-mode button").forEach((b) => {
    b.addEventListener("click", () => setProxMode(b.dataset.mode));
  });
  document.querySelectorAll("#prox-level button").forEach((b) => {
    b.addEventListener("click", () => setProxLevel(b.dataset.level));
  });
  $("prox-hosp-search")?.addEventListener("input", renderProxHospitalList);
  // The old fixed #prox-panel (its close button and its own pick-row
  // delegation) is retired (31 Aug 2026 merge) -- routing and catchment now
  // live in each popup's own Routes/Catchment tab, wired by fpWire /
  // fpLoadRoutes / fpLoadCatchment instead.
  syncProxChrome();
}
