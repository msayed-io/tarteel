//! مسار اختياري لتلاوات Rust الأصلية: Symphonia عبر Rodio، ثم HRTF/reverb قبل WASAPI.
//!
//! يظل مشغل HTML الحالي هو المسار الطبيعي الافتراضي. هذا المحرك يُفتح فقط عند
//! اختيار العمق المكاني أو محاكاة المسجد، ويعمل مستهلك المصدر على خيط خرج Rodio
//! المنفصل عن واجهة Tauri. لا توجد تخصيصات داخل `Iterator::next`.

#[path = "spatial_audio/hrtf.rs"]
mod hrtf;
use hrtf::HrtfRenderer;

use rodio::{OutputStream, OutputStreamHandle, Sink, Source};
use serde::Serialize;
use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder as CodecDecoder, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

const LIMIT: f32 = 0.98;
const SEEK_FADE_MS: u32 = 8;
const HRIR_TAIL_MS: u64 = 4;
const MOSQUE_TAIL_MS: u64 = 1_600;
const MAX_DELAY_MS: usize = 1_600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DspMode {
    Spatial,
    Mosque,
}

impl DspMode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "spatial" => Ok(Self::Spatial),
            "mosque" => Ok(Self::Mosque),
            _ => Err("وضع الصوت غير مدعوم في محرك Rust".into()),
        }
    }

    fn tail_duration(self) -> Duration {
        match self {
            Self::Spatial => Duration::from_millis(HRIR_TAIL_MS),
            Self::Mosque => Duration::from_millis(MOSQUE_TAIL_MS),
        }
    }
}

#[derive(Default)]
struct LevelSnapshot {
    rms_bits: AtomicU32,
    peak_bits: AtomicU32,
}

