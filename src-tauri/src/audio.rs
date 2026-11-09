//! محرك صوت الأذان — مستقل عن نافذة التطبيق بالكامل.
//!
//! لماذا صوت في Rust لا في WebView؟
//! لو شُغّل الأذان في الصفحة لسكت متى خُفيت النافذة أو جُمّدت الصفحة (وهو
//! ما يحدث فعليًا عند الإخفاء إلى الصينية أو عند قفل الجهاز). `rodio` يملك
//! مسارًا صوتيًا أصليًا يعمل ما دامت العملية حيّة.
//!
//! حماية التكرار:
//!   • صوت واحد في المرة: تشغيل جديد يوقف السابق.
//!   • `last_played` يمنع تكرار الصلاة نفسها خلال نافذة حراسة.
//!   • الاستئناف من السكون لا يُعيد تشغيل ما مضى: الخلفية تتحقق من العمر.

use rodio::{OutputStream, OutputStreamHandle, Sink, Source};
use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder as SymphoniaDecoder, DecoderOptions};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// مستوى الصوت الافتراضي (0..=100).
pub const DEFAULT_VOLUME: u32 = 80;

/// أقل مدة بين تشغيلين لنفس المعرّف تُعدّ تكرارًا (2 دقيقة).
pub const REPEAT_GUARD_MS: i64 = 120_000;

/// مصدر متدفق لملف الأذان AAC داخل حاوية MP4.
/// نمرر `File` نفسه إلى Symphonia كي يعرف طول المصدر؛ غلاف Rodio العام يخفي
/// طول الملف، فيرفض قارئ MP4 عمليات seek اللازمة للوصول إلى مسار الصوت.
struct M4aAdhanSource {
  format: Box<dyn FormatReader>,
  decoder: Box<dyn SymphoniaDecoder>,
  track_id: u32,
  samples: Vec<f32>,
  position: usize,
  channels: u16,
  sample_rate: u32,
  total_duration: Option<Duration>,
  ended: bool,
}

impl M4aAdhanSource {
  fn open(path: &Path) -> Result<Self, String> {
    let file = File::open(path).map_err(|error| format!("تعذر فتح ملف الأذان: {error}"))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    hint.with_extension("m4a");
    let format_options = FormatOptions { enable_gapless: true, ..Default::default() };
    let probed = symphonia::default::get_probe()
      .format(&hint, stream, &format_options, &MetadataOptions::default())
      .map_err(|error| format!("تعذر فحص حاوية ملف الأذان: {error:?}"))?;
    let (track_id, codec_params) = {
      let track = probed.format.default_track()
        .ok_or_else(|| "لم يُعثر على مسار صوت في ملف الأذان".to_string())?;
      (track.id, track.codec_params.clone())
    };
    let total_duration = codec_params.time_base.zip(codec_params.n_frames)
      .map(|(time_base, frames)| Duration::from(time_base.calc_time(frames)));
    let decoder = symphonia::default::get_codecs()
      .make(&codec_params, &DecoderOptions::default())
      .map_err(|error| format!("تعذر تجهيز فك ترميز ملف الأذان: {error:?}"))?;
    let mut source = Self {
      format: probed.format,
      decoder,
      track_id,
      samples: Vec::new(),
      position: 0,
      channels: 0,
      sample_rate: 0,
      total_duration,
      ended: false,
    };
    if !source.fill_samples()? {
      return Err("ملف الأذان لا يحتوي عينات صوت قابلة للتشغيل".into());
    }
    Ok(source)
  }

  fn fill_samples(&mut self) -> Result<bool, String> {
    if self.ended { return Ok(false); }
    let mut decode_errors = 0;
    loop {
      let packet = match self.format.next_packet() {
        Ok(packet) => packet,
        Err(SymphoniaError::IoError(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
          self.ended = true;
          return Ok(false);
        }
        Err(error) => {
          self.ended = true;
          return Err(format!("تعذر قراءة ملف الأذان: {error:?}"));
        }
      };
      if packet.track_id() != self.track_id { continue; }
      let decoded = match self.decoder.decode(&packet) {
        Ok(decoded) => decoded,
        Err(SymphoniaError::DecodeError(_)) if decode_errors < 3 => {
          decode_errors += 1;
          continue;
        }
        Err(error) => {
          self.ended = true;
          return Err(format!("تعذر فك ترميز ملف الأذان: {error:?}"));
        }
      };
      let spec = decoded.spec().to_owned();
      self.channels = spec.channels.count() as u16;
      self.sample_rate = spec.rate;
      let mut samples = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
      samples.copy_interleaved_ref(decoded);
      self.samples.clear();
      self.samples.extend_from_slice(samples.samples());
      self.position = 0;
      if !self.samples.is_empty() { return Ok(true); }
    }
  }
}

impl Iterator for M4aAdhanSource {
  type Item = f32;

