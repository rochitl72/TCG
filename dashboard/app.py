import csv
import io
import json
import os
import zipfile

from flask import (
    Flask,
    Response,
    after_this_request,
    jsonify,
    render_template,
    request,
    send_file,
    url_for,
)
from werkzeug.middleware.proxy_fix import ProxyFix

import ambulance_v2
import dataset_manager
import districts
import grid_ambulance
import network_analytics
import rbg_live
import reach_pipeline
import tpl

app = Flask(__name__, static_folder="static", template_folder="templates")

# Sits behind the nginx "frontend" container / any edge proxy in front of it
# (docker-compose.yml, nginx/nginx.conf) when deployed at tcg.coers.in. Without
# this, url_for(..., _external=True) or request.url would resolve to the
# internal container host/scheme instead of the real public one.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# Never let the browser hold a stale CSS/JS file. Restarting Flask does nothing
# for assets the browser already cached, so an edit to popup_panes.css or
# network_analytics.js would silently not appear until a hard reload — which is
# exactly the kind of thing that eats ten minutes during a demo. Belt: no
# max-age on static. Braces: asset() below stamps each URL with the file's own
# mtime, so the URL itself changes whenever the file does and the cache is
# bypassed by identity rather than by hope.
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


@app.context_processor
def _asset_helper():
    """`asset('css/popup_panes.css')` -> /static/css/popup_panes.css?v=<mtime>.

    Use this in templates instead of url_for('static', ...) for anything edited
    during development. A missing file falls back to an unstamped URL rather
    than raising, so a typo shows up as a 404 in the network tab instead of a
    500 on the page.
    """

    def asset(filename: str) -> str:
        path = os.path.join(app.static_folder, filename)
        try:
            stamp = int(os.path.getmtime(path))
        except OSError:
            return url_for("static", filename=filename)
        return url_for("static", filename=filename, v=stamp)

    return {"asset": asset}


# The accidents feed backs the optional "Accidents" overlay on Tab 1. It is the
# only non-analytics data route the trauma network page still needs.
@app.route("/api/accidents")
def accidents_data():
    path = dataset_manager.get_active_accidents_path()
    if not os.path.exists(path):
        return jsonify({"error": "No accidents dataset found in latest data/.", "features": []}), 404

    features = [
        {
            "accident_id_sp": r["accident_id_sp"],
            "latitude": float(r["latitude_sp"]),
            "longitude": float(r["longitude_sp"]),
            "severity": r["severity"],
            "district_name": r["district_name"],
            # Canonical key so district filters work across the accident CSV,
            # the hospital table and the grid feed, which all spell districts
            # differently. Additive — existing consumers ignore it.
            "district": districts.normalize(r["district_name"]),
            "station_name": r["station_name"],
        }
        for r in dataset_manager.iter_active_accidents()
    ]
    return jsonify({"features": features})


# --------------------------------------------------------------------------
# Trauma network analytics (grid proximity, coverage gaps, ambulance siting)
# --------------------------------------------------------------------------
def _float_arg(name: str, default: float) -> float:
    try:
        return float(request.args.get(name, default))
    except (TypeError, ValueError):
        return default


def _bool_arg(name: str, default: bool = False) -> bool:
    v = request.args.get(name)
    if v is None:
        return default
    return v.lower() in ("1", "true", "yes", "on")


def _csv_fieldnames(rows: list[dict]) -> list[str]:
    """Union of every row's keys, first-seen order.

    DictWriter on rows[0].keys() silently drops any column a later row adds and
    raises on the first row that has one. Both are real here: an export can mix
    rows that carry a nearest-facility block with rows that have none.
    """
    seen: dict[str, None] = {}
    for r in rows:
        for k in r:
            seen.setdefault(k, None)
    return list(seen)


def _csv_text(rows: list[dict]) -> str:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=_csv_fieldnames(rows), extrasaction="ignore")
    writer.writeheader()
    for r in rows:
        writer.writerow(r)
    return buf.getvalue()


