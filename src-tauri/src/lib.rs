use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use lofty::prelude::*;
use lofty::probe::Probe;
use tauri::webview::Color;
use tauri::{Manager, PhysicalPosition, State, WebviewUrl, WebviewWindowBuilder};
use walkdir::WalkDir;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let server = start_audio_server().expect("error while starting local audio server");
  tauri::Builder::default().manage(server).plugin(tauri_plugin_dialog::init()).setup(|app| {
    let main_window = app.get_webview_window("main").ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "main window not found"))?;
    let island = WebviewWindowBuilder::new(app, "island", WebviewUrl::App("island.html".into()))
      .parent(&main_window)?
      .title("تَرتيل")
      .inner_size(64.0, 34.0)
      .decorations(false)
      .transparent(true)
      .background_color(Color(0, 0, 0, 0))
      .shadow(false)
      .no_redirection_bitmap(true)
      .always_on_top(true)
      .focused(false)
      .skip_taskbar(true)
      .resizable(false)
      .visible(true)
      .build()?;
    if let Ok(Some(monitor)) = island.primary_monitor() {
      let origin = monitor.position();
      let area = monitor.size();
      let window_size = island.inner_size()?;
      let scale = island.scale_factor()?;
      let x = origin.x + ((area.width as i64 - window_size.width as i64) / 2) as i32;
      let y = origin.y + (10.0 * scale).round() as i32;
      island.set_position(PhysicalPosition::new(x, y))?;
    }
    Ok(())
  }).invoke_handler(tauri::generate_handler![scan_directory, set_audio_root, audio_url]).run(tauri::generate_context!()).expect("error while running Tauri application");
}
