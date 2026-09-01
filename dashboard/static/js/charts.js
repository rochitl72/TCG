/* ==========================================================================
   charts.js — dependency-free inline-SVG charts for Trauma Network Analytics
   ==========================================================================

   Everything renders into a 306px-ish sidebar column, so every form here is
   built for a narrow container: horizontal bars rather than vertical, viewBox
   scaling rather than fixed pixels, labels outside marks rather than inside.

   PALETTE — validated, not eyeballed.
   The level hues are entity colours: L1/L2/L3 mean the same thing on the map,
   in the legend and in every chart, so they are declared once here and the map
   reads them back. The old triplet (violet / blue / teal) failed CVD hard —
   violet #7c3aed against blue #2563eb measures deltaE 0.4 under deuteranopia and
   12.4 for normal vision, i.e. the two levels were effectively one colour for
   a red-green colourblind viewer. Swapping L2 to orange keeps L1 and L3 exactly
   as they were and lifts the worst pair to 10.7 (CVD) / 27.5 (normal vision),
   clear of the 8 / 15 floors on all three pairs.

   Marks follow one spec throughout: 2px lines, 4px rounded data-ends anchored
   to the baseline, a 2px surface gap between adjacent fills, hairline solid
   gridlines one shade off the surface, and text in ink tokens — never in the
   series colour.
   ========================================================================== */

const VIZ = {
  surface: "#ffffff",
  ink: "#1e293b",
  ink2: "#52514e",
  muted: "#898781",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  track: "#eef2f6",
  // Single-series magnitude. One colour for every bar — never a ramp keyed to
  // bar length, which would double-encode what the length already says.
  series: "#2563eb",
  seriesSoft: "#9ec5f4",
  // Entity colours for the three service levels.
  level: { L1: "#7c3aed", L2: "#eb6834", L3: "#0d9488" },
  // Reserved status tokens. Never reused as "series 4".
  status: { good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" },
};

const NS = "http://www.w3.org/2000/svg";

function el(name, attrs = {}, text = null) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    n.setAttribute(k, String(v));
  }
  if (text !== null) n.textContent = text;
  return n;
}

/* ---------- shared tooltip ------------------------------------------------
   One node for the whole page. Tooltips enhance; they never gate a value —
   every chart below has a table or a direct label carrying the same numbers. */