def _csv_response(rows: list[dict], filename: str):
    if not rows:
        return jsonify({"error": "Nothing to export for the current selection."}), 404
    return Response(
        _csv_text(rows),
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# Above this many rows a single CSV stops being something you can open. Excel
# copes, but Numbers and Sheets both stall well before the 6,760-grid exports
# this app can produce with every column attached.
CSV_SPLIT_ROWS = 50_000


def _csv_or_zip_response(rows: list[dict], base: str, meta: dict | None = None,
                         split_rows: int = CSV_SPLIT_ROWS):
    """One CSV when it is small, otherwise a ZIP of numbered parts — one click either way.

    The ZIP always carries a `_manifest.csv` naming every part and its row
    count, plus the filters the export was taken under. An export that lands in
    someone's inbox three weeks later has to be able to say what it is a slice
    of; a bare `part_03.csv` cannot.
    """
    if not rows:
        return jsonify({"error": "Nothing to export for the current selection."}), 404
    if len(rows) <= split_rows:
        return _csv_response(rows, f"{base}.csv")

    chunks = [rows[i : i + split_rows] for i in range(0, len(rows), split_rows)]
    manifest = [
        {"file": f"{base}_part{i + 1:02d}.csv", "rows": len(c),
         "first_row": i * split_rows + 1, "last_row": i * split_rows + len(c)}
        for i, c in enumerate(chunks)
    ]
    for k, v in (meta or {}).items():
        manifest.append({"file": f"# {k}", "rows": "", "first_row": v, "last_row": ""})

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("_manifest.csv", _csv_text(manifest))
        for i, c in enumerate(chunks):
            z.writestr(f"{base}_part{i + 1:02d}.csv", _csv_text(c))
    buf.seek(0)
    return Response(
        buf.getvalue(),
        mimetype="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{base}.zip"'},
    )


# --- Ambulance reach bands -------------------------------------------------
# The map paints ambulance gap cells in four colours; these are the same four
# buckets, computed here so the file and the screen cannot disagree. They are
# MULTIPLES of the active threshold, not fixed kilometres, so moving the
# threshold slider rescales the bands instead of silently mislabelling them.
# Mirrors ambBand() / AMB_BAND_LABEL in static/js/network_analytics.js.
AMB_BAND_LABEL = {
    3: "Within reach",
    2: "Just outside - up to 2x the limit",
    1: "2-3x the limit",
    0: "3x+ the limit, or none within 60 km",
}
# File-name-safe slugs for the per-band files inside the ambulance bundle.
AMB_BAND_SLUG = {
    3: "band3_within_reach",
    2: "band2_just_outside_up_to_2x",
    1: "band1_2x_to_3x",
    0: "band0_over_3x_or_none_within_60km",
}


def _amb_band(road_km, threshold_km: float) -> int:
    """3 = inside the limit, 0 = past 3x it (or no vehicle inside the cache).

    A missing distance is band 0 rather than "unknown": the cache holds every
    station within 60 km, so None means nothing was found in 60 km, which is
    the worst bucket, not an absent measurement.
    """
    if road_km is None:
        return 0
    t = threshold_km or 10.0
    if road_km < t:
        return 3
    if road_km < t * 2:
        return 2
    if road_km < t * 3:
        return 1
    return 0


def _amb_with_bands(rows: list[dict], threshold_km: float, km_key: str) -> list[dict]:
    """Stamp band / band_label / band_multiple onto ambulance gap rows."""
    out = []
    t = threshold_km or 10.0
    for r in rows:
        km = r.get(km_key)
        b = _amb_band(km, t)
        out.append({
            **r,
            "band": b,
            "band_label": AMB_BAND_LABEL[b],
            "band_multiple_of_limit": (round(km / t, 2) if km is not None else None),
            "threshold_km": t,
        })
    return out


def _amb_band_parts(rows: list[dict]) -> dict[str, list[dict]]:
    """Split banded rows into one table per band.

    All four keys are always present, even when a band is empty, so the bundle's
    manifest lists it at 0 rows. "No grid is more than 3x out" is a finding, and
    a band silently absent from the manifest would read as a broken export.
    """
    parts: dict[str, list[dict]] = {AMB_BAND_SLUG[b]: [] for b in (0, 1, 2, 3)}
    for r in rows:
        parts[AMB_BAND_SLUG[r["band"]]].append(r)
    return parts


def _amb_band_summary(rows: list[dict], threshold_km: float) -> list[dict]:
    """One line per band: how many grids, how much severity, the km window.

    Band 3 normally reads 0 here because these tables hold the OUT-of-reach
    grids only; it is listed anyway so the four bands on screen and the four
    bands in the file line up one for one.
    """
    t = threshold_km or 10.0
    windows = {
        3: f"0 - {t:g} km",
        2: f"{t:g} - {t * 2:g} km",
        1: f"{t * 2:g} - {t * 3:g} km",
        0: f"{t * 3:g} km+, or nothing within 60 km",
    }
    total = len(rows) or 1
    out = []
    for b in (0, 1, 2, 3):
        sel = [r for r in rows if r["band"] == b]
        out.append({
            "band": b,
            "band_label": AMB_BAND_LABEL[b],
            "distance_window": windows[b],
            "grids": len(sel),
            "pct_of_gap_grids": round(100.0 * len(sel) / total, 1),
            "severity_score_total": round(sum(r.get("severity_score") or 0 for r in sel), 2),
            "no_vehicle_within_60km": sum(
                1 for r in sel
                if r.get("nearest_km") is None and r.get("road_km") is None
            ),
            "threshold_km": t,
        })
    return out


def _district_of(row: dict) -> str | None:
    """The district a row belongs to, or None if the row is not district-scoped.

    Order matters. `hospital_district` wins on the hospital -> grid table
    because that is the district the `district=` filter selects on, so the
    folder names and the filter agree; a row also carries `grid_district` for
    the covered cell, which is frequently a different district and is left as a
    column to filter on rather than a second, contradictory folder scheme.

    None means "do not split this one" — a summary table has no district and
    was landing in an UNKNOWN/ folder that looked like a bug.
    """
    for k in ("hospital_district", "district", "grid_district"):
        v = row.get(k)
        if v:
            return str(v)
    return None


def _bundle_zip_response(parts: dict[str, list[dict]], base: str, meta: dict | None = None,
                         split_by_district: bool = False):
    """Several named CSVs in one ZIP — the "download everything on this tab" button.

    With split_by_district, each table becomes a FOLDER of per-district files
    (`hospital_grids/SONIPAT.csv`) instead of one state-wide file. That is the
    difference between an export you can hand to a district officer and one they
    have to filter down themselves — and for the hospital-grid table it is also
    the difference between files that open and a 250 MB CSV that does not.

    Empty parts are recorded in the manifest with 0 rows rather than dropped, so
    the bundle answers "was there nothing, or did it not run?" — a distinction
    that matters when a filter legitimately empties a panel.
    """
    manifest = []
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, rows in parts.items():
            if not split_by_district:
                manifest.append({"file": f"{name}.csv", "rows": len(rows)})
                if rows:
                    z.writestr(f"{name}.csv", _csv_text(rows))
                continue

            by: dict[str, list[dict]] = {}
            undistricted = []
            for r in rows:
                d = _district_of(r)
                (undistricted if d is None else by.setdefault(d, [])).append(r)

            # A table with no district column stays one file. Splitting it would
            # invent a district it does not have.
            if undistricted and not by:
                manifest.append({"file": f"{name}.csv", "rows": len(undistricted)})
                z.writestr(f"{name}.csv", _csv_text(undistricted))
                continue
            if not by:
                manifest.append({"file": f"{name}/ (empty)", "rows": 0})
                continue
            for dist in sorted(by):
                safe = "".join(c if c.isalnum() or c in " -_" else "_" for c in dist).strip()
                path = f"{name}/{safe or 'UNKNOWN'}.csv"
                manifest.append({"file": path, "rows": len(by[dist])})
                z.writestr(path, _csv_text(by[dist]))

        for k, v in (meta or {}).items():
            manifest.append({"file": f"# {k}", "rows": v})
        z.writestr("_manifest.csv", _csv_text(manifest))
    buf.seek(0)
    return Response(
        buf.getvalue(),
        mimetype="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{base}.zip"'},
    )


# The three views are one page. Each has its own URL so the rail buttons can
# behave like navigation — address bar, back button, bookmarks, a link to /gaps
# in a slide deck — while the client swaps panels in place. Adding a real page
# per view would refetch meta, rebuild every layer and lose the map position on
# each switch, for no benefit the user can see.
TAB_PATHS = {"proximity": "/proximity", "gaps": "/gaps", "ambulance": "/ambulances"}


SIDEBAR_SUBS = ("controls", "charts", "data", "map")


@app.route("/")
@app.route("/network-analytics")
@app.route("/proximity")
@app.route("/gaps")
@app.route("/ambulances")
@app.route("/proximity/<sub>")
@app.route("/gaps/<sub>")
@app.route("/ambulances/<sub>")
def network_analytics_view(sub: str | None = None):
    """The only page this app serves, entered on whichever view the URL names.

    `/` and `/network-analytics` both open Proximity; the three view paths open
    straight onto their own tab, so a deep link lands where it says it will
    instead of on tab 1 with a flash of the wrong panel.
    """
    by_path = {"proximity": "proximity", "gaps": "gaps", "ambulances": "ambulance"}
    head = request.path.strip("/").split("/")[0]
    active_tab = by_path.get(head, "proximity")
    # An unrecognised section falls back to Controls rather than 404-ing: a
    # stale bookmark should still open the view it names.
    active_sub = sub if sub in SIDEBAR_SUBS else "controls"
    # Per-view initial section. Only the view named by the URL honours `sub`;
    # the other two open on Controls. Passed as a dict so the template can mark
    # the right button and panel server-side and a deep link never flashes the
    # wrong section before the JS runs.
    initial_sub = {"proximity": "controls", "gaps": "controls", "ambulance": "controls"}
    initial_sub[active_tab] = active_sub
    return render_template(
        "network_analytics.html",
        active="network",
        active_tab=active_tab,
        active_sub=active_sub,
        initial_sub=initial_sub,
    )


_DISTRICT_SHAPES: dict | None = None


@app.route("/api/districts/boundaries")
def district_boundaries():
    """Haryana district outlines, for highlighting the selected district.

    `data/districts.geojson` is the all-India admin boundary file — 840 features
    and 11 MB, almost none of it ours. Filtering to Haryana leaves 22 features
    and ~200 KB, small enough to send once and hold on the client, so this is
    memoised on first call rather than re-parsed per request.

    Properties are reduced to a single `district` key, normalised through
    districts.normalize() so it matches the values in the district <select>
    (which come from the grid feed) exactly. Without that the highlight would
    silently miss on the districts whose spellings differ between sources —
    which is most of them, see districts.py.
    """
    global _DISTRICT_SHAPES
    if _DISTRICT_SHAPES is None:
        path = os.path.join(DATA_DIR, "districts.geojson")
        if not os.path.exists(path):
            return jsonify({"error": "districts.geojson not found.", "features": []}), 404
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        feats = []
        for f in raw.get("features", []):
            props = f.get("properties") or {}
            if (props.get("STATE_UT") or "").strip().upper() != "HARYANA":
                continue
            name = districts.normalize(props.get("DISTRICT"))
            if not name:
                continue
            feats.append(
                {
                    "type": "Feature",
                    "properties": {"district": name},
                    "geometry": f.get("geometry"),
                }
            )
        feats.sort(key=lambda f: f["properties"]["district"])
        _DISTRICT_SHAPES = {"type": "FeatureCollection", "features": feats}
    return jsonify(_DISTRICT_SHAPES)


@app.route("/api/analytics/meta")
def analytics_meta():
    """Everything the page needs to render its controls and data-quality badges."""
    year = request.args.get("year") or "2025"
    payload = {
        "year": year,
        "tpl": tpl.summary(),
        "defaults": {
            "spec_km": network_analytics.SPEC_KM,
            "distance_km": network_analytics.DEFAULT_KM,
            "time_min": network_analytics.DEFAULT_MIN,
            "ambulance_km": grid_ambulance.DEFAULT_THRESHOLD_KM,
            "level_km": network_analytics.ALL_LEVEL_RADII,
            "type_km": network_analytics.TYPE_RADII,
        },
        # `levels` is what the UI builds its toggles from, so it carries EP.
        # `scoring_levels` is the public triple the 0-3 grid ramp counts, kept
        # separate so the frontend cannot accidentally score a grid out of four.
        "levels": network_analytics.ALL_LEVEL_ORDER,
        "scoring_levels": network_analytics.LEVEL_ORDER,
        "private_level": network_analytics.EP_LEVEL,
        "private_only_color": network_analytics.PRIVATE_ONLY_COLOR,
        "private_only_label": network_analytics.PRIVATE_ONLY_LABEL,
        "level_labels": network_analytics.LEVEL_LABEL,
        "level_notes": network_analytics.LEVEL_NOTE,
        "presets": network_analytics.PRESETS,
        "proximity_radius_km": network_analytics.PROXIMITY_KM,
        "tiers": network_analytics.TIER_ORDER,
        "hosp_types": network_analytics.HOSP_TYPES,
        "type_labels": network_analytics.TYPE_LABEL,
        "type_short": network_analytics.TYPE_SHORT,
    }
    try:
        cache = network_analytics.load_proximity(year)
        payload["cache"] = {
            "available": True,
            "generated_at": cache.get("generated_at"),
            "distance_model": cache.get("distance_model", "osrm_road"),
            "grid_count": len(cache.get("grids", [])),
            "hospital_count": cache.get("hospital_count"),
            "grid_report": cache.get("grid_report"),
        }
        payload["districts"] = sorted({g["district"] for g in cache["grids"]})
        # Shipped with meta so the district dropdown can zoom on the very first
        # change without a second round trip.
        payload["district_bounds"] = network_analytics.district_bounds(year)
    except FileNotFoundError as exc:
        payload["cache"] = {"available": False, "error": str(exc)}
        payload["districts"] = []
        payload["district_bounds"] = {}
    return jsonify(payload)


@app.route("/api/analytics/coverage")
def analytics_coverage():
    """Deliverable 2 — tier coverage gaps + underserved corridors."""
    year = request.args.get("year") or "2025"
    mode = request.args.get("mode") or "distance"
    district = request.args.get("district") or None
    include_private = _bool_arg("private", False)

    # Distance mode defaults to the literal 60 km in the requirement.
    defaults = (
        network_analytics.DEFAULT_MIN if mode == "time" else network_analytics.SPEC_KM
    )
    thresholds = {t: _float_arg(t.lower(), defaults[t]) for t in network_analytics.TIER_ORDER}

    try:
        coverage = network_analytics.evaluate_coverage(
            year=year,
            mode=mode,
            thresholds=thresholds,
            include_private=include_private,
            district=district,
        )
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503

    corridor_tier = request.args.get("corridor_tier") or "Tertiary"
    coverage["corridors"] = network_analytics.find_corridors(
        coverage["grids"], tier=corridor_tier
    )
    coverage["corridor_tier"] = corridor_tier
    # Gap cells too scattered to form a corridor still matter — report them so
    # the UI doesn't imply the corridors account for every gap.
    total_gap = sum(1 for g in coverage["grids"] if g["status"].get(corridor_tier) == "gap")
    in_corridor = sum(c["cells"] for c in coverage["corridors"])
    coverage["corridor_summary"] = {
        "gap_cells": total_gap,
        "in_corridor": in_corridor,
        "isolated": total_gap - in_corridor,
        "min_cells": network_analytics.CORRIDOR_MIN_CELLS,
    }
    coverage["by_district"] = network_analytics.summarise_by_district(coverage)
    return jsonify(coverage)


def _tier_thresholds():
    """Per-tier limits from the query string, defaulting to the uniform 60 km."""
    d = network_analytics.STRICT_GAP_DEFAULT_KM
    return {t: _float_arg(t.lower(), _float_arg("threshold", d)) for t in network_analytics.TIER_ORDER}


@app.route("/api/analytics/tier-gaps")
def analytics_tier_gaps():
    """Deliverable 2, three modes (public facilities only).

    mode=strict       a grid qualifies only if ALL THREE tiers are out of range.
                      Serves both mode A (one limit for every tier) and mode B
                      (a separate limit per tier) — A is just B with all equal.
    mode=independent  mode C: each tier judged on its own, three result sets,
                      each exported separately.
    """
    mode = (request.args.get("mode") or "strict").lower()
    try:
        if mode == "independent":
            payload = network_analytics.independent_tier_gaps(
                year=request.args.get("year") or "2025",
                thresholds=_tier_thresholds(),
                district=request.args.get("district") or None,
            )
            return jsonify(payload)

        payload = network_analytics.strict_tier_gaps(
            year=request.args.get("year") or "2025",
            thresholds=_tier_thresholds(),
            district=request.args.get("district") or None,
        )
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503

    # Corridors among the qualifying grids — the written requirement asks for
    # "Coverage Gaps and Underserved Corridors".
    shaped = [
        {**g, "status": {t: "gap" for t in network_analytics.TIER_ORDER}}
        for g in payload["grids"]
    ]
    payload["corridors"] = network_analytics.find_corridors(shaped, tier="Tertiary")
    return jsonify(payload)


def _prox_verdict_rows(year: str, district: str | None, include_ep: bool = True) -> list[dict]:
    """One row per grid: the four-band reach verdict, flattened for a spreadsheet.

    This is the Proximity tab's own answer — how many of the three conditions
    (L1 <=60 km, L2 <=30 km, L3 <=10 km) a grid satisfies — with the nearest
    facility at each level spread across columns. Nested JSON is what the API
    returns; a CSV has to be flat or it is not usable in the tool people
    actually open it in.

    include_ep=False (the ignore toggle) drops the three EP summary columns
    and the nearest_ep_* columns from every row entirely, rather than leaving
    them present-but-blank — a reader opening this file cold should see AT A
    GLANCE that private capacity was excluded from the run, not have to notice
    a column full of "no"s and wonder whether that is a finding or a filter.
    """
    radii = dict(network_analytics.ALL_LEVEL_RADII)
    idx = network_analytics._verdict_index(year, radii, include_ep=include_ep)
    want = districts.normalize(district) if district else None
    export_levels = (
        network_analytics.ALL_LEVEL_ORDER if include_ep else network_analytics.LEVEL_ORDER
    )

    rows = []
    for rec in idx.values():
        if want and districts.normalize(rec["district"]) != want:
            continue
        row = {
            "grid_id": rec["grid_id"],
            "district": rec["district"],
            "latitude": rec["lat"],
            "longitude": rec["lon"],
            "severity_score_tss": rec["severity_score"],
            "levels_in_reach": rec["n_met"],
            "verdict": rec["verdict"],
            "levels_met": ", ".join(rec["levels_met"]) or "none",
            "levels_missed": ", ".join(rec["levels_missed"]) or "none",
        }
        if include_ep:
            # EP sits OUTSIDE levels_in_reach on purpose — that count is out of
            # three public levels. These three columns say what private
            # capacity is there and whether it is the only thing there.
            row["empanelled_private_in_reach"] = "yes" if rec.get("ep_within") else "no"
            row["empanelled_private_road_km"] = (
                rec.get("ep_km") if rec.get("ep_km") is not None else ""
            )
            row["only_private_in_reach"] = "yes" if rec.get("private_only") else "no"
        row["grid_colour"] = rec.get("color")
        for lv in export_levels:
            n = (rec.get("nearest") or {}).get(lv)
            p = f"nearest_{lv.lower()}"
            row[f"{p}_spec_km"] = radii[lv]
            if not n:
                # No facility of that level inside the 60 km cache. Blank, not
                # zero and not the radius — neither is a measurement.
                row.update({f"{p}_id": "", f"{p}_name": "", f"{p}_type": "",
                            f"{p}_district": "", f"{p}_road_km": "",
                            f"{p}_straight_km": "", f"{p}_tpl": "",
                            f"{p}_within_spec": "no facility in 60 km cache"})
                continue
            row.update({
                f"{p}_id": n.get("s_no"),
                f"{p}_name": n.get("name"),
                f"{p}_type": n.get("type"),
                f"{p}_district": n.get("district"),
                f"{p}_road_km": n.get("road_km"),
                f"{p}_straight_km": n.get("straight_km"),
                f"{p}_tpl": n.get("tpl"),
                f"{p}_within_spec": "yes" if n.get("within") else "no",
            })
        rows.append(row)
    rows.sort(key=lambda r: (r["levels_in_reach"], -r["severity_score_tss"]))
    return rows


@app.route("/api/analytics/export/proximity-verdicts.csv")
def analytics_export_proximity_verdicts():
    year = request.args.get("year") or "2025"
    district = request.args.get("district") or None
    include_ep = _bool_arg("include_ep", True)
    try:
        rows = _prox_verdict_rows(year, district, include_ep=include_ep)
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503
    ep_note = (
        "reported separately as EP <=60km; never counted toward levels_in_reach"
        if include_ep else
        "excluded — the include/ignore-EP toggle was off for this export, so "
        "empanelled private hospitals played no part in any grid's colour or count"
    )
    return _csv_or_zip_response(
        rows, "proximity_grid_verdicts",
        {"year": year, "district": district or "all",
         "rule": "L1<=60km, L2<=30km, L3<=10km by road (public only)",
         "empanelled_private": ep_note},
    )


def _prox_facility_rows(year: str, district: str | None, include_ep: bool = True) -> list[dict]:
    """The Facilities panel, with every column those rows display.

    Shared by the CSV route and the tab bundle so the two can never disagree
    about what a facility export contains.
    """
    rows = []
    for h in network_analytics.load_hospitals():
        # Same canonical comparison as /api/analytics/hospitals — never the raw
        # label, or HISAR and Hissar read as two districts.
        if district and not districts.matches(h["district_name"], district):
            continue
        # The ignore-EP toggle drops empanelled private facilities out of this
        # export entirely — the same population the map stops drawing.
        if not include_ep and h["hosp_type"] == network_analytics.PRIVATE_TYPE:
            continue
        rows.append({
            "s_no": h["s_no"],
            "name": h["hospital_name"],
            "hosp_type": h["hosp_type"],
            "tier": h["tier"],
            # Both the label and the verdict: they differ for 570 of 1,208
            # facilities, and an export that carried only one would be
            # answering a different question from the map.
            "level_labelled": h.get("hosp_level", ""),
            "level_source": h.get("level_source", ""),
            "level_counts_as": network_analytics.counts_at_level(h) or "",
            "district": h["district_norm"],
            "latitude": round(h["latitude"], 6),
            "longitude": round(h["longitude"], 6),
            "tpl": h.get("tpl_total"),
            "tpl_source": h.get("tpl_source"),
            "coord_status": h.get("coord_status", "ok"),
            "coord_note": h.get("coord_note", ""),
        })
    return rows


@app.route("/api/analytics/export/proximity-facilities.csv")
def analytics_export_proximity_facilities():
    year = request.args.get("year") or "2025"
    district = request.args.get("district") or None
    include_ep = _bool_arg("include_ep", True)
    return _csv_or_zip_response(
        _prox_facility_rows(year, district, include_ep=include_ep), "proximity_facilities",
        {"year": year, "district": district or "all",
         "empanelled_private": "included" if include_ep else "excluded (toggle was off)"},
    )


@app.route("/api/analytics/export/proximity-bundle.zip")
def analytics_export_proximity_bundle():
    """Everything on the Proximity tab, under the district filter in force.

    Includes the full hospital -> grid table (every hospital paired with every
    grid inside its radius). Unsplit that is ~1.48 M rows and no spreadsheet
    opens it, which is why split=district is the default here and not on the
    other bundles: for this table the split is what makes it usable at all.
    """
    year = request.args.get("year") or "2025"
    district = request.args.get("district") or None
    split = _bool_arg("split_district", True)
    include_ep = _bool_arg("include_ep", True)
    try:
        verdicts = _prox_verdict_rows(year, district, include_ep=include_ep)
        facilities = _prox_facility_rows(year, district, include_ep=include_ep)
        tss = network_analytics.district_tss(year)["districts"]
        # district_tss() is state-wide by design, but inside a bundle taken
        # under a district filter an all-22-district table contradicts every
        # other file in the ZIP. Narrow it here rather than shipping a file
        # that answers a wider question than its own manifest claims.
        if district:
            tss = [r for r in tss
                   if districts.matches(r.get("district"), district)]
        hosp_grids = list(network_analytics.iter_hospital_grid_rows(
            year=year, district=district, per_level=True, include_ep=include_ep,
        ))
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503

    bands: dict[str, int] = {}
    for r in verdicts:
        bands[r["verdict"]] = bands.get(r["verdict"], 0) + 1
    summary = [{"verdict": k, "grids": v,
                "pct": round(100.0 * v / len(verdicts), 1) if verdicts else 0.0}
               for k, v in sorted(bands.items())]

    return _bundle_zip_response(
        {
            "hospital_to_grid": hosp_grids,
            "grid_verdicts": verdicts,
            "facilities": facilities,
            "district_tss": tss,
            "summary_by_verdict": summary,
        },
        "proximity_tab_export" + ("_by_district" if split else ""),
        {"year": year, "district": district or "all",
         "split_by_district": "yes" if split else "no",
         "hospital_to_grid_rows": str(len(hosp_grids)),
         "rule": "L1<=60km, L2<=30km, L3<=10km by road",
         "empanelled_private": "included" if include_ep else "excluded (toggle was off)"},
        split_by_district=split,
    )





@app.route("/api/analytics/export/gaps-bundle.zip")
def analytics_export_gaps_bundle():
    """Everything on the Gaps tab: each level's uncovered grids, and all three together.

    FOUR SEPARATE QUESTIONS, four files. "Which grids have no L1 in 60 km" is a
    different set from "which grids have no L2 in 30 km", and neither is the set
    that fails all three at once. Reporting only the last one — which is what a
    single "out of reach" file does — hides the two failures that are easiest to
    act on, because a grid missing only its L3 still shows as covered overall.

    Each level is computed by running the same reach test scoped to that level
    alone (level_reach(levels=[lv])), so the per-level files and the combined one
    can never disagree about a boundary.
    """
    year = request.args.get("year") or "2025"
    district = request.args.get("district") or None
    split = _bool_arg("split_district", False)
    include_ep = _bool_arg("include_ep", True)
    radii = _level_radii()

    parts: dict[str, list[dict]] = {}
    try:
        # ALL_LEVEL_ORDER, so ep_not_covered — grids with no empanelled private
        # hospital within 60 km — ships as its own file. It is NOT added into
        # the combined set below, which stays the public-provision question.
        # With the toggle off, EP is not a question this bundle can answer at
        # all, so the file ships EMPTY rather than running an analysis the
        # rest of the export was told to ignore — the manifest still lists it,
        # at 0 rows, so its absence of content is visible rather than silent.
        bundle_levels = network_analytics.ALL_LEVEL_ORDER if include_ep else network_analytics.LEVEL_ORDER
        for lv in bundle_levels:
            payload = network_analytics.level_reach(
                year=year, radii=radii, district=district, levels=[lv],
                include_ep=include_ep,
            )
            parts[f"{lv.lower()}_not_covered"] = network_analytics.level_rows(
                payload, "out_reach"
            )
        if not include_ep:
            parts["ep_not_covered"] = []
        # NAMED FOR WHAT IT IS. The combined rule fails a grid that misses ANY
        # one level, so this set is "missing at least one", not "missing all
        # three" — it is larger than any single level's file, not smaller. A
        # file called all_three_not_covered would be read as the intersection
        # and understate the problem by an order of magnitude.
        allp = network_analytics.level_reach(
            year=year, radii=radii, district=district, include_ep=include_ep
        )
        parts["missing_at_least_one_level"] = network_analytics.level_rows(allp, "out_reach")
        parts["all_three_in_reach"] = network_analytics.level_rows(allp, "in_reach")
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503

    # One row per district per level, so the summary answers "where, and at
    # which level" without needing the big files opened.
    summary = []
    for name, rows in parts.items():
        counts: dict[str, int] = {}
        for r in rows:
            counts[r.get("district", "")] = counts.get(r.get("district", ""), 0) + 1
        for d, n in sorted(counts.items(), key=lambda kv: -kv[1]):
            summary.append({"set": name, "district": d, "grids": n})
    parts["summary_by_district"] = summary

    meta = {"year": year, "district": district or "all",
            "split_by_district": "yes" if split else "no",
            "empanelled_private": "included" if include_ep else
                                   "excluded (toggle was off) — ep_not_covered.csv is empty",
            **{f"radius_{lv}_km": str(radii[lv])
               for lv in network_analytics.ALL_LEVEL_ORDER}}
    return _bundle_zip_response(
        parts, "gaps_tab_export" + ("_by_district" if split else ""),
        meta, split_by_district=split,
    )


@app.route("/api/analytics/export/gaps-districts.csv")
def analytics_export_gaps_districts():
    year = request.args.get("year") or "2025"
    district = request.args.get("district") or None
    try:
        strict = network_analytics.strict_tier_gaps(
            year=year, thresholds=_tier_thresholds(), district=district
        )
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503
    counts: dict[str, int] = {}
    for g in strict.get("grids", []):
        counts[g.get("district", "")] = counts.get(g.get("district", ""), 0) + 1
    rows = [{"district": k, "grids_in_gap": v}
            for k, v in sorted(counts.items(), key=lambda kv: -kv[1])]
    return _csv_or_zip_response(rows, "gaps_by_district",
                                {"year": year, "district": district or "all"})


@app.route("/api/analytics/export/tier-gaps.csv")
def analytics_export_tier_gaps():
    mode = (request.args.get("mode") or "strict").lower()
    th = _tier_thresholds()
    year = request.args.get("year") or "2025"
    district = request.args.get("district") or None

    if mode == "independent":
        tier = request.args.get("tier") or "Tertiary"
        if tier not in network_analytics.TIER_ORDER:
            return jsonify({"error": f"Unknown tier {tier!r}."}), 400
        rows = network_analytics.independent_gap_rows(year, th, district, tier=tier)
        if not rows:
            return jsonify(
                {
                    "error": (
                        f"No grids miss {tier} care at {th[tier]:.0f} km — every grid "
                        f"reaches a {tier.lower()} facility within that distance by road."
                    ),
                    "gap_count": 0,
                }
            ), 404
        return _csv_response(
            rows, f"grids_missing_{tier.lower()}_within_{int(th[tier])}km.csv"
        )

    rows = network_analytics.strict_gap_rows(year, th, district)
    if not rows:
        limits = " / ".join(f"{t[0]}{int(v)}" for t, v in th.items())
        return jsonify(
            {
                "error": (
                    f"No grids qualify at {limits} km — every grid reaches at least one "
                    "public tertiary, secondary or primary hospital within its limit by "
                    "road. Lower the thresholds to find grids that do."
                ),
                "gap_count": 0,
                "thresholds": th,
            }
        ), 404
    tag = (
        f"{int(next(iter(th.values())))}km"
        if len(set(th.values())) == 1
        else f"T{int(th['Tertiary'])}_S{int(th['Secondary'])}_P{int(th['Primary'])}"
    )
    return _csv_response(rows, f"grids_no_public_hospital_{tag}.csv")


@app.route("/api/analytics/export/tier-gaps-bundle.zip")
def analytics_export_tier_gaps_bundle():
    """Mode C's three per-tier CSVs in one download.

    Convenience only, NOT a size workaround. Tab 2 emits one row per grid, so
    any single file is capped at 6,760 rows / ~1.8 MB — 155x under Excel's
    limit. Tab 1 needed splitting because it is a many-to-many join (958,704
    rows); applying the same machinery here would be cargo-culting.
    """
    import io as _io
    import zipfile

    th = _tier_thresholds()
    year = request.args.get("year") or "2025"
    district = request.args.get("district") or None

    buf = _io.BytesIO()
    manifest = []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for tier in network_analytics.TIER_ORDER:
            rows = network_analytics.independent_gap_rows(year, th, district, tier=tier)
            name = f"{tier.lower()}_gaps_within_{int(th[tier])}km.csv"
            sio = _io.StringIO()
            if rows:
                w = csv.DictWriter(sio, fieldnames=list(rows[0].keys()))
                w.writeheader()
                w.writerows(rows)
            else:
                sio.write(
                    f"# No grids miss {tier} care at {th[tier]:.0f} km by road.\n"
                )
            z.writestr(name, sio.getvalue())
            manifest.append({"tier": tier, "threshold_km": th[tier], "rows": len(rows), "file": name})

        idx = _io.StringIO()
        w = csv.DictWriter(idx, fieldnames=["tier", "threshold_km", "rows", "file"])
        w.writeheader()
        w.writerows(manifest)
        z.writestr("00_INDEX.csv", idx.getvalue())
        z.writestr(
            "00_README.txt",
            "GRIDS OUT OF RANGE PER HOSPITAL TIER — HARYANA 2025\n\n"
            "Each tier judged independently against its own road-distance limit\n"
            "(mode C). A grid can appear in more than one file.\n\n"
            + "\n".join(
                f"  {m['tier']:<10} limit {m['threshold_km']:.0f} km -> {m['rows']} grids  ({m['file']})"
                for m in manifest
            )
            + "\n\nPublic facilities only: DCH, CH_SDH, CHC, PHC. The 614 empanelled\n"
            "private hospitals are excluded.\n\n"
            "Distances are real road routes from a self-hosted OSRM server built on\n"
            "an OpenStreetMap extract — not straight-line.\n\n"
            "TPL columns: tpl_source is 'real' (from the supplied dump) or\n"
            "'estimated' (generated from the real per-type distribution). Never\n"
            "present an estimated score as measured.\n",
        )

    buf.seek(0)
    tag = f"T{int(th['Tertiary'])}_S{int(th['Secondary'])}_P{int(th['Primary'])}"
    return Response(
        buf.getvalue(),
        mimetype="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="tier_gaps_{tag}.zip"'
        },
    )


