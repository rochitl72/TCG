"""Screenshot every chart and map view in the analytics app.

Drives a headless Chrome over CDP rather than re-plotting the data offline,
because the charts ARE the deliverable: re-drawing them in matplotlib would
produce different pictures from the ones the app shows, and the whole point of
the deck is to explain what is on screen.

Output: ~/Downloads/Outcomes/charts/*.png at 2x device scale, plus
charts/_manifest.json recording what each image is and the live numbers behind
it, which the deck builder reads so no figure in the PPT is typed by hand.

Run with the app up on :5050 and Chrome started with
  --headless=new --remote-debugging-port=9333 --remote-allow-origins=*
"""

import base64
import json
import os
import time

import requests
import websocket

CDP = "http://localhost:9333"
OUT = os.path.expanduser("~/Downloads/Outcomes/charts")
os.makedirs(OUT, exist_ok=True)

_id = 0
ws = None
manifest = []


def connect():
    global ws
    tab = next(t for t in requests.get(f"{CDP}/json").json() if t.get("type") == "page")
    ws = websocket.create_connection(tab["webSocketDebuggerUrl"], timeout=60)
    send("Page.enable")
    send("Runtime.enable")
    send("Emulation.setDeviceMetricsOverride", {
        "width": 1700, "height": 1050, "deviceScaleFactor": 2, "mobile": False,
    })


