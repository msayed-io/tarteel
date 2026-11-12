import { displayPlaceWithCountry } from './engine/display.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { invoke } from '@tauri-apps/api/core';
import { resolveLocation, describeLocationError } from './engine/location.js';
import { METHODS, methodForTimeZone } from './engine/astro.js';
import { DEFAULT_ISLAND_PLACEMENT, normalizeIslandPlacement, nudgeIslandPlacement, setIslandPlacementMode } from './engine/island-placement.js';
import { normalizeIslandAppearance } from './lib/island-appearance.js';
import './PrayerSettings.css';

/**
 * إعدادات الصلاة والتنبيهات.
 * تغيّر هذا المكوّن بصري فقط؛ تبقى الخدمات والحفظ التلقائي وجدولة Rust كما هي.
 */
const SAVE_DELAY_MS = 400;
const formatPlacementOffset = value => {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 1 }).format(Math.abs(value))}`;
};

const METHOD_ORDER = [
  'auto', 'egyptian', 'umm_al_qura', 'muslim_world_league', 'karachi',
  'dubai', 'kuwait', 'turkey', 'singapore', 'isna',
];

function Icon({ name, className = '' }) {
  return (
    <svg className={`ps-icon ${className}`.trim()} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <use href={`#ps-icon-${name}`} />
    </svg>
  );
}

