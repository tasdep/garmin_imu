import * as fitsdk from "https://cdn.jsdelivr.net/npm/@garmin/fitsdk@21.218.0/+esm";
import { parseFit } from "./fit.js";
import * as D from "./dsp.js";

const $ = (id) => document.getElementById(id);
const S = {}; // loaded activity and derived signals

// ---------- helpers ----------
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const colors = () => ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6"].map(css);
const cfg = { responsive: true, displaylogo: false };

function layout(extra = {}) {
  return {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: css("--fg"), size: 12 },
    margin: { l: 64, r: 16, t: 28, b: 40 },
    legend: { orientation: "h", y: 1.06, x: 0 },
    hovermode: "x unified",
    ...extra,
  };
}
const ax = (extra = {}) => ({ gridcolor: css("--grid"), zerolinecolor: css("--border"), ...extra });

// Plotly shows date axes in UTC, so shift by the local offset to show wall-clock time.
const xOf = (t) => S.x0 + t * 1000;
const tOf = (x) =>
  ((typeof x === "number" ? x : Date.parse(String(x).replace(" ", "T").replace(/(\.\d{3})\d+/, "$1") + "Z")) - S.x0) / 1000;

const fmtTime = (s) => {
  if (!Number.isFinite(s)) return "–";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(ss).padStart(2, "0")}`;
};
const fmtSplit = (mps) => (mps > 0.5 ? fmtTime(500 / mps) : "–");
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "–");

// Decimated series with nulls at pauses so lines don't bridge them.
function series(t, y, i0 = 0, i1 = t.length, max = 150000) {
  const step = Math.max(1, Math.ceil((i1 - i0) / max));
  const xs = [], ys = [];
  let prev = null;
  for (let i = i0; i < i1; i += step) {
    if (prev !== null && t[i] - t[prev] > 0.5) {
      xs.push(null);
      ys.push(null);
    }
    xs.push(xOf(t[i]));
    ys.push(y[i]);
    prev = i;
  }
  return { x: xs, y: ys };
}

function setStatus(msg) {
  $("status").textContent = msg;
}

// ---------- loading & processing ----------
async function load(file) {
  setStatus(`Reading ${file.name}…`);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const act = parseFit(bytes, fitsdk);
    S.act = act;
    S.name = file.name;
    S.t = act.accel.t;
    S.acc = [act.accel.x, act.accel.y, act.accel.z];
    S.gyro = act.gyro ? [act.gyro.x, act.gyro.y, act.gyro.z].map((c) => D.interp(act.gyro.t, c, S.t)) : null;
    S.x0 = act.start.getTime() - act.start.getTimezoneOffset() * 60000;
    S.rec = {
      dist: D.interp(act.rec.t, act.rec.dist, S.t),
      speed: D.interp(act.rec.t, act.rec.speed, S.t),
      hr: D.interp(act.rec.t, act.rec.hr, S.t),
    };
    S.flip = false;
    S.sel = { t0: S.t[0], t1: S.t[S.t.length - 1] };
    fillSelection();
    $("app").hidden = false;
    computeOrientation();
    const fs = (1 / D.medianDt(S.t)).toFixed(0);
    setStatus(`${file.name}: ${act.start.toLocaleString()} · ${S.t.length.toLocaleString()} samples at ${fs} Hz · ${act.gyro ? "accel + gyro" : "accel only (no gyro: orientation from gravity only)"}`);
  } catch (e) {
    console.error(e);
    setStatus(`Could not load ${file.name}: ${e.message}`);
  }
}

function computeOrientation() {
  S.up = S.gyro ? D.madgwick(S.t, S.acc, S.gyro, +$("beta").value) : D.upFromAccel(S.t, S.acc);
  S.frame0 = D.boatFrame(S.t, S.acc, S.up, S.gyro);
  S.autoFlip = D.forwardLooksReversed(D.lowpass(S.frame0.surge, S.t, 4));
  applyFrame();
}

function applyFrame() {
  S.frame = S.autoFlip !== S.flip ? D.flipFrame(S.frame0) : S.frame0;
  const fr = S.frame;
  $("frameInfo").textContent = `forward = [${fr.f.map((v) => v.toFixed(2))}] in watch axes${S.autoFlip ? " (auto-flipped)" : ""}`;
  detect();
}

function detect() {
  const { t } = S;
  S.sDet = D.lowpass(S.frame.surge, t, 4);
  S.strokes = D.detectStrokes(t, S.sDet, { depthFrac: +$("sens").value });
  S.metrics = D.strokeMetrics(S.strokes, { t, surge: S.sDet, roll: S.frame.roll, pitch: S.frame.pitch, ...S.rec });
  filterDisplay();
}

function filterOpts() {
  const type = $("ftype").value;
  const v = +$("fc").value;
  return { type, fc: v, ms: v };
}

function filterDisplay() {
  const o = filterOpts();
  const fr = S.frame;
  const sm = (x) => (x ? D.smooth(x, S.t, o) : null);
  S.disp = {
    surge: sm(fr.surge), sway: sm(fr.sway), heave: sm(fr.heave),
    roll: sm(fr.roll), pitch: sm(fr.pitch), yaw: sm(fr.yawRate),
  };
  renderAll();
}

// ---------- selection ----------
function fillSelection() {
  const sel = $("sel");
  sel.innerHTML = "";
  sel.add(new Option("Whole activity", "all"));
  S.pieces = D.findPieces(S.act.rec);
  S.pieces.forEach((p, i) => sel.add(new Option(`Piece ${i + 1}: ${p.dist.toFixed(0)} m in ${fmtTime(p.t1 - p.t0)} (${fmtSplit(p.dist / (p.t1 - p.t0))})`, `p${i}`)));
  for (const l of S.act.laps) sel.add(new Option(`Lap ${l.index} (${fmtTime(l.t1 - l.t0)})`, String(l.index)));
  sel.add(new Option("Custom (zoomed)", "custom"));
}

function setSelection(t0, t1, fromZoom = false) {
  S.sel = { t0, t1 };
  if (!fromZoom) {
    S.ignoreRelayout = true;
    Plotly.relayout("overview", { "xaxis.range": [xOf(t0), xOf(t1)] }).finally(() => (S.ignoreRelayout = false));
  } else {
    $("sel").value = "custom";
  }
  fitSelection();
  renderSelection();
}

function selected() {
  const { t0, t1 } = S.sel;
  return S.metrics.map((m, k) => [m, k]).filter(([m]) => m.t0 >= t0 && m.t1 <= t1);
}

// ---------- rendering ----------
function renderAll() {
  renderOverview();
  renderSignals();
  renderOrientation();
  renderMap();
  renderSelection();
  fitSelection();
}

// Zoom the detail charts to the selection and fit their y axes to what's visible.
function fitSelection() {
  const { t0, t1 } = S.sel;
  const [i0, i1] = rangeIdx(t0, t1);
  const step = Math.max(1, Math.ceil((i1 - i0) / 50000));
  const part = (x) => {
    const out = [];
    for (let i = i0; i < i1; i += step) out.push(x[i]);
    return out;
  };
  const d = S.disp;
  const fit = (id, arrays) => {
    const upd = { "xaxis.range": [xOf(t0), xOf(t1)] };
    arrays.forEach((x, k) => {
      const r = x && robustRange(part(x));
      if (r) upd[`yaxis${k ? k + 1 : ""}.range`] = r;
    });
    Plotly.relayout(id, upd);
  };
  fit("signals", [$("showRaw").checked ? S.frame.surge : d.surge, d.sway, d.heave]);
  fit("orient", [d.roll, d.pitch, d.yaw]);
}

function renderSelection() {
  const sel = selected();
  // Consistency: correlation of each selected stroke's curve with the selection mean.
  S.selCurves = sel.map(([, k]) => D.strokeCurve(S.t, S.disp.surge, S.strokes[k]));
  S.selRoll = sel.map(([, k]) => D.strokeCurve(S.t, S.disp.roll, S.strokes[k]));
  S.meanCurve = meanOf(S.selCurves);
  sel.forEach(([m], j) => (m.similarity = D.pearson(S.selCurves[j], S.meanCurve)));
  S.metrics.forEach((m) => {
    if (m.t0 < S.sel.t0 || m.t1 > S.sel.t1) m.similarity = NaN;
  });
  renderTiles(sel.map(([m]) => m));
  renderOverlay(sel);
  renderTrends();
  renderRoll(sel.map(([m]) => m));
  renderTable(sel.map(([m]) => m));
  highlightMap();
}

function meanOf(curves) {
  if (!curves.length) return new Float64Array(0);
  const N = curves[0].length;
  const m = new Float64Array(N);
  for (const c of curves) for (let i = 0; i < N; i++) m[i] += c[i] / curves.length;
  return m;
}

function sdOf(curves, mean) {
  const N = mean.length;
  const s = new Float64Array(N);
  for (const c of curves) for (let i = 0; i < N; i++) s[i] += (c[i] - mean[i]) ** 2;
  return s.map((v) => Math.sqrt(v / Math.max(1, curves.length - 1)));
}

function rangeIdx(t0, t1) {
  const { t } = S;
  let i0 = 0, i1 = t.length;
  while (i0 < t.length && t[i0] < t0) i0++;
  while (i1 > i0 && t[i1 - 1] > t1) i1--;
  return [i0, i1];
}

function tile(k, v, s = "") {
  return `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
}

