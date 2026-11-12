use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use lofty::prelude::*;
use lofty::probe::Probe;
use tauri::webview::Color;
use tauri::{Emitter, Listener, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindowBuilder};
use walkdir::WalkDir;

mod alarm;
mod task_scheduler;
use audio::AudioEngine;
mod audio;
mod spatial_audio;
use spatial_audio::{DspMode, RecitationStatus, SpatialAudioEngine};
mod frame;
mod geometry;
mod hittest;
mod island_diagnostics;
mod tray;

#[derive(Serialize, Clone)]
pub struct Track { pub path: String, pub file_name: String, pub title: String, pub artist: String, pub duration: Option<u64>, pub cover: Option<String> }

fn supported(p: &Path) -> bool { matches!(p.extension().and_then(|x| x.to_str()).map(|x| x.to_ascii_lowercase()).as_deref(), Some("mp3"|"m4a"|"mp4"|"flac"|"ogg"|"oga"|"opus"|"wav"|"webm")) }

#[derive(Clone)]
struct AudioServer { root: Arc<RwLock<Option<PathBuf>>>, token: String, port: u16 }

fn mime_for(path: &Path) -> &'static str {
  match path.extension().and_then(|x| x.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
    "mp3" => "audio/mpeg", "wav" => "audio/wav", "ogg"|"oga"|"opus" => "audio/ogg", "webm" => "audio/webm",
    "flac" => "audio/flac", "m4a"|"mp4" => "audio/mp4", _ => "application/octet-stream"
  }
}

fn new_token() -> String {
  let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
  format!("{:032x}", nanos ^ (std::process::id() as u128))
}

fn start_audio_server() -> Result<AudioServer, String> {
  let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("تعذر تشغيل خادم الصوت المحلي: {e}"))?;
  let port = listener.local_addr().map_err(|e| e.to_string())?.port();
  listener.set_nonblocking(true).map_err(|e| e.to_string())?;
  let root = Arc::new(RwLock::new(None));
  let token = new_token();
  let server = AudioServer { root: root.clone(), token: token.clone(), port };
  thread::Builder::new().name("tarteel-audio-server".into()).spawn(move || loop {
    match listener.accept() {
      Ok((stream, _)) => { let root = root.clone(); let token = token.clone(); thread::spawn(move || handle_request(stream, root, token)); }
      Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(10)),
      Err(_) => break,
    }
  }).map_err(|e| e.to_string())?;
  Ok(server)
}

fn response(stream: &mut TcpStream, status: &str, headers: &[(&str, String)]) -> std::io::Result<()> {
  write!(stream, "HTTP/1.1 {status}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n")?;
  for (key, value) in headers { write!(stream, "{key}: {value}\r\n")?; }
  write!(stream, "\r\n")
}

fn handle_request(mut stream: TcpStream, root: Arc<RwLock<Option<PathBuf>>>, token: String) {
  let mut request = [0u8; 8192];
  let Ok(size) = stream.read(&mut request) else { return };
  let text = String::from_utf8_lossy(&request[..size]);
  let mut lines = text.lines();
  let Some(first) = lines.next() else { return };
  let mut parts = first.split_whitespace();
  let method = parts.next().unwrap_or("");
  let target = parts.next().unwrap_or("");
  let range_header = lines.find_map(|line| {
    let (key, value) = line.split_once(':')?;
    (key.eq_ignore_ascii_case("range")).then(|| value.trim().to_string())
  });
  if method != "GET" && method != "HEAD" { let _ = response(&mut stream, "405 Method Not Allowed", &[]); return; }
  let prefix = format!("/audio/{token}/");
  if !target.starts_with(&prefix) { let _ = response(&mut stream, "404 Not Found", &[]); return; }
  let encoded = target[prefix.len()..].split('?').next().unwrap_or("");
  let Ok(bytes) = URL_SAFE_NO_PAD.decode(encoded) else { let _ = response(&mut stream, "400 Bad Request", &[]); return; };
  let Ok(path_string) = String::from_utf8(bytes) else { let _ = response(&mut stream, "400 Bad Request", &[]); return; };
  let candidate = PathBuf::from(path_string);
  let Ok(file_path) = candidate.canonicalize() else { let _ = response(&mut stream, "404 Not Found", &[]); return; };
  let allowed = root.read().ok().and_then(|guard| guard.clone()).is_some_and(|base| file_path.starts_with(base) && file_path.is_file());
  if !allowed || !supported(&file_path) { let _ = response(&mut stream, "403 Forbidden", &[]); return; }
  let Ok(mut file) = File::open(&file_path) else { let _ = response(&mut stream, "404 Not Found", &[]); return; };
  let Ok(total) = file.metadata().map(|m| m.len()) else { let _ = response(&mut stream, "404 Not Found", &[]); return; };
  if total == 0 { let _ = response(&mut stream, "416 Range Not Satisfiable", &[("Content-Range", "bytes */0".into())]); return; }
  let (start, end, status) = match range_header.as_deref().and_then(parse_range) {
    Some((start, end)) if start < total => (start, end.min(total - 1), "206 Partial Content"),
    Some(_) => { let _ = response(&mut stream, "416 Range Not Satisfiable", &[("Content-Range", format!("bytes */{total}"))]); return; }
    None => (0, total - 1, "200 OK"),
  };
  let length = end - start + 1;
  let mut headers = vec![("Content-Type", mime_for(&file_path).into()), ("Content-Length", length.to_string()), ("Accept-Ranges", "bytes".into())];
  if status.starts_with("206") { headers.push(("Content-Range", format!("bytes {start}-{end}/{total}"))); }
  if response(&mut stream, status, &headers).is_err() || method == "HEAD" { return; }
  if file.seek(SeekFrom::Start(start)).is_err() { return; }
  let mut remaining = length;
  let mut buffer = [0u8; 64 * 1024];
  while remaining > 0 {
    let want = remaining.min(buffer.len() as u64) as usize;
    let Ok(read) = file.read(&mut buffer[..want]) else { break; };
    if read == 0 || stream.write_all(&buffer[..read]).is_err() { break; }
    remaining -= read as u64;
  }
}

fn parse_range(value: &str) -> Option<(u64, u64)> {
  let value = value.strip_prefix("bytes=")?.split(',').next()?.trim();
  let (start, end) = value.split_once('-')?;
  if start.is_empty() { return None; }
  Some((start.parse().ok()?, end.parse().ok().unwrap_or(u64::MAX)))
}

/* ================================================================== *
 * منظومة التنبيهات — الأوامر وحلقة الإطلاق
 * ================================================================== */

/// حالة التنبيهات المشتركة بين الواجهة وحلقة الإطلاق.
struct AlarmHandle { state: alarm::SharedAlarm, path: PathBuf }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct AdhanPreferences {
  enabled: bool,
  volume: u32,
  muted: bool,
}

impl Default for AdhanPreferences {
  fn default() -> Self { Self { enabled: true, volume: 80, muted: false } }
}

#[derive(Clone)]
struct AdhanPreferencesHandle { state: Arc<Mutex<AdhanPreferences>>, path: PathBuf }

fn read_adhan_preferences(path: &Path) -> AdhanPreferences {
  fs::read(path)
    .ok()
    .and_then(|bytes| serde_json::from_slice::<AdhanPreferences>(&bytes).ok())
    .unwrap_or_default()
}

fn write_adhan_preferences(path: &Path, preferences: &AdhanPreferences) -> Result<(), String> {
  let parent = path.parent().ok_or_else(|| "مسار تفضيلات الأذان غير صالح".to_string())?;
  fs::create_dir_all(parent).map_err(|e| format!("تعذر إنشاء مجلد تفضيلات الأذان: {e}"))?;
  let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
  let bytes = serde_json::to_vec(preferences).map_err(|e| format!("تعذر ترميز تفضيلات الأذان: {e}"))?;
  fs::write(&temporary, bytes).map_err(|e| format!("تعذر كتابة تفضيلات الأذان: {e}"))?;
  if path.exists() { fs::remove_file(path).map_err(|e| format!("تعذر استبدال تفضيلات الأذان: {e}"))?; }
  fs::rename(&temporary, path).map_err(|e| format!("تعذر تثبيت تفضيلات الأذان: {e}"))
}

fn update_adhan_preferences(
  handle: &AdhanPreferencesHandle,
  update: impl FnOnce(&mut AdhanPreferences),
) -> Result<AdhanPreferences, String> {
  let mut stored = handle.state.lock().map_err(|_| "قفل تفضيلات الأذان تالف".to_string())?;
  let mut next = stored.clone();
  update(&mut next);
  next.volume = next.volume.min(100);
  write_adhan_preferences(&handle.path, &next)?;
  *stored = next.clone();
  Ok(next)
}

