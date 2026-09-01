#!/usr/bin/env python3
"""Build the Trauma Preparedness Level (TPL) table for every Haryana hospital.

INPUT
  latest data/haryana_tpl_dump.csv   TPL dump (partial, dirty) — AS OF 20 AUG
                                     2026 this is a DIFFERENT schema than
                                     before: recid, hospid, hosp_level,
                                     statecode, state, districtcode, district,
                                     overall_prep_score. NO latitude/longitude.
  data/rbg_hosp_gps_haryana.json     hospid -> {latitude, longitude, ...},
                                     written by scripts/fetch_hosp_gps_cache.py.
                                     Run that FIRST — this script exits with a
                                     clear error if the cache is missing.
  public.haryana_hosp                Canonical 1,208 hospitals (DB, or parsed
                                     from 'latest data/geolocations latest.sql')

OUTPUT
  data/hospital_tpl.csv              One row per hospital in haryana_hosp

WHY THIS SCRIPT EXISTS
The supplied dump does not line up with our hospital table and cannot be used
as-is. Specifically:

  * `hospid` is a FOREIGN ID SYSTEM. It is NOT our haryana_hosp.s_no — of 609
    testable ids against the OLD dump, ZERO referred to the same hospital. We
    therefore join on LATITUDE/LONGITUDE, which matches to <1 m where it
    overlaps.
  * THE 20 AUG 2026 DUMP HAS NO LATITUDE/LONGITUDE AT ALL — but its `hospid`
    was confirmed live against the partner's own bs_ddhi/get_hosp_gps endpoint
    (9 of 9 tested Jhajjar ids matched exactly). So this version resolves
    coordinates through that endpoint FIRST (via the cache
    scripts/fetch_hosp_gps_cache.py writes), then runs the exact same
    GPS-to-our-hospital join as before. A hospid absent from the hosp_gps
    cache (out of state, a test district, or simply not returned) has no
    coordinate to resolve and is dropped — this is how "out of state" rows
    get cleaned now, since the dump itself no longer carries a location to
    check.
  * The dump has 1,070 rows but only 864 distinct hospids; hospid 880 alone
    appears 54 times with differing scores.
  * 117 rows carry a non-Haryana state field (Tamil Nadu, West Bengal, "Test
    State", a bare state code, ...) — these have no Haryana hosp_gps entry
    either, so they fall out at the coordinate-resolution step, not by a
    separate state check.
  * overall_prep_score = 0 or "NULL" means UNSCORED, not "scored zero" — the
    same convention the old dump used (total_score = 0.00). We ignore both.
  * After cleaning, only a few hundred of our 1,208 hospitals have a usable
    real score from this dump; the rest keep synthesised estimates exactly as
    before.

For the remainder we synthesise a score drawn from the REAL per-type
distribution measured from the matched rows, so downstream analytics stay
complete. Every row is stamped with `tpl_source` so nothing synthetic is ever
mistaken for real:

    real       score came from the dump
    estimated  synthesised from the real distribution for that hospital type

When the complete real TPL file arrives, drop it in as the dump and re-run;
rows flip from `estimated` to `real` automatically with no code change.

Usage:
    python3 scripts/build_tpl.py
    python3 scripts/build_tpl.py --dump "latest data/other_dump.csv"
"""

from __future__ import annotations

import argparse
import csv
import os
import random
import re
import statistics as st
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DUMP = os.path.join(ROOT, "latest data", "haryana_tpl_dump.csv")
GEO_SQL = os.path.join(ROOT, "latest data", "geolocations latest.sql")
OUT_CSV = os.path.join(ROOT, "data", "hospital_tpl.csv")

# Fixed seed => the same hospital always gets the same estimated score across
# runs, restarts and machines. Without this the maps would flicker on reload.
SEED = 20260807