  fn next(&mut self) -> Option<Self::Item> {
    if self.position >= self.samples.len() {
      match self.fill_samples() {
        Ok(true) => {}
        Ok(false) => return None,
        Err(error) => {
          eprintln!("Tarteel adhan decode stopped: {error}");
          return None;
        }
      }
    }
    let sample = self.samples.get(self.position).copied();
    if sample.is_some() { self.position += 1; }
    sample
  }
}

impl Source for M4aAdhanSource {
  fn current_frame_len(&self) -> Option<usize> {
    let remaining = self.samples.len().saturating_sub(self.position);
    (remaining > 0).then_some(remaining)
  }

  fn channels(&self) -> u16 { self.channels }
  fn sample_rate(&self) -> u32 { self.sample_rate }
  fn total_duration(&self) -> Option<Duration> { self.total_duration }
}

/// حالة محرك الصوت المشتركة بين الخلفية والأوامر.
#[derive(Clone)]
pub struct AudioEngine {
  inner: Arc<AudioInner>,
}

/*
 * OutputStream في rodio ليس Send لأنه يملك مقبض جهاز الصوت الأصلي.
 * لكن تَرتيل لا يقرأ منه ولا يكتب فيه من خيوط أخرى — يُحفظ فقط ليبقى الجهاز
 * مفتوحًا. الوصول إليه محميّ بـ Mutex، والعمليات الفعلية (append/set_volume)
 * تمر عبر OutputStreamHandle وهو Send. لذلك الإرسال بين الخيوط آمن عمليًا.
 */
unsafe impl Send for AudioInner {}
unsafe impl Sync for AudioInner {}

struct AudioInner {
  /* `OutputStream` يجب أن يبقى حيًّا طوال العمر، وإلا انقطع الصوت فورًا. */
  stream: Mutex<Option<OutputStream>>,
  handle: Mutex<Option<Arc<OutputStreamHandle>>>,
  sink: Mutex<Option<Arc<Sink>>>,
  volume: AtomicU32,
  muted: AtomicBool,
  last_id: Mutex<Option<String>>,
  last_at: Mutex<i64>,
}

impl Default for AudioEngine {
  fn default() -> Self {
    Self::new()
  }
}

impl AudioEngine {
  pub fn new() -> Self {
    Self {
      inner: Arc::new(AudioInner {
        stream: Mutex::new(None),
        handle: Mutex::new(None),
        sink: Mutex::new(None),
        volume: AtomicU32::new(DEFAULT_VOLUME),
        muted: AtomicBool::new(false),
        last_id: Mutex::new(None),
        last_at: Mutex::new(0),
      }),
    }
  }

  /// يفتح جهاز الصوت عند أول حاجة (فتح متأخر يتجنّب احتكار الجهاز عند الإقلاع).
  fn ensure_device(&self) -> Result<Arc<OutputStreamHandle>, String> {
    let mut handle_slot = self.inner.handle.lock().map_err(|_| "قفل جهاز الصوت تالف")?;
    if let Some(handle) = handle_slot.as_ref() {
      return Ok(handle.clone());
    }
    let (stream, handle) = OutputStream::try_default()
      .map_err(|e| format!("تعذر فتح جهاز الصوت: {e}"))?;
    *self.inner.stream.lock().map_err(|_| "قفل مجرى الصوت تالف")? = Some(stream);
    let handle = Arc::new(handle);
    *handle_slot = Some(handle.clone());
    Ok(handle)
  }

  /// يضبط مستوى الصوت (0..=100).
  pub fn set_volume(&self, volume: u32) {
    let clamped = volume.min(100);
    self.inner.volume.store(clamped, Ordering::SeqCst);
    if let Ok(sink_slot) = self.inner.sink.lock() {
      if let Some(sink) = sink_slot.as_ref() {
        let _ = sink.set_volume(self.effective_volume());
      }
    }
  }

  /// يكتم أو يُلغي الكتم دون فقدان المستوى المختار.
  pub fn set_muted(&self, muted: bool) {
    self.inner.muted.store(muted, Ordering::SeqCst);
    if let Ok(sink_slot) = self.inner.sink.lock() {
      if let Some(sink) = sink_slot.as_ref() {
        let _ = sink.set_volume(self.effective_volume());
      }
    }
  }

  pub fn is_muted(&self) -> bool {
    self.inner.muted.load(Ordering::SeqCst)
  }

  pub fn volume(&self) -> u32 {
    self.inner.volume.load(Ordering::SeqCst)
  }

  fn effective_volume(&self) -> f32 {
    if self.is_muted() { 0.0 } else { self.volume() as f32 / 100.0 }
  }

  /// يوقف أي أذان جارٍ.
  pub fn stop(&self) {
    if let Ok(mut sink_slot) = self.inner.sink.lock() {
      if let Some(sink) = sink_slot.take() {
        sink.stop();
      }
    }
  }

