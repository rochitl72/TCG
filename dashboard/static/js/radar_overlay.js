/**
 * Radar-style range visualisation for the trauma network map.
 *
 * Draws concentric labelled distance rings around an origin (a hospital on the
 * Proximity tab, a gap cell on the Gaps tab), a compass graticule, and an
 * animated sweep arm. The point is to make "how far is 30 km from here" legible
 * at a glance instead of something the viewer has to infer from a colour ramp.
 *
 * Rings are true ground distance, not pixels: L.circle takes metres and Leaflet
 * projects it, so a 60 km ring stays 60 km at every zoom level. That matters —
 * a fixed-pixel ring would quietly lie as soon as anyone zoomed.
 *
 * The sweep is a canvas-free SVG wedge rotated by requestAnimationFrame. It
 * lives in its own pane below the markers so it never eats clicks.
 */

function createRadarOverlay(map, opts = {}) {
  const paneName = opts.pane || "radarPane";
  if (!map.getPane(paneName)) {
    const p = map.createPane(paneName);
    p.style.zIndex = 420; // above tiles + grid dots, below markers and popups
    p.style.pointerEvents = "none";
  }

  const group = L.layerGroup([], { pane: paneName });
  const BEARINGS = [
    ["N", 0], ["NE", 45], ["E", 90], ["SE", 135],
    ["S", 180], ["SW", 225], ["W", 270], ["NW", 315],
  ];

  let origin = null;
  let rings = [];
  // Cells currently tracked by the outward glow, so hide() can put every one
  // of them back to the style it borrowed them at.
  const glowed = [];
  let glowState = null;
  let glowRaf = null;
  let sweepEl = null;
  let sweepAngle = 0;
  let rafId = null;
  let animate = opts.animate !== false;
  let visible = false;

  const COLOR = opts.color || "#0d9488";

  function destinationPoint(from, bearingDeg, km) {
    // Great-circle offset. Used for the graticule spokes and label anchors so
    // they land exactly on the ring rather than near it.
    const R = 6371.0088;
    const brng = (bearingDeg * Math.PI) / 180;
    const lat1 = (from.lat * Math.PI) / 180;
    const lon1 = (from.lng * Math.PI) / 180;
    const dr = km / R;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(brng)
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(brng) * Math.sin(dr) * Math.cos(lat1),
        Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2)
      );
    return L.latLng((lat2 * 180) / Math.PI, (((lon2 * 180) / Math.PI + 540) % 360) - 180);
  }

  function clear() {
    stopSweep();
    group.clearLayers();
    rings = [];
    sweepEl = null;
  }

  function stopSweep() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  /**
   * An outward PULSE, not a rotating arm.
   *
   * The old sweep was a wedge spinning at 55°/sec — visually busy, and it said
   * something untrue: a rotating beam implies the range is being scanned
   * directionally, when reach here is the same in every direction. A ring
   * travelling outward and thinning as it goes is the honest shape of the
   * thing being drawn, and it makes distance the subject rather than motion.
   *
   * Both radius and opacity are driven from one eased progress value, so the
   * ring genuinely dissolves as it travels instead of popping at the edge.
   * Two rings are kept a half-cycle apart so the motion reads as continuous
   * without either one demanding attention.
   */
  function buildSweep(maxKm) {
    if (!animate || !origin) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const PULSES = 2;
    const PERIOD_MS = 3400;
    const pulses = [];

    for (let i = 0; i < PULSES; i += 1) {
      const c = L.circle(origin, {
        pane: paneName,
        radius: 0,
        color: COLOR,
        weight: 1.6,
        opacity: 0,
        fill: true,
        fillColor: COLOR,
        fillOpacity: 0,
        interactive: false,
        className: "radar-pulse",
      });
      group.addLayer(c);
      pulses.push({ layer: c, phase: i / PULSES });
    }
    sweepEl = pulses[0].layer;

    const start = performance.now();

    function frame(now) {
      const base = ((now - start) % PERIOD_MS) / PERIOD_MS;
      pulses.forEach((p) => {
        const t = (base + p.phase) % 1;
        // easeOutCubic: quick away from the centre, slow at the rim — reads as
        // something propagating rather than a circle being scaled.
        const eased = 1 - Math.pow(1 - t, 3);
        p.layer.setRadius(eased * maxKm * 1000);
        // Fades on a curve, not linearly: a linear fade still has visible ink
        // at 80% of the way out and the rim looks like a hard edge.
        const fade = Math.pow(1 - t, 1.8);
        p.layer.setStyle({
          opacity: 0.55 * fade,
          fillOpacity: 0.07 * fade,
        });
      });
      rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);
  }

  /**
   * @param {L.LatLng|Array} at      centre of the radar
   * @param {Array<{km:number,label?:string,color?:string}>} ranges  rings to draw
   */
  function show(at, ranges) {
    clear();
    origin = L.latLng(at);
    const bands = (ranges || [])
      .filter((r) => r && Number.isFinite(r.km) && r.km > 0)
      .sort((a, b) => a.km - b.km);
    if (!bands.length) return;

    const maxKm = bands[bands.length - 1].km;

    // Graticule spokes first so rings and labels paint over them.
    BEARINGS.forEach(([name, deg]) => {
      group.addLayer(
        L.polyline([origin, destinationPoint(origin, deg, maxKm)], {
          pane: paneName,
          color: COLOR,
          weight: 1,
          opacity: 0.22,
          dashArray: "4 7",
          interactive: false,
        })
      );
      group.addLayer(
        L.marker(destinationPoint(origin, deg, maxKm * 1.045), {
          pane: paneName,
          interactive: false,
          icon: L.divIcon({
            className: "radar-bearing",
            html: `<span>${name}</span>`,
            iconSize: [26, 14],
            iconAnchor: [13, 7],
          }),
        })
      );
    });

    bands.forEach((band, i) => {
      /* Rings THIN as they get further out. The old set drew every ring at the
         same 0.75 stroke, which made the 60 km circle shout as loudly as the
         10 km one and turned the whole thing into a bullseye. Weight and
         opacity both fall with distance, so the eye starts at the origin and
         travels out — which is the direction the information runs.

         Fill falls faster than stroke: stacked translucent discs otherwise
         accumulate into a muddy blob in the centre where three of them
         overlap. */
      const depth = bands.length > 1 ? i / (bands.length - 1) : 0;
      const ring = L.circle(origin, {
        pane: paneName,
        radius: band.km * 1000,
        color: band.color || COLOR,
        weight: 1.7 - depth * 0.7,
        opacity: 0.8 - depth * 0.42,
        fill: true,
        fillColor: band.color || COLOR,
        fillOpacity: 0.06 * (1 - depth * 0.75),
        dashArray: band.dash || null,
        interactive: false,
      });
      group.addLayer(ring);
      rings.push(ring);

      // Label sits due east on the ring itself, so the number is unambiguous
      // about which circle it belongs to.
      group.addLayer(
        L.marker(destinationPoint(origin, 90, band.km), {
          pane: paneName,
          interactive: false,
          icon: L.divIcon({
            className: "radar-ring-label",
            html: `<span style="border-color:${band.color || COLOR}">${
              band.label || `${band.km} km`
            }</span>`,
            iconSize: [64, 18],
            iconAnchor: [32, 9],
          }),
        })
      );
    });

    // Centre pip.
    group.addLayer(
      L.circleMarker(origin, {
        pane: paneName,
        radius: 4,
        color: COLOR,
        weight: 2,
        fillColor: "#fff",
        fillOpacity: 1,
        interactive: false,
      })
    );

    buildSweep(maxKm);
    glowGrids(maxKm);
    if (!visible) {
      group.addTo(map);
      visible = true;
    }
  }

  /**
   * Light the grid cells as the pulse reaches them, then let them settle back.
   *
   * The delay on each cell is its OWN distance from the origin, so the glow
   * travels outward at the same speed as the ring and the two read as one
   * event rather than two animations that happen to be running together. A
   * uniform delay would have made every cell flash at once, which says nothing
   * about distance — the whole point here.
   *
   * Purely decorative and purely additive: it brightens shapes that are
   * already drawn, touches no data, and restores every one of them on hide().
   * If the grid layer is absent or motion is reduced, nothing happens.
   */
  function glowGrids(maxKm) {
    clearGlow();
    if (!origin || !opts.gridLayers) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const cells = opts.gridLayers();
    if (!cells || !cells.size) return;

    /* WHY THIS IS NOT A CSS ANIMATION.
       The map runs with preferCanvas:true, so a grid cell is a shape drawn on
       a canvas, not an SVG path — shape.getElement() is null and there is no
       node to put a class or an animation-delay on. The wave therefore has to
       be driven from JS by restyling the layers themselves.

       That is cheap done this way: Leaflet's canvas renderer batches every
       setStyle in a frame into ONE redraw, and the two-pointer window below
       only touches the cells the wave front is currently crossing — a few
       dozen per frame, not all 6,760. */
    const list = [];
    cells.forEach((rec) => {
      const g = rec.g || rec;
      if (!rec.shape?.setStyle || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) return;
      const km = origin.distanceTo(L.latLng(g.lat, g.lon)) / 1000;
      if (km > maxKm) return;
      list.push({ shape: rec.shape, t: km / maxKm, on: false });
    });
    if (!list.length) return;
    list.sort((a, b) => a.t - b.t);

    glowState = { list, head: 0, tail: 0, start: performance.now() };
    glowed.push(...list);
    stepGlow();
  }

  // Half-width of the lit band, as a fraction of the full radius. Wide enough
  // to read as a wave with a soft edge, narrow enough that only a slice of the
  // map is lit at any moment.
  const GLOW_BAND = 0.07;

  function stepGlow() {
    if (!glowState) return;
    const { list } = glowState;
    const t = (((performance.now() - glowState.start) % 3400) / 3400);
    // Same easing as the pulse, so the light and the ring stay together.
    const wave = 1 - Math.pow(1 - t, 3);

    const lo = wave - GLOW_BAND;
    const hi = wave + GLOW_BAND;

    // The window only ever moves forward within a cycle; when it wraps, reset
    // both pointers and darken whatever was still lit.
    if (hi < glowState.lastHi) {
      list.forEach((c) => { if (c.on) { c.shape.setStyle({ opacity: c.o0, fillOpacity: c.f0 }); c.on = false; } });
      glowState.head = 0;
      glowState.tail = 0;
    }
    glowState.lastHi = hi;

    while (glowState.head < list.length && list[glowState.head].t <= hi) {
      const c = list[glowState.head];
      if (!c.on) {
        const o = c.shape.options;
        c.o0 = o.opacity ?? 1;
        c.f0 = o.fillOpacity ?? 0;
        c.shape.setStyle({ opacity: 1, fillOpacity: Math.min(1, (c.f0 || 0.3) + 0.45) });
        c.on = true;
      }
      glowState.head += 1;
    }
    while (glowState.tail < glowState.head && list[glowState.tail].t < lo) {
      const c = list[glowState.tail];
      if (c.on) {
        c.shape.setStyle({ opacity: c.o0, fillOpacity: c.f0 });
        c.on = false;
      }
      glowState.tail += 1;
    }
    glowRaf = requestAnimationFrame(stepGlow);
  }

  function clearGlow() {
    if (glowRaf !== null) {
      cancelAnimationFrame(glowRaf);
      glowRaf = null;
    }
    // Restore anything mid-glow, or cells keep a brightness that no longer
    // means anything once the radar is off.
    glowed.forEach((c) => {
      if (c.on && c.shape?.setStyle) c.shape.setStyle({ opacity: c.o0, fillOpacity: c.f0 });
    });
    glowed.length = 0;
    glowState = null;
  }

  function hide() {
    clear();
    clearGlow();
    if (visible) {
      map.removeLayer(group);
      visible = false;
    }
    origin = null;
  }

  function setAnimate(on) {
    animate = Boolean(on);
    // Cheapest correct approach: re-run show() with what we already have.
    if (!origin) return;
    const bands = rings.map((r) => ({ km: r.getRadius() / 1000 }));
    if (bands.length) show(origin, bands);
  }

  // Pausing while the tab is hidden keeps the sweep from burning a core in the
  // background during a long demo.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopSweep();
    else if (visible && animate && origin && rafId === null && rings.length) {
      buildSweep(Math.max(...rings.map((r) => r.getRadius() / 1000)));
    }
  });

  return { show, hide, setAnimate, isVisible: () => visible, getOrigin: () => origin };
}
