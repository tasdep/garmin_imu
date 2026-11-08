# garmin_imu

Raw IMU recording and live boat-acceleration display for rowing on a Garmin Forerunner 965 (Connect IQ).

## Web analyzer

`docs/` is a static, client-side app (GitHub Pages) for exploring a Row IMU `.fit` file: interactive plots, display filters, complementary-filter orientation (roll/pitch/yaw rate), stroke detection, stroke overlays, consistency and roll-balance stats, GPS track, and per-stroke CSV export. Files are parsed in the browser and never uploaded.

Run it locally with `python3 -m http.server 8765` from the repo root, then open http://127.0.0.1:8765/docs/.

## FR965 findings (imu-probe, 2026-11-02, firmware 29.05)

- `Sensor.getMaxSampleRate()` = 50; `getMaxSampleRateForSensorType` = 100 for accel and gyro.
- Accel + gyro register together in one listener (the gyro is exposed, despite forum reports).
- Requested 50 Hz: delivered 50 samples per 1 s batch, timestamps confirm ~50 Hz for both.
- Accel at rest reads ~1000 mg magnitude (e.g. -161,-343,-921), so values are calibrated milli-g.
- `Toybox.SensorLogging` is available. Even `Toybox has :SensorLogging` needs the `SensorLogging` permission.

## Workflow notes

- Ubuntu 22.04's libmtp 1.1.19 doesn't know the FR965 (USB 091e:50db): MTP drops after ~30 s. libmtp >= 1.1.22 fixes it.
- Sideload: copy the `.prg` to `GARMIN/Apps/`; it installs on unplug.
- Crash logs: `GARMIN/Apps/LOGS/CIQ_LOG.YML`. `System.println` output goes to `GARMIN/Apps/LOGS/<PRG name>.TXT` if that file exists.