/// طلبات مجدول Windows والأحداث الملتقطة التي تنتظر جاهزية الجزيرة.
#[derive(Default)]
struct PendingAlarms {
  task_names: Mutex<Vec<String>>,
  events: Mutex<Vec<alarm::AlarmEvent>>,
  main_ready: AtomicBool,
  island_ready: AtomicBool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum IslandPositionMode { Auto, Manual }

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct IslandPlacement {
  mode: IslandPositionMode,
  offset_x: f64,
  offset_y: f64,
}

impl Default for IslandPositionMode {
  fn default() -> Self { Self::Auto }
}

impl Default for IslandPlacement {
  fn default() -> Self { Self { mode: IslandPositionMode::Auto, offset_x: 0.0, offset_y: 0.0 } }
}

const ISLAND_PLACEMENT_FILE: &str = "island-position.json";
const MAX_STORED_ISLAND_OFFSET: f64 = 10_000.0;

struct IslandPlacementHandle {
  placement: Mutex<IslandPlacement>,
  path: PathBuf,
  animation_revision: Arc<AtomicU64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum IslandAppearance { Glass, Black }

impl Default for IslandAppearance {
  fn default() -> Self { Self::Glass }
}

const ISLAND_APPEARANCE_FILE: &str = "island-appearance.json";

struct IslandAppearanceHandle {
  appearance: Mutex<IslandAppearance>,
  path: PathBuf,
}

fn normalize_island_placement(mut placement: IslandPlacement) -> IslandPlacement {
  placement.offset_x = if placement.offset_x.is_finite() { placement.offset_x.clamp(-MAX_STORED_ISLAND_OFFSET, MAX_STORED_ISLAND_OFFSET) } else { 0.0 };
  placement.offset_y = if placement.offset_y.is_finite() { placement.offset_y.clamp(-MAX_STORED_ISLAND_OFFSET, MAX_STORED_ISLAND_OFFSET) } else { 0.0 };
  placement
}

fn read_island_placement(path: &Path) -> IslandPlacement {
  fs::read(path).ok()
    .and_then(|bytes| serde_json::from_slice::<IslandPlacement>(&bytes).ok())
    .map(normalize_island_placement)
    .unwrap_or_default()
}

fn write_island_placement(path: &Path, placement: IslandPlacement) -> Result<(), String> {
  let placement = normalize_island_placement(placement);
  let parent = path.parent().ok_or_else(|| "مسار موضع الجزيرة لا يحتوي مجلدًا أبًا".to_string())?;
  fs::create_dir_all(parent).map_err(|e| format!("تعذر إنشاء مجلد حفظ موضع الجزيرة: {e}"))?;
  let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
  let bytes = serde_json::to_vec(&placement).map_err(|e| format!("تعذر ترميز موضع الجزيرة: {e}"))?;
  fs::write(&temporary, bytes).map_err(|e| format!("تعذر كتابة موضع الجزيرة المؤقت: {e}"))?;
  if path.exists() { fs::remove_file(path).map_err(|e| format!("تعذر استبدال موضع الجزيرة المحفوظ: {e}"))?; }
  fs::rename(&temporary, path).map_err(|e| format!("تعذر تثبيت موضع الجزيرة المحفوظ: {e}"))
}

fn read_island_appearance(path: &Path) -> IslandAppearance {
  fs::read(path).ok()
    .and_then(|bytes| serde_json::from_slice::<IslandAppearance>(&bytes).ok())
    .unwrap_or_default()
}

fn write_island_appearance(path: &Path, appearance: IslandAppearance) -> Result<(), String> {
  let parent = path.parent().ok_or_else(|| "مسار مظهر الجزيرة لا يحتوي مجلدًا أبًا".to_string())?;
  fs::create_dir_all(parent).map_err(|e| format!("تعذر إنشاء مجلد حفظ مظهر الجزيرة: {e}"))?;
  let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
  let bytes = serde_json::to_vec(&appearance).map_err(|e| format!("تعذر ترميز مظهر الجزيرة: {e}"))?;
  fs::write(&temporary, bytes).map_err(|e| format!("تعذر كتابة مظهر الجزيرة المؤقت: {e}"))?;
  if path.exists() { fs::remove_file(path).map_err(|e| format!("تعذر استبدال مظهر الجزيرة المحفوظ: {e}"))?; }
  fs::rename(&temporary, path).map_err(|e| format!("تعذر تثبيت مظهر الجزيرة المحفوظ: {e}"))
}

fn scheduled_task_argument(args: &[String]) -> Option<String> {
  args.windows(2)
    .find(|pair| pair[0] == "--adhan-task")
    .map(|pair| pair[1].clone())
}

fn queue_scheduled_task(app: &tauri::AppHandle, task_name: String) {
  let Some(pending) = app.try_state::<PendingAlarms>() else { return };
  match pending.task_names.lock() {
    Ok(mut queue) => queue.push(task_name),
    Err(_) => { eprintln!("Tarteel scheduled-alarm queue is unavailable"); return; }
  }
  process_pending_scheduled_tasks(app);
}

fn start_scheduled_adhan_audio(app: &tauri::AppHandle, event: &alarm::AlarmEvent) {
  let Some(preferences) = app.try_state::<AdhanPreferencesHandle>() else {
    eprintln!("Tarteel adhan preferences are unavailable for a scheduled prayer");
    return;
  };
  let Ok(preferences) = preferences.state.lock().map(|state| state.clone()) else {
    eprintln!("Tarteel adhan preferences lock is unavailable for a scheduled prayer");
    return;
  };
  if !preferences.enabled || preferences.muted { return; }
  let Some(engine) = app.try_state::<AudioEngine>() else {
    eprintln!("Tarteel audio engine is unavailable for a scheduled prayer");
    return;
  };
  let path = match resolve_adhan_file(app) {
    Ok(path) => path,
    Err(error) => { eprintln!("Tarteel scheduled adhan file is unavailable: {error}"); return; }
  };
  if let Err(error) = engine.play(&event.id, &path, now_ms(), true) {
    eprintln!("Tarteel native scheduled adhan playback failed: {error}");
  }
}

fn process_pending_scheduled_tasks(app: &tauri::AppHandle) {
  let Some(pending) = app.try_state::<PendingAlarms>() else { return };
  let tasks = match pending.task_names.lock() {
    Ok(mut queue) => std::mem::take(&mut *queue),
    Err(_) => { eprintln!("Tarteel scheduled-alarm queue is unavailable"); return; }
  };
  if tasks.is_empty() {
    flush_pending_alarms(app);
    return;
  }
  let Some(handle) = app.try_state::<AlarmHandle>() else {
    if let Ok(mut queue) = pending.task_names.lock() { queue.extend(tasks); }
    return;
  };

  for task_name in tasks {
    let event = {
      let Ok(mut state) = handle.state.lock() else {
        eprintln!("Tarteel alarm state lock is unavailable");
        continue;
      };
      let event = alarm::claim_scheduled_task(&mut state, &task_name, now_ms());
      if let Err(error) = alarm::write_state(&handle.path, &state) {
        eprintln!("Tarteel scheduled-alarm persistence failed: {error}");
      }
      event
    };
    if let Some(event) = event {
      /* يبدأ الصوت الآن؛ لا ننتظر جاهزية WebView كي لا يضيع عند فشل تحميل الواجهة. */
      start_scheduled_adhan_audio(app, &event);
      if let Ok(mut events) = pending.events.lock() { events.push(event); }
    }
  }
  flush_pending_alarms(app);
}

fn flush_pending_alarms(app: &tauri::AppHandle) {
  let Some(pending) = app.try_state::<PendingAlarms>() else { return };
  if !pending.main_ready.load(Ordering::SeqCst) || !pending.island_ready.load(Ordering::SeqCst) { return; }
  let events = match pending.events.lock() {
    Ok(mut events) => std::mem::take(&mut *events),
    Err(_) => { eprintln!("Tarteel pending-alarm event queue is unavailable"); return; }
  };
  for event in events { deliver_alarm(app, event); }
}

/// حدث حان وقته، يُرسل إلى الواجهة لتعرضه في الجزيرة.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AdhanPayload {
  id: String,
  key: String,
  name: String,
  at: i64,
}

/// ملخص الحالة، تستعلمه الواجهة بعد الإقلاع.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlarmStatus {
  scheduled: usize,
  fired: usize,
  next_at: Option<i64>,
  next_name: Option<String>,
}