function renderTiles(ms) {
  const { t0, t1 } = S.sel;
  const [i0, i1] = rangeIdx(t0, t1);
  const dist = S.rec.dist[i1 - 1] - S.rec.dist[i0];
  const dur = t1 - t0;
  const rate = D.summarize(ms.map((m) => m.rate));
  const dps = D.summarize(ms.map((m) => m.dps));
  const cat = D.summarize(ms.map((m) => m.catchAcc));
  const pk = D.summarize(ms.map((m) => m.peakAcc));
  const ratio = D.summarize(ms.map((m) => m.ratio));
  const sim = D.summarize(ms.map((m) => m.similarity));
  const rr = D.summarize(ms.map((m) => m.rollRange));
  const hr = D.summarize(Array.from(S.rec.hr.subarray(i0, i1)));
  const side = rollSides(i0, i1);
  $("tiles").innerHTML = [
    tile("Duration", fmtTime(dur), `${fmtTime(t0)} → ${fmtTime(t1)}`),
    tile("Distance", Number.isFinite(dist) && dist > 0 ? `${dist.toFixed(0)} m` : "–", "GPS"),
    tile("Avg split", fmtSplit(dist / dur), "/500 m"),
    tile("Strokes", ms.length, `${f(rate.mean)} spm avg`),
    tile("Rate CV", `${f(rate.cv)} %`, `sd ${f(rate.sd)} spm`),
    tile("Dist / stroke", `${f(dps.mean, 2)} m`, `CV ${f(dps.cv)} %`),
    tile("Catch accel", `${f(cat.mean, 1)}`, `m/s² · CV ${f(cat.cv)} %`),
    tile("Drive peak", `${f(pk.mean, 1)}`, `m/s² · CV ${f(pk.cv)} %`),
    tile("Drive : recovery", f(ratio.mean, 2), `CV ${f(ratio.cv)} %`),
    tile("Consistency r", f(sim.mean, 3), "curve vs mean"),
    tile("Roll range", `${f(rr.mean)}°`, "per stroke"),
    tile("Stbd / port down", `${f(side.stbd, 0)} / ${f(side.port, 0)} %`, `level ±1°: ${f(side.level, 0)} %`),
    tile("Heart rate", Number.isFinite(hr.mean) ? f(hr.mean, 0) : "–", "bpm avg"),
  ].join("");
}

