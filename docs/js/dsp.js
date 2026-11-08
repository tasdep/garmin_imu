// Signal processing for rowing IMU data: filters, orientation, boat frame,
// stroke detection and per-stroke metrics. Plain functions on arrays so they
// run in the browser and under Node.

export const G = 9.80665;
const DEG = 180 / Math.PI;

export function medianDt(t) {
  const d = [];
  for (let i = 1; i < Math.min(t.length, 5001); i++) d.push(t[i] - t[i - 1]);
  d.sort((a, b) => a - b);
  return d[d.length >> 1];
}

export function percentile(x, p) {
  const s = Array.from(x).filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
}

export function median(x) {
  return percentile(x, 0.5);
}

export function summarize(x) {
  const v = x.filter(Number.isFinite);
  if (!v.length) return { mean: NaN, sd: NaN, cv: NaN, n: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length - 1));
  return { mean, sd, cv: (100 * sd) / Math.abs(mean), n: v.length };
}

// [start, end) index ranges split at gaps (pauses leave multi-second holes).
export function segments(t, maxGap = 0.2) {
  const out = [];
  let s = 0;
  for (let i = 1; i < t.length; i++) {
    if (t[i] - t[i - 1] > maxGap) {
      out.push([s, i]);
      s = i;
    }
  }
  out.push([s, t.length]);
  return out;
}

// Butterworth as cascaded RBJ biquads; section k has Q = 1 / (2 sin((2k-1)pi/2N)).
function lowpassSections(fc, fs, order) {
  const w0 = (2 * Math.PI * fc) / fs;
  const c = Math.cos(w0);
  const secs = [];
  for (let k = 1; k <= order / 2; k++) {
    const q = 1 / (2 * Math.sin(((2 * k - 1) * Math.PI) / (2 * order)));
    const al = Math.sin(w0) / (2 * q);
    const a0 = 1 + al;
    secs.push([(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0]);
  }
  return secs;
}

function runSections(x, secs) {
  // Start from rest at x[0] (unity DC gain) to avoid a step transient.
  const x0 = x[0];
  for (const [b0, b1, b2, a1, a2] of secs) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i] - x0;
      const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = xi; y2 = y1; y1 = y;
      x[i] = y + x0;
    }
  }
}

function filtfilt(seg, secs, pad) {
  const n = seg.length;
  pad = Math.min(pad, n - 2);
  const buf = new Float64Array(n + 2 * pad);
  // Odd reflection keeps the ends continuous so edge transients stay in the pad.
  for (let i = 0; i < pad; i++) buf[i] = 2 * seg[0] - seg[pad - i];
  buf.set(seg, pad);
  for (let i = 0; i < pad; i++) buf[pad + n + i] = 2 * seg[n - 1] - seg[n - 2 - i];
  runSections(buf, secs);
  buf.reverse();
  runSections(buf, secs);
  buf.reverse();
  return buf.subarray(pad, pad + n);
}

// Zero-phase Butterworth low-pass, applied per contiguous segment.
export function lowpass(x, t, fc, order = 4) {
  const fs = 1 / medianDt(t);
  const out = Float64Array.from(x);
  if (!(fc > 0) || fc >= 0.45 * fs) return out;
  const secs = lowpassSections(fc, fs, order);
  const pad = Math.round((3 * fs) / fc);
  for (const [s, e] of segments(t)) {
    if (e - s > 3) out.set(filtfilt(out.slice(s, e), secs, pad), s);
  }
  return out;
}

export function movingAverage(x, t, ms) {
  const half = Math.max(0, Math.round((ms / 1000 / medianDt(t)) / 2));
  const out = new Float64Array(x.length);
  for (const [s, e] of segments(t)) {
    const cs = new Float64Array(e - s + 1);
    for (let i = s; i < e; i++) cs[i - s + 1] = cs[i - s] + x[i];
    for (let i = s; i < e; i++) {
      const a = Math.max(s, i - half), b = Math.min(e - 1, i + half);
      out[i] = (cs[b - s + 1] - cs[a - s]) / (b - a + 1);
    }
  }
  return out;
}

