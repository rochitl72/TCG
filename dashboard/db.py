"""PostgreSQL + PostGIS database access for the dashboard."""

from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg2
from psycopg2.extras import RealDictCursor

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://mapsr:mapsr@localhost:5433/mapsr")


@contextmanager
def get_conn() -> Iterator[Any]:
    conn = psycopg2.connect(DATABASE_URL)
    try:
        yield conn
    finally:
        conn.close()


def fetch_one(query: str, params: tuple | dict | None = None) -> dict | None:
    with get_conn() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(query, params)
        row = cur.fetchone()
        return dict(row) if row else None


def fetch_all(query: str, params: tuple | dict | None = None) -> list[dict]:
    with get_conn() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(query, params)
        return [dict(row) for row in cur.fetchall()]


def states_geojson() -> dict:
    row = fetch_one(
        """
        SELECT json_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(json_agg(
                json_build_object(
                    'type', 'Feature',
                    'properties', json_build_object(
                        'STATE', "STATE",
                        'iradSTcode', "iradSTcode",
                        'iradSTname', "iradSTname"
                    ),
                    'geometry', ST_AsGeoJSON(geometry)::json
                )
            ), '[]'::json)
        ) AS collection
        FROM india_admin_boundary.state
        """
    )
    return row["collection"] if row else {"type": "FeatureCollection", "features": []}


def districts_geojson(state: str | None = None) -> dict:
    # Full India district set is 840 features with detailed geometry (~11MB serialized).
    # Most views in this app only ever need Haryana's 22 districts, so callers should
    # pass state="HARYANA" (or any state name) to scope the query and avoid generating
    # and shipping geometry nobody's going to render.
    where_sql = 'WHERE UPPER("STATE_UT") = UPPER(%(state)s)' if state else ""
    row = fetch_one(
        f"""
        SELECT json_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(json_agg(
                json_build_object(
                    'type', 'Feature',
                    'properties', json_build_object(
                        'OBJECTID', "OBJECTID",
                        'STATE_LGD', "STATE_LGD",
                        'DISTRICT', "DISTRICT",
                        'STATE_UT', "STATE_UT",
                        'Shape_Leng', "Shape_Leng",
                        'Shape_Area', "Shape_Area",
                        'Dist_LGD', "Dist_LGD",
                        'IRAD_ST_NAME', "IRAD_ST_NAME",
                        'IRAD_ST_CODE', "IRAD_ST_CODE",
                        'IRAD_DT_NAME', "IRAD_DT_NAME",
                        'IRAD_DT_CODE', "IRAD_DT_CODE"
                    ),
                    'geometry', ST_AsGeoJSON(geometry)::json
                )
            ), '[]'::json)
        ) AS collection
        FROM india_admin_boundary.district
        {where_sql}
        """,
        {"state": state},
    )
    return row["collection"] if row else {"type": "FeatureCollection", "features": []}


def summary_payload() -> dict:
    states = fetch_all(
        """
        SELECT
            s."STATE" AS name,
            s."iradSTcode" AS irad_code,
            s."iradSTname" AS irad_name,
            GREATEST(COALESCE(dc.cnt, 0), COALESCE(ic.cnt, 0)) AS district_count
        FROM india_admin_boundary.state s
        LEFT JOIN (
            SELECT "STATE_UT", COUNT(*) AS cnt
            FROM india_admin_boundary.district
            GROUP BY "STATE_UT"
        ) dc ON dc."STATE_UT" = s."STATE"
        LEFT JOIN (
            SELECT d."IRAD_ST_CODE", COUNT(*) AS cnt
            FROM india_admin_boundary.district d
            GROUP BY d."IRAD_ST_CODE"
        ) ic ON ic."IRAD_ST_CODE" = s."iradSTcode"
        ORDER BY s."STATE"
        """
    )

    districts = fetch_all(
        """
        SELECT
            "DISTRICT" AS district,
            "STATE_UT" AS state,
            "Dist_LGD" AS lgd,
            "IRAD_ST_CODE" AS irad_state_code,
            "IRAD_DT_CODE" AS irad_district_code,
            "IRAD_DT_NAME" AS irad_district_name
        FROM india_admin_boundary.district
        ORDER BY "STATE_UT", "DISTRICT"
        """
    )

    district_by_state: dict[str, list[dict]] = {}
    for row in districts:
        district_by_state.setdefault(row["state"] or "Unknown", []).append(row)

    state_count = fetch_one("SELECT COUNT(*) AS n FROM india_admin_boundary.state")["n"]
    district_count = fetch_one("SELECT COUNT(*) AS n FROM india_admin_boundary.district")["n"]

    payload = {
        "state_count": state_count,
        "district_count": district_count,
        "states": states,
        "districts_by_state": district_by_state,
        "districts": districts,
    }
    payload["geolocations"] = geolocations_summary()
    return payload


