use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, watch};

type Reply = Result<Value, String>;
struct Inner {
    input: Mutex<ChildStdin>,
    child: Mutex<Child>,
    requests: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    sequence: AtomicU64,
    ready: watch::Sender<Option<Result<(), String>>>,
    pub closing: AtomicBool,
    exit_ready: AtomicBool,
}
#[derive(Clone)]
pub struct Core(Arc<Inner>);
impl Core {
    pub fn spawn(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let runtime = app.path().resource_dir()?.join("runtime");
        let entry = runtime.join("dist-electron/tauri-host.cjs");
        let node = runtime.join(if cfg!(windows) {
            "node_modules/node/bin/node.exe"
        } else {
            "node_modules/node/bin/node"
        });
        let profile = std::env::var_os("TONGZHOU_TAURI_DATA_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or(app.path().app_data_dir()?);
        std::fs::create_dir_all(&profile)?;
        let mut command = Command::new(node);
        command
            .arg(entry)
            .arg(&profile)
            .arg(app.package_info().version.to_string())
            .current_dir(&runtime)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        // The host never inherits an Electron development mode or Node injection hook.
        command
            .env_remove("ELECTRON_RUN_AS_NODE")
            .env_remove("NODE_OPTIONS");
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn()?;
        let input = child.stdin.take().ok_or("Missing core stdin")?;
        let output = child.stdout.take().ok_or("Missing core stdout")?;
        let (ready, _) = watch::channel(None);
        let core = Self(Arc::new(Inner {
            input: Mutex::new(input),
            child: Mutex::new(child),
            requests: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(0),
            ready,
            closing: AtomicBool::new(false),
            exit_ready: AtomicBool::new(false),
        }));
        let reader = core.clone();
        let handle = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                match message["type"].as_str() {
                    Some("ready") => {
                        reader.0.ready.send_replace(Some(Ok(())));
                    }
                    Some("fatal") => {
                        reader.fail(
                            message["error"]
                                .as_str()
                                .unwrap_or("Execution core failed")
                                .to_owned(),
                        );
                    }
                    Some("event") => {
                        if message["event"]["type"] == "appearance" {
                            if let Some(language) = message["event"]["value"]["language"].as_str() {
                                crate::desktop::language(&handle, language);
                            }
                        }

                        let _ = handle.emit_to("main", "tongzhou:event", &message["event"]);
                    }
                    Some("result") => {
                        if let Some(id) = message["id"].as_u64() {
                            if let Some(reply) = reader.0.requests.lock().unwrap().remove(&id) {
                                let value = if message["ok"] == true {
                                    Ok(message["value"].clone())
                                } else {
                                    Err(message["error"]
                                        .as_str()
                                        .unwrap_or("Core request failed")
                                        .to_owned())
                                };
                                let _ = reply.send(value);
                            }
                        }
                    }
                    Some("host") => {
                        let (writer, app) = (reader.clone(), handle.clone());
                        tauri::async_runtime::spawn(async move {
                            let result = crate::host::execute(&app, &message).await;
                            let response = match result {
                                Ok(value) => {
                                    json!({"type":"host_result", "id":message["id"], "ok":true, "value":value})
                                }
                                Err(error) => {
                                    json!({"type":"host_result", "id":message["id"], "ok":false, "error":error})
                                }
                            };
                            let _ = writer.write(&response);
                        });
                    }
                    _ => {}
                }
            }
            reader.fail("Execution core disconnected".into());
        });
        Ok(core)
    }
    fn fail(&self, error: String) {
        self.0.ready.send_replace(Some(Err(error.clone())));
        for (_, pending) in self.0.requests.lock().unwrap().drain() {
            let _ = pending.send(Err(error.clone()));
        }
    }
    fn write(&self, value: &Value) -> Result<(), String> {
        let mut input = self.0.input.lock().map_err(|_| "Core input unavailable")?;
        serde_json::to_writer(&mut *input, value).map_err(|e| e.to_string())?;
        input
            .write_all(b"\n")
            .and_then(|_| input.flush())
            .map_err(|e| e.to_string())
    }
    pub async fn ready(&self) -> Result<(), String> {
        let mut receiver = self.0.ready.subscribe();
        loop {
            let state = receiver.borrow().clone();
            if let Some(result) = state {
                return result;
            }
            receiver
                .changed()
                .await
                .map_err(|_| "Core startup cancelled")?;
        }
    }
    pub async fn request(&self, mut message: Value) -> Reply {
        let id = self.0.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        message["id"] = json!(id);
        let (sender, receiver) = oneshot::channel();
        self.0.requests.lock().unwrap().insert(id, sender);
        if let Err(error) = self.write(&message) {
            self.0.requests.lock().unwrap().remove(&id);
            return Err(error);
        }
        receiver.await.map_err(|_| "Core request cancelled")?
    }
    pub fn host_event(&self, name: &str, payload: Value) {
        let _ = self.write(&json!({"type":"host_event","name":name,"payload":payload}));
    }
    pub fn exit_ready(&self) -> bool {
        self.0.exit_ready.load(Ordering::SeqCst)
    }
    pub fn allow_exit(&self) {
        self.0.exit_ready.store(true, Ordering::SeqCst);
    }
    pub fn begin_close(&self) -> bool {
        !self.0.closing.swap(true, Ordering::SeqCst)
    }
    pub fn is_closing(&self) -> bool {
        self.0.closing.load(Ordering::SeqCst)
    }
    pub async fn shutdown(&self) {
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(12),
            self.request(json!({"type":"shutdown"})),
        )
        .await;
        self.terminate();
    }
    pub fn terminate(&self) {
        if let Ok(mut child) = self.0.child.lock() {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            if !matches!(child.try_wait(), Ok(Some(_))) {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }
}