export function smooth(x, t, { type, fc, ms }) {
  if (type === "butter") return lowpass(x, t, fc);
  if (type === "ma") return movingAverage(x, t, ms);
  return Float64Array.from(x);
}

// Linear interpolation of (ts, ys) at td; nulls in ys are skipped, ends clamped.
export function interp(ts, ys, td) {
  const xs = [], vs = [];
  ts.forEach((t, i) => {
    if (ys[i] != null && Number.isFinite(ys[i])) {
      xs.push(t);
      vs.push(ys[i]);
    }
  });
  const out = new Float64Array(td.length).fill(NaN);
  if (!xs.length) return out;
  let j = 0;
  for (let i = 0; i < td.length; i++) {
    const t = td[i];
    while (j < xs.length - 2 && xs[j + 1] < t) j++;
    if (t <= xs[0]) out[i] = vs[0];
    else if (t >= xs[xs.length - 1]) out[i] = vs[vs.length - 1];
    else {
      const k = xs[j + 1] - xs[j];
      out[i] = k > 0 ? vs[j] + ((vs[j + 1] - vs[j]) * (t - xs[j])) / k : vs[j];
    }
  }
  return out;
}

// Madgwick 6-DOF AHRS (Madgwick 2010, IMU variant). Returns the estimated
// "up" direction in the sensor frame per sample, i.e. what the accelerometer
// would read with no linear acceleration. Gyro bias is taken as the per-axis
// median, and the accel correction is skipped when |a| is far from 1 g so
// boat surges and knocks don't tilt the estimate.
export function madgwick(t, a, g, beta = 0.04) {
  const n = t.length;
  const rad = Math.PI / 180;
  const bias = g.map(median);
  const ux = new Float64Array(n), uy = new Float64Array(n), uz = new Float64Array(n);
  let q0 = 1, q1 = 0, q2 = 0, q3 = 0;

  function step(i, b, dt, useGyro) {
    const gx = useGyro ? (g[0][i] - bias[0]) * rad : 0;
    const gy = useGyro ? (g[1][i] - bias[1]) * rad : 0;
    const gz = useGyro ? (g[2][i] - bias[2]) * rad : 0;
    let d0 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz);
    let d1 = 0.5 * (q0 * gx + q2 * gz - q3 * gy);
    let d2 = 0.5 * (q0 * gy - q1 * gz + q3 * gx);
    let d3 = 0.5 * (q0 * gz + q1 * gy - q2 * gx);
    let ax = a[0][i], ay = a[1][i], az = a[2][i];
    const an = Math.hypot(ax, ay, az);
    if (an > 0 && Math.abs(an - 1000) < 300) {
      ax /= an; ay /= an; az /= an;
      const _2q0 = 2 * q0, _2q1 = 2 * q1, _2q2 = 2 * q2, _2q3 = 2 * q3;
      const _4q0 = 4 * q0, _4q1 = 4 * q1, _4q2 = 4 * q2, _8q1 = 8 * q1, _8q2 = 8 * q2;
      const q0q0 = q0 * q0, q1q1 = q1 * q1, q2q2 = q2 * q2, q3q3 = q3 * q3;
      let s0 = _4q0 * q2q2 + _2q2 * ax + _4q0 * q1q1 - _2q1 * ay;
      let s1 = _4q1 * q3q3 - _2q3 * ax + 4 * q0q0 * q1 - _2q0 * ay - _4q1 + _8q1 * q1q1 + _8q1 * q2q2 + _4q1 * az;
      let s2 = 4 * q0q0 * q2 + _2q0 * ax + _4q2 * q3q3 - _2q3 * ay - _4q2 + _8q2 * q1q1 + _8q2 * q2q2 + _4q2 * az;
      let s3 = 4 * q1q1 * q3 - _2q1 * ax + 4 * q2q2 * q3 - _2q2 * ay;
      const sn = Math.hypot(s0, s1, s2, s3);
      if (sn > 0) {
        d0 -= (b * s0) / sn; d1 -= (b * s1) / sn; d2 -= (b * s2) / sn; d3 -= (b * s3) / sn;
      }
    }
    q0 += d0 * dt; q1 += d1 * dt; q2 += d2 * dt; q3 += d3 * dt;
    const qn = Math.hypot(q0, q1, q2, q3);
    q0 /= qn; q1 /= qn; q2 /= qn; q3 /= qn;
  }

  const dt0 = medianDt(t);
  // Settle the initial attitude on the first 2 s using gravity only.
  const warm = Math.min(n, Math.round(2 / dt0));
  for (let k = 0; k < 20; k++) for (let i = 0; i < warm; i++) step(i, 1, dt0, false);
  for (let i = 0; i < n; i++) {
    let dt = i ? t[i] - t[i - 1] : dt0;
    if (!(dt > 0) || dt > 0.2) dt = dt0;
    step(i, beta, dt, true);
    ux[i] = 2 * (q1 * q3 - q0 * q2);
    uy[i] = 2 * (q0 * q1 + q2 * q3);
    uz[i] = q0 * q0 - q1 * q1 - q2 * q2 + q3 * q3;
  }
  return [ux, uy, uz];
}

