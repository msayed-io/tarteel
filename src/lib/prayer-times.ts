/**
 * حساب مواقيت الصلاة الفلكية — نظام موحد يعتمد على التوقيت العالمي (UTC)
 * والمنطقة الزمنية الديناميكية (IANA Time Zone Database) لضمان الدقة التامة
 * في التحول بين التوقيت الصيفي والشتوي.
 */
import {
  Coordinates,
  PrayerTimes as AdhanPrayerTimes,
  CalculationMethod,
} from "adhan";
import type { CalculationMethodId, PrayerId, PrayerLocation } from "./prayer-config";
import { PRAYER_DEFINITIONS } from "./prayer-config";

export interface TimedPrayer {
  prayerId: PrayerId;
  time: Date;
  minutesFromMidnight: number;
  isoTime?: string;
  timeFormatted?: string;
}

export interface DailyPrayers {
  date: string;
  prayers: TimedPrayer[];
}

export interface SecondaryPrayerTimes {
  duha: string;
  midnight: string;
  firstThird: string;
  lastThird: string;
}

export interface PrayerTimelineItem {
  key: PrayerId;
  name: string;
  date: Date;
  isoTime: string;
  timeFormatted: string;
  isMandatory: boolean;
  isCurrent: boolean;
  isNext: boolean;
  status: "الآن" | "التالية" | "تمت" | "قادمة";
}

export interface PrayerTimeline {
  current: {
    key: PrayerId;
    name: string;
    date: Date;
    isoTime: string;
    timeFormatted: string;
    isToday: boolean;
  };
  next: {
    key: PrayerId;
    name: string;
    date: Date;
    isoTime: string;
    timeFormatted: string;
    isToday: boolean;
  };
  remainingSeconds: number;
  countdownLabel: string;
  progress: number;
  augmentedSchedule: PrayerTimelineItem[];
  secondaryTimes: SecondaryPrayerTimes;
  timezoneInfo: {
    timezoneId: string;
    offsetMinutes: number;
    offsetString: string;
    isDst: boolean;
    standardLabelAr: string;
  };
}

/** خريطة طرق الحساب إلى بارامترات adhan الرسمية */
export function methodParams(method: CalculationMethodId) {
  switch (method) {
    case "egyptian":
      return CalculationMethod.Egyptian();
    case "umm_al_qura":
      return CalculationMethod.UmmAlQura();
    case "mwl":
      return CalculationMethod.MuslimWorldLeague();
    case "isna":
      return CalculationMethod.NorthAmerica();
    case "karachi":
      return CalculationMethod.Karachi();
    default:
      return CalculationMethod.Egyptian();
  }
}

/** دقائق من منتصف الليل في المنطقة الزمنية المحددة */
export function minutesFromMidnight(d: Date, timezoneId: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezoneId,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    let hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
    if (hour === 24) hour = 0;
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
    return hour * 60 + minute;
  } catch {
    return d.getHours() * 60 + d.getMinutes();
  }
}

/** استخراج أجزاء التاريخ المدني في المنطقة الزمنية المستهدفة بدقة */
export function datePartsInTimezone(
  date: Date,
  timezoneId: string = "Africa/Cairo"
): { year: number; month: number; day: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezoneId,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    return {
      year: Number(parts.find((part) => part.type === "year")?.value),
      month: Number(parts.find((part) => part.type === "month")?.value),
      day: Number(parts.find((part) => part.type === "day")?.value),
    };
  } catch {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
    };
  }
}

/**
 * حساب التاريخ المدني المستهدف مع إضافة إزاحة أيام (+1 للغد، -1 للأمس)،
 * مع تعيين ساعة الظهر (12:00) لتجنب أي تأثير لاختلافات التوقيت الصيفي/الشتوي.
 */
export function getCivilDate(
  date: Date,
  dayOffset: number = 0,
  timezoneId: string = "Africa/Cairo"
): Date {
  const parts = datePartsInTimezone(date, timezoneId);
  const anchorUtc = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset, 12, 0, 0)
  );
  return new Date(
    anchorUtc.getUTCFullYear(),
    anchorUtc.getUTCMonth(),
    anchorUtc.getUTCDate(),
    12,
    0,
    0
  );
}

/** تحويل التاريخ إلى Date يمكن لـ adhan استخدامه محلياً */
export function calendarDateInTimezone(date: Date, timezoneId: string = "Africa/Cairo"): Date {
  return getCivilDate(date, 0, timezoneId);
}