impl LevelSnapshot {
    fn read(&self) -> (f32, f32) {
        (
            f32::from_bits(self.rms_bits.load(Ordering::Relaxed)),
            f32::from_bits(self.peak_bits.load(Ordering::Relaxed)),
        )
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecitationStatus {
    pub playing: bool,
    pub paused: bool,
    pub ended: bool,
    pub position: f64,
    pub duration: f64,
    pub rms: f32,
    pub peak: f32,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct SpatialAudioEngine {
    inner: Arc<SpatialAudioInner>,
}

/* `OutputStream` is the native device lifetime guard and is only stored under
 * this mutex. Rodio's Sink owns the independently synchronized playback queue. */
unsafe impl Send for SpatialAudioInner {}
unsafe impl Sync for SpatialAudioInner {}

struct SpatialAudioInner {
    stream: Mutex<Option<OutputStream>>,
    handle: Mutex<Option<Arc<OutputStreamHandle>>>,
    playback: Mutex<Option<RecitationPlayback>>,
}

struct RecitationPlayback {
    sink: Sink,
    duration: Duration,
    levels: Arc<LevelSnapshot>,
    position_offset: Duration,
    error: Arc<Mutex<Option<String>>>,
}

impl Default for SpatialAudioEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl SpatialAudioEngine {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(SpatialAudioInner {
                stream: Mutex::new(None),
                handle: Mutex::new(None),
                playback: Mutex::new(None),
            }),
        }
    }

    fn ensure_handle(&self) -> Result<Arc<OutputStreamHandle>, String> {
        let mut handle_slot = self
            .inner
            .handle
            .lock()
            .map_err(|_| "قفل جهاز الصوت المكاني تالف")?;
        if let Some(handle) = handle_slot.as_ref() {
            return Ok(handle.clone());
        }
        /* CPAL يختار مخرج Windows الأصلي (WASAPI) ومخزن الإطارات الافتراضي الذي
        يعلنه الجهاز؛ تجنب فرض حجم ثابت يمنع عدم توافق المخزن أو التقطيع. الفتح
        مؤجل حتى طلب صوت مكاني كي لا يتدخل في المشغل الطبيعي أو الأذان. */
        let (stream, handle) = OutputStream::try_default()
            .map_err(|error| format!("تعذر فتح مخرج الصوت المكاني: {error}"))?;
        *self
            .inner
            .stream
            .lock()
            .map_err(|_| "قفل مجرى الصوت المكاني تالف")? = Some(stream);
        let handle = Arc::new(handle);
        *handle_slot = Some(handle.clone());
        Ok(handle)
    }

    pub fn play(
        &self,
        path: &Path,
        mode: DspMode,
        position: Duration,
        volume: u32,
        speed: f32,
        autoplay: bool,
    ) -> Result<RecitationStatus, String> {
        let mut decoder = SymphoniaSource::open(path)?;
        let source_duration = decoder.total_duration();
        let source_channels = decoder.channels();
        if source_channels == 0 {
            return Err("ملف التلاوة لا يحتوي قنوات صوتية قابلة للتشغيل".into());
        }
        if position > Duration::ZERO {
            decoder
                .try_seek(position)
                .map_err(|error| format!("تعذر الانتقال إلى موضع التلاوة المطلوب: {error:?}"))?;
        }
        let duration = source_duration
            .map(|value| value.saturating_add(mode.tail_duration()))
            .unwrap_or_else(|| mode.tail_duration());
        let levels = Arc::new(LevelSnapshot::default());
        let error = decoder.error.clone();
        let source = SpatialSource::new(decoder.convert_samples::<f32>(), mode, levels.clone())?;
        let handle = self.ensure_handle()?;
        let sink = Sink::try_new(handle.as_ref())
            .map_err(|error| format!("تعذر إنشاء مسار الصوت المكاني: {error}"))?;
        sink.set_volume(volume.min(100) as f32 / 100.0);
        sink.set_speed(normalize_speed(speed));
        self.stop();
        sink.append(source);
        if !autoplay {
            sink.pause();
        }
        *self
            .inner
            .playback
            .lock()
            .map_err(|_| "قفل تشغيل التلاوة المكانية تالف")? = Some(RecitationPlayback {
            sink,
            duration,
            levels,
            position_offset: position,
            error,
        });
        Ok(self.state())
    }

    pub fn pause(&self) -> Result<(), String> {
        let playback = self
            .inner
            .playback
            .lock()
            .map_err(|_| "قفل تشغيل التلاوة المكانية تالف")?;
        let playback = playback
            .as_ref()
            .ok_or_else(|| "لا توجد تلاوة مكانية نشطة".to_string())?;
        playback.sink.pause();
        Ok(())
    }

    pub fn resume(&self) -> Result<(), String> {
        let playback = self
            .inner
            .playback
            .lock()
            .map_err(|_| "قفل تشغيل التلاوة المكانية تالف")?;
        let playback = playback
            .as_ref()
            .ok_or_else(|| "لا توجد تلاوة مكانية نشطة".to_string())?;
        if playback.sink.empty() {
            return Err("انتهت التلاوة المكانية؛ أعد تشغيل المسار من البداية".into());
        }
        playback.sink.play();
        Ok(())
    }

    pub fn seek(&self, position: Duration) -> Result<(), String> {
        let mut playback = self
            .inner
            .playback
            .lock()
            .map_err(|_| "قفل تشغيل التلاوة المكانية تالف")?;
        let playback = playback
            .as_mut()
            .ok_or_else(|| "لا توجد تلاوة مكانية نشطة".to_string())?;
        if playback.sink.empty() {
            return Err("انتهت التلاوة المكانية".into());
        }
        playback
            .sink
            .try_seek(position)
            .map_err(|error| format!("تعذر البحث داخل التلاوة: {error:?}"))?;
        playback.position_offset = Duration::ZERO;
        Ok(())
    }

    pub fn set_volume(&self, volume: u32) -> Result<(), String> {
        let playback = self
            .inner
            .playback
            .lock()
            .map_err(|_| "قفل تشغيل التلاوة المكانية تالف")?;
        if let Some(playback) = playback.as_ref() {
            playback.sink.set_volume(volume.min(100) as f32 / 100.0);
        }
        Ok(())
    }

    pub fn set_speed(&self, speed: f32) -> Result<(), String> {
        let playback = self
            .inner
            .playback
            .lock()
            .map_err(|_| "قفل تشغيل التلاوة المكانية تالف")?;
        if let Some(playback) = playback.as_ref() {
            playback.sink.set_speed(normalize_speed(speed));
        }
        Ok(())
    }

    pub fn stop(&self) {
        if let Ok(mut playback) = self.inner.playback.lock() {
            if let Some(playback) = playback.take() {
                playback.sink.stop();
            }
        }
    }

    pub fn state(&self) -> RecitationStatus {
        let Ok(playback) = self.inner.playback.lock() else {
            return empty_status();
        };
        let Some(playback) = playback.as_ref() else {
            return empty_status();
        };
        let position = playback
            .position_offset
            .saturating_add(playback.sink.get_pos());
        let empty = playback.sink.empty();
        let paused = playback.sink.is_paused();
        let (rms, peak) = playback.levels.read();
        let duration = playback.duration.as_secs_f64();
        RecitationStatus {
            playing: !paused && !empty,
            paused: paused && !empty,
            ended: empty && !paused && duration > 0.0 && position > Duration::ZERO,
            position: position.as_secs_f64().min(duration),
            duration,
            rms,
            peak,
            error: playback.error.lock().ok().and_then(|error| error.clone()),
        }
    }
}

fn empty_status() -> RecitationStatus {
    RecitationStatus {
        playing: false,
        paused: false,
        ended: false,
        position: 0.0,
        duration: 0.0,
        rms: 0.0,
        peak: 0.0,
        error: None,
    }
}

fn normalize_speed(value: f32) -> f32 {
    if [0.75_f32, 1.0, 1.25, 1.5].contains(&value) {
        value
    } else {
        1.0
    }
}

const MAX_CONSECUTIVE_DECODE_ERRORS: usize = 3;

fn decode_failure_message(
    file_label: &str,
    codec_label: &str,
    packet_timestamp: u64,
    consecutive_errors: usize,
    decoder_error: &str,
) -> Option<String> {
    (consecutive_errors > MAX_CONSECUTIVE_DECODE_ERRORS).then(|| {
        format!(
            "الملف «{file_label}» يستخدم الترميز {codec_label}؛ فشل فك {consecutive_errors} حزم صوت متتالية عند الطابع الزمني {packet_timestamp}. آخر سبب من المفكك: {decoder_error}"
        )
    })
}

pub(crate) struct SymphoniaSource {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn CodecDecoder>,
    track_id: u32,
    file_label: String,
    codec_label: String,
    time_base: Option<symphonia::core::units::TimeBase>,
    sample_buffer: Option<SampleBuffer<f32>>,
    sample_cursor: usize,
    channels: u16,
    sample_rate: u32,
    duration: Option<Duration>,
    pending_seek: Option<Duration>,
    decode_errors: usize,
    error: Arc<Mutex<Option<String>>>,
    ended: bool,
}

impl SymphoniaSource {
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        let file_label = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("unknown file")
            .to_string();
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let file = File::open(path)
            .map_err(|error| format!("تعذر فتح ملف التلاوة «{file_label}»: {error}"))?;
        let mut hint = Hint::new();
        if !extension.is_empty() {
            hint.with_extension(&extension);
        }
        let stream = MediaSourceStream::new(Box::new(file), Default::default());
        let probed = symphonia::default::get_probe()
            .format(
                &hint,
                stream,
                &FormatOptions {
                    enable_gapless: true,
                    ..Default::default()
                },
                &MetadataOptions::default(),
            )
            .map_err(|error| {
                format!("تعذر قراءة حاوية التلاوة «{file_label}» (امتداد .{extension}): {error}")
            })?;
        let format = probed.format;
        let track = format
            .tracks()
            .iter()
            .find(|track| {
                let params = &track.codec_params;
                params.codec != CODEC_TYPE_NULL && params.sample_rate.is_some()
            })
            .ok_or_else(|| "ملف التلاوة لا يحتوي مسارًا صوتيًا مدعومًا".to_string())?;
        let track_id = track.id;
        let codec_label = format!("{:?}", track.codec_params.codec);
        let mut codec_params = track.codec_params.clone();
        if codec_params.channels.is_none() {
            codec_params.channels = codec_params
                .channel_layout
                .map(|layout| layout.into_channels());
        }
        let time_base = codec_params.time_base;
        let duration = time_base.zip(codec_params.n_frames).map(|(base, frames)| {
            let time = base.calc_time(frames);
            Duration::from_secs_f64(time.seconds as f64 + time.frac)
        });
        let channels = codec_params
            .channels
            .map(|channels| channels.count() as u16)
            .unwrap_or(2);
        let sample_rate = codec_params.sample_rate.unwrap_or(44_100);
        let mut codecs = symphonia::core::codecs::CodecRegistry::new();
        symphonia::default::register_enabled_codecs(&mut codecs);
        codecs.register_all::<symphonia_adapter_libopus::OpusDecoder>();
        let decoder = codecs
            .make(&codec_params, &DecoderOptions::default())
            .map_err(|error| {
                format!("تعذر تهيئة مفكك التلاوة «{file_label}» للترميز {codec_label}: {error}")
            })?;
        let mut source = Self {
            format,
            decoder,
            track_id,
            file_label,
            codec_label,
            time_base,
            sample_buffer: None,
            sample_cursor: 0,
            channels,
            sample_rate,
            duration,
            pending_seek: None,
            decode_errors: 0,
            error: Arc::new(Mutex::new(None)),
            ended: false,
        };
        if !source
            .read_next_packet()
            .map_err(|error| format!("تعذر فك ترميز التلاوة محليًا: {error}"))?
        {
            return Err(format!(
                "الملف «{}» لم ينتج أي عينات صوتية قابلة للتشغيل",
                source.file_label
            ));
        }
        Ok(source)
    }

