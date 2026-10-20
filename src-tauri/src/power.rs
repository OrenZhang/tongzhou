use serde_json::{json, Value};
use std::{sync::mpsc, time::Duration};
use tokio::sync::oneshot;

type Reply = Result<Value, String>;
struct Request {
    action: String,
    id: u64,
    reply: oneshot::Sender<Reply>,
}
/// A dedicated thread owns the assertion: Windows execution-state requests are thread-affine.
pub struct Power(mpsc::Sender<Request>);
impl Power {
    pub fn new() -> Self {
        let (send, receive) = mpsc::channel::<Request>();
        std::thread::spawn(move || {
            let mut guard: Option<(u64, keepawake::KeepAwake)> = None;
            let mut sequence = 0;
            loop {
                // Fail closed on unplug or an unreadable power source, even if Node is busy.
                if battery().unwrap_or(true) {
                    guard = None;
                }
                match receive.recv_timeout(Duration::from_secs(1)) {
                    Ok(request) => {
                        let result = (|| match request.action.as_str() {
                            "powerStart" => {
                                if battery()? {
                                    return Err("请先连接电源，再启用保持唤醒".into());
                                }
                                if guard.is_none() {
                                    let awake = keepawake::Builder::default()
                                        .idle(true)
                                        .display(false)
                                        .sleep(false)
                                        .reason("CoSail AC-only background tasks")
                                        .create()
                                        .map_err(|e| e.to_string())?;
                                    sequence += 1;
                                    guard = Some((sequence, awake));
                                }
                                Ok(json!(guard.as_ref().unwrap().0))
                            }
                            "powerStop" => {
                                if guard.as_ref().is_some_and(|g| g.0 == request.id) {
                                    guard = None;
                                }
                                Ok(Value::Null)
                            }
                            "powerStatus" => {
                                Ok(json!({"onBatteryPower":battery()?,"active":guard.is_some()}))
                            }
                            _ => Err("Unknown power operation".into()),
                        })();
                        let _ = request.reply.send(result);
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });
        Self(send)
    }
    pub async fn call(&self, action: &str, id: u64) -> Reply {
        let (reply, receive) = oneshot::channel();
        self.0
            .send(Request {
                action: action.into(),
                id,
                reply,
            })
            .map_err(|_| "Power driver stopped")?;
        receive.await.map_err(|_| "Power driver disconnected")?
    }
}
#[cfg(target_os = "macos")]
fn battery() -> Result<bool, String> {
    use std::ffi::{c_char, c_void};
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPSCopyPowerSourcesInfo() -> *const c_void;
        fn IOPSGetProvidingPowerSourceType(info: *const c_void) -> *const c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(value: *const c_void);
        fn CFStringGetCString(
            value: *const c_void,
            buffer: *mut c_char,
            size: isize,
            encoding: u32,
        ) -> bool;
    }
    unsafe {
        let info = IOPSCopyPowerSourcesInfo();
        if info.is_null() {
            return Err("无法读取电源状态".into());
        }
        let kind = IOPSGetProvidingPowerSourceType(info);
        let mut bytes = [0i8; 64];
        let ok = !kind.is_null() && CFStringGetCString(kind, bytes.as_mut_ptr(), 64, 0x08000100);
        CFRelease(info);
        if !ok {
            return Err("无法读取电源状态".into());
        }
        Ok(std::ffi::CStr::from_ptr(bytes.as_ptr()).to_bytes() != b"AC Power")
    }
}
#[cfg(windows)]
fn battery() -> Result<bool, String> {
    #[repr(C)]
    struct Status {
        ac: u8,
        flags: u8,
        percent: u8,
        saver: u8,
        life: u32,
        full: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemPowerStatus(status: *mut Status) -> i32;
    }
    let mut status = Status {
        ac: 255,
        flags: 0,
        percent: 0,
        saver: 0,
        life: 0,
        full: 0,
    };
    if unsafe { GetSystemPowerStatus(&mut status) } == 0 || status.ac == 255 {
        return Err("无法读取电源状态".into());
    }
    Ok(status.ac != 1)
}
#[cfg(not(any(target_os = "macos", windows)))]
fn battery() -> Result<bool, String> {
    Ok(true)
}
