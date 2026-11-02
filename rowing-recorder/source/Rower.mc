// Sensor processing, stroke rate and the FIT session. The views only read from here.
import Toybox.Activity;
import Toybox.ActivityRecording;
import Toybox.Application;
import Toybox.FitContributor;
import Toybox.Lang;
import Toybox.Math;
import Toybox.Position;
import Toybox.Sensor;
import Toybox.SensorLogging;
import Toybox.System;
import Toybox.WatchUi;

enum RecState { IDLE, RUNNING, PAUSED }

class Rower {
    const WINDOW_S = 6;
    // Gravity is tracked with a slow EMA; strokes are ~2 s, so 10 s keeps the
    // stroke signal out of the gravity estimate.
    private const GRAVITY_TAU_S = 10;
    // Stroke rate runs on block averages at 12.5 Hz over 10 s, which keeps the
    // autocorrelation cheap enough for the watchdog in a 1 s callback.
    private const SR_FS = 12.5;
    private const SR_LEN = 125;
    private const SR_MIN_SPM = 15;
    private const SR_MAX_SPM = 50;
    // Below this RMS (mg) the boat isn't being rowed; don't report a rate.
    private const SR_MIN_RMS = 30.0;
    // Peak normalised autocorrelation needed to trust the period.
    private const SR_MIN_CORR = 0.4;

    static const SMOOTHING_OPTIONS = [0, 10, 5, 3, 2];

    var rate as Number = 0;
    var batchN as Number = 0;
    var err as String = "";
    // Filtered, gravity-removed accel ring buffers (mg).
    var dx as Array<Float> = [];
    var dy as Array<Float> = [];
    var dz as Array<Float> = [];
    var head as Number = 0;
    var count as Number = 0;
    // Unit vector of the dominant motion direction (assumed surge).
    var axis as Array<Float> = [1.0, 0.0, 0.0];
    var sign as Number = 1;
    var smoothHz as Number = 5;
    var strokeRate as Float? = null;
    var state as RecState = IDLE;

    private var _alpha as Float = 0.0;
    private var _g as Array<Float>? = null;
    // Biquad low-pass: coefficients [b0 b1 b2 a1 a2], state per axis [x1 x2 y1 y2].
    private var _bq as Array<Float>? = null;
    private var _bqState as Array<Array<Float> > = [];

    private var _sr as Array<Float> = new Array<Float>[SR_LEN];
    private var _srHead as Number = 0;
    private var _srCount as Number = 0;
    private var _blockSum as Float = 0.0;
    private var _blockN as Number = 0;

    private var _strokes as Float = 0.0;
    private var _srSum as Float = 0.0;
    private var _srSecs as Number = 0;

    private var _session as ActivityRecording.Session? = null;
    private var _logger as SensorLogging.SensorLogger? = null;
    private var _srField as FitContributor.Field? = null;
    private var _strokesField as FitContributor.Field? = null;
    private var _avgSrField as FitContributor.Field? = null;

    function initialize() {
        var s = Application.Storage.getValue("sign");
        if (s instanceof Number) {
            sign = s;
        }
        var h = Application.Storage.getValue("smoothHz");
        if (h instanceof Number) {
            smoothHz = h;
        }
        for (var i = 0; i < SR_LEN; i++) {
            _sr[i] = 0.0;
        }
    }

    function start() as Void {
        Position.enableLocationEvents(Position.LOCATION_CONTINUOUS, method(:onPosition));
        // The probe saw getMaxSampleRate() = 50 but a per-sensor max of 100; try 100 first.
        if (!startListener(100) && !startListener(50)) {
            System.println("listener failed: " + err);
        }
    }

    function stop() as Void {
        Sensor.unregisterSensorDataListener();
        Position.enableLocationEvents(Position.LOCATION_DISABLE, method(:onPosition));
    }

    function onPosition(info as Position.Info) as Void {
    }

    private function startListener(r as Number) as Boolean {
        try {
            Sensor.registerSensorDataListener(method(:onData), {
                :period => 1,
                :accelerometer => {:enabled => true, :sampleRate => r}
            });
        } catch (e) {
            err = "" + e.getErrorMessage();
            return false;
        }
        rate = r;
        _alpha = 1.0 / (r * GRAVITY_TAU_S);
        var len = r * WINDOW_S;
        dx = new Array<Float>[len];
        dy = new Array<Float>[len];
        dz = new Array<Float>[len];
        for (var i = 0; i < len; i++) {
            dx[i] = 0.0;
            dy[i] = 0.0;
            dz[i] = 0.0;
        }
        head = 0;
        count = 0;
        setSmoothing(smoothHz);
        System.println("listener requested " + r + " Hz");
        return true;
    }

