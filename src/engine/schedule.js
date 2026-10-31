/**
 * تَرتيل — منظّم الجدول (Schedule Coordinator)
 * =============================================
 * يربط محرك الموقع بالمحرك الفلكي وينتج جدولًا موحّدًا يُغذّي:
 *   • الواجهة (الجزيرة والنافذة الرئيسية)
 *   • جدولة Rust (set_alarm_schedule)
 *   • مهام ويندوز المجدولة (sync_windows_tasks)
 *
 * القواعد الحاكمة:
 *   1. كل المواعيد لحظات مطلقة (epoch ms) — لا ساعات ولا نصوص.
 *   2. الطريقة الفقهية ومعامل العصر مشتقان من الدولة تلقائيًا، ولا يُسأل
 *      المستخدم عن طريقة حساب دولته.
 *   3. عند غياب الموقع لا يُنتج جدولًا ولا يُخمّن: تبقى المنظومة صامتة
 *      بصدق بدل أوقات خاطئة.
 *   4. الجدول يُعاد بناؤه عند: تغيّر الموقع، تغيّر اليوم المدني، تغيّر
 *      المنطقة الزمنية، أو مضيّ 24 ساعة على آخر بناء.
 */

import { ARABIC_NAMES, nextPrayer, currentPrayer } from './astro.js';
import { haversineKm } from './location.js';
/* المحرك الفلكي المنقول من Dar-Al-Hikayat: مكتبة adhan الرسمية، عبر سلسلة
   UTC متصلة. يحل محل الحساب اليدوي السابق بالكامل. */
import { getDayPrayers } from '../lib/prayer-times.ts';

/** عدد الأيام المحسوبة مسبقًا. 3 أيام تكفي للمسار المتصل حول منتصف الليل. */
export const TIMELINE_DAYS = 3;

/** الأيام التي تُجدول لها مهام ويندوز. أسبوع كامل يغطي أي انقطاع. */
export const TASK_HORIZON_DAYS = 7;

/** الصلوات التي يُطلق لها تنبيه. الشروق ليس صلاة. */
const ALARM_KEYS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];

/**
 * يبني جدولًا كاملًا من موقع مؤكد.
 *
 * @param {object} location نتيجة resolveLocation (تحتوي timeZone وcountryCode)
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {object} [options.adjust] إزاحات يدوية بالدقائق (−5..+5)
 * @returns {{events:Array, days:Array, method:string, methodName:string, timeZone:string, builtAt:number}}
 */
export function buildSchedule(location, { now = Date.now(), adjust, methodId, shadowFactor } = {}) {
  if (!location || !Number.isFinite(Number(location.latitude)) || !Number.isFinite(Number(location.longitude))) {
    throw new Error('لا يمكن بناء جدول دون موقع مؤكد.');
  }
  const timeZone = location.timeZone || location.timezoneId;
  if (!timeZone) throw new Error('لا يمكن بناء جدول دون منطقة زمنية IANA.');

  /* معرّف الطريقة بصيغة المرجع (egyptian | umm_al_qura | mwl | isna | karachi). */
  const method = resolveMethodId(methodId, location.countryCode, timeZone);
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);

  /*
   * سلسلة فلكية متصلة: نبدأ من يوم أمس ونحسب عدة أيام، ثم نصلها زمنيًا.
   * بهذا لا يوجد أي احتمال للالتباس بين التوقيت الصيفي والشتوي: كل موعد
   * يُحسب داخل منطقته الزمنية ثم يُحوّل إلى لحظة UTC مطلقة.
   */
  const events = [];
  const days = [];
  for (let offset = -1; offset < TIMELINE_DAYS; offset += 1) {
    const dayDate = new Date(now + offset * 86400000);
    const day = getDayPrayers(latitude, longitude, dayDate, method, timeZone);
    days.push(day);
    for (const prayer of day.prayers) {
      const at = Math.round(prayer.time.getTime());
      if (!Number.isFinite(at)) continue;
      events.push({
        id: `${day.date}|${prayer.prayerId}`,
        key: prayer.prayerId,
        name: arabicName(prayer.prayerId),
        date: day.date,
        at,
        localTime: formatPrayerTime(prayer.time, timeZone),
        timeZone,
      });
    }
  }
  events.sort((a, b) => a.at - b.at);

  /* الإزاحة اليدوية الاختيارية تُطبّق على المواعيد القادمة فقط. */
  const adjusted = applyAdjust(events, adjust);
  /* أحداث الآيلاند: ستة صفوف كما هو تصميمها. */
  const islandEvents = adjusted.filter(event => ISLAND_KEYS.has(event.key));

  return {
    location: {
      latitude,
      longitude,
      timeZone,
      countryCode: location.countryCode || '',
      resolvedAt: location.resolvedAt || now,
    },
    events: islandEvents,
    days,
    method,
    methodName: METHOD_NAMES[method] || method,
    requestedMethod: methodId || 'auto',
    shadowFactor: Number.isFinite(Number(shadowFactor)) ? Number(shadowFactor) : 1,
    timeZone,
    /* توافق صريح مع عقد الآيلاند الذي يقرأ schedule.timezone بحرف صغير. */
    timezone: timeZone,
    builtAt: now,
  };
}