# Standard Indian public health service tiers. Derived from hosp_type, NOT from
# the dump's hosp_level: that field collapses CH_SDH, CHC and PHC all into "L3"
# (31/31, 63/63 and 234/234 respectively), so it cannot separate secondary from
# primary care and is useless for the coverage-gap analysis.
TIER_BY_TYPE = {
    "DCH": "Tertiary",                        # District Civil Hospital
    "CH_SDH": "Secondary",                    # Civil / Sub-District Hospital
    "CHC": "Secondary",                       # Community Health Centre
    "PHC": "Primary",                         # Primary Health Centre
    "Empanelled Private Hospital": "Private",
}

# Private hospitals span every tier. Where the dump gives us a hosp_level we use
# it; L1 sits ABOVE the top public facility (every DCH is L2), so L1/L2 private
# hospitals are treated as tertiary-capable.
PRIVATE_TIER_BY_LEVEL = {"L1": "Tertiary", "L2": "Tertiary", "L3": "Secondary"}
PRIVATE_TIER_DEFAULT = "Secondary"

# --------------------------------------------------------------------------
# Facility LEVEL (L1/L2/L3) — the vocabulary the trauma-network spec uses:
#     L1 = MCH / SSH                          60 km road reach
#     L2 = DH / DCH                           30 km
#     L3 = CHC, SDH, SSH, PHC, UPHC           10 km
#
# WHY WE DERIVE THIS INSTEAD OF TAKING THE DUMP'S COLUMN AT FACE VALUE
# The dump and our hospital table share no key, so they are joined by GPS. That
# join succeeds for 591 of 1,208 hospitals and fails for 617 — and the failures
# are NOT random. Sonipat and Charki Dadri lose 100% of their facilities,
# Mahendragarh 97%, Rohtak 85%, while Rewari loses none. Excluding unmatched
# rows would therefore rank districts by how cleanly they geocoded rather than
# by how well they are served, which is worse than useless for this analysis.
#
# So: public facilities take their level from hosp_type, which the spec defines
# outright (a CHC is L3 by definition, no inference required).
#
# PRIVATE FACILITIES ARE ALL L1 (project decision, 20 Aug 2026, rochit).
#
# Previously private hospitals were levelled by inference: the dump's own
# hosp_level where it had one, else a medical-college/super-speciality name
# match, else a bare default of L2. That produced 44 L1s, 561 L2s and 9 L3s out
# of 614 — and it was the source of a real defect. The spec's L2 is "DH / DCH",
# so the reach analysis counted none of those 561 as L2 providers, while the map
# painted every one of them in L2 colours. Grid 743223 showed an "L2" 2.65 km
# away and routed 13.41 km past it to District Civil Hospital Sirsa. The route
# was right; the label was wrong.
#
# The 386 rows that carried L2 purely from PRIVATE_LEVEL_DEFAULT were the worst
# of it: that was never a measurement, just a value the builder had to put in
# the column. Inferring a care tier from a hospital's NAME was not much better —
# "SUPER SPECIALITY" in a signboard is marketing, not a capability audit.
#
# The empanelled private network is now treated as one tier, L1, on the reasoning
# that these are the facilities actually equipped to receive trauma in Haryana,
# and that the state's own tiering (DCH -> L2, CHC/SDH/PHC -> L3) covers the
# public network completely on its own. One rule, no inference, and the map can
# no longer disagree with the analysis about what a facility provides.
#
# CONSEQUENCE, stated plainly: L1 goes from 44 facilities to 614, so L1 reach
# rises sharply and the L1 gap all but disappears. That is a decision about what
# counts as top-tier trauma care, not a measurement — anyone presenting L1
# numbers has to say that L1 here means "empanelled private hospital", not
# "government medical college". Haryana still has NO public MCH/SSH in this
# data; that finding has not changed, it has only stopped being visible in the
# L1 count.
LEVEL_BY_TYPE = {
    "DCH": "L2",        # District Civil Hospital -> the spec's "DH/DCH"
    "CH_SDH": "L3",     # Civil / Sub-District Hospital -> the spec's "SDH"
    "CHC": "L3",
    "PHC": "L3",
}

# Every empanelled private hospital, with no inference from name or dump level.
PRIVATE_LEVEL = "L1"