function rollSides(i0, i1) {
  let p = 0, s = 0, l = 0;
  for (let i = i0; i < i1; i++) {
    const r = S.frame.roll[i];
    if (r > 1) s++;
    else if (r < -1) p++;
    else l++;
  }
  const n = Math.max(1, i1 - i0);
  return { stbd: (100 * s) / n, port: (100 * p) / n, level: (100 * l) / n };
}

// 1st-99th percentile with padding, so a few knocks or outliers don't set the scale.
function robustRange(values, pad = 0.1) {
  const lo = D.percentile(values, 0.01), hi = D.percentile(values, 0.99);
  if (!Number.isFinite(lo)) return undefined;
  const span = hi - lo || 1;
  return [lo - pad * span, hi + pad * span];
}

// Reversed split axis (faster = higher) with m:ss ticks at a readable spacing.
function splitAxis(splits) {
  const v = splits.filter((x) => Number.isFinite(x) && x < 600);
  const lo = v.length ? D.percentile(v, 0.02) : 90;
  const hi = v.length ? D.percentile(v, 0.95) : 180;
  const step = [5, 10, 15, 20, 30, 60, 120].find((s) => (hi - lo) / s <= 6) ?? 120;
  const ticks = [];
  for (let x = Math.floor(lo / step) * step; x <= hi + step; x += step) ticks.push(x);
  return { title: { text: "split" }, autorange: false, range: [hi + step / 2, lo - step / 2], tickvals: ticks, ticktext: ticks.map(fmtTime) };
}