    fn read_next_packet(&mut self) -> Result<bool, String> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(error))
                    if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    self.ended = true;
                    return Ok(false);
                }
                Err(SymphoniaError::IoError(error)) => {
                    return Err(format!(
                        "تعذر قراءة ملف التلاوة «{}»: {error}",
                        self.file_label
                    ))
                }
                Err(error) => {
                    return Err(format!(
                        "تعذرت قراءة حزمة من «{}»: {error}",
                        self.file_label
                    ))
                }
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            match self.decoder.decode(&packet) {
                Ok(decoded) => {
                    self.channels = decoded.spec().channels.count() as u16;
                    self.sample_rate = decoded.spec().rate;
                    let required = decoded.capacity().saturating_mul(self.channels as usize);
                    if self
                        .sample_buffer
                        .as_ref()
                        .map_or(true, |buffer| buffer.capacity() < required)
                    {
                        self.sample_buffer = Some(SampleBuffer::new(
                            decoded.capacity() as u64,
                            *decoded.spec(),
                        ));
                    }
                    let buffer = self
                        .sample_buffer
                        .as_mut()
                        .expect("sample buffer allocated");
                    buffer.copy_interleaved_ref(decoded);
                    self.sample_cursor = 0;
                    if let Some(target) = self.pending_seek {
                        if let Some(base) = self.time_base {
                            let start = base.calc_time(packet.ts);
                            let start_seconds = start.seconds as f64 + start.frac;
                            let delta = (target.as_secs_f64() - start_seconds).max(0.0);
                            let skip_frames = (delta * self.sample_rate as f64).ceil() as usize;
                            self.sample_cursor = skip_frames
                                .saturating_mul(self.channels as usize)
                                .min(buffer.len());
                            if self.sample_cursor == buffer.len() {
                                continue;
                            }
                        }
                        self.pending_seek = None;
                    }
                    self.decode_errors = 0;
                    self.ended = false;
                    return Ok(true);
                }
                Err(SymphoniaError::DecodeError(error)) => {
                    self.decode_errors += 1;
                    let decoder_error = error.to_string();
                    eprintln!(
                        "Tarteel spatial decode error: file={} codec={} packet_ts={} consecutive={} reason={}",
                        self.file_label, self.codec_label, packet.ts, self.decode_errors, decoder_error
                    );
                    if let Some(message) = decode_failure_message(
                        &self.file_label,
                        &self.codec_label,
                        packet.ts,
                        self.decode_errors,
                        &decoder_error,
                    ) {
                        if let Ok(mut failure) = self.error.lock() {
                            *failure = Some(message.clone());
                        }
                        return Err(message);
                    }
                }
                Err(error) => {
                    return Err(format!(
                        "تعذر فك حزمة التلاوة «{}» عند الطابع الزمني {} باستخدام {}: {error}",
                        self.file_label, packet.ts, self.codec_label
                    ))
                }
            }
        }
    }
}

