import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { sendNotification } from '@tauri-apps/plugin-notification';
import PrayerSettings from './PrayerSettings.jsx';
import { displayPlaceName } from './engine/display.js';
import { resolveLocation, readDevicePosition, locationNeedsRefresh, describeLocationError } from './engine/location.js';
import { buildSchedule, scheduleNeedsRebuild, alarmEvents, upcoming, current as currentPrayerOf, countdownLabel, toNativeEvents, TASK_HORIZON_DAYS, tasksWithinHorizon } from './engine/schedule.js';
import { installSpecularRim } from './lib/specular-rim.js';
import { applyRimIntensity, readRimIntensity } from './lib/rim-preference.js';
import './styles.css';
import { measureAudioLevels } from './engine/audio-levels.js';

const DIG = '٠١٢٣٤٥٦٧٨٩';
const ar = n => String(n).replace(/\d/g, d => DIG[d]);
const fmt = seconds => {
  if (!Number.isFinite(seconds)) return '٠:٠٠';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const c = String(s % 60).padStart(2, '0');
  return ar(h ? `${h}:${String(m).padStart(2, '0')}:${c}` : `${m}:${c}`);
};
const norm = value => String(value)
  .replace(/[٠-٩]/g, d => DIG.indexOf(d))
  .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
  .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .trim().toLowerCase();
const count = n => n === 0 ? 'لا توجد تلاوات' : n === 1 ? 'تلاوة واحدة' : n === 2 ? 'تلاوتان' : n <= 10 ? `${ar(n)} تلاوات` : `${ar(n)} تلاوة`;
/** اسم المكان العربي: المدينة، المحافظة، الدولة — بلا أي منطقة زمنية إنجليزية. */
const placeLabel = location => (location ? displayPlaceName(location) : '');

/** الاسم العربي الكامل للمكان كما سيظهر في الآيلاند. */
const prayerLocationLabel = config => placeLabel(config?.location) || 'موقعي';

/* الشروق ليس صلاة، فلا تنبيه مسبق له. */
const PRE_ALARM_KEYS = new Set(['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']);