/// يستبدل جدول المواعيد كله. هذا هو المصدر الوحيد للحقيقة.
#[tauri::command]
fn set_alarm_schedule(handle: State<AlarmHandle>, events: Vec<alarm::AlarmEvent>) -> Result<usize, String> {
  let mut state = handle.state.lock().map_err(|_| "تعذر قفل حالة التنبيهات".to_string())?;
  alarm::apply_events(&mut state, events)?;
  let count = state.events.len();
  alarm::write_state(&handle.path, &state)?;
  Ok(count)
}

#[tauri::command]
fn set_sleep_deadline(handle: State<AlarmHandle>, deadline_ms: Option<i64>) -> Result<(), String> {
  let mut state = handle.state.lock().map_err(|_| "تعذر قفل حالة مؤقت النوم".to_string())?;
  state.sleep_deadline_ms = deadline_ms.filter(|deadline| *deadline > 0);
  alarm::write_state(&handle.path, &state)
}

#[tauri::command]
fn alarm_status(handle: State<AlarmHandle>) -> Result<AlarmStatus, String> {
  let state = handle.state.lock().map_err(|_| "تعذر قفل حالة التنبيهات".to_string())?;
  let now = now_ms();
  let next = alarm::next_event_after(&state, now);
  Ok(AlarmStatus {
    scheduled: state.events.len(),
    fired: state.fired_ids.len(),
    next_at: next.map(|event| event.at),
    next_name: next.map(|event| event.name.clone()),
  })
}

/// يزامن مهام ويندوز المجدولة مع المواعيد المقبولة.
/// يُستدعى من الواجهة بعد كل تحديث للجدول، فتبقى المهام مطابقة دائمًا.
#[tauri::command]
fn sync_windows_tasks(handle: State<AlarmHandle>, ahead_ms: Option<i64>) -> Result<usize, String> {
  let state = handle.state.lock().map_err(|_| "تعذر قفل حالة التنبيهات".to_string())?;
  let horizon = now_ms() + ahead_ms.unwrap_or(7 * 24 * 3600 * 1000);
  let specs: Vec<task_scheduler::TaskSpec> = state.events.iter()
    .filter(|event| matches!(event.key.as_str(), "fajr" | "dhuhr" | "asr" | "maghrib" | "isha") && event.at > now_ms() && event.at <= horizon)
    .map(|event| task_scheduler::TaskSpec {
      name: task_scheduler::task_name_for(&event.id),
      at_epoch_ms: event.at,
      label: format!("حان وقت صلاة {}", event.name),
    })
    .collect();
  task_scheduler::sync_tasks(&specs).map_err(|error| error.to_string())
}

/// يحذف كل مهام تَرتيل من مجدول ويندوز. لا يمسّ أي مهمة أخرى.
#[tauri::command]
fn clear_windows_tasks() -> usize {
  task_scheduler::delete_all_tasks()
}

/// اللحظة الحالية بالمللي ثانية. دالة واحدة تستخدمها كل المنظومة.
fn now_ms() -> i64 {
  SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default()
    .as_millis().min(i64::MAX as u128) as i64
}

/// يرسل حدث الصلاة إلى بطاقة التطبيق فقط؛ الإشعارات مخصصة للتنبيه المسبق.
fn deliver_alarm(app: &tauri::AppHandle, event: alarm::AlarmEvent) {
  let payload = AdhanPayload {
    id: event.id, key: event.key, name: event.name, at: event.at,
  };
  if let Err(error) = app.emit("prayer-adhan", payload) {
    eprintln!("Tarteel alarm event delivery failed: {error}");
  }
  /* إظهار النافذة الرئيسية إن كانت مخفية، حتى يرى المستخدم البطاقة. */
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.unminimize();
  }
  if let Some(island) = app.get_webview_window("island") {
    let _ = island.show();
  }
}

/// حلقة الإطلاق: تفحص كل 250ms. عند استئناف الجهاز من النوم لا تُطلق أحداثًا
/// متأخرة، بل تُسجّلها كمُطلقة (انظر alarm::tick).
fn start_alarm_loop(app: tauri::AppHandle, state: alarm::SharedAlarm, path: PathBuf, engine: AudioEngine) {
  let spawned = thread::Builder::new().name("tarteel-alarm".into()).spawn(move || loop {
    thread::sleep(Duration::from_millis(250));
    let tick_result = {
      let Ok(mut guard) = state.lock() else { continue };
      let result = alarm::tick(&mut guard, now_ms());
      if result.changed {
        if let Err(error) = alarm::write_state(&path, &guard) {
          eprintln!("Tarteel alarm persistence failed: {error}");
        }
      }
      result
    };
    for event in tick_result.skipped {
      /* فات وقته: يُسجَّل بلا صوت حتى لا يُزعج المستخدم بعد ساعات. */
      eprintln!("Tarteel alarm skipped (too late): {}", event.id);
    }
    for event in tick_result.due { deliver_alarm(&app, event); }
    if let Some(id) = engine.take_completed_playback() {
      if let Err(error) = app.emit("adhan-playback-state", serde_json::json!({
        "playing": false, "ended": true, "id": id
      })) {
        eprintln!("Tarteel adhan completion event delivery failed: {error}");
      }
    }
    if tick_result.sleep_due {
      if let Err(error) = app.emit("sleep-deadline", ()) {
        eprintln!("Tarteel sleep timer event delivery failed: {error}");
      }
    }
  });
  if let Err(error) = spawned { eprintln!("Tarteel alarm loop failed to start: {error}"); }
}

/* ------------------------------------------------------------------ *
 * منظومة الأذان: صوت أصلي + بطاقة التطبيق + كتم
 * ------------------------------------------------------------------ */

/// يضمن وجود ملف الأذان المرفق `adhan-call.mpeg` على القرص.
///
/// الملف مرفق بالحزمة كأصل (resource). في التشغيل التطويري لا يكون منسوخًا
/// بعد، فنبحث في مسار المصدر كاحتياط حتى لا يفشل «تجربة التنبيه».
fn resolve_adhan_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let candidates = [
    app.path().resolve("assets/adhan-call.mpeg", tauri::path::BaseDirectory::Resource).ok(),
    Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets").join("adhan-call.mpeg")),
  ];
  for candidate in candidates.into_iter().flatten() {
    if candidate.exists() {
      return Ok(candidate);
    }
  }
  Err("ملف الأذان غير موجود في الحزمة".into())
}

#[tauri::command]
fn play_adhan(app: tauri::AppHandle, engine: State<AudioEngine>, id: Option<String>) -> Result<(), String> {
  let path = resolve_adhan_file(&app)?;
  let key = id.unwrap_or_else(|| "manual".to_string());
  let playing = engine.play(&key, &path, now_ms(), true)?;
  let _ = app.emit("adhan-playback-state", serde_json::json!({ "playing": playing, "id": key }));
  Ok(())
}

#[tauri::command]
fn stop_adhan(app: tauri::AppHandle, engine: State<AudioEngine>) -> Result<(), String> {
  engine.stop();
  let _ = app.emit("adhan-playback-state", serde_json::json!({ "playing": false, "stopped": true }));
  Ok(())
}

#[tauri::command]
fn set_adhan_preferences(
  handle: State<AdhanPreferencesHandle>,
  engine: State<AudioEngine>,
  enabled: bool,
  volume: u32,
  muted: bool,
) -> Result<(), String> {
  let preferences = update_adhan_preferences(&handle, |stored| {
    stored.enabled = enabled;
    stored.volume = volume;
    stored.muted = muted;
  })?;
  engine.set_volume(preferences.volume);
  engine.set_muted(preferences.muted);
  Ok(())
}

#[tauri::command]
fn set_adhan_volume(handle: State<AdhanPreferencesHandle>, engine: State<AudioEngine>, volume: u32) -> Result<(), String> {
  let preferences = update_adhan_preferences(&handle, |stored| stored.volume = volume)?;
  engine.set_volume(preferences.volume);
  Ok(())
}

#[tauri::command]
fn set_adhan_muted(handle: State<AdhanPreferencesHandle>, engine: State<AudioEngine>, muted: bool) -> Result<(), String> {
  let preferences = update_adhan_preferences(&handle, |stored| stored.muted = muted)?;
  engine.set_muted(preferences.muted);
  Ok(())
}

#[tauri::command]
fn adhan_state(engine: State<AudioEngine>) -> serde_json::Value {
  serde_json::json!({
    "muted": engine.is_muted(),
    "volume": engine.volume(),
    "playing": engine.is_playing(),
  })
}