# --------------------------------------------------------------------------
# KNOWN-BAD COORDINATES (flagged, not silently trusted) — 23 Aug 2026
# --------------------------------------------------------------------------
# Two of the 22 District Civil Hospitals plot in the wrong place. Confirmed
# the error is upstream of this codebase: the same wrong lat/lon appears
# identically in our own source SQL ('latest data/geolocations latest.sql',
# lines 1377 & 1389) AND in the partner's own live hosp_gps feed
# (data/rbg_hosp_gps_haryana.json, hospid 110 and 637) — so whoever first
# geocoded these two made the same mistake, and every downstream system has
# been inheriting it unchanged. No corrected value exists anywhere in our
# own data to fall back on.
#
#   s_no 8  — DISTRICT CIVIL HOSPITAL HISAR  — off by ~136.8 km (lands on
#             top of DCH Gurugram instead of Hisar)
#   s_no 20 — DISTRICT CIVIL HOSPITAL ROHTAK — off by ~49.3 km
#
# Rather than guess a replacement, both rows are stamped coord_status=
# "unverified" with an explanatory coord_note, so the map/popups/exports can
# surface a "coordinates approximate — pending verification" warning instead
# of presenting them as trustworthy. Replace the two lat/lon values here (or
# upstream in the source SQL) with a confirmed value when one is available,
# then delete the corresponding entry below.
UNVERIFIED_COORDS = {
    "8": (
        "DCH Hisar's GPS is ~137km off (matches DCH Gurugram's location in "
        "the source data) — confirmed wrong in both our source data and the "
        "partner's live feed. Location shown is approximate; true site is "
        "Civil Hospital, Sirsa Road, Hisar. Pending an authoritative fix."
    ),
    "20": (
        "DCH Rohtak's GPS is ~49km off — confirmed wrong in both our source "
        "data and the partner's live feed. Location shown is approximate. "
        "Pending an authoritative fix."
    ),
}


# --------------------------------------------------------------------------
# L1 FACILITIES — REAL ONLY, no mock (removed 20 Aug 2026)
# --------------------------------------------------------------------------
# `haryana_hosp` has never had MCH/SSH rows, and the partner's own live
# hosp_gps feed doesn't either — checked directly: of 822 hospitals the
# partner returns for the whole state, 16 carry hosp_level "L1" and every one
# of them is a PRIVATE facility (SGT Medical College, Amrita Institute, NC
# Medical College Israna, and so on). No government medical college has real
# coordinates anywhere we can reach.
#
# This build used to seed six government medical colleges as fabricated
# points (PGIMS Rohtak, SHKM Nalhar, Kalpana Chawla Karnal, BPS Khanpur
# Kalan, ESIC Faridabad, Maharaja Agrasen Agroha) with hand-picked
# approximate coordinates, specifically because an empty L1 set makes
# "grids within 60 km of an L1" identically zero and collapses deliverable A
# to nothing.
#
# That mock is gone, and as of 20 Aug 2026 the inference is gone with it. L1 is
# now simply THE EMPANELLED PRIVATE NETWORK — all 614 of them, by type alone.
# There is no name matching and no dump lookup left to disagree about: if a
# facility is not one of the four public types, it is L1.
#
# The downstream rule in dashboard/network_analytics.py is unchanged and still
# correct under this scheme: `eligible_at_level()` lets a private facility count
# at L1 and only at L1, while L2 and L3 stay public-only exactly as the spec
# asks. What changed is that all 614 now carry the L1 label rather than 44, so
# the label and the eligibility rule finally describe the same set.
#
# Net effect: L1 reach is now "within 60 km of an empanelled private hospital",
# which is a much larger and much better-distributed set than the 44 the name
# match found — so L1 coverage rises sharply. Say that out loud when presenting
# it. L1 here does NOT mean government medical college; Haryana still has no
# public MCH/SSH anywhere in this data, and that gap is now invisible in the L1
# number rather than absent from the state.