@app.route("/api/analytics/grid/<grid_id>")
def analytics_grid_detail(grid_id: str):
    """Deliverable 1 — every hospital within 60 km of ONE grid cell.

    Served on demand rather than shipped for all 6,785 grids at once: the full
    60 km join is 1,488,851 rows, which is not something to put on the wire.
    """
    year = request.args.get("year") or "2025"
    try:
        cache = network_analytics.load_proximity(year)
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503

    grid = next((g for g in cache["grids"] if str(g["grid_id"]) == str(grid_id)), None)
    if grid is None:
        return jsonify({"error": f"Grid {grid_id} not found for {year}."}), 404

    radius = cache.get("radius_km", network_analytics.PROXIMITY_KM)
    rows, source = None, "live_osrm"

    # Prefer a live lookup: the cache keeps only the nearest few per type, so it
    # under-reports the true "hospitals within 60 km" count this view promises.
    if _bool_arg("live", True):
        try:
            rows = network_analytics.grid_hospitals_live(
                grid, network_analytics.load_hospitals(), radius
            )
        except Exception:  # noqa: BLE001 — fall through to the cache
            rows = None

    if rows is None:
        source = "cache"
        hospitals = cache["hospitals"]
        rows = []
        for c in sorted(grid["candidates"], key=lambda x: x["road_km"]):
            h = hospitals.get(c["s_no"])
            if not h:
                continue
            rows.append(
                {
                    "hospital_id": c["s_no"],
                    "hospital_name": h["hospital_name"],
                    "hosp_type": h["hosp_type"],
                    "tier": h["tier"],
                    # Carried so the popup can group hospitals by service level,
                    # which is the category the brief actually keys on. The
                    # VERDICT level, so empanelled private groups under EP.
                    "hosp_level": network_analytics.counts_at_level(h),
                    "hosp_level_labelled": (h.get("hosp_level") or "").upper(),
                    "district": h["district_name"],
                    "latitude": h["lat"],
                    "longitude": h["lon"],
                    "tpl": h.get("tpl"),
                    "tpl_source": h.get("tpl_source"),
                    "road_km": c["road_km"],
                    "drive_min": c.get("drive_min"),
                }
            )

    return jsonify(
        {
            "grid_id": grid["grid_id"],
            "latitude": grid["lat"],
            "longitude": grid["lon"],
            "district": grid["district"],
            "severity_score": grid["severity_score"],
            "radius_km": radius,
            "source": source,
            "hospitals": rows,
            "count": len(rows),
        }
    )


