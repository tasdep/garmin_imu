// Probe: reports what the FR965 actually exposes for high-rate IMU data,
// so the recorder app can be designed around real limits, not doc guesses.
import Toybox.Application;
import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Sensor;
import Toybox.WatchUi;

class ProbeApp extends Application.AppBase {
    function initialize() {
        AppBase.initialize();
    }

    function getInitialView() {
        return [new ProbeView()];
    }
}

class ProbeView extends WatchUi.View {
    private var _maxRate as String = "?";
    private var _maxAccel as String = "?";
    private var _maxGyro as String = "?";
    private var _mode as String = "none";
    private var _err as String = "";
    private var _batches as Number = 0;
    private var _accel as String = "-";
    private var _gyro as String = "-";

    function initialize() {
        View.initialize();
    }

    function onShow() as Void {
        _maxRate = "" + Sensor.getMaxSampleRate();
        if (Sensor has :getMaxSampleRateForSensorType) {
            _maxAccel = "" + Sensor.getMaxSampleRateForSensorType(:accelerometer);
            _maxGyro = "" + Sensor.getMaxSampleRateForSensorType(:gyroscope);
        }
        var rate = Sensor.getMaxSampleRate();
        var accel = {:enabled => true, :sampleRate => rate, :includeTimestamps => true};
        // Try accel+gyro first; a forum report says the FR965 may not list a gyro.
        try {
            Sensor.registerSensorDataListener(method(:onData), {
                :period => 1,
                :accelerometer => accel,
                :gyroscope => {:enabled => true, :sampleRate => rate, :includeTimestamps => true}
            });
            _mode = "accel+gyro";
        } catch (e) {
            _err = "" + e.getErrorMessage();
            try {
                Sensor.registerSensorDataListener(method(:onData), {:period => 1, :accelerometer => accel});
                _mode = "accel only";
            } catch (e2) {
                _err += " / " + e2.getErrorMessage();
            }
        }
    }

    function onHide() as Void {
        Sensor.unregisterSensorDataListener();
    }

    function onData(data as Sensor.SensorData) as Void {
        _batches++;
        var a = data.accelerometerData;
        if (a != null) {
            _accel = describe(a.x.size(), a.timestamp) + " " + a.x[0] + "," + a.y[0] + "," + a.z[0] + "mg";
        }
        var g = data.gyroscopeData;
        if (g != null) {
            _gyro = describe(g.x.size(), g.timestamp);
        }
        WatchUi.requestUpdate();
    }

    // Samples per batch plus the rate implied by the per-sample timestamps.
    private function describe(n as Number, ts as Array<Number>?) as String {
        var s = "n=" + n;
        if (ts != null && n > 1 && ts[n - 1] != ts[0]) {
            s += " " + ((n - 1) * 1000.0 / (ts[n - 1] - ts[0])).format("%.1f") + "Hz";
        }
        return s;
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.clear();
        var lines = [
            "max " + _maxRate + " a" + _maxAccel + " g" + _maxGyro,
            "logger " + ((Toybox has :SensorLogging) ? "yes" : "no"),
            _mode + " #" + _batches,
            "A " + _accel,
            "G " + _gyro,
            _err
        ];
        var y = 80;
        for (var i = 0; i < lines.size(); i++) {
            dc.drawText(dc.getWidth() / 2, y, Graphics.FONT_XTINY, lines[i], Graphics.TEXT_JUSTIFY_CENTER);
            y += 48;
        }
    }
}
