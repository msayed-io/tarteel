use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use lofty::prelude::*;
use lofty::probe::Probe;
use tauri::webview::Color;
use tauri::{Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;
use walkdir::WalkDir;

#[derive(Serialize, Clone)]
pub struct Track { pub path: String, pub file_name: String, pub title: String, pub artist: String, pub duration: Option<u64>, pub cover: Option<String> }

fn supported(p: &Path) -> bool { matches!(p.extension().and_then(|x| x.to_str()).map(|x| x.to_ascii_lowercase()).as_deref(), Some("mp3"|"m4a"|"mp4"|"flac"|"ogg"|"oga"|"wav"|"webm")) }

#[derive(Clone)]
struct AudioServer { root: Arc<RwLock<Option<PathBuf>>>, token: String, port: u16 }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrayerEvent { id: String, name: String, at: i64 }

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SchedulerData {
  events: Vec<PrayerEvent>,
  fired_ids: Vec<String>,
  sleep_deadline_ms: Option<i64>,
}

struct PrayerScheduler { data: Arc<Mutex<SchedulerData>>, path: PathBuf }

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AdhanPayload { id: String, name: String, at: i64, notification_error: Option<String> }

const LATE_ALARM_GRACE_MS: i64 = 3 * 60 * 1000;
const MAX_FIRED_IDS: usize = 240;

fn mime_for(path: &Path) -> &'static str {
  match path.extension().and_then(|x| x.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
    "mp3" => "audio/mpeg", "wav" => "audio/wav", "ogg"|"oga" => "audio/ogg", "webm" => "audio/webm",
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

fn write_scheduler(path: &Path, data: &SchedulerData) -> Result<(), String> {
  let parent = path.parent().ok_or_else(|| "مسار إعدادات الجدولة غير صالح".to_string())?;
  fs::create_dir_all(parent).map_err(|e| format!("تعذر إنشاء مجلد إعدادات الصلاة: {e}"))?;
  let bytes = serde_json::to_vec(data).map_err(|e| format!("تعذر ترميز إعدادات الجدولة: {e}"))?;
  fs::write(path, bytes).map_err(|e| format!("تعذر حفظ إعدادات الجدولة: {e}"))
}

fn read_scheduler(path: &Path) -> SchedulerData {
  match fs::read(path) {
    Ok(bytes) => match serde_json::from_slice::<SchedulerData>(&bytes) {
      Ok(mut data) => { data.fired_ids.truncate(MAX_FIRED_IDS); data },
      Err(e) => { eprintln!("Tarteel prayer scheduler settings are invalid: {e}"); SchedulerData::default() }
    },
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => SchedulerData::default(),
    Err(e) => { eprintln!("Tarteel prayer scheduler settings could not be read: {e}"); SchedulerData::default() }
  }
}

fn process_due(data: &mut SchedulerData, now_ms: i64) -> (Vec<PrayerEvent>, bool, bool) {
  let mut alarms = Vec::new();
  let mut changed = false;
  let fired: HashSet<String> = data.fired_ids.iter().cloned().collect();
  for event in &data.events {
    if event.at > now_ms || fired.contains(&event.id) { continue; }
    data.fired_ids.push(event.id.clone());
    changed = true;
    if now_ms.saturating_sub(event.at) <= LATE_ALARM_GRACE_MS { alarms.push(event.clone()); }
  }
  if data.fired_ids.len() > MAX_FIRED_IDS { let remove = data.fired_ids.len() - MAX_FIRED_IDS; data.fired_ids.drain(0..remove); changed = true; }
  let sleep_due = data.sleep_deadline_ms.is_some_and(|deadline| now_ms >= deadline);
  if sleep_due { data.sleep_deadline_ms = None; changed = true; }
  (alarms, sleep_due, changed)
}

#[tauri::command]
fn set_prayer_schedule(scheduler: State<PrayerScheduler>, events: Vec<PrayerEvent>) -> Result<(), String> {
  if events.len() > 500 { return Err("رفضت الجدولة أكثر من 500 موعد في تحديث واحد".into()); }
  let mut unique = HashSet::new();
  if events.iter().any(|event| event.id.trim().is_empty() || event.name.trim().is_empty() || !unique.insert(event.id.clone())) {
    return Err("رفضت جدولة موعد ناقص أو مكرر المعرّف".into());
  }
  let mut ordered = events;
  ordered.sort_by_key(|event| event.at);
  let mut data = scheduler.data.lock().map_err(|_| "تعذر قفل حالة جدولة الصلاة".to_string())?;
  data.events = ordered;
  write_scheduler(&scheduler.path, &data)
}

#[tauri::command]
fn set_sleep_deadline(scheduler: State<PrayerScheduler>, deadline_ms: Option<i64>) -> Result<(), String> {
  let mut data = scheduler.data.lock().map_err(|_| "تعذر قفل حالة مؤقت النوم".to_string())?;
  data.sleep_deadline_ms = deadline_ms.filter(|deadline| *deadline > 0);
  write_scheduler(&scheduler.path, &data)
}

fn start_prayer_scheduler(app: tauri::AppHandle, data: Arc<Mutex<SchedulerData>>, path: PathBuf) {
  let result = thread::Builder::new().name("tarteel-prayer-scheduler".into()).spawn(move || loop {
    thread::sleep(Duration::from_millis(250));
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(i64::MAX as u128) as i64;
    let (alarms, sleep_due, changed) = match data.lock() {
      Ok(mut state) => process_due(&mut state, now_ms),
      Err(e) => { eprintln!("Tarteel prayer scheduler lock failed: {e}"); continue; }
    };
    if changed {
      if let Ok(state) = data.lock() {
        if let Err(e) = write_scheduler(&path, &state) { eprintln!("Tarteel prayer scheduler persistence failed: {e}"); }
      }
    }
    for event in alarms {
      let notification_error = app.notification().builder()
        .title(format!("حان وقت صلاة {}", event.name))
        .body(format!("حان موعد صلاة {} وفق الموقع وطريقة الحساب المحددين في تَرتيل.", event.name))
        .show()
        .err()
        .map(|e| { eprintln!("Tarteel native prayer notification failed: {e}"); e.to_string() });
      let payload = AdhanPayload { id: event.id, name: event.name, at: event.at, notification_error };
      if let Err(e) = app.emit("prayer-adhan", payload) { eprintln!("Tarteel prayer event delivery failed: {e}"); }
    }
    if sleep_due {
      if let Err(e) = app.emit("sleep-deadline", ()) { eprintln!("Tarteel sleep timer event delivery failed: {e}"); }
    }
  });
  if let Err(e) = result { eprintln!("Tarteel prayer scheduler failed to start: {e}"); }
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

#[tauri::command]
fn resize_island(app: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
  let widths = [64.0, 144.0, 384.0, 440.0, 444.0, 480.0];
  let heights = [34.0, 92.0, 188.0, 210.0, 262.0, 424.0];
  let tools_height = width == 480.0 && (220.0..=430.0).contains(&height) && height.fract() == 0.0;
  if !widths.contains(&width) || (!heights.contains(&height) && !tools_height) { return Err("رفضت أبعادًا غير معتمدة لنافذة الجزيرة".into()); }
  let island = app.get_webview_window("island").ok_or_else(|| "نافذة الجزيرة غير متاحة".to_string())?;
  island.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height))).map_err(|e| format!("تعذر تغيير حجم نافذة الجزيرة: {e}"))?;
  let monitor = island.current_monitor().map_err(|e| format!("تعذر تحديد شاشة الجزيرة: {e}"))?
    .or(island.primary_monitor().map_err(|e| format!("تعذر تحديد الشاشة الرئيسية: {e}"))?)
    .ok_or_else(|| "لم يُرجع Windows شاشة صالحة لتمركز الجزيرة".to_string())?;
  let area = monitor.size();
  let origin = monitor.position();
  let window_size = island.inner_size().map_err(|e| format!("تعذر قراءة حجم نافذة الجزيرة: {e}"))?;
  let scale = island.scale_factor().map_err(|e| format!("تعذر قراءة مقياس الشاشة: {e}"))?;
  let x = origin.x + ((area.width as i64 - window_size.width as i64) / 2) as i32;
  let y = origin.y + (10.0 * scale).round() as i32;
  island.set_position(PhysicalPosition::new(x, y)).map_err(|e| format!("تعذر إعادة تمركز نافذة الجزيرة: {e}"))?;
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let server = start_audio_server().expect("error while starting local audio server");
  tauri::Builder::default()
    .manage(server)
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_geolocation::init())
    .plugin(tauri_plugin_notification::init())
    .setup(|app| {
      let island = WebviewWindowBuilder::new(app, "island", WebviewUrl::App("island.html".into()))
        .title("تَرتيل")
        .inner_size(480.0, 262.0)
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
      let window_size = island.inner_size()?;
      let scale = island.scale_factor()?;
      let x = origin.x + ((area.width as i64 - window_size.width as i64) / 2) as i32;
      let y = origin.y + (10.0 * scale).round() as i32;
      island.set_position(PhysicalPosition::new(x, y))?;
      island.show()?;
      let scheduler_path = app.path().app_config_dir()?.join("prayer-scheduler.json");
      let scheduler_data = Arc::new(Mutex::new(read_scheduler(&scheduler_path)));
      app.manage(PrayerScheduler { data: scheduler_data.clone(), path: scheduler_path.clone() });
      start_prayer_scheduler(app.handle().clone(), scheduler_data, scheduler_path);
      Ok(())
    })
    .on_window_event(|window, event| {
      if window.label() == "main" && matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
        if let Some(island) = window.app_handle().get_webview_window("island") {
          let _ = island.destroy();
        }
      }
    })
    .invoke_handler(tauri::generate_handler![scan_directory, set_audio_root, audio_url, resize_island, set_prayer_schedule, set_sleep_deadline])
    .run(tauri::generate_context!())
    .expect("error while running Tauri application");
}

