// Live boat-acceleration plot plus a FIT recording with raw accelerometer
// samples (SensorLogger) for offline analysis.
import Toybox.Activity;
import Toybox.ActivityRecording;
import Toybox.Application;
import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Math;
import Toybox.Position;
import Toybox.Sensor;
import Toybox.SensorLogging;
import Toybox.System;
import Toybox.WatchUi;

class RowView extends WatchUi.View {
    private const WINDOW_S = 6;
    // Gravity is tracked with a slow EMA; strokes are ~2 s, so 10 s keeps the
    // stroke signal out of the gravity estimate.
    private const GRAVITY_TAU_S = 10;
    // Shell acceleration spans roughly -0.6..+0.4 g, so +-600 mg fills the plot.
    private const RANGE_MG = 600.0;

    private var _rate as Number = 0;
    private var _batchN as Number = 0;
    private var _alpha as Float = 0.0;
    private var _g as Array<Float>? = null;
    private var _dx as Array<Float> = [];
    private var _dy as Array<Float> = [];
    private var _dz as Array<Float> = [];
    private var _head as Number = 0;
    private var _count as Number = 0;
    // Unit vector of the dominant motion direction (assumed surge).
    private var _axis as Array<Float> = [1.0, 0.0, 0.0];
    private var _sign as Number = 1;
    private var _err as String = "";

    private var _session as ActivityRecording.Session? = null;
    private var _logger as SensorLogging.SensorLogger? = null;

    function initialize() {
        View.initialize();
        var s = Application.Storage.getValue("sign");
        if (s instanceof Number) {
            _sign = s;
        }
    }

    function onShow() as Void {
        Position.enableLocationEvents(Position.LOCATION_CONTINUOUS, method(:onPosition));
        // The probe saw getMaxSampleRate() = 50 but a per-sensor max of 100; try 100 first.
        if (!startListener(100) && !startListener(50)) {
            System.println("listener failed: " + _err);
        }
    }

    function onHide() as Void {
        Sensor.unregisterSensorDataListener();
        Position.enableLocationEvents(Position.LOCATION_DISABLE, method(:onPosition));
    }

    function onPosition(info as Position.Info) as Void {
    }

    private function startListener(rate as Number) as Boolean {
        try {
            Sensor.registerSensorDataListener(method(:onData), {
                :period => 1,
                :accelerometer => {:enabled => true, :sampleRate => rate}
            });
        } catch (e) {
            _err = "" + e.getErrorMessage();
            return false;
        }
        _rate = rate;
        _alpha = 1.0 / (rate * GRAVITY_TAU_S);
        var len = rate * WINDOW_S;
        _dx = new Array<Float>[len];
        _dy = new Array<Float>[len];
        _dz = new Array<Float>[len];
        for (var i = 0; i < len; i++) {
            _dx[i] = 0.0;
            _dy[i] = 0.0;
            _dz[i] = 0.0;
        }
        _head = 0;
        _count = 0;
        System.println("listener requested " + rate + " Hz");
        return true;
    }