let _tip = null;
function tip() {
  if (!_tip) {
    _tip = document.createElement("div");
    _tip.className = "viz-tip";
    document.body.appendChild(_tip);
  }
  return _tip;
}
function showTip(html, evt) {
  const t = tip();
  t.innerHTML = html;
  t.classList.add("on");
  const pad = 12;
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  const r = t.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${Math.max(8, y)}px`;
}
function hideTip() {
  if (_tip) _tip.classList.remove("on");
}

/* Attach hover + keyboard focus to a mark. Focus shows exactly what hover
   shows, so a keyboard reader is never worse off than a mouse reader. */
function hoverable(node, html) {
  node.setAttribute("tabindex", "0");
  node.addEventListener("mousemove", (e) => showTip(html, e));
  node.addEventListener("mouseleave", hideTip);
  node.addEventListener("focus", (e) => {
    const b = node.getBoundingClientRect();
    showTip(html, { clientX: b.left + b.width / 2, clientY: b.top });
  });
  node.addEventListener("blur", hideTip);
  return node;
}

function svgRoot(host, w, h) {
  host.innerHTML = "";
  const s = el("svg", {
    viewBox: `0 0 ${w} ${h}`,
    width: "100%",
    height: h,
    class: "viz",
    role: "img",
    preserveAspectRatio: "xMidYMid meet",
  });
  host.appendChild(s);
  return s;
}

function emptyState(host, msg) {
  host.innerHTML = `<p class="viz-empty">${msg}</p>`;
}

function fmtN(n, d = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function truncate(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/* ==========================================================================
   1. Horizontal ranked bar — the workhorse for "compare magnitude"
   ==========================================================================
   Single series, single hue. Optional `note` per row renders as a selective
   direct label to the right of the bar end, so a second measure (severity
   share) can travel with the bar WITHOUT a second axis. */
function vizBarH(host, opts) {
  const rows = (opts.rows || []).slice(0, opts.limit || 12);
  if (!rows.length) return emptyState(host, opts.empty || "No rows to plot.");

  const labelW = opts.labelWidth || 92;
  const noteW = rows.some((r) => r.note) ? opts.noteWidth || 62 : 0;
  const w = 306;
  const rowH = 22;
  const gap = 6; // 2px surface gap is the minimum; 6 reads better at this size
  const top = 6;
  const h = top + rows.length * rowH + 4;
  const plotL = labelW + 6;
  const plotW = w - plotL - noteW - 6;

  const max = niceMax(Math.max(...rows.map((r) => r.value || 0)));
  const s = svgRoot(host, w, h);
  s.setAttribute("aria-label", opts.aria || opts.title || "Ranked bar chart");

  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const bh = rowH - gap;
    const bw = Math.max(1.5, (plotW * (r.value || 0)) / max);
    const colour = r.color || opts.color || VIZ.series;

    // Track: shows the row's share of the leader without a second scale.
    s.appendChild(
      el("rect", { x: plotL, y, width: plotW, height: bh, rx: 3, fill: VIZ.track })
    );
    const bar = el("rect", {
      x: plotL,
      y,
      width: bw,
      height: bh,
      rx: 4,
      fill: colour,
      class: "viz-mark",
    });
    s.appendChild(
      hoverable(
        bar,
        `<b>${r.label}</b><br/>${opts.valueLabel || "Value"}: ${fmtN(r.value, opts.decimals ?? 0)}` +
          (r.tipExtra ? `<br/>${r.tipExtra}` : "")
      )
    );

    s.appendChild(
      el(
        "text",
        {
          x: labelW,
          y: y + bh / 2 + 4,
          "text-anchor": "end",
          class: "viz-lab",
          fill: VIZ.ink2,
        },
        truncate(r.label, opts.labelChars || 14)
      )
    );

    if (r.note) {
      s.appendChild(
        el(
          "text",
          { x: w - 4, y: y + bh / 2 + 4, "text-anchor": "end", class: "viz-note", fill: VIZ.muted },
          r.note
        )
      );
    } else if (opts.valueInline !== false) {
      // Value sits just past the bar end, clear of the fill — never inside a
      // short bar where it would be clipped.
      s.appendChild(
        el(
          "text",
          {
            x: Math.min(plotL + bw + 5, w - 4),
            y: y + bh / 2 + 4,
            "text-anchor": "start",
            class: "viz-note",
            fill: VIZ.muted,
          },
          fmtN(r.value, opts.decimals ?? 0)
        )
      );
    }
  });

  return s;
}

/* ==========================================================================
   2. Lollipop — same job as a bar, but for a long tail of individual items
   ==========================================================================
   Used where the extremes are the point and the bar mass would just be ink.
   Rows flagged `critical` take the reserved status colour AND a label, never
   colour alone. */
function vizLollipop(host, opts) {
  const rows = (opts.rows || []).slice(0, opts.limit || 15);
  if (!rows.length) return emptyState(host, opts.empty || "No rows to plot.");

  const w = 306;
  const labelW = opts.labelWidth || 86;
  const rowH = 19;
  const top = 8;
  const h = top + rows.length * rowH + 20;
  const plotL = labelW + 6;
  const plotW = w - plotL - 34;
  const max = niceMax(Math.max(...rows.map((r) => r.value || 0)));

  const s = svgRoot(host, w, h);
  s.setAttribute("aria-label", opts.aria || opts.title || "Lollipop chart");

  // Hairline gridlines, solid — dashed grid reads as a threshold it is not.
  [0, 0.5, 1].forEach((f) => {
    const x = plotL + plotW * f;
    s.appendChild(
      el("line", { x1: x, y1: top - 4, x2: x, y2: top + rows.length * rowH, stroke: VIZ.grid, "stroke-width": 1 })
    );
    s.appendChild(
      el(
        "text",
        { x, y: h - 6, "text-anchor": "middle", class: "viz-tick", fill: VIZ.muted },
        fmtN(max * f, max < 20 ? 1 : 0)
      )
    );
  });

  rows.forEach((r, i) => {
    const y = top + i * rowH + rowH / 2 - 2;
    const critical = !!r.critical;
    const colour = critical ? VIZ.status.critical : opts.color || VIZ.series;
    const x = plotL + (plotW * (r.value || 0)) / max;

    s.appendChild(
      el("line", { x1: plotL, y1: y, x2: x, y2: y, stroke: colour, "stroke-width": 2, "stroke-linecap": "round", opacity: 0.45 })
    );
    // 2px surface ring keeps overlapping dots apart without drawing a border.
    s.appendChild(el("circle", { cx: x, cy: y, r: 6, fill: VIZ.surface }));
    const dot = el("circle", { cx: x, cy: y, r: 4.5, fill: colour, class: "viz-mark" });
    s.appendChild(
      hoverable(
        dot,
        `<b>${r.label}</b><br/>${opts.valueLabel || "Value"}: ${fmtN(r.value, opts.decimals ?? 1)}` +
          (r.tipExtra ? `<br/>${r.tipExtra}` : "")
      )
    );
    // Oversized invisible hit area — a 4.5px dot is not a fair target.
    const hit = el("rect", { x: plotL, y: y - 10, width: plotW + 20, height: 20, fill: "transparent", class: "viz-hit" });
    s.appendChild(
      hoverable(
        hit,
        `<b>${r.label}</b><br/>${opts.valueLabel || "Value"}: ${fmtN(r.value, opts.decimals ?? 1)}` +
          (r.tipExtra ? `<br/>${r.tipExtra}` : "")
      )
    );

    s.appendChild(
      el(
        "text",
        { x: labelW, y: y + 4, "text-anchor": "end", class: "viz-lab", fill: critical ? VIZ.status.critical : VIZ.ink2 },
        truncate(r.label, opts.labelChars || 13)
      )
    );
    s.appendChild(
      el("text", { x: w - 2, y: y + 4, "text-anchor": "end", class: "viz-note", fill: VIZ.muted }, r.valueText ?? fmtN(r.value, opts.decimals ?? 1))
    );
  });

  if (opts.rule !== undefined && opts.rule !== null && opts.rule <= max) {
    const x = plotL + (plotW * opts.rule) / max;
    s.appendChild(
      el("line", { x1: x, y1: top - 4, x2: x, y2: top + rows.length * rowH, stroke: VIZ.status.critical, "stroke-width": 1.5, opacity: 0.55 })
    );
  }
  return s;
}

/* ==========================================================================
   3. Multi-line — the only categorical form here that carries 3 series
   ==========================================================================
   Three series is the all-pairs cap for the validated palette, and the level
   triplet sits exactly at it. Each line is direct-labelled at its endpoint, so
   identity never rests on colour alone. */
function vizLines(host, opts) {
  const series = (opts.series || []).filter((s) => s.points && s.points.length);
  if (!series.length) return emptyState(host, opts.empty || "No data to plot.");

  const w = 306;
  const h = opts.height || 190;
  const padL = 40;
  const padR = 30;
  const padT = 10;
  const padB = 28;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const xs = series.flatMap((s) => s.points.map((p) => p[0]));
  const ys = series.flatMap((s) => s.points.map((p) => p[1]));
  const x0 = opts.xMin ?? Math.min(...xs);
  const x1 = opts.xMax ?? Math.max(...xs);
  const y1 = niceMax(Math.max(...ys, 1));

  const sx = (v) => padL + (plotW * (v - x0)) / (x1 - x0 || 1);
  const sy = (v) => padT + plotH - (plotH * v) / y1;

  const s = svgRoot(host, w, h);
  s.setAttribute("aria-label", opts.aria || opts.title || "Line chart");

  [0, 0.25, 0.5, 0.75, 1].forEach((f) => {
    const y = padT + plotH * (1 - f);
    s.appendChild(el("line", { x1: padL, y1: y, x2: padL + plotW, y2: y, stroke: VIZ.grid, "stroke-width": 1 }));
    s.appendChild(
      el("text", { x: padL - 6, y: y + 3.5, "text-anchor": "end", class: "viz-tick", fill: VIZ.muted }, fmtN(y1 * f))
    );
  });
  s.appendChild(el("line", { x1: padL, y1: padT + plotH, x2: padL + plotW, y2: padT + plotH, stroke: VIZ.axis, "stroke-width": 1 }));

  (opts.xTicks || [x0, (x0 + x1) / 2, x1]).forEach((t) => {
    s.appendChild(
      el("text", { x: sx(t), y: h - 10, "text-anchor": "middle", class: "viz-tick", fill: VIZ.muted }, fmtN(t))
    );
  });
  if (opts.xLabel) {
    s.appendChild(el("text", { x: padL + plotW / 2, y: h - 0.5, "text-anchor": "middle", class: "viz-axis-title", fill: VIZ.muted }, opts.xLabel));
  }

  // Marker rules — drawn under the data so they never obscure a value.
  (opts.rules || []).forEach((r) => {
    if (r.x < x0 || r.x > x1) return;
    const x = sx(r.x);
    s.appendChild(el("line", { x1: x, y1: padT, x2: x, y2: padT + plotH, stroke: r.color || VIZ.muted, "stroke-width": 1.5, opacity: 0.5 }));
    if (r.label) {
      s.appendChild(el("text", { x: x + 3, y: padT + 9, class: "viz-tick", fill: r.color || VIZ.muted }, r.label));
    }
  });

  const endLabels = [];
  series.forEach((ser) => {
    const d = ser.points.map((p, i) => `${i ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(" ");
    s.appendChild(el("path", { d, fill: "none", stroke: ser.color || VIZ.series, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    const last = ser.points[ser.points.length - 1];
    endLabels.push({ x: sx(last[0]) + 5, y: sy(last[1]) + 3.5, name: ser.name });
  });

  // Converging lines put their endpoint labels on top of each other. Nudge them
  // apart rather than dropping them: with a legend AND a direct label, identity
  // never rests on colour alone.
  endLabels.sort((a, b) => a.y - b.y);
  const MIN = 10;
  for (let i = 1; i < endLabels.length; i++) {
    if (endLabels[i].y - endLabels[i - 1].y < MIN) endLabels[i].y = endLabels[i - 1].y + MIN;
  }
  const overflow = endLabels.length ? Math.max(0, endLabels[endLabels.length - 1].y - (padT + plotH)) : 0;
  endLabels.forEach((L) => {
    s.appendChild(el("text", { x: L.x, y: L.y - overflow, class: "viz-note", fill: VIZ.ink2 }, L.name));
  });

  // Crosshair + tooltip across all series at the nearest x.
  const cross = el("line", { x1: 0, y1: padT, x2: 0, y2: padT + plotH, stroke: VIZ.axis, "stroke-width": 1, opacity: 0 });
  s.appendChild(cross);
  const surface = el("rect", { x: padL, y: padT, width: plotW, height: plotH, fill: "transparent" });
  surface.addEventListener("mousemove", (e) => {
    const box = s.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * w;
    const xv = x0 + ((px - padL) / plotW) * (x1 - x0);
    cross.setAttribute("x1", sx(xv));
    cross.setAttribute("x2", sx(xv));
    cross.setAttribute("opacity", "1");
    const parts = series.map((ser) => {
      let best = ser.points[0];
      ser.points.forEach((p) => {
        if (Math.abs(p[0] - xv) < Math.abs(best[0] - xv)) best = p;
      });
      return `<span class="viz-tip-key" style="background:${ser.color || VIZ.series}"></span>${ser.name}: <b>${fmtN(best[1])}</b>`;
    });
    showTip(`<b>${fmtN(Math.round(xv))} ${opts.xUnit || ""}</b><br/>${parts.join("<br/>")}`, e);
  });
  surface.addEventListener("mouseleave", () => {
    cross.setAttribute("opacity", "0");
    hideTip();
  });
  s.appendChild(surface);
  return s;
}

/* ==========================================================================
   4. Scatter — two measures, one plot, no second y-axis
   ==========================================================================
   Composite encoding: hue carries the level, shape carries it a second time,
   and a hollow mark flags an estimated value. A dense field gets small marks
   with a nearest-point hit layer rather than fat unmissable dots. */
function vizScatter(host, opts) {
  const pts = opts.points || [];
  if (!pts.length) return emptyState(host, opts.empty || "No points to plot.");

  const w = 306;
  const h = opts.height || 210;
  const padL = 38;
  const padR = 10;
  const padT = 10;
  const padB = 34;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  // niceMax rounds an axis up to a friendly number, which is right for a linear
  // count and wrong for a transformed one: rounding a log-space maximum of 3.36
  // up to 5 stretches the axis to 100,000 grids and leaves two thirds of the
  // plot empty. Callers working in transformed space pass xNice:false.
  const rawX = opts.xMax ?? Math.max(...pts.map((p) => p.x));
  const rawY = opts.yMax ?? Math.max(...pts.map((p) => p.y));
  const xMax = opts.xNice === false ? rawX : niceMax(rawX);
  const yMax = opts.yNice === false ? rawY : niceMax(rawY);
  const sx = (v) => padL + (plotW * v) / xMax;
  const sy = (v) => padT + plotH - (plotH * v) / yMax;

  const s = svgRoot(host, w, h);
  s.setAttribute("aria-label", opts.aria || opts.title || "Scatter plot");

  [0, 0.5, 1].forEach((f) => {
    const y = padT + plotH * (1 - f);
    s.appendChild(el("line", { x1: padL, y1: y, x2: padL + plotW, y2: y, stroke: VIZ.grid, "stroke-width": 1 }));
    s.appendChild(el("text", { x: padL - 6, y: y + 3.5, "text-anchor": "end", class: "viz-tick", fill: VIZ.muted }, fmtN(yMax * f, opts.yDecimals ?? 0)));
    const x = padL + plotW * f;
    s.appendChild(el("text", { x, y: h - 14, "text-anchor": "middle", class: "viz-tick", fill: VIZ.muted }, opts.xTickLabel ? opts.xTickLabel(xMax * f) : fmtN(xMax * f, opts.xDecimals ?? 0)));
  });
  s.appendChild(el("line", { x1: padL, y1: padT + plotH, x2: padL + plotW, y2: padT + plotH, stroke: VIZ.axis, "stroke-width": 1 }));

  if (opts.xLabel) s.appendChild(el("text", { x: padL + plotW / 2, y: h - 2, "text-anchor": "middle", class: "viz-axis-title", fill: VIZ.muted }, opts.xLabel));
  if (opts.yLabel) {
    s.appendChild(
      el("text", { x: 10, y: padT + plotH / 2, "text-anchor": "middle", class: "viz-axis-title", fill: VIZ.muted, transform: `rotate(-90 10 ${padT + plotH / 2})` }, opts.yLabel)
    );
  }

  const shapeNode = (shape, cx, cy, r, fill, hollow) => {
    const common = hollow
      ? { fill: VIZ.surface, stroke: fill, "stroke-width": 1.6 }
      : { fill, stroke: VIZ.surface, "stroke-width": 1 };
    if (shape === "square") {
      return el("rect", { x: cx - r, y: cy - r, width: r * 2, height: r * 2, rx: 1, ...common });
    }
    if (shape === "star") {
      const pts5 = [];
      for (let i = 0; i < 10; i++) {
        const rr = i % 2 ? r * 0.45 : r * 1.25;
        const a = (Math.PI / 5) * i - Math.PI / 2;
        pts5.push(`${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`);
      }
      return el("polygon", { points: pts5.join(" "), ...common });
    }
    // Diamond — a square on its point. Added for the EP (empanelled private)
    // series, which needs a silhouette distinguishable from the three public
    // levels at a glance rather than only by hue.
    if (shape === "diamond") {
      const d = r * 1.25;
      const pts4 = [
        `${cx.toFixed(1)},${(cy - d).toFixed(1)}`,
        `${(cx + d).toFixed(1)},${cy.toFixed(1)}`,
        `${cx.toFixed(1)},${(cy + d).toFixed(1)}`,
        `${(cx - d).toFixed(1)},${cy.toFixed(1)}`,
      ];
      return el("polygon", { points: pts4.join(" "), ...common });
    }
    return el("circle", { cx, cy, r, ...common });
  };

  pts.forEach((p) => {
    const node = shapeNode(p.shape || "circle", sx(p.x), sy(p.y), p.r || 3.6, p.color || VIZ.series, p.hollow);
    node.setAttribute("class", "viz-mark viz-dot");
    node.setAttribute("opacity", p.opacity ?? 0.8);
    s.appendChild(hoverable(node, p.tip || `<b>${p.label}</b>`));
    if (p.onClick) node.addEventListener("click", p.onClick);
  });

  // Selective direct labels — only the marks that carry the story.
  (opts.labelled || []).forEach((p) => {
    // A label past the right edge gets clipped by the container, so it flips to
    // the other side of its mark instead of being cropped.
    const flip = sx(p.x) + 6 + p.label.length * 4.6 > w - 2;
    s.appendChild(
      el(
        "text",
        {
          x: flip ? sx(p.x) - 6 : sx(p.x) + 6,
          y: sy(p.y) - 5,
          "text-anchor": flip ? "end" : "start",
          class: "viz-note viz-halo",
          fill: VIZ.ink,
          // paint-order puts the surface-coloured stroke UNDER the glyph, so the
          // label stays readable where it lands on top of a dense mark cloud.
          stroke: VIZ.surface,
          "stroke-width": 3,
          "paint-order": "stroke",
          "stroke-linejoin": "round",
        },
        p.label
      )
    );
  });

  if (opts.quadrantNote) {
    s.appendChild(el("text", { x: padL + plotW - 2, y: padT + 10, "text-anchor": "end", class: "viz-tick", fill: VIZ.muted }, opts.quadrantNote));
  }
  return s;
}

/* ==========================================================================
   5. Histogram / distance-decay — a single distribution
   ========================================================================== */
function vizHistogram(host, opts) {
  const bins = opts.bins || [];
  if (!bins.length || !bins.some((b) => b.count)) return emptyState(host, opts.empty || "No distribution to plot.");

  const w = 306;
  const h = opts.height || 160;
  const padL = 36;
  const padR = 8;
  const padT = 8;
  const padB = 30;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const max = niceMax(Math.max(...bins.map((b) => b.count)));
  const bw = plotW / bins.length;

  const s = svgRoot(host, w, h);
  s.setAttribute("aria-label", opts.aria || opts.title || "Histogram");

  [0, 0.5, 1].forEach((f) => {
    const y = padT + plotH * (1 - f);
    s.appendChild(el("line", { x1: padL, y1: y, x2: padL + plotW, y2: y, stroke: VIZ.grid, "stroke-width": 1 }));
    s.appendChild(el("text", { x: padL - 5, y: y + 3.5, "text-anchor": "end", class: "viz-tick", fill: VIZ.muted }, fmtN(max * f)));
  });

  bins.forEach((b, i) => {
    const bh = Math.max(b.count > 0 ? 1.5 : 0, (plotH * b.count) / max);
    const x = padL + i * bw + 1; // 2px surface gap between adjacent fills
    const rect = el("rect", {
      x,
      y: padT + plotH - bh,
      width: Math.max(1, bw - 2),
      height: bh,
      rx: 3,
      fill: b.color || opts.color || VIZ.series,
      class: "viz-mark",
    });
    s.appendChild(hoverable(rect, `<b>${b.label}</b><br/>${opts.valueLabel || "Grids"}: ${fmtN(b.count)}`));
  });

  s.appendChild(el("line", { x1: padL, y1: padT + plotH, x2: padL + plotW, y2: padT + plotH, stroke: VIZ.axis, "stroke-width": 1 }));
  bins.forEach((b, i) => {
    if (b.tick === undefined) return;
    s.appendChild(el("text", { x: padL + i * bw + bw / 2, y: h - 14, "text-anchor": "middle", class: "viz-tick", fill: VIZ.muted }, b.tick));
  });
  if (opts.xLabel) s.appendChild(el("text", { x: padL + plotW / 2, y: h - 2, "text-anchor": "middle", class: "viz-axis-title", fill: VIZ.muted }, opts.xLabel));

  if (opts.rule !== undefined && opts.rule !== null) {
    const x = padL + plotW * opts.ruleFrac;
    s.appendChild(el("line", { x1: x, y1: padT, x2: x, y2: padT + plotH, stroke: VIZ.status.critical, "stroke-width": 1.5, opacity: 0.6 }));
    s.appendChild(el("text", { x: x - 3, y: padT + 9, "text-anchor": "end", class: "viz-tick", fill: VIZ.status.critical }, opts.ruleLabel || ""));
  }
  return s;
}

/* ==========================================================================
   6. Stacked share bar — part-to-whole, <= 3 segments
   ========================================================================== */
function vizStack(host, opts) {
  const segs = (opts.segments || []).filter((x) => x.value > 0);
  if (!segs.length) return emptyState(host, opts.empty || "Nothing to break down.");

  const w = 306;
  const barH = 26;
  const h = barH + 10;
  const total = segs.reduce((a, x) => a + x.value, 0) || 1;
  const s = svgRoot(host, w, h);
  s.setAttribute("aria-label", opts.aria || opts.title || "Stacked share bar");

  let x = 0;
  segs.forEach((seg, i) => {
    const sw = (w * seg.value) / total;
    const gap = i === segs.length - 1 ? 0 : 2; // 2px surface gap, not a border
    const rect = el("rect", {
      x,
      y: 2,
      width: Math.max(1, sw - gap),
      height: barH,
      rx: 4,
      fill: seg.color || VIZ.series,
      class: "viz-mark",
    });
    s.appendChild(
      hoverable(rect, `<b>${seg.label}</b><br/>${fmtN(seg.value)} (${((100 * seg.value) / total).toFixed(1)}%)`)
    );
    // Only label inside the segment when the text genuinely fits with padding.
    const pct = `${Math.round((100 * seg.value) / total)}%`;
    if (sw > 34) {
      s.appendChild(
        el("text", { x: x + sw / 2 - gap / 2, y: barH / 2 + 6, "text-anchor": "middle", class: "viz-inbar" }, pct)
      );
    }
    x += sw;
  });
  return s;
}

/* ==========================================================================
   7. Meter — one ratio against its whole
   ==========================================================================
   Two of these stacked is how "X% of grids / Y% of severity" gets told without
   inventing a chart for two numbers. */
function vizMeter(host, opts) {
  // Callers reach for this with a bare array often enough that refusing one is
  // just a trap; both shapes are accepted.
  const rows = Array.isArray(opts) ? opts : opts.rows || [];
  host.innerHTML = "";
  rows.forEach((r) => {
    const pct = Math.max(0, Math.min(100, r.pct || 0));
    const wrap = document.createElement("div");
    wrap.className = "viz-meter";
    wrap.innerHTML =
      `<div class="viz-meter-head"><span>${r.label}</span><b>${r.display ?? pct.toFixed(1) + "%"}</b></div>` +
      `<div class="viz-meter-track"><div class="viz-meter-fill" style="width:${pct}%;background:${r.color || VIZ.series}"></div></div>` +
      (r.note ? `<div class="viz-meter-note">${r.note}</div>` : "");
    host.appendChild(wrap);
  });
}

/* ==========================================================================
   8. Legend — always present for >= 2 series
   ========================================================================== */
function vizLegend(host, items) {
  host.innerHTML = items
    .map(
      (i) =>
        `<span class="viz-legend-item"><i class="viz-swatch ${i.hollow ? "hollow" : ""}" style="${
          i.hollow ? `border-color:${i.color}` : `background:${i.color}`
        }"></i>${i.label}</span>`
    )
    .join("");
}

window.VIZ = VIZ;
window.vizBarH = vizBarH;
window.vizLollipop = vizLollipop;
window.vizLines = vizLines;
window.vizScatter = vizScatter;
window.vizHistogram = vizHistogram;
window.vizStack = vizStack;
window.vizMeter = vizMeter;
window.vizLegend = vizLegend;