export default function PrayerSettings({ config, schedule, audioMode, onAudioModeChange, onSave, onClose, onPreviewAlarm }) {
  const activeAudioMode = audioMode || 'natural';
  const [location, setLocation] = useState(config.location || null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [notificationsAllowed, setNotificationsAllowed] = useState(Boolean(config.notificationsAllowed));
  const [preAlarmMinutes, setPreAlarmMinutes] = useState(config.preAlarmMinutes ?? 0);
  const [adhanSound, setAdhanSound] = useState(Boolean(config.adhanSound ?? true));
  const [adhanVolume, setAdhanVolume] = useState(config.adhanVolume ?? 80);
  const [adhanMuted, setAdhanMuted] = useState(Boolean(config.adhanMuted ?? false));
  const [autostart, setAutostart] = useState(false);
  const [islandPlacement, setIslandPlacement] = useState(DEFAULT_ISLAND_PLACEMENT);
  const [placementLoading, setPlacementLoading] = useState(true);
  const [placementError, setPlacementError] = useState('');
  const [islandAppearance, setIslandAppearance] = useState('glass');
  const [appearanceLoading, setAppearanceLoading] = useState(true);
  const [appearanceError, setAppearanceError] = useState('');
  const placementRef = useRef(DEFAULT_ISLAND_PLACEMENT);
  const placementRequestRef = useRef(0);
  const appearanceRequestRef = useRef(0);
  const [methodId, setMethodId] = useState(config.methodId || 'auto');
  const [school, setSchool] = useState(config.school ?? 'auto');
  /* تبقى الإزاحات المحفوظة داخليًا وفي حساب الجدول حتى من دون إظهار بطاقة الضبط. */
  const [adjust] = useState(config.adjust || {});
  const bodyRef = useRef(null);
  const headRef = useRef(null);

  /* آخر إعدادات أُرسلت، لمنع حلقة حفظ لا نهائية عند تحديث الأب. */
  const lastSavedRef = useRef('');
  const timerRef = useRef(0);

  useEffect(() => {
    let active = true;
    invoke('get_island_placement').then(value => {
      if (!active) return;
      const normalized = normalizeIslandPlacement(value);
      placementRef.current = normalized;
      setIslandPlacement(normalized);
      setPlacementError('');
    }).catch(cause => {
      if (active) setPlacementError(`تعذّر قراءة موضع Dynamic: ${String(cause?.message || cause)}`);
    }).finally(() => { if (active) setPlacementLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    invoke('get_island_appearance').then(value => {
      if (!active) return;
      setIslandAppearance(normalizeIslandAppearance(value));
      setAppearanceError('');
    }).catch(cause => {
      if (active) setAppearanceError(`تعذّر قراءة مظهر Dynamic: ${String(cause?.message || cause)}`);
    }).finally(() => { if (active) setAppearanceLoading(false); });
    return () => { active = false; };
  }, []);

  const persistIslandPlacement = next => {
    const normalized = normalizeIslandPlacement(next);
    const request = ++placementRequestRef.current;
    placementRef.current = normalized;
    setIslandPlacement(normalized);
    setPlacementError('');
    invoke('set_island_placement', { mode: normalized.mode, offsetX: normalized.offsetX, offsetY: normalized.offsetY })
      .then(value => {
        if (request !== placementRequestRef.current) return;
        const saved = normalizeIslandPlacement(value);
        placementRef.current = saved;
        setIslandPlacement(saved);
      })
      .catch(cause => {
        if (request === placementRequestRef.current) {
          setPlacementError(`تعذّر حفظ موضع Dynamic: ${String(cause?.message || cause)}`);
          invoke('get_island_placement').then(value => {
            if (request !== placementRequestRef.current) return;
            const saved = normalizeIslandPlacement(value);
            placementRef.current = saved;
            setIslandPlacement(saved);
          }).catch(() => {});
        }
      });
  };

  const chooseIslandPlacementMode = mode => persistIslandPlacement(setIslandPlacementMode(placementRef.current, mode));
  const nudgeIsland = direction => persistIslandPlacement(nudgeIslandPlacement(placementRef.current, direction));
  const chooseIslandAppearance = appearance => {
    const next = normalizeIslandAppearance(appearance);
    const request = ++appearanceRequestRef.current;
    setIslandAppearance(next);
    setAppearanceError('');
    invoke('set_island_appearance', { appearance: next }).then(value => {
      if (request === appearanceRequestRef.current) setIslandAppearance(normalizeIslandAppearance(value));
    }).catch(cause => {
      if (request !== appearanceRequestRef.current) return;
      setAppearanceError(`تعذّر حفظ مظهر Dynamic: ${String(cause?.message || cause)}`);
      invoke('get_island_appearance').then(value => {
        if (request === appearanceRequestRef.current) setIslandAppearance(normalizeIslandAppearance(value));
      }).catch(() => {});
    });
  };

  const snapshot = useCallback(() => ({
    location,
    notificationsAllowed,
    preAlarmMinutes: Number(preAlarmMinutes) || 0,
    adhanSound,
    adhanVolume: Number(adhanVolume),
    adhanMuted,
    methodId,
    school,
    adjust,
  }), [location, notificationsAllowed, preAlarmMinutes, adhanSound, adhanVolume, adhanMuted, methodId, school, adjust]);

  /* الحفظ التلقائي: أي تغيير ⇒ حفظ بعد هدوء قصير. */
  useEffect(() => {
    if (!location) return;
    const payload = snapshot();
    const key = JSON.stringify(payload);
    if (key === lastSavedRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      lastSavedRef.current = key;
      try {
        await onSave(payload);
        setError('');
        setStatus('حُفظ تلقائيًا');
      } catch (cause) {
        setError(String(cause?.message || cause));
        setStatus('');
      }
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timerRef.current);
  }, [snapshot, location, onSave]);

  const requestDeviceLocation = async () => {
    setBusy(true); setError(''); setStatus('جارٍ طلب إذن الموقع من ويندوز…');
    try {
      const resolved = await resolveLocation();
      setLocation(resolved);
      setStatus(resolved.precise
        ? `تم تحديد موقعك بدقة ${Math.round(resolved.accuracy)} متر.`
        : `تم تحديد موقعك تقريبًا (${Math.round(resolved.accuracy || 0)} متر). لتحسين الدقة فعّل Wi-Fi.`);
    } catch (cause) {
      setError(describeLocationError(cause));
      setStatus('');
    } finally {
      setBusy(false);
    }
  };

  const requestNotifications = async () => {
    setError('');
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === 'granted';
      setNotificationsAllowed(granted);
      setStatus(granted
        ? 'إذن إشعار التنبيه المسبق ممنوح. عند موعد الصلاة سيعمل الأذان الصوتي فقط.'
        : 'لم يُمنح إذن التنبيه المسبق؛ الأذان الفعلي يعمل صوتًا فقط دون إشعار.');
    } catch (cause) {
      setError(`تعذّر طلب إذن إشعار التنبيه المسبق: ${String(cause)}`);
    }
  };

  /* تفضيلات الصوت كاملة تُحفظ في Rust لاستخدامها قبل تحميل WebView عند الموعد. */
  useEffect(() => {
    invoke('set_adhan_preferences', {
      enabled: Boolean(adhanSound), volume: Number(adhanVolume), muted: Boolean(adhanMuted),
    }).catch(() => {});
  }, [adhanSound, adhanVolume, adhanMuted]);

  /* حالة البدء مع ويندوز تُقرأ من النظام لا من التخزين المحلي. */
  useEffect(() => {
    invoke('is_autostart_enabled').then(value => setAutostart(Boolean(value))).catch(() => {});
  }, []);

  const toggleAutostart = async enabled => {
    try {
      const applied = await invoke('set_autostart', { enabled });
      setAutostart(Boolean(applied));
    } catch (cause) {
      setError(`تعذّر تغيير البدء مع ويندوز: ${String(cause)}`);
    }
  };

  /* اسم عربي صريح: المدينة، المحافظة، الدولة. لا إحداثيات جافة. */
  const placeLabel = location ? placeName(location) : '';
  const effectiveMethod = methodId === 'auto'
    ? (schedule?.methodName || methodForTimeZone(location?.timeZone).method.name)
    : (METHODS[methodId]?.name || '—');
  const effectiveSchool = school === 'auto'
    ? (schedule?.shadowFactor === 2 ? 'الحنفي (ظل ×٢)' : 'الجمهور (ظل ×١)')
    : (Number(school) === 2 ? 'الحنفي (ظل ×٢)' : 'الجمهور (ظل ×١)');

  /* تمرير داخلي بلا شريط ظاهر، مع تلاشي للحواف ورأس ثابت. */
  useEffect(() => {
    const body = bodyRef.current;
    const head = headRef.current;
    if (!body || !head) return undefined;
    const updateEdges = () => {
      const top = body.scrollTop > 4;
      const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
      body.style.setProperty('--ps-fade-top', top ? '18px' : '0px');
      body.style.setProperty('--ps-fade-bottom', atBottom ? '0px' : '26px');
      head.classList.toggle('is-scrolled', top);
    };
    body.addEventListener('scroll', updateEdges, { passive: true });
    window.addEventListener('resize', updateEdges);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateEdges);
    observer?.observe(body);
    updateEdges();
    return () => {
      body.removeEventListener('scroll', updateEdges);
      window.removeEventListener('resize', updateEdges);
      observer?.disconnect();
    };
  }, []);

  /* زر Esc يستخدم الإغلاق نفسه المستخدم في زر X والخلفية. */
  useEffect(() => {
    const closeOnEscape = event => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="prayer-settings-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <svg className="ps-icon-sprite" aria-hidden="true" focusable="false">
        <defs>
          <symbol id="ps-icon-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></symbol>
          <symbol id="ps-icon-moon" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></symbol>
          <symbol id="ps-icon-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></symbol>
          <symbol id="ps-icon-pin" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21s-7-5.2-7-11a7 7 0 0 1 14 0c0 5.8-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></g></symbol>
          <symbol id="ps-icon-refresh" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11a8 8 0 0 0-14.9-3M4 5v4h4" /><path d="M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4" /></g></symbol>
          <symbol id="ps-icon-compass" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M15.5 8.5l-2 5-5 2 2-5z" /></g></symbol>
          <symbol id="ps-icon-sun" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></g></symbol>
          <symbol id="ps-icon-bell" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10.3 20a2 2 0 0 0 3.4 0" /></g></symbol>
          <symbol id="ps-icon-volume" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></g></symbol>
          <symbol id="ps-icon-volume-low" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z" /><path d="M15.5 9a4 4 0 0 1 0 6" /></g></symbol>
          <symbol id="ps-icon-volume-mute" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z" /><path d="m22 9-6 6m0-6 6 6" /></g></symbol>
          <symbol id="ps-icon-clock" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></g></symbol>
          <symbol id="ps-icon-play" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></symbol>
          <symbol id="ps-icon-tray" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></g></symbol>
          <symbol id="ps-icon-arrow-up" viewBox="0 0 24 24"><path d="m6 14 6-6 6 6M12 8v11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></symbol>
          <symbol id="ps-icon-arrow-down" viewBox="0 0 24 24"><path d="m6 10 6 6 6-6M12 16V5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></symbol>
          <symbol id="ps-icon-arrow-left" viewBox="0 0 24 24"><path d="m10 6-6 6 6 6M4 12h15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></symbol>
          <symbol id="ps-icon-arrow-right" viewBox="0 0 24 24"><path d="m14 6 6 6-6 6m6-6H5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></symbol>
        </defs>
      </svg>

      <section className="prayer-settings" role="dialog" aria-modal="true" aria-labelledby="ps-title" dir="rtl">
        <header className="ps-head" ref={headRef}>
          <div className="ps-head-icon"><Icon name="moon" /></div>
          <div className="ps-head-copy">
            <h2 id="ps-title">إعدادات الصلاة والتنبيهات</h2>
            <p className="ps-head-sub"><Icon name="check" /> يُحفظ كل تغيير تلقائيًا</p>
          </div>
          <button type="button" className="ps-close rim" aria-label="إغلاق" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>

        <div className="ps-body" ref={bodyRef}>
          <section className="ps-section" aria-labelledby="ps-location-title">
            <h3 className="ps-section-title" id="ps-location-title">الموقع</h3>
            <div className="ps-card ps-location" aria-live="polite">
              <div className="ps-location-icon"><Icon name="pin" /></div>
              <div className="ps-location-main">
                <div className="ps-location-name">{location ? placeLabel : 'لم يُحدَّد الموقع بعد.'}</div>
                {location && (
                  <div className="ps-chips">
                    {location.timeZone && <span className="ps-chip"><bdi dir="ltr">{location.timeZone}</bdi></span>}
                    {Number.isFinite(location.accuracy) && <span className="ps-chip">دقة {Math.round(location.accuracy)} م</span>}
                  </div>
                )}
              </div>
              <button type="button" className={`ps-button ps-button-blue rim${busy ? ' is-spinning' : ''}`} onClick={requestDeviceLocation} disabled={busy} aria-busy={busy}>
                <Icon name="refresh" /> {location ? 'تحديث موقعي الآن' : 'استخدام موقع الجهاز وطلب الإذن'}
              </button>
            </div>
            <p className="ps-hint">يُحدَّد موقعك من ويندوز.</p>
          </section>

          <section className="ps-section" aria-labelledby="ps-method-title">
            <h3 className="ps-section-title" id="ps-method-title">طريقة الحساب</h3>
            <div className="ps-card">
              <div className="ps-fields">
                <label className="ps-field" htmlFor="ps-method">
                  <span className="ps-field-label">الطريقة</span>
                  <select className="ps-select" id="ps-method" value={methodId} onChange={event => setMethodId(event.target.value)}>
                    <option value="auto">تلقائي حسب الدولة — {methodForTimeZone(location?.timeZone).method.name}</option>
                    {METHOD_ORDER.filter(id => id !== 'auto').map(id => (
                      <option key={id} value={id}>{METHODS[id].name}</option>
                    ))}
                  </select>
                </label>
                <label className="ps-field" htmlFor="ps-school">
                  <span className="ps-field-label">حساب العصر</span>
                  <select className="ps-select" id="ps-school" value={String(school)} onChange={event => setSchool(event.target.value === 'auto' ? 'auto' : Number(event.target.value))}>
                    <option value="auto">تلقائي حسب الدولة</option>
                    <option value="1">جمهور الفقهاء (ظل ×١)</option>
                    <option value="2">المذهب الحنفي (ظل ×٢)</option>
                  </select>
                </label>
              </div>
              <div className="ps-applied">
                <div className="ps-applied-label"><Icon name="check" /> المطبّق الآن</div>
                <div className="ps-chips">
                  <span className="ps-chip ps-chip-applied">{effectiveMethod}</span>
                  <span className="ps-chip ps-chip-applied">{effectiveSchool}</span>
                </div>
              </div>
            </div>
            <p className="ps-hint">تُشتق طريقة الحساب من دولتك.</p>
          </section>

          <section className="ps-section" aria-labelledby="ps-alerts-title">
            <h3 className="ps-section-title" id="ps-alerts-title">التنبيهات</h3>
            <div className="ps-card">
              <div className="ps-control-row">
                <span className="ps-row-icon"><Icon name="bell" /></span>
                <span className="ps-row-label" id="ps-notify-label">إذن إشعار التنبيه المسبق</span>
                <button id="ps-notify" type="button" className="ps-button ps-button-ghost ps-control rim" aria-labelledby="ps-notify-label" aria-pressed={notificationsAllowed} onClick={requestNotifications}>
                  {notificationsAllowed ? 'ممنوحة ✓' : 'طلب الإذن'}
                </button>
              </div>

              <div className="ps-control-row">
                <span className="ps-row-icon"><Icon name="volume" /></span>
                <span className="ps-row-label" id="ps-sound-label">صوت الأذان عند الموعد</span>
                <label className="ps-switch ps-control" aria-label="صوت الأذان عند الموعد">
                  <input id="ps-sound" type="checkbox" role="switch" aria-labelledby="ps-sound-label" checked={adhanSound} onChange={event => setAdhanSound(event.target.checked)} />
                  <span className="ps-switch-track" />
                </label>
              </div>

              <div className="ps-control-row ps-volume-row">
                <div className="ps-volume-heading">
                  <span className="ps-row-icon"><Icon name="volume-low" /></span>
                  <label className="ps-row-label" id="ps-volume-label" htmlFor="ps-volume">مستوى صوت الأذان</label>
                  <bdi className="ps-volume-badge" dir="ltr">{adhanVolume}%</bdi>
                </div>
                <div className="ps-slider-line">
                  <Icon name="volume-low" />
                  <input
                    className="ps-range"
                    id="ps-volume"
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={adhanVolume}
                    aria-labelledby="ps-volume-label"
                    aria-valuetext={`${adhanVolume}%`}
                    style={{ '--ps-range-progress': `${Math.max(0, Math.min(100, Number(adhanVolume) || 0))}%` }}
                    onChange={event => setAdhanVolume(Number(event.target.value))}
                    disabled={!adhanSound}
                  />
                  <Icon name="volume" />
                </div>
              </div>

              <div className="ps-control-row">
                <span className="ps-row-icon"><Icon name="volume-mute" /></span>
                <span className="ps-row-label" id="ps-mute-label">كتم الأذان مؤقتًا</span>
                <label className="ps-switch ps-control" aria-label="كتم الأذان مؤقتًا">
                  <input id="ps-mute" type="checkbox" role="switch" aria-labelledby="ps-mute-label" checked={adhanMuted} onChange={event => setAdhanMuted(event.target.checked)} />
                  <span className="ps-switch-track" />
                </label>
              </div>

              <div className="ps-control-row">
                <span className="ps-row-icon"><Icon name="clock" /></span>
                <span className="ps-row-label" id="ps-pre-label">تنبيه مسبق</span>
                <select className="ps-select ps-select-sm ps-control" id="ps-pre" aria-labelledby="ps-pre-label" value={preAlarmMinutes} onChange={event => setPreAlarmMinutes(Number(event.target.value))}>
                  <option value={0}>بدون</option>
                  <option value={5}>قبل 5 دقائق</option>
                  <option value={10}>قبل 10 دقائق</option>
                  <option value={15}>قبل 15 دقيقة</option>
                  <option value={30}>قبل 30 دقيقة</option>
                </select>
              </div>

              {onPreviewAlarm && (
                <div className="ps-card-foot">
                  <button type="button" className="ps-button ps-button-preview rim" onClick={onPreviewAlarm}>
                    <Icon name="play" /> تجربة صوت الأذان
                  </button>
                </div>
              )}
            </div>
          </section>

          <section className="ps-section" aria-labelledby="ps-audio-title">
            <h3 className="ps-section-title" id="ps-audio-title">صوت التلاوة</h3>
            <div className="ps-card ps-audio-card">
              <div className="ps-audio-options" role="group" aria-label="وضع معالجة صوت التلاوة">
                {[
                  { id: 'natural', title: 'طبيعي', detail: 'الصوت الأصلي بلا مؤثرات إضافية.' },
                  { id: 'spatial', title: 'العمق المكاني', detail: 'HRTF عامة من KU100؛ يُفضّل استخدامها عبر سماعات الرأس.' },
                  { id: 'mosque', title: 'محاكاة المسجد', detail: 'صدى تلافيفي متزن يحافظ على وضوح التلاوة.' },
                ].map(option => (
                  <button
                    key={option.id}
                    type="button"
                    className="ps-audio-option"
                    aria-pressed={activeAudioMode === option.id}
                    onClick={() => onAudioModeChange?.(option.id)}
                  >
                    <span className="ps-audio-option-copy"><b>{option.title}</b><small>{option.detail}</small></span>
                    <span className="ps-audio-option-mark" aria-hidden="true">{activeAudioMode === option.id ? '✓' : ''}</span>
                  </button>
                ))}
              </div>
              <p className="ps-audio-hint">بيانات HRTF عامة وليست مخصصة للمستمع، وتُشتق استجابة الأذن الأخرى بالانعكاس؛ مكبرات اللابتوب قد لا تعطي صورة ثلاثية الأبعاد ثابتة. «طبيعي» يبقي المشغّل الحالي دون تغيير.</p>
            </div>
          </section>

          <section className="ps-section" aria-labelledby="ps-background-title">
            <h3 className="ps-section-title" id="ps-background-title">التطبيق في الخلفية</h3>
            <div className="ps-card ps-background-card">
              <div className="ps-background-note">
                <span className="ps-row-icon"><Icon name="tray" /></span>
                <p><strong>إغلاق النافذة لا يُنهي التطبيق:</strong> يبقى في صينية النظام بجانب الساعة ليُطلق الأذان في موعده. الخروج النهائي من قائمة الصينية.</p>
              </div>
              <div className="ps-control-row ps-autostart-row">
                <span className="ps-row-icon"><Icon name="tray" /></span>
                <span className="ps-row-label" id="ps-autostart-label">البدء مع تشغيل ويندوز (مصغّرًا في الصينية)</span>
                <label className="ps-switch ps-control" aria-label="البدء مع تشغيل ويندوز">
                  <input id="ps-autostart" type="checkbox" role="switch" aria-labelledby="ps-autostart-label" checked={autostart} onChange={event => toggleAutostart(event.target.checked)} />
                  <span className="ps-switch-track" />
                </label>
              </div>
            </div>
          </section>

          <section className="ps-section" aria-labelledby="ps-placement-title">
            <h3 className="ps-section-title" id="ps-placement-title">موضع Dynamic</h3>
            <div className="ps-card ps-placement-card" aria-busy={placementLoading}>
              <p className="ps-placement-intro">اختر موضع العرض التلقائي أو اضبطه يدويًا بدقة.</p>
              <div className="ps-placement-modes" role="group" aria-label="طريقة تحديد الموضع">
                <button type="button" className="ps-placement-mode" aria-pressed={islandPlacement.mode === 'auto'} disabled={placementLoading} onClick={() => chooseIslandPlacementMode('auto')}>Auto</button>
                <button type="button" className="ps-placement-mode" aria-pressed={islandPlacement.mode === 'manual'} disabled={placementLoading} onClick={() => chooseIslandPlacementMode('manual')}>يدوي</button>
              </div>
              <div className={`ps-placement-remote${islandPlacement.mode === 'manual' ? ' is-manual' : ''}`}>
                <div className="ps-dpad" role="group" aria-label="تحريك نافذة Dynamic">
                  <button type="button" className="ps-dpad-button ps-dpad-up rim" aria-label="تحريك لأعلى بمقدار ٢ بكسل" disabled={placementLoading || islandPlacement.mode !== 'manual'} onClick={() => nudgeIsland('up')}><Icon name="arrow-up" /></button>
                  <button type="button" className="ps-dpad-button ps-dpad-left rim" aria-label="تحريك لليسار بمقدار ٢ بكسل" disabled={placementLoading || islandPlacement.mode !== 'manual'} onClick={() => nudgeIsland('left')}><Icon name="arrow-left" /></button>
                  <output className="ps-dpad-center" aria-live="polite" aria-label="الإزاحة اليدوية المحفوظة">
                    <span>{islandPlacement.mode === 'manual' ? 'الموضع اليدوي' : 'الإزاحة المحفوظة'}</span>
                    <bdi dir="ltr">X {formatPlacementOffset(islandPlacement.offsetX)} · Y {formatPlacementOffset(islandPlacement.offsetY)} px</bdi>
                  </output>
                  <button type="button" className="ps-dpad-button ps-dpad-right rim" aria-label="تحريك لليمين بمقدار ٢ بكسل" disabled={placementLoading || islandPlacement.mode !== 'manual'} onClick={() => nudgeIsland('right')}><Icon name="arrow-right" /></button>
                  <button type="button" className="ps-dpad-button ps-dpad-down rim" aria-label="تحريك لأسفل بمقدار ٢ بكسل" disabled={placementLoading || islandPlacement.mode !== 'manual'} onClick={() => nudgeIsland('down')}><Icon name="arrow-down" /></button>
                </div>
              </div>
              <p className="ps-placement-hint">كل ضغطة تحرّك الجزيرة ٢ بكسل منطقيًا بحركة سلسة. وضع Auto يعيد الحساب الافتراضي دون حذف إزاحتك اليدوية.</p>
              {placementError && <p className="ps-feedback" role="alert">{placementError}</p>}
            </div>
          </section>

          <section className="ps-section" aria-labelledby="ps-appearance-title">
            <h3 className="ps-section-title" id="ps-appearance-title">مظهر Dynamic</h3>
            <div className="ps-card ps-appearance-card" aria-busy={appearanceLoading}>
              <p className="ps-placement-intro">اختر مادة الجزيرة؛ يتغير السطح فقط وتبقى بقية تفاصيل التصميم كما هي.</p>
              <div className="ps-placement-modes" role="group" aria-label="مظهر Dynamic">
                <button type="button" className="ps-placement-mode" aria-pressed={islandAppearance === 'glass'} disabled={appearanceLoading} onClick={() => chooseIslandAppearance('glass')}>زجاج</button>
                <button type="button" className="ps-placement-mode" aria-pressed={islandAppearance === 'black'} disabled={appearanceLoading} onClick={() => chooseIslandAppearance('black')}>أسود صلب</button>
              </div>
              <p className="ps-appearance-hint">وضع الزجاج يستخدم طبقة CSS الحالية دون تغيير. تمويه سطح المكتب خلف الجزيرة غير مضمون مع إبقاء النافذة غير مفعّلة وتمرير النقرات كما هو.</p>
              {appearanceError && <p className="ps-feedback" role="alert">{appearanceError}</p>}
            </div>
          </section>

          {error && <p className="ps-feedback" role="alert">{error}</p>}
          {status && <p className="ps-feedback" role="status">{status}</p>}
        </div>
      </section>
    </div>
  );
}

/** اسم المكان بالعربية: المدينة، المحافظة، الدولة. */
function placeName(location) {
  /* الاسم التفصيلي العربي الكامل، مع الدولة إن وُجدت — بلا أي نص لاتيني. */
  return displayPlaceWithCountry(location);
}
