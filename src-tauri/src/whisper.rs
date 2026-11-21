//! Whisper speech recognition on the Mac and the phone (sherpa-onnx, already here for Kokoro): the voice graph's
//! live transcription without sending audio anywhere. The model is downloaded once into the app's
//! local data folder (never synced or backed up), loaded only while a recording runs, and released
//! when it stops, so it costs nothing the rest of the time.

use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use sherpa_onnx::{OfflineModelConfig, OfflineRecognizer, OfflineRecognizerConfig, OfflineWhisperModelConfig};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager};

/// Model size names and approximate download size in MB (the archive holds both precisions; only
/// the int8 files are kept).
const MODELS: &[(&str, u32)] = &[("tiny", 116), ("base", 208), ("small", 640)];
const URL_BASE: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-";
const RATE: i32 = 16_000;

static DOWNLOADING: Mutex<Option<String>> = Mutex::new(None);
/// Why the last download failed (shown in Settings, and readable when the phone "can't get it").
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);
/// The loaded model: (model id, language, recognizer).
static ENGINE: Mutex<Option<(String, String, Arc<OfflineRecognizer>)>> = Mutex::new(None);

fn root(app: &AppHandle) -> PathBuf {
    app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("whisper")
}

/// Models copied onto the phone from the Mac (adb push to the app's own folder on the shared
/// storage, which needs no permission): moved into the app on first look. For a phone whose
/// connection to GitHub keeps dropping mid-download (21 Nov).
fn take_side_loaded(app: &AppHandle) {
    if !cfg!(target_os = "android") {
        return;
    }
    let shared = PathBuf::from(format!("/storage/emulated/0/Android/data/{}/files/whisper", app.config().identifier));
    for (id, _) in MODELS {
        let from = shared.join(id);
        let need = [format!("{id}-encoder.int8.onnx"), format!("{id}-decoder.int8.onnx"), format!("{id}-tokens.txt")];
        if installed(app, id) || need.iter().any(|f| !from.join(f).exists()) {
            continue;
        }
        let to = root(app).join(id);
        let copied = fs::create_dir_all(&to).is_ok() && need.iter().all(|f| fs::copy(from.join(f), to.join(f)).is_ok());
        if copied && fs::write(to.join(".done"), "ok").is_ok() {
            let _ = fs::write(root(app).join("model"), id);
            let _ = fs::remove_dir_all(&from);
        } else {
            let _ = fs::remove_dir_all(&to);
        }
    }
}

fn installed(app: &AppHandle, id: &str) -> bool {
    root(app).join(id).join(".done").exists()
}

/// The model to use: the chosen one if it's downloaded, else the biggest downloaded one.
fn chosen(app: &AppHandle) -> Option<String> {
    let saved = fs::read_to_string(root(app).join("model")).ok().map(|s| s.trim().to_string());
    if let Some(id) = saved.filter(|id| installed(app, id)) {
        return Some(id);
    }
    MODELS.iter().rev().map(|(id, _)| id.to_string()).find(|id| installed(app, id))
}

#[tauri::command]
pub fn whisper_info(app: AppHandle) -> Value {
    take_side_loaded(&app);
    json!({
        "models": MODELS.iter().map(|(id, mb)| json!({ "id": id, "sizeMb": mb, "installed": installed(&app, id) })).collect::<Vec<_>>(),
        "model": chosen(&app),
        "downloading": *DOWNLOADING.lock().unwrap_or_else(|e| e.into_inner()),
        "error": *LAST_ERROR.lock().unwrap_or_else(|e| e.into_inner()),
    })
}

fn progress(app: &AppHandle, model: &str, state: &str, received: u64, total: u64, message: &str) {
    let _ = app.emit("whisper-progress", json!({ "model": model, "state": state, "received": received, "total": total, "message": message }));
}

