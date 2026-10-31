import { useEffect, useMemo, useState } from 'react';
import { ARABIC_NAMES } from './engine/astro.js';

/**
 * جدول مواقيت اليوم الكامل.
 *
 * قرارات العرض:
 *   • كل الصلوات الست بما فيها الشروق — لأن الشروق حدّ فاصل يحتاجه الصائم.
 *   • الأرقام والأوقات بالأرقام العربية الهندية (٠١٢٣٤٥٦٧٨٩) وص/م.
 *   • شارة حيّة لكل صف: «الآن» للصلاة الجارية، «التالية» للقادمة، «تمت» للمنقضية.
 *   • الشروق ليس صلاة، فلا يأخذ شارة «الآن» ولا «التالية» أبدًا.
 *   • اسم المدينة بالعربية أعلى الجدول، ولا تُعرض أي منطقة زمنية إنجليزية.
 */

const DIGITS = '٠١٢٣٤٥٦٧٨٩';
const toArabicDigits = value => String(value).replace(/\d/g, d => DIGITS[d]);

/** وقت عربي 12 ساعة بصيغة «٤:٤٠ ص». */
export function arabicClock(epochMs, timeZone) {
  if (!Number.isFinite(epochMs)) return '—';
  const formatted = new Intl.DateTimeFormat('ar-EG', {
    timeZone, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(epochMs));
  /* ar-EG يعطي «٤:٤٠ ص» أصلًا في معظم البيئات، لكن بعض الإصدارات تستخدم
     الأرقام اللاتينية؛ نُطبّع دائمًا لضمان أرقام عربية. */
  return toArabicDigits(formatted);
}

const PRAYER_KEYS = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

/** الصلوات المؤهلة للشارات: كل شيء عدا الشروق. */
const BADGE_KEYS = new Set(['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']);

/**
 * يحسب حالة كل صف من لحظة الآن.
 * @returns {Array<{key, name, at, localTime, status, remainingMs}>}
 */
export function buildRows(schedule, now) {
  if (!Array.isArray(schedule?.events)) return [];
  const timeZone = schedule.timeZone;
  const todayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now));

  const today = schedule.events
    .filter(event => event.date === todayKey && PRAYER_KEYS.includes(event.key))
    .sort((a, b) => a.at - b.at);

  /* الصلاة الجارية: آخر صلاة مضت (الشروق لا يُعدّ صلاة). */
  const past = today.filter(event => event.at <= now && BADGE_KEYS.has(event.key));
  const currentKey = past.length ? past[past.length - 1].key : null;
  /* الصلاة القادمة: أول صلاة لم تمض. */
  const future = today.find(event => event.at > now && BADGE_KEYS.has(event.key));
  const nextKey = future?.key || null;

  return today.map(event => {
    let status = 'done';
    if (event.key === currentKey) status = 'current';
    else if (event.key === nextKey) status = 'next';
    else if (event.at > now) status = 'waiting';
    else status = 'done';
    /* الشروق لا يحمل شارة صلاة. */
    if (event.key === 'sunrise') status = event.at > now ? 'waiting' : 'done';
    return {
      key: event.key,
      name: ARABIC_NAMES[event.key] || event.key,
      at: event.at,
      localTime: arabicClock(event.at, timeZone),
      status,
      remainingMs: event.at - now,
    };
  });
}

const STATUS_LABEL = { current: 'الآن', next: 'التالية', done: 'تمت', waiting: '' };

export default function DailyPrayerTable({ schedule, placeName, onOpenSettings }) {
  const [now, setNow] = useState(() => Date.now());

  /* تحديث كل 15 ثانية: يكفي لتغيير الشارات في موعدها دون إثقال الواجهة. */
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);

  const rows = useMemo(() => buildRows(schedule, now), [schedule, now]);

  if (!schedule || !rows.length) {
    return (
      <section className="times glass" dir="rtl" aria-label="مواقيت الصلاة">
        <header className="times-head">
          <h2>مواقيت الصلاة</h2>
          <button type="button" className="times-place" onClick={onOpenSettings}>
            تحديد موقعي
          </button>
        </header>
        <p className="times-empty">لا توجد مواقيت بعد — حدّد موقعك من الإعدادات ليُحسب الجدول تلقائيًا.</p>
      </section>
    );
  }

  return (
    <section className="times glass" dir="rtl" aria-label="مواقيت الصلاة">
      <header className="times-head">
        <h2>مواقيت الصلاة</h2>
        <button type="button" className="times-place" onClick={onOpenSettings} title="تغيير الموقع">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
            <path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11Z" />
            <circle cx="12" cy="10" r="2.6" />
          </svg>
          <span>{placeName || 'موقعي'}</span>
        </button>
      </header>

      <ol className="times-list">
        {rows.map(row => (
          <li key={row.key} className={`times-row is-${row.status}`}>
            <span className="times-name">{row.name}</span>
            <span className="times-time">{row.localTime}</span>
            <span className="times-badge" data-status={row.status}>
              {STATUS_LABEL[row.status]}
            </span>
          </li>
        ))}
      </ol>

      {rows.some(r => r.status === 'next') && (
        <p className="times-foot">
          متبقّي على {rows.find(r => r.status === 'next').name}:{' '}
          {toArabicDigits(countdown(rows.find(r => r.status === 'next').remainingMs))}
        </p>
      )}
    </section>
  );
}

/** عدّاد مختصر «٢:١٥:٠٤» أو «١٥:٠٤». */
function countdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
