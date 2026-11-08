use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::geometry::Rect;

const LOG_NAME: &str = "island-geometry.jsonl";
const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;
static LOG_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Serialize)]
struct PointPx { x: f64, y: f64 }
#[derive(Debug, Serialize, Clone, Copy)]
struct PointErrorPx { x: f64, y: f64 }
#[derive(Debug, Serialize)]
struct SizePx { width: u32, height: u32 }

#[derive(Debug, Serialize)]
struct PreAlignment {
  window_rect_outer: Rect,
  capsule_rect_screen: Option<Rect>,
  capsule_center_error_from_anchor_px: Option<PointErrorPx>,
  client_origin_error_from_target_px: PointErrorPx,
}

#[derive(Debug, Serialize)]
struct Snapshot {
  schema: u32,
  timestamp_unix_ms: u128,
  coordinate_unit: &'static str,
  window_handle: isize,
  state: String,
  scale_factor: f64,
  native_dpi: Option<u32>,
  monitor_rc_monitor: Rect,
  monitor_rc_work: Rect,
  capsule_anchor_center_screen: PointPx,
  window_rect_outer: Rect,
  client_origin_screen: PointPx,
  client_size: SizePx,
  capsule_rect_client: Option<Rect>,
  capsule_rect_screen: Option<Rect>,
  capsule_center_error_from_anchor_px: Option<PointErrorPx>,
  client_origin_error_from_target_px: PointErrorPx,
  pre_alignment: Option<PreAlignment>,
  correction_attempts: u8,
  aligned_within_half_pixel: Option<bool>,
  motion_top_min_screen_css_px: Option<f64>,
  motion_top_max_screen_css_px: Option<f64>,
  motion_sample_count: u32,
}

fn now_ms() -> u128 {
  SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
}

fn log_path(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app.path().app_config_dir().map_err(|e| format!("تعذر تحديد مجلد بيانات التطبيق: {e}"))?;
  fs::create_dir_all(&dir).map_err(|e| format!("تعذر إنشاء مجلد بيانات التشخيص: {e}"))?;
  Ok(dir.join(LOG_NAME))
}

fn append_record(app: &AppHandle, snapshot: &Snapshot) -> Result<PathBuf, String> {
  let _guard = LOG_MUTEX.lock().map_err(|_| "قفل سجل قياسات الجزيرة تالف".to_string())?;
  let path = log_path(app)?;
  if fs::metadata(&path).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false) {
    let previous = path.with_file_name("island-geometry.previous.jsonl");
    let _ = fs::remove_file(&previous);
    fs::rename(&path, previous).map_err(|e| format!("تعذر تدوير ملف القياس: {e}"))?;
  }
  let mut file = OpenOptions::new().create(true).append(true).open(&path)
    .map_err(|e| format!("تعذر فتح ملف قياس الجزيرة: {e}"))?;
  serde_json::to_writer(&mut file, snapshot).map_err(|e| format!("تعذر ترميز قياس الجزيرة: {e}"))?;
  file.write_all(b"\n").and_then(|_| file.flush()).map_err(|e| format!("تعذر حفظ قياس الجزيرة: {e}"))?;
  Ok(path)
}

/// يسجل قياس الإقلاع قبل أن تبلغ صفحة الجزيرة عن مستطيل الكبسولة.
pub fn record_startup(app: &AppHandle) -> Result<(), String> {
  #[cfg(windows)]
  {
    let island = app.get_webview_window("island").ok_or_else(|| "نافذة الجزيرة غير متاحة عند تسجيل الإقلاع".to_string())?;
    let scale = island.scale_factor().map_err(|e| format!("تعذر قراءة مقياس الجزيرة: {e}"))?;
    let hwnd = island.hwnd().map_err(|e| format!("تعذر قراءة مقبض الجزيرة: {e}"))?;
    let anchor_offset = crate::geometry::compact_anchor_offset_px(scale);
    let snapshot = unsafe { measure(hwnd, scale, anchor_offset, "startup".to_string(), None, 0)? };
    append_record(app, &snapshot)?;
    Ok(())
  }
  #[cfg(not(windows))]
  { let _ = app; Ok(()) }
}

