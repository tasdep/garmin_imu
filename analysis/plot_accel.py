# /// script
# dependencies = ["fitdecode", "numpy", "scipy", "matplotlib"]
# ///
"""Plot raw SensorLogger accel (and gyro, if logged) from a FIT file and compare smoothings.

Usage: uv run analysis/plot_accel.py <file.fit> [--start S] [--end S] [-o out.png]
"""
import argparse

import fitdecode
import matplotlib.pyplot as plt
import numpy as np
from scipy.signal import butter, filtfilt


SENSORS = {"accelerometer_data": "calibrated_accel", "gyroscope_data": "calibrated_gyro"}


def load_imu(path):
    """Return {message name: (t [s from first accel sample], v [n x 3])} for logged sensors.

    Accel is in mg, gyro in deg/s.
    """
    raw = {name: ([], []) for name in SENSORS}
    with fitdecode.FitReader(path) as reader:
        for frame in reader:
            if not (isinstance(frame, fitdecode.FitDataMessage) and frame.name in SENSORS):
                continue
            t, v = raw[frame.name]
            base = frame.get_value("timestamp").timestamp() * 1000 + frame.get_value("timestamp_ms")
            t += [base + off for off in frame.get_value("sample_time_offset")]
            v += zip(*(frame.get_value(f"{SENSORS[frame.name]}_{c}") for c in "xyz"))
    t0 = raw["accelerometer_data"][0][0]
    return {name: ((np.array(t) - t0) / 1000, np.array(v)) for name, (t, v) in raw.items() if t}


def load_accel(path):
    return load_imu(path)["accelerometer_data"]


def lowpass(x, cutoff_hz, fs, order=4):
    # Zero-phase, so peaks stay aligned in time with the raw signal.
    b, a = butter(order, cutoff_hz / (fs / 2))
    return filtfilt(b, a, x, axis=0)


def moving_average(x, n):
    return np.convolve(x, np.ones(n) / n, mode="same")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("fit")
    p.add_argument("--start", type=float, default=0.0, help="crop start [s]")
    p.add_argument("--end", type=float, default=None, help="crop end [s]")
    p.add_argument("-o", "--out", default=None)
    args = p.parse_args()

    imu = load_imu(args.fit)
    t, a = imu["accelerometer_data"]
    fs = (len(t) - 1) / (t[-1] - t[0])
    end = args.end if args.end is not None else t[-1]
    keep = (t >= args.start) & (t <= end)
    t, a = t[keep], a[keep]
    gyro = imu.get("gyroscope_data")

    # Gravity = what's left below 0.2 Hz; strokes (~0.5 Hz) sit well above it.
    dyn = a - lowpass(a, 0.2, fs, order=2)
    # Surge = principal axis of the dynamic accel, same idea as the watch app.
    _, _, vt = np.linalg.svd(dyn - dyn.mean(axis=0), full_matrices=False)
    surge = dyn @ vt[0]

    fig, ax = plt.subplots(4 if gyro else 3, 1, figsize=(13, 12 if gyro else 9), sharex=True)
    for i, c in enumerate("xyz"):
        ax[0].plot(t, dyn[:, i], lw=0.6, label=f"{c} (gravity removed)")
    ax[0].set_title(f"{args.fit}  ({fs:.1f} Hz, surge axis {np.round(vt[0], 2)})")
    ax[0].legend(ncol=3, loc="upper right")

    ax[1].plot(t, surge, color="0.75", lw=0.6, label="raw")
    for ms in (50, 150, 300):
        ax[1].plot(t, moving_average(surge, max(1, round(ms * fs / 1000))), lw=1, label=f"moving avg {ms} ms")
    ax[1].set_title("Surge: moving average")
    ax[1].legend(ncol=4, loc="upper right")

    ax[2].plot(t, surge, color="0.75", lw=0.6, label="raw")
    for hz in (10, 5, 2):
        ax[2].plot(t, lowpass(surge, hz, fs), lw=1, label=f"Butterworth {hz} Hz")
    ax[2].set_title("Surge: zero-phase low-pass")
    ax[2].legend(ncol=4, loc="upper right")

    for x in ax:
        x.set_ylabel("mg")
    if gyro:
        tg, g = gyro
        gk = (tg >= args.start) & (tg <= end)
        gfs = (len(tg) - 1) / (tg[-1] - tg[0])
        for i, c in enumerate("xyz"):
            ax[3].plot(tg[gk], lowpass(g[gk, i], 5, gfs), lw=0.8, label=f"{c} (5 Hz low-pass)")
        ax[3].set_title(f"Gyro rate ({gfs:.1f} Hz)")
        ax[3].set_ylabel("deg/s")
        ax[3].legend(ncol=3, loc="upper right")
    ax[-1].set_xlabel("time [s]")

    for x in ax:
        x.axhline(0, color="k", lw=0.5)
        x.grid(alpha=0.3)
    fig.tight_layout()
    out = args.out or args.fit.rsplit(".", 1)[0] + ".png"
    fig.savefig(out, dpi=100)
    print(f"{len(t)} samples, {fs:.1f} Hz -> {out}")


if __name__ == "__main__":
    main()