    // 2nd-order Butterworth low-pass (RBJ cookbook, Q = 1/sqrt(2)). Causal, so
    // the live plot lags by roughly 1/(4*fc): ~50 ms at 5 Hz.
    function setSmoothing(hz as Number) as Void {
        smoothHz = hz;
        Application.Storage.setValue("smoothHz", hz);
        _bqState = [[0.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 0.0]];
        if (hz == 0 || rate == 0) {
            _bq = null;
            return;
        }
        var w0 = 2 * Math.PI * hz / rate;
        var c = Math.cos(w0);
        var alpha = Math.sin(w0) / (2 * 0.7071);
        var a0 = 1 + alpha;
        _bq = [((1 - c) / 2 / a0).toFloat(), ((1 - c) / a0).toFloat(), ((1 - c) / 2 / a0).toFloat(),
               (-2 * c / a0).toFloat(), ((1 - alpha) / a0).toFloat()];
    }

    private function filt(x as Float, s as Array<Float>) as Float {
        var b = _bq;
        if (b == null) {
            return x;
        }
        var y = b[0] * x + b[1] * s[0] + b[2] * s[1] - b[3] * s[2] - b[4] * s[3];
        s[1] = s[0];
        s[0] = x;
        s[3] = s[2];
        s[2] = y;
        return y;
    }

    function flipSign() as Void {
        sign = -sign;
        Application.Storage.setValue("sign", sign);
    }

    function onData(data as Sensor.SensorData) as Void {
        var a = data.accelerometerData;
        if (a == null) {
            return;
        }
        var n = a.x.size();
        if (batchN == 0) {
            System.println("first batch n=" + n);
        }
        batchN = n;
        var len = dx.size();
        var block = (rate / SR_FS + 0.5).toNumber();
        for (var i = 0; i < n; i++) {
            var x = a.x[i].toFloat();
            var y = a.y[i].toFloat();
            var z = a.z[i].toFloat();
            var g = _g;
            if (g == null) {
                g = [x, y, z];
                _g = g;
            }
            g[0] += (x - g[0]) * _alpha;
            g[1] += (y - g[1]) * _alpha;
            g[2] += (z - g[2]) * _alpha;
            var fx = filt(x - g[0], _bqState[0]);
            var fy = filt(y - g[1], _bqState[1]);
            var fz = filt(z - g[2], _bqState[2]);
            dx[head] = fx;
            dy[head] = fy;
            dz[head] = fz;
            head = (head + 1) % len;
            count++;

            _blockSum += fx * axis[0] + fy * axis[1] + fz * axis[2];
            _blockN++;
            if (_blockN == block) {
                _sr[_srHead] = _blockSum / block;
                _srHead = (_srHead + 1) % SR_LEN;
                _srCount++;
                _blockSum = 0.0;
                _blockN = 0;
            }
        }
        updateAxis();
        updateStrokeRate();
        if (state == RUNNING) {
            recordSecond();
        }
        WatchUi.requestUpdate();
    }

