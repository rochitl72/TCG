#!/usr/bin/env python3
"""Fetch the partner's hosp_gps hospital list for all of Haryana, once.

WHY THIS EXISTS
The TPL dump now in use (Aug 2026 revision) carries no latitude/longitude —
only `hospid`, which we confirmed against a live probe is the SAME id space as
the partner's bs_ddhi/get_hosp_gps endpoint (Jhajjar hospids 199, 200, 202...
all matched exactly). So instead of the old GPS-in-the-dump join, coordinates
for each hospid are resolved through this cache.

build_tpl.py reads the JSON this writes; it never calls the network itself, so
the TPL build stays reproducible offline once this has been run once.

WHOLE-STATE VS PER-DISTRICT
We only ever confirmed this endpoint live for ONE district (Jhajjar, in the
probe). Whether `district: ""` really means "whole state" on their SERVER —
not just in our own proxy's code — is unverified, so this script tries the
whole-state call first and falls back to 22 per-district calls (using the same
codes rbg_live.py already carries) if that returns suspiciously few hospitals
or fails outright. Either path writes the same output file.

Usage:
    python3 scripts/fetch_hosp_gps_cache.py

Needs network access to rbg.iitm.ac.in — this environment's sandbox has none,
so it must run on a machine that does, same as scripts/probe_rbg_api.py.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "data", "rbg_hosp_gps_haryana.json")
URL = "https://rbg.iitm.ac.in/bs_ddhi/get_hosp_gps"
STATE = "13"

# A whole-state haryana_hosp table has ~1,200 facilities. If the "whole state"
# call returns far fewer than that, it silently defaulted to something else
# rather than erroring, and the per-district loop is the honest fallback.
SUSPICIOUSLY_FEW = 100

try:
    sys.path.insert(0, os.path.join(ROOT, "dashboard"))
    from rbg_live import DISTRICT_CODES  # noqa: PLC0415 — reuse the one source of truth
except Exception:
    DISTRICT_CODES = {}  # fallback loop just won't have codes; whole-state must work


def post(district_code: str) -> dict:
    body = json.dumps({"state": STATE, "district": district_code}).encode("utf-8")
    req = urllib.request.Request(
        URL, data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30.0) as resp:
        return json.loads(resp.read())


def rows_from(raw: dict) -> list[dict]:
    status = raw.get("statusCode", raw.get("status_code"))
    if str(status) not in ("200",):
        return []
    details = raw.get("details") or {}
    return list(details.values()) if isinstance(details, dict) else list(details)


def merge(by_hospid: dict, rows: list[dict]) -> int:
    added = 0
    for r in rows:
        hospid = str(r.get("hospid", "")).strip()
        try:
            lat, lon = float(r["latitude"]), float(r["longitude"])
        except (TypeError, ValueError, KeyError):
            continue
        if not hospid:
            continue
        if hospid not in by_hospid:
            added += 1
        by_hospid[hospid] = {
            "hospname": (r.get("hospname") or "").strip(),
            "category": (r.get("category") or "").strip(),
            "hosp_type": (r.get("hosp_type") or "").strip(),
            "hosp_level": (r.get("hosp_level") or "").strip(),
            "latitude": lat,
            "longitude": lon,
        }
    return added


def main() -> int:
    by_hospid: dict[str, dict] = {}

    print(f"POST {URL}  {{state: '{STATE}', district: ''}}  (whole state, first try)")
    t0 = time.time()
    try:
        raw = post("")
        rows = rows_from(raw)
        print(f"  {len(rows)} hospitals in {round((time.time()-t0)*1000)} ms")
        merge(by_hospid, rows)
    except urllib.error.URLError as exc:
        print(f"  whole-state call failed: {exc}")

    if len(by_hospid) < SUSPICIOUSLY_FEW:
        if not DISTRICT_CODES:
            print("Cannot fall back — DISTRICT_CODES unavailable (import failed).")
            if not by_hospid:
                return 1
        else:
            print(f"\nOnly {len(by_hospid)} hospitals — falling back to "
                  f"{len(DISTRICT_CODES)} per-district calls.")
            for name, code in sorted(DISTRICT_CODES.items()):
                try:
                    raw = post(code)
                    n = merge(by_hospid, rows_from(raw))
                    print(f"  {name:<16} code={code:<4} +{n} new (total {len(by_hospid)})")
                except urllib.error.URLError as exc:
                    print(f"  {name:<16} code={code:<4} FAILED: {exc}")

    if not by_hospid:
        print("\nNo hospitals resolved at all. Nothing written.")
        return 1

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(by_hospid, fh, indent=1, sort_keys=True)

    print(f"\nWrote {OUT}  ({len(by_hospid)} hospid -> coordinates)")
    print("Next: python3 scripts/build_tpl.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
