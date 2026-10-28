//! Read aloud with Kokoro-82M on the Mac (sherpa-onnx). Same behaviour as KokoroSpeech.kt on Android:
//! the model is downloaded once into the app's local data folder (not the journal, so never synced or
//! backed up), speech is made sentence by sentence while the previous sentence plays, and the page
//! falls back to the system voice whenever `speak` returns false.

use std::collections::VecDeque;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use sherpa_onnx::{GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig, OfflineTtsModelConfig};
use tauri::{AppHandle, Emitter, Manager};

/// Model id and approximate download size in MB.
const MODELS: &[(&str, u32)] = &[("kokoro-int8-en-v0_19", 98), ("kokoro-int8-multi-lang-v1_1", 140)];
const URL_BASE: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/";

static RUN: AtomicU64 = AtomicU64::new(0);
static DOWNLOADING: Mutex<Option<String>> = Mutex::new(None);
static ENGINE: Mutex<Option<(String, Arc<OfflineTts>)>> = Mutex::new(None);

fn root(app: &AppHandle) -> PathBuf {
    app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("voices")
}

fn settings_path(app: &AppHandle) -> PathBuf {
    root(app).join("settings.json")
}

fn settings(app: &AppHandle) -> Value {
    fs::read_to_string(settings_path(app)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| json!({}))
}

fn save_setting(app: &AppHandle, key: &str, value: Value) {
    let mut s = settings(app);
    s[key] = value;
    let _ = fs::create_dir_all(root(app));
    let _ = fs::write(settings_path(app), s.to_string());
}

fn model(app: &AppHandle) -> String {
    settings(app)["model"].as_str().map(String::from).unwrap_or_else(|| MODELS[0].0.to_string())
}

fn voice(app: &AppHandle) -> i32 {
    settings(app)["voice"].as_i64().unwrap_or(0) as i32
}

fn installed(app: &AppHandle, id: &str) -> bool {
    root(app).join(id).join(".done").exists()
}

#[tauri::command]
pub fn voice_info(app: AppHandle) -> Value {
    let current = model(&app);
    let speakers = match &*ENGINE.lock().unwrap() {
        Some((id, tts)) if *id == current => tts.num_speakers(),
        _ => 0,
    };
    json!({
        "models": MODELS.iter().map(|(id, mb)| json!({ "id": id, "sizeMb": mb, "installed": installed(&app, id) })).collect::<Vec<_>>(),
        "model": current,
        "voice": voice(&app),
        "downloading": *DOWNLOADING.lock().unwrap(),
        "speakers": speakers,
    })
}

#[tauri::command]
pub fn set_voice_model(app: AppHandle, model: String) {
    save_setting(&app, "model", json!(model));
}

#[tauri::command]
pub fn set_voice(app: AppHandle, voice: i32) {
    save_setting(&app, "voice", json!(voice));
}

#[tauri::command]
pub fn remove_voice(app: AppHandle, model: String) {
    let mut engine = ENGINE.lock().unwrap();
    if engine.as_ref().is_some_and(|(id, _)| *id == model) {
        *engine = None;
    }
    let _ = fs::remove_dir_all(root(&app).join(&model));
}

fn progress(app: &AppHandle, model: &str, state: &str, received: u64, total: u64, message: &str) {
    let _ = app.emit("voice-progress", json!({ "model": model, "state": state, "received": received, "total": total, "message": message }));
}

/// Counts bytes as they arrive so the page can show download progress.
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
        if self.received - self.last > 1_000_000 {
            self.last = self.received;
            progress(&self.app, &self.model, "downloading", self.received, self.total, "");
        }
        Ok(n)
    }
}

