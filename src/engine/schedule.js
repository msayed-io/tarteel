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

import { buildTimeline, computeDay, ARABIC_NAMES, nextPrayer, currentPrayer } from './astro.js';
import { haversineKm } from './location.js';

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
  if (!location.timeZone) throw new Error('لا يمكن بناء جدول دون منطقة زمنية IANA.');

  const common = {
    latitude: Number(location.latitude),
    longitude: Number(location.longitude),
    timeZone: location.timeZone,
    countryCode: location.countryCode || '',
    adjust,
    methodId,
    shadowFactor,
  };

  const events = buildTimeline({ ...common, from: now, daysAhead: TIMELINE_DAYS });

  /* الأيام نفسها تبقى متاحة للعرض في النافذة الرئيسية دون إعادة حساب. */
  const days = [];
  const seen = new Set();
  for (const event of events) {
    if (seen.has(event.date)) continue;
    seen.add(event.date);
    const day = computeDay({ ...common, year: +event.date.slice(0, 4), month: +event.date.slice(5, 7), day: +event.date.slice(8, 10) });
    days.push(day);
  }

  const sample = computeDay({
    ...common,
    year: +events[0].date.slice(0, 4),
    month: +events[0].date.slice(5, 7),
    day: +events[0].date.slice(8, 10),
  });

  return {
    /* الموقع محفوظ مع الجدول لأنه شرط فحص التحديث: بدونه يعيد البناء دائمًا. */
    location: {
      latitude: common.latitude,
      longitude: common.longitude,
      timeZone: common.timeZone,
      countryCode: common.countryCode,
      resolvedAt: location.resolvedAt || now,
    },
    events: events.map(event => ({
      id: event.id,
      key: event.key,
      name: ARABIC_NAMES[event.key] || event.key,
      date: event.date,
      at: event.at,
      localTime: event.localTime,
      timeZone: event.timeZone,
    })),
    days,
    method: sample.method,
    methodName: sample.methodName,
    requestedMethod: methodId || 'auto',
    shadowFactor: sample.shadowFactor,
    timeZone: location.timeZone,
    builtAt: now,
  };
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