function renderOverview() {
  const c = colors();
  const r = S.act.rec;
  const split = r.speed.map((v) => (v > 0.5 ? 500 / v : null));
  const rx = r.t.map(xOf);
  const traces = [
    { x: rx, y: split, name: "Split /500m", yaxis: "y", line: { color: c[0], width: 1.5 }, hovertemplate: "%{customdata}", customdata: split.map(fmtTime) },
    { x: S.metrics.map((m) => xOf(m.t0)), y: S.metrics.map((m) => m.rate), name: "SPM (detected)", yaxis: "y2", mode: "markers", marker: { color: c[1], size: 4 } },
    { x: rx, y: r.cadence, name: "SPM (watch)", yaxis: "y2", line: { color: c[3], width: 1 } },
    { x: rx, y: r.hr, name: "Heart rate", yaxis: "y3", line: { color: c[4], width: 1.5 } },
  ];
  if (r.imuSr.some((v) => v)) traces.push({ x: rx, y: r.imuSr, name: "SPM (app live)", yaxis: "y2", line: { color: c[5], width: 1, dash: "dot" } });
  // A boat-mounted watch records no heart rate; drop the empty row then.
  const hasHr = r.hr.some((v) => v);
  Plotly.react("overview", traces, layout({
    xaxis: ax({ type: "date", anchor: hasHr ? "y3" : "y2", rangeslider: { visible: true, thickness: 0.06 } }),
    yaxis: ax({ domain: hasHr ? [0.68, 1] : [0.52, 1], ...splitAxis(split) }),
    // Fixed rowing range so stray values (e.g. native cadence spikes) don't squash the plot.
    yaxis2: ax({ domain: hasHr ? [0.36, 0.64] : [0, 0.46], title: { text: "spm" }, range: [10, 55] }),
    yaxis3: ax({ domain: [0, 0.32], title: { text: "bpm" }, visible: hasHr }),
    shapes: S.act.laps.slice(1).map((l) => ({ type: "line", xref: "x", yref: "paper", x0: xOf(l.t0), x1: xOf(l.t0), y0: 0, y1: 1, line: { color: css("--muted"), width: 1, dash: "dot" } })),
  }), cfg);
  const el = $("overview");
  el.removeAllListeners?.("plotly_relayout");
  el.on("plotly_relayout", (ev) => {
    if (S.ignoreRelayout) return;
    if (ev["xaxis.autorange"]) {
      $("sel").value = "all";
      setSelection(S.t[0], S.t[S.t.length - 1], true);
      $("sel").value = "all";
    } else if (ev["xaxis.range[0]"] || ev["xaxis.range"]) {
      const rg = ev["xaxis.range"] ?? [ev["xaxis.range[0]"], ev["xaxis.range[1]"]];
      setSelection(tOf(rg[0]), tOf(rg[1]), true);
    }
  });
}

function renderSignals() {
  const c = colors();
  const { t } = S;
  const d = S.disp;
  const traces = [];
  if ($("showRaw").checked) traces.push({ ...series(t, S.frame.surge), name: "surge raw", line: { color: css("--muted"), width: 0.6 }, type: "scattergl", opacity: 0.6 });
  traces.push(
    { ...series(t, d.surge), name: "surge", line: { color: c[0], width: 1.2 }, type: "scattergl" },
    { x: S.strokes.map((s) => xOf(s.t0)), y: S.strokes.map((s) => d.surge[s.i0]), name: "catch", mode: "markers", marker: { color: c[4], size: 6, symbol: "triangle-down" }, type: "scattergl" },
    { ...series(t, d.sway), name: "sway", yaxis: "y2", line: { color: c[1], width: 1 }, type: "scattergl" },
    { ...series(t, d.heave), name: "heave", yaxis: "y3", line: { color: c[2], width: 1 }, type: "scattergl" },
  );
  Plotly.react("signals", traces, layout({
    xaxis: ax({ type: "date", anchor: "y3" }),
    yaxis: ax({ domain: [0.5, 1], title: { text: "surge m/s²" } }),
    yaxis2: ax({ domain: [0.26, 0.47], title: { text: "sway" } }),
    yaxis3: ax({ domain: [0, 0.23], title: { text: "heave" } }),
  }), cfg);
}