@app.route("/api/analytics/hospitals")
def analytics_hospitals():
    """Hospital markers for the analytics map, carrying TPL and tier.

    Distinct from /api/geolocations/hospitals, which the older views use and
    which has no TPL attached.
    """
    want = request.args.get("district") or ""
    include_ep = _bool_arg("include_ep", True)
    rows = []
    for h in network_analytics.load_hospitals():
        # Compare on the canonical key, never the raw label — 'HISAR' (private)
        # and 'Hissar' (public) are the same district. See districts.py.
        if want and not districts.matches(h["district_name"], want):
            continue
        # The ignore-EP toggle drops every empanelled private facility off the
        # map entirely, not just the grids it would have covered — "ignore
        # them completely" means the pins go too.
        if not include_ep and h["hosp_type"] == network_analytics.PRIVATE_TYPE:
            continue
        rows.append(
            {
                "s_no": h["s_no"],
                "name": h["hospital_name"],
                "hosp_type": h["hosp_type"],
                "tier": h["tier"],
                # hosp_level is the raw LABEL out of build_tpl; level_source
                # says whether it is spec-derived, from the TPL dump, a name
                # match ("MEDICAL COLLEGE" etc), or merely the private default.
                "hosp_level": h.get("hosp_level", ""),
                "level_source": h.get("level_source", ""),
                # counts_at_level is the VERDICT — the level this facility
                # actually provides for reach analysis, or "" for none. THIS is
                # what the map colour must key on. Keying on hosp_level drew 583
                # facilities in L2 colours while the L2 analysis recognised 22,
                # so a grid could show an "L2" pin 2.65 km away and route 13.41 km
                # the other way for its real L2. Both fields ship: the label is
                # still worth showing in a popup, it just must not carry a tier.
                "counts_at_level": network_analytics.counts_at_level(h),
                "district": h["district_norm"],
                "lat": round(h["latitude"], 6),
                "lon": round(h["longitude"], 6),
                "tpl": h.get("tpl_total"),
                "tpl_source": h.get("tpl_source"),
                # coord_status "unverified" flags a handful of facilities whose
                # GPS is known-wrong upstream (see build_tpl.UNVERIFIED_COORDS)
                # with no authoritative replacement yet — surfaced so the map/
                # popup can warn rather than silently show a bad location.
                "coord_status": h.get("coord_status", "ok"),
                "coord_note": h.get("coord_note", ""),
            }
        )
    counts: dict[str, int] = {}
    by_level: dict[str, int] = {}
    by_level_labelled: dict[str, int] = {}
    for r in rows:
        counts[r["hosp_type"]] = counts.get(r["hosp_type"], 0) + 1
        # by_level counts what actually PROVIDES each level, so the sidebar
        # badges agree with the reach numbers. by_level_labelled keeps the raw
        # label tally alongside it — the gap between the two is the data-quality
        # story (how many private facilities the dump levelled by default), and
        # burying it would just hide the thing worth raising with the team lead.
        v = r["counts_at_level"] or "—"
        by_level[v] = by_level.get(v, 0) + 1
        lab = r["hosp_level"] or "—"
        by_level_labelled[lab] = by_level_labelled.get(lab, 0) + 1
    return jsonify(
        {
            "hospitals": rows,
            "count": len(rows),
            "by_type": counts,
            "by_level": by_level,
            "by_level_labelled": by_level_labelled,
        }
    )


