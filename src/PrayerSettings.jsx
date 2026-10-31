import { displayPlaceWithCountry } from './engine/display.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { resolveLocation, describeLocationError } from './engine/location.js';
import { METHODS, MANUAL_ADJUST_LIMIT, ARABIC_NAMES, methodForTimeZone } from './engine/astro.js';
import './PrayerSettings.css';

/**
 * إعدادات الصلاة والتنبيهات.
 *
 * قرارات التصميم:
 *   • لا زر حفظ. كل تغيير يُحفظ ويُعاد بناء الجدول ويُنشر إلى Rust فورًا
 *     (debounce قصير لتفادي عشرات الاستدعاءات أثناء تحريك المؤشر).
 *   • الموقع من ويندوز فقط. لا بحث مدن ولا إدخال إحداثيات.
 *   • الطريقة والمذهب لهما قيمة تلقائية مشتقة من الدولة، مع إمكانية التغيير.
 *   • كل نص للمستخدم عربي صريح: اسم المدينة والمحافظة لا إحداثيات جافة.
 */
const SAVE_DELAY_MS = 400;

const METHOD_ORDER = [
  'auto', 'egyptian', 'umm_al_qura', 'muslim_world_league', 'karachi',
  'dubai', 'kuwait', 'turkey', 'singapore', 'isna',
];

