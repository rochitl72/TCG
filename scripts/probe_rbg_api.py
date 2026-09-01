#!/usr/bin/env python3
"""Call every partner RBG endpoint and report exactly what comes back.

Run this on a machine that can reach rbg.iitm.ac.in. It needs nothing but the
Python standard library — no Flask, no venv, no packages.

    python3 scripts/probe_rbg_api.py

It prints a readable summary and writes the full responses to
`data/rbg_probe/` so the shapes can be inspected properly afterwards.

WHY THIS EXISTS. Everything wired behind the New toggle so far was built against
a stub, because the sandbox this was written in cannot POST to their host. The
field names in `fpGridStatsLive()` and `FP_PARTNER_HOSPITAL_FIELDS` are taken
from THEIR source, not from a real response — so they are educated guesses until
this script says otherwise.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_DIR = os.path.join(ROOT, "data", "rbg_probe")

STATE = "13"          # Haryana
DISTRICT = "257"      # Jhajjar — small, so payloads stay readable
YEAR = "2025"
GRID_ID = "716773"    # our busiest cell: 59 crashes

CALLS = [
    ("grid_data",     "https://rbg.iitm.ac.in/one_pager/grid_data",
     {"grid_id": GRID_ID, "year": YEAR}),
    ("hosp_gps",      "https://rbg.iitm.ac.in/bs_ddhi/get_hosp_gps",
     {"state": STATE, "district": DISTRICT}),
    ("acc_loc_data",  "https://rbg.iitm.ac.in/one_pager/acc_loc_data",
     {"state": STATE, "district": DISTRICT, "year": YEAR}),
    ("acc_grid_data", "https://rbg.iitm.ac.in/one_pager/acc_grid_data",
     {"state": STATE, "district": DISTRICT, "year": YEAR}),
    # NOTE the key: this one spells it `dist`, not `district`. Their own file
    # does this one line away from the others.
    ("get_layer",     "https://rbg.iitm.ac.in/gis_layer/get_layer",
     {"state": STATE, "dist": DISTRICT}),
]

TIMEOUT = 30.0


def post(url: str, body: dict):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        raw = resp.read()
        return resp.status, raw, round((time.time() - t0) * 1000)


def describe(value, depth=0, max_depth=3):
    """A compact shape description: types, keys, list lengths."""
    pad = "  " * depth
    if isinstance(value, dict):
        if not value:
            return "{} (empty)"
        if depth >= max_depth:
            return f"{{...{len(value)} keys}}"
        lines = []
        for k, v in list(value.items())[:25]:
            lines.append(f"{pad}  {k}: {describe(v, depth + 1, max_depth)}")
        if len(value) > 25:
            lines.append(f"{pad}  ... {len(value) - 25} more keys")
        return "{\n" + "\n".join(lines) + f"\n{pad}}}"
    if isinstance(value, list):
        if not value:
            return "[] (empty)"
        return f"[{len(value)} items] first -> " + describe(value[0], depth + 1, max_depth)
    if isinstance(value, str):
        s = value if len(value) <= 60 else value[:57] + "..."
        return f'"{s}"'
    return f"{value!r}"


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"Probing the partner RBG API")
    print(f"  state={STATE}  district={DISTRICT}  year={YEAR}  grid_id={GRID_ID}")
    print(f"  writing full responses to {os.path.relpath(OUT_DIR, ROOT)}/\n")

    ok_count = 0
    for name, url, body in CALLS:
        print("=" * 74)
        print(f"{name}   POST {url}")
        print(f"  body: {json.dumps(body)}")
        try:
            status, raw, ms = post(url, body)
        except urllib.error.HTTPError as exc:
            print(f"  -> HTTP {exc.code} {exc.reason}")
            head = exc.read()[:300].decode("utf-8", "replace")
            print(f"     body starts: {head!r}")
            continue
        except urllib.error.URLError as exc:
            print(f"  -> CANNOT REACH: {exc.reason}")
            print("     If this is the only failure mode across all five, the")
            print("     endpoints are probably inside the IITM network.")
            continue
        except Exception as exc:  # noqa: BLE001
            print(f"  -> {type(exc).__name__}: {exc}")
            continue

        print(f"  -> HTTP {status} in {ms} ms, {len(raw):,} bytes")

        path = os.path.join(OUT_DIR, f"{name}.json")
        with open(path, "wb") as fh:
            fh.write(raw)

        try:
            payload = json.loads(raw)
        except Exception as exc:  # noqa: BLE001
            print(f"     NOT JSON ({exc}). First 200 bytes: {raw[:200]!r}")
            continue

        ok_count += 1
        status_field = payload.get("status_code", payload.get("statusCode"))
        print(f"     envelope keys : {list(payload.keys())}")
        print(f"     status field  : {status_field!r}"
              f"{'  (101 = no data for this key)' if str(status_field) == '101' else ''}")
        if payload.get("message"):
            print(f"     message       : {payload['message']!r}")

        details = payload.get("details", payload.get("data"))
        print(f"     details shape :\n       {describe(details)}")

        # The fields we currently guess at, checked against reality.
        if name == "grid_data" and isinstance(details, dict):
            want = ["total_crashes", "total_dead", "total_injured", "vehicle_count", "categories"]
            have = [w for w in want if w in details]
            miss = [w for w in want if w not in details]
            print(f"     WE EXPECT     : {want}")
            print(f"     present       : {have or 'NONE'}")
            if miss:
                print(f"     MISSING       : {miss}   <-- fpGridStatsLive() needs updating")
        if name == "hosp_gps":
            rows = details if isinstance(details, list) else list((details or {}).values())
            if rows and isinstance(rows[0], dict):
                want = ["hospid", "hospname", "category", "hosp_type", "hosp_level",
                        "latitude", "longitude", "equip_prep", "infra_prep", "staff_prep"]
                have = [w for w in want if w in rows[0]]
                miss = [w for w in want if w not in rows[0]]
                print(f"     rows          : {len(rows):,}")
                print(f"     WE EXPECT     : {want}")
                print(f"     present       : {have or 'NONE'}")
                if miss:
                    print(f"     MISSING       : {miss}   <-- FP_PARTNER_HOSPITAL_FIELDS needs updating")
                print(f"     sample row    : {json.dumps(rows[0], default=str)[:400]}")
        print()

    print("=" * 74)
    print(f"{ok_count} of {len(CALLS)} endpoints returned JSON.")
    print(f"Full responses: {OUT_DIR}")
    print("\nPaste the output above back into the chat, or attach the JSON files.")
    return 0 if ok_count else 1


if __name__ == "__main__":
    sys.exit(main())