/// يصحح موضع النافذة من قياس Win32، ثم يحفظ مستطيلات الشاشة والنافذة والكبسولة.
#[tauri::command]
pub async fn record_island_geometry(
  app: AppHandle,
  state: String,
  x: f64,
  y: f64,
  width: f64,
  height: f64,
  hit_x: f64,
  hit_y: f64,
  hit_width: f64,
  hit_height: f64,
  compact_anchor_offset: f64,
  motion_top_min: Option<f64>,
  motion_top_max: Option<f64>,
  motion_samples: u32,
) -> Result<serde_json::Value, String> {
  if !["idle", "compact", "full", "prayer", "tools", "alert"].contains(&state.as_str()) {
    return Err("حالة الجزيرة المرسلة غير معروفة".into());
  }
  if ![x, y, width, height, hit_x, hit_y, hit_width, hit_height, compact_anchor_offset].iter().all(|v| v.is_finite()) || x < 0.0 || y < 0.0 || width <= 0.0 || height <= 0.0 || width > 1000.0 || height > 1000.0 || hit_x < 0.0 || hit_y < 0.0 || hit_width <= 0.0 || hit_height <= 0.0 || hit_width > 1000.0 || hit_height > 1000.0 || !(1.0..=200.0).contains(&compact_anchor_offset) {
    return Err("مستطيل الكبسولة المرسل غير صالح".into());
  }
  if motion_samples > 120 || ![motion_top_min, motion_top_max].into_iter().flatten().all(|value| value.is_finite()) {
    return Err("قياسات حركة الجزيرة غير صالحة".into());
  }
  match (motion_top_min, motion_top_max) {
    (Some(min), Some(max)) if min <= max && motion_samples > 0 => {},
    (None, None) if motion_samples == 0 => {},
    _ => return Err("مجال حركة الجزيرة لا يطابق عدد العينات".into()),
  }

  #[cfg(windows)]
  {
    let island = app.get_webview_window("island").ok_or_else(|| "نافذة الجزيرة غير متاحة".to_string())?;
    let scale = island.scale_factor().map_err(|e| format!("تعذر قراءة مقياس الجزيرة: {e}"))?;
    let left = (x * scale).round() as i32;
    let top = (y * scale).round() as i32;
    let local = Rect { left, top, right: ((x + width) * scale).round() as i32, bottom: ((y + height) * scale).round() as i32 };
    let hit_left = (hit_x * scale).round() as i32;
    let hit_top = (hit_y * scale).round() as i32;
    let interactive = Rect { left: hit_left, top: hit_top, right: ((hit_x + hit_width) * scale).round() as i32, bottom: ((hit_y + hit_height) * scale).round() as i32 };
    if local.width() <= 0 || local.height() <= 0 {
      return Err("أصبح مستطيل الكبسولة فارغًا بعد التحويل إلى البكسل الفيزيائي".into());
    }
    if interactive.width() <= 0 || interactive.height() <= 0 {
      return Err("أصبح مستطيل النقر فارغًا بعد التحويل إلى البكسل الفيزيائي".into());
    }
    let hwnd = island.hwnd().map_err(|e| format!("تعذر قراءة مقبض الجزيرة: {e}"))?;
    let raw_hwnd = hwnd.0 as isize;
    let state_for_main = state.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    island.run_on_main_thread(move || {
      let hwnd = windows::Win32::Foundation::HWND(raw_hwnd as *mut core::ffi::c_void);
      let result = unsafe { align_and_measure(hwnd, scale, compact_anchor_offset * scale, state_for_main, Some(local)) };
      let _ = tx.send(result);
    }).map_err(|e| format!("تعذر جدولة قياس الجزيرة على خيط النافذة: {e}"))?;
    let mut snapshot = tauri::async_runtime::spawn_blocking(move || rx.recv())
      .await.map_err(|e| format!("تعذر انتظار قياس الجزيرة: {e}"))?
      .map_err(|e| format!("انقطع قياس الجزيرة قبل اكتماله: {e}"))??;
    snapshot.motion_top_min_screen_css_px = motion_top_min;
    snapshot.motion_top_max_screen_css_px = motion_top_max;
    snapshot.motion_sample_count = motion_samples;
    append_record(&app, &snapshot)?;
    if snapshot.aligned_within_half_pixel == Some(false) {
      eprintln!("Tarteel island geometry remains outside the 0.5 physical-pixel target after three corrections");
    }
    return serde_json::to_value(snapshot).map_err(|e| format!("تعذر تجهيز نتيجة قياس الجزيرة: {e}"));
  }

  #[cfg(not(windows))]
  { let _ = (app, state, x, y, width, height, hit_x, hit_y, hit_width, hit_height, compact_anchor_offset, motion_top_min, motion_top_max, motion_samples); Ok(serde_json::json!({"supported": false, "reason": "قياس هندسة نافذة Windows غير متاح على هذا النظام"})) }
}