    // Principal axis of the dynamic acceleration over the window (power
    // iteration on the 3x3 covariance), so the mount orientation doesn't matter.
    private function updateAxis() as Void {
        var len = count < dx.size() ? count : dx.size();
        var xx = 0.0, yy = 0.0, zz = 0.0, xy = 0.0, xz = 0.0, yz = 0.0;
        for (var i = 0; i < len; i++) {
            var x = dx[i];
            var y = dy[i];
            var z = dz[i];
            xx += x * x; yy += y * y; zz += z * z;
            xy += x * y; xz += x * z; yz += y * z;
        }
        var v = axis;
        for (var k = 0; k < 8; k++) {
            var wx = xx * v[0] + xy * v[1] + xz * v[2];
            var wy = xy * v[0] + yy * v[1] + yz * v[2];
            var wz = xz * v[0] + yz * v[1] + zz * v[2];
            var norm = Math.sqrt(wx * wx + wy * wy + wz * wz);
            if (norm < 1.0) {
                return; // no motion yet: keep the previous axis
            }
            v = [wx / norm, wy / norm, wz / norm];
        }
        // An eigenvector's sign is arbitrary; keep it continuous with the last one.
        if (v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2] < 0) {
            v = [-v[0], -v[1], -v[2]];
        }
        axis = v;
    }

    // Stroke period = strongest autocorrelation peak of the surge signal within
    // 15..50 spm. Sign-agnostic, so it works before the plot axis is flipped.
    private function updateStrokeRate() as Void {
        if (_srCount < SR_LEN) {
            strokeRate = null;
            return;
        }
        var mean = 0.0;
        for (var i = 0; i < SR_LEN; i++) {
            mean += _sr[i];
        }
        mean /= SR_LEN;
        // Unroll the ring oldest-first with the mean removed.
        var s = new Array<Float>[SR_LEN];
        var energy = 0.0;
        for (var i = 0; i < SR_LEN; i++) {
            var v = _sr[(_srHead + i) % SR_LEN] - mean;
            s[i] = v;
            energy += v * v;
        }
        if (Math.sqrt(energy / SR_LEN) < SR_MIN_RMS) {
            strokeRate = null;
            return;
        }
        var minLag = (60 * SR_FS / SR_MAX_SPM).toNumber();
        var maxLag = (60 * SR_FS / SR_MIN_SPM).toNumber();
        var r = new Array<Float>[maxLag + 2];
        var best = -1;
        for (var lag = minLag - 1; lag <= maxLag + 1; lag++) {
            var acc = 0.0;
            for (var i = 0; i + lag < SR_LEN; i++) {
                acc += s[i] * s[i + lag];
            }
            // Normalise per overlapping sample so long lags aren't penalised.
            r[lag] = acc / (SR_LEN - lag) / (energy / SR_LEN);
            if (lag >= minLag && lag <= maxLag && (best < 0 || r[lag] > r[best])) {
                best = lag;
            }
        }
        if (r[best] < SR_MIN_CORR) {
            strokeRate = null;
            return;
        }
        // Avoid octave errors: 2x the period correlates almost as well, so take
        // the shortest local peak within 80% of the best (halved the rate on
        // the 2026-11-02 test recording otherwise).
        var threshold = 0.8 * r[best];
        for (var lag = minLag; lag < best; lag++) {
            if (r[lag] >= threshold && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
                best = lag;
                break;
            }
        }
        // Parabolic interpolation around the peak for sub-sample period.
        var den = r[best - 1] - 2 * r[best] + r[best + 1];
        var period = best + (den != 0 ? 0.5 * (r[best - 1] - r[best + 1]) / den : 0.0);
        strokeRate = (60 * SR_FS / period).toFloat();
    }

    private function recordSecond() as Void {
        var sr = strokeRate;
        if (sr != null) {
            _strokes += sr / 60;
            _srSum += sr;
            _srSecs++;
        }
        (_srField as FitContributor.Field).setData(sr == null ? 0 : sr.toNumber());
        (_strokesField as FitContributor.Field).setData(_strokes.toNumber());
        if (_srSecs > 0) {
            (_avgSrField as FitContributor.Field).setData((_srSum / _srSecs).toNumber());
        }
    }

    function strokes() as Number {
        return _strokes.toNumber();
    }

    function startRecording() as Void {
        // Gyro is logged for offline analysis only (roll/pitch/yaw rate); the
        // live processing stays accel-only.
        var logger = new SensorLogging.SensorLogger({
            :accelerometer => {:enabled => true},
            :gyroscope => {:enabled => true}
        });
        var session = ActivityRecording.createSession({
            :name => "Row IMU",
            :sport => Activity.SPORT_ROWING,
            :sensorLogger => logger
        });
        // The firmware fills native cadence/strokes for SPORT_ROWING sessions
        // (seen in the 2026-11-02 21:36 test), so these stay separate IMU fields
        // for comparison rather than mirroring native ones.
        _srField = session.createField("imu_stroke_rate", 0, FitContributor.DATA_TYPE_UINT8,
            {:mesgType => FitContributor.MESG_TYPE_RECORD, :units => "spm"});
        _strokesField = session.createField("imu_total_strokes", 1, FitContributor.DATA_TYPE_UINT32,
            {:mesgType => FitContributor.MESG_TYPE_SESSION, :units => "strokes"});
        _avgSrField = session.createField("imu_avg_stroke_rate", 2, FitContributor.DATA_TYPE_UINT8,
            {:mesgType => FitContributor.MESG_TYPE_SESSION, :units => "spm"});
        _strokes = 0.0;
        _srSum = 0.0;
        _srSecs = 0;
        session.start();
        _logger = logger;
        _session = session;
        state = RUNNING;
    }

    function pause() as Void {
        (_session as ActivityRecording.Session).stop();
        state = PAUSED;
    }

    function resume() as Void {
        (_session as ActivityRecording.Session).start();
        state = RUNNING;
    }

    function lap() as Void {
        (_session as ActivityRecording.Session).addLap();
    }

    function save() as Void {
        (_session as ActivityRecording.Session).save();
        var stats = (_logger as SensorLogging.SensorLogger).getStats();
        if (stats != null) {
            System.println("logged " + stats.sampleCount + " samples over " + stats.samplePeriod + " s");
        }
        endSession();
    }

    function discard() as Void {
        (_session as ActivityRecording.Session).discard();
        endSession();
    }

    private function endSession() as Void {
        _session = null;
        _logger = null;
        _srField = null;
        _strokesField = null;
        _avgSrField = null;
        state = IDLE;
    }
}