    function onData(data as Sensor.SensorData) as Void {
        var a = data.accelerometerData;
        if (a == null) {
            return;
        }
        var n = a.x.size();
        if (_batchN == 0) {
            System.println("first batch n=" + n);
        }
        _batchN = n;
        var len = _dx.size();
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
            _dx[_head] = x - g[0];
            _dy[_head] = y - g[1];
            _dz[_head] = z - g[2];
            _head = (_head + 1) % len;
            _count++;
        }
        updateAxis();
        WatchUi.requestUpdate();
    }

    // Principal axis of the dynamic acceleration over the window (power
    // iteration on the 3x3 covariance), so the mount orientation doesn't matter.
    private function updateAxis() as Void {
        var len = _count < _dx.size() ? _count : _dx.size();
        var xx = 0.0, yy = 0.0, zz = 0.0, xy = 0.0, xz = 0.0, yz = 0.0;
        for (var i = 0; i < len; i++) {
            var x = _dx[i];
            var y = _dy[i];
            var z = _dz[i];
            xx += x * x; yy += y * y; zz += z * z;
            xy += x * y; xz += x * z; yz += y * z;
        }
        var v = _axis;
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
        if (v[0] * _axis[0] + v[1] * _axis[1] + v[2] * _axis[2] < 0) {
            v = [-v[0], -v[1], -v[2]];
        }
        _axis = v;
    }

    function flipSign() as Void {
        _sign = -_sign;
        Application.Storage.setValue("sign", _sign);
        WatchUi.requestUpdate();
    }

    function isRecording() as Boolean {
        return _session != null;
    }

    function toggleRecording() as Void {
        var session = _session;
        if (session == null) {
            _logger = new SensorLogging.SensorLogger({:accelerometer => {:enabled => true}});
            session = ActivityRecording.createSession({
                :name => "Row IMU",
                :sport => Activity.SPORT_ROWING,
                :sensorLogger => _logger
            });
            session.start();
            _session = session;
        } else {
            session.stop();
            session.save();
            var stats = (_logger as SensorLogging.SensorLogger).getStats();
            if (stats != null) {
                System.println("logged " + stats.sampleCount + " samples over " + stats.samplePeriod + " s");
            }
            _session = null;
            _logger = null;
        }
        WatchUi.requestUpdate();
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        var w = dc.getWidth();
        var h = dc.getHeight();
        var cy = h / 2;
        var x0 = 40;
        var plotW = w - 2 * x0;
        var ky = (h * 0.32) / RANGE_MG;

        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_BLACK);
        dc.clear();

        // Grid: 0 and +-0.5 g
        dc.setColor(Graphics.COLOR_DK_GRAY, Graphics.COLOR_TRANSPARENT);
        dc.drawLine(x0, cy, x0 + plotW, cy);
        dc.drawLine(x0, cy - 500 * ky, x0 + plotW, cy - 500 * ky);
        dc.drawLine(x0, cy + 500 * ky, x0 + plotW, cy + 500 * ky);

        // Oldest to newest, left to right.
        var len = _dx.size();
        var n = _count < len ? _count : len;
        if (n > 1) {
            dc.setColor(Graphics.COLOR_GREEN, Graphics.COLOR_TRANSPARENT);
            dc.setPenWidth(2);
            var ax = _axis[0] * _sign;
            var ay = _axis[1] * _sign;
            var az = _axis[2] * _sign;
            var start = (_head - n + len) % len;
            var px = 0;
            var py = 0;
            for (var i = 0; i < n; i++) {
                var j = (start + i) % len;
                var mg = _dx[j] * ax + _dy[j] * ay + _dz[j] * az;
                if (mg > RANGE_MG) { mg = RANGE_MG; }
                if (mg < -RANGE_MG) { mg = -RANGE_MG; }
                var qx = x0 + (i * plotW) / (len - 1);
                var qy = (cy - mg * ky).toNumber();
                if (i > 0) {
                    dc.drawLine(px, py, qx, qy);
                }
                px = qx;
                py = qy;
            }
            dc.setPenWidth(1);
        }

        var font = Graphics.FONT_XTINY;
        var cx = w / 2;
        if (_session != null) {
            var ms = Activity.getActivityInfo().timerTime;
            var s = ms == null ? 0 : ms / 1000;
            dc.setColor(Graphics.COLOR_RED, Graphics.COLOR_TRANSPARENT);
            dc.drawText(cx, 58, Graphics.FONT_TINY, "REC " + (s / 60) + ":" + (s % 60).format("%02d"), Graphics.TEXT_JUSTIFY_CENTER);
        } else {
            dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
            dc.drawText(cx, 58, Graphics.FONT_TINY, "START to record", Graphics.TEXT_JUSTIFY_CENTER);
        }
        dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, h - 95, font, _batchN + " Hz  +-0.5 g grid", Graphics.TEXT_JUSTIFY_CENTER);
        dc.drawText(cx, h - 65, font, _err.length() > 0 && _rate == 0 ? _err : "UP/DN flip", Graphics.TEXT_JUSTIFY_CENTER);
    }
}