impl Iterator for SymphoniaSource {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(buffer) = self.sample_buffer.as_ref() {
                if self.sample_cursor < buffer.len() {
                    let sample = buffer.samples()[self.sample_cursor];
                    self.sample_cursor += 1;
                    return Some(sample);
                }
            }
            if self.ended {
                return None;
            }
            match self.read_next_packet() {
                Ok(true) => {}
                Ok(false) => {
                    self.ended = true;
                    return None;
                }
                Err(error) => {
                    self.ended = true;
                    if let Ok(mut failure) = self.error.lock() {
                        *failure = Some(error);
                    }
                    return None;
                }
            }
        }
    }
}

impl Source for SymphoniaSource {
    fn current_frame_len(&self) -> Option<usize> {
        self.sample_buffer
            .as_ref()
            .map(|buffer| buffer.len().saturating_sub(self.sample_cursor))
    }

    fn channels(&self) -> u16 {
        self.channels
    }

    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn total_duration(&self) -> Option<Duration> {
        self.duration
    }

    fn try_seek(&mut self, position: Duration) -> Result<(), rodio::source::SeekError> {
        self.format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: position.as_secs_f64().into(),
                    track_id: Some(self.track_id),
                },
            )
            .map_err(|_| rodio::source::SeekError::NotSupported {
                underlying_source: "SymphoniaSource",
            })?;
        self.decoder.reset();
        if let Some(buffer) = self.sample_buffer.as_mut() {
            buffer.clear();
        }
        self.sample_cursor = 0;
        self.pending_seek = Some(position);
        self.decode_errors = 0;
        if let Ok(mut failure) = self.error.lock() {
            *failure = None;
        }
        self.ended = false;
        Ok(())
    }
}

#[derive(Clone, Copy)]
struct Reflection {
    delay_ms: f32,
    left: f32,
    right: f32,
    cross_left: f32,
    cross_right: f32,
}

const MOSQUE_REFLECTIONS: [Reflection; 13] = [
    Reflection {
        delay_ms: 18.0,
        left: 0.115,
        right: 0.080,
        cross_left: 0.0,
        cross_right: 0.0,
    },
    Reflection {
        delay_ms: 32.0,
        left: 0.055,
        right: 0.095,
        cross_left: 0.0,
        cross_right: 0.0,
    },
    Reflection {
        delay_ms: 49.0,
        left: 0.070,
        right: 0.045,
        cross_left: 0.025,
        cross_right: 0.010,
    },
    Reflection {
        delay_ms: 78.0,
        left: 0.042,
        right: 0.052,
        cross_left: 0.010,
        cross_right: 0.020,
    },
    Reflection {
        delay_ms: 112.0,
        left: 0.034,
        right: 0.028,
        cross_left: 0.018,
        cross_right: 0.012,
    },
    Reflection {
        delay_ms: 158.0,
        left: 0.026,
        right: 0.032,
        cross_left: 0.011,
        cross_right: 0.014,
    },
    Reflection {
        delay_ms: 224.0,
        left: 0.021,
        right: 0.018,
        cross_left: 0.012,
        cross_right: 0.009,
    },
    Reflection {
        delay_ms: 310.0,
        left: 0.016,
        right: 0.020,
        cross_left: 0.007,
        cross_right: 0.009,
    },
    Reflection {
        delay_ms: 430.0,
        left: 0.012,
        right: 0.010,
        cross_left: 0.007,
        cross_right: 0.005,
    },
    Reflection {
        delay_ms: 590.0,
        left: 0.008,
        right: 0.009,
        cross_left: 0.004,
        cross_right: 0.005,
    },
    Reflection {
        delay_ms: 790.0,
        left: 0.006,
        right: 0.005,
        cross_left: 0.003,
        cross_right: 0.002,
    },
    Reflection {
        delay_ms: 1_080.0,
        left: 0.003,
        right: 0.004,
        cross_left: 0.001,
        cross_right: 0.002,
    },
    Reflection {
        delay_ms: 1_420.0,
        left: 0.002,
        right: 0.002,
        cross_left: 0.001,
        cross_right: 0.001,
    },
];