#[tauri::command]
fn set_next_prayer_label(app: tauri::AppHandle, label: String) -> Result<(), String> {
  tray::update_next_prayer(&app, &label);
  Ok(())
}

#[tauri::command]
fn is_autostart_enabled<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> bool {
  use tauri_plugin_autostart::ManagerExt;
  app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart<R: tauri::Runtime>(app: tauri::AppHandle<R>, enabled: bool) -> Result<bool, String> {
  use tauri_plugin_autostart::ManagerExt;
  let manager = app.autolaunch();
  let result = if enabled { manager.enable() } else { manager.disable() };
  result.map_err(|e| format!("تعذر تغيير إعداد البدء التلقائي: {e}"))?;
  Ok(manager.is_enabled().unwrap_or(false))
}

/// يبثّ حدثًا إلى نافذة التطبيق الرئيسية.
/// تستخدمه الصينية لإبلاغ الواجهة بتبديل الكتم، فتبقى الواجهة مصدر الحقيقة.
pub fn emit_to_ui(app: &tauri::AppHandle, event: &str, payload: serde_json::Value) {
  let _ = app.emit(event, payload);
}

#[cfg(windows)]
async fn apply_island_native_region(
  island: &tauri::WebviewWindow,
  region: Option<(i32, i32, i32, i32, i32)>,
) -> Result<(), String> {
  let hwnd = island.hwnd().map_err(|e| format!("تعذر الحصول على مقبض نافذة الجزيرة: {e}"))?;
  let raw_hwnd = hwnd.0 as isize;
  let (tx, rx) = std::sync::mpsc::sync_channel(1);
  island.run_on_main_thread(move || {
    let hwnd = windows::Win32::Foundation::HWND(raw_hwnd as *mut core::ffi::c_void);
    let result = match region {
      Some((x, y, width, height, radius)) => {
        let bounds = hittest::expand_for_antialias_fringe(x, y, width, height, radius);
        hittest::set_collapsed_window_region(hwnd, bounds.0, bounds.1, bounds.2, bounds.3, bounds.4)
      },
      None => hittest::clear_window_region(hwnd),
    };
    let _ = tx.send(result);
  }).map_err(|e| format!("تعذر جدولة منطقة نافذة الجزيرة على خيط الواجهة: {e}"))?;
  tauri::async_runtime::spawn_blocking(move || rx.recv())
    .await.map_err(|e| format!("تعذر انتظار تطبيق منطقة نافذة الجزيرة: {e}"))?
    .map_err(|e| format!("انقطع تطبيق منطقة نافذة الجزيرة: {e}"))?
}

/// تُستدعى من الجزيرة لتحديد المنطقة التفاعلية الفعلية.
///
/// الواجهة تعرف شكل الجزيرة بعد كل انتقال، فتبلّغ به. في الوضع المطوي
/// تُطابق منطقة HWND نفسها الحدود المستديرة ونصف القطر، كي تصل النقرات خارجها إلى أي تطبيق.
#[tauri::command]
async fn set_island_hit_rect(x: f64, y: f64, width: f64, height: f64, radius: f64, app: tauri::AppHandle) -> Result<(), String> {
  let island = app.get_webview_window("island").ok_or_else(|| "نافذة الجزيرة غير متاحة".to_string())?;
  let scale = island.scale_factor().map_err(|e| format!("تعذر قراءة مقياس الشاشة: {e}"))?;
  #[cfg(windows)]
  let (client_offset_x, client_offset_y) = {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
    let hwnd = island.hwnd().map_err(|e| format!("تعذر قراءة مقبض نافذة الجزيرة: {e}"))?;
    let mut window_rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut window_rect) }.map_err(|e| format!("تعذر قراءة حدود نافذة الجزيرة: {e}"))?;
    let mut client_origin = POINT { x: 0, y: 0 };
    if !unsafe { ClientToScreen(hwnd, &mut client_origin) }.as_bool() {
      return Err(format!("تعذر تحويل أصل WebView إلى إحداثيات الشاشة: {}", windows::core::Error::from_thread()));
    }
    (client_origin.x - window_rect.left, client_origin.y - window_rect.top)
  };
  #[cfg(not(windows))]
  let (client_offset_x, client_offset_y) = (0, 0);
  let left = (x * scale).round() as i32 + client_offset_x;
  let top = (y * scale).round() as i32 + client_offset_y;
  let right = ((x + width) * scale).round() as i32 + client_offset_x;
  let bottom = ((y + height) * scale).round() as i32 + client_offset_y;
  let width = (right - left).max(0);
  let height = (bottom - top).max(0);
  #[cfg(windows)]
  let radius_px = if radius.is_finite() { (radius.max(0.0) * scale).round() as i32 } else { 0 };
  #[cfg(not(windows))]
  let _ = radius;
  hittest::set_interactive_rect(left, top, width, height);
  #[cfg(windows)]
  if hittest::pass_through() {
    apply_island_native_region(&island, Some((left, top, width, height, radius_px))).await?;
  }
  Ok(())
}

/// يفعّل أو يوقف تمرير النقرات. الموسّعات توقفه لتلتقط كل نقراتها.
#[tauri::command]
async fn set_island_pass_through(enabled: bool, app: tauri::AppHandle) -> Result<(), String> {
  hittest::set_pass_through(enabled);
  #[cfg(windows)]
  {
    let island = app.get_webview_window("island").ok_or_else(|| "نافذة الجزيرة غير متاحة".to_string())?;
    /* ارفع القصّ أثناء الحركة؛ set_island_hit_rect يعيد شكل الجزيرة بعد استقرارها. */
    apply_island_native_region(&island, None).await?;
  }
  #[cfg(not(windows))]
  let _ = app;
  Ok(())
}

#[tauri::command]
fn get_island_placement(state: State<IslandPlacementHandle>) -> Result<IslandPlacement, String> {
  state.placement.lock().map(|placement| *placement).map_err(|_| "تعذر قراءة موضع الجزيرة المحفوظ".to_string())
}

#[tauri::command]
fn set_island_placement(
  mode: String,
  offset_x: f64,
  offset_y: f64,
  app: tauri::AppHandle,
  state: State<IslandPlacementHandle>,
) -> Result<IslandPlacement, String> {
  let mode = match mode.as_str() {
    "auto" => IslandPositionMode::Auto,
    "manual" => IslandPositionMode::Manual,
    _ => return Err("وضع موضع الجزيرة غير معروف".into()),
  };
  let mut placement = normalize_island_placement(IslandPlacement { mode, offset_x, offset_y });
  let island = app.get_webview_window("island").ok_or_else(|| "نافذة الجزيرة غير متاحة".to_string())?;
  let monitor = island.current_monitor().map_err(|e| format!("تعذر تحديد شاشة الجزيرة: {e}"))?
    .or(island.primary_monitor().map_err(|e| format!("تعذر تحديد الشاشة الرئيسية: {e}"))?)
    .ok_or_else(|| "لم يُرجع Windows شاشة صالحة لضبط موضع الجزيرة".to_string())?;
  let area = monitor.size();
  let origin = monitor.position();
  let scale = island.scale_factor().map_err(|e| format!("تعذر قراءة مقياس الشاشة: {e}"))?;
  if placement.mode == IslandPositionMode::Manual {
    (placement.offset_x, placement.offset_y) = geometry::clamp_island_offsets_logical(
      area.width as i32, area.height as i32, scale, true, placement.offset_x, placement.offset_y,
    );
  }
  write_island_placement(&state.path, placement)?;
  *state.placement.lock().map_err(|_| "تعذر تحديث موضع الجزيرة".to_string())? = placement;

  let current = island.outer_position().map_err(|e| format!("تعذر قراءة موضع الجزيرة الحالي: {e}"))?;
  let size = island.outer_size().map_err(|e| format!("تعذر قراءة حجم نافذة الجزيرة: {e}"))?;
  let (left, top) = geometry::island_origin_with_placement(
    origin.x, origin.y, area.width as i32, area.height as i32, size.width as i32, scale,
    placement.mode == IslandPositionMode::Manual, placement.offset_x, placement.offset_y,
  );
  animate_island_bounds(island, current.x, current.y, left, top, size.width, size.height, state.animation_revision.clone())?;
  Ok(placement)
}

#[tauri::command]
fn get_island_appearance(state: State<IslandAppearanceHandle>) -> Result<IslandAppearance, String> {
  state.appearance.lock().map(|appearance| *appearance).map_err(|_| "تعذر قراءة مظهر الجزيرة المحفوظ".to_string())
}

