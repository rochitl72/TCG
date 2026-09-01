# Backend image for the TCGA (Trauma Care Gap Analysis) Flask app.
# Build context is the repo root (see docker-compose.yml), because the app
# reads/writes ../data relative to this file.
FROM python:3.11-slim

# osmnx pulls in geopandas, which needs GEOS/GDAL/PROJ at build time even
# though recent geopandas wheels bundle most of this — installing the system
# libs too avoids surprise build failures on architectures without a
# prebuilt wheel.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    gdal-bin libgdal-dev \
    libgeos-dev \
    proj-bin libproj-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

COPY dashboard/ ./dashboard/

# The build scripts ship with the image so artifacts can be regenerated inside
# the container. Without them a fresh deploy has no way to produce
# data/hospital_tpl.csv or data/analytics/*.json, and the analytics pages come
# up empty with a "run the precompute first" error. See README.md > Deploying.
COPY scripts/ ./scripts/

WORKDIR /app/dashboard

EXPOSE 5050

# python-slim has no curl or wget, so probe with the interpreter that is
# already here. Hitting a real route proves the app booted AND that its
# imports resolved, which a TCP check would not.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5050/api/geolocations', timeout=8).status==200 else 1)"

# --timeout is generous on purpose: grid/road analyses make live OSRM calls
# per cell and can legitimately take up to ~1-2 minutes on first load for a
# district (see grid_analysis.js / road_grid_generator.py). The Flask dev
# server used in local development has no such timeout; gunicorn's default
# (30s) would otherwise kill the worker mid-request in production.
CMD ["gunicorn", "--bind", "0.0.0.0:5050", "--workers", "4", "--timeout", "300", "app:app"]