#[cfg(windows)]
unsafe fn measure(
  hwnd: windows::Win32::Foundation::HWND,
  scale: f64,
  anchor_offset_y_px: f64,
  state: String,
  capsule_local: Option<Rect>,
  attempts: u8,
) -> Result<Snapshot, String> {
  use std::mem::size_of;
  use windows::Win32::Foundation::{POINT, RECT};
  use windows::Win32::Graphics::Gdi::{ClientToScreen, GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
  use windows::Win32::UI::HiDpi::GetDpiForWindow;
  use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, GetWindowRect};

  let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
  if monitor.0.is_null() { return Err("لم يُرجع Windows شاشة قريبة لنافذة الجزيرة".into()); }
  let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
  if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
    return Err(format!("تعذر قراءة rcMonitor/rcWork: {}", windows::core::Error::from_thread()));
  }
  let monitor_rect = Rect { left: info.rcMonitor.left, top: info.rcMonitor.top, right: info.rcMonitor.right, bottom: info.rcMonitor.bottom };
  let work_rect = Rect { left: info.rcWork.left, top: info.rcWork.top, right: info.rcWork.right, bottom: info.rcWork.bottom };

  let mut outer = RECT::default();
  unsafe { GetWindowRect(hwnd, &mut outer) }.map_err(|e| format!("تعذر قراءة مستطيل نافذة الجزيرة: {e}"))?;
  let mut client = RECT::default();
  unsafe { GetClientRect(hwnd, &mut client) }.map_err(|e| format!("تعذر قراءة مساحة عميل الجزيرة: {e}"))?;
  let mut origin = POINT { x: 0, y: 0 };
  if !unsafe { ClientToScreen(hwnd, &mut origin) }.as_bool() {
    return Err(format!("تعذر تحويل أصل WebView إلى إحداثيات الشاشة: {}", windows::core::Error::from_thread()));
  }
  let client_size = SizePx { width: (client.right - client.left).max(0) as u32, height: (client.bottom - client.top).max(0) as u32 };
  let client_origin = PointPx { x: origin.x as f64, y: origin.y as f64 };
  let capsule_screen = capsule_local.map(|r| Rect { left: origin.x + r.left, top: origin.y + r.top, right: origin.x + r.right, bottom: origin.y + r.bottom });
  let anchor_center_x = (monitor_rect.left as f64 + monitor_rect.right as f64) / 2.0;
  let anchor_center_y = monitor_rect.top as f64 + anchor_offset_y_px;
  let capsule_error = capsule_screen.map(|r| PointErrorPx {
    x: (r.left as f64 + r.right as f64) / 2.0 - anchor_center_x,
    y: (r.top as f64 + r.bottom as f64) / 2.0 - anchor_center_y,
  });
  let monitor_center_x = (monitor_rect.left as f64 + monitor_rect.right as f64) / 2.0;
  let target_client_x = monitor_center_x - client_size.width as f64 / 2.0;
  let target_client_y = monitor_rect.top as f64;
  let origin_error = PointErrorPx { x: origin.x as f64 - target_client_x, y: origin.y as f64 - target_client_y };
  let native_dpi = match unsafe { GetDpiForWindow(hwnd) } { 0 => None, dpi => Some(dpi) };
  Ok(Snapshot {
    schema: 4,
    timestamp_unix_ms: now_ms(),
    coordinate_unit: "physical virtual-desktop pixels",
    window_handle: hwnd.0 as isize,
    state,
    scale_factor: scale,
    native_dpi,
    monitor_rc_monitor: monitor_rect,
    monitor_rc_work: work_rect,
    capsule_anchor_center_screen: PointPx { x: anchor_center_x, y: anchor_center_y },
    window_rect_outer: Rect { left: outer.left, top: outer.top, right: outer.right, bottom: outer.bottom },
    client_origin_screen: client_origin,
    client_size,
    capsule_rect_client: capsule_local,
    capsule_rect_screen: capsule_screen,
    capsule_center_error_from_anchor_px: capsule_error,
    client_origin_error_from_target_px: origin_error,
    pre_alignment: None,
    correction_attempts: attempts,
    aligned_within_half_pixel: None,
    motion_top_min_screen_css_px: None,
    motion_top_max_screen_css_px: None,
    motion_sample_count: 0,
  })
}