struct Counting<R> {
    inner: R,
    received: u64,
    last: u64,
    total: u64,
    app: AppHandle,
    model: String,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.received += n as u64;
        if self.received - self.last > 2_000_000 {
            self.last = self.received;
            progress(&self.app, &self.model, "downloading", self.received, self.total, "");
        }
        Ok(n)
    }
}

fn fetch(app: &AppHandle, id: &str) -> Result<u64, String> {
    let part = root(app).join(".part");
    // A half-downloaded archive is kept (resumed below); anything half-unpacked is not.
    let _ = fs::remove_dir_all(part.join(format!("sherpa-onnx-whisper-{id}")));
    fs::create_dir_all(&part).map_err(|e| e.to_string())?;
    // The archive goes to a file first, picking up where it stopped if the connection drops (the
    // phone moving between Wi-Fi and mobile data broke a straight-through unpack, 21 Nov).
    let archive = part.join("model.tar.bz2");
    let url = format!("{URL_BASE}{id}.tar.bz2");
    let mut total = 0u64;
    let mut tries = 0;
    loop {
        let have = fs::metadata(&archive).map(|m| m.len()).unwrap_or(0);
        if total > 0 && have >= total {
            break;
        }
        let mut req = ureq::get(&url);
        if have > 0 {
            req = req.header("Range", &format!("bytes={have}-"));
        }
        let result = req.call().map_err(|e| e.to_string()).and_then(|response| {
            let resumed = response.status().as_u16() == 206;
            let len: u64 = response.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(0);
            let start = if resumed { have } else { 0 };
            total = start + len;
            let mut file = fs::OpenOptions::new().create(true).write(true).append(resumed).truncate(!resumed).open(&archive).map_err(|e| e.to_string())?;
            let mut counting = Counting { inner: response.into_body().into_reader(), received: start, last: start, total, app: app.clone(), model: id.to_string() };
            std::io::copy(&mut counting, &mut file).map_err(|e| e.to_string())?;
            Ok(len == 0)
        });
        match result {
            // No length given: whatever came is all of it.
            Ok(true) => break,
            Ok(false) => {}
            Err(e) => {
                tries += 1;
                if tries >= 6 {
                    return Err(format!("download kept stopping: {e}"));
                }
                std::thread::sleep(std::time::Duration::from_secs(2 * tries));
            }
        }
    }
    let received = fs::metadata(&archive).map(|m| m.len()).unwrap_or(0);
    let file = fs::File::open(&archive).map_err(|e| e.to_string())?;
    tar::Archive::new(bzip2::read::BzDecoder::new(std::io::BufReader::with_capacity(1 << 16, file)))
        .unpack(&part)
        .map_err(|e| {
            // A bad archive is fetched again next time.
            let _ = fs::remove_file(&archive);
            format!("couldn't unpack the download: {e}")
        })?;
    let _ = fs::remove_file(&archive);
    let unpacked = part.join(format!("sherpa-onnx-whisper-{id}"));
    let need = [format!("{id}-encoder.int8.onnx"), format!("{id}-decoder.int8.onnx"), format!("{id}-tokens.txt")];
    if need.iter().any(|f| !unpacked.join(f).exists()) {
        return Err("The download didn't contain the Whisper files".into());
    }
    // Keep only what's used (the full-precision copies and test clips are as big again).
    for entry in fs::read_dir(&unpacked).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !need.contains(&name) {
            let p = entry.path();
            let _ = if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
        }
    }
    fs::write(unpacked.join(".done"), "ok").map_err(|e| e.to_string())?;
    let target = root(app).join(id);
    let _ = fs::remove_dir_all(&target);
    fs::rename(&unpacked, &target).map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(&part);
    let _ = fs::write(root(app).join("model"), id);
    Ok(received)
}