def derive_level(htype: str, name: str, dump_level: str) -> tuple[str, str]:
    """Return (level, provenance) for one hospital. Never returns blank.

    Two rules, no inference. Public facilities take the level their type is
    given by the spec; everything else is an empanelled private hospital and is
    L1. `name` and `dump_level` are no longer consulted — see the note above
    LEVEL_BY_TYPE for why guessing a care tier from a signboard or from a dump
    column that was silent for 386 rows caused more harm than it prevented.
    They stay in the signature because the caller passes them and because
    dump_hosp_level is still written to the CSV for provenance.
    """
    if htype in LEVEL_BY_TYPE:
        return LEVEL_BY_TYPE[htype], "spec_type"
    return PRIVATE_LEVEL, "private_all_l1"

COORD_DP = 6          # exact-match precision (~0.1 m)
FALLBACK_M = 100.0    # nearest-neighbour tolerance if no exact hit


# --------------------------------------------------------------------------
# Loading our canonical hospital table
# --------------------------------------------------------------------------
def load_hospitals_from_db() -> list[dict] | None:
    try:
        sys.path.insert(0, os.path.join(ROOT, "dashboard"))
        from db import fetch_all  # noqa: PLC0415

        rows = fetch_all(
            "SELECT s_no, district_name, hospital_name, latitude, longitude, hosp_type "
            "FROM public.haryana_hosp "
            "WHERE latitude IS NOT NULL AND longitude IS NOT NULL"
        )
        return [dict(r) for r in rows] if rows else None
    except Exception as exc:  # noqa: BLE001 — DB is optional here
        print(f"    (database unavailable: {exc})")
        return None


def load_hospitals_from_sql() -> list[dict]:
    text = open(GEO_SQL, encoding="utf-8", errors="replace").read()
    match = re.search(
        r"^COPY public\.haryana_hosp \((.+?)\) FROM stdin;\n(.*?)^\\\.$",
        text,
        re.M | re.S,
    )
    if not match:
        raise SystemExit(f"Could not find haryana_hosp COPY block in {GEO_SQL}")
    cols = [c.strip() for c in match.group(1).split(",")]
    out = []
    for line in match.group(2).strip("\n").split("\n"):
        if line:
            out.append(dict(zip(cols, line.split("\t"))))
    return out


def load_hospitals() -> list[dict]:
    print("==> Loading canonical hospital table...")
    rows = load_hospitals_from_db()
    src = "database"
    if not rows:
        rows = load_hospitals_from_sql()
        src = "geolocations latest.sql"
    clean = []
    for r in rows:
        try:
            lat, lon = float(r["latitude"]), float(r["longitude"])
        except (TypeError, ValueError):
            continue
        clean.append(
            {
                "s_no": str(r["s_no"]).lstrip("﻿").strip(),
                "district_name": (r.get("district_name") or "").strip(),
                "hospital_name": (r.get("hospital_name") or "").strip(),
                "hosp_type": (r.get("hosp_type") or "").strip(),
                "latitude": lat,
                "longitude": lon,
            }
        )
    print(f"    {len(clean)} hospitals from {src}")
    return clean


# --------------------------------------------------------------------------
# Reading + cleaning the TPL dump
# --------------------------------------------------------------------------
HOSP_GPS_CACHE = os.path.join(ROOT, "data", "rbg_hosp_gps_haryana.json")


def _load_hosp_gps_cache() -> dict:
    if not os.path.exists(HOSP_GPS_CACHE):
        raise SystemExit(
            f"{HOSP_GPS_CACHE} not found.\n"
            "The 20 Aug 2026 TPL dump carries no coordinates — hospid is\n"
            "resolved against the partner's own hosp_gps endpoint instead.\n"
            "Run this first:\n"
            "    python3 scripts/fetch_hosp_gps_cache.py"
        )
    import json as _json
    with open(HOSP_GPS_CACHE, encoding="utf-8") as fh:
        return _json.load(fh)