function renderOrientation() {
  const c = colors();
  const { t } = S;
  const d = S.disp;
  const traces = [
    { ...series(t, d.roll), name: "roll (+ stbd down)", line: { color: c[0], width: 1.2 }, type: "scattergl" },
    { ...series(t, d.pitch), name: "pitch (+ bow up)", yaxis: "y2", line: { color: c[1], width: 1 }, type: "scattergl" },
  ];
  if (d.yaw) traces.push({ ...series(t, d.yaw), name: "yaw rate", yaxis: "y3", line: { color: c[2], width: 1 }, type: "scattergl" });
  Plotly.react("orient", traces, layout({
    xaxis: ax({ type: "date", anchor: d.yaw ? "y3" : "y2" }),
    yaxis: ax({ domain: d.yaw ? [0.5, 1] : [0.45, 1], title: { text: "roll °" } }),
    yaxis2: ax({ domain: d.yaw ? [0.26, 0.47] : [0, 0.4], title: { text: "pitch °" } }),
    yaxis3: ax({ domain: [0, 0.23], title: { text: "yaw °/s" } }),
  }), cfg);
}

// One trace per third of the selection (early/middle/late) so drift shows up.
function overlayTraces(curves, sel, signal, unit) {
  const c = colors();
  const timeMode = document.querySelector('input[name="xmode"]:checked').value === "time";
  const groups = [[], [], []];
  sel.forEach(([, k], j) => groups[Math.min(2, Math.floor((3 * j) / Math.max(1, sel.length)))].push([k, j]));
  const names = ["early", "middle", "late"];
  const traces = groups.map((g, gi) => {
    const xs = [], ys = [];
    for (const [k, j] of g) {
      const st = S.strokes[k];
      if (timeMode) {
        for (let i = st.i0; i <= st.i1; i++) {
          xs.push(S.t[i] - st.t0);
          ys.push(signal[i]);
        }
      } else {
        curves[j].forEach((v, i) => {
          xs.push(i);
          ys.push(v);
        });
      }
      xs.push(null);
      ys.push(null);
    }
    return { x: xs, y: ys, name: `${names[gi]} third`, mode: "lines", line: { color: [c[0], c[2], c[1]][gi], width: 1 }, opacity: 0.45, hoverinfo: "skip", type: "scattergl" };
  });
  const mean = meanOf(curves);
  if (mean.length) {
    const sd = sdOf(curves, mean);
    const meanDur = sel.reduce((a, [m]) => a + m.dur, 0) / sel.length;
    const x = Array.from(mean, (_, i) => (timeMode ? (i / 100) * meanDur : i));
    traces.push(
      { x, y: Array.from(mean, (v, i) => v + sd[i]), mode: "lines", line: { width: 0 }, showlegend: false, hoverinfo: "skip" },
      { x, y: Array.from(mean, (v, i) => v - sd[i]), mode: "lines", line: { width: 0 }, fill: "tonexty", fillcolor: "rgba(128,128,128,0.25)", name: "±1 sd", hoverinfo: "skip" },
      { x, y: Array.from(mean), name: "mean", mode: "lines", line: { color: css("--fg"), width: 2.5 }, hovertemplate: `%{y:.2f} ${unit}<extra>mean</extra>` },
    );
  }
  return { traces, xTitle: timeMode ? "time since catch (s)" : "% of stroke (catch → catch)" };
}

function renderOverlay(sel) {
  const s = overlayTraces(S.selCurves, sel, S.disp.surge, "m/s²");
  Plotly.react("overlaySurge", s.traces, layout({ hovermode: "closest", xaxis: ax({ title: { text: s.xTitle } }), yaxis: ax({ title: { text: "surge m/s²" } }), title: { text: `Boat acceleration · ${sel.length} strokes`, font: { size: 13 } } }), cfg);
  const r = overlayTraces(S.selRoll, sel, S.disp.roll, "°");
  Plotly.react("overlayRoll", r.traces, layout({ hovermode: "closest", xaxis: ax({ title: { text: r.xTitle } }), yaxis: ax({ title: { text: "roll ° (+ stbd down)" } }), title: { text: "Roll through the stroke", font: { size: 13 } } }), cfg);
}