def _level_radii():
    """Per-level road-reach radii from the query string, defaulting to the spec.

    EP is included so ?ep=45 works, but it defaults to its own 60 km rather
    than tracking L1 — the two are separate populations since the 25 Aug split
    and a shared default would quietly re-couple them.
    """
    return {
        lv: _float_arg(lv.lower(), network_analytics.ALL_LEVEL_RADII[lv])
        for lv in network_analytics.ALL_LEVEL_ORDER
    }


def _requested_levels() -> list[str] | None:
    """?levels=L2 -> ["L2"]. Absent or "all" means every PUBLIC level counts.

    "all" deliberately does NOT sweep EP in. The default gap question is about
    state provision; asking for private capacity is an explicit ?levels=EP.
    """
    raw = (request.args.get("levels") or "").strip()
    if not raw or raw.lower() == "all":
        return None
    wanted = {v.strip().upper() for v in raw.split(",") if v.strip()}
    picked = [lv for lv in network_analytics.ALL_LEVEL_ORDER if lv in wanted]
    return picked or None


def _level_payload():
    return network_analytics.level_reach(
        year=request.args.get("year") or "2025",
        radii=_level_radii(),
        district=request.args.get("district") or None,
        mode=request.args.get("mode") or "complement",
        levels=_requested_levels(),
        include_ep=_bool_arg("include_ep", True),
    )


# ==========================================================================
# Proximity tab — the three modes
# ==========================================================================
# Mode 1 "Overall"  -> /api/analytics/proximity/overview
# Mode 2 "Grid"     -> same grid layer, plus /proximity/grid/<id> on click
# Mode 3 "Hospital" -> /proximity/level/<lv>, plus /proximity/hospital/<s_no>
#
# All four read the same verdict index in network_analytics, so the colour a
# grid gets in one mode can never contradict the colour it gets in another.
def _prox_args():
    return {
        "year": request.args.get("year") or "2025",
        "district": request.args.get("district") or None,
        "radii": _level_radii(),
        # The app-wide "include Empanelled Private" toggle. Default True so
        # every existing bookmark/export URL that predates the toggle keeps
        # behaving exactly as it always has.
        "include_ep": _bool_arg("include_ep", True),
    }


@app.route("/api/analytics/proximity/overview")
def analytics_proximity_overview():
    """Mode 1 + the shared grid layer for mode 2."""
    try:
        return jsonify(network_analytics.proximity_overview(**_prox_args()))
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503


@app.route("/api/analytics/proximity/grid/<grid_id>")
def analytics_proximity_grid(grid_id):
    """Mode 2 click — one grid's verdict and its three road-route branches."""
    args = _prox_args()
    try:
        payload = network_analytics.proximity_grid_detail(
            args["year"], grid_id, radii=args["radii"], include_ep=args["include_ep"]
        )
    except KeyError:
        return jsonify({"error": f"grid {grid_id} not found"}), 404
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503
    return jsonify(payload)


