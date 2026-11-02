// Buttons follow the native activity: START start/pause, BACK lap, UP/DOWN
// pages, hold UP for settings.
import Toybox.Application;
import Toybox.Lang;
import Toybox.WatchUi;

class RowApp extends Application.AppBase {
    function initialize() {
        AppBase.initialize();
    }

    function getInitialView() {
        var rower = new Rower();
        var view = new RowView(rower);
        return [view, new RowDelegate(rower, view)];
    }
}

class RowDelegate extends WatchUi.BehaviorDelegate {
    private var _rower as Rower;
    private var _view as RowView;

    function initialize(rower as Rower, view as RowView) {
        BehaviorDelegate.initialize();
        _rower = rower;
        _view = view;
    }

    // START
    function onSelect() as Boolean {
        var s = _rower.state;
        if (s == IDLE) {
            _rower.startRecording();
        } else {
            if (s == RUNNING) {
                _rower.pause();
            }
            showPauseMenu(_rower);
        }
        WatchUi.requestUpdate();
        return true;
    }

    // BACK/LAP: lap while rowing, exit only when nothing is recording.
    function onBack() as Boolean {
        var s = _rower.state;
        if (s == RUNNING) {
            _rower.lap();
            return true;
        }
        if (s == PAUSED) {
            showPauseMenu(_rower);
            return true;
        }
        return false;
    }

    function onNextPage() as Boolean {
        _view.nextPage(1);
        return true;
    }

    function onPreviousPage() as Boolean {
        _view.nextPage(-1);
        return true;
    }

    // Hold UP
    function onMenu() as Boolean {
        var menu = new WatchUi.Menu2({:title => "Settings"});
        var hz = _rower.smoothHz;
        menu.addItem(new WatchUi.MenuItem("Smoothing", hz == 0 ? "Off (raw)" : hz + " Hz", :smoothing, null));
        menu.addItem(new WatchUi.MenuItem("Flip plot axis", null, :flip, null));
        WatchUi.pushView(menu, new SettingsDelegate(_rower), WatchUi.SLIDE_UP);
        return true;
    }
}

function showPauseMenu(rower as Rower) as Void {
    var menu = new WatchUi.Menu2({:title => "Paused"});
    menu.addItem(new WatchUi.MenuItem("Resume", null, :resume, null));
    menu.addItem(new WatchUi.MenuItem("Save", null, :save, null));
    menu.addItem(new WatchUi.MenuItem("Discard", null, :discard, null));
    WatchUi.pushView(menu, new PauseDelegate(rower), WatchUi.SLIDE_UP);
}

class PauseDelegate extends WatchUi.Menu2InputDelegate {
    private var _rower as Rower;

    function initialize(rower as Rower) {
        Menu2InputDelegate.initialize();
        _rower = rower;
    }

    function onSelect(item as WatchUi.MenuItem) as Void {
        var id = item.getId();
        if (id == :resume) {
            _rower.resume();
        } else if (id == :save) {
            _rower.save();
        } else {
            _rower.discard();
        }
        WatchUi.popView(WatchUi.SLIDE_DOWN);
    }
}

class SettingsDelegate extends WatchUi.Menu2InputDelegate {
    private var _rower as Rower;

    function initialize(rower as Rower) {
        Menu2InputDelegate.initialize();
        _rower = rower;
    }

    function onSelect(item as WatchUi.MenuItem) as Void {
        if (item.getId() == :flip) {
            _rower.flipSign();
            WatchUi.popView(WatchUi.SLIDE_DOWN);
            return;
        }
        var menu = new WatchUi.Menu2({:title => "Smoothing"});
        var opts = Rower.SMOOTHING_OPTIONS;
        for (var i = 0; i < opts.size(); i++) {
            var hz = opts[i] as Number;
            menu.addItem(new WatchUi.MenuItem(hz == 0 ? "Off (raw)" : hz + " Hz", null, hz, null));
        }
        WatchUi.switchToView(menu, new SmoothingDelegate(_rower), WatchUi.SLIDE_LEFT);
    }
}

class SmoothingDelegate extends WatchUi.Menu2InputDelegate {
    private var _rower as Rower;

    function initialize(rower as Rower) {
        Menu2InputDelegate.initialize();
        _rower = rower;
    }

    function onSelect(item as WatchUi.MenuItem) as Void {
        _rower.setSmoothing(item.getId() as Number);
        WatchUi.popView(WatchUi.SLIDE_DOWN);
    }
}
