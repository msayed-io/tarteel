import { useEffect, useState } from 'react';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { resolveLocation, describeLocationError, LocationError } from './engine/location.js';
import { METHODS } from './engine/astro.js';
import './PrayerSettings.css';

/**
 * إعدادات الصلاة والتنبيهات — مبسّطة بقرار المنتج:
 *
 *   • الموقع: زر واحد يطلب إذن ويندوز ويجلب الموقع الحقيقي. لا بحث مدن،
 *     ولا إدخال إحداثيات باليد — لأن أي خطأ في الموقع يعني مواقيت خاطئة.
 *   • طريقة الحساب: لا يسأل المستخدم عنها. تُشتق من دولته تلقائيًا وتُعرض
 *     للعلم فقط.
 *   • العصر: يُشتق من الدولة تلقائيًا ويُعرض للعلم فقط.
 *   • يبقى للمستخدم ما يخصّه فعلًا: صوت الأذان ومستواه والتنبيه المسبق.
 */
export default function PrayerSettings({ config, schedule, onSave, onClose, onPreviewAlarm }) {
  const [location, setLocation] = useState(config.location || null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [notificationsAllowed, setNotificationsAllowed] = useState(Boolean(config.notificationsAllowed));
  const [preAlarmMinutes, setPreAlarmMinutes] = useState(config.preAlarmMinutes ?? 0);
  const [adhanSound, setAdhanSound] = useState(Boolean(config.adhanSound ?? true));
  const [adhanVolume, setAdhanVolume] = useState(config.adhanVolume ?? 80);

  /* إذا تغيّر الموقع خارج النافذة، نظهر القيمة الحديثة. */
  useEffect(() => { if (config.location) setLocation(config.location); }, [config.location]);

  const requestDeviceLocation = async () => {
    setBusy(true); setError(''); setStatus('جارٍ طلب إذن الموقع من ويندوز…');
    try {
      const resolved = await resolveLocation();
      setLocation(resolved);
      setStatus(resolved.precise
        ? `تم تحديد موقعك بدقة ${Math.round(resolved.accuracy)} متر — ${resolved.city || resolved.timeZone}.`
        : `تم تحديد موقعك تقريبًا (دقة ${Math.round(resolved.accuracy || 0)} متر). لتحسين الدقة فعّل Wi-Fi.`);
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

  const save = async event => {
    event.preventDefault();
    if (!location) { setError('اطلب موقع الجهاز أولًا — لا يمكن حساب مواقيت دون موقع مؤكد.'); return; }
    setBusy(true); setError('');
    try {
      await onSave({
        location,
        notificationsAllowed,
        preAlarmMinutes: Number(preAlarmMinutes) || 0,
        adhanSound,
        adhanVolume: Number(adhanVolume),
      });
      setStatus('حُفظت الإعدادات وأُعيد بناء جدول المواقيت.');
    } catch (cause) {
      setError(String(cause?.message || cause));
      setStatus('');
    } finally {
      setBusy(false);
    }
  };

  const method = schedule?.methodName || (location ? 'تُحدَّد تلقائيًا بعد حساب المواقيت' : '—');
  const asrLabel = schedule?.shadowFactor === 2 ? 'الحنفي (ظل ×٢)' : 'الجمهور (ظل ×١)';

  return (
    <div className="prayer-settings-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="prayer-settings glass" role="dialog" aria-modal="true" aria-labelledby="ps-title" dir="rtl">
        <header className="prayer-settings-head">
          <div>
            <h2 id="ps-title">إعدادات الصلاة والتنبيهات</h2>
            <p>يُحدَّد موقعك تلقائيًا من ويندوز، وتُشتق طريقة الحساب من دولتك.</p>
          </div>
          <button type="button" className="ps-close" aria-label="إغلاق الإعدادات" onClick={onClose}>×</button>
        </header>

        {/* ---------- الموقع ---------- */}
        <div className="ps-section">
          <h3>الموقع</h3>
          <div className="ps-current" aria-live="polite">
            {location ? (
              <>
                <b>{location.city ? `${location.city}${location.country ? `، ${location.country}` : ''}` : 'موقع الجهاز'}</b>
                <span>
                  {Number(location.latitude).toFixed(4)}, {Number(location.longitude).toFixed(4)}
                  {location.timeZone ? ` · ${location.timeZone}` : ''}
                  {Number.isFinite(location.accuracy) ? ` · دقة ${Math.round(location.accuracy)} م` : ''}
                </span>
              </>
            ) : 'لم يُحدَّد الموقع بعد.'}
          </div>
          <button type="button" className="ps-action" onClick={requestDeviceLocation} disabled={busy}>
            {location ? 'تحديث موقعي الآن' : 'استخدام موقع الجهاز وطلب الإذن'}
          </button>
        </div>

        {/* ---------- طريقة الحساب: تلقائية ---------- */}
        <div className="ps-section">
          <h3>طريقة الحساب</h3>
          <p className="ps-auto">
            <b>{method}</b>
            <span>تُختار تلقائيًا حسب دولتك: {methodsForCountry(location?.countryCode)}</span>
            <span>حساب العصر: <b>{asrLabel}</b></span>
          </p>
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

        {error && <p className="ps-error" role="alert">{error}</p>}
        {status && <p className="ps-status" role="status">{status}</p>}

        <footer className="ps-actions">
          <button type="button" className="ps-cancel" onClick={onClose} disabled={busy}>إلغاء</button>
          <button type="button" className="ps-save" onClick={save} disabled={busy || !location}>
            {busy ? 'جارٍ الحفظ…' : 'حفظ وإعادة بناء المواقيت'}
          </button>
        </footer>
      </section>
    </div>
  );
}

/** أسماء الطرق المعتمدة في الدول ذات الأولوية، للعرض فقط. */
function methodsForCountry(countryCode) {
  const code = String(countryCode || '').toUpperCase();
  const found = Object.values(METHODS).filter(method => method.countryCodes.includes(code));
  if (found.length) return found.map(method => method.name).join('، ');
  return 'رابطة العالم الإسلامي (الافتراضي العالمي)';
}