export default function PrayerSettings({ config, schedule, onSave, onClose, onPreviewAlarm }) {
  const [location, setLocation] = useState(config.location || null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [notificationsAllowed, setNotificationsAllowed] = useState(Boolean(config.notificationsAllowed));
  const [preAlarmMinutes, setPreAlarmMinutes] = useState(config.preAlarmMinutes ?? 0);
  const [adhanSound, setAdhanSound] = useState(Boolean(config.adhanSound ?? true));
  const [adhanVolume, setAdhanVolume] = useState(config.adhanVolume ?? 80);
  const [methodId, setMethodId] = useState(config.methodId || 'auto');
  const [school, setSchool] = useState(config.school ?? 'auto');
  const [adjust, setAdjust] = useState(config.adjust || {});
  const [showAdvanced, setShowAdvanced] = useState(false);

  /* آخر إعدادات أُرسلت، لمنع حلقة حفظ لا نهائية عند تحديث الأب. */
  const lastSavedRef = useRef('');
  const timerRef = useRef(0);

  const snapshot = useCallback(() => ({
    location,
    notificationsAllowed,
    preAlarmMinutes: Number(preAlarmMinutes) || 0,
    adhanSound,
    adhanVolume: Number(adhanVolume),
    methodId,
    school,
    adjust,
  }), [location, notificationsAllowed, preAlarmMinutes, adhanSound, adhanVolume, methodId, school, adjust]);

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
      setStatus(granted ? 'إشعارات ويندوز ممنوحة.' : 'لم يُمنح إذن الإشعارات. ستظهر البطاقة داخل التطبيق فقط.');
    } catch (cause) {
      setError(`تعذّر طلب إذن الإشعارات: ${String(cause)}`);
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

  return (
    <div className="prayer-settings-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="prayer-settings glass" role="dialog" aria-modal="true" aria-labelledby="ps-title" dir="rtl">
        <header className="prayer-settings-head">
          <div>
            <h2 id="ps-title">إعدادات الصلاة والتنبيهات</h2>
            <p>يُحفظ كل تغيير تلقائيًا. يُحدَّد موقعك من ويندوز وتُشتق طريقة الحساب من دولتك.</p>
          </div>
          <button type="button" className="ps-close" aria-label="إغلاق الإعدادات" onClick={onClose}>×</button>
        </header>

        {/* ---------- الموقع ---------- */}
        <div className="ps-section">
          <h3>الموقع</h3>
          <div className="ps-current" aria-live="polite">
            {location ? (
              <>
                <b>{placeLabel}</b>
                <span>
                  {location.timeZone}
                  {Number.isFinite(location.accuracy) ? ` · دقة ${Math.round(location.accuracy)} م` : ''}
                </span>
              </>
            ) : 'لم يُحدَّد الموقع بعد.'}
          </div>
          <button type="button" className="ps-action" onClick={requestDeviceLocation} disabled={busy}>
            {location ? 'تحديث موقعي الآن' : 'استخدام موقع الجهاز وطلب الإذن'}
          </button>
        </div>

        {/* ---------- طريقة الحساب ---------- */}
        <div className="ps-section">
          <h3>طريقة الحساب</h3>
          <div className="ps-row">
            <label htmlFor="ps-method">الطريقة</label>
            <select id="ps-method" value={methodId} onChange={e => setMethodId(e.target.value)}>
              <option value="auto">تلقائي حسب الدولة — {methodForTimeZone(location?.timeZone).method.name}</option>
              {METHOD_ORDER.filter(id => id !== 'auto').map(id => (
                <option key={id} value={id}>{METHODS[id].name}</option>
              ))}
            </select>
          </div>
          <div className="ps-row">
            <label htmlFor="ps-school">حساب العصر</label>
            <select id="ps-school" value={String(school)} onChange={e => setSchool(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}>
              <option value="auto">تلقائي حسب الدولة</option>
              <option value="1">جمهور الفقهاء (ظل ×١)</option>
              <option value="2">المذهب الحنفي (ظل ×٢)</option>
            </select>
          </div>
          <p className="ps-hint">المطبَّق الآن: <b>{effectiveMethod}</b> · <b>{effectiveSchool}</b></p>
        </div>

        {/* ---------- التنبيهات ---------- */}
        <div className="ps-section">
          <h3>التنبيهات</h3>
          <div className="ps-row">
            <label htmlFor="ps-notify">إشعارات ويندوز</label>
            <button id="ps-notify" type="button" className="ps-toggle" aria-pressed={notificationsAllowed} onClick={requestNotifications}>
              {notificationsAllowed ? 'ممنوحة ✓' : 'طلب الإذن'}
            </button>
          </div>
          <div className="ps-row">
            <label htmlFor="ps-sound">صوت الأذان عند الموعد</label>
            <input id="ps-sound" type="checkbox" checked={adhanSound} onChange={e => setAdhanSound(e.target.checked)} />
          </div>
          <div className="ps-row">
            <label htmlFor="ps-volume">مستوى صوت الأذان: {adhanVolume}%</label>
            <input id="ps-volume" type="range" min="0" max="100" step="5" value={adhanVolume} onChange={e => setAdhanVolume(Number(e.target.value))} disabled={!adhanSound} />
          </div>
          <div className="ps-row">
            <label htmlFor="ps-pre">تنبيه مسبق</label>
            <select id="ps-pre" value={preAlarmMinutes} onChange={e => setPreAlarmMinutes(Number(e.target.value))}>
              <option value={0}>بدون</option>
              <option value={5}>قبل 5 دقائق</option>
              <option value={10}>قبل 10 دقائق</option>
              <option value={15}>قبل 15 دقيقة</option>
              <option value={30}>قبل 30 دقيقة</option>
            </select>
          </div>
          {onPreviewAlarm && (
            <button type="button" className="ps-preview" onClick={onPreviewAlarm}>تجربة التنبيه الآن</button>
          )}
        </div>

        {/* ---------- الضبط الدقيق (اختياري، مطوي) ---------- */}
        <div className="ps-section">
          <button type="button" className="ps-disclosure" aria-expanded={showAdvanced} onClick={() => setShowAdvanced(v => !v)}>
            {showAdvanced ? 'إخفاء' : 'إظهار'} الضبط الدقيق للمواقيت (اختياري)
          </button>
          {showAdvanced && (
            <div className="ps-adjust">
              {Object.entries(ARABIC_NAMES).filter(([key]) => key !== 'sunrise').map(([key, name]) => (
                <label key={key}>
                  <span>{name}</span>
                  <input
                    type="number" min={-MANUAL_ADJUST_LIMIT} max={MANUAL_ADJUST_LIMIT} step={1}
                    value={adjust[key] ?? 0}
                    onChange={e => setAdjust({
                      ...adjust,
                      [key]: Math.max(-MANUAL_ADJUST_LIMIT, Math.min(MANUAL_ADJUST_LIMIT, Number(e.target.value) || 0)),
                    })}
                  />
                </label>
              ))}
            </div>
          )}
        </div>

        {error && <p className="ps-error" role="alert">{error}</p>}
        {status && <p className="ps-status" role="status">{status}</p>}

        <footer className="ps-actions">
          <button type="button" className="ps-save" onClick={onClose}>تم</button>
        </footer>
      </section>
    </div>
  );
}

/** اسم المكان بالعربية: المدينة، المحافظة، الدولة. */
function placeName(location) {
  /* الاسم التفصيلي العربي الكامل، مع الدولة إن وُجدت — بلا أي نص لاتيني. */
  return displayPlaceWithCountry(location);
}