fn fetch(app: &AppHandle, id: &str) -> Result<u64, String> {
    let part = root(app).join(".part");
    let _ = fs::remove_dir_all(&part);
    fs::create_dir_all(&part).map_err(|e| e.to_string())?;
    let response = ureq::get(&format!("{URL_BASE}{id}.tar.bz2")).call().map_err(|e| e.to_string())?;
    let total = response.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut counting = Counting { inner: response.into_body().into_reader(), received: 0, last: 0, total, app: app.clone(), model: id.to_string() };
    tar::Archive::new(bzip2::read::BzDecoder::new(std::io::BufReader::with_capacity(1 << 16, &mut counting)))
        .unpack(&part)
        .map_err(|e| e.to_string())?;
    let unpacked = part.join(id);
    if !unpacked.join("tokens.txt").exists() {
        return Err("The download didn't contain the voice files".into());
    }
    fs::write(unpacked.join(".done"), "ok").map_err(|e| e.to_string())?;
    let target = root(app).join(id);
    let _ = fs::remove_dir_all(&target);
    fs::rename(&unpacked, &target).map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(&part);
    Ok(counting.received)
}

#[tauri::command]
pub fn download_voice(app: AppHandle, model: String) {
    if !MODELS.iter().any(|(id, _)| *id == model) {
        return;
    }
    {
        let mut downloading = DOWNLOADING.lock().unwrap();
        if downloading.is_some() {
            return;
        }
        *downloading = Some(model.clone());
    }
    std::thread::spawn(move || {
        let result = fetch(&app, &model);
        *DOWNLOADING.lock().unwrap() = None;
        match result {
            Ok(received) => progress(&app, &model, "done", received, received, ""),
            Err(e) => {
                let _ = fs::remove_dir_all(root(&app).join(".part"));
                progress(&app, &model, "error", 0, 0, &e);
            }
        }
    });
}

/// The engine for the chosen model, loaded once (None if it isn't downloaded or won't load).
fn engine(app: &AppHandle) -> Option<Arc<OfflineTts>> {
    let id = model(app);
    let mut slot = ENGINE.lock().unwrap();
    if let Some((loaded, tts)) = &*slot {
        if *loaded == id {
            return Some(tts.clone());
        }
    }
    *slot = None;
    if !installed(app, &id) {
        return None;
    }
    let tts = Arc::new(load(&root(app).join(&id))?);
    *slot = Some((id, tts.clone()));
    Some(tts)
}

/// Loads a downloaded Kokoro model folder.
fn load(dir: &std::path::Path) -> Option<OfflineTts> {
    let path = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());
    let lexicon = ["lexicon-us-en.txt", "lexicon-zh.txt"]
        .iter()
        .map(|f| dir.join(f))
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(",");
    let config = OfflineTtsConfig {
        model: OfflineTtsModelConfig {
            kokoro: OfflineTtsKokoroModelConfig {
                model: if dir.join("model.int8.onnx").exists() { path("model.int8.onnx") } else { path("model.onnx") },
                voices: path("voices.bin"),
                tokens: path("tokens.txt"),
                data_dir: path("espeak-ng-data"),
                lexicon: (!lexicon.is_empty()).then_some(lexicon),
                ..Default::default()
            },
            num_threads: 2,
            provider: Some("cpu".into()),
            ..Default::default()
        },
        ..Default::default()
    };
    OfflineTts::create(&config)
}

/// Splits text into sentences, keeping where each starts (in UTF-16 units, like the page's string indexes).
fn sentences(text: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut start = 0usize;
    let mut at = 0usize;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        // A sentence starts at its first non-space character.
        if current.trim().is_empty() {
            start = at;
        }
        current.push(c);
        at += c.len_utf16();
        let ends = c == '\n' || (matches!(c, '.' | '!' | '?') && chars.peek().is_none_or(|n| n.is_whitespace()));
        if ends {
            if !current.trim().is_empty() {
                out.push((start, current.trim().to_string()));
            }
            current.clear();
        }
    }
    if !current.trim().is_empty() {
        out.push((start, current.trim().to_string()));
    }
    out
}

