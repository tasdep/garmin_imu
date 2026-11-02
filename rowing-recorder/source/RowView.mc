// Pages (UP/DOWN): rowing data, live boat-acceleration plot, clock.
import Toybox.Activity;
import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Position;
import Toybox.System;
import Toybox.WatchUi;

class RowView extends WatchUi.View {
    const PAGES = 3;
    // Shell acceleration spans roughly -0.6..+0.4 g, so +-600 mg fills the plot.
    private const RANGE_MG = 600.0;

    private var _rower as Rower;
    var page as Number = 0;

    function initialize(rower as Rower) {
        View.initialize();
        _rower = rower;
    }

    function onShow() as Void {
        _rower.start();
    }

    function onHide() as Void {
        _rower.stop();
    }

    function nextPage(step as Number) as Void {
        page = (page + step + PAGES) % PAGES;
        WatchUi.requestUpdate();
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.clear();
        var info = Activity.getActivityInfo();
        if (page == 0) {
            drawData(dc, info);
        } else if (page == 1) {
            drawPlot(dc, info);
        } else {
            drawClock(dc, info);
        }
    }

    private function drawData(dc as Graphics.Dc, info as Activity.Info?) as Void {
        var w = dc.getWidth();
        var h = dc.getHeight();
        var cx = w / 2;
        var label = Graphics.FONT_XTINY;
        var big = Graphics.FONT_NUMBER_MEDIUM;
        var mid = Graphics.FONT_NUMBER_MILD;
        var lc = Graphics.COLOR_LT_GRAY;
        var just = Graphics.TEXT_JUSTIFY_CENTER;

        drawStatus(dc, cx, 22);

        // Timer
        text(dc, cx, 70, label, lc, "TIMER");
        text(dc, cx, 92, big, Graphics.COLOR_WHITE, timerText(info));

        dc.setColor(Graphics.COLOR_DK_GRAY, Graphics.COLOR_TRANSPARENT);
        dc.drawLine(0, 185, w, 185);
        dc.drawLine(0, 300, w, 300);
        dc.drawLine(cx, 185, cx, 300);

        // Split /500 m | stroke rate
        var speed = info != null ? info.currentSpeed : null;
        text(dc, cx / 2 + 15, 195, label, lc, "/500m");
        text(dc, cx / 2 + 15, 220, mid, Graphics.COLOR_WHITE, splitText(speed));
        var sr = _rower.strokeRate;
        text(dc, cx + cx / 2 - 15, 195, label, lc, "SPM");
        text(dc, cx + cx / 2 - 15, 220, mid, Graphics.COLOR_WHITE, sr == null ? "--" : sr.format("%.0f"));

        // Distance | heart rate
        var dist = info != null ? info.elapsedDistance : null;
        text(dc, cx / 2 + 35, 310, label, lc, "DIST m");
        text(dc, cx / 2 + 35, 335, mid, Graphics.COLOR_WHITE, dist == null ? "0" : dist.format("%.0f"));
        var hr = info != null ? info.currentHeartRate : null;
        text(dc, cx + cx / 2 - 35, 310, label, lc, "HR");
        text(dc, cx + cx / 2 - 35, 335, mid, Graphics.COLOR_RED, hr == null ? "--" : hr.toString());

        // GPS quality, so you can wait for a fix before pressing START.
        var q = Position.getInfo().accuracy;
        var gpsColor = q >= Position.QUALITY_GOOD ? Graphics.COLOR_GREEN
            : (q >= Position.QUALITY_POOR ? Graphics.COLOR_YELLOW : Graphics.COLOR_RED);
        dc.setColor(gpsColor, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, h - 50, label, "GPS", just);
    }

