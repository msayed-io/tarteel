import { displayPlaceWithCountry } from './engine/display.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { invoke } from '@tauri-apps/api/core';
import { resolveLocation, describeLocationError } from './engine/location.js';
import { METHODS, methodForTimeZone } from './engine/astro.js';
import { DEFAULT_ISLAND_PLACEMENT, normalizeIslandPlacement, nudgeIslandPlacement, setIslandPlacementMode } from './engine/island-placement.js';
import { normalizeIslandAppearance } from './lib/island-appearance.js';
import PrayerSettingsPage from './PrayerSettingsPage.jsx';

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

export default function PrayerSettings({ config, schedule, audioMode, onAudioModeChange, onSave, onClose, onPreviewAlarm }) {
  const activeAudioMode = audioMode || 'natural';
  const [location, setLocation] = useState(config.location || null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [notificationsAllowed, setNotificationsAllowed] = useState(Boolean(config.notificationsAllowed));
  const [notificationPermissionReady, setNotificationPermissionReady] = useState(false);
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

  /* آخر إعدادات أُرسلت، لمنع حلقة حفظ لا نهائية عند تحديث الأب. */
  const lastSavedRef = useRef('');
  const timerRef = useRef(0);

  useEffect(() => {
    let active = true;
    isPermissionGranted()
      .then(granted => { if (active) setNotificationsAllowed(Boolean(granted)); })
      .catch(() => {})
      .finally(() => { if (active) setNotificationPermissionReady(true); });
    return () => { active = false; };
  }, []);

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
    if (!location || !notificationPermissionReady) return;
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
  }, [snapshot, location, onSave, notificationPermissionReady]);

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

  const effectiveMethodId = methodId === 'auto'
    ? (schedule?.method || methodForTimeZone(location?.timeZone).method.id)
    : methodId;
  const appliedMethod = METHODS[effectiveMethodId];
  const methodAngles = appliedMethod?.fajrAngle != null && appliedMethod?.ishaAngle != null
    ? `${new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 1 }).format(appliedMethod.fajrAngle)}/${new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 1 }).format(appliedMethod.ishaAngle)}`
    : '';

  return (
    <PrayerSettingsPage
      location={location}
      placeLabel={placeLabel}
      autoMethodName={methodForTimeZone(location?.timeZone).method.name}
      methodOptions={METHOD_ORDER.filter(id => id !== 'auto').map(id => ({ id, name: METHODS[id].name }))}
      methodAngles={methodAngles}
      methodId={methodId}
      setMethodId={setMethodId}
      school={school}
      setSchool={setSchool}
      effectiveMethod={effectiveMethod}
      effectiveSchool={effectiveSchool}
      busy={busy}
      notificationsAllowed={notificationsAllowed}
      requestDeviceLocation={requestDeviceLocation}
      requestNotifications={requestNotifications}
      preAlarmMinutes={preAlarmMinutes}
      setPreAlarmMinutes={setPreAlarmMinutes}
      adhanSound={adhanSound}
      setAdhanSound={setAdhanSound}
      adhanVolume={adhanVolume}
      setAdhanVolume={setAdhanVolume}
      adhanMuted={adhanMuted}
      setAdhanMuted={setAdhanMuted}
      onPreviewAlarm={onPreviewAlarm}
      activeAudioMode={activeAudioMode}
      onAudioModeChange={onAudioModeChange}
      autostart={autostart}
      toggleAutostart={toggleAutostart}
      islandPlacement={islandPlacement}
      placementLoading={placementLoading}
      chooseIslandPlacementMode={chooseIslandPlacementMode}
      nudgeIsland={nudgeIsland}
      formatPlacementOffset={formatPlacementOffset}
      islandAppearance={islandAppearance}
      appearanceLoading={appearanceLoading}
      chooseIslandAppearance={chooseIslandAppearance}
      onClose={onClose}
    />
  );
}

/** اسم المكان بالعربية: المدينة، المحافظة، الدولة. */
function placeName(location) {
  /* الاسم التفصيلي العربي الكامل، مع الدولة إن وُجدت — بلا أي نص لاتيني. */
  return displayPlaceWithCountry(location);
}
