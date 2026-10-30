import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
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
  const [tracks, setTracks] = useState(() => JSON.parse(localStorage.getItem('tarteel.library') || '[]'));
  const [favorites, setFavorites] = useState(() => new Set(JSON.parse(localStorage.getItem('tarteel.favorites') || '[]')));
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => Math.min(100, Math.max(0, Number(localStorage.getItem('tarteel.volume') || 70))));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const audio = useRef(null);
  const nextRef = useRef(() => {});
  const tracksRef = useRef(tracks);
  const visibleRef = useRef([]);
  const controlsRef = useRef({});
  const statePublisherRef = useRef(() => Promise.resolve());
  tracksRef.current = tracks;

  if (!audio.current) {
    audio.current = new Audio();
    audio.current.preload = 'metadata';
  }

  useEffect(() => { localStorage.setItem('tarteel.library', JSON.stringify(tracks)); }, [tracks]);
  useEffect(() => { localStorage.setItem('tarteel.favorites', JSON.stringify([...favorites])); }, [favorites]);
  useEffect(() => { localStorage.setItem('tarteel.volume', String(volume)); }, [volume]);

  useEffect(() => {
    const a = audio.current;
    const onTime = () => setPos(Number.isFinite(a.currentTime) ? a.currentTime : 0);
    const onMetadata = () => setDuration(Number.isFinite(a.duration) ? a.duration : 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => nextRef.current(1);
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
    return () => {
      a.pause();
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMetadata);
      a.removeEventListener('durationchange', onMetadata);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('ended', onEnded);
      a.removeEventListener('error', onError);
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
      const a = audio.current;
      a.pause();
      a.src = await invoke('audio_url', { path: track.path });
      a.volume = volume / 100;
      a.load();
      setCurrent(index); setPos(0); setDuration(0);
      if (autoplay) {
        await a.play();
      }
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
    const at = current === null ? -1 : ids.indexOf(current);
    const target = ids[at < 0 ? (direction > 0 ? 0 : ids.length - 1) : (at + direction + ids.length) % ids.length];
    load(target, true);
  };
  nextRef.current = step;

  const toggle = async () => {
    if (current === null) { if (tracks.length) await load(0, true); return; }
    try {
      if (audio.current.paused) await audio.current.play(); else audio.current.pause();
    } catch (cause) {
      console.error('Tarteel audio toggle failed', { message: String(cause) });
      setError('تعذّر تشغيل الملف. تحقّق من أن الصيغة MP3 أو WAV أو OGG وأن الملف قابل للقراءة.');
    }
  };

  const seek = event => {
    const value = Number(event.target.value);
    seekTo(value);
  };
  const seekTo = value => {
    if (!Number.isFinite(value) || !Number.isFinite(audio.current.duration)) return;
    audio.current.currentTime = Math.max(0, Math.min(value, audio.current.duration));
    setPos(audio.current.currentTime);
  };
  const active = current === null ? null : tracks[current];
  controlsRef.current = { toggle, step, seekTo };

  const publishPlayerState = () => emit('player-state', {
    state: active ? 'compact' : 'idle', playing, fileName: active?.file_name || '', artist: active?.artist || '',
    cover: active?.cover || null, duration: Number.isFinite(duration) ? duration : 0, position: Number.isFinite(pos) ? pos : 0
  }).catch(cause => console.error('Tarteel island state event failed', { message: String(cause) }));
  statePublisherRef.current = publishPlayerState;

  useEffect(() => {
    publishPlayerState();
    return undefined;
  }, [active, playing, duration, pos]);

  useEffect(() => {
    let unlistenControl;
    let unlistenReady;
    Promise.all([
      listen('island-control', event => {
        const payload = event.payload || {};
        if (payload.action === 'toggle') controlsRef.current.toggle();
        if (payload.action === 'previous') controlsRef.current.step(-1);
        if (payload.action === 'next') controlsRef.current.step(1);
        if (payload.action === 'seek') controlsRef.current.seekTo(Number(payload.position));
      }),
      listen('island-ready', () => statePublisherRef.current())
    ]).then(([control, ready]) => { unlistenControl = control; unlistenReady = ready; });
    return () => { unlistenControl?.(); unlistenReady?.(); };
  }, []);

  return <>
    <header className="bar">
      <div className="brand glass"><div className="mark">ت</div><b>تَرتيل</b></div>
      <div className="tabs glass" role="group" aria-label="التصفية"><button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>المكتبة</button><button aria-pressed={filter === 'fav'} onClick={() => setFilter('fav')}>المفضلة</button></div>
      <div className="tools"><label className="search glass"><Icon name="search"/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="ابحث عن سورة أو قارئ" aria-label="بحث"/></label><button className="circle glass btn" aria-label="اختيار مجلد الصوت" onClick={selectFolder}><Icon name="folder"/></button><button className="circle glass btn" aria-label="الإعدادات" onClick={selectFolder}><Icon name="sliders"/></button></div>
    </header>
    <main>
      <h1>{filter === 'all' ? 'المكتبة' : 'المفضلة'}</h1><p className="sub">{count(visible.length)}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {!tracks.length ? <div className="empty">{busy ? 'جارٍ فحص مجلد الصوت…' : 'اختر مجلد الصوت لبدء مكتبتك'}</div> : visible.length ? <div className="list" role="list">{visible.map(track => {
        const index = tracks.indexOf(track), on = index === current;
        return <div className={`row${on ? ' on' : ''}`} role="listitem" key={track.path}><button className="hit" onClick={() => load(index, true)} aria-current={on ? 'true' : undefined}><span className="cover">{track.cover ? <img src={track.cover} alt=""/> : on && playing ? <span className="eq"><i/><i/><i/></span> : track.file_name.slice(0, 1)}</span><span className="meta"><b title={track.file_name}>{track.file_name}</b><span>{track.artist || 'ملف صوتي محلي'}</span></span><span className="dur">{track.duration ? fmt(track.duration) : '—'}</span></button><button className="fav" aria-pressed={favorites.has(index)} aria-label={`المفضلة: ${track.file_name}`} onClick={() => setFavorites(old => { const next = new Set(old); next.has(index) ? next.delete(index) : next.add(index); return next; })}><Icon name="heart" filled={favorites.has(index)}/></button></div>;
      })}</div> : <p className="empty">{query.trim() ? 'لا توجد نتائج' : 'لم تُضف أي تلاوة إلى المفضلة بعد'}</p>}
    </main>
    <footer className="player glass big"><div className="pr"><div className="now">{active ? <div className="cover">{active.cover ? <img src={active.cover} alt=""/> : active.file_name.slice(0, 1)}</div> : <div className="cover">ت</div>}<div className="meta"><b title={active?.file_name || ''}>{active?.file_name || ''}</b><span>{active?.artist || ''}</span></div></div><div className="ctl"><button className="tbtn" onClick={() => step(-1)} aria-label="السابق"><Transport type="prev"/></button><button className="tbtn play" onClick={toggle} aria-label={playing ? 'إيقاف مؤقت' : 'تشغيل'}>{playing ? <Transport type="pause"/> : <Transport type="play"/>}</button><button className="tbtn" onClick={() => step(1)} aria-label="التالي"><Transport type="next"/></button></div><div className="vol"><input type="range" min="0" max="100" value={volume} onChange={event => { const value = Number(event.target.value); setVolume(value); audio.current.volume = value / 100; }} style={{ '--p': `${volume}%` }} aria-label="مستوى الصوت"/><Icon name="volume"/></div></div><div className="seek"><span>{fmt(pos)}</span><input type="range" min="0" max={duration || 0} step="any" value={Math.min(pos, duration || 0)} onChange={seek} style={{ '--p': `${duration ? pos / duration * 100 : 0}%` }} aria-label="التقدّم"/><span>{fmt(duration)}</span></div></footer>
  </>;
}

createRoot(document.getElementById('root')).render(<App/>);
