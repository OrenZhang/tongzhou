ObjC.import('Cocoa');
ObjC.import('CoreGraphics');
function run(argv) {
  var p=JSON.parse(argv[0]);
  if(p.action==='release') { [54,55,56,58,59].forEach(function(k){var e=$.CGEventCreateKeyboardEvent(null,k,false);$.CGEventPost(0,e);});var position=$.CGEventGetLocation($.CGEventCreate(null));[2,4].forEach(function(t){$.CGEventPost(0,$.CGEventCreateMouseEvent(null,t,position,t===4?1:0));});return '{"ok":true}'; }
  if(p.action==='windows') {
    var windows=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1,0)));
    return JSON.stringify(windows.filter(function(w){return w.kCGWindowLayer===0&&w.kCGWindowName&&w.kCGWindowBounds.Width>0;}).slice(0,200).map(function(w){return {id:String(w.kCGWindowNumber),pid:w.kCGWindowOwnerPID,title:w.kCGWindowName,bounds:{x:w.kCGWindowBounds.X,y:w.kCGWindowBounds.Y,width:w.kCGWindowBounds.Width,height:w.kCGWindowBounds.Height}};}));
  }
  var app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(p.window.pid);
  if(!app) throw Error('Window application has closed');
  app.activateWithOptions(2);
  var se=Application('System Events');
  var process=se.processes.whose({unixId:p.window.pid})[0];
  var target=process.windows.whose({name:p.window.title});
  if(target.length!==1) throw Error('Window changed or title is ambiguous; capture again');
  target[0].actions.byName('AXRaise').perform();
  delay(0.12);
  if(!process.frontmost()) throw Error('Could not focus the selected window');
  function post(type,x,y,button){var event=$.CGEventCreateMouseEvent(null,type,$.CGPointMake(x,y),button||0);$.CGEventPost(0,event);}
  if(p.action==='click') {
    var down=p.button==='right'?3:1,up=p.button==='right'?4:2,button=p.button==='right'?1:0;
    for(var i=0;i<p.clickCount;i++){var e=$.CGEventCreateMouseEvent(null,down,$.CGPointMake(p.x,p.y),button);$.CGEventSetIntegerValueField(e,1,i+1);$.CGEventPost(0,e);post(up,p.x,p.y,button);}
  } else if(p.action==='type') {
    // System Events handles Unicode text without changing the user's clipboard.
    se.keystroke(p.text);
  } else if(p.action==='key') {
    var pieces=p.key.split('+'),key=pieces.pop();
    var modifiers=pieces.map(function(k){return {CTRL:'control down',CMD:'command down',ALT:'option down',SHIFT:'shift down'}[k];});
    var codes={ENTER:36,TAB:48,ESC:53,BACKSPACE:51,DELETE:117,SPACE:49,LEFT:123,RIGHT:124,UP:126,DOWN:125,HOME:115,END:119,PAGEUP:116,PAGEDOWN:121,F1:122,F2:120,F3:99,F4:118,F5:96,F6:97,F7:98,F8:100,F9:101,F10:109,F11:103,F12:111};
    if(Object.prototype.hasOwnProperty.call(codes,key))se.keyCode(codes[key],{using:modifiers});else se.keystroke(key.toLowerCase(),{using:modifiers});
  } else if(p.action==='scroll') {
    post(5,p.x,p.y);var scroll=$.CGEventCreateScrollWheelEvent(null,1,1,-p.amount);$.CGEventPost(0,scroll);
  } else if(p.action==='drag') {
    post(1,p.x,p.y);try{for(var j=1;j<=12;j++){post(6,p.x+(p.toX-p.x)*j/12,p.y+(p.toY-p.y)*j/12);delay(0.015);}}finally{post(2,p.toX,p.toY);}
  } else throw Error('Unknown action');
  return JSON.stringify({ok:true});
}