/* المرجع يضيف «الضحى» كوقت سابع. آيلاند تَرتيل مُصمَّم لستة صفوف بارتفاع
   ثابت (188px)، فإضافة صف سابع تكسر التصميم. الضحى ليس صلاة مفروضة، ويبقى
   محسوبًا في days الكاملة. */
const ISLAND_KEYS = new Set(['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha']);

/** الاسم العربي لكل مفتاح، بما في ذلك ما لا تعرفه astro مثل الضحى. */
const EXTRA_NAMES = { duha: 'الضحى' };
const arabicName = key => ARABIC_NAMES[key] || EXTRA_NAMES[key] || key;

/** أسماء الطرق كما في المرجع. */
export const METHOD_NAMES = {
  egyptian: 'الهيئة المصرية العامة للمساحة (١٩٫٥/١٧٫٥)',
  umm_al_qura: 'أم القرى',
  mwl: 'رابطة العالم الإسلامي',
  isna: 'الجمعية الإسلامية لأمريكا الشمالية',
  karachi: 'جامعة العلوم الإسلامية بكراتشي',
};

/** يترجم اختيار المستخدم أو الدولة إلى معرّف طريقة من معرّفات المرجع. */
export function resolveMethodId(methodId, countryCode, timeZone) {
  if (methodId && methodId !== 'auto' && METHOD_NAMES[methodId]) return methodId;
  const cc = String(countryCode || '').toUpperCase();
  if (cc === 'EG' || cc === 'SD' || cc === 'SY' || cc === 'JO' || cc === 'LB' || cc === 'PS' || cc === 'YE' || cc === 'LY') return 'egyptian';
  if (cc === 'SA' || cc === 'AE' || cc === 'KW' || cc === 'QA' || cc === 'BH' || cc === 'OM' || cc === 'YE') return 'umm_al_qura';
  if (cc === 'PK' || cc === 'IN' || cc === 'BD' || cc === 'AF' || cc === 'TR' || cc === 'LK' || cc === 'NP') return 'karachi';
  if (cc === 'US' || cc === 'CA') return 'isna';
  if (cc) return 'mwl';
  /* بلا رمز دولة: نستنتج من المنطقة الزمنية. */
  if (timeZone === 'Africa/Cairo') return 'egyptian';
  if (/^Asia\/(Riyadh|Dubai|Kuwait|Qatar|Bahrain|Muscat|Aden)/.test(timeZone || '')) return 'umm_al_qura';
  if (/^Asia\/(Karachi|Kolkata|Dhaka|Kabul)/.test(timeZone || '')) return 'karachi';
  if (/^America\//.test(timeZone || '')) return 'isna';
  return 'mwl';
}

/** إزاحة يدوية اختيارية بالدقائق (−10..+10)، على الصلوات فقط دون الشروق. */
function applyAdjust(events, adjust) {
  if (!adjust || typeof adjust !== 'object') return events;
  return events.map(event => {
    const delta = Number(adjust[event.key]);
    if (!Number.isFinite(delta) || delta === 0) return event;
    const clamped = Math.max(-10, Math.min(10, Math.round(delta)));
    return { ...event, at: event.at + clamped * 60000 };
  });
}

/** وقت عربي بصيغة المرجع نفسه. */
function formatPrayerTime(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('ar-EG', {
      timeZone, hour: 'numeric', minute: '2-digit', hourCycle: 'h12',
    }).format(date);
  } catch {
    return '';
  }
}

/**
 * يبني الحمولة المرسلة إلى Rust: لحظات صحيحة، واسم عربي، ومفتاح.
 * التحصين هنا خط الدفاع الأخير قبل IPC: أي كسر عشري يفشل فك الترميز في Rust
 * ويُسقط الجدولة كلها، فلا نسمح به بالمرور.
 */
