#!/usr/bin/env python3
"""Precompute road distance + drive time from every 2025 grid cell to every
hospital within 60 km. This is the expensive step behind all three analytics
deliverables; everything else reads its output and stays interactive.

OUTPUT
    data/analytics/grid_hospital_<year>.json

PERFORMANCE
OSRM's /table service caps the number of coordinates per request via
`--max-table-size` (default 100). With the default we would need ~15,000
requests. Raise it and we can put ALL 1,208 hospitals in one request as
destinations and batch grid centroids as sources, cutting it to ~230 requests:

    # docker-compose.yml, osrm service:
    command: osrm-routed --algorithm mld --max-table-size 8000 /data/haryana.osrm

The script auto-detects the server's limit and falls back to smaller batches if
the flag hasn't been added, so it works either way — just slower.

USAGE
    OSRM_BASE=http://127.0.0.1:5000 \
    DATABASE_URL=postgresql://mapsr:mapsr@localhost:5433/mapsr \
        python3 scripts/precompute_network_analytics.py --year 2025
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "dashboard"))

import network_analytics as na  # noqa: E402

OSRM_BASE = os.environ.get("OSRM_BASE", "http://127.0.0.1:5000").rstrip("/")
REQUEST_TIMEOUT = 180


def osrm_table(sources: list[dict], dests: list[dict]) -> tuple[list, list] | None:
    """One /table call. Returns (distances_m, durations_s) matrices."""
    coords = ";".join(
        [f"{s['lon']:.6f},{s['lat']:.6f}" for s in sources]
        + [f"{d['longitude']:.6f},{d['latitude']:.6f}" for d in dests]
    )
    ns, nd = len(sources), len(dests)
    src_idx = ";".join(str(i) for i in range(ns))
    dst_idx = ";".join(str(ns + i) for i in range(nd))
    url = (
        f"{OSRM_BASE}/table/v1/driving/{coords}"
        f"?sources={src_idx}&destinations={dst_idx}&annotations=distance,duration"
    )
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", "replace")[:200]
        except Exception:
            pass
        if exc.code == 400 and "TooBig" in body:
            return None  # caller shrinks the batch
        raise RuntimeError(f"OSRM HTTP {exc.code}: {body}") from exc
    if data.get("code") != "Ok":
        raise RuntimeError(f"OSRM error: {data.get('code')} {data.get('message')}")
    return data.get("distances"), data.get("durations")


def preflight() -> None:
    """Fail fast with guidance if OSRM isn't reachable. See grid_ambulance.preflight."""
    import grid_ambulance  # noqa: PLC0415 — only needed on the OSRM path

    grid_ambulance.OSRM_BASE = OSRM_BASE
    grid_ambulance.preflight()