#[tauri::command]
pub fn download_whisper(app: AppHandle, model: String) {
    if !MODELS.iter().any(|(id, _)| *id == model) {
        return;
    }
    {
        let mut downloading = DOWNLOADING.lock().unwrap_or_else(|e| e.into_inner());
        if downloading.is_some() {
            return;
        }
        *downloading = Some(model.clone());
    }
    *LAST_ERROR.lock().unwrap_or_else(|e| e.into_inner()) = None;
    std::thread::spawn(move || {
        let result = fetch(&app, &model);
        *DOWNLOADING.lock().unwrap_or_else(|e| e.into_inner()) = None;
        match result {
            Ok(received) => progress(&app, &model, "done", received, received, ""),
            Err(e) => {
                *LAST_ERROR.lock().unwrap_or_else(|p| p.into_inner()) = Some(e.clone());
                // The archive stays for the next try to resume; a half-unpacked folder doesn't.
                let _ = fs::remove_dir_all(root(&app).join(".part").join(format!("sherpa-onnx-whisper-{model}")));
                progress(&app, &model, "error", 0, 0, &e);
            }
        }
    });
}

#[tauri::command]
pub fn remove_whisper(app: AppHandle, model: String) {
    let mut engine = ENGINE.lock().unwrap_or_else(|e| e.into_inner());
    if engine.as_ref().is_some_and(|(id, _, _)| *id == model) {
        *engine = None;
    }
    if MODELS.iter().any(|(id, _)| *id == model) {
        let _ = fs::remove_dir_all(root(&app).join(&model));
    }
}

/// The recognizer, loaded once per recording. `lang`: "en", "gu"… or "" to let Whisper guess
/// (short live sentences are often guessed wrong, so live agents say which).
fn engine(app: &AppHandle, lang: &str) -> Result<Arc<OfflineRecognizer>, String> {
    let id = chosen(app).ok_or("No Whisper model downloaded")?;
    let mut slot = ENGINE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((loaded, l, r)) = &*slot {
        if *loaded == id && l == lang {
            return Ok(r.clone());
        }
    }
    let dir = root(app).join(&id);
    let path = |name: String| Some(dir.join(name).to_string_lossy().into_owned());
    let mut config = OfflineRecognizerConfig::default();
    config.model_config = OfflineModelConfig {
        whisper: OfflineWhisperModelConfig {
            encoder: path(format!("{id}-encoder.int8.onnx")),
            decoder: path(format!("{id}-decoder.int8.onnx")),
            // Empty: Whisper finds the language itself (English, Gujarati, Hindi…).
            language: Some(lang.to_string()),
            task: Some("transcribe".into()),
            tail_paddings: -1,
            ..Default::default()
        },
        tokens: path(format!("{id}-tokens.txt")),
        // Two threads on the Mac: quick enough for live pieces, gentle on the battery. The phone's
        // cores are slower: four, so a sentence is back in about a second.
        num_threads: if cfg!(target_os = "android") { 4 } else { 2 },
        provider: Some("cpu".into()),
        ..Default::default()
    };
    let r = Arc::new(OfflineRecognizer::create(&config).ok_or("Whisper didn't load")?);
    *slot = Some((id, lang.to_string(), r.clone()));
    Ok(r)
}

/// Transcribes one piece: 16 kHz mono 16-bit little-endian PCM as the raw request body.
#[tauri::command]
pub async fn whisper_transcribe(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let lang: String = request
        .headers()
        .get("x-lang")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_lowercase())
        .filter(|v| v.len() <= 3 && v.chars().all(|c| c.is_ascii_lowercase()))
        .unwrap_or_default();
    let bytes = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        _ => return Err("Send the audio as raw bytes".into()),
    };
    if bytes.len() > RATE as usize * 2 * 30 {
        return Err("Pieces must be under 30 seconds".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let recognizer = engine(&app, &lang)?;
        let samples: Vec<f32> = bytes.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect();
        let stream = recognizer.create_stream();
        stream.accept_waveform(RATE, &samples);
        recognizer.decode(&stream);
        Ok(stream.get_result().map(|r| r.text.trim().to_string()).unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Frees the model's memory (after a recording).
#[tauri::command]
pub fn whisper_release() {
    *ENGINE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}