export function toNativeEvents(schedule) {
  if (!Array.isArray(schedule?.events)) return [];
  return schedule.events
    .filter(event => Number.isFinite(Number(event.at)))
    .map(event => ({
      id: String(event.id),
      key: String(event.key),
      name: String(event.name || ARABIC_NAMES[event.key] || event.key),
      at: Math.round(Number(event.at)),
    }));
}

/** الأحداث التي تستحق تنبيهًا فقط (بلا شروق). */
export function alarmEvents(schedule, now = Date.now()) {
  if (!Array.isArray(schedule?.events)) return [];
  return schedule.events.filter(event => ALARM_KEYS.includes(event.key) && event.at > now);
}

/**
 * مهام ويندوز المقترحة: كل صلاة داخل أفق أسبوع.
 * تُستخدم لتغذية sync_windows_tasks في Rust.
 */
export function tasksWithinHorizon(schedule, now = Date.now(), days = TASK_HORIZON_DAYS) {
  const horizon = now + days * 24 * 3600 * 1000;
  return alarmEvents(schedule, now).filter(event => event.at <= horizon);
}

/**
 * هل يحتاج الجدول إعادة بناء؟
 *
 * تمييز مقصود: تحديث *الموقع* له شروط (حركة، عمر القراءة) لأن قراءة Wi-Fi
 * تتغيّر، أمّا إعادة بناء *الجدول* فحسابٌ محض لا يحتاج قراءة موقع جديدة.
 * لذلك نقارن الإحداثيات والمنطقة نفسها هنا، ولا نستخدم عمر قراءة الموقع.
 *
 * الأسباب: تغيّر الإحداثيات، أو المنطقة الزمنية، أو اليوم المدني، أو مرور
 * 24 ساعة، أو انتهاء كل المواعيد.
 */
export function scheduleNeedsRebuild(schedule, location, now = Date.now()) {
  if (!schedule || !Array.isArray(schedule.events) || schedule.events.length === 0) return true;
  if (!location) return true;
  const saved = schedule.location;
  if (!saved) return true;
  if (saved.timeZone !== location.timeZone) return true;
  if (schedule.timeZone !== location.timeZone) return true;
  if (!Number.isFinite(saved.latitude) || !Number.isFinite(saved.longitude)) return true;
  if (haversineKm(saved, location) > 0.5) return true;
  if (now - Number(schedule.builtAt || 0) > 24 * 3600 * 1000) return true;
  /* هل ما زال هناك موعد قادم؟ لو انتهت كل المواعيد فالجدول متأخر. */
  return !schedule.events.some(event => event.at > now);
}

/** الموعد القادم من الجدول. */
export function upcoming(schedule, now = Date.now()) {
  return nextPrayer(schedule?.events, now);
}

/**
 * الصلاة الحالية: آخر صلاة مضت. الشروق ليس صلاة، فلا يُعدّ "الصلاة الحالية"
 * حتى لا تعرض الجزيرة «الشروق» في خانة الصلاة القائمة.
 */
export function current(schedule, now = Date.now()) {
  const past = currentPrayer(schedule?.events, now);
  if (!past) return null;
  if (past.key !== 'sunrise') return past;
  const index = schedule.events.indexOf(past);
  for (let i = index - 1; i >= 0; i--) {
    if (schedule.events[i].key !== 'sunrise') return schedule.events[i];
  }
  return null;
}

/** الوقت المتبقي بصيغة مقروءة. */
export function countdownLabel(msRemaining) {
  const total = Math.max(0, Math.floor(Number(msRemaining) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * صياغة نص التنبيه. تُستخدم للإشعار وللبطاقة معًا، فلا يختلف النص بينهما.
 */
export function alarmCopy(event, { paused = false, resumeDisabled = false } = {}) {
  const name = event?.name || ARABIC_NAMES[event?.key] || '';
  return {
    title: `حان وقت صلاة ${name}`,
    body: resumeDisabled
      ? 'انتهى مؤقت النوم؛ لن تُستأنف التلاوة تلقائيًا.'
      : paused
        ? 'أُوقفت التلاوة مؤقتًا، ويمكنك استئنافها بعد الأذان.'
        : 'حان موعد الصلاة وفق موقعك وتوقيتك المحلي.',
  };
}
