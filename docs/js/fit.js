// FIT decoding: expands SensorLogger accel/gyro messages into per-sample
// arrays and pulls the 1 Hz records, laps and session. The FIT SDK module is
// passed in so this also runs under Node for testing.

const SEMI_TO_DEG = 180 / 2 ** 31;

function expandSensor(mesgs, prefix) {
  const t = [], x = [], y = [], z = [];
  for (const m of mesgs) {
    const base = m.timestamp.getTime() + (m.timestampMs ?? 0);
    const offs = m.sampleTimeOffset ?? [];
    const cx = m[`${prefix}X`], cy = m[`${prefix}Y`], cz = m[`${prefix}Z`];
    if (!cx) continue;
    for (let k = 0; k < cx.length; k++) {
      t.push(base + (offs[k] ?? 0));
      x.push(cx[k]);
      y.push(cy[k]);
      z.push(cz[k]);
    }
  }
  return { t, x, y, z };
}

export function parseFit(bytes, { Decoder, Stream }) {
  const decoder = new Decoder(Stream.fromByteArray(bytes));
  if (!decoder.isFIT()) throw new Error("Not a FIT file");
  const { messages, errors } = decoder.read({
    convertTypesToStrings: true,
    expandComponents: true,
    mergeHeartRates: true,
  });
  if (errors.length) console.warn("FIT decode errors", errors);

  const acc = expandSensor(messages.accelerometerDataMesgs ?? [], "calibratedAccel");
  if (!acc.t.length) throw new Error("No raw accelerometer data in this file (was it recorded with Row IMU?)");
  const gyr = expandSensor(messages.gyroscopeDataMesgs ?? [], "calibratedGyro");
  const t0 = acc.t[0];
  const rel = (ms) => (ms - t0) / 1000;

  // Developer fields come keyed by field_description order.
  const devNames = {};
  for (const d of messages.fieldDescriptionMesgs ?? []) devNames[d.key] = d.fieldName;
  const imuSrKey = Object.keys(devNames).find((k) => devNames[k] === "imu_stroke_rate");

  const rec = { t: [], speed: [], dist: [], hr: [], cadence: [], imuSr: [], lat: [], lon: [] };
  for (const r of messages.recordMesgs ?? []) {
    rec.t.push(rel(r.timestamp.getTime()));
    rec.speed.push(r.enhancedSpeed ?? r.speed ?? null);
    rec.dist.push(r.distance ?? null);
    rec.hr.push(r.heartRate ?? null);
    rec.cadence.push(r.cadence || null);
    rec.imuSr.push(imuSrKey != null ? r.developerFields?.[imuSrKey] || null : null);
    rec.lat.push(r.positionLat != null ? r.positionLat * SEMI_TO_DEG : null);
    rec.lon.push(r.positionLong != null ? r.positionLong * SEMI_TO_DEG : null);
  }

  // The FR965 writes lap.timestamp equal to start_time, so the end comes from
  // the elapsed time (which includes pauses).
  const laps = (messages.lapMesgs ?? []).map((l, i) => {
    const t0 = rel(l.startTime.getTime());
    return { index: i + 1, t0, t1: t0 + (l.totalElapsedTime ?? 0) };
  });
  const session = messages.sessionMesgs?.[0] ?? {};

  return {
    start: new Date(t0),
    sport: session.sport,
    session,
    accel: { t: acc.t.map(rel), x: acc.x, y: acc.y, z: acc.z },
    gyro: gyr.t.length ? { t: gyr.t.map(rel), x: gyr.x, y: gyr.y, z: gyr.z } : null,
    rec,
    laps,
  };
}
