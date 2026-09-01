#!/usr/bin/env node
/*
 * Catch undefined-reference bugs in the dashboard's front-end scripts.
 *
 * WHY THIS EXISTS
 * `node --check` only validates SYNTAX. It happily passes a file that
 * references a variable which does not exist — that only explodes at runtime,
 * in the browser, as a silent blank page.
 *
 * That is exactly what happened: network_analytics.js used SEVERITY_COLORS,
 * which is declared in reach_view.js / grid_analysis.js / severity_heatmap.js
 * but NOT in network_analytics.js, and none of those load on that page. The
 * ReferenceError killed init() half-way through, so the page sat on "Loading…"
 * with every counter at zero and no error anywhere the user could see.
 *
 * This script evaluates each file against a stubbed browser + Leaflet and
 * reports any ReferenceError. Stub-induced TypeErrors (missing DOM nodes) are
 * expected and ignored — we are hunting undefined *names*, not DOM behaviour.
 *
 * Usage:  node scripts/check_js.js
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const JS_DIR = path.join(__dirname, "..", "dashboard", "static", "js");

// Anything you touch on a stub returns another stub, so chained calls survive.
const chain = new Proxy(function () {}, {
  get: () => chain,
  apply: () => chain,
  construct: () => chain,
});

function makeElement() {
  return new Proxy(
    {
      style: {},
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
      appendChild() {},
      add() {},
      innerHTML: "",
      textContent: "",
      value: "",
      checked: false,
      dataset: {},
    },
    { get: (t, k) => (k in t ? t[k] : chain) }
  );
}

function sandboxFor() {
  const el = makeElement();
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math, JSON, Object, Number, String, Boolean, Array, Set, Map, Date,
    URLSearchParams, Promise, setTimeout, clearTimeout, parseInt, parseFloat, isNaN,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    L: new Proxy({}, { get: () => chain }),
    Option: function () {},
    // Globals the shared partials provide at runtime.
    initMapMeasure() {},
    REACH_CONFIG: {},
    document: {
      getElementById: () => el,
      querySelectorAll: () => [],
      querySelector: () => el,
      createElement: () => el,
      addEventListener() {},
      body: el,
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

/*
 * Static pass: find calls to functions that are never defined.
 *
 * Evaluating the file only catches names referenced at TOP LEVEL. A call sitting
 * inside an async function — say init() calling a helper you deleted — does not
 * throw until that code path runs in a browser. That is exactly how a call to a
 * removed buildTierSliders() survived the runtime check and only surfaced as
 * "Page setup failed" in the UI.
 *
 * Heuristic, deliberately: strip strings/comments, collect declared names, then
 * flag bare `name(` calls that resolve to nothing. Method calls (obj.name()) are
 * ignored since we cannot know their type.
 */
const BUILTINS = new Set([
  "if","for","while","switch","catch","return","typeof","function","await","new",
  "case","do","else","try","finally","throw","delete","void","in","of","yield",
  "Array","Object","String","Number","Boolean","Math","JSON","Date","Set","Map",
  "Promise","Error","RegExp","Symbol","BigInt","parseInt","parseFloat","isNaN",
  "isFinite","encodeURIComponent","decodeURIComponent","setTimeout","clearTimeout",
  "setInterval","clearInterval","fetch","alert","confirm","prompt","require",
  "L","URLSearchParams","URL","Blob","FormData","Headers","Request","Response",
  "console","document","window","navigator","location","history","localStorage",
  "Option","Image","CustomEvent","Event","AbortController","structuredClone",
  "requestAnimationFrame","cancelAnimationFrame","queueMicrotask","initMapMeasure","$",
  "performance","getComputedStyle","matchMedia","ResizeObserver","IntersectionObserver",
  "SVGElement","HTMLElement","Node","NodeList","DOMParser","TextDecoder","TextEncoder",
]);

/*
 * Names defined at top level in ANY of the scanned files.
 *
 * Every one of these scripts is loaded with a plain <script> tag, so they all
 * share one global scope: radar_overlay.js defines createRadarOverlay() and
 * network_analytics.js calls it, which is correct at runtime but looks
 * undefined when each file is analysed alone. Reporting that as an error
 * trained the eye to ignore this tool's output, which is worse than not having
 * it. Cross-file names are collected first and treated as defined.
 *
 * The trade-off is deliberate: a name defined in a file that ISN'T on the same
 * page would slip through. That is the rarer mistake, and the SEVERITY_COLORS
 * bug it once caught is now guarded by the per-page DOM audit instead.
 */
function collectTopLevelNames(dir, fileList) {
  const names = new Set();
  for (const f of fileList) {
    const src = blankLiterals(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const m of src.matchAll(/^\s*(?:async\s+)?function\s+([\w$]+)/gm)) names.add(m[1]);
    for (const m of src.matchAll(/^\s*(?:const|let|var)\s+([\w$]+)/gm)) names.add(m[1]);
    for (const m of src.matchAll(/^\s*class\s+([\w$]+)/gm)) names.add(m[1]);
  }
  return names;
}

/*
 * Blank out comments and string bodies while preserving offsets and newlines.
 *
 * A regex cannot do this: template literals nest (`${x.map(v => `<td>${v}</td>`)}`)
 * and a naive /`...`/ match runs from the first backtick to the wrong closing
 * one, swallowing whole function definitions and making them look undefined.
 * This is a small state machine instead — the code inside ${...} is KEPT, since
 * calls in there are real calls.
 */