#[tauri::command]
fn set_island_appearance(
  appearance: String,
  app: tauri::AppHandle,
  state: State<IslandAppearanceHandle>,
) -> Result<IslandAppearance, String> {
  let appearance = match appearance.as_str() {
    "glass" => IslandAppearance::Glass,
    "black" => IslandAppearance::Black,
    _ => return Err("مظهر الجزيرة غير معروف".into()),
  };
  let mut stored = state.appearance.lock().map_err(|_| "تعذر تحديث مظهر الجزيرة".to_string())?;
  write_island_appearance(&state.path, appearance)?;
  *stored = appearance;
  let _ = app.emit("island-appearance-changed", serde_json::json!({ "appearance": appearance }));
  Ok(appearance)
}

/// يحرك النافذة الأصلية على خيطها في إطارات قصيرة، دون تغيير حجمها أو تنشيطها.
fn animate_island_bounds(
  island: tauri::WebviewWindow,
  start_x: i32,
  start_y: i32,
  left: i32,
  top: i32,
  width: u32,
  height: u32,
  revision: Arc<AtomicU64>,
) -> Result<(), String> {
  let generation = revision.fetch_add(1, Ordering::SeqCst) + 1;
  if start_x == left && start_y == top { return Ok(()); }
  thread::Builder::new().name("tarteel-island-position".into()).spawn(move || {
    const FRAMES: u32 = geometry::ISLAND_POSITION_ANIMATION_FRAMES;
    for frame in 1..=FRAMES {
      thread::sleep(Duration::from_millis(geometry::ISLAND_POSITION_ANIMATION_FRAME_MS));
      if revision.load(Ordering::SeqCst) != generation { return; }
      let progress = frame as f64 / FRAMES as f64;
      let eased = geometry::island_position_motion_progress(progress);
      let x = (start_x as f64 + (left - start_x) as f64 * eased).round() as i32;
      let y = (start_y as f64 + (top - start_y) as f64 * eased).round() as i32;
      let target = island.clone();
      let frame_revision = revision.clone();
      let _ = island.run_on_main_thread(move || {
        if frame_revision.load(Ordering::SeqCst) != generation { return; }
        if let Err(cause) = apply_island_bounds_native(&target, x, y, width, height) {
          eprintln!("Tarteel smooth island movement failed: {cause}");
          return;
        }
        if frame == FRAMES {
          let _ = target.emit("island-geometry-recheck", serde_json::json!({}));
        }
      });
    }
  }).map_err(|e| format!("تعذر بدء الحركة السلسة لموضع الجزيرة: {e}"))?;
  Ok(())
}

#[tauri::command]
fn resize_island(app: tauri::AppHandle, state: State<IslandPlacementHandle>, width: f64, height: f64) -> Result<(), String> {
  /* أبعاد الأمر هي أبعاد النافذة الفعلية وتشمل هامش الرسم الشفاف. */
  if !geometry::is_supported_island_resize(width, height) {
    return Err(format!("رفضت أبعاد نافذة الجزيرة {width}×{height} CSS px: خارج الحدود الآمنة"));
  }
  let island = app.get_webview_window("island").ok_or_else(|| "نافذة الجزيرة غير متاحة".to_string())?;
  let monitor = island.current_monitor().map_err(|e| format!("تعذر تحديد شاشة الجزيرة: {e}"))?
    .or(island.primary_monitor().map_err(|e| format!("تعذر تحديد الشاشة الرئيسية: {e}"))?)
    .ok_or_else(|| "لم يُرجع Windows شاشة صالحة لتمركز الجزيرة".to_string())?;
  let area = monitor.size();
  let origin = monitor.position();
  let scale = island.scale_factor().map_err(|e| format!("تعذر قراءة مقياس الشاشة: {e}"))?;

  /* أبقِ نافذة WebView على الأقل بارتفاع مسرح الخمول الصغير، ثم وسّعها
     قبل انتقال الحالة. هذه مساحة رسم للجزيرة فقط ولا تُحجز من Windows. */
  let target_width = (width * scale).round() as u32;
  let floor = geometry::compact_window_height_px(scale).max(1) as u32;
  let desired = (height * scale).round() as u32;
  let target_height = desired.max(floor);

  let placement = *state.placement.lock().map_err(|_| "تعذر قراءة موضع الجزيرة".to_string())?;
  let (left, top) = geometry::island_origin_with_placement(
    origin.x, origin.y, area.width as i32, area.height as i32, target_width as i32, scale,
    placement.mode == IslandPositionMode::Manual, placement.offset_x, placement.offset_y,
  );

  let target = island.clone();
  island.run_on_main_thread(move || {
    /* الأبعاد المطلوبة تشمل الهامش الشفاف وتُطبّق كما هي على النافذة بلا إطار. */
    if let Err(e) = apply_island_bounds(&target, left, top, target_width, target_height) {
      eprintln!("Tarteel island bounds could not be applied: {e}");
    }
  }).map_err(|e| format!("تعذر جدولة تغيير أبعاد الجزيرة على خيط الواجهة: {e}"))?;
  Ok(())
}

/// حجم نافذة الرسم عند الإقلاع: مساحة الخمول المرئية مع الهامش الشفاف حولها.
/// تحديده قبل الإظهار يمنع انتقال المركز من حجم WebView الافتراضي.
fn island_boot_size_logical() -> (f64, f64) {
  (geometry::compact_window_width_logical(), geometry::compact_window_height_logical())
}

fn island_bounds_from_monitor(
  monitor_left: i32,
  monitor_top: i32,
  monitor_width: i32,
  monitor_height: i32,
  scale: f64,
  placement: IslandPlacement,
) -> (i32, i32, i32, i32) {
  let width = geometry::compact_window_width_px(scale);
  let height = geometry::compact_window_height_px(scale);
  let (x, y) = geometry::island_origin_with_placement(
    monitor_left, monitor_top, monitor_width, monitor_height, width, scale,
    placement.mode == IslandPositionMode::Manual, placement.offset_x, placement.offset_y,
  );
  (x, y, width, height)
}

/// `SetWindowPos` changes position and size in a single call, so no frame ever sees one
/// applied without the other. It has window thread affinity, hence the main-thread hop.
fn apply_island_bounds(island: &tauri::WebviewWindow, left: i32, top: i32, width: u32, height: u32) -> Result<(), String> {
  apply_island_bounds_native(island, left, top, width, height)
}
#[tauri::command]
fn set_audio_root(server: State<AudioServer>, path: String) -> Result<(), String> {
  let root = PathBuf::from(path).canonicalize().map_err(|e| format!("مجلد الصوت غير موجود: {e}"))?;
  if !root.is_dir() { return Err("المسار المختار ليس مجلدًا".into()); }
  *server.root.write().map_err(|_| "تعذر تحديث مجلد الصوت".to_string())? = Some(root);
  Ok(())
}

#[tauri::command]
fn audio_url(server: State<AudioServer>, path: String) -> Result<String, String> {
  let candidate = PathBuf::from(&path).canonicalize().map_err(|e| format!("تعذر فتح الملف: {e}"))?;
  let allowed = server.root.read().map_err(|_| "تعذر قراءة حالة خادم الصوت".to_string())?.as_ref().is_some_and(|root| candidate.starts_with(root));
  if !allowed || !candidate.is_file() || !supported(&candidate) { return Err("الملف خارج مجلد الصوت أو صيغته غير مدعومة".into()); }
  let encoded = URL_SAFE_NO_PAD.encode(path.as_bytes());
  Ok(format!("http://127.0.0.1:{}/audio/{}/{encoded}", server.port, server.token))
}

fn checked_spatial_audio_path(server: &AudioServer, path: &str) -> Result<PathBuf, String> {
  let candidate = PathBuf::from(path).canonicalize().map_err(|error| format!("تعذر فتح ملف التلاوة: {error}"))?;
  let allowed = server.root.read().map_err(|_| "تعذر قراءة مجلد مكتبة الصوت".to_string())?
    .as_ref().is_some_and(|root| candidate.starts_with(root));
  let extension = candidate.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
  let decodable = matches!(extension.as_str(), "mp3" | "flac" | "wav" | "m4a" | "mp4" | "ogg" | "oga" | "opus" | "webm");
  if !allowed || !candidate.is_file() || !supported(&candidate) || !decodable {
    return Err("الملف خارج مجلد المكتبة أو أن صيغته غير مدعومة للمعالجة المكانية".into());
  }
  Ok(candidate)
}