struct DspProcessor {
    mode: DspMode,
    sample_rate: usize,
    hrtf: Option<HrtfRenderer>,
    left_delay: Vec<f32>,
    right_delay: Vec<f32>,
    delay_cursor: usize,
    reflection_taps: [(usize, Reflection); 13],
    level_count: usize,
    level_squares: f64,
    level_peak: f32,
    levels: Arc<LevelSnapshot>,
}

impl DspProcessor {
    fn new(mode: DspMode, sample_rate: u32, levels: Arc<LevelSnapshot>) -> Result<Self, String> {
        let rate = sample_rate as usize;
        let delay_len = rate
            .saturating_mul(MAX_DELAY_MS)
            .saturating_div(1_000)
            .saturating_add(2)
            .max(2);
        let hrtf = if mode == DspMode::Spatial {
            Some(HrtfRenderer::new(sample_rate)?)
        } else {
            None
        };
        Ok(Self {
            mode,
            sample_rate: rate,
            hrtf,
            left_delay: vec![0.0; delay_len],
            right_delay: vec![0.0; delay_len],
            delay_cursor: 0,
            reflection_taps: MOSQUE_REFLECTIONS.map(|tap| {
                let delay = ((tap.delay_ms * rate as f32 / 1_000.0).round() as usize)
                    .min(delay_len - 1)
                    .max(1);
                (delay, tap)
            }),
            level_count: 0,
            level_squares: 0.0,
            level_peak: 0.0,
            levels,
        })
    }

    fn process(&mut self, left: f32, right: f32, mono_input: bool) -> (f32, f32) {
        let (mut out_left, mut out_right) = match self.mode {
            DspMode::Spatial => self
                .hrtf
                .as_mut()
                .expect("spatial mode always owns measured HRIR filters")
                .process(left, right, mono_input),
            DspMode::Mosque => {
                let cursor = self.delay_cursor;
                self.left_delay[cursor] = left;
                self.right_delay[cursor] = right;
                let mut wet_left = 0.0;
                let mut wet_right = 0.0;
                for (delay, tap) in self.reflection_taps {
                    let index = (cursor + self.left_delay.len() - delay) % self.left_delay.len();
                    wet_left += self.left_delay[index] * tap.left
                        + self.right_delay[index] * tap.cross_left;
                    wet_right += self.right_delay[index] * tap.right
                        + self.left_delay[index] * tap.cross_right;
                }
                self.delay_cursor = (cursor + 1) % self.left_delay.len();
                (left * 0.79 + wet_left, right * 0.79 + wet_right)
            }
        };
        out_left = soft_limit(out_left);
        out_right = soft_limit(out_right);
        let peak = out_left.abs().max(out_right.abs());
        self.level_squares += ((out_left * out_left + out_right * out_right) * 0.5) as f64;
        self.level_peak = self.level_peak.max(peak);
        self.level_count += 1;
        if self.level_count >= 256 {
            let rms = (self.level_squares / self.level_count as f64).sqrt() as f32;
            self.levels.rms_bits.store(rms.to_bits(), Ordering::Relaxed);
            self.levels
                .peak_bits
                .store(self.level_peak.to_bits(), Ordering::Relaxed);
            self.level_count = 0;
            self.level_squares = 0.0;
            self.level_peak = 0.0;
        }
        (out_left, out_right)
    }
}

fn soft_limit(sample: f32) -> f32 {
    if !sample.is_finite() {
        return 0.0;
    }
    let magnitude = sample.abs();
    if magnitude <= 0.90 {
        return sample;
    }
    let shaped = (0.90 + 0.08 * ((magnitude - 0.90) / 0.08).tanh()).min(LIMIT);
    sample.signum() * shaped
}

pub struct SpatialSource<S: Source<Item = f32>> {
    inner: S,
    mode: DspMode,
    channels: usize,
    frame: Vec<f32>,
    output: [f32; 2],
    output_cursor: usize,
    processor: DspProcessor,
    eof: bool,
    tail_remaining: usize,
    duration: Option<Duration>,
    fade_total: usize,
    fade_remaining: usize,
    fade_from: [f32; 2],
    last_output: [f32; 2],
}