def probe_batch_size(grids: list[dict], hospitals: list[dict]) -> int:
    """Find the largest source-batch the server will accept."""
    for size in (60, 30, 12, 4, 1):
        try:
            if osrm_table(grids[:size], hospitals) is not None:
                print(f"    OSRM accepts {size} grids x {len(hospitals)} hospitals per request")
                return size
        except RuntimeError as exc:
            print(f"    probe {size}: {exc}")
    raise SystemExit(
        "OSRM rejected even a 1 x N table request. Raise --max-table-size on the\n"
        "osrm service (see the docstring at the top of this file) and retry."
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", default="2025")
    ap.add_argument("--radius-km", type=float, default=na.PROXIMITY_KM)
    ap.add_argument("--keep-per-type", type=int, default=na.KEEP_PER_TYPE)
    ap.add_argument(
        "--offline",
        action="store_true",
        help="Use straight-line distance instead of OSRM. For smoke-testing the "
        "pipeline before the routing server is up. The artifact is stamped "
        "distance_model=straight_line_offline and the UI shows a warning "
        "banner — never present offline output as road-route analysis.",
    )
    args = ap.parse_args()

    if args.offline:
        print("==> OFFLINE MODE — straight-line distances, NOT road routes")
    else:
        print(f"==> OSRM: {OSRM_BASE}")
    grids, report = na.load_grids(args.year)
    print(
        f"==> Grids {args.year}: {report['kept']} kept, "
        f"{report['dropped_blank_district']} blank-district dropped, "
        f"{report['dropped_outside_haryana']} outside-Haryana dropped"
    )
    hospitals = na.load_hospitals()
    print(f"==> Hospitals: {len(hospitals)}")
    if not grids or not hospitals:
        raise SystemExit("Nothing to compute — check the database and RBG grid cache.")

    if args.offline:
        batch = 200
    else:
        import grid_ambulance  # noqa: PLC0415

        try:
            preflight()
        except grid_ambulance.OSRMUnavailable as exc:
            print(f"\n!! {exc}", file=sys.stderr)
            return 2
        batch = probe_batch_size(grids, hospitals)

    # Offline stand-in: straight-line km, and a nominal 40 km/h to give the
    # drive-time fields something plausible. Clearly not routing.
    def offline_table(chunk: list[dict]) -> tuple[list, list]:
        dist, dur = [], []
        for g in chunk:
            row = [
                na.haversine_km(g["lat"], g["lon"], h["latitude"], h["longitude"]) * 1000.0
                for h in hospitals
            ]
            dist.append(row)
            dur.append([m / 1000.0 / 40.0 * 3600.0 for m in row])
        return dist, dur

    out_grids = []
    # HOSPITAL-CENTRIC accumulator. The requirement lists hospital fields first
    # (1a) then grid fields (1b): "for each hospital, the grids it serves within
    # 60 km". The grid-centric artifact cannot answer that — it keeps only the
    # nearest N per type PER GRID, so a hospital that is never in anyone's top-N
    # vanishes entirely (5 of 1,208 did). Here we keep EVERY pair within the
    # radius, indexed by hospital, stored as [grid_index, road_km] against a
    # shared grid table to keep the file compact.
    hospital_grids: dict[str, list] = defaultdict(list)

    t0 = time.time()
    for start in range(0, len(grids), batch):
        chunk = grids[start : start + batch]
        if args.offline:
            distances, durations = offline_table(chunk)
        else:
            result = osrm_table(chunk, hospitals)
            if result is None:
                raise SystemExit("OSRM rejected a batch it previously accepted.")
            distances, durations = result

        for row_i, g in enumerate(chunk):
            grid_index = start + row_i
            drow = distances[row_i] if distances else []
            trow = durations[row_i] if durations else []
            per_type: dict[str, list[dict]] = defaultdict(list)
            for col, h in enumerate(hospitals):
                d_m = drow[col] if col < len(drow) else None
                if d_m is None:
                    continue
                km = d_m / 1000.0
                if km > args.radius_km:
                    continue
                secs = trow[col] if col < len(trow) else None
                # Every qualifying pair, untruncated, for the hospital-centric view.
                hospital_grids[h["s_no"]].append([grid_index, round(km, 2)])
                per_type[h["hosp_type"]].append(
                    {
                        "s_no": h["s_no"],
                        "road_km": round(km, 2),
                        "drive_min": round(secs / 60.0, 1) if secs is not None else None,
                    }
                )

            candidates = []
            for lst in per_type.values():
                lst.sort(key=lambda c: c["road_km"])
                candidates.extend(lst[: args.keep_per_type])
            candidates.sort(key=lambda c: c["road_km"])

            out_grids.append(
                {
                    "grid_id": g["grid_id"],
                    "lat": round(g["lat"], 6),
                    "lon": round(g["lon"], 6),
                    "district": g["district"],
                    "severity_score": g["severity_score"],
                    "candidates": candidates,
                }
            )

        done = min(start + batch, len(grids))
        if done % (batch * 10) < batch or done == len(grids):
            rate = done / max(time.time() - t0, 0.001)
            eta = (len(grids) - done) / max(rate, 0.001)
            print(f"    {done}/{len(grids)} grids  ({rate:.0f}/s, eta {eta:.0f}s)", flush=True)

    hosp_index = {
        h["s_no"]: {
            "hospital_name": h["hospital_name"],
            "district_name": h["district_name"],
            "hosp_type": h["hosp_type"],
            "tier": h["tier"],
            "is_private": h["is_private"],
            "lat": round(h["latitude"], 6),
            "lon": round(h["longitude"], 6),
            "tpl": h.get("tpl_total"),
            "tpl_source": h.get("tpl_source"),
        }
        for h in hospitals
    }

    payload = {
        "schema": "v1",
        "year": args.year,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "radius_km": args.radius_km,
        "keep_per_type": args.keep_per_type,
        "distance_model": "straight_line_offline" if args.offline else "osrm_road",
        "osrm_base": None if args.offline else OSRM_BASE,
        "grid_report": report,
        "hospital_count": len(hospitals),
        "hospitals": hosp_index,
        "grids": out_grids,
    }

    os.makedirs(na.ANALYTICS_DIR, exist_ok=True)
    path = na.artifact_path(args.year)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.replace(tmp, path)

    pairs = sum(len(g["candidates"]) for g in out_grids)
    size_mb = os.path.getsize(path) / 1e6
    print(f"\n==> Wrote {path}  ({size_mb:.1f} MB)")
    print(f"    {len(out_grids)} grids, {pairs} retained grid-hospital pairs")

    # ---- hospital-centric artifact (deliverable 1) ------------------------
    for lst in hospital_grids.values():
        lst.sort(key=lambda x: x[1])

    covered = set()
    for lst in hospital_grids.values():
        for gi, _ in lst:
            covered.add(gi)
    uncovered = [i for i in range(len(out_grids)) if i not in covered]

    hg_payload = {
        "schema": "v1",
        "year": args.year,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "radius_km": args.radius_km,
        "distance_model": "straight_line_offline" if args.offline else "osrm_road",
        # Shared index: hospital_grids entries reference these by position.
        "grid_index": [
            {
                "grid_id": g["grid_id"],
                "lat": g["lat"],
                "lon": g["lon"],
                "district": g["district"],
                "severity_score": g["severity_score"],
            }
            for g in out_grids
        ],
        "hospitals": hosp_index,
        "hospital_grids": {k: v for k, v in hospital_grids.items()},
        "uncovered_grid_indexes": uncovered,
        "totals": {
            "hospitals": len(hospitals),
            "hospitals_serving_at_least_one_grid": len(hospital_grids),
            "grids": len(out_grids),
            "pairs": sum(len(v) for v in hospital_grids.values()),
            "uncovered_grids": len(uncovered),
        },
    }
    hg_path = os.path.join(na.ANALYTICS_DIR, f"hospital_grid_{args.year}.json")
    tmp = hg_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(hg_payload, f)
    os.replace(tmp, hg_path)

    t = hg_payload["totals"]
    print(f"\n==> Wrote {hg_path}  ({os.path.getsize(hg_path) / 1e6:.1f} MB)")
    print(f"    {t['pairs']:,} hospital-grid pairs within {args.radius_km:.0f} km")
    print(
        f"    {t['hospitals_serving_at_least_one_grid']} of {t['hospitals']} hospitals "
        f"serve at least one grid"
    )
    print(
        f"    {t['uncovered_grids']} of {t['grids']} grids have NO hospital "
        f"within {args.radius_km:.0f} km"
    )
    print(f"\n    elapsed {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
