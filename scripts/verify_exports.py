#!/usr/bin/env python3
"""Exercise every download/export the UI offers, for every state and a
district slice, and check the files are well-formed and consistent.

Two ways to run it:
    # in-process (Flask test client, no server needed)
    python3 scripts/verify_exports.py
    # against a running server (e.g. ./start.sh, or production)
    python3 scripts/verify_exports.py --base http://127.0.0.1:5050

Each request uses the SAME query string the corresponding button builds in
network_analytics.js (proxQuery / levelQuery / typeQuery / gapExportQuery /
ambGapParams), with the UI's default control values. Files are saved under
--out, and a JSON + text report is written next to them.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
import urllib.parse
import urllib.request
import zipfile
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

STATES = ["Haryana", "Himachal Pradesh"]


class Client:
    def __init__(self, base: str | None):
        self.base = base.rstrip("/") if base else None
        if not self.base:
            sys.path.insert(0, os.path.join(ROOT, "dashboard"))
            os.chdir(os.path.join(ROOT, "dashboard"))
            import app as appmod  # noqa: PLC0415

            self.tc = appmod.app.test_client()

    def get(self, path: str):
        """Return (status, headers-dict, body-bytes)."""
        if self.base:
            req = urllib.request.Request(self.base + path, headers={"User-Agent": "verify-exports"})
            try:
                with urllib.request.urlopen(req, timeout=600) as r:
                    return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
            except urllib.error.HTTPError as e:
                return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()
        r = self.tc.get(path)
        return r.status_code, {k.lower(): v for k, v in r.headers.items()}, r.data


def with_state(path: str, st: str) -> str:
    """Mirror window.apiUrl: Haryana adds nothing, other states add ?state=."""
    if st == "Haryana":
        return path
    return path + ("&" if "?" in path else "?") + "state=" + urllib.parse.quote(st)


def parse_csv(raw: bytes):
    text = raw.decode("utf-8-sig", errors="replace")
    rows = list(csv.reader(io.StringIO(text)))
    # Some exports prepend '# comment' provenance lines.
    comments = [r for r in rows if r and r[0].startswith("#")]
    data = [r for r in rows if r and not r[0].startswith("#")]
    if not data:
        return [], [], comments
    hdr, body = data[0], data[1:]
    return hdr, [dict(zip(hdr, r)) for r in body], comments


def summarise_csv(name: str, raw: bytes) -> dict:
    hdr, rows, comments = parse_csv(raw)
    s: dict = {"file": name, "rows": len(rows), "cols": len(hdr), "header": hdr,
               "comment_lines": len(comments)}
    lower = {h.lower(): h for h in hdr}
    for key in ("district", "district_name", "grid_district"):
        if key in lower:
            s["districts"] = dict(Counter(r.get(lower[key], "") for r in rows).most_common())
            break
    for key in ("state", "state_ut", "state_name"):
        if key in lower:
            s["states"] = dict(Counter(r.get(lower[key], "") for r in rows))
    if "grid_id" in lower:
        ids = [r.get(lower["grid_id"]) for r in rows]
        s["grid_ids"] = sorted(set(ids))
        s["dup_grid_ids"] = len(ids) - len(set(ids))
    for key in ("s_no", "hospital_id", "hospital_s_no"):
        if key in lower:
            s["hospital_ids"] = sorted(set(r.get(lower[key]) for r in rows))
            break
    # Columns that are blank on every row (a header with no data behind it).
    s["all_blank_cols"] = [h for h in hdr if rows and all((r.get(h) or "").strip() == "" for r in rows)]
    bad = Counter()
    for r in rows:
        for h in hdr:
            v = (r.get(h) or "").strip().lower()
            if v in ("nan", "none", "null", "undefined", "inf", "-inf"):
                bad[h] += 1
    s["bad_values"] = dict(bad)
    # Distance sanity: any *_km column, numeric range.
    rng = {}
    for h in hdr:
        if h.lower().endswith("_km") or h.lower() in ("road_km", "distance_km"):
            vals = []
            for r in rows:
                try:
                    vals.append(float(r[h]))
                except (TypeError, ValueError, KeyError):
                    pass
            if vals:
                rng[h] = [round(min(vals), 2), round(max(vals), 2), len(vals)]
    s["km_ranges"] = rng
    return s


def summarise(name: str, status: int, headers: dict, raw: bytes) -> dict:
    out = {"status": status, "content_type": headers.get("content-type", ""),
           "disposition": headers.get("content-disposition", ""), "bytes": len(raw)}
    if status != 200:
        out["error"] = raw[:400].decode("utf-8", "replace")
        return out
    if raw[:2] == b"PK":
        z = zipfile.ZipFile(io.BytesIO(raw))
        out["zip_members"] = []
        for n in z.namelist():
            b = z.read(n)
            if n.lower().endswith(".csv"):
                out["zip_members"].append(summarise_csv(n, b))
            else:
                out["zip_members"].append({"file": n, "bytes": len(b),
                                           "text": b[:600].decode("utf-8", "replace") if n.lower().endswith((".txt", ".md", ".json")) else None})
    else:
        out["csv"] = summarise_csv(name, raw)
    return out


def ui_requests(meta: dict, district: str | None, include_ep: bool) -> list[tuple[str, str, str]]:
    """(page, label, path) for every export button, with UI default controls."""
    y = meta.get("year", "2025")
    ep = "1" if include_ep else "0"
    d = {"district": district} if district else {}
    enc = urllib.parse.urlencode

    prox = enc({"year": y, **d, "include_ep": ep})
    lvl = {"year": y, "mode": "complement", "l1": 60, "l2": 30, "l3": 10}
    if include_ep:
        lvl["ep"] = 60
    lvl_q = {**lvl, "include_ep": ep, **d}
    gapexp = {"year": y, "tertiary": 60, "secondary": 30, "primary": 10, **d,
              "l1": 60, "l2": 30, "l3": 10, **({"ep": 60} if include_ep else {}), "include_ep": ep}
    tq = {"year": y, "mode": "complement", **d}
    hg = {"year": y, "per_level": "1", "include_ep": ep, **d}
    amb_new = {"year": y, "threshold_km": 10, **d}
    return [
        ("Proximity", "Grid verdicts CSV", f"/api/analytics/export/proximity-verdicts.csv?{prox}"),
        ("Proximity", "Facilities CSV", f"/api/analytics/export/proximity-facilities.csv?{prox}"),
        ("Proximity", "Bundle ZIP (single)", f"/api/analytics/export/proximity-bundle.zip?{prox}&split_district=0"),
        ("Proximity", "Bundle ZIP (per-district)", f"/api/analytics/export/proximity-bundle.zip?{prox}&split_district=1"),
        ("Proximity", "Hospital->grids CSV", f"/api/analytics/export/hospital-grids.csv?{enc(hg)}"),
        ("Proximity", "Hospital->grids ZIP", f"/api/analytics/export/hospital-grids-bundle.zip?{enc({**hg, 'split': 'district'})}"),
        ("Gaps", "Out-of-reach CSV", f"/api/analytics/export/level-reach.csv?{enc({**lvl_q, 'which': 'out_reach'})}"),
        ("Gaps", "In-reach CSV", f"/api/analytics/export/level-reach.csv?{enc({**lvl_q, 'which': 'in_reach'})}"),
        ("Gaps", "By-type out-of-reach CSV", f"/api/analytics/export/type-reach.csv?{enc({**tq, 'which': 'out_reach'})}"),
        ("Gaps", "District TSS CSV", f"/api/analytics/export/district-tss.csv?year={y}"),
        ("Gaps", "By-district CSV", f"/api/analytics/export/gaps-districts.csv?{enc(lvl_q)}"),
        ("Gaps", "Gaps bundle ZIP", f"/api/analytics/export/gaps-bundle.zip?{enc(gapexp)}"),
        ("Gaps", "Gaps bundle ZIP (per-district)", f"/api/analytics/export/gaps-bundle.zip?{enc({**gapexp, 'split_district': 1})}"),
        ("Ambulance", "Gaps CSV (v2)", f"/api/analytics/export/ambulance-v2-gaps.csv?{enc(amb_new)}"),
        ("Ambulance", "Stations CSV (v2)", f"/api/analytics/export/ambulance-v2-stations.csv?{enc(amb_new)}"),
        ("Ambulance", "Districts CSV (v2)", f"/api/analytics/export/ambulance-v2-districts.csv?{enc(amb_new)}"),
        ("Ambulance", "Bundle ZIP (v2)", f"/api/analytics/export/ambulance-bundle.zip?{enc({**amb_new, 'dataset': 'new'})}"),
        ("Ambulance", "Bundle ZIP (old fleet)", f"/api/analytics/export/ambulance-bundle.zip?{enc({'year': y, 'threshold': 10, 'emergency_only': 0, **d, 'dataset': 'old'})}"),
        ("Ambulance", "Gaps CSV (old fleet)", f"/api/analytics/export/ambulance-gaps.csv?{enc({'year': y, 'threshold': 10, 'emergency_only': 0, **d})}"),
        ("Proximity", "Blood storage (BS) CSV", "/api/analytics/export/bloodbanks.csv"),
    ]


def _rows(r: dict | None) -> int | None:
    if not r or r.get("status") != 200:
        return None
    if r.get("csv"):
        return r["csv"]["rows"]
    return None


def _csv_rows_from(r: dict) -> list:
    return [r["csv"]] if r.get("csv") else [m for m in (r.get("zip_members") or []) if "rows" in m]


def run_checks(c: Client, report: list[dict], context: dict) -> list[dict]:
    """Cross-check every file against the on-screen JSON for the same slice."""
    out: list[dict] = []
    by = {}
    for r in report:
        by[(r["state"], r["district"], r["include_ep"], r["label"])] = r

    def add(scope, check, ok, detail):
        out.append({"scope": scope, "check": check, "ok": bool(ok), "detail": detail})

    for (st, dist, ep) in sorted({(r["state"], r["district"], r["include_ep"]) for r in report}):
        scope = f"{st}/{dist}/ep{int(ep)}"
        ctx = context.get(st, {})
        y = ctx.get("year", "2025")
        allowed = {d.upper() for d in ctx.get("districts", [])}
        dq = {} if dist == "ALL" else {"district": dist}
        enc = urllib.parse.urlencode
        lvl = {"year": y, "mode": "complement", "l1": 60, "l2": 30, "l3": 10,
               **({"ep": 60} if ep else {}), "include_ep": "1" if ep else "0", **dq}
        _, lr = json_get(c, with_state(f"/api/analytics/level-reach?{enc(lvl)}", st))
        _, ov = json_get(c, with_state(f"/api/analytics/proximity/overview?{enc({'year': y, 'include_ep': '1' if ep else '0', **dq})}", st))
        _, hc = json_get(c, with_state(f"/api/analytics/hospital-coverage?{enc({'year': y, 'per_level': '1', 'include_ep': '1' if ep else '0', **dq})}", st))
        g = lambda lab: by.get((st, dist, ep, lab))  # noqa: E731

        if lr:
            o, i = _rows(g("Out-of-reach CSV")), _rows(g("In-reach CSV"))
            ir = g("In-reach CSV")
            add(scope, "out-of-reach CSV rows == on-screen out count", o == lr.get("out_count"),
                f"csv={o} screen={lr.get('out_count')}")
            if lr.get("in_count") == 0:
                add(scope, "in-reach CSV refuses cleanly when 0 in reach", ir and ir["status"] == 404,
                    f"status={ir and ir['status']} msg={(ir or {}).get('error', '')[:80]}")
            else:
                add(scope, "in-reach CSV rows == on-screen in count", i == lr.get("in_count"),
                    f"csv={i} screen={lr.get('in_count')}")
            add(scope, "out + in == total grids", (lr.get("out_count", 0) + lr.get("in_count", 0) + lr.get("unclassified", 0)) == lr.get("total_grids"),
                f"{lr.get('out_count')}+{lr.get('in_count')}+{lr.get('unclassified')} vs {lr.get('total_grids')}")
            gd = g("By-district CSV")
            if gd and gd.get("status") == 200:
                raw = c.get(with_state(f"/api/analytics/export/gaps-districts.csv?{enc(lvl)}", st))[2]
                hdr, rows, _ = parse_csv(raw)
                so = sum(int(float(r.get("out_of_reach_grids") or 0)) for r in rows)
                si = sum(int(float(r.get("in_reach_grids") or 0)) for r in rows)
                add(scope, "gaps-by-district sums == on-screen totals", so == lr.get("out_count") and si == lr.get("in_count"),
                    f"out {so} vs {lr.get('out_count')}, in {si} vs {lr.get('in_count')}")
        if ov:
            v = _rows(g("Grid verdicts CSV"))
            add(scope, "grid verdicts rows == grids on map", v == len(ov.get("grids") or []),
                f"csv={v} map={len(ov.get('grids') or [])}")
        if hc:
            hg = _rows(g("Hospital->grids CSV"))
            add(scope, "hospital->grids rows == on-screen pairs", hg == (hc.get("totals") or {}).get("pairs"),
                f"csv={hg} screen={(hc.get('totals') or {}).get('pairs')}")
            hz = g("Hospital->grids ZIP")
            if hz and hz.get("status") == 200:
                zrows = sum(m["rows"] for m in _csv_rows_from(hz) if not m["file"].startswith("00_"))
                add(scope, "hospital->grids ZIP parts == one-CSV rows", zrows == hg, f"zip={zrows} csv={hg}")
        tss = g("District TSS CSV")
        if tss and tss.get("status") == 200:
            add(scope, "district TSS has one row per district", tss["csv"]["rows"] == len(allowed),
                f"rows={tss['csv']['rows']} districts={len(allowed)}")
        # Leakage: every district value in every file belongs to this state.
        for r in report:
            if (r["state"], r["district"], r["include_ep"]) != (st, dist, ep) or r["status"] != 200:
                continue
            seen = set()
            for part in _csv_rows_from(r):
                seen |= {k.upper() for k in (part.get("districts") or {}) if k}
            stray = sorted(seen - allowed - {"", "ALL", "TOTAL", "(NONE)"})
            add(scope, f"no other-state rows: {r['label']}", not stray, f"stray={stray[:5]}")
        # Haryana-only layers must refuse for other states.
        if st != "Haryana":
            for r in report:
                if (r["state"], r["district"], r["include_ep"]) == (st, dist, ep) and (
                    r["page"] == "Ambulance" or "Blood" in r["label"]
                ):
                    add(scope, f"refused (Haryana-only): {r['label']}", r["status"] == 404,
                        f"status={r['status']} msg={(r.get('error') or '')[:70]}")
    return out


def json_get(c: Client, path: str):
    st, _, b = c.get(path)
    try:
        return st, json.loads(b)
    except Exception:  # noqa: BLE001
        return st, None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", help="http://host:port of a running server; omit for in-process")
    ap.add_argument("--out", default=os.path.join(ROOT, "export_check"))
    ap.add_argument("--haryana-district", default="Ambala")
    ap.add_argument("--save-files", action="store_true", help="keep every downloaded file")
    args = ap.parse_args()

    c = Client(args.base)
    os.makedirs(args.out, exist_ok=True)
    report: list[dict] = []
    context: dict = {}

    for st in STATES:
        s, meta = json_get(c, with_state("/api/analytics/meta", st))
        if s != 200 or not meta:
            print(f"!! meta failed for {st}: {s}")
            continue
        districts = meta.get("districts") or []
        # Reference sets for leakage checks.
        _, prox = json_get(c, with_state(f"/api/analytics/proximity/overview?year={meta['year']}&include_ep=1", st))
        context[st] = {"districts": districts, "grid_count": meta["cache"]["grid_count"],
                       "hospital_count": meta["cache"]["hospital_count"], "year": meta["year"],
                       "prox_overview_keys": list((prox or {}).keys())[:20]}
        scopes = [None]
        if st == "Haryana":
            scopes.append(args.haryana_district if args.haryana_district in districts else districts[0])
        else:
            scopes.append(districts[0])
        for dist in scopes:
            for ep in (True, False):
                for page, label, path in ui_requests(meta, dist, ep):
                    if not ep and page == "Ambulance":
                        continue  # EP toggle does not touch ambulance exports
                    full = with_state(path, st)
                    status, hdrs, raw = c.get(full)
                    name = f"{st}|{dist or 'ALL'}|ep{int(ep)}|{label}"
                    summ = summarise(label, status, hdrs, raw)
                    summ.update({"state": st, "district": dist or "ALL", "include_ep": ep,
                                 "page": page, "label": label, "path": full})
                    report.append(summ)
                    if args.save_files and status == 200:
                        fn = (summ["disposition"].split("filename=")[-1].strip('"') or "export").replace("/", "_")
                        sub = os.path.join(args.out, st.replace(" ", "_"), (dist or "ALL"), f"ep{int(ep)}")
                        os.makedirs(sub, exist_ok=True)
                        open(os.path.join(sub, fn), "wb").write(raw)
                    print(f"{status} {name}  {summ.get('bytes')}B", flush=True)

    checks = run_checks(c, report, context)
    for ch in checks:
        print(("PASS " if ch["ok"] else "FAIL ") + ch["scope"] + " | " + ch["check"] + " | " + ch["detail"])

    # Drop the heavy id lists from the saved report but keep counts.
    for r in report:
        for part in ([r.get("csv")] if r.get("csv") else []) + (r.get("zip_members") or []):
            if part and "grid_ids" in part:
                part["grid_id_count"] = len(part.pop("grid_ids"))
            if part and "hospital_ids" in part:
                part["hospital_id_count"] = len(part.pop("hospital_ids"))
    with open(os.path.join(args.out, "report.json"), "w") as f:
        json.dump({"context": context, "checks": checks, "results": report}, f, indent=1)
    print(f"\nreport -> {os.path.join(args.out, 'report.json')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