// Without a gyro: up = normalised slow low-pass of the accel.
export function upFromAccel(t, a) {
  const f = a.map((c) => lowpass(c, t, 0.3, 2));
  const n = t.length;
  const out = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  for (let i = 0; i < n; i++) {
    const m = Math.hypot(f[0][i], f[1][i], f[2][i]) || 1;
    for (let k = 0; k < 3; k++) out[k][i] = f[k][i] / m;
  }
  return out;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const m = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / m, a[1] / m, a[2] / m];
};

// Boat frame from a rigidly mounted watch: up = mean gravity direction, forward
// = dominant horizontal acceleration (surge), left = up x forward. Roll and
// pitch are relative to the session-average level.
export function boatFrame(t, a, up, gyro) {
  const n = t.length;
  let u = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) u[k] += up[k][i];
  u = norm(u);

  const lin = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) lin[k][i] = a[k][i] - 1000 * up[k][i];

  // Covariance of horizontal accel (3 Hz low-passed, knocks over 2 g excluded).
  const lf = lin.map((c) => lowpass(c, t, 3));
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) {
    const v = [lf[0][i], lf[1][i], lf[2][i]];
    if (Math.hypot(v[0], v[1], v[2]) > 2000) continue;
    const h = dot(v, u);
    const w = [v[0] - h * u[0], v[1] - h * u[1], v[2] - h * u[2]];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r][c] += w[r] * w[c];
  }
  let f = norm(cross(u, Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  for (let k = 0; k < 50; k++) f = norm([dot(C[0], f), dot(C[1], f), dot(C[2], f)]);
  const fh = dot(f, u);
  f = norm([f[0] - fh * u[0], f[1] - fh * u[1], f[2] - fh * u[2]]);
  const l = cross(u, f);

  const toMs2 = G / 1000;
  const surge = new Float64Array(n), sway = new Float64Array(n), heave = new Float64Array(n);
  const roll = new Float64Array(n), pitch = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = [lin[0][i], lin[1][i], lin[2][i]];
    const w = [up[0][i], up[1][i], up[2][i]];
    surge[i] = dot(v, f) * toMs2;
    sway[i] = dot(v, l) * toMs2;
    heave[i] = dot(v, u) * toMs2;
    // Positive roll = starboard side down, positive pitch = bow up.
    roll[i] = Math.atan2(dot(w, l), dot(w, u)) * DEG;
    pitch[i] = Math.atan2(dot(w, f), dot(w, u)) * DEG;
  }
  let yawRate = null;
  if (gyro) {
    const bias = gyro.map(median);
    yawRate = new Float64Array(n);
    for (let i = 0; i < n; i++) yawRate[i] = dot([gyro[0][i] - bias[0], gyro[1][i] - bias[1], gyro[2][i] - bias[2]], u);
  }
  return { u, f, l, surge, sway, heave, roll, pitch, yawRate };
}

// Reverse the forward direction (forward and left both flip).
export function flipFrame(fr) {
  const neg = (x) => x.map((v) => -v);
  return {
    ...fr,
    f: neg(fr.f), l: neg(fr.l),
    surge: neg(fr.surge), sway: neg(fr.sway), roll: neg(fr.roll), pitch: neg(fr.pitch),
  };
}

