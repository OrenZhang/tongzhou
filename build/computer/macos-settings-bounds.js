ObjC.import('Cocoa');
ObjC.import('CoreGraphics');
function run() {
  var windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0)));
  for (var i = 0; i < windows.length; i++) {
    var window = windows[i];
    if (window.kCGWindowLayer !== 0 || window.kCGWindowBounds.Width < 200) continue;
    var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(window.kCGWindowOwnerPID);
    if (app && ObjC.unwrap(app.bundleIdentifier) === 'com.apple.systempreferences') {
      var bounds = window.kCGWindowBounds;
      return JSON.stringify({ x: bounds.X, y: bounds.Y, width: bounds.Width, height: bounds.Height });
    }
  }
  return 'null';
}
