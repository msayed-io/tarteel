import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import PrayerSettings from './PrayerSettings.jsx';
import { resolveLocation, readDevicePosition, locationNeedsRefresh, describeLocationError } from './engine/location.js';
import { buildSchedule, scheduleNeedsRebuild, alarmEvents, upcoming, current as currentPrayerOf, countdownLabel } from './engine/schedule.js';
import './styles.css';

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
const readJson = (key, fallback) => { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const DEFAULT_PRAYER_CONFIG = {
  location: null, showNext: false, pauseAtAdhan: true,
  notificationsAllowed: false, adhanSound: true, adhanVolume: 80,
  preAlarmMinutes: 0, adjust: {},
};
const DEFAULT_AUDIO_PREFS = { speed: 1, sleepMode: 'off', sleepMinutes: 0, sleepDeadline: null };
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
  return ({ mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
    webm: 'audio/webm', flac: 'audio/flac', m4a: 'audio/mp4', mp4: 'audio/mp4' })[ext] || '';
};

function App() {
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
  const [audioPrefs, setAudioPrefs] = useState(() => ({ ...DEFAULT_AUDIO_PREFS, ...(readJson('tarteel.audio.settings', {}) || {}) }));
  const audio = useRef(null);
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
  currentRef.current = current;
  playingRef.current = playing;
  adhanAlertRef.current = adhanAlert;

  if (!audio.current) {
    audio.current = new Audio();
    audio.current.preload = 'metadata';
    audio.current.playbackRate = Number(audioPrefs.speed) || 1;
  }

  useEffect(() => { localStorage.setItem('tarteel.library', JSON.stringify(tracks)); }, [tracks]);
  useEffect(() => { localStorage.setItem('tarteel.favorites', JSON.stringify([...favorites])); }, [favorites]);
  useEffect(() => { localStorage.setItem('tarteel.volume', String(volume)); }, [volume]);
  useEffect(() => { localStorage.setItem('tarteel.prayer.settings', JSON.stringify(prayerConfig)); }, [prayerConfig]);
  useEffect(() => { if (adhanAlert) localStorage.setItem('tarteel.adhan.alert', JSON.stringify(adhanAlert)); else localStorage.removeItem('tarteel.adhan.alert'); }, [adhanAlert]);

  const persistAudioPrefs = patch => {
    const next = { ...audioPrefsRef.current, ...patch };
    audioPrefsRef.current = next;
    setAudioPrefs(next);
    localStorage.setItem('tarteel.audio.settings', JSON.stringify(next));
    if (audio.current && Number.isFinite(Number(next.speed))) audio.current.playbackRate = Number(next.speed);
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
    const events = (schedule?.events || []).map(({ id, key, name, at }) => ({ id, key, name, at }));
    await invoke('set_alarm_schedule', { events });
    /* فشل مهام ويندوز لا يُسقط الجدولة المقيمة: تُغطّى الحالتان معًا. */
    invoke('sync_windows_tasks', { aheadMs: 7 * 24 * 3600 * 1000 })
      .catch(cause => console.error('Tarteel could not sync Windows tasks', cause));
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
    const built = buildSchedule(config.location, { adjust: config.adjust });
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
    setPrayerSettingsOpen(false);
    if (!next.notificationsAllowed) {
      setError('المواقيت محدّثة، لكن إشعارات ويندوز غير ممنوحة؛ ستظهر البطاقة داخل التطبيق فقط.');
    }
    return result;
  };

  useEffect(() => {
    const a = audio.current;
    const onTime = () => setPos(Number.isFinite(a.currentTime) ? a.currentTime : 0);
    const onMetadata = () => setDuration(Number.isFinite(a.duration) ? a.duration : 0);
    const onPlay = () => { setPlaying(true); playingRef.current = true; };
    const onPause = () => { setPlaying(false); playingRef.current = false; };
    const onEnded = () => {
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
      const code = a.error?.code || 0;
      console.error('Tarteel audio engine error', { code, mediaError: a.error?.message || 'unknown' });
      setPlaying(false);
      setError('تعذّر فك ترميز الملف الصوتي. جرّب MP3 أو WAV أو OGG مدعومًا.');
    };
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMetadata);
    a.addEventListener('durationchange', onMetadata);
    a.addEventListener('play', onPlay);
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
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('ended', onEnded);
      a.removeEventListener('error', onError);
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
      await invoke('set_audio_root', { path: picked });
      const found = await invoke('scan_directory', { path: picked });
      setTracks(found);
      localStorage.setItem('tarteel.folder', picked);
      setCurrent(found.length ? 0 : null);
      setDuration(0); setPos(0); setPlaying(false);
    } catch (cause) {
      console.error('Tarteel directory scan failed', { message: String(cause) });
      setError(`تعذّر فحص المجلد: ${String(cause)}`);
    } finally { setBusy(false); }
  };

  const load = async (index, autoplay = true) => {
    const track = tracksRef.current[index];
    if (!track) return;
    const mime = mimeFor(track.path);
    if (!mime) { setError('صيغة الملف غير مدعومة في مشغل Windows هذا.'); return; }
    try {
      setError('');
      if (adhanAlertRef.current) disableAdhanResume(); else clearPendingResume();
      const a = audio.current;
      a.pause();
      a.src = await invoke('audio_url', { path: track.path });
      a.volume = volume / 100;
      a.playbackRate = Number(audioPrefsRef.current.speed) || 1;
      a.load();
      setCurrent(index); currentRef.current = index; setPos(0); setDuration(0);
      if (autoplay) await a.play();
    } catch (cause) {
      console.error('Tarteel audio load failed', { mime, message: String(cause) });
      setPlaying(false);
      setError(`تعذّر تشغيل «${track.file_name}». الملف قد يكون تالفًا أو بصيغة لا يدعمها WebView2.`);
    }
  };

  const step = direction => {
    const shown = visibleRef.current;
    if (!shown.length) return;
    if (direction < 0 && audio.current.currentTime > 3) { audio.current.currentTime = 0; setPos(0); return; }
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
      if (audio.current.paused) await audio.current.play(); else audio.current.pause();
    } catch (cause) {
      console.error('Tarteel audio toggle failed', cause);
      setError('تعذّر تشغيل الملف. تحقّق من أن الصيغة MP3 أو WAV أو OGG وأن الملف قابل للقراءة.');
    }
  };

  const seekTo = value => {
    if (!Number.isFinite(value) || !Number.isFinite(audio.current.duration)) return;
    audio.current.currentTime = Math.max(0, Math.min(value, audio.current.duration));
    setPos(audio.current.currentTime);
  };
  const seekBy = seconds => seekTo((Number(audio.current.currentTime) || 0) + seconds);
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
      await audio.current.play();
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
    const wasPlaying = !audio.current.paused;
    const shouldPause = wasPlaying && Boolean(prayerConfigRef.current.pauseAtAdhan);
    const record = {
      id: payload.id, key: payload.key || '', name: payload.name, at: payload.at,
      createdAt: Date.now(), wasPlaying, pausedByAdhan: shouldPause,
    };
    if (shouldPause) {
      const activeTrack = currentRef.current === null ? null : tracksRef.current[currentRef.current];
      const pending = { id: payload.id, trackPath: activeTrack?.path || '', position: Number(audio.current.currentTime) || 0, canResume: Boolean(activeTrack) };
      pendingResumeRef.current = pending;
      localStorage.setItem('tarteel.adhan.resume', JSON.stringify(pending));
      audio.current.pause();
    } else clearPendingResume();
    if (payload.notificationError) {
      record.notificationError = payload.notificationError;
      setError(`وصل موعد الصلاة إلى التطبيق، لكن إشعار Windows فشل: ${payload.notificationError}. تحقق من إذن الإشعارات وإعدادات Focus.`);
    } else if (!prayerConfigRef.current.notificationsAllowed) {
      record.notificationError = 'notification-permission-not-granted';
      setError('وصل تنبيه الصلاة داخل التطبيق، لكن إشعار Windows غير ممنوح.');
    }
    adhanAlertRef.current = record; setAdhanAlert(record);
    localStorage.setItem('tarteel.adhan.alert', JSON.stringify(record));
  };

  /** تجربة التنبيه: يُطلق حدثًا حقيقيًا عبر Rust ليعمل بنفس المسار الفعلي. */
  const previewAlarm = async () => {
    try {
      await invoke('fire_alarm_now', { key: null });
    } catch (cause) {
      /* لا يوجد موعد قادم في الجدول: نعرض بطاقة اختبار مباشرة بدل الفشل الصامت. */
      const sample = { id: 'preview', key: 'fajr', name: 'الفجر', at: Date.now(), createdAt: Date.now(), wasPlaying: false, pausedByAdhan: false };
      adhanAlertRef.current = sample;
      setAdhanAlert(sample);
      console.warn('Tarteel alarm preview fell back to a local card', cause);
    }
  };

  const controls = {
    toggle, step, seekTo, seekBy, setSpeed, setSleep,
    resumeAfterAdhan, dismissAdhan: clearAdhanAlert,
    setPrayerPreference: (key, value) => updatePrayerPreferences({ [key]: Boolean(value) }),
    openPrayerSettings: () => setPrayerSettingsOpen(true)
  };
  controlsRef.current = controls;

  const active = current === null ? null : tracks[current];
  useEffect(() => {
    if (!active?.path) return;
    localStorage.setItem('tarteel.player.last-playback', JSON.stringify({ path: active.path, position: Number(pos) || 0, wasPlaying: Boolean(playing), savedAt: Date.now() }));
  }, [active?.path, pos, playing]);
  const publishPlayerState = () => emit('player-state', {
    state: active ? 'compact' : 'idle', playing, fileName: active?.title || active?.file_name || '', artist: active?.artist || '',
    cover: active?.cover || null, duration: Number.isFinite(duration) ? duration : 0, position: Number.isFinite(pos) ? pos : 0,
    speed: audioPrefsRef.current.speed, sleepMode: audioPrefsRef.current.sleepMode, sleepMinutes: audioPrefsRef.current.sleepMinutes,
    prayerAlert: adhanAlertRef.current?.notificationError || ''
  }).catch(cause => console.error('Tarteel island player state event failed', cause));
  statePublisherRef.current = publishPlayerState;

  const publishPrayerState = () => emit('prayer-data', {
    schedule: prayerScheduleRef.current ? {
      source: prayerScheduleRef.current.source,
      locationSource: prayerScheduleRef.current.locationSource,
      locationLabel: prayerScheduleRef.current.locationLabel,
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
        if (payload.action === 'dismiss-adhan') controlsRef.current.dismissAdhan();
        if (payload.action === 'open-prayer-settings') controlsRef.current.openPrayerSettings();
      }),
      listen('island-ready', () => {
        statePublisherRef.current(); publishPrayerState();
        emit('main-ready').catch(cause => console.error('Tarteel main-ready acknowledgement failed', cause));
        if (restoreReadyRef.current && adhanAlertRef.current && Date.now() - adhanAlertRef.current.createdAt < 12 * 60 * 60 * 1000) emit('prayer-alarm-restore', adhanAlertRef.current).catch(() => {});
      }),
      listen('prayer-adhan', event => handleAdhan(event.payload || {})),
      listen('sleep-deadline', () => {
        audio.current.pause();
        disableAdhanResume();
        persistAudioPrefs({ sleepMode: 'off', sleepMinutes: 0, sleepDeadline: null });
        setError('انتهى مؤقت النوم وأُوقفت التلاوة.');
        statePublisherRef.current();
      }),
      listen('prayer-alert-dismissed', () => controlsRef.current.dismissAdhan()),
      listen('island-error', event => setError(String(event.payload?.message || 'تعذر تغيير حجم نافذة الجزيرة.')))
    ]).then(([control, ready, alarm, sleepListener, dismiss, islandError]) => {
      unlistenControl = control; unlistenReady = ready; unlistenAlarm = alarm; unlistenSleep = sleepListener; unlistenDismiss = dismiss; unlistenIslandError = islandError;
    }).catch(cause => {
      console.error('Tarteel event listeners failed to initialize', cause);
      setError(`تعذر تهيئة ربط أحداث الصوت/الصلاة: ${String(cause)}`);
    });
    return () => { unlistenControl?.(); unlistenReady?.(); unlistenAlarm?.(); unlistenSleep?.(); unlistenDismiss?.(); unlistenIslandError?.(); };
  }, []);

  const changeVolume = event => {
    const value = Number(event.target.value);
    setVolume(value); audio.current.volume = value / 100;
  };

  return <>
    <header className="bar">
      <div className="brand glass"><div className="mark">ت</div><b>تَرتيل</b></div>
      <div className="tabs glass" role="group" aria-label="التصفية"><button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>المكتبة</button><button aria-pressed={filter === 'fav'} onClick={() => setFilter('fav')}>المفضلة</button></div>
      <div className="tools"><label className="search glass"><Icon name="search"/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="ابحث عن سورة أو قارئ" aria-label="بحث"/></label><button className="circle glass btn" aria-label="اختيار مجلد الصوت" onClick={selectFolder}><Icon name="folder"/></button><button className="circle glass btn" aria-label="إعدادات الصلاة والموقع" onClick={() => setPrayerSettingsOpen(true)}><Icon name="sliders"/></button></div>
    </header>
    <main>
      <h1>{filter === 'all' ? 'المكتبة' : 'المفضلة'}</h1><p className="sub">{count(visible.length)}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {!tracks.length ? <div className="empty">{busy ? 'جارٍ فحص مجلد الصوت…' : 'اختر مجلد الصوت لبدء مكتبتك'}</div> : visible.length ? <div className="list" role="list">{visible.map(track => {
        const index = tracks.indexOf(track), on = index === current;
        return <div className={`row${on ? ' on' : ''}`} role="listitem" key={track.path}><button className="hit" onClick={() => load(index, true)} aria-current={on ? 'true' : undefined}><span className="cover">{track.cover ? <img src={track.cover} alt=""/> : on && playing ? <span className="eq"><i/><i/><i/></span> : track.file_name.slice(0, 1)}</span><span className="meta"><b title={track.file_name}>{track.file_name}</b><span>{track.artist || 'ملف صوتي محلي'}</span></span><span className="dur">{track.duration ? fmt(track.duration) : '—'}</span></button><button className="fav" aria-pressed={favorites.has(index)} aria-label={`المفضلة: ${track.file_name}`} onClick={() => setFavorites(old => { const next = new Set(old); next.has(index) ? next.delete(index) : next.add(index); return next; })}><Icon name="heart" filled={favorites.has(index)}/></button></div>;
      })}</div> : <p className="empty">{query.trim() ? 'لا توجد نتائج' : 'لم تُضف أي تلاوة إلى المفضلة بعد'}</p>}
    </main>
    <footer className="player glass big"><div className="pr"><div className="now">{active ? <div className="cover">{active.cover ? <img src={active.cover} alt=""/> : active.file_name.slice(0, 1)}</div> : <div className="cover">ت</div>}<div className="meta"><b title={active?.file_name || ''}>{active?.title || active?.file_name || ''}</b><span>{active?.artist || ''}</span></div></div><div className="ctl"><button className="tbtn" onClick={() => step(-1)} aria-label="السابق"><Transport type="prev"/></button><button className="tbtn play" onClick={toggle} aria-label={playing ? 'إيقاف مؤقت' : 'تشغيل'}>{playing ? <Transport type="pause"/> : <Transport type="play"/>}</button><button className="tbtn" onClick={() => step(1)} aria-label="التالي"><Transport type="next"/></button></div><div className="vol"><input type="range" min="0" max="100" value={volume} onChange={changeVolume} style={{ '--p': `${volume}%` }} aria-label="مستوى الصوت"/><Icon name="volume"/></div></div><div className="seek"><span>{fmt(pos)}</span><input type="range" min="0" max={duration || 0} step="any" value={Math.min(pos, duration || 0)} onChange={seek} style={{ '--p': `${duration ? pos / duration * 100 : 0}%` }} aria-label="التقدّم"/><span>{fmt(duration)}</span></div></footer>
    {prayerSettingsOpen && <PrayerSettings config={prayerConfig} schedule={prayerSchedule} onClose={() => setPrayerSettingsOpen(false)} onSave={savePrayerSettings} onPreviewAlarm={previewAlarm}/>}
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