#[cfg(test)]
mod prayer_scheduler_tests {
  use super::*;

  #[test]
  fn prayer_alarm_is_emitted_once_and_only_in_the_late_grace_period() {
    let mut state = SchedulerData { events: vec![PrayerEvent { id: "date|fajr".into(), name: "الفجر".into(), at: 1_000 }], ..Default::default() };
    let (first, sleep_due, changed) = process_due(&mut state, 1_000);
    assert_eq!(first.len(), 1);
    assert!(!sleep_due);
    assert!(changed);
    let (second, _, _) = process_due(&mut state, 1_001);
    assert!(second.is_empty());

    let mut stale = SchedulerData { events: vec![PrayerEvent { id: "old|asr".into(), name: "العصر".into(), at: 1_000 }], ..Default::default() };
    let (late, _, _) = process_due(&mut stale, 1_000 + LATE_ALARM_GRACE_MS + 1);
    assert!(late.is_empty());
    assert_eq!(stale.fired_ids, vec!["old|asr"]);
  }

  #[test]
  fn sleep_deadline_is_cleared_and_fired_only_once() {
    let mut state = SchedulerData { sleep_deadline_ms: Some(5_000), ..Default::default() };
    let (_, due, changed) = process_due(&mut state, 4_999);
    assert!(!due);
    assert!(!changed);
    let (_, due, changed) = process_due(&mut state, 5_000);
    assert!(due);
    assert!(changed);
    assert_eq!(state.sleep_deadline_ms, None);
    let (_, due, _) = process_due(&mut state, 5_001);
    assert!(!due);
  }
}