def grid_collection(
    grid_type: str,
    state: str | None = None,
    district: str | None = None,
    irad_code: str | None = None,
) -> dict:
    clauses = ["grid_type = %(grid_type)s"]
    params: dict[str, Any] = {"grid_type": grid_type}

    if district:
        clauses.append("district = %(district)s")
        params["district"] = district

    if state:
        if irad_code:
            clauses.append(
                """(
                    state_ut = %(state)s
                    OR state_ut IN (
                        SELECT "STATE_UT" FROM india_admin_boundary.district
                        WHERE "IRAD_ST_CODE" = %(irad_code)s
                    )
                )"""
            )
            params["irad_code"] = irad_code
        else:
            clauses.append("state_ut = %(state)s")
        params["state"] = state

    where_sql = "WHERE " + " AND ".join(clauses)

    meta = fetch_one(
        f"""
        SELECT
            COUNT(*) AS cells,
            COUNT(DISTINCT district || '::' || state_ut) AS districts
        FROM india_admin_boundary.grid_cell
        {where_sql}
        """,
        params,
    )

    row = fetch_one(
        f"""
        SELECT json_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(json_agg(
                json_build_object(
                    'type', 'Feature',
                    'properties', json_build_object(
                        'DISTRICT', district,
                        'STATE_UT', state_ut,
                        'grid_type', grid_type,
                        'cell_radius_m', cell_radius_m,
                        'cell_diameter_m', cell_radius_m * 2,
                        'cell_id', id::text
                    ),
                    'geometry', ST_AsGeoJSON(geometry)::json
                )
            ), '[]'::json)
        ) AS collection
        FROM india_admin_boundary.grid_cell
        {where_sql}
        """,
        params,
    )

    collection = row["collection"] if row else {"type": "FeatureCollection", "features": []}
    collection["properties"] = {
        "grid_type": grid_type,
        "districts": meta["districts"] if meta else 0,
        "cells": meta["cells"] if meta else 0,
        "cell_diameter_km": 10.0 if grid_type != "road" else None,
        "spacing_km": 10.0 if grid_type == "road" else None,
        "distance_mode": "road_network" if grid_type == "road" else "straight_line",
        "source": "postgis",
    }
    return collection


DISTRICT_ALIASES: dict[str, list[str]] = {
    "gurugram": ["gurugram", "gurgaon"],
    "hisar": ["hisar", "hissar"],
    "sonipat": ["sonipat", "sonepat"],
    "yamunanagar": ["yamunanagar", "yamuna nagar", "jagadhari"],
    "mahendragarh": ["mahendragarh", "narnaul"],
    "charkhi dadri": ["charkhi dadri"],
}


def _is_haryana_state(state: str | None) -> bool:
    if not state:
        return True
    return "haryana" in state.lower()


def _district_match_sql(column: str = "district_name") -> str:
    return f"""(
        %(district)s IS NULL
        OR LOWER(TRIM({column})) = LOWER(TRIM(%(district)s))
        OR LOWER(TRIM(%(district)s)) = 'gurugram' AND LOWER(TRIM({column})) IN ('gurugram', 'gurgaon')
        OR LOWER(TRIM(%(district)s)) = 'gurgaon' AND LOWER(TRIM({column})) IN ('gurugram', 'gurgaon')
        OR LOWER(TRIM(%(district)s)) = 'hisar' AND LOWER(TRIM({column})) IN ('hisar', 'hissar')
        OR LOWER(TRIM(%(district)s)) = 'hissar' AND LOWER(TRIM({column})) IN ('hisar', 'hissar')
        OR LOWER(TRIM(%(district)s)) IN ('sonipat', 'sonepat') AND LOWER(TRIM({column})) IN ('sonipat', 'sonepat')
        OR LOWER(TRIM(%(district)s)) IN ('yamunanagar', 'yamuna nagar') AND LOWER(TRIM({column})) IN ('yamunanagar', 'yamuna nagar', 'jagadhari')
        OR LOWER(TRIM(%(district)s)) = 'mahendragarh' AND LOWER(TRIM({column})) IN ('mahendragarh', 'narnaul')
        OR LOWER(TRIM(%(district)s)) = 'narnaul' AND LOWER(TRIM({column})) IN ('mahendragarh', 'narnaul')
        OR LOWER(TRIM(%(district)s)) IN ('nuh', 'mewat') AND LOWER(TRIM({column})) IN ('nuh', 'mewat')
        OR LOWER(TRIM(%(district)s)) IN ('charkhi dadri', 'charki dadri', 'dadri')
            AND LOWER(TRIM({column})) IN ('charkhi dadri', 'charki dadri', 'dadri')
    )"""


