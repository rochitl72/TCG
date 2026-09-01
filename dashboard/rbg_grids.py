"""Fetch Haryana accident grid cells from the RBG IITM API and cache them.

Source: POST https://rbg.iitm.ac.in/one_pager/acc_grid_data
  { "state": "13", "district": "", "year": "2025" }

Returns ~1 km square polygons with grid_id + severity_score. Field names
centroid_lat / centroid_long are swapped relative to geographic meaning
(centroid_lat holds longitude). Geometry coordinates are correct GeoJSON [lon, lat].
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

from shapely.geometry import Point, shape

from db import districts_geojson

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR = os.path.join(ROOT, "data")
CACHE_DIR = os.path.join(DATA_DIR, "rbg_grids")

RBG_GRID_URL = os.environ.get(
    "RBG_GRID_URL", "https://rbg.iitm.ac.in/one_pager/acc_grid_data"
)
RBG_STATE_CODE = os.environ.get("RBG_STATE_CODE", "13")  # Haryana
DEFAULT_YEAR = "2025"
AVAILABLE_YEARS = ("2023", "2024", "2025")


def _cache_path(year: str) -> str:
    return os.path.join(CACHE_DIR, f"haryana_{year}.json")


def _normalize_year(year: str | None) -> str:
    y = str(year or DEFAULT_YEAR).strip()
    if y not in AVAILABLE_YEARS:
        raise ValueError(f"year must be one of {', '.join(AVAILABLE_YEARS)}")
    return y


def _district_index() -> list[tuple[str, Any]]:
    """Load Haryana district polygons once for spatial join."""
    collection = districts_geojson(state="Haryana")
    out = []
    for feature in collection.get("features") or []:
        props = feature.get("properties") or {}
        name = str(props.get("DISTRICT") or "").strip()
        geom = feature.get("geometry")
        if not name or not geom:
            continue
        try:
            g = shape(geom)
            if not g.is_valid:
                g = g.buffer(0)
            out.append((name.upper(), g))
        except Exception:
            continue
    return out


def _assign_district(lon: float, lat: float, index: list[tuple[str, Any]]) -> str:
    pt = Point(lon, lat)
    for name, geom in index:
        try:
            if geom.contains(pt) or geom.intersects(pt):
                return name
        except Exception:
            continue
    # Tiny buffer for cells that sit exactly on a boundary edge
    try:
        buf = pt.buffer(0.002)
        for name, geom in index:
            if geom.intersects(buf):
                return name
    except Exception:
        pass
    return ""


def _fetch_raw(year: str) -> list[dict]:
    payload = json.dumps(
        {"state": RBG_STATE_CODE, "district": "", "year": year}
    ).encode("utf-8")
    req = urllib.request.Request(
        RBG_GRID_URL,
        data=payload,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"RBG grid API HTTP {exc.code}: {exc.reason}") from exc
    except Exception as exc:
        raise RuntimeError(f"RBG grid API request failed: {exc}") from exc

    if data.get("status_code") not in (200, "200", None):
        # API uses 200 for success; 101 = no data
        if data.get("status_code") == 101:
            return []
        if data.get("message") and data.get("status_code") not in (200, "200"):
            # still try features if present
            pass

    details = data.get("details") or {}
    features = details.get("features") if isinstance(details, dict) else None
    if features is None and isinstance(data.get("features"), list):
        features = data["features"]
    if not isinstance(features, list):
        raise RuntimeError(f"Unexpected RBG grid response shape: {list(data.keys())}")
    return features


# The API returns both Polygon and MultiPolygon cells. 15 of the 6,800 Haryana
# 2025 cells are MultiPolygon — cells whose footprint is split, typically where
# they straddle a boundary. Accepting only Polygon silently discarded all 15,
# including some of the highest-severity cells in the state (grid 728051 carries
# severity 66, grid 737554 carries 35). Both types are valid GeoJSON and shapely
# handles both, so both are kept.
_ACCEPTED_GEOMETRY = {"Polygon", "MultiPolygon"}


def _normalize_feature(raw: dict, year: str, district: str) -> dict[str, Any] | None:
    geometry = raw.get("geometry")
    if not geometry or geometry.get("type") not in _ACCEPTED_GEOMETRY:
        return None

    # API labels are swapped: centroid_lat ≈ longitude, centroid_long ≈ latitude
    lon = float(raw.get("centroid_lat") if raw.get("centroid_lat") is not None else 0)
    lat = float(raw.get("centroid_long") if raw.get("centroid_long") is not None else 0)
    # Prefer geometry centroid if API centroid missing/odd
    if not (70 <= lon <= 90 and 20 <= lat <= 40):
        try:
            c = shape(geometry).centroid
            lon, lat = c.x, c.y
        except Exception:
            return None

    grid_id = raw.get("grid_id")
    severity = raw.get("severity_score")
    return {
        "type": "Feature",
        "properties": {
            "grid_id": grid_id,
            "cell_id": str(grid_id),
            "severity_score": severity,
            "centroid_lat": lat,
            "centroid_lon": lon,
            "DISTRICT": district,
            "district": district,
            "STATE_UT": "HARYANA",
            "state_ut": "HARYANA",
            "grid_type": "rbg_square",
            "year": year,
            "cell_diameter_km": 1.0,
            "cell_diameter_m": 1000,
            "source": "rbg.iitm.ac.in/one_pager/acc_grid_data",
        },
        "geometry": geometry,
    }


def build_collection(year: str, force: bool = False) -> dict[str, Any]:
    year = _normalize_year(year)
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = _cache_path(year)

    if not force and os.path.exists(path):
        with open(path) as f:
            return json.load(f)

    raw_features = _fetch_raw(year)
    index = _district_index()
    features: list[dict] = []
    # Account for every raw row. Without this the pipeline can silently discard
    # API rows (bad geometry, unusable centroid) and nobody ever finds out that
    # the grid count is short.
    skipped_no_centroid = 0
    skipped_bad_geometry = 0
    unassigned_district = 0

    for raw in raw_features:
        lon = float(raw.get("centroid_lat") or 0)
        lat = float(raw.get("centroid_long") or 0)
        if not (70 <= lon <= 90 and 20 <= lat <= 40):
            try:
                c = shape(raw["geometry"]).centroid
                lon, lat = c.x, c.y
            except Exception:
                skipped_no_centroid += 1
                continue
        district = _assign_district(lon, lat, index)
        if not district:
            unassigned_district += 1
        feat = _normalize_feature(raw, year, district)
        if feat:
            features.append(feat)
        else:
            skipped_bad_geometry += 1

    print(
        f"==> RBG {year}: API returned {len(raw_features)} rows -> kept {len(features)} "
        f"(skipped {skipped_no_centroid} no-centroid, {skipped_bad_geometry} bad-geometry; "
        f"{unassigned_district} could not be assigned a district by polygon join)"
    )

    districts = sorted({f["properties"]["DISTRICT"] for f in features if f["properties"].get("DISTRICT")})
    collection = {
        "type": "FeatureCollection",
        "features": features,
        "properties": {
            "grid_type": "rbg_square",
            "year": year,
            "state": "HARYANA",
            "state_code": RBG_STATE_CODE,
            "cells": len(features),
            "districts": len(districts),
            "district_list": districts,
            "cell_diameter_km": 1.0,
            "distance_mode": "rbg_api",
            "source": RBG_GRID_URL,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "fetch_audit": {
                "api_rows": len(raw_features),
                "kept": len(features),
                "skipped_no_centroid": skipped_no_centroid,
                "skipped_bad_geometry": skipped_bad_geometry,
                "unassigned_district": unassigned_district,
            },
        },
    }
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(collection, f)
    os.replace(tmp, path)
    return collection


def get_grids(
    year: str | None = None,
    district: str | None = None,
    force: bool = False,
) -> dict[str, Any]:
    """Return a FeatureCollection for the year, optionally filtered by district."""
    year = _normalize_year(year)
    collection = build_collection(year, force=force)
    features = collection.get("features") or []

    if district:
        key = district.strip().upper()
        features = [
            f
            for f in features
            if str((f.get("properties") or {}).get("DISTRICT") or "").upper() == key
        ]

    districts = sorted(
        {
            str((f.get("properties") or {}).get("DISTRICT") or "")
            for f in features
            if (f.get("properties") or {}).get("DISTRICT")
        }
    )
    props = dict(collection.get("properties") or {})
    props.update(
        {
            "cells": len(features),
            "districts": len(districts),
            "district_list": districts,
            "filter_district": district.strip().upper() if district else None,
        }
    )
    return {"type": "FeatureCollection", "features": features, "properties": props}


def ensure_default_cache() -> None:
    """Best-effort prefetch of the default year (used at setup)."""
    try:
        build_collection(DEFAULT_YEAR, force=False)
        print(f"==> RBG grids cached for year {DEFAULT_YEAR}")
    except Exception as exc:
        print(f"!! RBG grid prefetch failed (will retry on first map request): {exc}")