@app.route("/api/analytics/proximity/level/<level>")
def analytics_proximity_level(level):
    """Mode 3 — one level in isolation: grids green/red, plus its facilities."""
    args = _prox_args()
    try:
        payload = network_analytics.proximity_level_view(
            year=args["year"],
            level=level,
            district=args["district"],
            radii=args["radii"],
            include_ep=args["include_ep"],
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503
    return jsonify(payload)


@app.route("/api/analytics/proximity/hospital/<s_no>")
def analytics_proximity_hospital(s_no):
    """Mode 3 click — a facility's catchment, with the drawn branches capped."""
    args = _prox_args()
    try:
        limit = int(request.args.get("limit") or network_analytics.HOSPITAL_BRANCH_LIMIT)
    except ValueError:
        return jsonify({"error": "limit must be an integer"}), 400
    try:
        payload = network_analytics.proximity_hospital_detail(
            args["year"],
            s_no,
            level=request.args.get("level") or None,
            limit=limit,
            radii=args["radii"],
            include_ep=args["include_ep"],
        )
    except KeyError:
        return jsonify({"error": f"hospital {s_no} not found"}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503
    return jsonify(payload)


@app.route("/api/analytics/proximity/routes-status")
def analytics_proximity_routes_status():
    """Whether the road-route artifact exists, so the UI can say so up front."""
    import grid_routes

    return jsonify(grid_routes.stats(request.args.get("year") or "2025"))


@app.route("/api/analytics/proximity/route")
def analytics_proximity_route():
    """One grid<->hospital road route for an ARBITRARY pair.

    Modes 2/3 only ever asked precompute_grid_routes.py for "this grid's
    nearest L1/L2/L3 (never EP)" or "this L1/L2/L3 facility's own nearest
    grids (EP-level facilities skipped entirely)" -- so a Nearby tab's
    "top N of any category" list can easily include a pair well outside that
    canonical set, and the precomputed cache alone has no answer for it.

    Checked cache first (grid_routes.route_for, keyed by grid_id + s_no,
    direction-agnostic); on a miss, falls to a LIVE OSRM call using the
    coordinates the frontend already has and sends along as glat/glon/hlat/
    hlon (network_analytics._polyline_for_pair — the same live fallback
    Modes 2/3's own builders use for their guaranteed-uncached pairs, EP
    branches and EP catchments). `polyline: null` only when neither the
    cache nor a live OSRM call could answer, and the UI already knows to
    fall back to a dashed straight line for that.
    """
    grid_id = request.args.get("grid_id")
    s_no = request.args.get("s_no")
    if not grid_id or not s_no:
        return jsonify({"error": "grid_id and s_no are required"}), 400
    year = request.args.get("year") or "2025"

    def _f(name):
        v = request.args.get(name)
        try:
            return float(v) if v is not None else None
        except ValueError:
            return None

    poly = network_analytics._polyline_for_pair(
        year, grid_id, s_no, _f("glat"), _f("glon"), _f("hlat"), _f("hlon")
    )
    return jsonify(
        {
            "grid_id": grid_id,
            "s_no": s_no,
            "polyline": poly,
            "geometry": "osrm" if poly else "straight",
        }
    )


@app.route("/api/analytics/bloodbanks")
def analytics_bloodbanks():
    """Blood storage (BS) centres with GPS — the brief's "GPS of BS"."""
    want = request.args.get("district") or ""
    rows = [
        b
        for b in network_analytics.load_bloodbanks()
        if not want or districts.matches(b["district"], want)
    ]
    by_district: dict[str, int] = {}
    for b in rows:
        by_district[b["district"]] = by_district.get(b["district"], 0) + 1
    return jsonify(
        {
            "bloodbanks": rows,
            "count": len(rows),
            "by_district": by_district,
            # Districts with no blood storage at all are the point of this
            # layer, so name them rather than leaving a silent absence.
            "districts_without": sorted(districts.CANONICAL - set(by_district)),
        }
    )


@app.route("/api/analytics/export/bloodbanks.csv")
def analytics_export_bloodbanks():
    rows = [
        {
            "s_no": b["s_no"],
            "blood_centre_name": b["name"],
            "address": b["address"],
            "district": b["district"],
            "latitude": b["latitude"],
            "longitude": b["longitude"],
        }
        for b in network_analytics.load_bloodbanks()
    ]
    return _csv_response(rows, "blood_storage_centres.csv")


@app.route("/api/analytics/district-tss")
def analytics_district_tss():
    """TSS (Total Severity Score) per district — see network_analytics.district_tss."""
    try:
        return jsonify(network_analytics.district_tss(request.args.get("year") or "2025"))
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503


@app.route("/api/analytics/export/district-tss.csv")
def analytics_export_district_tss():
    payload = network_analytics.district_tss(request.args.get("year") or "2025")
    rows = [
        {
            "rank": d["rank"],
            "district": d["district"],
            "tss": d["tss"],
            "grid_cells": d["grid_cells"],
            "tss_per_cell": d["tss_per_cell"],
            "share_of_state_pct": d["share_pct"],
        }
        for d in payload["districts"]
    ]
    return _csv_response(rows, f"district_tss_{payload['year']}.csv")


@app.route("/api/analytics/level-reach")
def analytics_level_reach():
    """Deliverables A and B in one payload — grids in and out of L1/L2/L3 reach."""
    try:
        payload = _level_payload()
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503
    return jsonify(payload)


@app.route("/api/analytics/export/level-reach.csv")
def analytics_export_level_reach():
    which = request.args.get("which") or "out_reach"
    if which not in {"in_reach", "out_reach"}:
        return jsonify({"error": "which must be in_reach or out_reach"}), 400
    try:
        payload = _level_payload()
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 503

    rows = network_analytics.level_rows(payload, which)
    if not rows:
        return jsonify(
            {
                "error": (
                    f"No grids in this bucket at L1 {payload['radii']['L1']:.0f} km / "
                    f"L2 {payload['radii']['L2']:.0f} km / L3 {payload['radii']['L3']:.0f} km."
                ),
                "count": 0,
            }
        ), 404
    r = payload["radii"]
    name = (
        f"grids_{'in' if which == 'in_reach' else 'out_of'}_reach_"
        f"L1-{r['L1']:.0f}_L2-{r['L2']:.0f}_L3-{r['L3']:.0f}_{payload['mode']}.csv"
    )
    return _csv_response(rows, name)


# --------------------------------------------------------------------------
# Facility-type segmentation (Gaps tab: "analyse each hospital type on its own")
# --------------------------------------------------------------------------
def _type_radii():
    """Per-type road-reach radii from the query string, defaulting to the spec."""
    return {
        t: _float_arg(f"r_{t.lower().replace(' ', '_')}", network_analytics.TYPE_RADII[t])
        for t in network_analytics.HOSP_TYPES
    }


def _requested_types() -> list[str] | None:
    """?types=CHC,PHC -> ["CHC", "PHC"]. Absent or "all" means every type."""
    raw = (request.args.get("types") or "").strip()
    if not raw or raw.lower() == "all":
        return None
    wanted = {t.strip().lower() for t in raw.split(",") if t.strip()}
    picked = [t for t in network_analytics.HOSP_TYPES if t.lower() in wanted]
    return picked or None


def _type_payload():
    return network_analytics.type_reach(
        year=request.args.get("year") or "2025",
        radii=_type_radii(),
        district=request.args.get("district") or None,
        types=_requested_types(),
        mode=request.args.get("mode") or "complement",
    )


@app.route("/api/analytics/type-reach")
def analytics_type_reach():
    """Gap analysis segmented by facility type rather than by service level."""
    try:
        payload = _type_payload()
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503
    return jsonify(payload)


@app.route("/api/analytics/export/type-reach.csv")
def analytics_export_type_reach():
    which = request.args.get("which") or "out_reach"
    if which not in {"in_reach", "out_reach"}:
        return jsonify({"error": "which must be in_reach or out_reach"}), 400
    try:
        payload = _type_payload()
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 503

    rows = network_analytics.type_rows(payload, which)
    if not rows:
        return jsonify({"error": "No grids in this bucket for the current segment.", "count": 0}), 404
    seg = "-".join(t.replace(" ", "_") for t in payload["types"])
    return _csv_response(
        rows, f"grids_{'in' if which == 'in_reach' else 'out_of'}_reach_{seg}_{payload['mode']}.csv"
    )


@app.route("/api/analytics/locate-grid/<grid_id>")
def analytics_locate_grid(grid_id: str):
    """Fast existence check + coordinates, backing the grid-ID search box.

    Returns 404 with a plain message when the ID is unknown so the UI can show
    "Grid id doesn't exist" without having to guess why the request failed.
    """
    year = request.args.get("year") or "2025"
    try:
        hit = network_analytics.locate_grid(grid_id, year)
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503
    if hit is None:
        return jsonify({"error": "Grid id doesn't exist", "grid_id": grid_id, "found": False}), 404
    return jsonify({**hit, "found": True})


@app.route("/api/analytics/district-bounds")
def analytics_district_bounds():
    """Per-district grid bounding boxes, so the UI can zoom without a geometry fetch."""
    year = request.args.get("year") or "2025"
    try:
        return jsonify({"year": year, "bounds": network_analytics.district_bounds(year)})
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503


@app.route("/api/analytics/ambulances")
def analytics_ambulance_positions():
    """Where the 569 real vehicles are parked today, for the map layer.

    Reads through ambulance_optimizer.load_ambulances() rather than the raw
    table on purpose: every row in haryana_ambulance is duplicated exactly
    twice, so the raw table reports 1,138 vehicles that do not exist.
    """
    import ambulance_optimizer as ao

    try:
        fleet = ao.load_ambulances()
    except Exception as exc:  # noqa: BLE001 — surface failures to the UI
        return jsonify({"error": f"Could not load ambulances: {exc}"}), 500

    # GEOGRAPHIC DISTRICT (31 Aug 2026). `district_name` in the source table is
    # wrong for 31 of the 569 vehicles — 19 of them labelled KARNAL sit next to
    # JIND grids, up to 81 km from Karnal. The optimiser has always corrected
    # this (ambulance_optimizer.assign_geographic_districts) because the "stay
    # in your home district" rule is nonsense otherwise, but THIS endpoint —
    # which feeds the map layer and the tab's district filter — did not, so
    # picking JIND hid 19 ambulances that are physically in Jind and picking
    # KARNAL showed 19 that are not.
    #
    # Demand points come from the ambulance reach cache rather than a fresh
    # load_grids() call: it is already memoised, it is the same grid set the
    # gap analysis runs on, and it costs nothing here. If it is missing the
    # rows keep their recorded label rather than failing the request — a
    # slightly wrong district filter beats a dead map layer.
    try:
        cache = grid_ambulance.load_current(request.args.get("year") or "2025")
        demand = [
            {"lat": g["lat"], "lon": g["lon"], "district": g["district"]}
            for g in cache["grids"]
        ]
        ao.assign_geographic_districts(fleet, demand)
    except Exception:  # noqa: BLE001 — see comment above
        for a in fleet:
            a.setdefault("district_recorded", a["district"])

    # assign_geographic_districts' own `relabelled` figure counts SPELLINGS as
    # well as relocations — GURGAON -> GURUGRAM and MEWAT -> NUH are the same
    # place under two names, and 136 of its 136 "relabelled" rows are mostly
    # that. Only a row whose NORMALISED label still disagrees with where it
    # sits is a real fault worth putting in front of a reader, and there are 31
    # of those. Anything else would make the popup shout "recorded as GURGAON"
    # at 31 Gurugram ambulances.
    for a in fleet:
        recorded = districts.normalize(a.get("district_recorded") or a["district"])
        a["district_mislabelled"] = recorded != a["district"]
        a["district_recorded_norm"] = recorded
    relabelled = sum(1 for a in fleet if a["district_mislabelled"])


    district = request.args.get("district") or None
    rows = [
        {
            "s_no": a["s_no"],
            "vehicle_no": a["vehicle_no"],
            "vehicle_type": (a["vehicle_type"] or "").upper(),
            "stationed_at": a["stationed_at"],
            "district": a["district"],
            # Only when it genuinely disagrees — see above. Absent otherwise, so
            # the popup has nothing to show for the 538 rows that are fine.
            **(
                {"district_recorded": a["district_recorded_norm"]}
                if a.get("district_mislabelled")
                else {}
            ),
            "lat": a["lat"],
            "lon": a["lon"],
        }
        for a in fleet
        if not district or districts.matches(a["district"], district)
    ]
    by_type: dict[str, int] = {}
    for r in rows:
        by_type[r["vehicle_type"]] = by_type.get(r["vehicle_type"], 0) + 1
    return jsonify(
        {
            "ambulances": rows,
            "count": len(rows),
            "by_type": by_type,
            "relabelled": relabelled,
        }
    )


def _ambulance_gap_payload():
    """Grids >= threshold km by road from any ambulance spot (deliverable 3).

    Reads the 569 deduplicated vehicles (384 distinct sites) from the
    precomputed cache — this is a gap identifier only, not a repositioning tool.
    """
    year = request.args.get("year") or "2025"
    threshold = _float_arg("threshold", grid_ambulance.DEFAULT_THRESHOLD_KM)
    emergency_only = _bool_arg("emergency_only", False)
    district = request.args.get("district") or None

    cache = grid_ambulance.load_current(year)
    rows = cache["grids"]
    meta = {
        "distance_model": cache.get("distance_model"),
        "generated_at": cache.get("generated_at"),
        "fleet_size": cache.get("fleet_size"),
    }

    payload = grid_ambulance.find_gaps(
        rows, threshold_km=threshold, emergency_only=emergency_only, district=district
    )
    payload["source"] = "current"
    payload["meta"] = meta
    return payload


@app.route("/api/analytics/grid/<grid_id>/ambulances")
def analytics_grid_ambulances(grid_id: str):
    """The vehicles closest to one grid — the Ambulance tab's grid popup."""
    payload = grid_ambulance.nearest_ambulances(
        grid_id,
        year=request.args.get("year") or "2025",
        limit=int(_float_arg("limit", 10)),
        emergency_only=_bool_arg("emergency_only", False),
    )
    if payload is None:
        return jsonify({"error": f"Grid {grid_id} is not in the ambulance cache."}), 404
    return jsonify(payload)


@app.route("/api/analytics/ambulance/<ambulance_id>/grids")
def analytics_ambulance_grids(ambulance_id: str):
    """The grids one vehicle is closest to — the Ambulance tab's vehicle popup."""
    payload = grid_ambulance.nearest_grids(
        ambulance_id,
        year=request.args.get("year") or "2025",
        limit=int(_float_arg("limit", 10)),
    )
    if payload is None:
        return jsonify({"error": f"Ambulance {ambulance_id} covers no cached grid."}), 404
    return jsonify(payload)


@app.route("/api/analytics/hospital-coverage")
def analytics_hospital_coverage():
    """Deliverable 1, hospital-centric: how many grids each hospital serves.

    The requirement lists hospital fields first (1a) then grid fields (1b) —
    i.e. "for each hospital, the grids within 60 km", not "for each grid, the
    nearest hospitals". This reads the untruncated hospital-indexed artifact.
    """
    types = request.args.get("types")
    try:
        payload = network_analytics.hospital_coverage_summary(
            year=request.args.get("year") or "2025",
            district=request.args.get("district") or None,
            types=set(types.split(",")) if types else None,
            # Default ON: the deliverable scopes each hospital to its own
            # level's radius. per_level=0 restores the flat 60 km view.
            per_level=_bool_arg("per_level", True),
            include_ep=_bool_arg("include_ep", True),
        )
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503
    return jsonify(payload)


@app.route("/api/analytics/hospital/<hospital_id>/grids")
def analytics_hospital_grids(hospital_id: str):
    """Every grid within the radius of ONE hospital.

    `limit` caps the ROWS RETURNED, never the count. This used to be passed
    straight through as `max_rows`, which truncates the generator itself — so
    `count` was `len(rows)` of an already-truncated list and a caller asking for
    ten rows was told the hospital reaches ten grids. The popup rendered that
    verbatim as "Reaches 10 grids in total" for every facility in the state.
    Scoped to one hospital the full clipped list is ~2,100 rows at worst, so
    counting it and then slicing is cheap and honest.
    """
    try:
        rows = network_analytics.hospital_grid_rows(
            year=request.args.get("year") or "2025",
            hospital_id=hospital_id,
            per_level=_bool_arg("per_level", True),
            include_ep=_bool_arg("include_ep", True),
        )
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503
    if not rows:
        return jsonify({"error": f"No grids found for hospital {hospital_id}."}), 404

    total = len(rows)
    limit = int(_float_arg("limit", 500))
    grids = rows[:limit] if limit > 0 else rows
    return jsonify(
        {
            "hospital_id": hospital_id,
            "hospital_name": rows[0]["hospital_name"],
            "hospital_level": rows[0].get("hospital_level") or "",
            "level_radius_km": rows[0].get("level_radius_km"),
            # count = every grid this hospital reaches. returned = how many of
            # them are in this response. Never let one stand in for the other.
            "count": total,
            "returned": len(grids),
            "truncated": len(grids) < total,
            "grids": grids,
        }
    )


# --------------------------------------------------------------------------
# Grid accident statistics — the payload the popup's Statistics / Charts tabs
# read. Deliberately shaped like the partner team's `grid_data` response so the
# two apps can be compared field by field.
# --------------------------------------------------------------------------
_GRID_STATS: dict | None = None

# Their four stat cards. We hold real data for exactly one of them: our accident
# feed records a severity CLASS per crash, not casualty counts, and carries no
# vehicle data at all. The other three are returned as null and render as "NA"
# — their own client already does `|| "NA"`, so the shape matches and nobody is
# shown a fabricated number.
GRID_STAT_FIELDS = ("total_crashes", "total_dead", "total_injured", "vehicle_count")


def _build_grid_stats() -> dict:
    """Join every accident to the 1 km cell containing it, once per process.

    Point-in-bbox rather than a real point-in-polygon: the RBG cells are axis
    aligned 0.01° squares, so their bounding box IS the cell. A spatial hash on
    0.02° buckets keeps this at ~0.3 s for 35 k accidents against 6.8 k cells,
    which is why this is computed lazily on first request instead of becoming
    another precompute script somebody has to remember to run.

    Accidents outside the grid's coverage are counted but not attributed —
    that is the same population the partner app calls "outliers".
    """
    from collections import defaultdict, Counter

    # Read the cached grid GeoJSON straight off disk rather than importing
    # rbg_grids: that module pulls in shapely AND the database (it assigns
    # districts on build), and a stats popup must not fall over because the DB
    # is asleep. The cache is what rbg_grids writes anyway.
    path = os.path.join(DATA_DIR, "rbg_grids", "haryana_2025.json")
    with open(path, "r", encoding="utf-8") as fh:
        grids = json.load(fh)["features"]

    HASH = 0.02
    index: dict[tuple[int, int], list] = defaultdict(list)
    for f in grids:
        ring = f["geometry"]["coordinates"][0]
        xs = [c[0] for c in ring]
        ys = [c[1] for c in ring]
        box = (str(f["properties"]["grid_id"]), min(xs), max(xs), min(ys), max(ys))
        for gx in range(int(box[1] / HASH), int(box[2] / HASH) + 1):
            for gy in range(int(box[3] / HASH), int(box[4] / HASH) + 1):
                index[(gx, gy)].append(box)

    per: dict[str, dict] = {}
    matched = unmatched = 0

    for r in dataset_manager.iter_active_accidents():
        try:
            lat = float(r["latitude_sp"])
            lon = float(r["longitude_sp"])
        except (TypeError, ValueError, KeyError):
            unmatched += 1
            continue

        gid = None
        for box in index.get((int(lon / HASH), int(lat / HASH)), ()):
            if box[1] <= lon <= box[2] and box[3] <= lat <= box[4]:
                gid = box[0]
                break
        if gid is None:
            unmatched += 1
            continue

        matched += 1
        cell = per.setdefault(
            gid,
            {"total": 0, "severity": Counter(), "year": Counter(), "station": Counter()},
        )
        cell["total"] += 1
        cell["severity"][r.get("severity") or "Unknown"] += 1
        cell["year"][str(r.get("year") or "—")] += 1
        st = (r.get("station_name") or "").strip()
        if st:
            cell["station"][st] += 1

    return {
        "cells": per,
        "matched": matched,
        "unmatched": unmatched,
        "grid_count": len(grids),
    }


def _grid_stats() -> dict:
    global _GRID_STATS
    if _GRID_STATS is None:
        _GRID_STATS = _build_grid_stats()
    return _GRID_STATS


# Worst-first, so the reader sees the outcome that matters at the top of the
# table rather than having to scan for it.
# These are the labels AFTER dataset_manager.normalize_severity() has run —
# it rewrites "No Injury" to "Non-Injury" and "Minor Injury Non Hospitalized"
# to the hyphenated form. Ordering by the raw CSV spellings would silently
# drop two rows from every table.
_SEVERITY_ORDER = [
    "Fatal",
    "Grievous Injury",
    "Minor Injury Hospitalized",
    "Minor Injury Non-Hospitalized",
    "Non-Injury",
]


@app.route("/api/analytics/grid/<grid_id>/stats")
def analytics_grid_stats(grid_id: str):
    """Accident statistics for ONE cell, in the partner app's `grid_data` shape.

    `year` filters the counts; omit it or pass `all` for every year we hold
    (2023-2025). Their app always passes a year because their filter bar forces
    one; ours defaults to all so the popup is never mysteriously empty.
    """
    year = (request.args.get("year") or "all").strip()
    stats = _grid_stats()
    cell = stats["cells"].get(str(grid_id))

    if not cell:
        # A real answer, not a 404: the cell exists, it simply has no crash in
        # the window. Zero is information; "not found" is not.
        return jsonify(
            {
                "grid_id": grid_id,
                "year": year,
                "total_crashes": 0,
                "total_dead": None,
                "total_injured": None,
                "vehicle_count": None,
                "categories": [],
                "note": "No accidents recorded in this cell.",
            }
        )

    def counted(counter, keys=None, limit=None):
        items = (
            [(k, counter[k]) for k in keys if counter.get(k)]
            if keys
            else sorted(counter.items(), key=lambda kv: -kv[1])
        )
        if limit:
            items = items[:limit]
        return {k: v for k, v in items}

    if year in ("", "all", "All"):
        total = cell["total"]
        severity = cell["severity"]
        stations = cell["station"]
    else:
        # Re-derive from the year counter only. We keep severity per cell, not
        # per (cell, year), so a year filter narrows the total and the year
        # chart but leaves the severity mix as the all-years mix — stated in
        # the category title rather than quietly implied.
        total = cell["year"].get(year, 0)
        severity = cell["severity"]
        stations = cell["station"]

    sev_suffix = "" if year in ("", "all", "All") else " (all years)"
    categories = [
        {
            "title": f"Accidents by severity{sev_suffix}",
            "data": counted(severity, keys=_SEVERITY_ORDER),
        },
        {"title": "Accidents by year", "data": counted(cell["year"])},
    ]
    top_stations = counted(stations, limit=5)
    if top_stations:
        categories.append({"title": "Top reporting police stations", "data": top_stations})

    return jsonify(
        {
            "grid_id": grid_id,
            "year": year,
            "total_crashes": total,
            # Null on purpose — see GRID_STAT_FIELDS.
            "total_dead": None,
            "total_injured": None,
            "vehicle_count": None,
            "categories": categories,
        }
    )


# --------------------------------------------------------------------------
# Live RBG feeds — everything behind the "New" toggle
# --------------------------------------------------------------------------
# Old mode stays entirely offline. That is deliberate: it is the version that
# works with no network, no Docker and no OSRM, which is what you want running
# when the venue wifi dies. Every live call lives here, behind New, and every
# caller falls back to our local answer rather than to a spinner.
@app.route("/api/rbg/health")
def rbg_health():
    """Is the partner API reachable from this machine right now?"""
    return jsonify(rbg_live.health())


@app.route("/api/rbg/<name>", methods=["POST"])
def rbg_proxy(name: str):
    """Proxy one partner endpoint.

    The browser cannot POST cross-origin to rbg.iitm.ac.in — they send no CORS
    header for our origin — so the call has to happen server-side. See
    rbg_live.py for the full reasoning.

    District is accepted as a NAME and translated here, so the client never has
    to know their numeric codes.
    """
    body = request.get_json(silent=True) or {}
    district = body.pop("district_name", None)
    if district is not None:
        body["district"] = rbg_live.district_code(district)
    body.setdefault("state", rbg_live.STATE_CODE)

    # get_layer is the odd one out: it spells the key `dist`, not `district`.
    # Their own file does this one line apart from the others.
    if name == "get_layer":
        body["dist"] = body.pop("district", "")

    result = rbg_live.call(name, body)
    # 200 even on failure: the envelope carries ok/reason, and the client needs
    # to read it to decide whether to fall back. A 502 here would just become an
    # exception the caller has to unwrap anyway.
    return jsonify(result)


@app.route("/api/analytics/uncovered-grids")
def analytics_uncovered_grids():
    """Grids with NO hospital within the radius."""
    try:
        return jsonify(network_analytics.uncovered_grids(request.args.get("year") or "2025"))
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503


@app.route("/api/analytics/export/hospital-grids.csv")
def analytics_export_hospital_grids():
    """Deliverable 1: one row per (hospital, grid within 60 km), hospital-first.

    Ordered hospital by hospital (ascending hospital_id), and within each
    hospital the grids run nearest-first with a grid_rank counter.

    STREAMED, not buffered. Unfiltered this is ~1.48 M rows / ~250 MB; building
    that in memory before responding would spike RAM and make the browser wait
    with no feedback. A generator starts the download immediately and keeps
    memory flat.

    Note it exceeds Excel's 1,048,576-row limit — fine for pandas/R/database
    loads, so we do NOT silently truncate. Pass max_rows to cap it deliberately.
    """
    types = request.args.get("types")
    max_rows = request.args.get("max_rows")
    top = request.args.get("top_per_hospital")

    rows = network_analytics.iter_hospital_grid_rows(
        year=request.args.get("year") or "2025",
        hospital_id=request.args.get("hospital_id") or None,
        district=request.args.get("district") or None,
        types=set(types.split(",")) if types else None,
        max_rows=int(float(max_rows)) if max_rows else None,
        top_per_hospital=int(float(top)) if top else None,
        per_level=_bool_arg("per_level", True),
        include_ep=_bool_arg("include_ep", True),
    )

    fields = network_analytics.HOSPITAL_GRID_FIELDS

    def generate():
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        yield buf.getvalue()
        buf.seek(0)
        buf.truncate(0)

        for i, row in enumerate(rows, start=1):
            writer.writerow(row)
            # Flush every few thousand rows so the client sees steady progress.
            if i % 5000 == 0:
                yield buf.getvalue()
                buf.seek(0)
                buf.truncate(0)
        if buf.tell():
            yield buf.getvalue()

    scope = request.args.get("hospital_id") or request.args.get("district") or "all"
    return Response(
        generate(),
        mimetype="text/csv",
        headers={
            "Content-Disposition": (
                f'attachment; filename="hospital_grid_coverage_60km_{scope}.csv"'
            ),
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/api/analytics/export/hospital-grids-bundle.zip")
def analytics_export_hospital_grids_bundle():
    """Deliverable 1 as a ZIP of laptop-sized CSVs, split by hospital district.

    Built to a temp file, not memory: the CSVs total ~145 MB uncompressed.
    Deleted after the response is sent.
    """
    import tempfile

    types = request.args.get("types")
    top = request.args.get("top_per_hospital")

    fd, tmp_path = tempfile.mkstemp(suffix=".zip")
    os.close(fd)

    @after_this_request
    def _cleanup(response):
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        return response

    try:
        network_analytics.build_hospital_grid_bundle(
            tmp_path,
            year=request.args.get("year") or "2025",
            split_by=request.args.get("split") or "district",
            top_per_hospital=int(float(top)) if top else None,
            district=request.args.get("district") or None,
            types=set(types.split(",")) if types else None,
            per_level=_bool_arg("per_level", True),
            include_ep=_bool_arg("include_ep", True),
        )
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503
    except Exception as exc:  # noqa: BLE001 — surface failures to the UI
        return jsonify({"error": f"Bundle build failed: {exc}"}), 500

    scope = request.args.get("district") or "haryana"
    return send_file(
        tmp_path,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"hospital-grid-proximity-60km-{scope.lower().replace(' ', '_')}.zip",
    )


@app.route("/api/analytics/export/uncovered-grids.csv")
def analytics_export_uncovered_grids():
    payload = network_analytics.uncovered_grids(request.args.get("year") or "2025")
    if not payload["grids"]:
        return jsonify(
            {
                "error": (
                    f"No uncovered grids — all {payload['total_grids']} grids have at "
                    f"least one hospital within {payload['radius_km']:.0f} km by road."
                ),
                "uncovered": 0,
                "total_grids": payload["total_grids"],
            }
        ), 404
    return _csv_response(payload["grids"], "grids_with_no_hospital_in_60km.csv")


@app.route("/api/analytics/ambulance-gaps")
def analytics_ambulance_gaps():
    try:
        payload = _ambulance_gap_payload()
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503
    except Exception as exc:  # noqa: BLE001 — surface failures to the UI
        return jsonify({"error": f"Ambulance gap scan failed: {exc}"}), 500
    # The map needs every gap; trim nothing, but the list is only ~500-1000 rows.
    return jsonify(payload)


def _amb_v2_args():
    """Shared parsing for the v2 ambulance routes.

    Day and period arrive repeatable (?day=Sat&day=Sun) so the UI can offer
    multi-select later without a second URL shape. Empty means "all", which is
    the default the sidebar opens on — see ambulance_v2 for why a single
    day+period slice is a thin sample rather than a coverage collapse.
    """
    return {
        "year": request.args.get("year") or "2025",
        "threshold_km": _float_arg("threshold_km", grid_ambulance.DEFAULT_THRESHOLD_KM),
        "days": request.args.getlist("day") or None,
        "periods": request.args.getlist("period") or None,
        "district": request.args.get("district") or None,
    }


@app.route("/api/analytics/ambulance-v2/gaps")
def analytics_ambulance_v2_gaps():
    try:
        return jsonify(ambulance_v2.find_gaps(**_amb_v2_args()))
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503
    except Exception as exc:  # noqa: BLE001 — surface failures to the UI
        return jsonify({"error": f"v2 ambulance gap scan failed: {exc}"}), 500


@app.route("/api/analytics/ambulance-v2/stations")
def analytics_ambulance_v2_stations():
    a = _amb_v2_args()
    try:
        rows = ambulance_v2.stations(a["year"], a["days"], a["periods"], a["district"])
        meta = ambulance_v2.load(a["year"])
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "needs_precompute": True}), 503
    return jsonify({
        "count": len(rows),
        "total": meta["station_count"],
        "days": meta["days"],
        "periods": meta["periods"],
        "districts": meta["districts"],
        "slot_counts": meta["slot_counts"],
        "stations": rows,
    })


def _stamp(rows: list[dict], meta: dict) -> list[dict]:
    """Add filter provenance to each row WITHOUT overwriting the row's own data.

    `{**row, **meta}` looked harmless and was not: meta carries `district` —
    the district FILTER, "all" when unset — and it silently replaced each
    grid's actual district. Every row of ambulance_v2_gaps.csv shipped
    district="all", so the file could not be filtered or grouped by district
    at all, and the per-district split had nothing to split on. A meta key that
    collides is prefixed `filter_` instead of winning.
    """
    out = []
    for r in rows:
        extra = {(f"filter_{k}" if k in r else k): v for k, v in meta.items()}
        out.append({**r, **extra})
    return out


def _amb_v2_meta(p: dict) -> dict:
    """Filter provenance stamped into every v2 export."""
    return {
        "dataset": "v2 (partner filtered workbook)",
        "year": p["year"],
        "distance_mode": p["mode"],
        "threshold_km": p["threshold_km"],
        "days": ", ".join(p["days"]) or "all",
        "periods": ", ".join(p["periods"]) or "all",
        "district": p["district"] or "all",
        "stations_in_filter": p["station_count"],
        "stations_total": p["station_total"],
        "thin_slice_warning": (
            f"yes - only {p['station_count']} stations match this filter; "
            "the gap count reflects sample size, not a coverage collapse"
        ) if p["thin_slice"] else "no",
    }


@app.route("/api/analytics/export/ambulance-v2-gaps.csv")
def analytics_export_ambulance_v2_gaps():
    try:
        p = ambulance_v2.find_gaps(**_amb_v2_args())
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 503
    meta = _amb_v2_meta(p)
    banded = _amb_with_bands(p["gaps"], p["threshold_km"], "nearest_km")
    rows = _stamp(banded, meta)
    return _csv_or_zip_response(rows, "ambulance_v2_gaps", meta)


@app.route("/api/analytics/export/ambulance-v2-stations.csv")
def analytics_export_ambulance_v2_stations():
    a = _amb_v2_args()
    try:
        rows = ambulance_v2.stations(a["year"], a["days"], a["periods"], a["district"])
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 503
    meta = {
        "dataset": "v2 (partner filtered workbook)",
        "days": ", ".join(a["days"] or []) or "all",
        "periods": ", ".join(a["periods"] or []) or "all",
        "district": a["district"] or "all",
    }
    return _csv_or_zip_response(_stamp(rows, meta), "ambulance_v2_stations", meta)


@app.route("/api/analytics/export/ambulance-v2-districts.csv")
def analytics_export_ambulance_v2_districts():
    try:
        p = ambulance_v2.find_gaps(**_amb_v2_args())
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 503
    meta = _amb_v2_meta(p)
    rows = []
    for d in p["by_district"]:
        total = d["gaps"] + d["covered"]
        rows.append({
            **d,
            "grids_total": total,
            "pct_gap": round(100.0 * d["gaps"] / total, 1) if total else 0.0,
        })
    return _csv_or_zip_response(_stamp(rows, meta), "ambulance_v2_by_district", meta)


@app.route("/api/analytics/export/ambulance-bundle.zip")
def analytics_export_ambulance_bundle():
    """Everything on the Ambulance tab, for whichever dataset is active."""
    dataset = (request.args.get("dataset") or "old").lower()
    split = _bool_arg("split_district", False)
    if dataset == "new":
        a = _amb_v2_args()
        try:
            p = ambulance_v2.find_gaps(**a)
            st = ambulance_v2.stations(a["year"], a["days"], a["periods"], a["district"])
        except FileNotFoundError as exc:
            return jsonify({"error": str(exc)}), 503
        meta = _amb_v2_meta(p)
        by_district = []
        for d in p["by_district"]:
            tot = d["gaps"] + d["covered"]
            by_district.append({**d, "grids_total": tot,
                                "pct_gap": round(100.0 * d["gaps"] / tot, 1) if tot else 0.0})
        banded = _amb_with_bands(p["gaps"], p["threshold_km"], "nearest_km")
        return _bundle_zip_response(
            {
                "out_of_reach_grids": banded,
                **_amb_band_parts(banded),
                "band_summary": _amb_band_summary(banded, p["threshold_km"]),
                "stations": st,
                "by_district": by_district,
                "summary": [{
                    "grids_total": p["grids_total"], "grids_covered": p["grids_covered"],
                    "grids_gap": p["grids_gap"], "pct_gap": p["pct_gap"],
                    "severity_in_gap": p["severity_in_gap"],
                    "pct_severity_in_gap": p["pct_severity_in_gap"], **meta,
                }],
            },
            "ambulance_new_tab_export" + ("_by_district" if split else ""),
            {**{k: str(v) for k, v in meta.items()},
             "split_by_district": "yes" if split else "no"},
            split_by_district=split,
        )

    try:
        payload = _ambulance_gap_payload()
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 503
    meta = {
        "dataset": "old (current fleet)",
        "threshold_km": str(payload["threshold_km"]),
        "position_source": str(payload["source"]),
        "district": request.args.get("district") or "all",
    }
    banded = _amb_with_bands(payload["gaps"], payload["threshold_km"], "road_km")
    return _bundle_zip_response(
        {
            "out_of_reach_grids": banded,
            **_amb_band_parts(banded),
            "band_summary": _amb_band_summary(banded, payload["threshold_km"]),
            "summary": [{k: v for k, v in payload.items() if not isinstance(v, (list, dict))}],
        },
        "ambulance_old_tab_export" + ("_by_district" if split else ""),
        {**meta, "split_by_district": "yes" if split else "no"},
        split_by_district=split,
    )


@app.route("/api/analytics/export/ambulance-gaps.csv")
def analytics_export_ambulance_gaps():
    try:
        payload = _ambulance_gap_payload()
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 503
    rows = _amb_with_bands(payload["gaps"], payload["threshold_km"], "road_km")
    for r in rows:
        r["position_source"] = payload["source"]
    return _csv_response(rows, f"ambulance_gaps_{payload['source']}_{int(payload['threshold_km'])}km.csv")


@app.route("/api/analytics/export/proximity.csv")
def analytics_export_proximity():
    rows = network_analytics.grid_hospital_rows(
        year=request.args.get("year") or "2025",
        district=request.args.get("district") or None,
        top_n=int(_float_arg("top_n", network_analytics.EXPORT_TOP_N)),
        include_private=_bool_arg("private", True),
    )
    return _csv_response(rows, "grid_hospital_proximity_60km.csv")


@app.route("/api/analytics/export/gaps.csv")
def analytics_export_gaps():
    year = request.args.get("year") or "2025"
    mode = request.args.get("mode") or "distance"
    # Distance mode defaults to the literal 60 km in the requirement.
    defaults = (
        network_analytics.DEFAULT_MIN if mode == "time" else network_analytics.SPEC_KM
    )
    thresholds = {t: _float_arg(t.lower(), defaults[t]) for t in network_analytics.TIER_ORDER}
    coverage = network_analytics.evaluate_coverage(
        year=year,
        mode=mode,
        thresholds=thresholds,
        include_private=_bool_arg("private", False),
        district=request.args.get("district") or None,
    )
    rows = []
    for g in coverage["grids"]:
        if not any(v == "gap" for v in g["status"].values()):
            continue
        row = {
            "grid_id": g["grid_id"],
            "latitude": g["lat"],
            "longitude": g["lon"],
            "district": g["district"],
            "severity_score": g["severity_score"],
        }
        for t in network_analytics.TIER_ORDER:
            n = g["nearest"].get(t) or {}
            row[f"{t.lower()}_status"] = g["status"][t]
            row[f"{t.lower()}_nearest_hospital"] = n.get("name")
            row[f"{t.lower()}_road_km"] = n.get("road_km")
            row[f"{t.lower()}_drive_min"] = n.get("drive_min")
        rows.append(row)
    return _csv_response(rows, f"coverage_gaps_{mode}.csv")


@app.route("/api/analytics/level-sensitivity")
def analytics_level_sensitivity():
    """Gap count vs radius, per level — backs the Tab 2 sensitivity curve.

    Recomputed per district rather than cached: it is a sorted-array count over
    distances that are already in memory, so it costs far less than the round
    trip to build and invalidate another artifact.
    """
    try:
        payload = network_analytics.level_sensitivity(
            year=request.args.get("year") or "2025",
            district=request.args.get("district") or None,
            max_km=_float_arg("max_km", 80.0),
            step_km=_float_arg("step_km", 2.0),
        )
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 500
    return jsonify(payload)


# Backs the ruler tool in the shared measure panel (_measure_panel.html), which
# the analytics page still includes.
@app.route("/api/measure/route")
def measure_route():
    try:
        lat1 = float(request.args["lat1"])
        lon1 = float(request.args["lon1"])
        lat2 = float(request.args["lat2"])
        lon2 = float(request.args["lon2"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "lat1, lon1, lat2, lon2 are required as numbers"}), 400
    return jsonify(reach_pipeline.measure_route(lat1, lon1, lat2, lon2))


if __name__ == "__main__":
    # This block only runs the Flask dev server, used for local development
    # (start.sh). The production container (docker-compose.yml) runs gunicorn
    # instead — see dashboard/Dockerfile — which never executes this block,
    # so FLASK_DEBUG here has no effect on the deployed site.
    port = int(os.environ.get("PORT", 5050))
    debug = os.environ.get("FLASK_DEBUG", "1") == "1"
    app.run(debug=debug, port=port, host="0.0.0.0", threaded=True)