  /// يشغّل ملف أذان.
  ///
  /// @param id معرّف الصلاة — يُستخدم لمنع التكرار
  /// @param path مسار الملف الصوتي على القرص
  /// @param now_ms اللحظة الحالية
  /// @param guard يمنع تكرار المعرّف نفسه (اختباريًا يمكن تعطيله)
  pub fn play(&self, id: &str, path: &std::path::Path, now_ms: i64, guard: bool) -> Result<(), String> {
    if guard {
      let last_id = self.inner.last_id.lock().map_err(|_| "قفل سجل التشغيل تالف")?;
      let last_at = *self.inner.last_at.lock().map_err(|_| "قفل سجل التشغيل تالف")?;
      if last_id.as_deref() == Some(id) && now_ms - last_at < REPEAT_GUARD_MS {
        /* نفس الصلاة خلال دقيقتين: تكرار من استئناف أو إعادة إدخال. */
        return Ok(());
      }
    }

    let source = M4aAdhanSource::open(path)?;

    self.stop();
    let handle = self.ensure_device()?;
    let sink = Sink::try_new(handle.as_ref()).map_err(|e| format!("تعذر إنشاء مسار الصوت: {e}"))?;
    sink.set_volume(self.effective_volume());
    sink.append(source);

    /*
     * Sink في rodio 0.20 يبدأ التشغيل فورًا بمجرد append، ويستمر ما دام
     * حيًّا. لا حاجة إلى detach: نخزّنه في الحالة فيبقى حيًّا حتى نستبدله
     * أو نوقفه. الإسقاط وحده هو ما يقطع الصوت.
     */
    *self.inner.sink.lock().map_err(|_| "قفل مسار الصوت تالف")? = Some(Arc::new(sink));
    *self.inner.last_id.lock().map_err(|_| "قفل سجل التشغيل تالف")? = Some(id.to_string());
    *self.inner.last_at.lock().map_err(|_| "قفل سجل التشغيل تالف")? = now_ms;
    Ok(())
  }

  /// هل الصوت يعمل الآن؟
  pub fn is_playing(&self) -> bool {
    self.inner.sink.lock().map(|slot| slot.as_ref().map(|s| !s.empty()).unwrap_or(false)).unwrap_or(false)
  }
}

/// هل يستحق هذا المعرّف تشغيلًا الآن؟ منطق خالص لاختبار الحراسة.
pub fn should_play(last_id: Option<&str>, last_at: i64, id: &str, now_ms: i64) -> bool {
  match last_id {
    Some(previous) if previous == id => now_ms - last_at >= REPEAT_GUARD_MS,
    _ => true,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn repeat_guard_blocks_the_same_prayer_within_two_minutes() {
    assert!(!should_play(Some("2026-11-01|fajr"), 1_000_000, "2026-11-01|fajr", 1_000_000 + 60_000));
  }

  #[test]
  fn repeat_guard_allows_the_same_prayer_after_the_window() {
    assert!(should_play(Some("2026-11-01|fajr"), 1_000_000, "2026-11-01|fajr", 1_000_000 + REPEAT_GUARD_MS));
  }

  #[test]
  fn repeat_guard_always_allows_a_different_prayer() {
    assert!(should_play(Some("2026-11-01|fajr"), 1_000_000, "2026-11-01|dhuhr", 1_000_001));
  }

  #[test]
  fn first_play_is_always_allowed() {
    assert!(should_play(None, 0, "2026-11-01|fajr", 5));
  }

  #[test]
  fn volume_is_clamped_and_mute_wins_over_volume() {
    let engine = AudioEngine::new();
    engine.set_volume(250);
    assert_eq!(engine.volume(), 100);
    assert_eq!(engine.effective_volume(), 1.0);
    engine.set_muted(true);
    assert_eq!(engine.effective_volume(), 0.0);
    engine.set_muted(false);
    assert_eq!(engine.effective_volume(), 1.0);
  }

  #[test]
  fn bundled_user_adhan_audio_decodes_with_the_expected_duration() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("assets")
      .join("adhan-call.mpeg");
    let mut source = M4aAdhanSource::open(&path).expect("the user's bundled adhan-call.mpeg must decode");
    let duration = source.total_duration.expect("duration metadata must be present");
    assert!((220..=235).contains(&duration.as_secs()), "unexpected bundled adhan duration: {duration:?}");
    let decoded_samples = source.by_ref().count();
    assert!(decoded_samples > 1_000_000, "the full adhan must decode, got {decoded_samples} samples");
  }

  #[test]
  fn missing_file_fails_without_panicking() {
    let engine = AudioEngine::new();
    assert!(engine.play("x", std::path::Path::new("no-such-file.mp3"), 0, false).is_err());
  }
}