/** حساب فارق التوقيت بالدقائق عن UTC لمنطقة زمنية معينة في تاريخ محدد */
export function getTimezoneOffsetMinutes(
  date: Date,
  timezoneId: string = "Africa/Cairo"
): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezoneId,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
    const y = Number(get("year"));
    const m = Number(get("month"));
    const d = Number(get("day"));
    let h = Number(get("hour"));
    if (h === 24) h = 0;
    const min = Number(get("minute"));
    const s = Number(get("second"));

    const localUtc = new Date(Date.UTC(y, m - 1, d, h, min, s));
    return Math.round((localUtc.getTime() - date.getTime()) / 60000);
  } catch {
    return 120; // Default +02:00
  }
}

/** صياغة التاريخ والوقت بصيغة ISO 8601 القياسية المتضمنة لفرق التوقيت الصريح (مثل +02:00) */
export function formatIsoWithOffset(
  date: Date,
  timezoneId: string = "Africa/Cairo"
): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezoneId,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
    const y = get("year");
    const m = get("month");
    const d = get("day");
    let h = get("hour");
    if (h === "24") h = "00";
    const min = get("minute");
    const s = get("second");

    const offsetMinutes = getTimezoneOffsetMinutes(date, timezoneId);
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMinutes);
    const offH = String(Math.floor(abs / 60)).padStart(2, "0");
    const offM = String(abs % 60).padStart(2, "0");
    return `${y}-${m}-${d}T${h}:${min}:${s}${sign}${offH}:${offM}`;
  } catch {
    return date.toISOString();
  }
}

/** التحقق هل التاريخ الحالي يقع في التوقيت الصيفي لمنطقة IANA المحددة */
export function isDstActive(date: Date, timezoneId: string = "Africa/Cairo"): boolean {
  try {
    const janDate = new Date(date.getFullYear(), 0, 15);
    const currentOffset = getTimezoneOffsetMinutes(date, timezoneId);
    const janOffset = getTimezoneOffsetMinutes(janDate, timezoneId);
    return currentOffset > janOffset;
  } catch {
    return false;
  }
}

/** منتصف الوقت بين لحظتين زمنيتين */
function midpoint(a: Date, b: Date): Date {
  return new Date((a.getTime() + b.getTime()) / 2);
}

/**
 * حساب مواقيت يوم واحد بدقة فلكية تامة، مع إرجاع كائنات Date مستندة لـ UTC
 * وتنسيق نصي في المنطقة الزمنية المطلوبة.
 */
export function getDayPrayers(
  latitude: number,
  longitude: number,
  date: Date,
  method: CalculationMethodId = "egyptian",
  timezoneId: string = "Africa/Cairo"
): DailyPrayers {
  const calendarDate = calendarDateInTimezone(date, timezoneId);
  const coordinates = new Coordinates(latitude, longitude);
  const params = methodParams(method);
  const pt = new AdhanPrayerTimes(coordinates, calendarDate, params);

  const duha = midpoint(pt.sunrise, pt.dhuhr);

  const prayers: TimedPrayer[] = [
    {
      prayerId: "fajr",
      time: pt.fajr,
      minutesFromMidnight: minutesFromMidnight(pt.fajr, timezoneId),
      isoTime: formatIsoWithOffset(pt.fajr, timezoneId),
      timeFormatted: formatPrayerTime(pt.fajr, timezoneId),
    },
    {
      prayerId: "sunrise",
      time: pt.sunrise,
      minutesFromMidnight: minutesFromMidnight(pt.sunrise, timezoneId),
      isoTime: formatIsoWithOffset(pt.sunrise, timezoneId),
      timeFormatted: formatPrayerTime(pt.sunrise, timezoneId),
    },
    {
      prayerId: "duha",
      time: duha,
      minutesFromMidnight: minutesFromMidnight(duha, timezoneId),
      isoTime: formatIsoWithOffset(duha, timezoneId),
      timeFormatted: formatPrayerTime(duha, timezoneId),
    },
    {
      prayerId: "dhuhr",
      time: pt.dhuhr,
      minutesFromMidnight: minutesFromMidnight(pt.dhuhr, timezoneId),
      isoTime: formatIsoWithOffset(pt.dhuhr, timezoneId),
      timeFormatted: formatPrayerTime(pt.dhuhr, timezoneId),
    },
    {
      prayerId: "asr",
      time: pt.asr,
      minutesFromMidnight: minutesFromMidnight(pt.asr, timezoneId),
      isoTime: formatIsoWithOffset(pt.asr, timezoneId),
      timeFormatted: formatPrayerTime(pt.asr, timezoneId),
    },
    {
      prayerId: "maghrib",
      time: pt.maghrib,
      minutesFromMidnight: minutesFromMidnight(pt.maghrib, timezoneId),
      isoTime: formatIsoWithOffset(pt.maghrib, timezoneId),
      timeFormatted: formatPrayerTime(pt.maghrib, timezoneId),
    },
    {
      prayerId: "isha",
      time: pt.isha,
      minutesFromMidnight: minutesFromMidnight(pt.isha, timezoneId),
      isoTime: formatIsoWithOffset(pt.isha, timezoneId),
      timeFormatted: formatPrayerTime(pt.isha, timezoneId),
    },
  ];

  const dateParts = datePartsInTimezone(date, timezoneId);
  const dateStr = `${dateParts.year}-${String(dateParts.month).padStart(2, "0")}-${String(dateParts.day).padStart(2, "0")}`;

  return { date: dateStr, prayers };
}