impl<S: Source<Item = f32>> SpatialSource<S> {
    fn new(inner: S, mode: DspMode, levels: Arc<LevelSnapshot>) -> Result<Self, String> {
        let channels = usize::from(inner.channels().max(1));
        let sample_rate = inner.sample_rate().max(1);
        let duration = inner
            .total_duration()
            .map(|value| value.saturating_add(mode.tail_duration()));
        let fade_total = (sample_rate as usize * SEEK_FADE_MS as usize / 1_000).max(1);
        let processor = DspProcessor::new(mode, sample_rate, levels)?;
        Ok(Self {
            inner,
            mode,
            channels,
            frame: vec![0.0; channels],
            output: [0.0; 2],
            output_cursor: 2,
            processor,
            eof: false,
            tail_remaining: 0,
            duration,
            fade_total,
            fade_remaining: fade_total,
            fade_from: [0.0; 2],
            last_output: [0.0; 2],
        })
    }

    fn next_frame(&mut self) -> Option<[f32; 2]> {
        if !self.eof {
            let mut read = 0;
            while read < self.channels {
                match self.inner.next() {
                    Some(sample) => {
                        self.frame[read] = sample;
                        read += 1;
                    }
                    None => break,
                }
            }
            if read > 0 {
                let (left, right) = if self.channels == 1 || read == 1 {
                    (self.frame[0], self.frame[0])
                } else if self.channels == 2 {
                    (self.frame[0], self.frame[1])
                } else {
                    let extra_gain = 0.5 / (self.channels.saturating_sub(2) as f32).max(1.0);
                    let mut l = self.frame[0];
                    let mut r = self.frame[1];
                    for index in 2..read {
                        if index % 2 == 0 {
                            l += self.frame[index] * extra_gain;
                        } else {
                            r += self.frame[index] * extra_gain;
                        }
                    }
                    (l, r)
                };
                return Some(self.process_frame(left, right));
            }
            self.eof = true;
            self.tail_remaining = match self.mode {
                DspMode::Spatial => self.processor.sample_rate * HRIR_TAIL_MS as usize / 1_000,
                DspMode::Mosque => self.processor.sample_rate * MOSQUE_TAIL_MS as usize / 1_000,
            };
        }
        if self.tail_remaining == 0 {
            return None;
        }
        self.tail_remaining -= 1;
        Some(self.process_frame(0.0, 0.0))
    }

    fn process_frame(&mut self, left: f32, right: f32) -> [f32; 2] {
        let (processed_left, processed_right) =
            self.processor.process(left, right, self.channels == 1);
        let mut frame = [processed_left, processed_right];
        if self.fade_remaining > 0 {
            let progress = 1.0 - self.fade_remaining as f32 / self.fade_total as f32;
            frame[0] = self.fade_from[0] * (1.0 - progress) + frame[0] * progress;
            frame[1] = self.fade_from[1] * (1.0 - progress) + frame[1] * progress;
            self.fade_remaining -= 1;
        }
        self.last_output = frame;
        frame
    }
}

impl<S: Source<Item = f32>> Iterator for SpatialSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        if self.output_cursor >= 2 {
            self.output = self.next_frame()?;
            self.output_cursor = 0;
        }
        let value = self.output[self.output_cursor];
        self.output_cursor += 1;
        Some(value)
    }
}

impl<S: Source<Item = f32>> Source for SpatialSource<S> {
    fn current_frame_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> u16 {
        2
    }
    fn sample_rate(&self) -> u32 {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.duration
    }

