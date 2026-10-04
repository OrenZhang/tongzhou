param([string]$PayloadBase64)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64)) | ConvertFrom-Json
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class TZDesktop {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc,IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h,uint command);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h,out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h,ref POINT p);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h,int a,out RECT r,int size);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from,uint to,bool attach);
  [DllImport("user32.dll")] public static extern bool PeekMessage(IntPtr message,IntPtr window,uint min,uint max,uint remove);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint n,INPUT[] inputs,int size);
  public static void Input(INPUT i) { if(SendInput(1,new INPUT[]{i},Marshal.SizeOf(typeof(INPUT)))!=1) throw new Exception("Windows blocked input. Elevated or protected windows are not supported."); }
  public static void Mouse(uint flags,uint data=0) { Input(new INPUT{type=0,u=new UNION{mouse=new MOUSEINPUT{flags=flags,data=data}}}); }
  public static void Key(ushort vk,bool up) { Input(new INPUT{type=1,u=new UNION{key=new KEYBDINPUT{vk=vk,flags=up?2u:0u}}}); }
  public static void Text(string text) { foreach(char c in text) { Input(new INPUT{type=1,u=new UNION{key=new KEYBDINPUT{scan=c,flags=4}}}); Input(new INPUT{type=1,u=new UNION{key=new KEYBDINPUT{scan=c,flags=6}}}); } }
  public static void Focus(IntPtr window) {
    if(GetForegroundWindow()==window) return;
    IntPtr message=Marshal.AllocHGlobal(128);try{PeekMessage(message,IntPtr.Zero,0,0,0);}finally{Marshal.FreeHGlobal(message);}
    uint pid; uint foreground=GetWindowThreadProcessId(GetForegroundWindow(),out pid); uint current=GetCurrentThreadId(); uint target=GetWindowThreadProcessId(window,out pid);
    bool attached=foreground!=current&&AttachThreadInput(current,foreground,true);
    bool targetAttached=target!=current&&target!=foreground&&AttachThreadInput(current,target,true);
    try { BringWindowToTop(window);SetForegroundWindow(window); } finally {if(targetAttached)AttachThreadInput(current,target,false);if(attached)AttachThreadInput(current,foreground,false);}
  }
  public static object[] Windows() {
    var list=new List<object>();
    EnumWindows((h,p)=> { if(!IsWindowVisible(h)||IsIconic(h)) return true; var s=new StringBuilder(512); GetWindowText(h,s,512); if(s.Length==0) return true;
      RECT r; if(DwmGetWindowAttribute(h,9,out r,Marshal.SizeOf(typeof(RECT)))!=0) GetWindowRect(h,out r);
      RECT c; GetClientRect(h,out c); var origin=new POINT(); ClientToScreen(h,ref origin);
      var cls=new StringBuilder(128);GetClassName(h,cls,128);
      uint pid; GetWindowThreadProcessId(h,out pid); if(r.right>r.left&&r.bottom>r.top) list.Add(new{id=h.ToInt64().ToString(),title=s.ToString(),pid=pid,ownerId=GetWindow(h,4).ToInt64().ToString(),className=cls.ToString(),enabled=IsWindowEnabled(h),bounds=new{x=r.left,y=r.top,width=r.right-r.left,height=r.bottom-r.top},clientBounds=new{x=origin.x,y=origin.y,width=c.right,height=c.bottom}}); return list.Count<200;
    },IntPtr.Zero); return list.ToArray();
  }
}
'@
[void][TZDesktop]::SetThreadDpiAwarenessContext([IntPtr](-4))
if ($payload.action -eq 'windows') { ConvertTo-Json -InputObject @([TZDesktop]::Windows()) -Depth 5 -Compress; exit 0 }
if ($payload.action -eq 'release') { foreach($key in @(16,17,18,91)){[TZDesktop]::Key($key,$true)};[TZDesktop]::Mouse(4);[TZDesktop]::Mouse(16);'{"ok":true}';exit 0 }
$handle=[IntPtr]([long]$payload.window.id)
[uint32]$actualPid=0
[void][TZDesktop]::GetWindowThreadProcessId($handle,[ref]$actualPid)
if ($actualPid -ne $payload.window.pid) { throw 'Window has changed' }
if ($payload.action -eq 'capture-dialog') {
  $class=New-Object Text.StringBuilder 128
  [void][TZDesktop]::GetClassName($handle,$class,128)
  if ($class.ToString() -ne '#32770' -or [TZDesktop]::GetWindow($handle,4) -eq [IntPtr]::Zero -or ![TZDesktop]::IsWindowVisible($handle)) { throw 'Not a visible owned dialog' }
  $rect=New-Object TZDesktop+RECT
  [void][TZDesktop]::GetWindowRect($handle,[ref]$rect)
  $width=$rect.right-$rect.left; $height=$rect.bottom-$rect.top
  if ($width -le 0 -or $height -le 0 -or $width -gt 4096 -or $height -gt 4096) { throw 'Invalid dialog bounds' }
  Add-Type -AssemblyName System.Drawing
  $bitmap=New-Object Drawing.Bitmap $width,$height
  $graphics=[Drawing.Graphics]::FromImage($bitmap)
  $stream=New-Object IO.MemoryStream
  try {
    $dc=$graphics.GetHdc()
    try { if (![TZDesktop]::PrintWindow($handle,$dc,2)) { throw 'Dialog capture refused' } }
    finally { $graphics.ReleaseHdc($dc) }
    $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
    @{data=[Convert]::ToBase64String($stream.ToArray());bounds=@{x=$rect.left;y=$rect.top;width=$width;height=$height}} | ConvertTo-Json -Depth 3 -Compress
  } finally { $stream.Dispose();$graphics.Dispose();$bitmap.Dispose() }
  exit 0
}
[TZDesktop]::Focus($handle)
Start-Sleep -Milliseconds 120
if ([TZDesktop]::GetForegroundWindow() -ne $handle) { throw 'Could not focus the selected window' }
switch ($payload.action) {
 'click' {
   [void][TZDesktop]::SetCursorPos($payload.x,$payload.y)
   $down=2; $up=4; if($payload.button -eq 'right'){$down=8;$up=16}
   for($i=0;$i -lt $payload.clickCount;$i++){[TZDesktop]::Mouse($down);[TZDesktop]::Mouse($up)}
 }
 'type' { [TZDesktop]::Text($payload.text) }
 'key' {
   $keys=@{CTRL=17;SHIFT=16;ALT=18;CMD=91;ENTER=13;TAB=9;ESC=27;BACKSPACE=8;DELETE=46;SPACE=32;LEFT=37;UP=38;RIGHT=39;DOWN=40;HOME=36;END=35;PAGEUP=33;PAGEDOWN=34}
   $pressed=New-Object 'System.Collections.Generic.List[System.UInt16]'
   try { foreach($part in $payload.key.Split('+')) { $vk=$keys[$part]; if(!$vk){ if($part -match '^F(\d+)$'){$vk=111+[int]$Matches[1]}else{$vk=[int][char]$part} }; [TZDesktop]::Key($vk,$false);$pressed.Add($vk) } }
   finally { for($i=$pressed.Count-1;$i -ge 0;$i--){[TZDesktop]::Key($pressed[$i],$true)} }
 }
 'scroll' { [void][TZDesktop]::SetCursorPos($payload.x,$payload.y); $delta=[int](-120*$payload.amount); [TZDesktop]::Mouse(2048,[BitConverter]::ToUInt32([BitConverter]::GetBytes($delta),0)) }
 'drag' { [void][TZDesktop]::SetCursorPos($payload.x,$payload.y);[TZDesktop]::Mouse(2);try {for($i=1;$i -le 12;$i++){[void][TZDesktop]::SetCursorPos(($payload.x+($payload.toX-$payload.x)*$i/12),($payload.y+($payload.toY-$payload.y)*$i/12));Start-Sleep -Milliseconds 15}}finally{[TZDesktop]::Mouse(4)} }
 default { throw 'Unknown action' }
}
'{"ok":true}'