function renderTrends() {
  const c = colors();
  const ms = S.metrics;
  const x = ms.map((m) => xOf(m.t0));
  const rows = [
    ["rate", "spm", (m) => m.rate],
    ["split", "/500m", (m) => (m.speed > 0.5 ? 500 / m.speed : NaN)],
    ["dps", "m/stroke", (m) => m.dps],
    ["catchAcc", "catch m/s²", (m) => m.catchAcc],
    ["peakAcc", "peak m/s²", (m) => m.peakAcc],
    ["ratio", "drive:rec", (m) => m.ratio],
    ["rollRange", "roll range °", (m) => m.rollRange],
    ["similarity", "consistency r", (m) => m.similarity],
  ];
  const n = rows.length;
  const gap = 0.02;
  const h = (1 - gap * (n - 1)) / n;
  const { t0, t1 } = S.sel;
  const inSel = ms.filter((m) => m.t0 >= t0 && m.t1 <= t1);
  const lay = layout({
    hovermode: "closest", showlegend: false, margin: { l: 90, r: 16, t: 10, b: 40 },
    xaxis: ax({ type: "date", anchor: `y${rows.length}`, range: [xOf(t0), xOf(t1)] }),
  });
  const traces = rows.map(([, label, fn], i) => {
    const key = i ? `yaxis${i + 1}` : "yaxis";
    const top = 1 - i * (h + gap);
    const vals = inSel.map(fn);
    lay[key] = ax({ domain: [top - h, top], title: { text: label, font: { size: 11 } } });
    Object.assign(lay[key], label === "/500m" ? { ...splitAxis(vals), title: { text: label, font: { size: 11 } } } : { range: robustRange(vals) });
    return { x, y: ms.map(fn), mode: "markers", marker: { size: 4, color: c[i % c.length] }, yaxis: i ? `y${i + 1}` : "y", name: label, type: "scattergl", hovertemplate: `%{y:.2f} ${label}<extra></extra>` };
  });
  Plotly.react("trends", traces, lay, cfg);
}

function renderRoll(ms) {
  const c = colors();
  const [i0, i1] = rangeIdx(S.sel.t0, S.sel.t1);
  const step = Math.max(1, Math.ceil((i1 - i0) / 100000));
  const r = [];
  for (let i = i0; i < i1; i += step) r.push(S.frame.roll[i]);
  Plotly.react("rollHist", [{ x: r, type: "histogram", nbinsx: 80, marker: { color: c[0] }, name: "roll" }], layout({
    hovermode: "closest", showlegend: false,
    title: { text: "Roll distribution (+ = starboard down)", font: { size: 13 } },
    xaxis: ax({ title: { text: "roll °" } }), yaxis: ax({ title: { text: "samples" } }),
    shapes: [{ type: "line", x0: 0, x1: 0, yref: "paper", y0: 0, y1: 1, line: { color: css("--fg"), width: 1 } }],
  }), cfg);
  const x = ms.map((m) => xOf(m.t0));
  Plotly.react("rollSide", [
    { x, y: ms.map((m) => m.rollMean), name: "mean roll", mode: "markers", marker: { size: 4, color: c[0] }, type: "scattergl" },
    { x, y: ms.map((m) => m.rollCatch), name: "roll at catch", mode: "markers", marker: { size: 4, color: c[1] }, type: "scattergl" },
  ], layout({
    hovermode: "closest",
    title: { text: "Per-stroke roll", font: { size: 13 } },
    xaxis: ax({ type: "date" }), yaxis: ax({ title: { text: "° (+ stbd down)" } }),
  }), cfg);
}

const COLUMNS = [
  ["n", "#", 0], ["t0", "time", "t"], ["rate", "spm", 1], ["dur", "dur s", 2], ["speed", "split", "split"],
  ["dps", "m/stroke", 2], ["catchAcc", "catch m/s²", 2], ["peakAcc", "peak m/s²", 2], ["tPeak", "t peak s", 2],
  ["drive", "drive s", 2], ["ratio", "drive:rec", 2], ["rollMean", "roll °", 1], ["rollCatch", "roll catch °", 1],
  ["rollRange", "roll range °", 1], ["pitchRange", "pitch range °", 1], ["similarity", "r", 3], ["hr", "hr", 0],
];

function cell(m, [key, , d]) {
  if (d === "t") return fmtTime(m[key]);
  if (d === "split") return fmtSplit(m[key]);
  return f(m[key], d);
}