// The catch is a short, deep deceleration while the drive is a broader, lower
// positive hump, so the correct sign puts the deeper tail on the negative side.
export function forwardLooksReversed(surgeLp) {
  return Math.abs(percentile(surgeLp, 0.995)) > Math.abs(percentile(surgeLp, 0.005));
}

// Catches = prominent minima of the low-passed surge acceleration that are at
// least depthFrac as deep as the deepest dip within +-localWin. On water each
// stroke also has a shallow secondary dip (~-1.5 vs ~-8 m/s2 at the catch in
// the 2026-11-08 session) that a global prominence threshold let through.
export function detectStrokes(t, s, { minDist = 0.7, minDur = 0.75, maxDur = 4.5, depthFrac = 0.5, minProm = 1.0, win = 2.5, localWin = 2.0 } = {}) {
  const n = s.length;
  const cand = [];
  for (let i = 1; i < n - 1; i++) if (s[i] < 0 && s[i] <= s[i - 1] && s[i] < s[i + 1]) cand.push(i);
  const prom = cand.map((i) => {
    let lm = -Infinity, rm = -Infinity;
    for (let j = i - 1; j >= 0 && t[i] - t[j] <= win && s[j] >= s[i]; j--) lm = Math.max(lm, s[j]);
    for (let j = i + 1; j < n && t[j] - t[i] <= win && s[j] >= s[i]; j++) rm = Math.max(rm, s[j]);
    if (lm === -Infinity) lm = rm;
    if (rm === -Infinity) rm = lm;
    return Math.min(lm, rm) - s[i];
  });
  const deepEnough = (i) => {
    let lo = s[i];
    for (let j = i - 1; j >= 0 && t[i] - t[j] <= localWin; j--) lo = Math.min(lo, s[j]);
    for (let j = i + 1; j < n && t[j] - t[i] <= localWin; j++) lo = Math.min(lo, s[j]);
    return s[i] <= depthFrac * lo;
  };
  const keep = cand.filter((i, k) => prom[k] >= minProm && deepEnough(i)).sort((a, b) => s[a] - s[b]);

  // Deepest first; drop anything closer than minDist to an accepted catch.
  const accepted = [];
  const times = [];
  for (const i of keep) {
    let lo = 0, hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t[i]) lo = mid + 1; else hi = mid;
    }
    const near = (lo < times.length && times[lo] - t[i] < minDist) || (lo > 0 && t[i] - times[lo - 1] < minDist);
    if (!near) {
      times.splice(lo, 0, t[i]);
      accepted.splice(lo, 0, i);
    }
  }

  // Rhythm check: an occasionally deep mid-stroke dip splits one stroke into
  // two ~half-length ones (6-9 times per 3k piece on 2026-11-08). Drop the
  // middle catch when both halves are short but together make a normal stroke.
  for (let pass = 0; pass < 2; pass++) {
    const durs = [];
    for (let k = 0; k + 1 < accepted.length; k++) durs.push(t[accepted[k + 1]] - t[accepted[k]]);
    const drop = new Set();
    for (let k = 1; k < durs.length; k++) {
      if (drop.has(k - 1)) continue;
      const local = median(durs.slice(Math.max(0, k - 8), k + 9).filter((d) => d <= maxDur));
      const a = durs[k - 1], b = durs[k];
      if (a < 0.7 * local && b < 0.7 * local && a + b < 1.3 * local) drop.add(k);
    }
    if (!drop.size) break;
    for (const k of [...drop].sort((x, y) => y - x)) accepted.splice(k, 1);
  }

  const segId = new Int32Array(n);
  segments(t).forEach(([s0, e0], k) => segId.fill(k, s0, e0));
  const strokes = [];
  for (let k = 0; k + 1 < accepted.length; k++) {
    const i0 = accepted[k], i1 = accepted[k + 1];
    const dur = t[i1] - t[i0];
    if (dur >= minDur && dur <= maxDur && segId[i0] === segId[i1]) strokes.push({ i0, i1, t0: t[i0], t1: t[i1] });
  }
  return strokes;
}