    private function drawPlot(dc as Graphics.Dc, info as Activity.Info?) as Void {
        var w = dc.getWidth();
        var h = dc.getHeight();
        var cy = h / 2;
        var cx = w / 2;
        var x0 = 40;
        var plotW = w - 2 * x0;
        var ky = (h * 0.32) / RANGE_MG;

        // Grid: 0 and +-0.5 g
        dc.setColor(Graphics.COLOR_DK_GRAY, Graphics.COLOR_TRANSPARENT);
        dc.drawLine(x0, cy, x0 + plotW, cy);
        dc.drawLine(x0, cy - 500 * ky, x0 + plotW, cy - 500 * ky);
        dc.drawLine(x0, cy + 500 * ky, x0 + plotW, cy + 500 * ky);

        // Oldest to newest, left to right.
        var r = _rower;
        var len = r.dx.size();
        var n = r.count < len ? r.count : len;
        if (n > 1) {
            dc.setColor(Graphics.COLOR_GREEN, Graphics.COLOR_TRANSPARENT);
            dc.setPenWidth(2);
            var ax = r.axis[0] * r.sign;
            var ay = r.axis[1] * r.sign;
            var az = r.axis[2] * r.sign;
            var start = (r.head - n + len) % len;
            var px = 0;
            var py = 0;
            for (var i = 0; i < n; i++) {
                var j = (start + i) % len;
                var mg = r.dx[j] * ax + r.dy[j] * ay + r.dz[j] * az;
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

        drawStatus(dc, cx, 22);
        var sr = r.strokeRate;
        text(dc, cx, 62, Graphics.FONT_TINY, Graphics.COLOR_WHITE,
            timerText(info) + "   " + (sr == null ? "--" : sr.format("%.0f")) + " spm");
        var smooth = r.smoothHz == 0 ? "raw" : r.smoothHz + " Hz";
        var msg = r.rate == 0 && r.err.length() > 0 ? r.err : r.batchN + " Hz  " + smooth + "  grid 0.5 g";
        text(dc, cx, h - 80, Graphics.FONT_XTINY, Graphics.COLOR_LT_GRAY, msg);
    }

    private function drawClock(dc as Graphics.Dc, info as Activity.Info?) as Void {
        var cx = dc.getWidth() / 2;
        var cy = dc.getHeight() / 2;
        var t = System.getClockTime();
        var hour = t.hour;
        if (!System.getDeviceSettings().is24Hour) {
            hour = hour % 12 == 0 ? 12 : hour % 12;
        }
        drawStatus(dc, cx, 22);
        text(dc, cx, cy - 70, Graphics.FONT_NUMBER_THAI_HOT, Graphics.COLOR_WHITE,
            hour + ":" + t.min.format("%02d"));
        text(dc, cx, cy + 70, Graphics.FONT_MEDIUM, Graphics.COLOR_LT_GRAY, timerText(info));
    }

    private function drawStatus(dc as Graphics.Dc, cx as Number, y as Number) as Void {
        var s = _rower.state;
        if (s == RUNNING) {
            text(dc, cx, y, Graphics.FONT_XTINY, Graphics.COLOR_RED, "REC");
        } else if (s == PAUSED) {
            text(dc, cx, y, Graphics.FONT_XTINY, Graphics.COLOR_YELLOW, "PAUSED");
        } else {
            text(dc, cx, y, Graphics.FONT_XTINY, Graphics.COLOR_LT_GRAY, "START to row");
        }
    }

    private function text(dc as Graphics.Dc, x as Number, y as Number, font as Graphics.FontType,
            color as Graphics.ColorType, s as String) as Void {
        dc.setColor(color, Graphics.COLOR_TRANSPARENT);
        dc.drawText(x, y, font, s, Graphics.TEXT_JUSTIFY_CENTER);
    }

    private function timerText(info as Activity.Info?) as String {
        var ms = info != null ? info.timerTime : null;
        var s = ms == null ? 0 : ms / 1000;
        var hh = s / 3600;
        var mm = (s / 60) % 60;
        var ss = s % 60;
        return hh > 0 ? hh + ":" + mm.format("%02d") + ":" + ss.format("%02d")
            : mm + ":" + ss.format("%02d");
    }

    // Rowing split: time per 500 m at the current GPS speed.
    private function splitText(speed as Float?) as String {
        if (speed == null || speed < 0.5) {
            return "--:--";
        }
        var s = (500 / speed).toNumber();
        return (s / 60) + ":" + (s % 60).format("%02d");
    }
}
