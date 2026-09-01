"""Server-side client for the partner team's RBG endpoints.

WHY THIS IS A SERVER-SIDE PROXY AND NOT A BROWSER FETCH
-------------------------------------------------------
The browser cannot POST cross-origin to rbg.iitm.ac.in unless that server sends
`Access-Control-Allow-Origin` for our origin. The partner app is served from a
host they control, so CORS is a non-issue for them and there is nothing in the
file they shared that would make it work for us. Calling it from our page would
fail in the browser with an opaque CORS error and look like a bug in our code.

Proxying through Flask sidesteps CORS entirely, and buys three things we want
anyway: one memoised copy of a 4 MB grid payload instead of one per tab, a hard
timeout so a slow endpoint cannot hang the UI, and a single place to add
credentials if they ever turn auth on.

WHAT THIS MODULE DOES NOT DO
----------------------------
It does not decide fallbacks. It reports honestly whether a call succeeded, and
the client chooses whether to fall back to our offline data. A proxy that
silently substitutes local data would make "is this live?" unanswerable from
the UI, which is the one question that matters once two data sources exist.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

# Verified reachable 2026-08-19. Confirmed against our own rbg_grids.py, which
# has been calling acc_grid_data on this host since the grid cache was built —
# so the host, the path style and the no-auth POST are all already proven.
BASE_ONE_PAGER = "https://rbg.iitm.ac.in/one_pager"

ENDPOINTS = {
    # name              -> full URL
    "grid_data": f"{BASE_ONE_PAGER}/grid_data",
    "acc_loc_data": f"{BASE_ONE_PAGER}/acc_loc_data",
    "acc_grid_data": f"{BASE_ONE_PAGER}/acc_grid_data",
    "hosp_gps": "https://rbg.iitm.ac.in/bs_ddhi/get_hosp_gps",
    "get_layer": "https://rbg.iitm.ac.in/gis_layer/get_layer",
}

STATE_CODE = "13"  # Haryana

# Their APIs key on numeric district codes, not names. Derived from the
# district_code column of our own accident feed, normalised through
# districts.normalize() so the spellings line up (their "MAHENDERGARH" is our
# MAHENDRAGARH, "N U H" is NUH, and so on).
#
# Hansi (261) and Dabwali (265) also appear in the feed. They are sub-districts
# of Hisar and Sirsa, not districts in their own right, so the parent code is
# used and theirs are listed here only so the next reader does not think the
# table is missing two rows.
DISTRICT_CODES = {
    "AMBALA": "221",
    "BHIWANI": "223",
    "CHARKI DADRI": "259",
    "FARIDABAD": "225",
    "FATEHABAD": "256",
    "GURUGRAM": "227",
    "HISAR": "229",       # Hansi = 261
    "JHAJJAR": "257",
    "JIND": "230",
    "KAITHAL": "228",
    "KARNAL": "231",
    "KURUKSHETRA": "232",
    "MAHENDRAGARH": "233",
    "NUH": "258",
    "PALWAL": "260",
    "PANCHKULA": "235",
    "PANIPAT": "234",
    "REWARI": "236",
    "ROHTAK": "237",
    "SIRSA": "238",       # Dabwali = 265
    "SONIPAT": "239",
    "YAMUNANAGAR": "240",
}

DEFAULT_TIMEOUT = 8.0
# Their grid payload is ~4 MB and does not change during a session. Ten minutes
# is long enough that clicking between districts is instant and short enough
# that a genuinely updated feed is picked up within one demo.
CACHE_TTL = 600.0

_cache: dict[str, tuple[float, dict]] = {}


def district_code(name: str | None) -> str:
    """Canonical district name -> their numeric code. '' means whole state."""
    if not name:
        return ""
    import districts as _d

    return DISTRICT_CODES.get(_d.normalize(name), "")


def call(name: str, body: dict, timeout: float = DEFAULT_TIMEOUT) -> dict:
    """POST one endpoint. Returns an envelope; never raises for network reasons.

    { ok, source: "live"|"cache"|"unavailable", data, reason, elapsed_ms }
    """
    url = ENDPOINTS.get(name)
    if not url:
        return {"ok": False, "source": "unavailable", "data": None,
                "reason": f"Unknown endpoint {name!r}."}

    key = f"{name}|{json.dumps(body, sort_keys=True)}"
    hit = _cache.get(key)
    now = time.time()
    if hit and now - hit[0] < CACHE_TTL:
        return {"ok": True, "source": "cache", "data": hit[1], "elapsed_ms": 0}

    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )

    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return {"ok": False, "source": "unavailable", "data": None,
                "reason": f"{name}: HTTP {exc.code} {exc.reason}"}
    except urllib.error.URLError as exc:
        # Name the host we actually tried, not a hardcoded one — the URLs are
        # overridable for testing and a wrong hostname in the error sends the
        # next person debugging in the wrong direction.
        from urllib.parse import urlparse

        return {"ok": False, "source": "unavailable", "data": None,
                "reason": f"{name}: cannot reach {urlparse(url).netloc} ({exc.reason})"}
    except Exception as exc:  # noqa: BLE001 — a proxy must not 500 on bad JSON
        return {"ok": False, "source": "unavailable", "data": None,
                "reason": f"{name}: {type(exc).__name__}: {exc}"}

    elapsed = round((time.time() - t0) * 1000)

    # Their envelope is inconsistent across services: one_pager/* answer with
    # `status_code`, bs_ddhi/* with `statusCode`. Accept either rather than
    # guessing which service we are talking to.
    status = raw.get("status_code", raw.get("statusCode"))
    ok = str(status) in ("200", "None") or status is None

    # 101 means "no data for this key" — a valid answer, not a failure.
    if str(status) == "101":
        return {"ok": True, "source": "live", "data": {"empty": True, "raw": raw},
                "elapsed_ms": elapsed}

    if not ok:
        return {"ok": False, "source": "unavailable", "data": None,
                "reason": f"{name}: API status {status}"
                          f"{' — ' + str(raw.get('message')) if raw.get('message') else ''}"}

    _cache[key] = (now, raw)
    return {"ok": True, "source": "live", "data": raw, "elapsed_ms": elapsed}


def health() -> dict:
    """Cheap reachability probe used by the sidebar's data-source panel."""
    r = call("grid_data", {"grid_id": "0", "year": "2025"}, timeout=5.0)
    return {
        "reachable": r["ok"],
        "reason": r.get("reason"),
        "elapsed_ms": r.get("elapsed_ms"),
    }
