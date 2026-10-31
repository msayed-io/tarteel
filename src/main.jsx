import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { checkPermissions, clearWatch, watchPosition } from '@tauri-apps/plugin-geolocation';
import PrayerSettings from './PrayerSettings.jsx';
import { findNextPrayer, getTodayPrayerEvents, haversineKm, loadPrayerSchedule, prayerTransition, sleepTransition } from './prayer.js';
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
const DEFAULT_PRAYER_CONFIG = { location: null, methodId: null, school: null, showNext: false, pauseAtAdhan: true, notificationsAllowed: false };
const DEFAULT_AUDIO_PREFS = { speed: 1, sleepMode: 'off', sleepMinutes: 0, sleepDeadline: null };
const prayerSignature = config => {
  if (!config?.location) return '';
  const loc = config.location;
  return `${loc.source}|${Number(loc.latitude).toFixed(5)}|${Number(loc.longitude).toFixed(5)}|${loc.timezone || ''}|${config.methodId}|${config.school}`;
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
  const [prayerSettingsOpen, setPrayerSettingsOpen] = useState(() => !initialConfig.location || initialConfig.methodId === null || initialConfig.school === null);
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

  const publishScheduleToNative = async schedule => {
    await invoke('set_prayer_schedule', { events: (schedule?.events || []).map(({ id, name, at }) => ({ id, name, at })) });
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

  const loadAndPublishSchedule = async (config, { allowStale = false } = {}) => {
    const requestId = ++scheduleRequestRef.current;
    const signature = prayerSignature(config);
    try {
      const fresh = await loadPrayerSchedule({ location: config.location, methodId: config.methodId, school: config.school });
      if (requestId !== scheduleRequestRef.current) return prayerScheduleRef.current;
      const saved = await storePrayerSchedule(config, fresh);
      setError('');
      return saved;
    } catch (cause) {
      console.error('Tarteel prayer schedule refresh failed', cause);
      if (requestId !== scheduleRequestRef.current) throw cause;
      const stored = readStoredSchedule(config);
      if (allowStale && stored) {
        const stale = { ...stored, stale: true, refreshError: String(cause?.message || cause) };
        const saved = await storePrayerSchedule(config, stale);
        setError(`تعذر تحديث المواقيت من المصدر. يُعرض جدول محفوظ من ${new Date(stored.fetchedAt).toLocaleString('ar')} لنفس الموقع وطريقة الحساب فقط؛ ${String(cause?.message || cause)}`);
        return saved;
      }
      prayerScheduleRef.current = null;
      setPrayerSchedule(null);
      localStorage.removeItem('tarteel.prayer.schedule');
      await publishScheduleToNative(null).catch(nativeError => {
        console.error('Tarteel could not clear an obsolete prayer schedule', nativeError);
      });
      setError('لم تُعرض مواقيت؛ لا توجد بيانات حديثة أو محفوظة لنفس إعداد الموقع. ' + String(cause?.message || cause));
      throw cause;
    }
  };

  const stopLocationWatch = () => {
    if (locationWatchRef.current !== null) {
      clearWatch(locationWatchRef.current).catch(cause => console.error('Tarteel location watch cleanup failed', cause));
      locationWatchRef.current = null;
    }
  };

  const startLocationWatch = async config => {
    stopLocationWatch();
    if (config.location?.source !== 'device') return;
    try {
      const permission = await checkPermissions();
      if (permission?.location !== 'granted') return;
      const watchId = await watchPosition({ enableHighAccuracy: false, maximumAge: 60_000, timeout: 30_000 }, async (position, watchError) => {
        if (watchError) {
          console.error('Tarteel device location watch error', watchError);
          return;
        }
        const latest = prayerConfigRef.current;
        if (latest.location?.source !== 'device' || !Number.isFinite(position?.coords?.latitude) || !Number.isFinite(position?.coords?.longitude)) return;
        const point = { latitude: Number(position.coords.latitude), longitude: Number(position.coords.longitude) };
        if (haversineKm(latest.location, point) < 5) return;
        const changed = { ...latest, location: { ...latest.location, ...point, accuracy: Number(position.coords.accuracy) || null } };
        prayerConfigRef.current = changed;
        setPrayerConfig(changed);
        localStorage.setItem('tarteel.prayer.settings', JSON.stringify(changed));
        setError('تغيّر موقع الجهاز؛ جارٍ تحديث المواقيت والمنطقة الزمنية.');
        try { await loadAndPublishSchedule(changed); }
        catch (cause) { console.error('Tarteel location-change prayer refresh failed', cause); }
      });
      locationWatchRef.current = watchId;
    } catch (cause) {
      console.error('Tarteel could not start location change tracking', cause);
      setError(`تعذر متابعة تغيّر موقع الجهاز: ${String(cause)}`);
    }
  };

  const savePrayerSettings = async selected => {
    const next = { ...prayerConfigRef.current, ...selected };
    const oldSignature = prayerSignature(prayerConfigRef.current);
    const newSignature = prayerSignature(next);
    prayerConfigRef.current = next;
    setPrayerConfig(next);
    localStorage.setItem('tarteel.prayer.settings', JSON.stringify(next));
    if (oldSignature && oldSignature !== newSignature) {
      scheduleRequestRef.current++;
      prayerScheduleRef.current = null;
      setPrayerSchedule(null);
      localStorage.removeItem('tarteel.prayer.schedule');
      await publishScheduleToNative(null);
    }
    const result = await loadAndPublishSchedule(next, { allowStale: oldSignature === newSignature });
    if (next.location.source === 'device') await startLocationWatch(next);
    else stopLocationWatch();
    setPrayerSettingsOpen(false);
    if (!next.notificationsAllowed) setError('المواقيت محدثة، لكن إذن إشعارات Windows غير ممنوح؛ لن يظهر تنبيه النظام حتى يُسمح به.');
    return result;
  };

  useEffect(() => {
    const a = audio.current;
    const onTime = () => setPos(Number.isFinite(a.currentTime) ? a.currentTime : 0);
    const onMetadata = () => setDuration(Number.isFinite(a.duration) ? a.duration : 0);
    const onPlay = () => { setPlaying(true); playingRef.current = true; };
    const onPause = () => { setPlaying(false); playingRef.current = false; };
    const onEnded = () => {
      const transition = sleepTransition({ mode: audioPrefsRef.current.sleepMode, deadline: audioPrefsRef.current.sleepDeadline, trackEnded: true });
      if (transition.stop) {
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
    if (!config.location || config.methodId === null || config.school === null) {
      invoke('set_prayer_schedule', { events: [] }).catch(cause => console.error('Tarteel could not clear prayer schedule on startup', cause));
      return;
    }
    if (cached) {
      prayerScheduleRef.current = cached;
      setPrayerSchedule(cached);
      publishScheduleToNative(cached).catch(cause => setError(`تعذر استعادة جدولة مواقيت الصلاة: ${String(cause)}`));
    }
    loadAndPublishSchedule(config, { allowStale: true }).catch(cause => console.error('Tarteel startup schedule unavailable', cause));
    if (config.location.source === 'device') startLocationWatch(config);
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
        if (day && currentDay !== day) loadAndPublishSchedule(prayerConfigRef.current, { allowStale: true }).catch(cause => console.error('Tarteel midnight prayer refresh failed', cause));
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
    const transition = prayerTransition({ wasPlaying: !audio.current.paused, pauseAtAdhan: prayerConfigRef.current.pauseAtAdhan });
    const record = {
      id: payload.id, name: payload.name, at: payload.at, createdAt: Date.now(),
      wasPlaying: !audio.current.paused, pausedByAdhan: transition.shouldPause
    };
    if (transition.shouldPause) {
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
      methodId: prayerScheduleRef.current.methodId,
      school: prayerScheduleRef.current.school,
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
    <PrayerSettings open={prayerSettingsOpen} value={prayerConfig} onClose={() => setPrayerSettingsOpen(false)} onSave={savePrayerSettings}/>
  </>;
}

createRoot(document.getElementById('root')).render(<App/>);