#[tauri::command]
fn start_spatial_recitation(
  server: State<AudioServer>, engine: State<SpatialAudioEngine>, path: String,
  mode: String, position: f64, volume: u32, speed: f32, autoplay: bool,
) -> Result<RecitationStatus, String> {
  if !position.is_finite() || position < 0.0 || position > 86_400.0 {
    return Err("موضع التلاوة المطلوب غير صالح".into());
  }
  let file = checked_spatial_audio_path(&server, &path)?;
  engine.play(&file, DspMode::parse(&mode)?, Duration::from_secs_f64(position), volume, speed, autoplay)
}

#[tauri::command]
fn spatial_audio_state(engine: State<SpatialAudioEngine>) -> RecitationStatus { engine.state() }
#[tauri::command]
fn spatial_audio_pause(engine: State<SpatialAudioEngine>) -> Result<(), String> { engine.pause() }
#[tauri::command]
fn spatial_audio_resume(engine: State<SpatialAudioEngine>) -> Result<(), String> { engine.resume() }
#[tauri::command]
fn spatial_audio_seek(engine: State<SpatialAudioEngine>, position: f64) -> Result<(), String> {
  if !position.is_finite() || position < 0.0 || position > 86_400.0 { return Err("موضع البحث غير صالح".into()); }
  engine.seek(Duration::from_secs_f64(position))
}
#[tauri::command]
fn spatial_audio_set_volume(engine: State<SpatialAudioEngine>, volume: u32) -> Result<(), String> { engine.set_volume(volume) }
#[tauri::command]
fn spatial_audio_set_speed(engine: State<SpatialAudioEngine>, speed: f32) -> Result<(), String> {
  if ![0.75_f32, 1.0, 1.25, 1.5].contains(&speed) { return Err("سرعة التشغيل غير مدعومة".into()); }
  engine.set_speed(speed)
}
#[tauri::command]
fn spatial_audio_stop(engine: State<SpatialAudioEngine>) { engine.stop(); }

#[tauri::command]
fn scan_directory(path: String) -> Result<Vec<Track>, String> {
  let root = PathBuf::from(&path); if !root.is_dir() { return Err("المجلد غير موجود أو غير قابل للقراءة".into()); }
  let mut out = Vec::new();
  for e in WalkDir::new(root).follow_links(false).into_iter().filter_map(Result::ok) {
    let p = e.path(); if !e.file_type().is_file() || !supported(p) { continue; }
    let file_name = p.file_name().and_then(|s| s.to_str()).unwrap_or_default().to_string();
    let mut title = file_name.clone(); let mut artist = String::new(); let mut duration = None; let mut cover = None;
    if let Ok(tagged) = Probe::open(p).and_then(|x| x.read()) { if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
      if let Some(v) = tag.title() { if !v.is_empty() { title = v.to_string(); } } if let Some(v) = tag.artist() { artist = v.to_string(); }
      if let Some(pic) = tag.pictures().first() { cover = Some(format!("data:{};base64,{}", pic.mime_type().map(|m| m.to_string()).unwrap_or_else(|| "image/jpeg".into()), base64::engine::general_purpose::STANDARD.encode(pic.data()))); }
    } duration = Some(tagged.properties().duration().as_secs()); }
    out.push(Track { path: p.to_string_lossy().into_owned(), file_name, title, artist, duration, cover });
  }
  out.sort_by_key(|x| x.file_name.to_lowercase()); Ok(out)
}

#[cfg(windows)]
fn apply_island_bounds_native(island: &tauri::WebviewWindow, left: i32, top: i32, width: u32, height: u32) -> Result<(), String> {
  use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};
  let hwnd = island.hwnd().map_err(|e| format!("تعذر الحصول على مقبض نافذة الجزيرة: {e}"))?;
  // SAFETY: hwnd belongs to this process and this call runs on the window's own thread.
  unsafe { SetWindowPos(hwnd, None, left, top, width as i32, height as i32, SWP_NOZORDER | SWP_NOACTIVATE) }
    .map_err(|e| format!("تعذر تطبيق موضع وحجم الجزيرة في نداء واحد: {e}"))
}