fn speech_event(app: &AppHandle, event: &str, id: &str, index: usize) {
    let _ = app.emit("speech", json!({ "event": event, "id": id, "index": index }));
}

/// Speaks with Kokoro. Returns false when it isn't downloaded, so the page uses the system voice.
#[tauri::command]
pub fn speak(app: AppHandle, text: String, rate: f32, id: String) -> bool {
    let current = model(&app);
    if !installed(&app, &current) || DOWNLOADING.lock().unwrap().as_deref() == Some(current.as_str()) {
        return false;
    }
    let mine = RUN.fetch_add(1, Ordering::SeqCst) + 1;
    let live = move || RUN.load(Ordering::SeqCst) == mine;
    std::thread::spawn(move || {
        let Some(tts) = engine(&app) else {
            // Failed to load: the page falls back to the system voice.
            return speech_event(&app, "error", &id, 0);
        };
        let sid = voice(&app).clamp(0, (tts.num_speakers() - 1).max(0));
        let sample_rate = tts.sample_rate() as u32;
        let (tx, rx) = mpsc::sync_channel::<(usize, Vec<f32>)>(2);
        let generator = tts.clone();
        std::thread::spawn(move || {
            for (offset, sentence) in sentences(&text) {
                if !live() {
                    break;
                }
                let config = GenerationConfig { speed: rate, sid, ..Default::default() };
                let Some(audio) = generator.generate_with_config(&sentence, &config, None::<fn(&[f32], f32) -> bool>) else {
                    continue;
                };
                if tx.send((offset, audio.samples().to_vec())).is_err() {
                    break;
                }
            }
        });
        let Ok(stream) = rodio::OutputStreamBuilder::open_default_stream() else {
            return speech_event(&app, "error", &id, 0);
        };
        let sink = rodio::Sink::connect_new(stream.mixer());
        let mut offsets = VecDeque::new();
        let mut appended = 0usize;
        let mut announced = usize::MAX;
        let mut finished = false;
        loop {
            if !live() {
                sink.stop();
                return;
            }
            loop {
                match rx.try_recv() {
                    Ok((offset, samples)) => {
                        sink.append(rodio::buffer::SamplesBuffer::new(1, sample_rate, samples));
                        offsets.push_back(offset);
                        appended += 1;
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        finished = true;
                        break;
                    }
                }
            }
            // The sink holds what hasn't finished playing; the first of those is playing now.
            let playing = appended - sink.len();
            if playing < appended && playing != announced {
                announced = playing;
                speech_event(&app, "range", &id, offsets[playing]);
            }
            if finished && sink.empty() {
                return speech_event(&app, "done", &id, 0);
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    });
    true
}

#[tauri::command]
pub fn stop_speech() {
    RUN.fetch_add(1, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::{load, sentences};
    use sherpa_onnx::GenerationConfig;

    /// Needs a downloaded model: KOKORO_DIR=/path/to/kokoro-int8-en-v0_19 cargo test -- --ignored
    #[test]
    #[ignore]
    fn speaks_with_a_downloaded_model() {
        let dir = std::env::var("KOKORO_DIR").expect("KOKORO_DIR");
        let tts = load(std::path::Path::new(&dir)).expect("model loads");
        let config = GenerationConfig { sid: 3, ..Default::default() };
        let audio = tts.generate_with_config("Hello from the journal.", &config, None::<fn(&[f32], f32) -> bool>).expect("audio");
        assert_eq!(tts.num_speakers(), 11);
        assert!(audio.samples().len() > tts.sample_rate() as usize / 2);
    }

    #[test]
    fn splits_sentences_with_offsets() {
        let s = sentences("Hi there. Version 1.5 is out!\nNext line");
        assert_eq!(s.iter().map(|(o, t)| (*o, t.as_str())).collect::<Vec<_>>(), vec![(0, "Hi there."), (10, "Version 1.5 is out!"), (30, "Next line")]);
    }
}
