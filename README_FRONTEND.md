# TCGA — frontend

This is the presentation half of the Trauma Care Gap Analysis app: the Jinja templates Flask renders, the JavaScript and CSS that run in the browser, and the nginx config that serves them.

**It does not run on its own.** There is no build step, no `package.json`, no dev server. Extract this zip and `tcga-backend.zip` into the same folder and follow `HANDOFF.md` from the backend zip — the setup there brings up the whole stack, this half included.

## Why it is a separate zip at all

The app is a single Flask service, but it has a real deployment seam. In `docker-compose.yml` the `frontend` service is an nginx container that serves `dashboard/static/` directly off disk and proxies everything else to gunicorn. Static assets never occupy a backend worker — which matters, because there are only four of them and a single analytics response can be several megabytes. So the files here are exactly the set nginx owns, plus the templates that produce the HTML those assets attach to.

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