#[cfg(not(windows))]
fn apply_island_bounds_native(island: &tauri::WebviewWindow, left: i32, top: i32, width: u32, height: u32) -> Result<(), String> {
  let scale = island.scale_factor().map_err(|e| e.to_string())?;

  island.set_position(PhysicalPosition::new(left, top)).map_err(|e| e.to_string())?;
  island.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width as f64 / scale, height as f64 / scale))).map_err(|e| e.to_string())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let server = start_audio_server().expect("error while starting local audio server");
  let args: Vec<String> = std::env::args().collect();
  let pending = PendingAlarms::default();
  if let Some(task_name) = scheduled_task_argument(&args) {
    if let Ok(mut queue) = pending.task_names.lock() { queue.push(task_name); }
  }
  tauri::Builder::default()
    .manage(pending)
    /* نسخة واحدة فقط. بلا هذا السطر يفتح المستخدم التطبيق مرتين فيجد
       نسختين لكل نافذة، وتتضاعف الجزيرة. الترتيب مقصود: يجب أن يُسجَّل
       القفل قبل أي نافذة. النقر على الاختصار مجددًا يُظهر النافذة القائمة. */
    .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
      if let Some(task_name) = scheduled_task_argument(&argv) {
        queue_scheduled_task(app, task_name);
      } else if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
      }
      if let Some(island) = app.get_webview_window("island") {
        let _ = island.show();
      }
    }))
    .manage(server)
    .manage(audio::AudioEngine::new())
    .manage(SpatialAudioEngine::new())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_autostart::init(
      tauri_plugin_autostart::MacosLauncher::LaunchAgent,
      /* البدء مع ويندوز يمرّر --hidden ليبدأ مصغرًا في الصينية. */
      Some(vec!["--hidden"]),
    ))
    .setup(|app| {
      let placement_path = app.path().app_config_dir()?.join(ISLAND_PLACEMENT_FILE);
      let initial_placement = read_island_placement(&placement_path);
      app.manage(IslandPlacementHandle {
        placement: Mutex::new(initial_placement),
        path: placement_path,
        animation_revision: Arc::new(AtomicU64::new(0)),
      });
      let appearance_path = app.path().app_config_dir()?.join(ISLAND_APPEARANCE_FILE);
      let initial_appearance = read_island_appearance(&appearance_path);
      app.manage(IslandAppearanceHandle {
        appearance: Mutex::new(initial_appearance),
        path: appearance_path,
      });
      /* طلب المهمة قد يصل قبل أو بعد جاهزية WebView؛ نخزنه حتى تصبح أحداث
         البطاقة مسجلة، فلا يضيع الأذان عند بدء التطبيق في الخلفية. */
      let main_ready_app = app.handle().clone();
      let _main_ready_listener = app.listen_any("main-ready", move |_| {
        if let Some(pending) = main_ready_app.try_state::<PendingAlarms>() {
          pending.main_ready.store(true, Ordering::SeqCst);
        }
        process_pending_scheduled_tasks(&main_ready_app);
      });
      let island_ready_app = app.handle().clone();
      let _island_ready_listener = app.listen_any("island-ready", move |_| {
        if let Some(pending) = island_ready_app.try_state::<PendingAlarms>() {
          pending.island_ready.store(true, Ordering::SeqCst);
        }
        process_pending_scheduled_tasks(&island_ready_app);
      });
      /* اختبار Windows فقط: متغير عملية مؤقت يجهز حالة موسيقى اصطناعية عبر
         الحدث نفسه الذي تستخدمه الواجهة. لا يُفعّل هذا المسار في التشغيل العادي. */
      if std::env::var("TARTEEL_WINDOWS_SMOKE_TEST").ok().as_deref() == Some("1") {
        let smoke_handle = app.handle().clone();
        let _ = app.once_any("island-ready", move |_| {
          let smoke_handle = smoke_handle.clone();
          thread::spawn(move || {
            thread::sleep(Duration::from_secs(2));
            if let Err(cause) = smoke_handle.emit("player-state", serde_json::json!({
              "state": "compact", "playing": false, "fileName": "Smoke test recitation.wav",
              "artist": "Windows smoke", "cover": null, "duration": 60, "position": 0,
              "speed": 1, "sleepMode": "off", "sleepMinutes": 0, "prayerAlert": ""
            })) {
              eprintln!("Tarteel Windows smoke music state emit failed: {cause}");
              return;
            }
            thread::sleep(Duration::from_secs(45));
            if let Err(cause) = smoke_handle.emit("player-state", serde_json::json!({
              "state": "idle", "playing": false, "fileName": "", "artist": "",
              "cover": null, "duration": 0, "position": 0, "speed": 1,
              "sleepMode": "off", "sleepMinutes": 0, "prayerAlert": ""
            })) {
              eprintln!("Tarteel Windows smoke idle state emit failed: {cause}");
            }
          });
        });
      }
      /* اختبار Windows فقط: يبث حالتي تنبيه اصطناعيتين لاختبار الإخفاء التلقائي
         بعد الاكتمال وزر «تم» دون تشغيل ملف صوتي حقيقي. */
      if std::env::var("TARTEEL_WINDOWS_ALERT_SMOKE_TEST").ok().as_deref() == Some("1") {
        let alert_smoke_handle = app.handle().clone();
        let _ = app.once_any("island-ready", move |_| {
          let alert_smoke_handle = alert_smoke_handle.clone();
          thread::spawn(move || {
            thread::sleep(Duration::from_secs(2));
            let id = "windows-smoke-alert-auto-end";
            if let Err(cause) = alert_smoke_handle.emit("adhan-playback-state", serde_json::json!({
              "playing": true, "id": id
            })) {
              eprintln!("Tarteel Windows smoke alert state emit failed: {cause}");
              return;
            }
            if let Err(cause) = alert_smoke_handle.emit("prayer-alarm-restore", serde_json::json!({
              "id": id, "key": "fajr", "name": "الفجر", "wasPlaying": true,
              "pausedByAdhan": true, "resumeDisabled": false
            })) {
              eprintln!("Tarteel Windows smoke alert restore emit failed: {cause}");
              return;
            }
            thread::sleep(Duration::from_secs(8));
            if let Err(cause) = alert_smoke_handle.emit("adhan-playback-state", serde_json::json!({
              "playing": false, "ended": true, "id": id
            })) {
              eprintln!("Tarteel Windows smoke adhan completion emit failed: {cause}");
              return;
            }
            thread::sleep(Duration::from_secs(3));
            let id = "windows-smoke-alert-dismiss";
            if let Err(cause) = alert_smoke_handle.emit("adhan-playback-state", serde_json::json!({
              "playing": true, "id": id
            })) {
              eprintln!("Tarteel Windows smoke dismissal alert state emit failed: {cause}");
              return;
            }
            if let Err(cause) = alert_smoke_handle.emit("prayer-alarm-restore", serde_json::json!({
              "id": id, "key": "maghrib", "name": "المغرب", "wasPlaying": true,
              "pausedByAdhan": true, "resumeDisabled": false
            })) {
              eprintln!("Tarteel Windows smoke dismissal alert restore emit failed: {cause}");
            }
          });
        });
      }
      /* الحجم يُحدد هنا لا في الملف: النافذة كانت تُبنى بلا `inner_size`
         فتحصل على الحجم الافتراضي (~800×600)، فيصبح مركزها (400, 300) بدل
         (0, 0). وكل تغيير حجم لاحق يُبقى المركز ثابتًا، فتظهر الجزيرة في
         وسط الشاشة بدل أعلاها — وهو ما رآه المستخدم بالضبط.
         الآن تُولد بالحجم النهائي الصحيح منذ اللحظة الأولى. */
      let boot_size = island_boot_size_logical();
      let island_builder = WebviewWindowBuilder::new(app, "island", WebviewUrl::App("island.html".into()));
      // Windows smoke only: enable CDP for the island WebView with its own data directory.
      #[cfg(windows)]
      let island_builder = if std::env::var("TARTEEL_WINDOWS_SMOKE_CDP").ok().as_deref() == Some("1") {
        let port = std::env::var("TARTEEL_WINDOWS_SMOKE_DEBUG_PORT")
          .expect("Windows smoke CDP requires TARTEEL_WINDOWS_SMOKE_DEBUG_PORT");
        let data_directory = std::env::var("TARTEEL_WINDOWS_SMOKE_WEBVIEW_DATA_DIR")
          .expect("Windows smoke CDP requires TARTEEL_WINDOWS_SMOKE_WEBVIEW_DATA_DIR");
        let browser_args = format!("--remote-debugging-port={port} --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
        island_builder
          .additional_browser_args(&browser_args)
          .data_directory(PathBuf::from(data_directory))
      } else {
        island_builder
      };
      let island = island_builder
        .title("تَرتيل")
        .inner_size(boot_size.0, boot_size.1)
        .decorations(false)
        .transparent(true)
        .background_color(Color(0, 0, 0, 0))
        .shadow(false)
        .no_redirection_bitmap(true)
        .always_on_top(true)
        .focused(false)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .build()?;
      let monitor = island.primary_monitor()?.or(island.current_monitor()?)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "تعذر الحصول على شاشة لتمركز الجزيرة"))?;
      let area = monitor.size();
      let origin = monitor.position();
      let scale = island.scale_factor()?;
      let mut placement = app.state::<IslandPlacementHandle>().placement.lock().map(|saved| *saved).unwrap_or_default();
      if placement.mode == IslandPositionMode::Manual {
        (placement.offset_x, placement.offset_y) = geometry::clamp_island_offsets_logical(
          area.width as i32, area.height as i32, scale, true, placement.offset_x, placement.offset_y,
        );
        if let Ok(mut saved) = app.state::<IslandPlacementHandle>().placement.lock() { *saved = placement; }
        if let Err(cause) = write_island_placement(&app.state::<IslandPlacementHandle>().path, placement) {
          eprintln!("Tarteel could not persist the safe manual island position: {cause}");
        }
      }

      /* إزالة إطار Windows غير المرئي قبل ضبط الموضع حتى تطابق حدود النافذة
         المرئية الإحداثيات الفيزيائية التي سنطبقها. */
      #[cfg(windows)]
      if let Ok(hwnd) = island.hwnd() {
        if let Err(cause) = frame::strip_frame(hwnd) {
          eprintln!("Tarteel island frame strip failed: {cause}");
        }
        /* النقرات: كل نقطة خارج الكبسولة تُمرَّر إلى النافذة التي تحتها.
           هذا ما يوقف «تعطيل» أعلى نوافذ المستخدم. */
        if let Err(cause) = hittest::attach(hwnd) {
          eprintln!("Tarteel island hit-test attach failed: {cause}");
        }
      }

      /* الجزيرة نافذة شفافة مستقلة؛ لا تنشئ شريطًا ولا تعدّل مساحة عمل Windows. */
      let (x, y, w, h) = island_bounds_from_monitor(origin.x, origin.y, area.width as i32, area.height as i32, scale, placement);
      /* الحجم والموضع في نداء واحد: `SetWindowPos` تُطبّق الاثنين معًا، فلا
         يُرى إطار واحد بالحجم القديم في الموضع الجديد. */
      island.set_size(tauri::PhysicalSize::new(w as u32, h as u32))?;
      island.set_position(PhysicalPosition::new(x, y))?;
      /* تشديد أخير عبر Win32: الموضع الفعلي كما يراه مدير النوافذ، لا كما
         تظنه Tauri بعد سلسلة تغييرات حجم. */
      #[cfg(windows)]
      if let Ok(hwnd) = island.hwnd() {
        let _ = apply_island_bounds_native(&island, x, y, w as u32, h as u32);
        let _ = hwnd;
      }
      island.show()?;
      if let Err(cause) = island_diagnostics::record_startup(app.handle()) {
        eprintln!("Tarteel startup geometry record failed: {cause}");
      }
      /* حالة التنبيهات: تُقرأ من القرص عند الإقلاع، فتبقى المعرّفات المُطلقة
         محفوظة عبر إعادة التشغيل ولا يتكرر أي أذان. */
      let config_dir = app.path().app_config_dir()?;
      let adhan_preferences_path = config_dir.join("adhan-preferences.json");
      let adhan_preferences = read_adhan_preferences(&adhan_preferences_path);
      let audio_engine = app.state::<AudioEngine>().inner().clone();
      audio_engine.set_volume(adhan_preferences.volume);
      audio_engine.set_muted(adhan_preferences.muted);
      app.manage(AdhanPreferencesHandle {
        state: Arc::new(Mutex::new(adhan_preferences)), path: adhan_preferences_path,
      });
      let alarm_path = alarm::state_path(&config_dir);
      let alarm_state = Arc::new(Mutex::new(alarm::read_state(&alarm_path)));
      app.manage(AlarmHandle { state: alarm_state.clone(), path: alarm_path.clone() });
      process_pending_scheduled_tasks(app.handle());
      start_alarm_loop(app.handle().clone(), alarm_state, alarm_path, audio_engine);

      /* الصينية: تُبنى قبل إظهار النوافذ حتى يبقى التطبيق قابلًا للوصول
         بعد الإخفاء. */
      tray::build_tray(app.handle())?;

      /* --hidden يعني إقلاعًا تلقائيًا مع ويندوز: ابدأ في الصينية. */
      if std::env::args().any(|arg| arg == "--hidden") {
        tray::hide_all(app.handle());
      }
      Ok(())
    })
    .on_window_event(|window, event| {
      if window.label() == "island" {
        if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } | tauri::WindowEvent::Focused(true)) {
          let _ = window.emit("island-geometry-recheck", serde_json::json!({}));
        }
        return;
      }
      if window.label() != "main" {
        return;
      }
      /* إغلاق إلى الصينية: (X) يُخفي ولا يقتل. قتل العملية يُلغي الأذان،
         والمستخدم يريد التنبيهات حتى بعد إغلاق النافذة. الخروج النهائي
         متاح من قائمة الصينية وحدها. */
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        /* إغلاق نافذة الإعدادات يُخفيها وحدها. الجزيرة نافذة مستقلة تبقى
           في مكانها، والتطبيق يبقى حيًّا في الصينية حتى الخروج الصريح. */
        tray::hide_to_tray(window.app_handle());
      }
    })
    .invoke_handler(tauri::generate_handler![
      scan_directory, set_audio_root, audio_url,
      start_spatial_recitation, spatial_audio_state, spatial_audio_pause, spatial_audio_resume,
      spatial_audio_seek, spatial_audio_set_volume, spatial_audio_set_speed, spatial_audio_stop,
      resize_island, get_island_placement, set_island_placement,
      get_island_appearance, set_island_appearance,
      set_alarm_schedule, set_sleep_deadline, sync_windows_tasks, clear_windows_tasks,
      alarm_status,
      set_island_hit_rect, set_island_pass_through,
      island_diagnostics::record_island_geometry,
      play_adhan, stop_adhan, set_adhan_preferences, set_adhan_volume, set_adhan_muted, adhan_state,
      set_next_prayer_label,
      is_autostart_enabled, set_autostart
    ])
    .run(tauri::generate_context!())
    .expect("error while running Tauri application");
}