/** مواقيت اليوم والغد */
export function getTodayAndTomorrow(
  latitude: number,
  longitude: number,
  method: CalculationMethodId = "egyptian",
  timezoneId: string = "Africa/Cairo"
): { today: DailyPrayers; tomorrow: DailyPrayers } {
  const now = new Date();
  const tomorrow = getCivilDate(now, 1, timezoneId);
  return {
    today: getDayPrayers(latitude, longitude, now, method, timezoneId),
    tomorrow: getDayPrayers(latitude, longitude, tomorrow, method, timezoneId),
  };
}

/**
 * تنسيق الوقت بصيغة عربية (١٢ ساعة + ص/م).
 * تستخدم Intl مع المنطقة الزمنية للموقع لعرض وقت المدينة المختارة بدقة تامة.
 */
export function formatPrayerTime(date: Date, timezoneId: string = "Africa/Cairo"): string {
  try {
    const formatted = new Intl.DateTimeFormat("ar-EG", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: timezoneId,
    }).format(date);
    return normalizeArabicTime(formatted);
  } catch {
    let hours = date.getHours();
    const minutes = date.getMinutes();
    const period = hours >= 12 ? "م" : "ص";
    if (hours > 12) hours -= 12;
    if (hours === 0) hours = 12;
    return `${hours}:${String(minutes).padStart(2, "0")} ${period}`;
  }
}

