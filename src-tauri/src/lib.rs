use serde::Serialize;
use std::path::{Path,PathBuf};
use walkdir::WalkDir;
use lofty::prelude::*;
use lofty::probe::Probe;
use base64::Engine;

#[derive(Serialize,Clone)]
pub struct Track { pub path:String, pub file_name:String, pub title:String, pub artist:String, pub duration:Option<u64>, pub cover:Option<String> }

fn supported(p:&Path)->bool { matches!(p.extension().and_then(|x|x.to_str()).map(|x|x.to_ascii_lowercase()).as_deref(),Some("mp3"|"m4a"|"mp4"|"aac"|"flac"|"ogg"|"oga"|"wav"|"webm")) }

#[tauri::command]
fn scan_directory(path:String)->Result<Vec<Track>,String>{
 let root=PathBuf::from(&path); if !root.is_dir(){return Err("المجلد غير موجود أو غير قابل للقراءة".into())}
 let mut out=Vec::new();
 for e in WalkDir::new(root).follow_links(false).into_iter().filter_map(Result::ok){
  let p=e.path(); if !e.file_type().is_file()||!supported(p){continue}
  let file_name=p.file_name().and_then(|s|s.to_str()).unwrap_or_default().to_string();
  let mut title=file_name.clone(); let mut artist=String::new(); let mut duration=None; let mut cover=None;
  if let Ok(tagged)=Probe::open(p).and_then(|x|x.read()){ if let Some(tag)=tagged.primary_tag().or_else(||tagged.first_tag()){
    if let Some(v)=tag.title(){if !v.is_empty(){title=v.to_string();}} if let Some(v)=tag.artist(){artist=v.to_string();}
    if let Some(pic)=tag.pictures().first(){ cover=Some(format!("data:{};base64,{}",pic.mime_type().map(|m|m.to_string()).unwrap_or_else(||"image/jpeg".into()),base64::Engine::encode(&base64::engine::general_purpose::STANDARD,pic.data()))); }
  } duration=Some(tagged.properties().duration().as_secs()); }
  out.push(Track{path:p.to_string_lossy().into_owned(),file_name,title,artist,duration,cover});
 }
 out.sort_by_key(|x|x.file_name.to_lowercase()); Ok(out)
}

#[tauri::command]
fn read_audio(path:String)->Result<Vec<u8>,String>{
 std::fs::read(path).map_err(|e|format!("تعذّرت قراءة الملف: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(){tauri::Builder::default().plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_fs::init()).invoke_handler(tauri::generate_handler![scan_directory,read_audio]).run(tauri::generate_context!()).expect("error while running Tauri application");}