#[cfg(windows)]
unsafe fn align_and_measure(
  hwnd: windows::Win32::Foundation::HWND,
  scale: f64,
  anchor_offset_y_px: f64,
  state: String,
  capsule_local: Option<Rect>,
) -> Result<Snapshot, String> {
  use windows::Win32::Foundation::RECT;
  use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER};

  let collapsed = matches!(state.as_str(), "idle" | "compact");
  let pre = unsafe { measure(hwnd, scale, anchor_offset_y_px, state.clone(), capsule_local, 0)? };
  let mut corrections = 0u8;
  for _ in 0..3 {
    let before = unsafe { measure(hwnd, scale, anchor_offset_y_px, state.clone(), capsule_local, corrections)? };
    let (dx, dy) = if collapsed {
      let error = before.capsule_center_error_from_anchor_px.ok_or_else(|| "لم تصل حدود الكبسولة إلى مسجل الهندسة".to_string())?;
      (-error.x, -error.y)
    } else {
      (-before.client_origin_error_from_target_px.x, -before.client_origin_error_from_target_px.y)
    };
    if dx.abs() <= 0.5 && dy.abs() <= 0.5 { break; }
    let move_x = dx.round() as i32;
    let move_y = dy.round() as i32;
    if move_x == 0 && move_y == 0 { break; }
    let mut outer = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut outer) }.map_err(|e| format!("تعذر إعادة قياس النافذة قبل التصحيح: {e}"))?;
    unsafe { SetWindowPos(hwnd, None, outer.left + move_x, outer.top + move_y, 0, 0, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE) }
      .map_err(|e| format!("تعذر تصحيح موضع نافذة الجزيرة: {e}"))?;
    corrections += 1;
  }

  let mut final_snapshot = unsafe { measure(hwnd, scale, anchor_offset_y_px, state, capsule_local, corrections)? };
  final_snapshot.pre_alignment = Some(PreAlignment {
    window_rect_outer: pre.window_rect_outer,
    capsule_rect_screen: pre.capsule_rect_screen,
    capsule_center_error_from_anchor_px: pre.capsule_center_error_from_anchor_px,
    client_origin_error_from_target_px: pre.client_origin_error_from_target_px,
  });
  let aligned = if collapsed {
    final_snapshot.capsule_center_error_from_anchor_px.is_some_and(|e| e.x.abs() <= 0.5 && e.y.abs() <= 0.5)
  } else {
    final_snapshot.client_origin_error_from_target_px.x.abs() <= 0.5 && final_snapshot.client_origin_error_from_target_px.y.abs() <= 0.5
  };
  final_snapshot.aligned_within_half_pixel = Some(aligned);
  Ok(final_snapshot)
}

/// Exports a copy to Downloads and selects it in Explorer when invoked from the tray.
pub fn export_from_tray(app: &AppHandle) {
  match export_copy(app) {
    Ok(path) => {
      #[cfg(windows)]
      if let Err(error) = std::process::Command::new("explorer.exe").arg(format!("/select,{}", path.display())).spawn() {
        eprintln!("Tarteel island diagnostic copied to {} but Explorer could not open it: {error}", path.display());
      }
      #[cfg(not(windows))]
      eprintln!("Tarteel island diagnostic copied to {}", path.display());
    }
    Err(error) => eprintln!("Tarteel island diagnostic export failed: {error}"),
  }
}

fn export_copy(app: &AppHandle) -> Result<PathBuf, String> {
  let source = log_path(app)?;
  if !source.is_file() { return Err("لم يُنشأ ملف القياس بعد؛ أعد فتح الجزيرة ثم حاول مرة أخرى".into()); }
  let destination_dir = app.path().download_dir().unwrap_or_else(|_| source.parent().unwrap_or(Path::new(".")).to_path_buf());
  fs::create_dir_all(&destination_dir).map_err(|e| format!("تعذر تجهيز مجلد التنزيلات: {e}"))?;
  let destination = destination_dir.join(format!("Tarteel-island-geometry-{}.jsonl", now_ms()));
  fs::copy(&source, &destination).map_err(|e| format!("تعذر نسخ ملف القياس إلى التنزيلات: {e}"))?;
  Ok(destination)
}