def send(method, params=None):
    global _id
    _id += 1
    ws.send(json.dumps({"id": _id, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == _id:
            return msg


def ev(expr, await_promise=False):
    r = send("Runtime.evaluate", {
        "expression": expr, "returnByValue": True, "awaitPromise": await_promise,
    })
    res = r.get("result", {})
    if res.get("exceptionDetails"):
        return "EXC " + str(res["exceptionDetails"].get("exception", {}).get("description", ""))[:300]
    return res.get("result", {}).get("value")


def shot(name, caption, clip=None, facts=None):
    """One PNG plus its manifest entry. `clip` is a viewport-space rect."""
    params = {"format": "png"}
    if clip:
        params["clip"] = {**clip, "scale": 1}
    data = send("Page.captureScreenshot", params)["result"]["data"]
    path = os.path.join(OUT, f"{name}.png")
    with open(path, "wb") as fh:
        fh.write(base64.b64decode(data))
    manifest.append({"file": f"{name}.png", "caption": caption, "facts": facts or {}})
    print(f"  saved {name}.png  ({os.path.getsize(path) // 1024} KB)")


def rect_of(sel, tries=12):
    """Reveal a chart and return its viewport rect, or None if it never renders.

    Three things had to be handled together, because each one alone produced a
    zero-size element and a silently skipped figure:
      * the chart's accordion may be collapsed, so height is 0 even though the
        SVG inside it is fully built;
      * the panel is inside a sidebar that scrolls independently of the page;
      * several charts build their SVG a beat after the accordion opens.
    So: force the ancestor accordion open, scroll it into view, then poll until
    the box has real size instead of measuring once and giving up.

    Padded by 10 px so stroke edges are not clipped, and clamped to the
    viewport because CDP accepts a rect running off-screen and returns a
    mostly-blank image rather than an error.
    """
    for _ in range(tries):
        r = ev(f"""
        (() => {{
          const e = document.querySelector('{sel}');
          if (!e) return null;
          const acc = e.closest('.panel.acc');
          if (acc && !acc.classList.contains('open')) acc.querySelector('.acc-head')?.click();
          e.scrollIntoView({{block:'center'}});
          /* Frame the whole PANEL, not the bare chart div. Several charts keep
             their colour key in a sibling element (#viz-amb-mix-legend and
             friends), so cropping to the chart alone shipped a stacked bar
             reading "53% / 36%" with nothing to say what of. The panel also
             carries the chart's title and its explanatory note, which is
             exactly what a slide needs. */
          const target = acc && acc.getBoundingClientRect().height > 40 ? acc : e;
          const b = target.getBoundingClientRect();
          if (b.width < 40 || b.height < 25) return null;
          /* Clip to what is actually VISIBLE inside the sidebar, not to the
             panel's full box. The sidebar scrolls independently, so a panel
             taller than it still reports its whole height — cropping to that
             captured the map painted behind the overflow, and the slide ended
             in a stray strip of map texture. The top is also held below the
             app header, which was being sliced through mid-letter. */
          const host = target.closest('.sidebar,.side-panel,aside');
          const hb = host ? host.getBoundingClientRect() : {{x:0,y:0,right:innerWidth,bottom:innerHeight}};
          const x0 = Math.max(0, hb.x, b.x - 10);
          const x1 = Math.min(innerWidth, hb.right, b.right + 10);
          const y0 = Math.max(56, hb.y, b.y - 10);
          const y1 = Math.min(innerHeight, hb.bottom, b.bottom + 10);
          if (x1 - x0 < 40 || y1 - y0 < 25) return null;
          return {{x: x0, y: y0, width: x1 - x0, height: y1 - y0}};
        }})()
        """)
        if r:
            return r
        time.sleep(0.6)
    return None


def open_all_accordions():
    ev("""
    document.querySelectorAll('.sub-panel:not(.hidden) .panel.acc:not(.open) .acc-head')
      .forEach(h => h.click());
    'ok'
    """)
    time.sleep(1.2)


def sub_tab(view, sub):
    ev(f"document.querySelector('[data-view=\"{view}\"][data-sub=\"{sub}\"].sub-tab')?.click(); 'ok'")
    time.sleep(1.5)


def tab(name):
    ev(f"document.querySelector('[data-tab=\"{name}\"]').click(); 'ok'")
    time.sleep(4)


def chart(sel, name, caption, facts=None):
    r = rect_of(sel)
    if not r:
        print(f"  SKIP {name} — {sel} absent or empty")
        manifest.append({"file": None, "caption": caption, "facts": facts or {},
                         "skipped": f"{sel} not rendered"})
        return
    time.sleep(0.4)
    shot(name, caption, r, facts)


def widen_sidebar(px=620):
    """Temporarily widen the sidebar before shooting its chart panels.

    At its normal ~300 px the panels are roughly 0.3:1 — three times taller
    than they are wide. Dropped into a 16:9 slide that fits by height and comes
    out about an inch and a half wide, small enough that the chart inside is
    unreadable, while three-quarters of the slide stays blank. Widening the
    container first gives panels closer to 1:1, which is a shape a slide can
    actually use. The charts are SVGs sized to their container, so they have to
    be re-rendered afterwards rather than merely reflowed.
    """
    ev(f"""
    (() => {{
      const s = document.querySelector('.sidebar,.side-panel,aside');
      if (!s) return 'no sidebar';
      s.style.width = '{px}px';
      s.style.maxWidth = '{px}px';
      window.dispatchEvent(new Event('resize'));
      return 'ok';
    }})()
    """)
    time.sleep(1.0)
    # Re-render whatever chart builders this build exposes. Named individually
    # rather than swept by regex so a future non-chart render* function cannot
    # be called with no arguments and throw mid-capture.
    ev("""
    ['renderLevelStrip','renderCoverageTplScatter','renderTssCharts',
     'renderGapCharts','renderSensitivity','renderLevelStats','renderGapReach',
     'renderAmbulanceGaps','renderAmbulanceCharts','renderLegend']
      .forEach(fn => { try { if (typeof window[fn] === 'function') window[fn](); } catch (e) {} });
    'ok'
    """)
    time.sleep(2.0)


def reset_sidebar():
    ev("""
    (() => { const s = document.querySelector('.sidebar,.side-panel,aside');
      if (s) { s.style.width = ''; s.style.maxWidth = ''; }
      window.dispatchEvent(new Event('resize'));
      if (window.map) setTimeout(()=>map.invalidateSize(), 100);
      return 'ok'; })()
    """)
    time.sleep(1.2)


def hide_sidebar(hidden=True):
    """Collapse the sidebar so a map screenshot is the map, not 40% panel."""
    ev(f"""
    (() => {{ const s = document.querySelector('.sidebar,.side-panel,aside');
      if (s) s.style.display = '{"none" if hidden else ""}';
      if (window.map) setTimeout(()=>map.invalidateSize(), 100);
      return 'ok'; }})()
    """)
    time.sleep(1.2)


# --------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------
connect()
send("Network.setCacheDisabled", {"cacheDisabled": True})
send("Page.navigate", {"url": "http://localhost:5050/proximity"})
time.sleep(6)
for _ in range(90):
    if ev("typeof state !== 'undefined' && !!state.proxOverview && !!state.meta"):
        break
    time.sleep(0.5)
else:
    raise SystemExit("app never became ready")
print("app ready")

# Live numbers, pulled once and stamped into the manifest so the deck quotes
# the same figures the pictures were taken from.
F = json.loads(ev("""JSON.stringify({
  bands: proxBandCounts(state.proxOverview),
  total: state.proxOverview.total,
  missed: state.proxOverview.missed_by_level,
  ep_in_reach: state.proxOverview.ep_in_reach,
  private_only: state.proxOverview.private_only,
  radii: state.proxOverview.radii,
})"""))
print("live figures:", F)

# ---- PROXIMITY -----------------------------------------------------------
print("PROXIMITY")
ev("setProxMode('overall')", True); time.sleep(3)
hide_sidebar(True)
ev("map.setView([29.2,76.4], 8)"); time.sleep(4)
shot("01_proximity_overall_map",
     "Proximity - Overall. Every 1 km grid cell in Haryana coloured by how many "
     "of the three PUBLIC levels it can reach by road. Purple overrides that "
     "count where the only facility in reach is an empanelled private hospital.",
     facts=F)

ev("setProxMode('hospital')", True); time.sleep(2)
ev("setProxLevel('EP')", True); time.sleep(4)
shot("02_proximity_hospital_mode_EP",
     "Proximity - Hospital mode, EP. The map focuses on empanelled private "
     "hospitals and the grids within 60 km of one.",
     facts=json.loads(ev("JSON.stringify({level:proxLevel(),hospitals:state.proxLevelData.hospital_count,in_reach:state.proxLevelData.in_reach,out_of_reach:state.proxLevelData.out_of_reach,spec_km:state.proxLevelData.spec_km})")))

ev("setProxLevel('L3')", True); time.sleep(4)
shot("03_proximity_hospital_mode_L3",
     "Proximity - Hospital mode, L3. CHC / SDH / PHC and the grids within 10 km.",
     facts=json.loads(ev("JSON.stringify({level:proxLevel(),hospitals:state.proxLevelData.hospital_count,in_reach:state.proxLevelData.in_reach,out_of_reach:state.proxLevelData.out_of_reach,spec_km:state.proxLevelData.spec_km})")))

ev("setProxLevel('L1')", True); time.sleep(4)
shot("04_proximity_hospital_mode_L1_empty",
     "Proximity - Hospital mode, L1. The map is empty because L1 has no "
     "facilities at all: Haryana operates no public medical college or "
     "super-speciality hospital in this dataset.",
     facts=json.loads(ev("JSON.stringify({level:proxLevel(),hospitals:state.proxLevelData.hospital_count,in_reach:state.proxLevelData.in_reach,out_of_reach:state.proxLevelData.out_of_reach,spec_km:state.proxLevelData.spec_km})")))

ev("setProxMode('overall')", True); time.sleep(3)
r = rect_of(".legend, #prox-legend, .map-legend")
if r:
    shot("05_proximity_legend_bands", "The five grid states and how many cells are in each.", r, F)

hide_sidebar(False)
sub_tab("proximity", "charts")
open_all_accordions()
widen_sidebar()
chart("#viz-level-strip", "06_network_by_service_level",
      "Network by service level - how many facilities each level has, their "
      "median TPL preparedness score and their median catchment.",
      json.loads(ev("JSON.stringify({level_radii:state.levelKm})")))
chart("#viz-cov-tpl", "07_load_vs_preparedness",
      "Load vs preparedness - each facility plotted by how many grids it serves "
      "(log scale) against its TPL score. Shape and colour give the level.")
# The two TSS charts live on PROXIMITY / charts, not on the Gaps tab where
# their subject matter would suggest. Captured here, kept numbered 12/13 so
# the deck's running order still reads gaps-then-severity.
chart("#viz-tss-total", "12_district_tss_total",
      "District TSS - total accident severity burden per district. This is the "
      "demand side of the analysis: coverage only matters where crashes happen.")
chart("#viz-tss-percell", "13_district_tss_per_cell",
      "District TSS per cell - the same burden normalised by area, so a large "
      "rural district is not flattered by its size.")

# ---- GAPS ----------------------------------------------------------------
print("GAPS")
reset_sidebar()
tab("gaps")
sub_tab("gaps", "charts")
open_all_accordions()
widen_sidebar()
G = json.loads(ev("""JSON.stringify({
  levels: state.levelReach?.levels, out: state.levelReach?.out_count,
  inr: state.levelReach?.in_count, total: state.levelReach?.total_grids,
  missed: state.levelReach?.missed_by_level, radii: state.levelReach?.radii,
})"""))
print("  gaps figures:", G)
chart("#viz-gap-meter", "08_gaps_headline",
      "Gaps - the headline. How many grid cells fail the combined public "
      "L1/L2/L3 road-reach rule.", G)
chart("#viz-miss-bar", "09_which_level_fails",
      "Which level fails - the gap split by level, so it is clear whether a "
      "cell is short of L1, L2 or L3.", G)
chart("#viz-gap-districts", "10_gaps_by_district",
      "Gaps by district - where the uncovered cells actually are.", G)
chart("#viz-sens", "11_radius_sensitivity",
      "Radius sensitivity - gap count against radius for each level. Shows "
      "which radius is binding: a steep curve means the verdict moves a lot "
      "with a small change, a flat one means it does not.", G)

reset_sidebar()
hide_sidebar(True)
ev("map.setView([29.2,76.4], 8)"); time.sleep(4)
shot("14_gaps_map", "Gaps - the map of cells failing the combined rule.", facts=G)
hide_sidebar(False)

# ---- AMBULANCE -----------------------------------------------------------
print("AMBULANCE")
tab("ambulance")
time.sleep(4)
A_old = json.loads(ev("""JSON.stringify({
  dataset:'old', gaps: state.ambGaps?.gap_count, covered: state.ambGaps?.covered,
  gap_pct: state.ambGaps?.gap_pct, severity_pct: state.ambGaps?.severity_pct,
  threshold_km: state.ambGaps?.threshold_km,
  bands: (()=>{const c={};(state.ambGaps?.gaps||[]).forEach(g=>{const b=ambBand(g.road_km,state.ambGaps.threshold_km);c[AMB_BAND_LABEL[b]]=(c[AMB_BAND_LABEL[b]]||0)+1;});return c;})(),
})"""))
print("  old:", A_old)
hide_sidebar(True)
ev("map.setView([29.2,76.4], 8)"); time.sleep(4)
shot("15_ambulance_old_fleet_map",
     "Ambulance - old fleet. Cells 10 km or more by road from the nearest "
     "ambulance, in the four reach bands.", facts=A_old)
hide_sidebar(False)

sub_tab("ambulance", "charts")
open_all_accordions()
widen_sidebar()
chart("#viz-amb-mix", "16_what_covers_the_grids",
      "What is actually covering the grids - for every covered cell, the type "
      "of vehicle that covers it. A patient-transport van inside the radius is "
      "not an emergency response.", A_old)
chart("#viz-amb-worst", "17_worst_served_grids",
      "Worst-served grids - the extreme tail by road distance.", A_old)
chart("#viz-amb-districts", "18_ambulance_gaps_by_district",
      "Ambulance gaps by district.", A_old)

reset_sidebar()
sub_tab("ambulance", "controls")
ev("document.querySelector('#amb-dataset [data-dataset=\"new\"]').click(); 'ok'")
time.sleep(8)
A_new = json.loads(ev("""JSON.stringify({
  dataset:'new', gaps: state.ambGaps?.gap_count, covered: state.ambGaps?.covered,
  gap_pct: state.ambGaps?.gap_pct, severity_pct: state.ambGaps?.severity_pct,
  threshold_km: state.ambGaps?.threshold_km,
  stations: state.ambGaps?.station_count, stations_total: state.ambGaps?.station_total,
  bands: (()=>{const c={};(state.ambGaps?.gaps||[]).forEach(g=>{const b=ambBand(g.road_km,state.ambGaps.threshold_km);c[AMB_BAND_LABEL[b]]=(c[AMB_BAND_LABEL[b]]||0)+1;});return c;})(),
})"""))
print("  new:", A_new)
hide_sidebar(True)
ev("map.setView([29.2,76.4], 8)"); time.sleep(4)
shot("19_ambulance_new_workbook_map",
     "Ambulance - new workbook (142 partner stations). Same four reach bands, "
     "measured against the same 10 km limit.", facts=A_new)
r = rect_of(".legend, .map-legend")
if r:
    shot("20_ambulance_reach_bands_legend",
         "The four ambulance reach bands, spelled out in kilometres at the "
         "current 10 km threshold.", r, A_new)
hide_sidebar(False)

with open(os.path.join(OUT, "_manifest.json"), "w") as fh:
    json.dump({"figures": F, "gaps": G, "amb_old": A_old, "amb_new": A_new,
               "images": manifest}, fh, indent=2)
print(f"\n{len([m for m in manifest if m.get('file')])} images -> {OUT}")
skipped = [m for m in manifest if not m.get("file")]
if skipped:
    print("SKIPPED:", json.dumps(skipped, indent=1))
ws.close()
