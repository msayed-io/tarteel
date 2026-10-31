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

mod alarm;
mod task_scheduler;

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

#[tauri::command]
fn resize_island(app: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
  let widths = [64.0, 144.0, 384.0, 440.0, 444.0, 480.0];
  let heights = [34.0, 92.0, 188.0, 210.0, 262.0, 424.0];
  let tools_height = width == 480.0 && (220.0..=430.0).contains(&height) && height.fract() == 0.0;
  if !widths.contains(&width) || (!heights.contains(&height) && !tools_height) { return Err("رفضت أبعادًا غير معتمدة لنافذة الجزيرة".into()); }
  let island = app.get_webview_window("island").ok_or_else(|| "نافذة الجزيرة غير متاحة".to_string())?;
  let monitor = island.current_monitor().map_err(|e| format!("تعذر تحديد شاشة الجزيرة: {e}"))?
    .or(island.primary_monitor().map_err(|e| format!("تعذر تحديد الشاشة الرئيسية: {e}"))?)
    .ok_or_else(|| "لم يُرجع Windows شاشة صالحة لتمركز الجزيرة".to_string())?;
  let area = monitor.size();
  let origin = monitor.position();
  let scale = island.scale_factor().map_err(|e| format!("تعذر قراءة مقياس الشاشة: {e}"))?;
  // Anchor the top-left corner at an integer physical site derived from the FINAL size.
  // Measuring the window right after a resize request returns the still in-flight value,
  // which centred the island one frame off and produced the visible jolt on every resize.
  let target_width = (width * scale).round() as u32;
  let target_height = (height * scale).round() as u32;
  let (left, top) = centered_island_origin((area.width, area.height), (origin.x, origin.y), (target_width, target_height), scale);
  let target = island.clone();
  island.run_on_main_thread(move || {
    if let Err(e) = apply_island_bounds(&target, left, top, target_width, target_height) {
      eprintln!("Tarteel island bounds could not be applied: {e}");
    }
  }).map_err(|e| format!("تعذر جدولة تغيير أبعاد الجزيرة على خيط الواجهة: {e}"))?;
  Ok(())
}

/// يحسب موضع الركن الأعلى الأيسر لنافذة متمركزة أفقيًا أعلى الشاشة.
/// يعيد إحداثيات فيزيائية صحيحة، ويُبقي الركن عددًا صحيحًا لتجنّب أي إزاحة
/// بكسر بكسل عند مقاييس العرض 125% و150%.
fn centered_island_origin(area: (u32, u32), origin: (i32, i32), size: (u32, u32), scale: f64) -> (i32, i32) {
  let x = origin.0 as i64 + ((area.0 as i64 - size.0 as i64) / 2);
  let y = origin.1 as i64 + (10.0 * scale).round() as i64;
  (x as i32, y as i32)
}

/// `SetWindowPos` changes position and size in a single call, so no frame ever sees one
/// applied without the other. It has window thread affinity, hence the main-thread hop.
fn apply_island_bounds(island: &tauri::WebviewWindow, left: i32, top: i32, width: u32, height: u32) -> Result<(), String> {
  apply_island_bounds_native(island, left, top, width, height)
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
      let scale = island.scale_factor()?;
      // Anchor from the requested logical size: inner_size() can still report the
      // in-flight value on a freshly built translucent window.
      let (x, y) = centered_island_origin(
        (area.width, area.height),
        (origin.x, origin.y),
        ((480.0 * scale).round() as u32, (262.0 * scale).round() as u32),
        scale,
      );
      island.set_position(PhysicalPosition::new(x, y))?;
      island.show()?;
      /* حالة التنبيهات: تُقرأ من القرص عند الإقلاع، فتبقى المعرّفات المُطلقة
         محفوظة عبر إعادة التشغيل ولا يتكرر أي أذان. */
      let alarm_path = alarm::state_path(&app.path().app_config_dir()?);
      let alarm_state = Arc::new(Mutex::new(alarm::read_state(&alarm_path)));
      app.manage(AlarmHandle { state: alarm_state.clone(), path: alarm_path.clone() });
      start_alarm_loop(app.handle().clone(), alarm_state, alarm_path);
      Ok(())
    })
    .on_window_event(|window, event| {
      if window.label() == "main" && matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
        if let Some(island) = window.app_handle().get_webview_window("island") {
          let _ = island.destroy();
        }
      }
    })
    .invoke_handler(tauri::generate_handler![
      scan_directory, set_audio_root, audio_url, resize_island,
      set_alarm_schedule, set_sleep_deadline, sync_windows_tasks, clear_windows_tasks,
      alarm_status, fire_alarm_now
    ])
    .run(tauri::generate_context!())
    .expect("error while running Tauri application");
}

#[cfg(test)]
mod island_tests {
  use super::*;

  #[test]
  fn island_anchor_keeps_the_corner_integral_and_centred_for_every_state() {
    let area = (1920u32, 1080u32);
    let origin = (0i32, 0i32);
    for (width, height) in [(64.0, 34.0), (144.0, 34.0), (384.0, 210.0), (444.0, 188.0), (480.0, 290.0), (440.0, 92.0)] {
      let (x, y) = centered_island_origin(area, origin, ((width as f64 * 1.0) as u32, (height as f64 * 1.0) as u32), 1.0);
      assert_eq!(y, 10, "the island top inset must not depend on the state");
      assert!(x >= 0);
    }
    // 125% scaling: the width rounds once, so the anchor stays whole and symmetric.
    let (x, y) = centered_island_origin(area, origin, ((480.0f64 * 1.25).round() as u32, (262.0f64 * 1.25).round() as u32), 1.25);
    assert_eq!((x, y), ((1920i64 - 600) as i32 / 2, 13));
  }
}