// Per-stroke metrics. rec* are per-sample arrays interpolated from the 1 Hz
// records (NaN when missing).
export function strokeMetrics(strokes, { t, surge, roll, pitch, dist, speed, hr }) {
  return strokes.map((st, k) => {
    const { i0, i1 } = st;
    const dur = t[i1] - t[i0];
    let ip = i0;
    const peakEnd = i0 + Math.floor(0.7 * (i1 - i0));
    for (let i = i0; i <= peakEnd; i++) if (surge[i] > surge[ip]) ip = i;
    // Finish = the release dip: lowest surge between the drive peak and 65 %
    // of the stroke. On 2026-11-08 (33 spm) it sat at ~45 % with the recovery
    // hump at ~70 %; searching further reaches the slide into the next catch.
    let iF = ip;
    const finEnd = i0 + Math.floor(0.65 * (i1 - i0));
    for (let i = ip; i <= finEnd; i++) if (surge[i] < surge[iF]) iF = i;
    const drive = iF > ip ? t[iF] - t[i0] : NaN;
    let rMin = Infinity, rMax = -Infinity, rSum = 0, pMin = Infinity, pMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (let i = i0; i < i1; i++) {
      rMin = Math.min(rMin, roll[i]); rMax = Math.max(rMax, roll[i]); rSum += roll[i];
      pMin = Math.min(pMin, pitch[i]); pMax = Math.max(pMax, pitch[i]);
      vMin = Math.min(vMin, surge[i]); vMax = Math.max(vMax, surge[i]);
    }
    const dps = dist[i1] - dist[i0];
    return {
      n: k + 1,
      t0: st.t0,
      t1: st.t1,
      dur,
      rate: 60 / dur,
      catchAcc: surge[i0],
      minAcc: vMin,
      peakAcc: surge[ip],
      tPeak: t[ip] - t[i0],
      tFinish: t[iF],
      finishAcc: surge[iF],
      drive,
      ratio: drive / (dur - drive),
      rollMean: rSum / (i1 - i0),
      rollCatch: roll[i0],
      rollRange: rMax - rMin,
      pitchRange: pMax - pMin,
      dps: Number.isFinite(dps) && dps > 0 ? dps : NaN,
      speed: Number.isFinite(dps) && dps > 0 ? dps / dur : speed[(i0 + i1) >> 1],
      hr: hr[(i0 + i1) >> 1],
    };
  });
}

// x resampled to N points over the time window [ta, tb] (e.g. one stroke).
export function windowCurve(t, x, ta, tb, N = 101) {
  const out = new Float64Array(N);
  let lo = 0, hi = t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < ta) lo = mid + 1; else hi = mid;
  }
  let j = Math.max(0, lo - 1);
  for (let k = 0; k < N; k++) {
    const tk = ta + ((tb - ta) * k) / (N - 1);
    while (j < t.length - 2 && t[j + 1] < tk) j++;
    const dt = t[j + 1] - t[j];
    out[k] = dt > 0 ? x[j] + ((x[j + 1] - x[j]) * (tk - t[j])) / dt : x[j];
  }
  return out;
}

export function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  return sab / Math.sqrt(saa * sbb);
}

// Work pieces: stretches of at least minDur s where the 20 s mean GPS speed
// stays above frac x the session's 90th-percentile speed. Found the two 3k
// pieces of the 2026-11-08 session exactly.
export function findPieces(rec, { frac = 0.85, minDur = 180 } = {}) {
  const { t, speed, dist } = rec;
  const n = t.length;
  const sm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - 10); j <= Math.min(n - 1, i + 10); j++) {
      if (speed[j] != null) {
        s += speed[j];
        c++;
      }
    }
    sm[i] = c ? s / c : 0;
  }
  const thr = frac * percentile(speed.filter((v) => v != null), 0.9);
  const pieces = [];
  for (let i = 0; i < n; ) {
    if (!(sm[i] > thr)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && sm[j] > thr) j++;
    if (t[j - 1] - t[i] >= minDur) pieces.push({ t0: t[i], t1: t[j - 1], dist: dist[j - 1] - dist[i] });
    i = j;
  }
  return pieces;
}
