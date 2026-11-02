import Toybox.Application;
import Toybox.Lang;
import Toybox.WatchUi;

class RowApp extends Application.AppBase {
    function initialize() {
        AppBase.initialize();
    }

    function getInitialView() {
        var view = new RowView();
        return [view, new RowDelegate(view)];
    }
}

class RowDelegate extends WatchUi.BehaviorDelegate {
    private var _view as RowView;

    function initialize(view as RowView) {
        BehaviorDelegate.initialize();
        _view = view;
    }

    // START button
    function onSelect() as Boolean {
        _view.toggleRecording();
        return true;
    }

    // UP/DOWN flip the plotted axis so the drive phase reads positive.
    function onNextPage() as Boolean {
        _view.flipSign();
        return true;
    }

    function onPreviousPage() as Boolean {
        _view.flipSign();
        return true;
    }

    // Swallow BACK while recording so a stray press can't drop the session.
    function onBack() as Boolean {
        return _view.isRecording();
    }
}