const readJson = (key, fallback) => { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const DEFAULT_PRAYER_CONFIG = {
  location: null, showNext: false, pauseAtAdhan: true,
  notificationsAllowed: false, adhanSound: true, adhanVolume: 80,
  preAlarmMinutes: 0, adjust: {}, methodId: 'auto', school: 'auto',
};
const DEFAULT_AUDIO_PREFS = { speed: 1, sleepMode: 'off', sleepMinutes: 0, sleepDeadline: null, spatialMode: 'natural' };
const SPATIAL_MODES = new Set(['spatial', 'mosque']);
/* بصمة الجدول: الموقع والضبط الدقيق فقط. طريقة الحساب لم تعد اختيارًا
   للمستخدم — تُشتق من الدولة داخل المحرك، فلا معنى لتضمينها هنا. */
const prayerSignature = config => {
  const loc = config?.location;
  if (!loc) return '';
  const adjust = config?.adjust || {};
  const adjustKey = Object.entries(adjust).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}${Number(value) || 0}`).join('');
  return [
    Number(loc.latitude).toFixed(5),
    Number(loc.longitude).toFixed(5),
    loc.timeZone || '',
    adjustKey,
    config?.methodId || 'auto',
    String(config?.school ?? 'auto'),
  ].join('|');
};
const prayerDayKey = (epoch, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(epoch));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};
const readPrayerConfig = () => ({ ...DEFAULT_PRAYER_CONFIG, ...(readJson('tarteel.prayer.settings', {}) || {}) });
const readStoredSchedule = config => {
  const stored = readJson('tarteel.prayer.schedule', null);
  return stored?.signature === prayerSignature(config) && Array.isArray(stored?.value?.events) ? stored.value : null;
};
const readPendingAdhan = () => {
  const saved = readJson('tarteel.adhan.alert', null);
  return saved && Number.isFinite(saved.createdAt) && Date.now() - saved.createdAt < 12 * 60 * 60 * 1000 ? saved : null;
};
const icons = {
  search: <><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></>,
  folder: <><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/><path d="M12 11v5M9.5 13.5h5"/></>,
  sliders: <><path d="M4 8h8M18 8h2M4 16h2M12 16h8"/><circle cx="15" cy="8" r="2.5"/><circle cx="9" cy="16" r="2.5"/></>,
  heart: <path d="M12 20s-7.5-4.6-7.5-10a4.3 4.3 0 0 1 7.5-2.8A4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z"/>,
  volume: <><path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4Z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></>
};
const Icon = ({ name, className = 'i', filled = false }) => <svg className={`${className}${filled ? ' fs' : ''}`} viewBox="0 0 24 24" aria-hidden="true">{icons[name]}</svg>;
const Transport = ({ type }) => type === 'play'
  ? <svg className="transport-icon state-icon" viewBox="0 0 38 48"><path d="M6 6 33 24 6 42Z"/></svg>
  : type === 'pause'
    ? <svg className="transport-icon state-icon" viewBox="0 0 36 48"><rect width="14" height="48" rx="4"/><rect x="22" width="14" height="48" rx="4"/></svg>
    : <svg className="transport-icon skip-icon" viewBox="0 0 48 30"><path d={type === 'prev' ? 'M23 3 4 15l19 12ZM45 3 26 15l19 12Z' : 'M3 3l19 12L3 27ZM25 3l19 12-19 12Z'}/></svg>;

const mimeFor = path => {
  const ext = path.split('.').pop()?.toLowerCase();
  return ({ mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
    webm: 'audio/webm', flac: 'audio/flac', m4a: 'audio/mp4', mp4: 'audio/mp4' })[ext] || '';
};

function App() {
  useEffect(() => {
    const broadcastRimIntensity = event => {
      const value = Number(event.detail?.value);
      if (Number.isFinite(value)) emit('island-rim-intensity', { value }).catch(cause => console.error('Tarteel island rim update failed', cause));
    };
    document.addEventListener('tarteel-rim-change', broadcastRimIntensity);
    applyRimIntensity(readRimIntensity(), document);
    const uninstallRim = installSpecularRim(document);
    return () => {
      document.removeEventListener('tarteel-rim-change', broadcastRimIntensity);
      uninstallRim();
    };
  }, []);
  const initialConfig = readPrayerConfig();
  const [tracks, setTracks] = useState(() => readJson('tarteel.library', []));
  const [favorites, setFavorites] = useState(() => new Set(readJson('tarteel.favorites', [])));
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => Math.min(100, Math.max(0, Number(localStorage.getItem('tarteel.volume') || 70))));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [prayerConfig, setPrayerConfig] = useState(initialConfig);
  const [prayerSchedule, setPrayerSchedule] = useState(() => readStoredSchedule(initialConfig));
  const [prayerSettingsOpen, setPrayerSettingsOpen] = useState(() => !initialConfig.location);
  const [adhanAlert, setAdhanAlert] = useState(() => readPendingAdhan());
  const [audioPrefs, setAudioPrefs] = useState(() => {
    const saved = readJson('tarteel.audio.settings', {}) || {};
    return { ...DEFAULT_AUDIO_PREFS, ...saved, spatialMode: ['natural', 'spatial', 'mosque'].includes(saved.spatialMode) ? saved.spatialMode : 'natural' };
  });
  const [nativeAudioActive, setNativeAudioActive] = useState(false);
  const audio = useRef(null);
  const nativeAudioActiveRef = useRef(false);
  const nativeEndedRef = useRef(false);
  const nativeEndedHandledRef = useRef(false);
  const audioMeter = useRef({ context: null, source: null, stream: null, analyser: null, gate: null, samples: null, levels: Array(5).fill(0), raf: 0, lastSample: 0, sourceUrl: '', disabled: false });
  const nextRef = useRef(() => {});
  const tracksRef = useRef(tracks);
  const visibleRef = useRef([]);
  const controlsRef = useRef({});
  const statePublisherRef = useRef(() => Promise.resolve());
  const prayerConfigRef = useRef(prayerConfig);
  const prayerScheduleRef = useRef(prayerSchedule);
  const audioPrefsRef = useRef(audioPrefs);
  const currentRef = useRef(current);
  const playingRef = useRef(playing);
  const pendingResumeRef = useRef(readJson('tarteel.adhan.resume', null));
  const adhanAlertRef = useRef(adhanAlert);
  const lastAdhanIdRef = useRef(adhanAlert?.id || '');
  const locationWatchRef = useRef(null);
  const scheduleRequestRef = useRef(0);
  const restoreReadyRef = useRef(false);
  tracksRef.current = tracks;
  visibleRef.current = visibleRef.current;
  prayerConfigRef.current = prayerConfig;
  prayerScheduleRef.current = prayerSchedule;
  audioPrefsRef.current = audioPrefs;
  nativeAudioActiveRef.current = nativeAudioActive;
  currentRef.current = current;
  playingRef.current = playing;
  adhanAlertRef.current = adhanAlert;

  if (!audio.current) {
    audio.current = new Audio();
    audio.current.crossOrigin = 'anonymous';
    audio.current.preload = 'metadata';
    audio.current.playbackRate = Number(audioPrefs.speed) || 1;
  }

  useEffect(() => { localStorage.setItem('tarteel.library', JSON.stringify(tracks)); }, [tracks]);
  useEffect(() => { localStorage.setItem('tarteel.favorites', JSON.stringify([...favorites])); }, [favorites]);
  useEffect(() => { localStorage.setItem('tarteel.volume', String(volume)); }, [volume]);
  useEffect(() => { localStorage.setItem('tarteel.prayer.settings', JSON.stringify(prayerConfig)); }, [prayerConfig]);
  useEffect(() => { if (adhanAlert) localStorage.setItem('tarteel.adhan.alert', JSON.stringify(adhanAlert)); else localStorage.removeItem('tarteel.adhan.alert'); }, [adhanAlert]);
  useEffect(() => {
    invoke('set_adhan_preferences', {
      enabled: Boolean(prayerConfig.adhanSound ?? true),
      volume: Math.max(0, Math.min(100, Number(prayerConfig.adhanVolume ?? 80))),
      muted: Boolean(prayerConfig.adhanMuted ?? false),
    }).catch(cause => {
      console.error('Tarteel could not persist adhan preferences for scheduled playback', cause);
      setError(`تعذر حفظ تفضيلات الأذان للتنبيه عند تشغيل مهمة Windows: ${String(cause)}`);
    });
  }, [prayerConfig.adhanSound, prayerConfig.adhanVolume, prayerConfig.adhanMuted]);

  const persistAudioPrefs = patch => {
    const next = { ...audioPrefsRef.current, ...patch };
    audioPrefsRef.current = next;
    setAudioPrefs(next);
    localStorage.setItem('tarteel.audio.settings', JSON.stringify(next));
    if (audio.current && Number.isFinite(Number(next.speed))) audio.current.playbackRate = Number(next.speed);
    if (nativeAudioActiveRef.current && Number.isFinite(Number(next.speed))) {
      invoke('spatial_audio_set_speed', { speed: Number(next.speed) }).catch(cause => console.warn('Tarteel native speed update failed', cause));
    }
    return next;
  };

  const updatePrayerPreferences = patch => {
    const next = { ...prayerConfigRef.current, ...patch };
    prayerConfigRef.current = next;
    setPrayerConfig(next);
    localStorage.setItem('tarteel.prayer.settings', JSON.stringify(next));
    return next;
  };

  const clearPendingResume = () => {
    pendingResumeRef.current = null;
    localStorage.removeItem('tarteel.adhan.resume');
  };

  const disableAdhanResume = () => {
    clearPendingResume();
    const currentAlert = adhanAlertRef.current;
    if (currentAlert?.pausedByAdhan) {
      const nextAlert = { ...currentAlert, pausedByAdhan: false, resumeDisabled: true };
      adhanAlertRef.current = nextAlert;
      setAdhanAlert(nextAlert);
      localStorage.setItem('tarteel.adhan.alert', JSON.stringify(nextAlert));
    }
  };

  const clearAdhanAlert = () => {
    adhanAlertRef.current = null;
    setAdhanAlert(null);
    localStorage.removeItem('tarteel.adhan.alert');
    clearPendingResume();
  };

  const setNativeSleepDeadline = deadline => invoke('set_sleep_deadline', { deadlineMs: deadline }).catch(cause => {
    console.error('Tarteel native sleep timer update failed', cause);
    setError(`تعذر حفظ مؤقت النوم في مجدول التطبيق: ${String(cause)}`);
  });

  const setSleep = value => {
    let next;
    if (value === '0') next = { sleepMode: 'off', sleepMinutes: 0, sleepDeadline: null };
    else if (value === 'end') next = { sleepMode: 'end', sleepMinutes: 0, sleepDeadline: null };
    else {
      const minutes = Number(value);
      if (![15, 30, 60].includes(minutes)) return;
      next = { sleepMode: 'minutes', sleepMinutes: minutes, sleepDeadline: Date.now() + minutes * 60_000 };
    }
    persistAudioPrefs(next);
    setNativeSleepDeadline(next.sleepDeadline);
    statePublisherRef.current();
  };

  const setSpeed = value => {
    const speed = Number(value);
    if (![0.75, 1, 1.25, 1.5].includes(speed)) return;
    persistAudioPrefs({ speed });
    statePublisherRef.current();
  };

  /**
   * يدفع الجدول إلى الطبقة الأصلية: جدولة Rust + مهام ويندوز.
   * المهام المجدولة هي ما يُبقي الأذان يعمل والتطبيق مغلق.
   */
  const publishScheduleToNative = async schedule => {
    const events = toNativeEvents(schedule);
    await invoke('set_alarm_schedule', { events });
    const now = Date.now();
    const expected = tasksWithinHorizon(schedule, now).length;
    try {
      const created = await invoke('sync_windows_tasks', { aheadMs: TASK_HORIZON_DAYS * 24 * 3600 * 1000 });
      const prefix = 'تعذر مزامنة مهام الأذان';
      if (created < expected) {
        setError(`تزامن ${created} من ${expected} مهمة أذان فقط؛ قد لا يعمل الأذان أثناء سكون الجهاز.`);
      } else {
        setError(current => current.startsWith(prefix) || current.startsWith('تزامن ') ? '' : current);
      }
    } catch (cause) {
      console.error('Tarteel could not sync Windows tasks', cause);
      setError(`تعذر مزامنة مهام الأذان مع Windows Task Scheduler؛ قد لا يعمل الأذان أثناء سكون الجهاز. ${String(cause)}`);
    }
  };

  const storePrayerSchedule = async (config, schedule) => {
    const signature = prayerSignature(config);
    const wrapped = { ...schedule, signature };
    localStorage.setItem('tarteel.prayer.schedule', JSON.stringify({ signature, value: wrapped }));
    prayerScheduleRef.current = wrapped;
    setPrayerSchedule(wrapped);
    await publishScheduleToNative(wrapped);
    return wrapped;
  };

  /**
   * يبني الجدول من الموقع الحالي وبنشره.
   * لا شبكة ولا مصدر خارجي: المحرك الفلكي يحسب محليًا، فالجداول لا تفشل
   * أبدًا بسبب انقطاع الإنترنت.
   */
  const loadAndPublishSchedule = async config => {
    if (!config?.location) {
      prayerScheduleRef.current = null;
      setPrayerSchedule(null);
      localStorage.removeItem('tarteel.prayer.schedule');
      await publishScheduleToNative(null);
      return null;
    }
    const requestId = ++scheduleRequestRef.current;
    const built = buildSchedule(config.location, {
      adjust: config.adjust,
      methodId: config.methodId && config.methodId !== 'auto' ? config.methodId : undefined,
      shadowFactor: config.school === 2 ? 2 : config.school === 1 ? 1 : undefined,
    });
    if (requestId !== scheduleRequestRef.current) return prayerScheduleRef.current;
    return storePrayerSchedule(config, built);
  };

  /* مراقبة الموقع: WebView2 لا يحتاج watchPosition؛ نكتفي بفحص دوري
     خفيف يعيد بناء الجدول فقط عند تغيّر حقيقي (حركة أو منطقة زمنية أو عمر). */
  const stopLocationWatch = () => {
    if (locationWatchRef.current !== null) {
      clearInterval(locationWatchRef.current);
      locationWatchRef.current = null;
    }
  };

  /**
   * مراقبة موقع الجهاز. لا نعيد الحساب إلا عند تغيّر حقيقي:
   * حركة تتجاوز 500 متر، أو تغيّر المنطقة الزمنية، أو مرور 30 دقيقة.
   * هذا يمنع إعادة بناء الجدول كل دقيقة بسبب اهتزاز قراءة Wi-Fi.
   */
  const startLocationWatch = async config => {
    stopLocationWatch();
    if (config.location?.source !== 'device') return;
    /* كل 10 دقائق نقرأ الموقع؛ ولا نعيد البناء إلا إذا قرّر المحرك أن
       هناك تغيّرًا حقيقيًا: حركة > 500م، أو تغيّر المنطقة الزمنية، أو 30 دقيقة. */
    const interval = setInterval(async () => {
      const latest = prayerConfigRef.current;
      if (latest.location?.source !== 'device') return;
      try {
        const fix = await readDevicePosition();
        const next = {
          ...latest.location,
          latitude: fix.latitude, longitude: fix.longitude,
          accuracy: fix.accuracy, resolvedAt: Date.now(),
        };
        const { timeZoneForCoordinates } = await import('./engine/location.js');
        next.timeZone = timeZoneForCoordinates(fix.latitude, fix.longitude);
        if (!locationNeedsRefresh(latest.location, next)) return;
        const changed = { ...latest, location: next };
        prayerConfigRef.current = changed;
        setPrayerConfig(changed);
        localStorage.setItem('tarteel.prayer.settings', JSON.stringify(changed));
        await loadAndPublishSchedule(changed);
      } catch (cause) {
        /* فشل قراءة دورية ليس خطأً يعرض للمستخدم. */
        console.warn('Tarteel periodic location refresh skipped', cause);
      }
    }, 10 * 60 * 1000);
    locationWatchRef.current = interval;
  };

  const savePrayerSettings = async selected => {
    const next = { ...prayerConfigRef.current, ...selected };
    prayerConfigRef.current = next;
    setPrayerConfig(next);
    localStorage.setItem('tarteel.prayer.settings', JSON.stringify(next));
    const result = await loadAndPublishSchedule(next);
    await startLocationWatch(next);
    return result;
  };

  useEffect(() => {
    const a = audio.current;
    const meter = audioMeter.current;
    const publishLevels = (audioState, levels = Array(5).fill(0), rms = 0, peak = 0) => {
      emit('audio-levels', { audioState, levels, rms, peak }).catch(cause => console.error('Tarteel audio-level event failed', cause));
    };
    const stopMeter = (audioState, publish = true) => {
      if (meter.raf) cancelAnimationFrame(meter.raf);
      meter.raf = 0;
      meter.lastSample = 0;
      meter.levels = Array(5).fill(0);
      if (meter.context?.state === 'running' && audioState !== 'playing') meter.context.suspend().catch(cause => console.warn('Tarteel audio meter suspend failed', cause));
      if (publish) publishLevels(audioState);
    };
    const resetMeterSource = () => {
      if (meter.raf) cancelAnimationFrame(meter.raf);
      meter.raf = 0;
      try { meter.source?.disconnect(); meter.analyser?.disconnect(); meter.gate?.disconnect(); } catch {}
      for (const track of meter.stream?.getTracks() || []) track.stop();
      Object.assign(meter, { source: null, stream: null, analyser: null, gate: null, samples: null, levels: Array(5).fill(0), lastSample: 0, sourceUrl: '' });
    };
    const ensureMeter = () => {
      if (meter.disabled) return null;
      if (meter.analyser && meter.sourceUrl === a.currentSrc) return meter;
      if (meter.analyser) resetMeterSource();
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context || typeof a.captureStream !== 'function') {
        meter.disabled = true;
        console.warn('Tarteel audio-level monitoring is unavailable; original playback remains unchanged.');
        return null;
      }
      let context, source, analyser, gate, stream;
      try {
        context = meter.context || new Context({ latencyHint: 'interactive' });
        stream = a.captureStream();
        if (!stream?.getAudioTracks().length) throw new Error('The active playback stream has no audio track.');
        source = context.createMediaStreamSource(stream);
        analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0;
        gate = context.createGain();
        gate.gain.value = 0;
        source.connect(analyser);
        analyser.connect(gate);
        gate.connect(context.destination);
        Object.assign(meter, { context, source, stream, analyser, gate, samples: new Float32Array(analyser.fftSize), levels: Array(5).fill(0), sourceUrl: a.currentSrc });
        return meter;
      } catch (cause) {
        try { source?.disconnect(); analyser?.disconnect(); gate?.disconnect(); } catch {}
        if (stream) for (const track of stream.getTracks()) track.stop();
        if (context) {
          context.close().catch(() => {});
          if (meter.context === context) meter.context = null;
        }
        meter.disabled = true;
        console.warn('Tarteel could not start non-invasive audio-level monitoring; playback is unchanged.', cause);
        return null;
      }
    };
    const sample = now => {
      meter.raf = 0;
      if (a.paused || a.ended || !a.currentSrc) {
        stopMeter(a.ended ? 'ended' : currentRef.current === null ? 'no-track' : 'paused');
        return;
      }
      if (now - meter.lastSample >= 50) {
        meter.lastSample = now;
        try {
          meter.analyser.getFloatTimeDomainData(meter.samples);
          const signal = measureAudioLevels(meter.samples, meter.levels);
          meter.levels = signal.levels;
          publishLevels('playing', signal.levels, signal.rms, signal.peak);
        } catch (cause) {
          console.warn('Tarteel audio-level sampling stopped; playback continues.', cause);
          stopMeter('playing');
          return;
        }
      }
      meter.raf = requestAnimationFrame(sample);
    };
    const startMeter = () => {
      if (nativeAudioActiveRef.current || a.paused || a.ended || !a.currentSrc) return;
      const state = ensureMeter();
      if (!state) return;
      state.context.resume().then(() => {
        if (a.paused || a.ended || !a.currentSrc) {
          stopMeter(a.ended ? 'ended' : currentRef.current === null ? 'no-track' : 'paused');
          return;
        }
        if (!state.raf) state.raf = requestAnimationFrame(sample);
      }).catch(cause => console.warn('Tarteel audio meter resume failed; playback is unchanged.', cause));
    };
    const onTime = () => { if (!nativeAudioActiveRef.current) setPos(Number.isFinite(a.currentTime) ? a.currentTime : 0); };
    const onMetadata = () => { if (!nativeAudioActiveRef.current) setDuration(Number.isFinite(a.duration) ? a.duration : 0); };
    const onPlay = () => { if (!nativeAudioActiveRef.current) { setPlaying(true); playingRef.current = true; } };
    const onPlaying = () => startMeter();
    const onEmptied = () => resetMeterSource();
    const onPause = () => {
      stopMeter(currentRef.current === null ? 'no-track' : 'paused');
      if (!nativeAudioActiveRef.current) { setPlaying(false); playingRef.current = false; }
    };
    const onEnded = () => {
      if (nativeAudioActiveRef.current) return;
      stopMeter('ended');
      const prefs = audioPrefsRef.current;
      const sleepEnded = prefs.sleepMode === 'end';
      if (sleepEnded) {
        a.pause();
        persistAudioPrefs({ sleepMode: 'off', sleepMinutes: 0, sleepDeadline: null });
        setNativeSleepDeadline(null);
        statePublisherRef.current();
        return;
      }
      nextRef.current(1);
    };
    const onError = () => {
      if (nativeAudioActiveRef.current) return;
      const code = a.error?.code || 0;
      console.error('Tarteel audio engine error', { code, mediaError: a.error?.message || 'unknown' });
      setPlaying(false);
      playingRef.current = false;
      stopMeter(currentRef.current === null ? 'no-track' : 'paused');
      setError('تعذّر فك ترميز الملف الصوتي. جرّب MP3 أو WAV أو OGG مدعومًا.');
    };
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMetadata);
    a.addEventListener('durationchange', onMetadata);
    a.addEventListener('emptied', onEmptied);
    a.addEventListener('play', onPlay);
    a.addEventListener('playing', onPlaying);
    a.addEventListener('pause', onPause);
    a.addEventListener('ended', onEnded);
    a.addEventListener('error', onError);
    a.muted = false;
    a.volume = volume / 100;
    a.playbackRate = Number(audioPrefsRef.current.speed) || 1;
    return () => {
      a.pause();
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMetadata);
      a.removeEventListener('durationchange', onMetadata);
      a.removeEventListener('emptied', onEmptied);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('playing', onPlaying);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('ended', onEnded);
      a.removeEventListener('error', onError);
      stopMeter('no-track', false);
      try { meter.source?.disconnect(); meter.analyser?.disconnect(); meter.gate?.disconnect(); } catch {}
      for (const track of meter.stream?.getTracks() || []) track.stop();
      meter.context?.close().catch(() => {});
      Object.assign(meter, { context: null, source: null, stream: null, analyser: null, gate: null, samples: null, levels: Array(5).fill(0), lastSample: 0, sourceUrl: '', disabled: false });
      stopLocationWatch();
    };
  }, []);

  useEffect(() => {
    const savedFolder = localStorage.getItem('tarteel.folder');
    if (savedFolder) invoke('set_audio_root', { path: savedFolder }).catch(cause => {
      console.error('Tarteel saved audio scope failed', { message: String(cause) });
      setError('تعذّر إعادة فتح مجلد الصوت المحفوظ. اختر المجلد مرة أخرى.');
    });
  }, []);

  useEffect(() => {
    const saved = readJson('tarteel.player.last-playback', null);
    if (!saved?.path) {
      restoreReadyRef.current = true;
      if (adhanAlertRef.current) emit('prayer-alarm-restore', adhanAlertRef.current).catch(() => {});
      return;
    }
    const index = tracksRef.current.findIndex(track => track.path === saved.path);
    if (index < 0) {
      restoreReadyRef.current = true;
      setError('لم تُستعد التلاوة السابقة لأن ملفها غير موجود في المكتبة الحالية.');
      if (adhanAlertRef.current) emit('prayer-alarm-restore', adhanAlertRef.current).catch(() => {});
      return;
    }
    const folder = localStorage.getItem('tarteel.folder');
    const scopeReady = folder ? invoke('set_audio_root', { path: folder }) : Promise.resolve();
    scopeReady.then(async () => {
      const track = tracksRef.current[index], pending = pendingResumeRef.current;
      const position = pending?.trackPath === track.path ? Number(pending.position) : Number(saved.position);
      const a = audio.current;
      if (SPATIAL_MODES.has(audioPrefsRef.current.spatialMode)) {
        const status = await invoke('start_spatial_recitation', {
          path: track.path, mode: audioPrefsRef.current.spatialMode, position: Math.max(0, Number(position) || 0),
          volume, speed: Number(audioPrefsRef.current.speed) || 1, autoplay: false,
        });
        nativeAudioActiveRef.current = true;
        setNativeAudioActive(true);
        nativeEndedRef.current = false;
        a.pause();
        setCurrent(index); currentRef.current = index;
        setDuration(Number(status.duration) || Number(track.duration) || 0);
        setPos(Number(status.position) || 0);
        setPlaying(false); playingRef.current = false;
      } else {
        a.src = await invoke('audio_url', { path: track.path });
        a.playbackRate = Number(audioPrefsRef.current.speed) || 1;
        await new Promise((resolve, reject) => {
          const cleanup = () => { a.removeEventListener('loadedmetadata', success); a.removeEventListener('error', failure); clearTimeout(timeout); };
          const success = () => { cleanup(); resolve(); };
          const failure = () => { cleanup(); reject(new Error(a.error?.message || 'تعذر تحميل بيانات الملف السابق')); };
          const timeout = setTimeout(() => { cleanup(); reject(new Error('انتهت مهلة استعادة بيانات الملف')); }, 12000);
          a.addEventListener('loadedmetadata', success, { once: true });
          a.addEventListener('error', failure, { once: true });
          a.load();
        });
        const target = Number.isFinite(a.duration) ? Math.max(0, Math.min(position || 0, a.duration)) : 0;
        if (Number.isFinite(a.duration)) a.currentTime = target;
        a.pause();
        setCurrent(index); currentRef.current = index; setDuration(Number.isFinite(a.duration) ? a.duration : Number(track.duration) || 0); setPos(target); setPlaying(false);
      }
      if (pending?.trackPath && pending.trackPath !== track.path) clearPendingResume();
      restoreReadyRef.current = true;
      if (adhanAlertRef.current) emit('prayer-alarm-restore', adhanAlertRef.current).catch(() => {});
    }).catch(cause => {
      console.error('Tarteel previous playback restoration failed', cause);
      restoreReadyRef.current = true;
      setError(`تعذر استعادة موضع التلاوة السابقة: ${String(cause)}`);
      if (adhanAlertRef.current) emit('prayer-alarm-restore', adhanAlertRef.current).catch(() => {});
    });
  }, []);

  useEffect(() => {
    if (!nativeAudioActive) return undefined;
    let disposed = false;
    let inFlight = false;
    const syncNativePlayback = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const status = await invoke('spatial_audio_state');
        if (disposed) return;
        const position = Math.max(0, Number(status.position) || 0);
        const total = Math.max(0, Number(status.duration) || 0);
        if (status.error) {
          const failedIndex = currentRef.current;
          const resumeAfterFailure = playingRef.current;
          const detail = String(status.error);
          nativeEndedHandledRef.current = true;
          await invoke('spatial_audio_stop').catch(() => {});
          nativeAudioActiveRef.current = false;
          setNativeAudioActive(false);
          nativeEndedRef.current = false;
          persistAudioPrefs({ spatialMode: 'natural' });
          if (failedIndex !== null && !adhanAlertRef.current) {
            await load(failedIndex, resumeAfterFailure, position);
          }
          setError(`توقف فك التلاوة المكانية عند هذه النقطة؛ عادت إلى المسار الطبيعي. ${detail}`);
          return;
        }
        const peak = Math.max(0, Math.min(1, Number(status.peak) || 0));
        const rms = Math.max(0, Math.min(1, Number(status.rms) || 0));
        setPos(position);
        if (total > 0) setDuration(total);
        setPlaying(Boolean(status.playing));
        playingRef.current = Boolean(status.playing);
        nativeEndedRef.current = Boolean(status.ended);
        const level = Math.max(0.07, Math.min(1, peak * 0.72 + rms * 1.8));
        const levels = [0.68, 0.86, 1, 0.84, 0.64].map(weight => Math.max(0.07, Math.min(1, level * weight)));
        emit('audio-levels', {
          audioState: status.ended ? 'ended' : status.playing ? 'playing' : 'paused',
          levels: status.playing ? levels : Array(5).fill(0.07), rms, peak,
        }).catch(() => {});
        if (status.ended && !nativeEndedHandledRef.current) {
          nativeEndedHandledRef.current = true;
          if (audioPrefsRef.current.sleepMode === 'end') {
            await invoke('spatial_audio_stop').catch(() => {});
            nativeAudioActiveRef.current = false;
            setNativeAudioActive(false);
            setPlaying(false); playingRef.current = false;
            persistAudioPrefs({ sleepMode: 'off', sleepMinutes: 0, sleepDeadline: null });
            setNativeSleepDeadline(null);
            statePublisherRef.current();
          } else {
            nextRef.current(1);
          }
        }
      } catch (cause) {
        if (!disposed) console.warn('Tarteel native audio state polling failed', cause);
      } finally {
        inFlight = false;
      }
    };
    syncNativePlayback();
    const timer = setInterval(syncNativePlayback, 120);
    return () => { disposed = true; clearInterval(timer); };
  }, [nativeAudioActive]);

  useEffect(() => {
    const config = prayerConfigRef.current;
    const cached = readStoredSchedule(config);
    if (!config.location) {
      invoke('set_alarm_schedule', { events: [] })
        .catch(cause => console.error('Tarteel could not clear alarms on startup', cause));
      return;
    }
    if (cached) {
      prayerScheduleRef.current = cached;
      setPrayerSchedule(cached);
      publishScheduleToNative(cached).catch(cause => console.error('Tarteel could not republish alarms', cause));
    }
    /* المحرك محلي: إعادة البناء رخيصة ولا تحتاج شبكة، فنجدّد كل إقلاع. */
    loadAndPublishSchedule(config).catch(cause => console.error('Tarteel startup schedule failed', cause));
    startLocationWatch(config);
    const savedSleep = audioPrefsRef.current;
    if (savedSleep.sleepMode === 'minutes' && Number.isFinite(savedSleep.sleepDeadline)) {
      if (Date.now() >= savedSleep.sleepDeadline) {
        disableAdhanResume();
        persistAudioPrefs({ sleepMode: 'off', sleepMinutes: 0, sleepDeadline: null });
        setNativeSleepDeadline(null);
      } else setNativeSleepDeadline(savedSleep.sleepDeadline);
    } else setNativeSleepDeadline(null);
  }, []);

  /* التنبيه المسبق وحده يستخدم إشعار ويندوز وصوته الافتراضي؛ إذنه لا يدخل في الأذان الفعلي. */
  const preAlarmFiredRef = useRef(new Set(readJson('tarteel.prayer.pre-alerts', [])));
  const persistPreAlarmFired = () => {
    localStorage.setItem('tarteel.prayer.pre-alerts', JSON.stringify([...preAlarmFiredRef.current].slice(-512)));
  };
  useEffect(() => {
    const tick = () => {
      const config = prayerConfigRef.current;
      const minutes = Number(config.preAlarmMinutes) || 0;
      if (minutes <= 0 || !config.notificationsAllowed) return;
      const events = prayerScheduleRef.current?.events;
      if (!Array.isArray(events)) return;
      const now = Date.now();
      for (const event of events) {
        if (!PRE_ALARM_KEYS.has(event.key)) continue;
        const lead = event.at - minutes * 60000;
        /* نافذة دقيقتين: تكفي لدورة فحص كل ٣٠ ثانية ولا تسمح بالتكرار. */
        if (now < lead || now - lead > 120000) continue;
        const firedId = `pre|${event.id}`;
        if (preAlarmFiredRef.current.has(firedId)) continue;
        preAlarmFiredRef.current.add(firedId);
        persistPreAlarmFired();
        Promise.resolve(sendNotification({
          title: `بعد ${minutes} دقائق: صلاة ${event.name}`,
          body: 'استعد لصلاة الفريضة.',
        })).catch(cause => console.error('Tarteel pre-alarm notification failed', cause));
      }
    };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let day = '';
    const checkDay = () => {
      const schedule = prayerScheduleRef.current;
      if (!schedule?.timezone) return;
      try {
        const currentDay = prayerDayKey(Date.now(), schedule.timezone);
        if (day && currentDay !== day) loadAndPublishSchedule(prayerConfigRef.current).catch(cause => console.error('Tarteel midnight prayer refresh failed', cause));
        day = currentDay;
      } catch (cause) { console.error('Tarteel prayer timezone date check failed', cause); }
    };
    checkDay();
    const timer = setInterval(checkDay, 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const key = event => {
      if (event.code === 'Space' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && document.activeElement === document.body) {
        event.preventDefault(); toggle();
      }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  });

  const visible = useMemo(() => {
    const q = norm(query);
    return tracks.filter((track, index) => (filter === 'all' || favorites.has(index)) && (!q || [track.file_name, track.title, track.artist].some(value => norm(value).includes(q))));
  }, [tracks, filter, favorites, query]);
  visibleRef.current = visible;

  const selectFolder = async () => {
    setError('');
    const picked = await open({ directory: true, multiple: false, title: 'اختر مجلد التلاوات' });
    if (!picked) return;
    try {
      setBusy(true);
      if (nativeAudioActiveRef.current) {
        await invoke('spatial_audio_stop');
        nativeAudioActiveRef.current = false;
        setNativeAudioActive(false);
      }
      await invoke('set_audio_root', { path: picked });
      const found = await invoke('scan_directory', { path: picked });
      setTracks(found);
      localStorage.setItem('tarteel.folder', picked);
      if (!found.length) {
        audio.current.pause();
        audio.current.removeAttribute('src');
        audio.current.load();
      }
      const first = found.length ? 0 : null;
      setCurrent(first); currentRef.current = first;
      setDuration(0); setPos(0); setPlaying(false); playingRef.current = false;
    } catch (cause) {
      console.error('Tarteel directory scan failed', { message: String(cause) });
      setError(`تعذّر فحص المجلد: ${String(cause)}`);
    } finally { setBusy(false); }
  };

  const load = async (index, autoplay = true, startPosition = 0) => {
    const track = tracksRef.current[index];
    if (!track) return;
    const mime = mimeFor(track.path);
    if (!mime) { setError('صيغة الملف غير مدعومة في مشغل Windows هذا.'); return; }
    try {
      setError('');
      if (adhanAlertRef.current) disableAdhanResume(); else clearPendingResume();
      const a = audio.current;
      const requestedMode = audioPrefsRef.current.spatialMode;
      if (SPATIAL_MODES.has(requestedMode)) {
        try {
          const status = await invoke('start_spatial_recitation', {
            path: track.path, mode: requestedMode, position: Math.max(0, Number(startPosition) || 0),
            volume, speed: Number(audioPrefsRef.current.speed) || 1, autoplay,
          });
          nativeAudioActiveRef.current = true;
          setNativeAudioActive(true);
          nativeEndedRef.current = false;
          nativeEndedHandledRef.current = false;
          a.pause();
          setCurrent(index); currentRef.current = index;
          setPos(Number(status.position) || 0);
          setDuration(Number(status.duration) || Number(track.duration) || 0);
          setPlaying(Boolean(status.playing)); playingRef.current = Boolean(status.playing);
          return;
        } catch (cause) {
          console.warn('Tarteel spatial audio is unavailable; falling back to the original player.', cause);
          await invoke('spatial_audio_stop').catch(() => {});
          nativeAudioActiveRef.current = false;
          setNativeAudioActive(false);
          nativeEndedRef.current = false;
          persistAudioPrefs({ spatialMode: 'natural' });
          setError(`تعذّر تشغيل المؤثرات المكانية؛ استُخدم الصوت الطبيعي بدلًا منها. ${String(cause?.message || cause)}`);
        }
      }
      if (nativeAudioActiveRef.current) {
        await invoke('spatial_audio_stop').catch(() => {});
        nativeAudioActiveRef.current = false;
        setNativeAudioActive(false);
      }
      a.pause();
      a.src = await invoke('audio_url', { path: track.path });
      a.volume = volume / 100;
      a.playbackRate = Number(audioPrefsRef.current.speed) || 1;
      a.load();
      setCurrent(index); currentRef.current = index; setPos(0); setDuration(0);
      if (Number(startPosition) > 0) {
        await new Promise((resolve, reject) => {
          const cleanup = () => { a.removeEventListener('loadedmetadata', ready); a.removeEventListener('error', failed); clearTimeout(timeout); };
          const ready = () => { cleanup(); resolve(); };
          const failed = () => { cleanup(); reject(new Error(a.error?.message || 'تعذر تحميل بيانات التلاوة')); };
          const timeout = setTimeout(() => { cleanup(); reject(new Error('انتهت مهلة استعادة موضع التلاوة')); }, 12000);
          a.addEventListener('loadedmetadata', ready, { once: true });
          a.addEventListener('error', failed, { once: true });
        });
        if (Number.isFinite(a.duration)) a.currentTime = Math.max(0, Math.min(Number(startPosition), a.duration));
      }
      if (autoplay) await a.play();
    } catch (cause) {
      console.error('Tarteel audio load failed', { mime, message: String(cause) });
      setPlaying(false);
      setError(`تعذّر تشغيل «${track.file_name}». الملف قد يكون تالفًا أو بصيغة لا يدعمها WebView2.`);
    }
  };

  const setSpatialMode = async mode => {
    if (!['natural', 'spatial', 'mosque'].includes(mode)) return;
    const previousMode = audioPrefsRef.current.spatialMode;
    if (mode === previousMode) return;
    const index = currentRef.current;
    const position = Math.max(0, Number(nativeAudioActiveRef.current ? pos : audio.current.currentTime) || 0);
    const wasPlaying = nativeAudioActiveRef.current ? playingRef.current : !audio.current.paused;
    persistAudioPrefs({ spatialMode: mode });
    nativeEndedHandledRef.current = false;
    if (index === null) return;
    const track = tracksRef.current[index];
    if (!track) return;
    if (SPATIAL_MODES.has(mode)) {
      try {
        const status = await invoke('start_spatial_recitation', {
          path: track.path, mode, position, volume, speed: Number(audioPrefsRef.current.speed) || 1, autoplay: wasPlaying,
        });
        nativeAudioActiveRef.current = true;
        setNativeAudioActive(true);
        nativeEndedRef.current = false;
        audio.current.pause();
        setPos(Number(status.position) || position);
        setDuration(Number(status.duration) || Number(track.duration) || 0);
        setPlaying(Boolean(status.playing)); playingRef.current = Boolean(status.playing);
        return;
      } catch (cause) {
        console.warn('Tarteel could not switch to spatial audio; returning to the original route.', cause);
        await invoke('spatial_audio_stop').catch(() => {});
        nativeAudioActiveRef.current = false;
        setNativeAudioActive(false);
        nativeEndedRef.current = false;
        persistAudioPrefs({ spatialMode: 'natural' });
        await load(index, wasPlaying, position);
        setError(`تعذّر تفعيل هذا الوضع المكاني؛ عادت التلاوة إلى المسار الطبيعي. ${String(cause?.message || cause)}`);
        return;
      }
    }
    if (nativeAudioActiveRef.current) {
      await invoke('spatial_audio_stop').catch(() => {});
      nativeAudioActiveRef.current = false;
      setNativeAudioActive(false);
    }
    nativeEndedRef.current = false;
    await load(index, wasPlaying, position);
  };

  const step = direction => {
    const shown = visibleRef.current;
    if (!shown.length) return;
    const activePosition = nativeAudioActiveRef.current ? pos : audio.current.currentTime;
    if (direction < 0 && activePosition > 3) { seekTo(0); return; }
    const ids = shown.map(track => tracksRef.current.indexOf(track));
    const at = currentRef.current === null ? -1 : ids.indexOf(currentRef.current);
    const target = ids[at < 0 ? (direction > 0 ? 0 : ids.length - 1) : (at + direction + ids.length) % ids.length];
    load(target, true);
  };
  nextRef.current = step;

  const toggle = async () => {
    if (adhanAlertRef.current) disableAdhanResume();
    if (currentRef.current === null) { if (tracksRef.current.length) await load(0, true); return; }
    try {
      if (nativeAudioActiveRef.current) {
        if (nativeEndedRef.current || (duration > 0 && pos >= duration - 0.25)) {
          await load(currentRef.current, true, 0);
        } else if (playingRef.current) {
          await invoke('spatial_audio_pause');
          setPlaying(false); playingRef.current = false;
        } else {
          await invoke('spatial_audio_resume');
          setPlaying(true); playingRef.current = true;
        }
      } else if (audio.current.paused) await audio.current.play(); else audio.current.pause();
    } catch (cause) {
      console.error('Tarteel audio toggle failed', cause);
      setError('تعذّر تشغيل الملف. تحقّق من أن الصيغة MP3 أو WAV أو OGG وأن الملف قابل للقراءة.');
    }
  };

  const seekTo = value => {
    if (!Number.isFinite(value)) return;
    if (nativeAudioActiveRef.current) {
      if (!Number.isFinite(duration) || duration <= 0) return;
      const position = Math.max(0, Math.min(value, duration));
      nativeEndedRef.current = false;
      nativeEndedHandledRef.current = false;
      setPos(position);
      invoke('spatial_audio_seek', { position }).catch(cause => {
        console.error('Tarteel native seek failed', cause);
        setError(`تعذر البحث في التلاوة المكانية: ${String(cause?.message || cause)}`);
      });
      return;
    }
    if (!Number.isFinite(audio.current.duration)) return;
    audio.current.currentTime = Math.max(0, Math.min(value, audio.current.duration));
    setPos(audio.current.currentTime);
  };
  const seekBy = seconds => seekTo((Number(nativeAudioActiveRef.current ? pos : audio.current.currentTime) || 0) + seconds);
  const seek = event => seekTo(Number(event.target.value));

  const resumeAfterAdhan = async () => {
    const pending = pendingResumeRef.current;
    const activeTrack = currentRef.current === null ? null : tracksRef.current[currentRef.current];
    if (!pending?.canResume || pending.trackPath !== activeTrack?.path) {
      clearPendingResume();
      emit('prayer-resume-failed', { message: 'لا يوجد تشغيل سابق محفوظ لهذه الصلاة؛ لن يبدأ الصوت تلقائيًا.' }).catch(() => {});
      return;
    }
    try {
      await invoke('stop_adhan').catch(() => {});
      if (nativeAudioActiveRef.current) {
        await invoke('spatial_audio_resume');
        setPlaying(true); playingRef.current = true;
      } else await audio.current.play();
      clearPendingResume();
      adhanAlertRef.current = null; setAdhanAlert(null);
      localStorage.removeItem('tarteel.adhan.alert');
      emit('prayer-resumed', { id: pending.id }).catch(() => {});
    } catch (cause) {
      console.error('Tarteel prayer resume failed', cause);
      setError(`تعذر استئناف التلاوة: ${String(cause)}`);
      emit('prayer-resume-failed', { message: `تعذر استئناف التلاوة: ${String(cause)}` }).catch(() => {});
    }
  };

  const handleAdhan = payload => {
    if (!payload?.id || payload.id === lastAdhanIdRef.current) return;
    lastAdhanIdRef.current = payload.id;

    /*
     * الأذان يُشغّل في محرك Rust لا هنا: الصفحة تُجمّد عند إخفاء النافذة
     * إلى الصينية، بينما محرك الصوت الأصلي يستمر. حراسة التكرار داخل
     * المحرك نفسه، فلا حاجة لتكرارها في الواجهة.
     */
    if (prayerConfigRef.current.adhanSound && !prayerConfigRef.current.adhanMuted) {
      invoke('play_adhan', { id: payload.id }).catch(cause => {
        console.error('Tarteel adhan playback failed', cause);
        setError(`تعذّر تشغيل الأذان: ${String(cause)}`);
        emit('adhan-playback-state', { playing: false }).catch(() => {});
      });
    }

    /* في موعد الصلاة لا نرسل إشعار ويندوز؛ الحدث يفتح بطاقة التطبيق ويشغّل ملف الأذان فقط. */
    if (!prayerConfigRef.current.adhanSound || prayerConfigRef.current.adhanMuted) {
      emit('adhan-playback-state', { playing: false }).catch(() => {});
    }
    const wasPlaying = nativeAudioActiveRef.current ? playingRef.current : !audio.current.paused;
    const playbackPosition = nativeAudioActiveRef.current ? pos : Number(audio.current.currentTime) || 0;
    const shouldPause = wasPlaying && Boolean(prayerConfigRef.current.pauseAtAdhan);
    const record = {
      id: payload.id, key: payload.key || '', name: payload.name, at: payload.at,
      createdAt: Date.now(), wasPlaying, pausedByAdhan: shouldPause, preview: Boolean(payload.preview),
    };
    if (shouldPause) {
      const activeTrack = currentRef.current === null ? null : tracksRef.current[currentRef.current];
      const pending = { id: payload.id, trackPath: activeTrack?.path || '', position: playbackPosition, canResume: Boolean(activeTrack) };
      pendingResumeRef.current = pending;
      localStorage.setItem('tarteel.adhan.resume', JSON.stringify(pending));
      if (nativeAudioActiveRef.current) {
        invoke('spatial_audio_pause').catch(cause => console.warn('Tarteel could not pause native recitation for adhan', cause));
        setPlaying(false); playingRef.current = false;
      } else audio.current.pause();
    } else clearPendingResume();
    adhanAlertRef.current = record; setAdhanAlert(record);
    localStorage.setItem('tarteel.adhan.alert', JSON.stringify(record));
  };

  /** التجربة تشغّل ملف الأذان وتعرض بطاقته داخل التطبيق فقط، بلا إشعار ويندوز. */
  const previewAlarm = async () => {
    setError('');
    const at = Date.now();
    const sample = { id: `preview-${at}`, key: 'preview', name: 'الأذان التجريبي', at, preview: true };
    handleAdhan(sample);
    emit('prayer-alarm-restore', sample).catch(cause => console.error('Tarteel adhan preview card failed', cause));
  };

  const stopAdhan = async () => {
    try {
      await invoke('stop_adhan');
    } catch (cause) {
      console.error('Tarteel adhan stop failed', cause);
      setError(`تعذّر إيقاف الأذان: ${String(cause)}`);
    }
  };

  const controls = {
    toggle, step, seekTo, seekBy, setSpeed, setSleep,
    resumeAfterAdhan, stopAdhan,
    dismissAdhan: async () => { await stopAdhan(); clearAdhanAlert(); },
    setPrayerPreference: (key, value) => updatePrayerPreferences({ [key]: Boolean(value) }),
    openPrayerSettings: () => setPrayerSettingsOpen(true),
    openLibrary: async () => {
      setFilter('all'); setQuery(''); setPrayerSettingsOpen(false);
      try {
        const appWindow = getCurrentWindow();
        await appWindow.unminimize();
        await appWindow.show();
        await appWindow.setFocus();
      } catch (cause) {
        console.error('Tarteel could not open the recitation library from the island', cause);
        setError('تعذّر فتح مكتبة التلاوات.');
      }
    }
  };
  controlsRef.current = controls;

  const active = current === null ? null : tracks[current];
  useEffect(() => {
    if (!active?.path) return;
    localStorage.setItem('tarteel.player.last-playback', JSON.stringify({ path: active.path, position: Number(pos) || 0, wasPlaying: Boolean(playing), savedAt: Date.now() }));
  }, [active?.path, pos, playing]);
  const publishPlayerState = () => emit('player-state', {
    state: active ? 'compact' : 'idle', audioState: !active ? 'no-track' : (nativeEndedRef.current || audio.current?.ended) ? 'ended' : playing ? 'playing' : 'paused', playing, fileName: active?.title || active?.file_name || '', artist: active?.artist || '',
    cover: active?.cover || null, duration: Number.isFinite(duration) ? duration : 0, position: Number.isFinite(pos) ? pos : 0,
    speed: audioPrefsRef.current.speed, sleepMode: audioPrefsRef.current.sleepMode, sleepMinutes: audioPrefsRef.current.sleepMinutes,
  }).catch(cause => console.error('Tarteel island player state event failed', cause));
  statePublisherRef.current = publishPlayerState;

  const publishPrayerState = () => emit('prayer-data', {
    schedule: prayerScheduleRef.current ? {
      source: prayerScheduleRef.current.source,
      locationSource: prayerScheduleRef.current.locationSource,
      /* الاسم العربي الكامل المبني من الهرم الجغرافي هو ما تعرضه الآيلاند،
         لا الإحداثيات ولا معرف المنطقة الزمنية. */
      locationLabel: prayerLocationLabel(prayerConfigRef.current),
      timezone: prayerScheduleRef.current.timezone,
      methodName: prayerScheduleRef.current.methodName,
      shadowFactor: prayerScheduleRef.current.shadowFactor,
      fetchedAt: prayerScheduleRef.current.fetchedAt,
      stale: Boolean(prayerScheduleRef.current.stale),
      refreshError: prayerScheduleRef.current.refreshError || '',
      events: prayerScheduleRef.current.events.map(({ id, name, key, date, at, localTime, timezone }) => ({ id, name, key, date, at, localTime, timezone }))
    } : null,
    preferences: { showNext: prayerConfigRef.current.showNext, pauseAtAdhan: prayerConfigRef.current.pauseAtAdhan, notificationsAllowed: prayerConfigRef.current.notificationsAllowed },
    alert: adhanAlertRef.current
  }).catch(cause => console.error('Tarteel island prayer state event failed', cause));

  useEffect(() => { publishPlayerState(); }, [active, playing, duration, pos]);
  useEffect(() => { publishPrayerState(); }, [prayerSchedule, prayerConfig.showNext, prayerConfig.pauseAtAdhan, prayerConfig.notificationsAllowed, adhanAlert]);

  useEffect(() => {
    let unlistenControl;
    let unlistenReady;
    let unlistenAlarm;
    let unlistenPlayback;
    let unlistenSleep;
    let unlistenDismiss;
    let unlistenIslandError;
    Promise.all([
      listen('island-control', event => {
        const payload = event.payload || {};
        if (payload.action === 'toggle') controlsRef.current.toggle();
        if (payload.action === 'previous') controlsRef.current.step(-1);
        if (payload.action === 'next') controlsRef.current.step(1);
        if (payload.action === 'seek') controlsRef.current.seekTo(Number(payload.position));
        if (payload.action === 'seek-by') controlsRef.current.seekBy(Number(payload.seconds));
        if (payload.action === 'set-speed') controlsRef.current.setSpeed(payload.value);
        if (payload.action === 'set-sleep') controlsRef.current.setSleep(String(payload.value));
        if (payload.action === 'set-prayer-preference') controlsRef.current.setPrayerPreference(payload.key, payload.value);
        if (payload.action === 'resume-after-adhan') controlsRef.current.resumeAfterAdhan();
        if (payload.action === 'stop-adhan') controlsRef.current.stopAdhan();
        if (payload.action === 'dismiss-adhan') controlsRef.current.dismissAdhan();
        if (payload.action === 'open-prayer-settings') controlsRef.current.openPrayerSettings();
        if (payload.action === 'open-library') controlsRef.current.openLibrary();
      }),
      listen('island-ready', () => {
        statePublisherRef.current(); publishPrayerState();
        emit('main-ready').catch(cause => console.error('Tarteel main-ready acknowledgement failed', cause));
        if (restoreReadyRef.current && adhanAlertRef.current && Date.now() - adhanAlertRef.current.createdAt < 12 * 60 * 60 * 1000) emit('prayer-alarm-restore', adhanAlertRef.current).catch(() => {});
      }),
      listen('prayer-adhan', event => handleAdhan(event.payload || {})),
      listen('adhan-playback-state', event => {
        const payload = event.payload || {};
        if (!payload.ended || adhanAlertRef.current?.id !== payload.id) return;
        clearAdhanAlert();
      }),
      listen('sleep-deadline', () => {
        if (nativeAudioActiveRef.current) {
          invoke('spatial_audio_pause').catch(cause => console.warn('Tarteel sleep timer could not pause native audio', cause));
          setPlaying(false); playingRef.current = false;
        } else audio.current.pause();
        disableAdhanResume();
        persistAudioPrefs({ sleepMode: 'off', sleepMinutes: 0, sleepDeadline: null });
        setError('انتهى مؤقت النوم وأُوقفت التلاوة.');
        statePublisherRef.current();
      }),
      listen('prayer-alert-dismissed', () => controlsRef.current.dismissAdhan()),
      listen('island-error', event => setError(String(event.payload?.message || 'تعذر تغيير حجم نافذة الجزيرة.')))
    ]).then(([control, ready, alarm, playback, sleepListener, dismiss, islandError]) => {
      unlistenControl = control; unlistenReady = ready; unlistenAlarm = alarm; unlistenPlayback = playback; unlistenSleep = sleepListener; unlistenDismiss = dismiss; unlistenIslandError = islandError;
      emit('main-ready').catch(cause => console.error('Tarteel startup-ready acknowledgement failed', cause));
    }).catch(cause => {
      console.error('Tarteel event listeners failed to initialize', cause);
      setError(`تعذر تهيئة ربط أحداث الصوت/الصلاة: ${String(cause)}`);
    });
    return () => { unlistenControl?.(); unlistenReady?.(); unlistenAlarm?.(); unlistenPlayback?.(); unlistenSleep?.(); unlistenDismiss?.(); unlistenIslandError?.(); };
  }, []);

  const changeVolume = event => {
    const value = Number(event.target.value);
    setVolume(value); audio.current.volume = value / 100;
    if (nativeAudioActiveRef.current) invoke('spatial_audio_set_volume', { volume: value }).catch(cause => console.warn('Tarteel native volume update failed', cause));
  };

  if (prayerSettingsOpen) {
    return <PrayerSettings config={prayerConfig} schedule={prayerSchedule} audioMode={audioPrefs.spatialMode} onAudioModeChange={setSpatialMode} onClose={() => setPrayerSettingsOpen(false)} onSave={savePrayerSettings} onPreviewAlarm={previewAlarm} />;
  }

  return <>
    <header className="bar">
      <div className="brand glass rim"><div className="mark">ت</div><b>تَرتيل</b></div>
      <div className="tabs glass rim" role="group" aria-label="التصفية"><button className="rim" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>المكتبة</button><button className="rim" aria-pressed={filter === 'fav'} onClick={() => setFilter('fav')}>المفضلة</button></div>
      <div className="tools"><label className="search glass rim"><Icon name="search"/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="ابحث عن سورة أو قارئ" aria-label="بحث"/></label><button className="circle glass btn rim" aria-label="اختيار مجلد الصوت" onClick={selectFolder}><Icon name="folder"/></button><button className="circle glass btn rim" aria-label="إعدادات الصلاة والموقع" onClick={() => setPrayerSettingsOpen(true)}><Icon name="sliders"/></button></div>
    </header>
    <main>
      <h1>{filter === 'all' ? 'المكتبة' : 'المفضلة'}</h1><p className="sub">{count(visible.length)}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {!tracks.length ? <div className="empty">{busy ? 'جارٍ فحص مجلد الصوت…' : 'اختر مجلد الصوت لبدء مكتبتك'}</div> : visible.length ? <div className="list" role="list">{visible.map(track => {
        const index = tracks.indexOf(track), on = index === current;
        return <div className={`row${on ? ' on' : ''}`} role="listitem" key={track.path}><button className="hit" onClick={() => load(index, true)} aria-current={on ? 'true' : undefined}><span className="cover">{track.cover ? <img src={track.cover} alt=""/> : on && playing ? <span className="eq"><i/><i/><i/></span> : track.file_name.slice(0, 1)}</span><span className="meta"><b title={track.file_name}>{track.file_name}</b><span>{track.artist || 'ملف صوتي محلي'}</span></span><span className="dur">{track.duration ? fmt(track.duration) : '—'}</span></button><button className="fav rim" aria-pressed={favorites.has(index)} aria-label={`المفضلة: ${track.file_name}`} onClick={() => setFavorites(old => { const next = new Set(old); next.has(index) ? next.delete(index) : next.add(index); return next; })}><Icon name="heart" filled={favorites.has(index)}/></button></div>;
      })}</div> : <p className="empty">{query.trim() ? 'لا توجد نتائج' : 'لم تُضف أي تلاوة إلى المفضلة بعد'}</p>}
    </main>
    <footer className="player glass big"><div className="pr"><div className="now">{active ? <div className="cover">{active.cover ? <img src={active.cover} alt=""/> : active.file_name.slice(0, 1)}</div> : <div className="cover">ت</div>}<div className="meta"><b title={active?.file_name || ''}>{active?.title || active?.file_name || ''}</b><span>{active?.artist || ''}</span></div></div><div className="ctl"><button className="tbtn rim" onClick={() => step(-1)} aria-label="السابق"><Transport type="prev"/></button><button className="tbtn play rim" onClick={toggle} aria-label={playing ? 'إيقاف مؤقت' : 'تشغيل'}>{playing ? <Transport type="pause"/> : <Transport type="play"/>}</button><button className="tbtn rim" onClick={() => step(1)} aria-label="التالي"><Transport type="next"/></button></div><div className="vol"><input type="range" min="0" max="100" value={volume} onChange={changeVolume} style={{ '--p': `${volume}%` }} aria-label="مستوى الصوت"/><Icon name="volume"/></div></div><div className="seek"><span>{fmt(pos)}</span><input type="range" min="0" max={duration || 0} step="any" value={Math.min(pos, duration || 0)} onChange={seek} style={{ '--p': `${duration ? pos / duration * 100 : 0}%` }} aria-label="التقدّم"/><span>{fmt(duration)}</span></div></footer>
  </>;
}

/**
 * حاجز أخطاء أعلى الشجرة.
 *
 * لماذا وُجد: خطأ واحد في أي مكوّن أثناء الرسم يُفرّغ شجرة React بالكامل،
 * فيظهر التطبيق كشاشة سوداء بلا أي تفسير للمستخدم أو للمطوّر — وهو ما حدث
 * فعلًا عندما استقبل PrayerSettings خاصية غير معرّفة.
 *
 * هذا الحاجز لا يصلح الخطأ؛ وظيفته أن يجعل الفشل مرئيًا وقابلًا للتشخيص
 * بدل أن يختفي. أي خطأ غير متوقع يظهر برساله الحقيقية.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Tarteel crashed while rendering', error, info);
    this.setState({ info });
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div dir="rtl" style={{
        padding: '32px', fontFamily: 'Segoe UI, system-ui, sans-serif',
        color: '#fff', background: '#0b0b0d', minHeight: '100vh', lineHeight: 1.8,
      }}>
        <h1 style={{ fontSize: 20, marginBottom: 12 }}>تعذّر عرض واجهة تَرتيل</h1>
        <p style={{ color: '#b9b9c0', marginBottom: 16 }}>
          حدث خطأ غير متوقع أثناء الرسم. الرسالة أدناه هي السبب الفعلي، وليست سببًا افتراضيًا.
        </p>
        <pre style={{
          padding: 16, borderRadius: 12, background: '#17171b',
          color: '#ff9d9d', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13,
        }}>{String(error?.stack || error?.message || error)}</pre>
        {info?.componentStack && (
          <pre style={{
            marginTop: 12, padding: 16, borderRadius: 12, background: '#17171b',
            color: '#b9b9c0', whiteSpace: 'pre-wrap', fontSize: 12,
          }}>{info.componentStack}</pre>
        )}
      </div>
    );
  }
}

createRoot(document.getElementById('root')).render(
  <ErrorBoundary><App/></ErrorBoundary>
);