/* A `/` starts a regex (not a division) when the last meaningful token is an
 * operator, opening bracket, or a keyword like `return`. Good enough for this
 * codebase; full disambiguation needs a real parser. */
function isRegexStart(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const prev = src[j];
  if ("(,=:[!&|?{};+-*%~^<>".includes(prev)) return true;
  const word = /[\w$]+$/.exec(src.slice(Math.max(0, j - 10), j + 1));
  return word ? ["return", "typeof", "case", "in", "of", "new", "delete", "void"].includes(word[0]) : false;
}

function blankLiterals(src) {
  const out = src.split("");
  const blank = (k) => {
    if (out[k] !== undefined && out[k] !== "\n") out[k] = " ";
  };
  // Explicit context stack. Template literals nest arbitrarily —
  // `${x.map(v => `<td>${v}</td>`)}` — so a regex or a recursive slice cannot
  // track them. Code inside ${...} is KEPT: calls in there are real calls.
  const stack = [{ type: "code" }];
  let i = 0;

  while (i < src.length) {
    const top = stack[stack.length - 1];
    const c = src[i];
    const d = src[i + 1];

    if (top.type === "tmpl") {
      if (c === "\\") { blank(i); blank(i + 1); i += 2; continue; }
      if (c === "`") { stack.pop(); i++; continue; }
      if (c === "$" && d === "{") { stack.push({ type: "code", brace: 0 }); i += 2; continue; }
      blank(i); i++; continue;
    }

    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") { blank(i); i++; }
      continue;
    }
    if (c === "/" && d === "*") {
      let j = src.indexOf("*/", i + 2);
      j = j === -1 ? src.length : j + 2;
      while (i < j) { blank(i); i++; }
      continue;
    }
    // Regex literal. Must be handled explicitly: /filename="?([^"]+)"?/ contains
    // quote characters, and without this the scanner treats the first " as a
    // string opener and swallows the rest of the file — which silently hid a
    // real undefined-function call.
    if (c === "/" && isRegexStart(src, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const ch = src[j];
        if (ch === "\\") { j += 2; continue; }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        else if (ch === "\n") break; // unterminated — treat as division after all
        j++;
      }
      if (j < src.length && src[j] === "/") {
        for (let k = i + 1; k < j; k++) blank(k);
        j++;
        while (j < src.length && /[gimsuy]/.test(src[j])) j++;
        i = j;
        continue;
      }
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") { blank(j); blank(j + 1); j += 2; } else { blank(j); j++; }
      }
      i = Math.min(j + 1, src.length);
      continue;
    }
    if (c === "`") { stack.push({ type: "tmpl" }); i++; continue; }
    if (c === "{") { if (top.brace !== undefined) top.brace++; i++; continue; }
    if (c === "}") {
      if (top.brace !== undefined) {
        if (top.brace === 0) { stack.pop(); i++; continue; }
        top.brace--;
      }
      i++; continue;
    }
    i++;
  }
  return out.join("");
}

function staticUndefinedCalls(code, crossFile = new Set()) {
  const clean = blankLiterals(code);

  const declared = new Set([...BUILTINS, ...crossFile]);
  const add = (re, g = 1) => {
    let m;
    while ((m = re.exec(clean))) declared.add(m[g]);
  };
  add(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g);
  add(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g);
  add(/([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\()/g); // object methods
  add(/\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>/g); // single-param arrows
  add(/function\s*\(([^)]*)\)/g); // params, coarse
  clean.replace(/\(([^)]*)\)\s*=>/g, (_, params) => {
    params.split(",").forEach((p) => {
      const n = p.trim().split(/[=\s]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n);
    });
    return "";
  });

  const missing = new Map();
  const callRe = /(^|[^.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = callRe.exec(clean))) {
    const name = m[2];
    if (declared.has(name)) continue;
    const line = clean.slice(0, m.index).split("\n").length;
    if (!missing.has(name)) missing.set(name, line);
  }
  return missing;
}

let failures = 0;
const files = fs.readdirSync(JS_DIR).filter((f) => f.endsWith(".js")).sort();
const crossFile = collectTopLevelNames(JS_DIR, files);

for (const file of files) {
  const code = fs.readFileSync(path.join(JS_DIR, file), "utf8");
  const notes = [];

  // 1. Runtime pass — catches top-level undefined references.
  const sandbox = sandboxFor();
  vm.createContext(sandbox);
  try {
    vm.runInContext(code, sandbox, { filename: file, timeout: 5000 });
  } catch (err) {
    if (err instanceof ReferenceError) {
      console.log(`  FAIL  ${file} — ${err.message}`);
      failures += 1;
      continue;
    }
    notes.push(`stub ${err.constructor.name}, ignored`);
  }

  // 2. Static pass — catches calls inside functions that never ran.
  const missing = staticUndefinedCalls(code, crossFile);
  if (missing.size) {
    console.log(`  FAIL  ${file}`);
    for (const [name, line] of missing) {
      console.log(`          calls ${name}() — never defined (line ~${line})`);
    }
    failures += 1;
    continue;
  }

  console.log(`  ok    ${file}${notes.length ? "  (" + notes.join("; ") + ")" : ""}`);
}

if (failures) {
  console.log(`\n${failures} file(s) reference an undefined name.`);
  process.exit(1);
}
console.log(`\nAll ${files.length} scripts free of undefined references.`);
