/**
 * Multi-point distance tool for the trauma network map.
 *
 * Click as many points as you like: A, B, C, D... Each new point closes a leg
 * against the previous one, and the panel reports the cumulative straight-line
 * and road distance for the whole path plus a per-leg breakdown.
 *
 * Legs are measured independently against OSRM and summed, rather than asking
 * for one multi-waypoint route. That is deliberate — /api/measure/route is a
 * two-point endpoint, and summing legs is what "the path I clicked" actually
 * means. A single OSRM trip through all waypoints would be free to reorder or
 * smooth the path and would no longer answer the question the user asked.
 *
 * Each leg is cached by its coordinate pair, so undoing and re-adding a point
 * costs nothing.
 */
function initMapMeasure(map) {
  const toggle = document.getElementById("measure-toggle");
  const statusEl = document.getElementById("measure-status");
  const resultsEl = document.getElementById("measure-results");
  const straightEl = document.getElementById("measure-straight");
  const roadEl = document.getElementById("measure-road");
  const durationEl = document.getElementById("measure-duration");
  const pointsEl = document.getElementById("measure-points");
  const legsWrap = document.getElementById("measure-legs-wrap");
  const legsEl = document.getElementById("measure-legs");
  const reasonEl = document.getElementById("measure-reason");
  const clearBtn = document.getElementById("measure-clear");
  const undoBtn = document.getElementById("measure-undo");
  const mapEl = document.getElementById("map");

  if (!toggle || !map) return;

  let active = false;
  let points = [];
  let markers = [];
  let straightLines = [];
  let roadLines = [];
  // One permanent tooltip per leg, sitting on the leg it describes, so the
  // numbers are readable without cross-referencing the sidebar table. Kept in
  // its own array (not on the polyline) because the straight line is drawn
  // immediately on click while the road line only arrives after OSRM answers —
  // the label has to survive that gap and then be rewritten in place.
  let legLabels = [];
  let legs = []; // { straightKm, roadKm, durationS, ok }
  // The last reason OSRM gave for not returning a road distance. Held on the
  // module rather than per-leg because every leg fails for the same reason when
  // the router is down, and three copies of "cannot reach OSRM" is noise.
  let lastReason = "";
  const legCache = new Map();
  let seq = 0; // guards against out-of-order responses when clicking fast

  const measurePane = map.createPane("measurePane");
  measurePane.style.zIndex = 650;

  const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const labelFor = (i) => (i < 26 ? LABELS[i] : `P${i + 1}`);

  function setStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle("error", Boolean(isError));
  }

  function formatKm(km) {
    if (km == null || Number.isNaN(km)) return "—";
    return `${Number(km).toFixed(2)} km`;
  }

  function formatDuration(seconds) {
    if (seconds == null || Number.isNaN(seconds)) return "—";
    const s = Math.round(seconds);
    if (s < 60) return `${s} sec`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m < 60) return rem ? `${m} min ${rem} sec` : `${m} min`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `${h} hr ${rm} min` : `${h} hr`;
  }

  function haversineKm(a, b) {
    const R = 6371.0088;
    const p1 = (a.lat * Math.PI) / 180;
    const p2 = (b.lat * Math.PI) / 180;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lng - a.lng) * Math.PI) / 180;
    const x =
      Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function pointMarker(latlng, i) {
    const label = labelFor(i);
    return L.circleMarker(latlng, {
      pane: "measurePane",
      radius: 7,
      color: "#0f172a",
      weight: 2,
      fillColor: i === 0 ? "#2563eb" : "#dc2626",
      fillOpacity: 1,
    }).bindTooltip(label, {
      permanent: true,
      direction: "top",
      offset: [0, -8],
      className: "measure-point-label",
    });
  }

  function removeLayers(arr) {
    arr.forEach((l) => map.removeLayer(l));
    arr.length = 0;
  }

  /**
   * Draw (or redraw) the on-map label for one leg.
   *
   * Anchored to the ROAD line's own midpoint when the geometry has arrived, so
   * the label sits on the path it is describing rather than floating out in the
   * field the straight line cuts across — on a leg that detours around a canal
   * those are kilometres apart. Falls back to the straight-line midpoint until
   * then, which is also the permanent position when OSRM has no answer.
   *
   * Both numbers are always shown together: the whole point of the tool is the
   * gap between them, and a single figure on the map invites reading a detour
   * as the crow-flies distance.
   */
  function legMidpoint(legIndex) {
    const line = roadLines[legIndex];
    if (line) {
      const pts = [];
      line.eachLayer?.((l) => {
        const ll = l.getLatLngs?.();
        if (Array.isArray(ll)) pts.push(...ll.flat(Infinity));
      });
      if (pts.length) return pts[Math.floor(pts.length / 2)];
    }
    const a = points[legIndex];
    const b = points[legIndex + 1];
    if (!a || !b) return null;
    return L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
  }

  function renderLegLabel(legIndex) {
    const leg = legs[legIndex];
    const at = legMidpoint(legIndex);
    if (!leg || !at) return;

    /* "outside routing area" rather than a bare "road n/a" for an off-graph
       leg. The two failures need telling apart on the map itself: a dead router
       is temporary and affects every leg, while an off-graph point is this leg,
       permanently, and the fix is to click somewhere else. */
    const road = leg.pending
      ? '<span class="ml-wait">road…</span>'
      : leg.ok
      ? `<span class="ml-road">${formatKm(leg.roadKm)} road</span>`
      : leg.offGraph
      ? '<span class="ml-none">outside routing area</span>'
      : '<span class="ml-none">road n/a</span>';
    const html =
      `<span class="ml-leg">${labelFor(legIndex)}&rarr;${labelFor(legIndex + 1)}</span>` +
      `<span class="ml-straight">${formatKm(leg.straightKm)} straight</span>` +
      road;

    if (legLabels[legIndex]) {
      legLabels[legIndex].setLatLng(at).setContent(html);
      return;
    }
    legLabels[legIndex] = L.tooltip({
      permanent: true,
      // Floated ABOVE the midpoint, not centred on it: centred, the card sits
      // squarely on the road polyline it is quoting and hides the very detour
      // that explains the number.
      direction: "top",
      offset: [0, -9],
      className: "measure-leg-label",
      pane: "measurePane",
      interactive: false,
    })
      .setLatLng(at)
      .setContent(html)
      .addTo(map);
  }

  function clearMeasurement() {
    seq += 1;
    points = [];
    legs = [];
    removeLayers(markers);
    removeLayers(straightLines);
    removeLayers(roadLines);
    removeLayers(legLabels);
    if (resultsEl) resultsEl.classList.add("hidden");
    if (legsWrap) legsWrap.classList.add("hidden");
    if (straightEl) straightEl.textContent = "—";
    if (roadEl) roadEl.textContent = "—";
    if (durationEl) durationEl.textContent = "—";
    if (pointsEl) pointsEl.textContent = "0";
    if (legsEl) legsEl.innerHTML = "";
    lastReason = "";
    if (reasonEl) {
      reasonEl.textContent = "";
      reasonEl.classList.add("hidden");
    }
    if (clearBtn) clearBtn.disabled = true;
    if (undoBtn) undoBtn.disabled = true;
    if (active) setStatus("Click the first point on the map.");
  }

  function undoLastPoint() {
    if (!points.length) return;
    seq += 1;
    points.pop();
    const m = markers.pop();
    if (m) map.removeLayer(m);
    if (straightLines.length) {
      const l = straightLines.pop();
      if (l) map.removeLayer(l);
    }
    if (roadLines.length) {
      const l = roadLines.pop();
      if (l) map.removeLayer(l);
    }
    if (legLabels.length) {
      const l = legLabels.pop();
      if (l) map.removeLayer(l);
    }
    legs.pop();
    if (!points.length) return clearMeasurement();
    renderTotals();
    setStatus(
      points.length === 1
        ? "Click the next point to start measuring."
        : `${points.length} points · click to extend, or undo again.`
    );
  }

  function renderTotals() {
    const straightKm = legs.reduce((s, l) => s + (l.straightKm || 0), 0);
    const anyRoad = legs.some((l) => l.ok);
    const allRoad = legs.length > 0 && legs.every((l) => l.ok);
    const roadKm = legs.reduce((s, l) => s + (l.ok ? l.roadKm : 0), 0);
    const durS = legs.reduce((s, l) => s + (l.ok ? l.durationS || 0 : 0), 0);
    const pending = legs.some((l) => l.pending);

    if (pointsEl) pointsEl.textContent = String(points.length);
    if (straightEl) straightEl.textContent = formatKm(straightKm);

    // Redraw every on-map label: a leg that was "road…" a moment ago may have
    // just resolved, and the road geometry it now has also moves the anchor.
    legs.forEach((_, i) => renderLegLabel(i));

    if (roadEl) {
      if (pending) roadEl.textContent = "Loading…";
      else if (!anyRoad) roadEl.textContent = "Unavailable";
      else roadEl.textContent = allRoad ? formatKm(roadKm) : `${formatKm(roadKm)} (partial)`;
    }

    /* "Unavailable" on its own sent the user hunting through the UI for a
       setting that does not exist — the cause is always OSRM, and the server
       now names it. Print that verbatim under the totals, once, rather than
       making a dead router look like a broken feature. */
    if (reasonEl) {
      const show = !pending && !allRoad && lastReason;
      reasonEl.textContent = show ? lastReason : "";
      reasonEl.classList.toggle("hidden", !show);
    }
    if (durationEl) {
      durationEl.textContent = pending ? "Loading…" : anyRoad ? formatDuration(durS) : "—";
    }

    if (resultsEl) resultsEl.classList.toggle("hidden", legs.length === 0);
    if (clearBtn) clearBtn.disabled = points.length === 0;
    if (undoBtn) undoBtn.disabled = points.length === 0;

    if (legsEl) {
      if (!legs.length) {
        if (legsWrap) legsWrap.classList.add("hidden");
        legsEl.innerHTML = "";
        return;
      }
      if (legsWrap) legsWrap.classList.remove("hidden");
      legsEl.innerHTML = `
        <thead><tr><th>Leg</th><th class="num">Straight</th><th class="num">Road</th><th class="num">Time</th></tr></thead>
        <tbody>${legs
          .map(
            (l, i) => `<tr>
              <td>${labelFor(i)}&nbsp;&rarr;&nbsp;${labelFor(i + 1)}</td>
              <td class="num">${formatKm(l.straightKm)}</td>
              <td class="num">${
                l.pending ? "…"
                : l.ok ? formatKm(l.roadKm)
                : l.offGraph
                  ? `<span title="Nearest road in the graph is ${formatKm(l.snapKm)} away">off&nbsp;graph</span>`
                  : "—"
              }</td>
              <td class="num">${l.pending ? "…" : l.ok ? formatDuration(l.durationS) : "—"}</td>
            </tr>`
          )
          .join("")}</tbody>
        <tfoot><tr>
          <th>Total</th>
          <th class="num">${formatKm(straightKm)}</th>
          <th class="num">${pending ? "…" : anyRoad ? formatKm(roadKm) : "—"}</th>
          <th class="num">${pending ? "…" : anyRoad ? formatDuration(durS) : "—"}</th>
        </tr></tfoot>`;
    }
  }

  async function measureLeg(a, b, legIndex, mySeq) {
    const straightKm = haversineKm(a, b);
    legs[legIndex] = { straightKm, roadKm: null, durationS: null, ok: false, pending: true };
    renderTotals();

    const key = `${a.lat.toFixed(5)},${a.lng.toFixed(5)}|${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;
    let data = legCache.get(key);

    if (!data) {
      const params = new URLSearchParams({
        lat1: String(a.lat), lon1: String(a.lng),
        lat2: String(b.lat), lon2: String(b.lng),
      });
      try {
        const resp = await fetch(`/api/measure/route?${params}`);
        data = await resp.json();
        if (!resp.ok) throw new Error(data.error || "Route request failed");
        legCache.set(key, data);
      } catch (err) {
        console.error(err);
        if (mySeq !== seq) return;
        // The request itself failed (server down, 500). Distinguish that from
        // OSRM answering with a failure, which arrives on the success path.
        lastReason =
          (data && data.reason) ||
          `The dashboard could not reach /api/measure/route (${err.message}).`;
        legs[legIndex] = { straightKm, roadKm: null, durationS: null, ok: false, pending: false };
        renderTotals();
        setStatus("Straight-line shown; road route could not be loaded for one leg.", true);
        return;
      }
    }

    // A clear/undo landed while this was in flight — drop the result.
    if (mySeq !== seq) return;

    // OSRM answered and declined — the server names why. Clear it on success so
    // a recovered router does not leave a stale complaint on screen.
    lastReason = data.osrm_ok ? "" : data.reason || lastReason;

    legs[legIndex] = {
      straightKm: data.straight_km ?? straightKm,
      roadKm: data.road_km,
      durationS: data.duration_s,
      ok: Boolean(data.osrm_ok),
      // Carried so the on-map label can name THIS failure rather than the
      // generic one — see renderLegLabel.
      offGraph: Boolean(data.off_graph),
      snapKm: data.snap_km ?? null,
      pending: false,
    };

    if (data.route_geometry) {
      const line = L.geoJSON(data.route_geometry, {
        pane: "measurePane",
        style: { color: "#0d9488", weight: 4, opacity: 0.95 },
      }).addTo(map);
      roadLines[legIndex] = line;
    }

    renderTotals();
    setStatus(`${points.length} points · ${legs.length} leg${legs.length === 1 ? "" : "s"} measured. Click to extend the path.`);
  }

  function onMapClick(e) {
    if (!active) return;
    L.DomEvent.stop(e);

    const latlng = e.latlng;
    const idx = points.length;
    points.push(latlng);
    markers.push(pointMarker(latlng, idx).addTo(map));

    if (idx === 0) {
      renderTotals();
      setStatus("Click the next point. Keep clicking to add more.");
      return;
    }

    const a = points[idx - 1];
    const b = latlng;
    straightLines.push(
      L.polyline([a, b], {
        pane: "measurePane",
        color: "#64748b",
        weight: 2,
        dashArray: "8 6",
        opacity: 0.9,
      }).addTo(map)
    );

    measureLeg(a, b, idx - 1, seq);
  }

  function setActive(on) {
    active = on;
    mapEl?.classList.toggle("measure-active", on);
    if (on) {
      map.on("click", onMapClick);
      clearMeasurement();
      setStatus("Click the first point on the map.");
    } else {
      map.off("click", onMapClick);
      clearMeasurement();
      setStatus("Off — enable, then click points to build a path.");
    }
  }

  toggle.addEventListener("change", () => setActive(toggle.checked));
  clearBtn?.addEventListener("click", () => {
    clearMeasurement();
    if (active) setStatus("Click the first point on the map.");
  });
  undoBtn?.addEventListener("click", undoLastPoint);

  // Escape finishes the path without clearing it; handy mid-demo.
  document.addEventListener("keydown", (e) => {
    if (!active) return;
    if (e.key === "Escape") {
      toggle.checked = false;
      setActive(false);
    }
  });
}