def load_dump(path: str) -> list[dict]:
    if not os.path.exists(path):
        raise SystemExit(
            f"TPL dump not found: {path}\n"
            "Place the team-lead CSV there, or pass --dump <path>."
        )
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))

    has_coords = rows and "latitude" in rows[0] and "longitude" in rows[0]
    if not has_coords:
        # 20 Aug 2026 schema: recid, hospid, hosp_level, statecode, state,
        # districtcode, district, overall_prep_score — no location. Resolve
        # each hospid's coordinates through the hosp_gps cache and normalise
        # the score column name so index_dump() below needs no other change.
        print("==> Dump has no latitude/longitude column — resolving via "
              "hosp_gps cache")
        cache = _load_hosp_gps_cache()
        print(f"    {len(cache)} hospid -> coordinates in cache")
        resolved, unresolved = 0, 0
        clean = []
        for r in rows:
            hit = cache.get(str(r.get("hospid", "")).strip())
            if not hit:
                unresolved += 1
                continue
            resolved += 1
            clean.append({
                **r,
                "latitude": hit["latitude"],
                "longitude": hit["longitude"],
                "total_score": r.get("overall_prep_score", ""),
            })
        print(f"    {resolved} rows resolved, {unresolved} rows had no "
              "matching hospid in the cache (dropped — likely out of state, "
              "a test district, or a hospital hosp_gps did not return)")
        rows = clean

    print(f"==> TPL dump: {len(rows)} rows, "
          f"{len({r['hospid'] for r in rows})} distinct hospid")
    return rows


def index_dump(dump: list[dict], hospitals: list[dict]) -> tuple[dict, dict]:
    """Map our hospital s_no -> cleaned TPL facts, joining on coordinates."""
    exact = {(round(h["latitude"], COORD_DP), round(h["longitude"], COORD_DP)): h for h in hospitals}
    # Coarse buckets for the near-miss fallback.
    buckets: dict[tuple, list[dict]] = defaultdict(list)
    for h in hospitals:
        buckets[(round(h["latitude"], 2), round(h["longitude"], 2))].append(h)

    def nearest(lat: float, lon: float) -> dict | None:
        best, best_m = None, FALLBACK_M
        for dla in (-0.01, 0.0, 0.01):
            for dlo in (-0.01, 0.0, 0.01):
                for h in buckets.get((round(lat + dla, 2), round(lon + dlo, 2)), []):
                    # Local flat-earth metres — fine at 100 m scale.
                    dy = (h["latitude"] - lat) * 111_320.0
                    dx = (h["longitude"] - lon) * 96_000.0
                    d = (dx * dx + dy * dy) ** 0.5
                    if d < best_m:
                        best, best_m = h, d
        return best

    scores: dict[str, list[float]] = defaultdict(list)
    levels: dict[str, list[str]] = defaultdict(list)
    hospids: dict[str, set] = defaultdict(set)
    unmatched = 0

    for r in dump:
        try:
            lat, lon = float(r["latitude"]), float(r["longitude"])
        except (TypeError, ValueError):
            continue
        h = exact.get((round(lat, COORD_DP), round(lon, COORD_DP))) or nearest(lat, lon)
        if h is None:
            unmatched += 1
            continue
        sno = h["s_no"]
        hospids[sno].add(r.get("hospid", ""))
        lvl = (r.get("hosp_level") or "").strip()
        if lvl and lvl != "NA":
            levels[sno].append(lvl)
        try:
            v = float(r["total_score"])
        except (TypeError, ValueError):
            continue  # NULL
        if v > 0:  # 0.00 == unscored, see module docstring
            scores[sno].append(v)

    print(f"    dump rows matching no hospital of ours: {unmatched}")
    print(f"    our hospitals with >=1 real score:      {len(scores)}")
    facts = {}
    for sno in set(scores) | set(levels) | set(hospids):
        vals = scores.get(sno, [])
        lv = levels.get(sno, [])
        facts[sno] = {
            "tpl": round(st.median(vals), 2) if vals else None,
            "n_rows": len(vals),
            "conflict": len({round(v, 2) for v in vals}) > 1,
            "hosp_level": st.mode(lv) if lv else "",
            "dump_hospid": ";".join(sorted(hospids.get(sno, set()))[:3]),
        }
    return facts, {}