#[cfg(test)]
mod island_tests {
  use super::*;

  #[test]
  fn supported_audio_extensions_include_opus_and_map_its_mime_type() {
    for extension in ["mp3", "m4a", "mp4", "flac", "ogg", "oga", "opus", "wav", "webm"] {
      assert!(supported(Path::new(&format!("recitation.{extension}"))), "{extension}");
    }
    assert_eq!(mime_for(Path::new("recitation.opus")), "audio/ogg");
  }

  #[test]
  fn adhan_preferences_persist_and_clamp_volume() {
    let dir = std::env::temp_dir().join(format!("tarteel-adhan-prefs-test-{}", std::process::id()));
    let path = dir.join("adhan-preferences.json");
    let initial = AdhanPreferences { enabled: false, volume: 64, muted: true };
    write_adhan_preferences(&path, &initial).unwrap();
    assert_eq!(read_adhan_preferences(&path), initial);

    let handle = AdhanPreferencesHandle { state: Arc::new(Mutex::new(initial)), path: path.clone() };
    let updated = update_adhan_preferences(&handle, |prefs| prefs.volume = 140).unwrap();
    assert_eq!(updated.volume, 100);
    assert!(!updated.enabled);
    assert!(updated.muted);
    assert_eq!(read_adhan_preferences(&path), updated);
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn island_bounds_are_derived_from_the_actual_monitor_origin() {
    for scale in [1.0, 1.25, 1.5] {
      let (x, y, w, h) = island_bounds_from_monitor(0, 0, 1920, 1080, scale, IslandPlacement::default());
      assert_eq!(y, 0, "الجزيرة تبدأ من أصل الشاشة المختارة");
      assert_eq!(w, geometry::compact_window_width_px(scale), "النافذة تشمل الهامش الشفاف");
      assert_eq!(h, geometry::compact_window_height_px(scale), "النافذة تشمل الهامش الشفاف");
      assert!(x > 0 && x + w < 1920, "متمركزة أفقياً");
      let right_margin = 1920 - w - x;
      assert!((right_margin - x).abs() <= 1, "النافذتان متساويتان إلى أقرب بكسل فيزيائي");
      let center_error = (x as f64 + w as f64 / 2.0 - 960.0).abs();
      assert!(center_error <= 0.5, "خطأ مركز النافذة لا يتجاوز نصف بكسل: {center_error}");
    }
  }

  #[test]
  fn island_boot_size_includes_the_transparent_gutter() {
    assert_eq!(island_boot_size_logical(), (48.0, 42.0));
  }

  #[test]
  fn transparent_window_gutter_preserves_css_stage_at_every_scale() {
    for dpi in [96u32, 120, 144, 192] {
      let scale = geometry::scale_from_dpi(dpi);
      let (_, _, _, h) = island_bounds_from_monitor(0, 0, 1920, 1080, scale, IslandPlacement::default());
      assert_eq!(h, (42.0 * scale).round() as i32, "dpi {dpi}");
    }
  }

  #[test]
  fn a_second_monitor_is_centred_on_its_own_origin() {
    let (x, y, w, _) = island_bounds_from_monitor(1920, -1080, 1920, 1080, 1.25, IslandPlacement::default());
    assert_eq!(x, 1920 + (1920 - w) / 2);
    assert_eq!(y, -1080);
  }

  #[test]
  fn a_manual_offset_is_restored_from_disk_and_survives_switching_back_to_auto() {
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("tarteel-island-position-{}-{unique}", std::process::id()));
    let path = root.join(ISLAND_PLACEMENT_FILE);
    let manual = IslandPlacement { mode: IslandPositionMode::Manual, offset_x: -28.0, offset_y: -2.0 };
    write_island_placement(&path, manual).expect("يحفظ الإزاحة اليدوية");
    assert_eq!(read_island_placement(&path), manual, "تُستعاد بعد إعادة إنشاء الحالة");
    assert_eq!(geometry::island_offset_px(1920, 1080, 1.0, true, manual.offset_x, manual.offset_y), (-28, -2));

    let auto = IslandPlacement { mode: IslandPositionMode::Auto, ..manual };
    assert_eq!(geometry::island_offset_px(1920, 1080, 1.0, false, auto.offset_x, auto.offset_y), (0, 0), "Auto يعيد الموضع المحسوب تلقائيًا");
    write_island_placement(&path, auto).expect("يحفظ الرجوع إلى Auto");
    assert_eq!(read_island_placement(&path), auto, "لا يمسح Auto الإزاحة اليدوية المحفوظة");
    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn malformed_or_non_finite_position_data_falls_back_safely() {
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("tarteel-island-position-bad-{}-{unique}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let path = root.join(ISLAND_PLACEMENT_FILE);
    fs::write(&path, b"not-json").unwrap();
    assert_eq!(read_island_placement(&path), IslandPlacement::default());
    let normalized = normalize_island_placement(IslandPlacement {
      mode: IslandPositionMode::Manual, offset_x: f64::NAN, offset_y: 1.0e30,
    });
    assert_eq!(normalized.offset_x, 0.0);
    assert_eq!(normalized.offset_y, MAX_STORED_ISLAND_OFFSET);
    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn island_appearance_defaults_to_glass_and_persists_both_choices() {
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("tarteel-island-appearance-{}-{unique}", std::process::id()));
    let path = root.join(ISLAND_APPEARANCE_FILE);
    assert_eq!(read_island_appearance(&path), IslandAppearance::Glass);
    write_island_appearance(&path, IslandAppearance::Black).expect("يحفظ المظهر الأسود");
    assert_eq!(read_island_appearance(&path), IslandAppearance::Black, "يُستعاد الاختيار بعد إعادة إنشاء الحالة");
    write_island_appearance(&path, IslandAppearance::Glass).expect("يحفظ الرجوع إلى الزجاج");
    assert_eq!(read_island_appearance(&path), IslandAppearance::Glass);
    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn malformed_island_appearance_data_falls_back_to_glass() {
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("tarteel-island-appearance-bad-{}-{unique}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let path = root.join(ISLAND_APPEARANCE_FILE);
    fs::write(&path, b"not-json").unwrap();
    assert_eq!(read_island_appearance(&path), IslandAppearance::Glass);
    let _ = fs::remove_dir_all(root);
  }
}