    fn try_seek(&mut self, position: Duration) -> Result<(), rodio::source::SeekError> {
        self.inner.try_seek(position)?;
        self.processor = DspProcessor::new(
            self.mode,
            self.inner.sample_rate(),
            self.processor.levels.clone(),
        )
        .map_err(|_| rodio::source::SeekError::NotSupported {
            underlying_source: "SpatialSource HRIR reset",
        })?;
        self.output_cursor = 2;
        self.eof = false;
        self.tail_remaining = 0;
        self.fade_from = self.last_output;
        self.fade_remaining = self.fade_total;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rodio::buffer::SamplesBuffer;

    #[test]
    fn modes_are_explicit_and_unknown_values_are_rejected() {
        assert_eq!(DspMode::parse("spatial").unwrap(), DspMode::Spatial);
        assert_eq!(DspMode::parse("mosque").unwrap(), DspMode::Mosque);
        assert!(DspMode::parse("natural").is_err());
        assert!(DspMode::parse("experimental").is_err());
    }

    #[test]
    fn symphonia_decodes_a_local_ogg_fixture_without_a_system_codec() {
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/Al-Fatiha-CC0.ogg");
        let mut source = SymphoniaSource::open(&fixture).expect("Symphonia decodes OGG");
        assert!(source.channels() > 0);
        assert!(source.sample_rate() >= 8_000);
        assert!(source.find(|sample| *sample != 0.0).is_some());
    }

    #[test]
    fn symphonia_source_seeks_forward_without_restarting_the_track() {
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/Al-Fatiha-CC0.ogg");
        let mut source = SymphoniaSource::open(&fixture).expect("Symphonia opens OGG");
        let original_samples = source.by_ref().count();
        source
            .try_seek(Duration::from_secs(1))
            .expect("Symphonia seeks in OGG");
        let remaining_samples = source.count();
        assert!(remaining_samples > 0);
        assert!(remaining_samples < original_samples);
    }

    #[test]
    fn decode_error_threshold_preserves_the_original_decoder_reason() {
        assert!(decode_failure_message("recitation.mp3", "MP3", 4_608, 3, "bad frame").is_none());
        let error =
            decode_failure_message("recitation.mp3", "MP3", 6_144, 4, "invalid frame header")
                .expect("the existing fourth consecutive error remains fatal");
        for detail in [
            "recitation.mp3",
            "MP3",
            "6144",
            "4 حزم",
            "invalid frame header",
        ] {
            assert!(error.contains(detail), "missing {detail:?} in {error:?}");
        }
    }

    fn assert_audio_fixture_decodes_and_seeks(relative_path: &str) {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../test/fixtures")
            .join(relative_path);
        let mut source = SymphoniaSource::open(&fixture)
            .unwrap_or_else(|error| panic!("{relative_path} should decode: {error}"));
        assert!(source.channels() > 0, "{relative_path} has audio channels");
        assert!(
            source.sample_rate() >= 8_000,
            "{relative_path} has an audio sample rate"
        );
        assert!(
            source.find(|sample| *sample != 0.0).is_some(),
            "{relative_path} contains audible samples"
        );
        let total_samples = source.by_ref().count();
        assert!(
            total_samples > 1_000,
            "{relative_path} decodes a complete clip"
        );
        source
            .try_seek(Duration::from_millis(500))
            .unwrap_or_else(|error| panic!("{relative_path} should seek: {error:?}"));
        let remaining_samples = source.count();
        assert!(
            remaining_samples > 0,
            "{relative_path} produces samples after seeking"
        );
        assert!(
            remaining_samples < total_samples,
            "{relative_path} seek does not restart at zero"
        );
    }

    #[test]
    fn symphonia_decodes_and_seeks_real_files_in_every_supported_audio_format() {
        for fixture in [
            "audio-formats/recitation-short.wav",
            "audio-formats/recitation-short-24bit.wav",
            "audio-formats/recitation-short.flac",
            "audio-formats/recitation-short.mp3",
            "audio-formats/recitation-short-vbr.mp3",
            "audio-formats/recitation-short.m4a",
            "audio-formats/recitation-alac.m4a",
            "audio-formats/recitation-short.ogg",
            "audio-formats/recitation-short.oga",
            "audio-formats/recitation-opus.ogg",
            "audio-formats/recitation-short.opus",
            "audio-formats/recitation-audio-only.mp4",
            "audio-formats/recitation-video-first.mp4",
            "audio-formats/recitation-webm-opus.webm",
            "audio-formats/recitation-webm-vorbis.webm",
        ] {
            assert_audio_fixture_decodes_and_seeks(fixture);
        }
    }

    #[test]
    fn malformed_and_truncated_local_audio_are_rejected_with_the_file_name() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../test/fixtures/audio-formats/recitation-short.ogg");
        let valid_bytes = std::fs::read(fixture).expect("read valid OGG fixture");
        for (label, bytes) in [
            ("garbage", b"this is not an audio container".to_vec()),
            ("truncated", valid_bytes[..16].to_vec()),
        ] {
            let path = std::env::temp_dir().join(format!(
                "tarteel-spatial-invalid-{}-{label}.ogg",
                std::process::id()
            ));
            std::fs::write(&path, bytes).expect("write malformed test input");
            let result = SymphoniaSource::open(&path);
            let error = match result {
                Ok(_) => panic!("{label} audio must not be accepted"),
                Err(error) => error,
            };
            assert!(
                error.contains(&format!(
                    "tarteel-spatial-invalid-{}-{label}.ogg",
                    std::process::id()
                )),
                "{error}"
            );
            assert!(!error.contains("too many consecutive audio packet decode errors"));
            std::fs::remove_file(path).expect("remove malformed test input");
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_default_output_supports_spatial_playback_controls_when_available() {
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/Al-Fatiha-CC0.ogg");
        let engine = SpatialAudioEngine::new();
        if let Err(error) = engine.play(&fixture, DspMode::Spatial, Duration::ZERO, 75, 1.0, true) {
            if error.contains("تعذر فتح مخرج الصوت المكاني") {
                eprintln!(
                    "SKIP Windows spatial output smoke: no usable default audio output ({error})"
                );
                return;
            }
            panic!("Windows spatial playback failed: {error}");
        }
        engine.set_volume(60).expect("set spatial output volume");
        engine.set_speed(1.25).expect("set spatial output speed");
        engine.pause().expect("pause spatial output");
        assert!(engine.state().paused, "Windows output enters paused state");
        engine.resume().expect("resume spatial output");
        engine
            .seek(Duration::from_millis(500))
            .expect("seek spatial output");
        engine.stop();
        assert!(!engine.state().playing, "Windows output stops cleanly");
    }

    #[test]
    fn limiter_is_finite_and_never_exceeds_safe_peak() {
        for value in [
            -100.0,
            -1.0,
            -0.9,
            0.0,
            0.9,
            1.0,
            100.0,
            f32::NAN,
            f32::INFINITY,
        ] {
            let result = soft_limit(value);
            assert!(result.is_finite());
            assert!(result.abs() <= LIMIT);
        }
        assert_eq!(soft_limit(0.4), 0.4);
    }

    #[test]
    fn convolution_reverb_produces_a_bounded_tail_without_allocating_per_sample() {
        let input = SamplesBuffer::new(1, 1_000, vec![1.0_f32, 0.0, 0.0, 0.0]);
        let levels = Arc::new(LevelSnapshot::default());
        let output: Vec<f32> = SpatialSource::new(input, DspMode::Mosque, levels)
            .unwrap()
            .collect();
        assert_eq!(
            output.len(),
            (4 + MOSQUE_TAIL_MS as usize * 1_000 / 1_000) * 2
        );
        assert!(output
            .iter()
            .all(|sample| sample.is_finite() && sample.abs() <= LIMIT));
        assert!(output
            .chunks_exact(2)
            .skip(10)
            .any(|frame| frame[0].abs() > 0.001 || frame[1].abs() > 0.001));
    }

    #[test]
    fn spatial_hrtf_preserves_binaural_output_and_clips_safely() {
        let input = SamplesBuffer::new(1, 48_000, vec![1.0_f32; 64]);
        let levels = Arc::new(LevelSnapshot::default());
        let output: Vec<f32> = SpatialSource::new(input, DspMode::Spatial, levels)
            .unwrap()
            .collect();
        assert_eq!(
            output.len(),
            (64 + HRIR_TAIL_MS as usize * 48_000 / 1_000) * 2
        );
        assert!(output
            .iter()
            .all(|sample| sample.is_finite() && sample.abs() <= LIMIT));
        assert!(output.chunks_exact(2).any(|frame| frame[0].abs() > 0.001));
        assert!(output
            .chunks_exact(2)
            .any(|frame| (frame[0] - frame[1]).abs() > 0.001));
        let hrir_tail = &output[64 * 2..];
        assert!(hrir_tail
            .chunks_exact(2)
            .any(|frame| frame[0].abs() > 0.001 || frame[1].abs() > 0.001));
        assert!(output
            .chunks_exact(2)
            .rev()
            .take(8)
            .all(|frame| frame[0].abs() < 1e-6 && frame[1].abs() < 1e-6));
    }

    #[test]
    fn mono_hrtf_real_recitation_has_stereo_cues_without_clipping() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../test/fixtures/audio-formats/recitation-short.wav");
        let input = SymphoniaSource::open(&fixture).expect("mono recitation decodes");
        assert_eq!(input.channels(), 1);
        let sample_count = input.sample_rate() as usize * 2;
        let levels = Arc::new(LevelSnapshot::default());
        let output: Vec<f32> = SpatialSource::new(input, DspMode::Spatial, levels)
            .unwrap()
            .take(sample_count)
            .collect();
        assert!(output.len() >= 2_000);
        assert!(output
            .iter()
            .all(|sample| sample.is_finite() && sample.abs() <= LIMIT));
        let (difference, energy) = output
            .chunks_exact(2)
            .fold((0.0_f64, 0.0_f64), |acc, frame| {
                (
                    acc.0 + f64::from(frame[0] - frame[1]).powi(2),
                    acc.1 + f64::from(frame[0]).powi(2) + f64::from(frame[1]).powi(2),
                )
            });
        assert!(energy > 1e-8, "recitation produces audible samples");
        let channel_difference = (difference / energy).sqrt();
        println!(
            "mono HRTF relative channel difference: {:.1}%",
            channel_difference * 100.0
        );
        assert!(
            channel_difference > 0.15,
            "HRTF mono output should have measurable stereo cues: {channel_difference}"
        );
    }

    #[test]
    fn spatial_stereo_uses_measured_left_and_right_virtual_speaker_hrirs() {
        let mut input = Vec::with_capacity(128);
        for _ in 0..64 {
            input.extend_from_slice(&[1.0_f32, 0.0]);
        }
        let input = SamplesBuffer::new(2, 48_000, input);
        let levels = Arc::new(LevelSnapshot::default());
        let output: Vec<f32> = SpatialSource::new(input, DspMode::Spatial, levels)
            .unwrap()
            .collect();
        assert_eq!(
            output.len(),
            (64 + HRIR_TAIL_MS as usize * 48_000 / 1_000) * 2
        );
        assert!(output
            .iter()
            .all(|sample| sample.is_finite() && sample.abs() <= LIMIT));
        assert!(output
            .chunks_exact(2)
            .any(|frame| (frame[0] - frame[1]).abs() > 0.001));
    }
}