# --------------------------------------------------------------------------
# Synthesis for hospitals the dump does not cover
# --------------------------------------------------------------------------
def type_distributions(hospitals: list[dict], facts: dict) -> dict[str, dict]:
    by_type: dict[str, list[float]] = defaultdict(list)
    for h in hospitals:
        f = facts.get(h["s_no"])
        if f and f["tpl"] is not None:
            by_type[h["hosp_type"]].append(f["tpl"])
    dist = {}
    print("\n==> Real TPL distribution by hospital type (basis for synthesis)")
    for t, vals in sorted(by_type.items()):
        if len(vals) < 3:
            continue
        dist[t] = {
            "mean": st.mean(vals),
            "sd": st.pstdev(vals) or 8.0,
            "lo": min(vals),
            "hi": max(vals),
            "n": len(vals),
        }
        d = dist[t]
        print(
            f"    {t:<28} n={d['n']:>3}  mean {d['mean']:5.2f}  sd {d['sd']:5.2f}"
            f"  range {d['lo']:5.2f}-{d['hi']:5.2f}"
        )
    return dist


def synth(rng: random.Random, d: dict) -> float:
    """Draw from the real distribution, clipped to the real observed range."""
    for _ in range(64):
        v = rng.gauss(d["mean"], d["sd"])
        if d["lo"] <= v <= d["hi"]:
            return round(v, 2)
    return round(min(max(d["mean"], d["lo"]), d["hi"]), 2)


# --------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", default=DEFAULT_DUMP)
    args = ap.parse_args()

    hospitals = load_hospitals()
    dump = load_dump(args.dump)
    facts, _ = index_dump(dump, hospitals)
    dist = type_distributions(hospitals, facts)

    rng = random.Random(SEED)
    out_rows = []
    counts = defaultdict(int)
    conflicts = 0

    for h in sorted(hospitals, key=lambda x: int(x["s_no"]) if x["s_no"].isdigit() else 0):
        coord_status = "unverified" if h["s_no"] in UNVERIFIED_COORDS else "ok"
        coord_note = UNVERIFIED_COORDS.get(h["s_no"], "")
        f = facts.get(h["s_no"], {})
        htype = h["hosp_type"]
        dump_level = f.get("hosp_level", "")
        level, level_source = derive_level(htype, h["hospital_name"], dump_level)

        tier = TIER_BY_TYPE.get(htype, "Secondary")
        if tier == "Private":
            tier = PRIVATE_TIER_BY_LEVEL.get(level, PRIVATE_TIER_DEFAULT)

        tpl = f.get("tpl")
        if tpl is not None:
            source = "real"
            if f.get("conflict"):
                conflicts += 1
        else:
            source = "estimated"
            d = dist.get(htype)
            # No distribution for this type at all -> fall back to a neutral mid
            tpl = synth(rng, d) if d else 40.0
        counts[source] += 1

        out_rows.append(
            {
                "s_no": h["s_no"],
                "hospital_name": h["hospital_name"],
                "district_name": h["district_name"],
                "hosp_type": htype,
                "tier": tier,
                "hosp_level": level,
                "level_source": level_source,
                "dump_hosp_level": dump_level,
                "latitude": f"{h['latitude']:.6f}",
                "longitude": f"{h['longitude']:.6f}",
                "tpl_total": f"{tpl:.2f}",
                "tpl_source": source,
                "tpl_rows_in_dump": f.get("n_rows", 0),
                "dump_hospid": f.get("dump_hospid", ""),
                "coord_status": coord_status,
                "coord_note": coord_note,
            }
        )

    os.makedirs(os.path.dirname(OUT_CSV), exist_ok=True)
    with open(OUT_CSV, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(out_rows[0].keys()))
        w.writeheader()
        w.writerows(out_rows)

    print(f"\n==> Wrote {OUT_CSV}")
    print(f"    {len(out_rows)} hospitals: {counts['real']} real, {counts['estimated']} estimated")
    if conflicts:
        print(f"    {conflicts} hospitals had conflicting scores in the dump (median taken)")

    by_tier = defaultdict(int)
    for r in out_rows:
        by_tier[r["tier"]] += 1
    print("    tiers: " + ", ".join(f"{k} {v}" for k, v in sorted(by_tier.items())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