function renderTable(ms) {
  const head = `<tr>${COLUMNS.map(([, h]) => `<th>${h}</th>`).join("")}</tr>`;
  const body = ms.map((m) => `<tr>${COLUMNS.map((col) => `<td>${cell(m, col)}</td>`).join("")}</tr>`).join("");
  $("table").innerHTML = head + body;
}

function downloadCsv() {
  const ms = selected().map(([m]) => m);
  const lines = [COLUMNS.map(([k]) => k).join(",")];
  for (const m of ms) lines.push(COLUMNS.map(([k]) => (Number.isFinite(m[k]) ? +m[k].toFixed(4) : "")).join(","));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = S.name.replace(/\.fit$/i, "") + "-strokes.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- map ----------
function renderMap() {
  const r = S.act.rec;
  const pts = r.t.map((t, i) => [r.lat[i], r.lon[i], r.speed[i], t]).filter((p) => p[0] != null && p[1] != null);
  $("mapCard").hidden = false;
  if (S.map) {
    S.map.remove();
    S.map = null;
  }
  if (pts.length < 2) {
    $("map").hidden = true;
    $("mapNote").textContent = "No GPS positions in this file.";
    return;
  }
  $("map").hidden = false;
  $("mapNote").textContent = "Track coloured by speed (slow → fast); the selection is outlined.";
  const map = L.map("map");
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(map);
  const sp = pts.map((p) => p[2]).filter(Number.isFinite).sort((a, b) => a - b);
  const lo = sp[Math.floor(0.05 * sp.length)] ?? 0, hi = sp[Math.floor(0.95 * sp.length)] ?? 1;
  const ramp = ["#2c7bb6", "#00a6ca", "#90eb9d", "#f9d057", "#f29e2e", "#d7191c"];
  for (let i = 1; i < pts.length; i++) {
    const k = Math.max(0, Math.min(ramp.length - 1, Math.floor(((pts[i][2] - lo) / (hi - lo || 1)) * ramp.length)));
    L.polyline([pts[i - 1], pts[i]].map((p) => [p[0], p[1]]), { color: ramp[k], weight: 4 }).addTo(map);
  }
  map.fitBounds(pts.map((p) => [p[0], p[1]]), { padding: [20, 20] });
  S.map = map;
  S.mapPts = pts;
}

function highlightMap() {
  if (!S.map) return;
  S.selLine?.remove();
  const sel = S.mapPts.filter((p) => p[3] >= S.sel.t0 && p[3] <= S.sel.t1).map((p) => [p[0], p[1]]);
  if (sel.length > 1) S.selLine = L.polyline(sel, { color: css("--fg"), weight: 8, opacity: 0.35 }).addTo(S.map);
}

// ---------- wiring ----------
function onFile(file) {
  if (file) load(file);
}

$("file").addEventListener("change", (e) => onFile(e.target.files[0]));
const drop = $("drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  onFile(e.dataTransfer.files[0]);
});

$("sel").addEventListener("change", (e) => {
  const v = e.target.value;
  if (v === "all") setSelection(S.t[0], S.t[S.t.length - 1]);
  else if (v.startsWith("p")) {
    const p = S.pieces[+v.slice(1)];
    setSelection(p.t0, p.t1);
  } else if (v !== "custom") {
    const l = S.act.laps[+v - 1];
    setSelection(l.t0, l.t1);
  }
});
$("ftype").addEventListener("change", () => {
  const ma = $("ftype").value === "ma";
  $("fc").value = ma ? 150 : 5;
  $("fc").step = ma ? 10 : 0.5;
  $("fc").max = ma ? 2000 : 40;
  $("fcUnit").textContent = ma ? "ms" : "Hz";
  $("fc").disabled = $("ftype").value === "none";
  if (S.t) filterDisplay();
});
$("fc").addEventListener("change", () => S.t && filterDisplay());
$("beta").addEventListener("input", () => ($("betaOut").textContent = $("beta").value));
$("beta").addEventListener("change", () => S.t && computeOrientation());
$("sens").addEventListener("input", () => ($("sensOut").textContent = $("sens").value));
$("sens").addEventListener("change", () => S.t && detect());
$("flip").addEventListener("click", () => {
  S.flip = !S.flip;
  applyFrame();
});
$("showRaw").addEventListener("change", () => {
  if (!S.t) return;
  renderSignals();
  fitSelection();
});
document.querySelectorAll('input[name="xmode"]').forEach((r) => r.addEventListener("change", () => renderOverlay(selected())));
$("csv").addEventListener("click", downloadCsv);
