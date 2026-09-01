"""Canonical Haryana district names — one normaliser for the whole app.

WHY THIS EXISTS
`haryana_hosp` contains **44 distinct district_name values for 22 districts**,
because the public-facility list and the empanelled-private list were merged
without reconciling conventions. The split is completely systematic:

    private rows are UPPERCASE      public rows are Title Case
    'HISAR'          (74 private)   'Hissar'        (42 public)
    'SONIPAT'        (27 private)   'Sonepat'       (41 public)
    'MAHENDRAGARH'   (21 private)   'Narnaul'       (29 public)
    'Yamuna Nagar'   (34 private)   'Jagadhari'     (24 public)
    'CHARKI DADRI'   (15 private)   'Charkhi Dadri' (16 public)

There is NOT ONE district where public and private hospitals share a spelling.
So a naive `WHERE district_name = 'HISAR'` returns 74 private hospitals and zero
PHCs — the filter silently halves the network, and a coverage map built on it
would look far worse (or better) than reality.

The grid feed and the boundary polygons use yet another set of spellings, which
is why CANONICAL below matches the district polygon names — those are what the
RBG grid cells are labelled with, so normalising to them lets grids, hospitals
and ambulances be joined on a single key.

`db.py` solves the same problem inline with a hand-written SQL OR-chain
(`_district_match_sql`) and `reach_pipeline.py` has its own alias dict. Those
predate this module and still work; new code should use this one so there is a
single place to fix the next spelling that turns up.
"""

from __future__ import annotations

# The 22 district names as they appear in india_admin_boundary.district, which
# is also what the RBG grid cells are labelled with.
CANONICAL = {
    "AMBALA",
    "BHIWANI",
    "CHARKI DADRI",
    "FARIDABAD",
    "FATEHABAD",
    "GURUGRAM",
    "HISAR",
    "JHAJJAR",
    "JIND",
    "KAITHAL",
    "KARNAL",
    "KURUKSHETRA",
    "MAHENDRAGARH",
    "NUH",
    "PALWAL",
    "PANCHKULA",
    "PANIPAT",
    "REWARI",
    "ROHTAK",
    "SIRSA",
    "SONIPAT",
    "YAMUNANAGAR",
}

# Every spelling observed across haryana_hosp, haryana_ambulance,
# haryana_bloodbanks and the RBG grid feed. Keys are upper-cased and trimmed.
ALIASES = {
    # spelling variants
    "HISSAR": "HISAR",
    "SONEPAT": "SONIPAT",
    "CHARKHI DADRI": "CHARKI DADRI",
    "CHARKI DADRI": "CHARKI DADRI",
    "DADRI": "CHARKI DADRI",
    "GURGAON": "GURUGRAM",
    "YAMUNA NAGAR": "YAMUNANAGAR",
    "YAMUNANAGAR": "YAMUNANAGAR",
    "N U H": "NUH",
    "MAHENDERGARH": "MAHENDRAGARH",
    "JAGADHRI": "YAMUNANAGAR",
    # renamed districts — the public list still uses the old headquarters town
    "NARNAUL": "MAHENDRAGARH",     # Narnaul is the HQ of Mahendragarh district
    "JAGADHARI": "YAMUNANAGAR",    # Jagadhri is the HQ of Yamunanagar district
    "MEWAT": "NUH",                # Mewat was renamed Nuh in 2016
    # POLICE districts, not revenue districts. The accident data comes from IRAD,
    # a police system, so it reports police jurisdictions — but the grid feed and
    # the hospital table use revenue districts. Hansi and Dabwali exist only as
    # police districts. Verified geographically: all 495 HANSI accidents sit on
    # Hisar grids, all 472 Dabwali accidents on Sirsa grids. Left unmapped these
    # 967 accidents vanish from every district-filtered view.
    "HANSI": "HISAR",
    "DABWALI": "SIRSA",
}


def normalize(name: str | None) -> str:
    """Canonical upper-case district name, or '' if unrecognised."""
    n = (name or "").strip().upper()
    if not n:
        return ""
    n = " ".join(n.split())  # collapse repeated whitespace
    n = ALIASES.get(n, n)
    return n if n in CANONICAL else n  # unknown names pass through, not dropped


def matches(a: str | None, b: str | None) -> bool:
    """True when two district labels refer to the same district."""
    na, nb = normalize(a), normalize(b)
    return bool(na) and na == nb


def audit(names) -> dict:
    """Report which supplied names resolve and which do not — used by tests."""
    resolved, unresolved = {}, []
    for raw in names:
        n = normalize(raw)
        if n in CANONICAL:
            resolved.setdefault(n, []).append(raw)
        else:
            unresolved.append(raw)
    return {
        "canonical_hit": len(resolved),
        "canonical_total": len(CANONICAL),
        "unresolved": sorted(set(unresolved)),
        "mapping": {k: sorted(set(v)) for k, v in sorted(resolved.items())},
    }
