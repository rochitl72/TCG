# TCGA — frontend

This is the presentation half of the Trauma Care Gap Analysis app: the Jinja templates Flask renders, the JavaScript and CSS that run in the browser, and the nginx config that serves them.

**It does not run on its own.** There is no build step, no `package.json`, no dev server. It is one half of a single Flask service — to bring the whole stack up, follow [README.md § Deploying to a server](README.md#deploying-to-a-server) (git clone, for a server) or `HANDOFF.md` (the older two-zip route, for a laptop).

## Why it is a separate zip at all

The app is a single Flask service, but it has a real deployment seam. In `docker-compose.yml` the `frontend` service is an nginx container that serves the static assets itself and proxies everything else to gunicorn. Since the frontend became its own image (`frontend/Dockerfile`), those assets and `nginx/nginx.conf` are copied in at build time rather than bind-mounted from the host — so editing anything here needs a `docker compose build frontend` to appear in the production stack. Static assets never occupy a backend worker — which matters, because there are only four of them and a single analytics response can be several megabytes. So the files here are exactly the set nginx owns, plus the templates that produce the HTML those assets attach to.

## What is where

| Path | Notes |
|---|---|
| `dashboard/templates/network_analytics.html` | The entire single-page UI — every tab, panel and control. |
| `dashboard/templates/_rail.html`, `_app_header.html`, `_measure_panel.html` | Jinja partials included by the page above. |
| `dashboard/static/js/network_analytics.js` | The application. Map, tab routing, filters, layer toggles, popups, exports. This is where most frontend work happens. |
| `dashboard/static/js/charts.js` | Chart renderer — bars, scatter, radar. Marker shapes live in `shapeNode()`. |
| `dashboard/static/js/map_measure.js`, `radar_overlay.js` | Map measurement tool and the radar coverage overlay. |
| `dashboard/static/css/` | Split by area: `network_analytics.css` for the analytics page, `controls.css` for the sidebar, `popup_panes.css` for map popups, `charts.css`, `style.css`. |
| `dashboard/static/images/rbg-logo.png` | Referenced from `_rail.html`. |
| `nginx/nginx.conf` | Reverse proxy. Note the gzip block — the analytics JSON compresses about tenfold and this is the cheapest first-load win available. |

## Editing it

No compilation. Change a file, reload the page.

The one thing to know: **nginx serves `/static/` from a read-only bind mount**, so during the edit-reload loop your changes appear immediately, but nginx also sets `expires 1h`. If an edit does not show up, hard-reload (Ctrl+Shift+R) before assuming the change did not take.

Templates are rendered by Flask, not nginx, so a template edit needs the backend to pick it up — in the Docker stack that means `docker compose restart backend`.
