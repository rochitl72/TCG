"""Trauma Preparedness Level (TPL) lookup for Haryana hospitals.

Reads ``data/hospital_tpl.csv`` (built by ``scripts/build_tpl.py``) and joins it
onto hospital records by ``s_no``. Hot-reloads when the CSV changes on disk, so
dropping in a new TPL file takes effect without restarting the app.

Every record carries ``tpl_source``:
    real       score supplied in the team-lead TPL dump
    estimated  synthesised from the real per-hospital-type distribution

Never present an ``estimated`` score as a measured one. The UI shows a hatched
marker and the exports keep the column, so provenance survives the handoff.
"""

from __future__ import annotations

import csv
import os
import threading
from collections import Counter
from typing import Any

DATA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))
TPL_CSV = os.path.join(DATA_DIR, "hospital_tpl.csv")

# Service tiers used by the coverage-gap analysis.
TIERS = ("Tertiary", "Secondary", "Primary")

_lock = threading.Lock()
_cache: dict[str, Any] = {"mtime": None, "by_sno": {}, "summary": {}}


def _numeric(value: str) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _load() -> None:
    """(Re)read the CSV if it changed. Caller must hold _lock."""
    try:
        mtime = os.path.getmtime(TPL_CSV)
    except OSError:
        _cache.update(mtime=None, by_sno={}, summary={"available": False, "total": 0})
        return

    if _cache["mtime"] == mtime:
        return

    by_sno: dict[str, dict[str, Any]] = {}
    with open(TPL_CSV, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            sno = str(row.get("s_no", "")).strip()
            if not sno:
                continue
            by_sno[sno] = {
                "tpl_total": _numeric(row.get("tpl_total")),
                "tpl_source": (row.get("tpl_source") or "").strip(),
                "tier": (row.get("tier") or "").strip(),
                "hosp_level": (row.get("hosp_level") or "").strip(),
                # How that level was decided — spec_type / dump / name_mch_ssh /
                # private_default / mock_mch. Surfaced so a briefing can say
                # which classifications are inferred and which are mocked.
                "level_source": (row.get("level_source") or "").strip(),
                "dump_hospid": (row.get("dump_hospid") or "").strip(),
                # "unverified" flags facilities with a known-wrong GPS and no
                # authoritative replacement yet — see build_tpl.UNVERIFIED_COORDS.
                "coord_status": (row.get("coord_status") or "ok").strip(),
                "coord_note": (row.get("coord_note") or "").strip(),
            }

    src = Counter(v["tpl_source"] for v in by_sno.values())
    tier = Counter(v["tier"] for v in by_sno.values())
    scores = [v["tpl_total"] for v in by_sno.values() if v["tpl_total"] is not None]
    _cache.update(
        mtime=mtime,
        by_sno=by_sno,
        summary={
            "available": True,
            "total": len(by_sno),
            "real": src.get("real", 0),
            "estimated": src.get("estimated", 0),
            "by_tier": {t: tier.get(t, 0) for t in TIERS},
            "mean_tpl": round(sum(scores) / len(scores), 2) if scores else None,
            "source_file": os.path.basename(TPL_CSV),
        },
    )


def _ensure() -> None:
    with _lock:
        _load()


def get(s_no: Any) -> dict[str, Any]:
    """TPL facts for one hospital. Returns empty-ish defaults if unknown."""
    _ensure()
    return _cache["by_sno"].get(
        str(s_no).strip(),
        {
            "tpl_total": None,
            "tpl_source": "unknown",
            "tier": "",
            "hosp_level": "",
            "level_source": "",
            "dump_hospid": "",
            "coord_status": "ok",
            "coord_note": "",
        },
    )


def attach(hospitals: list[dict], key: str = "s_no") -> list[dict]:
    """Add tpl_total / tpl_source / tier / hosp_level to each hospital dict.

    Mutates and returns the list — cheap enough to call per request.
    """
    _ensure()
    table = _cache["by_sno"]
    for h in hospitals:
        facts = table.get(str(h.get(key, "")).strip())
        if facts:
            h.update(facts)
        else:
            h.setdefault("tpl_total", None)
            h.setdefault("tpl_source", "unknown")
            h.setdefault("tier", "")
            h.setdefault("hosp_level", "")
            h.setdefault("level_source", "")
            h.setdefault("coord_status", "ok")
            h.setdefault("coord_note", "")
    return hospitals


def tier_of(hospital: dict) -> str:
    """Service tier for a hospital record, falling back to hosp_type."""
    facts = get(hospital.get("s_no", ""))
    if facts["tier"]:
        return facts["tier"]
    return {
        "DCH": "Tertiary",
        "CH_SDH": "Secondary",
        "CHC": "Secondary",
        "PHC": "Primary",
    }.get((hospital.get("hosp_type") or "").strip(), "Secondary")


def summary() -> dict[str, Any]:
    """Coverage/provenance counts, for the UI's data-quality badge."""
    _ensure()
    return dict(_cache["summary"])
