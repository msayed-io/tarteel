import React, { useEffect, useState } from 'react';
import { checkPermissions, getCurrentPosition, requestPermissions } from '@tauri-apps/plugin-geolocation';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { fetchCalculationMethods, getDeviceLocation, searchCities } from './prayer.js';
import './PrayerSettings.css';

export default function PrayerSettings({ open, value, onClose, onSave }) {
  const [location, setLocation] = useState(value?.location || null);
  const [methodId, setMethodId] = useState(value?.methodId ?? '');
  const [school, setSchool] = useState(value?.school ?? '');
  const [methods, setMethods] = useState([]);
  const [methodError, setMethodError] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!open) return;
    setLocation(value?.location || null);
    setMethodId(value?.methodId ?? '');
    setSchool(value?.school ?? '');
    setError(''); setStatus(''); setMethodError('');
    fetchCalculationMethods().then(setMethods).catch(cause => {
      console.error('Tarteel prayer calculation methods failed', cause);
      setMethodError(String(cause?.message || cause));
    });
  }, [open, value?.location, value?.methodId, value?.school]);

  if (!open) return null;

  const useDeviceLocation = async () => {
    setBusy(true); setError(''); setStatus('سيطلب تَرتيل إذن الموقع من النظام ثم يقرأ موقع الجهاز.');
    try {
      const next = await getDeviceLocation({ checkPermissions, requestPermissions, getCurrentPosition });
      setLocation(next); setResults([]);
      setStatus(`تم تحديد موقع الجهاز بدقة تقريبية ${next.accuracy ? `${Math.round(next.accuracy)} متر` : 'غير متاحة'}. لن يُحفظ إلا بعد الضغط على حفظ.`);
    } catch (cause) {
      setError(String(cause?.message || cause)); setStatus('');
    } finally { setBusy(false); }
  };

  const findCities = async event => {
    event?.preventDefault(); setBusy(true); setError(''); setResults([]); setStatus('جارٍ البحث في دليل المدن…');
    try {
      const found = await searchCities(query);
      setResults(found);
      setStatus(found.length ? `اختر مدينة من النتائج. الإحداثيات والمنطقة الزمنية مأخوذة من دليل المدن وليست تخمينًا.` : 'لم يعثر المصدر على مدينة مطابقة. جرّب كتابة المدينة والدولة.');
    } catch (cause) {
      console.error('Tarteel manual city search failed', cause);
      setError(String(cause?.message || cause)); setStatus('');
    } finally { setBusy(false); }
  };

  const save = async event => {
    event.preventDefault();
    if (!location || methodId === '' || school === '') {
      setError('اختر الموقع وطريقة الحساب وطريقة العصر قبل الحفظ.'); return;
    }
    setBusy(true); setError(''); setStatus('جارٍ طلب إذن الإشعارات ثم التحقق من المواقيت…');
    let notificationsAllowed = false;
    try {
      notificationsAllowed = await isPermissionGranted();
      if (!notificationsAllowed) notificationsAllowed = (await requestPermission()) === 'granted';
    } catch (cause) {
      console.error('Tarteel notification permission request failed', cause);
      setStatus(`لم يكتمل طلب إذن إشعارات Windows: ${String(cause)}. سيظل الجدول داخل التطبيق؛ تحقق من إعدادات الإشعارات.`);
    }
    try {
      await onSave({ location, methodId: Number(methodId), school: Number(school), notificationsAllowed });
      setStatus(notificationsAllowed ? 'حُفظ الموقع والمواقيت وإذن الإشعارات.' : 'حُفظ الموقع والمواقيت، لكن إشعارات Windows غير ممنوحة.');
    } catch (cause) {
      setError(String(cause?.message || cause)); setStatus('');
    } finally { setBusy(false); }
  };

  return <div className="prayer-settings-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="prayer-settings glass" role="dialog" aria-modal="true" aria-labelledby="prayer-settings-title" dir="rtl">
      <header className="prayer-settings-head"><div><h2 id="prayer-settings-title">إعدادات الصلاة والتنبيهات</h2><p>اختر موقعًا معلومًا وطريقة الحساب قبل عرض أي مواقيت.</p></div><button type="button" className="ps-close" aria-label="إغلاق الإعدادات" onClick={onClose}>×</button></header>
      <div className="ps-section">
        <h3>الموقع</h3>
        <div className="ps-current" aria-live="polite">{location ? <><b>{location.source === 'manual' ? `اختيار يدوي: ${location.city}${location.country ? `، ${location.country}` : ''}` : 'موقع الجهاز'}</b><span>{Number(location.latitude).toFixed(4)}, {Number(location.longitude).toFixed(4)}{location.timezone ? ` · ${location.timezone}` : ''}</span></> : 'لم يُحدّد موقع بعد.'}</div>
        <button type="button" className="ps-action" onClick={useDeviceLocation} disabled={busy}>استخدام موقع الجهاز وطلب الإذن</button>
        <form className="ps-city-search" onSubmit={findCities}><label htmlFor="ps-city">أو ابحث عن مدينة لاختيارها يدويًا</label><div><input id="ps-city" value={query} onChange={event => setQuery(event.target.value)} placeholder="المدينة، الدولة" autoComplete="off"/><button type="submit" disabled={busy || [...query.trim()].length < 2}>بحث</button></div></form>
        {results.length > 0 && <div className="ps-results" role="listbox" aria-label="نتائج المدن">{results.map((item, index) => <button type="button" key={`${item.geonamesId ?? item.city}-${item.timezone}-${index}`} role="option" aria-selected={location?.geonamesId === item.geonamesId && location?.source === 'manual'} onClick={() => { setLocation(item); setStatus(`سيُستخدم اختيار يدوي: ${item.city}${item.country ? `، ${item.country}` : ''} (${item.timezone}).`); setResults([]); }}><b>{item.city}{item.admin1 ? `، ${item.admin1}` : ''}</b><span>{item.country} · {item.timezone}</span></button>)}</div>}
      </div>
      <div className="ps-grid">
        <label>طريقة حساب المواقيت<select value={methodId} onChange={event => setMethodId(event.target.value)} disabled={busy || !methods.length}><option value="">اختر طريقة الحساب</option>{methods.map(method => <option value={method.id} key={`${method.key}-${method.id}`}>{method.name}</option>)}</select></label>
        <label>حساب صلاة العصر<select value={school} onChange={event => setSchool(event.target.value)} disabled={busy}><option value="">اختر المذهب</option><option value="0">قياسي (شافعي/مالكي/حنبلي)</option><option value="1">حنفي</option></select></label>
      </div>
      <p className="ps-source">مصدر المواقيت: AlAdhan؛ تُرسل إليه إحداثيات الموقع المختار لجلبها. ويُستخدم Open-Meteo فقط للبحث اليدوي عن المدن. يبقى الاختيار اليدوي معلّمًا بوضوح، وتُراعى منطقته الزمنية والتوقيت الصيفي؛ لا تُعرض مواقيت افتراضية عند فشل المصدر.</p>
      {methodError && <p className="ps-error" role="alert">تعذر تحميل طرق الحساب من المصدر: {methodError}</p>}
      {error && <p className="ps-error" role="alert">{error}</p>}
      {status && <p className="ps-status" role="status">{status}</p>}
      <footer className="ps-actions"><button type="button" className="ps-cancel" onClick={onClose} disabled={busy}>إلغاء</button><button type="button" className="ps-save" onClick={save} disabled={busy || !location || methodId === '' || school === ''}>{busy ? 'جارٍ التحقق…' : 'حفظ واختبار المواقيت'}</button></footer>
    </section>
  </div>;
}