GEOLOCATION_LAYERS: dict[str, dict[str, Any]] = {
    "ambulance": {
        "table": "public.haryana_ambulance",
        "properties": [
            ("s_no", "s_no"),
            ("district_name", "district_name"),
            ("vehicle_no", "vehicle_no"),
            ("vehicle_make", "vehicle_make"),
            ("vehicle_type", "vehicle_type"),
            ("stationed_at", "stationed_at"),
            ("health_facility_name", "health_facility_name"),
        ],
        "label": "Ambulance",
    },
    "bloodbanks": {
        "table": "public.haryana_bloodbanks",
        "properties": [
            ("s_no", "s_no"),
            ("district_name", "district_name"),
            ("blood_centre_name", "blood_centre_name"),
            ("blood_centre_address", "blood_centre_address"),
        ],
        "label": "Blood bank",
    },
    "hospitals": {
        "table": "public.haryana_hosp",
        "properties": [
            ("s_no", "s_no"),
            ("district_name", "district_name"),
            ("hospital_name", "hospital_name"),
            ("hosp_type", "hosp_type"),
        ],
        "label": "Hospital",
    },
}


def geolocations_available() -> bool:
    row = fetch_one(
        """
        SELECT COUNT(*) AS n
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'haryana_ambulance'
        """
    )
    return bool(row and row["n"])


def geolocations_summary() -> dict:
    if not geolocations_available():
        return {"available": False, "state": "Haryana", "ambulance": 0, "bloodbanks": 0, "hospitals": 0}
    counts = fetch_one(
        """
        SELECT
            (SELECT COUNT(*) FROM public.haryana_ambulance) AS ambulance,
            (SELECT COUNT(*) FROM public.haryana_bloodbanks) AS bloodbanks,
            (SELECT COUNT(*) FROM public.haryana_hosp) AS hospitals
        """
    )
    return {
        "available": True,
        "state": "Haryana",
        "ambulance": counts["ambulance"] if counts else 0,
        "bloodbanks": counts["bloodbanks"] if counts else 0,
        "hospitals": counts["hospitals"] if counts else 0,
    }


def geolocation_geojson(
    layer: str,
    state: str | None = None,
    district: str | None = None,
) -> dict:
    if layer not in GEOLOCATION_LAYERS:
        return {"type": "FeatureCollection", "features": [], "error": "Unknown layer"}

    if not geolocations_available():
        return {"type": "FeatureCollection", "features": [], "error": "Geolocation data not loaded"}

    if not _is_haryana_state(state):
        return {
            "type": "FeatureCollection",
            "features": [],
            "properties": {"layer": layer, "count": 0, "note": "Data available for Haryana only"},
        }

    cfg = GEOLOCATION_LAYERS[layer]
    prop_sql = ", ".join(f"'{label}', {col}" for label, col in cfg["properties"])
    district_sql = _district_match_sql()

    row = fetch_one(
        f"""
        SELECT json_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(json_agg(
                json_build_object(
                    'type', 'Feature',
                    'properties', json_build_object(
                        {prop_sql},
                        'layer', '{layer}'
                    ),
                    'geometry', ST_AsGeoJSON(
                        ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)
                    )::json
                )
            ), '[]'::json)
        ) AS collection,
        COUNT(*) AS cnt
        FROM {cfg["table"]}
        WHERE latitude IS NOT NULL
          AND longitude IS NOT NULL
          AND {district_sql}
        """,
        {"district": district},
    )

    collection = row["collection"] if row else {"type": "FeatureCollection", "features": []}
    collection["properties"] = {
        "layer": layer,
        "count": row["cnt"] if row else 0,
        "state": "Haryana",
        "source": "latest data/geolocations latest.sql",
    }
    return collection
