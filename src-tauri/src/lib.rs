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
use tauri::{Emitter, Listener, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;
use walkdir::WalkDir;

mod alarm;
mod task_scheduler;
use audio::AudioEngine;
mod audio;
mod frame;
mod geometry;
mod hittest;
mod island_diagnostics;
mod tray;
#[cfg(windows)]
mod toast;

#[derive(Serialize, Clone)]
pub struct Track { pub path: String, pub file_name: String, pub title: String, pub artist: String, pub duration: Option<u64>, pub cover: Option<String> }

fn supported(p: &Path) -> bool { matches!(p.extension().and_then(|x| x.to_str()).map(|x| x.to_ascii_lowercase()).as_deref(), Some("mp3"|"m4a"|"mp4"|"flac"|"ogg"|"oga"|"wav"|"webm")) }

#[derive(Clone)]
struct AudioServer { root: Arc<RwLock<Option<PathBuf>>>, token: String, port: u16 }

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

/* ================================================================== *
 * منظومة التنبيهات — الأوامر وحلقة الإطلاق
 * ================================================================== */

/// حالة التنبيهات المشتركة بين الواجهة وحلقة الإطلاق.
struct AlarmHandle { state: alarm::SharedAlarm, path: PathBuf }

/// حدث حان وقته، يُرسل إلى الواجهة لتعرضه في الجزيرة.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AdhanPayload {
  id: String,
  key: String,
  name: String,
  at: i64,
  notification_error: Option<String>,
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
    .filter(|event| event.at > now_ms() && event.at <= horizon)
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

/// يُطلق تنبيهًا فورًا لأغراض الاختبار من الإعدادات.
#[tauri::command]
fn fire_alarm_now(app: tauri::AppHandle, handle: State<AlarmHandle>, key: Option<String>) -> Result<(), String> {
  let state = handle.state.lock().map_err(|_| "تعذر قفل حالة التنبيهات".to_string())?;
  let event = state.events.iter().find(|event| Some(&event.key) == key.as_ref())
    .or_else(|| state.events.iter().find(|event| event.at > now_ms()))
    .cloned();
  drop(state);
  if let Some(event) = event { deliver_alarm(&app, event); Ok(()) }
  else { Err("لا يوجد موعد لإرسال تنبيهٍ عنه".to_string()) }
}

/// اللحظة الحالية بالمللي ثانية. دالة واحدة تستخدمها كل المنظومة.
fn now_ms() -> i64 {
  SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default()
    .as_millis().min(i64::MAX as u128) as i64
}

/// يُرسل تنبيهًا واحدًا: إشعار ويندوز + حدث للواجهة.
/// فشل الإشعار لا يمنع الحدث، ونجاح الاثنين لا يكرر أيًا منهما.
fn deliver_alarm(app: &tauri::AppHandle, event: alarm::AlarmEvent) {
  let notification_error = app.notification().builder()
    .title(format!("حان وقت صلاة {}", event.name))
    .body(format!("حان موعد صلاة {} وفق موقعك وتوقيتك المحلي.", event.name))
    .show()
    .err()
    .map(|error| { eprintln!("Tarteel alarm notification failed: {error}"); error.to_string() });
  let payload = AdhanPayload {
    id: event.id, key: event.key, name: event.name, at: event.at, notification_error,
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
fn start_alarm_loop(app: tauri::AppHandle, state: alarm::SharedAlarm, path: PathBuf) {
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
    if tick_result.sleep_due {
      if let Err(error) = app.emit("sleep-deadline", ()) {
        eprintln!("Tarteel sleep timer event delivery failed: {error}");
      }
    }
  });
  if let Err(error) = spawned { eprintln!("Tarteel alarm loop failed to start: {error}"); }
}

/// الوضع الخفي: يُنفّذه مجدول مهام ويندوز عند موعد الأذان حين يكون التطبيق مغلقًا.
/// لا يفتح أي نافذة؛ يُطلق التنبيه ويلعب الصوت ثم يخرج.
fn run_headless_alarm(task_arg: &str) {
  let state_path = match std::env::var("APPDATA") {
    Ok(appdata) => PathBuf::from(appdata).join("com.tarteel.desktop").join("alarm-state.json"),
    Err(_) => { eprintln!("Tarteel headless alarm cannot resolve APPDATA"); return; }
  };
  let mut state = alarm::read_state(&state_path);
  let now = now_ms();
  let target = state.events.iter()
    .find(|event| task_scheduler::task_name_for(&event.id) == task_arg && !state.fired_ids.contains(&event.id))
    .cloned();
  let Some(event) = target else { return };
  if now - event.at > alarm::LATE_ALARM_GRACE_MS {
    /* متأخر جدًا: لا إزعاج. */
    state.fired_ids.push(event.id.clone());
    let _ = alarm::write_state(&state_path, &state);
    return;
  }
  state.fired_ids.push(event.id.clone());
  let _ = alarm::write_state(&state_path, &state);

  /* الإشعار عبر PowerShell/Toast غير متاح بلا سياق تطبيق، لذا نُشغّل التطبيق
     نفسه في وضع الأذان: يظهر ويُطلق المنبّه. هذا هو المسار الموثوق. */
  if let Ok(exe) = std::env::current_exe() {
    let _ = std::process::Command::new(exe)
      .arg("--adhan-ring")
      .arg(&event.id)
      .spawn();
  }
}

/* ------------------------------------------------------------------ *
 * منظومة الأذان: صوت أصلي في Rust + إشعار منبّه + كتم
 * ------------------------------------------------------------------ */

/// يضمن وجود ملف الأذان على القرص.
///
/// الملف مرفق بالحزمة كأصل (resource). في التشغيل التطويري لا يكون منسوخًا
/// بعد، فنبحث في مسار المصدر كاحتياط حتى لا يفشل «تجربة التنبيه».
fn resolve_adhan_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let candidates = [
    app.path().resolve("assets/adhan.wav", tauri::path::BaseDirectory::Resource).ok(),
    app.path().resolve("assets/adhan.wav", tauri::path::BaseDirectory::Resource).ok(),
    Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets").join("adhan.mp3")),
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
  engine.play(&key, &path, now_ms(), true)
}

#[tauri::command]
fn stop_adhan(engine: State<AudioEngine>) -> Result<(), String> {
  engine.stop();
  Ok(())
}

#[tauri::command]
fn set_adhan_volume(engine: State<AudioEngine>, volume: u32) -> Result<(), String> {
  engine.set_volume(volume);
  Ok(())
}

#[tauri::command]
fn set_adhan_muted(engine: State<AudioEngine>, muted: bool) -> Result<(), String> {
  engine.set_muted(muted);
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

/// يعرض إشعار منبّه ويندوز. فشله لا يُسقط الأذان الصوتي.
#[tauri::command]
#[cfg(windows)]
fn show_alarm_notification(title: String, body: String) -> Result<(), String> {
  toast::show_alarm_toast(&title, &body)
}

#[tauri::command]
#[cfg(not(windows))]
fn show_alarm_notification(_title: String, _body: String) -> Result<(), String> {
  Err("إشعارات المنبّه متاحة على ويندوز فقط".into())
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
fn resize_island(app: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
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

  let (left, top) = geometry::island_origin(origin.x, origin.y, area.width as i32, target_width as i32);
  let _ = (target_width, target_height, &area);

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

fn island_bounds_from_monitor(monitor_left: i32, monitor_top: i32, monitor_width: i32, scale: f64) -> (i32, i32, i32, i32) {
  let width = geometry::compact_window_width_px(scale);
  let height = geometry::compact_window_height_px(scale);
  let (x, y) = geometry::island_origin(monitor_left, monitor_top, monitor_width, width);
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
  tauri::Builder::default()
    /* نسخة واحدة فقط. بلا هذا السطر يفتح المستخدم التطبيق مرتين فيجد
       نسختين لكل نافذة، وتتضاعف الجزيرة. الترتيب مقصود: يجب أن يُسجَّل
       القفل قبل أي نافذة. النقر على الاختصار مجددًا يُظهر النافذة القائمة. */
    .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      if let Some(window) = app.get_webview_window("main") {
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
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_autostart::init(
      tauri_plugin_autostart::MacosLauncher::LaunchAgent,
      /* البدء مع ويندوز يمرّر --hidden ليبدأ مصغرًا في الصينية. */
      Some(vec!["--hidden"]),
    ))
    .setup(|app| {
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
      /* الحجم يُحدد هنا لا في الملف: النافذة كانت تُبنى بلا `inner_size`
         فتحصل على الحجم الافتراضي (~800×600)، فيصبح مركزها (400, 300) بدل
         (0, 0). وكل تغيير حجم لاحق يُبقى المركز ثابتًا، فتظهر الجزيرة في
         وسط الشاشة بدل أعلاها — وهو ما رآه المستخدم بالضبط.
         الآن تُولد بالحجم النهائي الصحيح منذ اللحظة الأولى. */
      let boot_size = island_boot_size_logical();
      let island = WebviewWindowBuilder::new(app, "island", WebviewUrl::App("island.html".into()))
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
      let (x, y, w, h) = island_bounds_from_monitor(origin.x, origin.y, area.width as i32, scale);
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
      let alarm_path = alarm::state_path(&app.path().app_config_dir()?);
      let alarm_state = Arc::new(Mutex::new(alarm::read_state(&alarm_path)));
      app.manage(AlarmHandle { state: alarm_state.clone(), path: alarm_path.clone() });
      start_alarm_loop(app.handle().clone(), alarm_state, alarm_path);

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
        if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } | tauri::WindowEvent::Focused(true)) {
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
      scan_directory, set_audio_root, audio_url, resize_island,
      set_alarm_schedule, set_sleep_deadline, sync_windows_tasks, clear_windows_tasks,
      alarm_status, fire_alarm_now,
      set_island_hit_rect, set_island_pass_through,
      island_diagnostics::record_island_geometry,
      play_adhan, stop_adhan, set_adhan_volume, set_adhan_muted, adhan_state,
      show_alarm_notification, set_next_prayer_label,
      is_autostart_enabled, set_autostart
    ])
    .run(tauri::generate_context!())
    .expect("error while running Tauri application");
}

#[cfg(test)]
mod island_tests {
  use super::*;

  #[test]
  fn island_bounds_are_derived_from_the_actual_monitor_origin() {
    for scale in [1.0, 1.25, 1.5] {
      let (x, y, w, h) = island_bounds_from_monitor(0, 0, 1920, scale);
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
      let (_, _, _, h) = island_bounds_from_monitor(0, 0, 1920, scale);
      assert_eq!(h, (42.0 * scale).round() as i32, "dpi {dpi}");
    }
  }

  #[test]
  fn a_second_monitor_is_centred_on_its_own_origin() {
    let (x, y, w, _) = island_bounds_from_monitor(1920, -1080, 1920, 1.25);
    assert_eq!(x, 1920 + (1920 - w) / 2);
    assert_eq!(y, -1080);
  }
}