/** تطبيع ناتج Intl العربي (أرقام هندية → قياسية + توحيد ص/م) */
export function normalizeArabicTime(input: string): string {
  const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
  let out = input;
  for (let i = 0; i < 10; i++) {
    out = out.replace(new RegExp(arabicDigits[i], "g"), String(i));
  }
  out = out.replace(/\s+/g, " ").trim();

  const match = out.match(/(\d{1,2}):(\d{2})\s*(ص|م)?/);
  if (match) {
    let h = parseInt(match[1], 10);
    const m = match[2];
    let period = match[3];
    if (!period) period = h >= 12 ? "م" : "ص";
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${m} ${period}`;
  }
  return out;
}

/** مواقيت اليوم جاهزة للعرض بالواجهة */
export async function getFormattedPrayerTimes(
  location: PrayerLocation,
  method: CalculationMethodId
): Promise<{ name: string; time: string; prayerId: PrayerId }[]> {
  const { today } = getTodayAndTomorrow(
    location.latitude,
    location.longitude,
    method,
    location.timezoneId
  );
  return today.prayers.map((p) => ({
    name: PRAYER_DEFINITIONS[p.prayerId].nameAr,
    time: formatPrayerTime(p.time, location.timezoneId),
    prayerId: p.prayerId,
  }));
}

/**
 * حساب الأوقات التابعة للصلوات (الضحى، منتصف الليل، الثلث الأول، الثلث الأخير)
 * مع الأخذ في الاعتبار الليل الحالي (بين مغرب الأمس وفجر اليوم إذا كان الوقت بعد منتصف الليل
 * وقبل الفجر، أو مغرب اليوم وفجر الغد لبقية اليوم).
 */
export function calculateSecondaryTimes(
  latitude: number,
  longitude: number,
  now: Date = new Date(),
  method: CalculationMethodId = "egyptian",
  timezoneId: string = "Africa/Cairo"
): SecondaryPrayerTimes {
  const coordinates = new Coordinates(latitude, longitude);
  const params = methodParams(method);

  const yDate = getCivilDate(now, -1, timezoneId);
  const tDate = getCivilDate(now, 0, timezoneId);
  const mDate = getCivilDate(now, 1, timezoneId);

  const ptYesterday = new AdhanPrayerTimes(coordinates, yDate, params);
  const ptToday = new AdhanPrayerTimes(coordinates, tDate, params);
  const ptTomorrow = new AdhanPrayerTimes(coordinates, mDate, params);

  const nowMs = now.getTime();
  const isBeforeFajrToday = nowMs < ptToday.fajr.getTime();

  // الليل الشرعي: إما ليل الليلة الماضية الجارية (بين مغرب الأمس وفجر اليوم) أو ليل اليوم القادم
  const nightStart = isBeforeFajrToday ? ptYesterday.maghrib : ptToday.maghrib;
  const nightEnd = isBeforeFajrToday ? ptToday.fajr : ptTomorrow.fajr;

  const nightDurationMs = nightEnd.getTime() - nightStart.getTime();
  const midnightTime = new Date(nightStart.getTime() + nightDurationMs / 2);
  const firstThirdTime = new Date(nightStart.getTime() + nightDurationMs / 3);
  const lastThirdTime = new Date(nightEnd.getTime() - nightDurationMs / 3);

  // الضحى: الضحى الشرعي لليوم الجاري
  const duhaTime = midpoint(ptToday.sunrise, ptToday.dhuhr);

  return {
    duha: formatPrayerTime(duhaTime, timezoneId),
    midnight: formatPrayerTime(midnightTime, timezoneId),
    firstThird: formatPrayerTime(firstThirdTime, timezoneId),
    lastThird: formatPrayerTime(lastThirdTime, timezoneId),
  };
}

/**
 * المحرك الرئيسي المتكامل لحساب الخط الزمني للصلوات (Prayer Timeline Engine):
 * 1. يعتمد كلياً على التوقيت العالمي (UTC) في الحسابات الفلكية لمنع أي تكرار أو تشويش عند انتقال الساعة.
 * 2. يقضي تماماً على كارثة الـ 28 ساعة بين منتصف الليل وفجر اليوم عن طريق تتبع سلسلة الصلوات
 *    المستمرة [عشاء الأمس -> فجر اليوم -> ظهر -> عصر -> مغرب -> عشاء -> فجر الغد].
 * 3. يربط التوقيت بالمنطقة الزمنية IANA الرسمية تلقائياً (+02:00 في الشتوي، +03:00 في الصيفي لمصر).
 */
export function getPrayerTimeline(
  location: PrayerLocation,
  method: CalculationMethodId = "egyptian",
  now: Date = new Date()
): PrayerTimeline {
  const tz = location.timezoneId || "Africa/Cairo";
  const coordinates = new Coordinates(location.latitude, location.longitude);
  const params = methodParams(method);

  // 1. حساب مواقيت 3 أيام متتالية بربط فلكي محكم
  const yDate = getCivilDate(now, -1, tz);
  const tDate = getCivilDate(now, 0, tz);
  const mDate = getCivilDate(now, 1, tz);

  const ptYesterday = new AdhanPrayerTimes(coordinates, yDate, params);
  const ptToday = new AdhanPrayerTimes(coordinates, tDate, params);
  const ptTomorrow = new AdhanPrayerTimes(coordinates, mDate, params);

  const nowMs = now.getTime();

  // 2. السلسلة المتصلة للصلوات المفروضة الخمس
  const mandatoryChain = [
    { key: "isha" as PrayerId, name: "العشاء", date: ptYesterday.isha, isToday: false },
    { key: "fajr" as PrayerId, name: "الفجر", date: ptToday.fajr, isToday: true },
    { key: "dhuhr" as PrayerId, name: "الظهر", date: ptToday.dhuhr, isToday: true },
    { key: "asr" as PrayerId, name: "العصر", date: ptToday.asr, isToday: true },
    { key: "maghrib" as PrayerId, name: "المغرب", date: ptToday.maghrib, isToday: true },
    { key: "isha" as PrayerId, name: "العشاء", date: ptToday.isha, isToday: true },
    { key: "fajr" as PrayerId, name: "الفجر", date: ptTomorrow.fajr, isToday: false },
  ];

  // العثور على آخر صلاة دخل وقتها
  let currentIdx = 0;
  for (let i = mandatoryChain.length - 2; i >= 0; i--) {
    if (nowMs >= mandatoryChain[i].date.getTime()) {
      currentIdx = i;
      break;
    }
  }

  const currentPrayer = mandatoryChain[currentIdx];
  const nextPrayer = mandatoryChain[currentIdx + 1];

  // 3. حساب الوقت المتبقي والنسبة المئوية للمؤشر الدائري
  const currentStartMs = currentPrayer.date.getTime();
  const nextStartMs = nextPrayer.date.getTime();
  const totalPeriodMs = Math.max(1, nextStartMs - currentStartMs);
  const elapsedMs = Math.max(0, nowMs - currentStartMs);
  const progress = Math.min(1, Math.max(0, elapsedMs / totalPeriodMs));

  const remainingSeconds = Math.max(0, Math.floor((nextStartMs - nowMs) / 1000));
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;
  const countdownLabel = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  // 4. بناء جدول صلوات اليوم الست (بما فيها الشروق) مع علامات الحالة الصحيحة
  const scheduleDef: { key: PrayerId; name: string; date: Date; isMandatory: boolean }[] = [
    { key: "fajr", name: "الفجر", date: ptToday.fajr, isMandatory: true },
    { key: "sunrise", name: "الشروق", date: ptToday.sunrise, isMandatory: false },
    { key: "dhuhr", name: "الظهر", date: ptToday.dhuhr, isMandatory: true },
    { key: "asr", name: "العصر", date: ptToday.asr, isMandatory: true },
    { key: "maghrib", name: "المغرب", date: ptToday.maghrib, isMandatory: true },
    { key: "isha", name: "العشاء", date: ptToday.isha, isMandatory: true },
  ];

  const augmentedSchedule: PrayerTimelineItem[] = scheduleDef.map((p) => {
    // تفعيل علامة "الآن" فقط إذا كانت هذه الصلاة الحالية فعلياً لليوم الحالي
    const isCurrent = currentPrayer.isToday && p.key === currentPrayer.key;
    // تفعيل علامة "التالية" فقط إذا كانت هذه الصلاة القادمة فعلياً لليوم الحالي
    const isNext = nextPrayer.isToday && p.key === nextPrayer.key;

    let status: "الآن" | "التالية" | "تمت" | "قادمة";
    if (isCurrent) {
      status = "الآن";
    } else if (isNext) {
      status = "التالية";
    } else if (nowMs >= p.date.getTime()) {
      status = "تمت";
    } else {
      status = "قادمة";
    }

    return {
      key: p.key,
      name: p.name,
      date: p.date,
      isoTime: formatIsoWithOffset(p.date, tz),
      timeFormatted: formatPrayerTime(p.date, tz),
      isMandatory: p.isMandatory,
      isCurrent,
      isNext,
      status,
    };
  });

  // 5. الأوقات الإضافية (الضحى، منتصف الليل، أثلاث الليل)
  const secondaryTimes = calculateSecondaryTimes(
    location.latitude,
    location.longitude,
    now,
    method,
    tz
  );

  // 6. معلومات المنطقة الزمنية وحالة التوقيت الشتوي/الصيفي
  const offsetMinutes = getTimezoneOffsetMinutes(now, tz);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offH = String(Math.floor(abs / 60)).padStart(2, "0");
  const offM = String(abs % 60).padStart(2, "0");
  const offsetString = `UTC${sign}${offH}:${offM}`;
  const isDst = isDstActive(now, tz);

  const standardLabelAr = isDst
    ? "التوقيت الصيفي"
    : tz === "Africa/Cairo"
    ? "التوقيت الشتوي (مصر)"
    : "التوقيت القياسي";

  return {
    current: {
      key: currentPrayer.key,
      name: currentPrayer.name,
      date: currentPrayer.date,
      isoTime: formatIsoWithOffset(currentPrayer.date, tz),
      timeFormatted: formatPrayerTime(currentPrayer.date, tz),
      isToday: currentPrayer.isToday,
    },
    next: {
      key: nextPrayer.key,
      name: nextPrayer.name,
      date: nextPrayer.date,
      isoTime: formatIsoWithOffset(nextPrayer.date, tz),
      timeFormatted: formatPrayerTime(nextPrayer.date, tz),
      isToday: nextPrayer.isToday,
    },
    remainingSeconds,
    countdownLabel,
    progress,
    augmentedSchedule,
    secondaryTimes,
    timezoneInfo: {
      timezoneId: tz,
      offsetMinutes,
      offsetString,
      isDst,
      standardLabelAr,
    },
  };
}
