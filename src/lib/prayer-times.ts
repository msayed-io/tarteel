/**
 * حساب مواقيت الصلاة — مطابق لمنطق النسخة الإنتاجية
 * يغلّف مكتبة adhan الرسمية (نفس المكتبة المستخدمة في الإنتاج)
 */
import {
  Coordinates,
  PrayerTimes as AdhanPrayerTimes,
  CalculationMethod,
  Madhab,
} from "adhan";
import type { CalculationMethodId, PrayerId, PrayerLocation } from "./prayer-config";

export interface TimedPrayer {
  prayerId: PrayerId;
  time: Date;
  minutesFromMidnight: number;
}

export interface DailyPrayers {
  date: string;
  prayers: TimedPrayer[];
}

/** Converts a prayer's local wall-clock date/time in the selected timezone to an instant. */
export function getPrayerInstant(prayer: TimedPrayer, date: string, timezoneId: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const minutes = prayer.minutesFromMidnight;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const wallClockUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  const offsetAt = (instantMs: number): number => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezoneId,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(instantMs));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const localAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") === 24 ? 0 : get("hour"), get("minute"), get("second"));
    return Math.round((localAsUtc - instantMs) / 60000);
  };

  let instantMs = wallClockUtc;
  instantMs = wallClockUtc - offsetAt(instantMs) * 60000;
  instantMs = wallClockUtc - offsetAt(instantMs) * 60000;
  return new Date(instantMs);
}

/** خريطة طرق الحساب إلى بارامترات adhan (كما في الإنتاج) */
function methodParams(method: CalculationMethodId) {
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

/** دقائق من منتصف الليل في المنطقة الزمنية التي اختارها المستخدم. */
function minutesFromMidnight(d: Date, timezoneId: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezoneId,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return (hour === 24 ? 0 : hour) * 60 + minute;
}

function datePartsInTimezone(date: Date, timezoneId: string): { year: number; month: number; day: number } {
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
}

/** يمرر إلى adhan تاريخًا محليًا يحمل اليوم المدني لمنطقة الموقع. */
function calendarDateInTimezone(date: Date, timezoneId: string): Date {
  const { year, month, day } = datePartsInTimezone(date, timezoneId);
  const result = new Date(0);
  result.setHours(12, 0, 0, 0);
  result.setFullYear(year, month - 1, day);
  return result;
}

/** منتصف الوقت بين الشروق والظهر = الضحى (كما في الإنتاج) */
function midpoint(a: Date, b: Date): Date {
  return new Date((a.getTime() + b.getTime()) / 2);
}

/** مواقيت يوم واحد (مع الضحى بالحساب الأوسط) */
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
    { prayerId: "fajr", time: pt.fajr, minutesFromMidnight: minutesFromMidnight(pt.fajr, timezoneId) },
    { prayerId: "sunrise", time: pt.sunrise, minutesFromMidnight: minutesFromMidnight(pt.sunrise, timezoneId) },
    { prayerId: "duha", time: duha, minutesFromMidnight: minutesFromMidnight(duha, timezoneId) },
    { prayerId: "dhuhr", time: pt.dhuhr, minutesFromMidnight: minutesFromMidnight(pt.dhuhr, timezoneId) },
    { prayerId: "asr", time: pt.asr, minutesFromMidnight: minutesFromMidnight(pt.asr, timezoneId) },
    { prayerId: "maghrib", time: pt.maghrib, minutesFromMidnight: minutesFromMidnight(pt.maghrib, timezoneId) },
    { prayerId: "isha", time: pt.isha, minutesFromMidnight: minutesFromMidnight(pt.isha, timezoneId) },
  ];

  const dateParts = datePartsInTimezone(date, timezoneId);
  const dateStr = `${dateParts.year}-${String(dateParts.month).padStart(2, "0")}-${String(dateParts.day).padStart(2, "0")}`;

  return { date: dateStr, prayers };
}

/** مواقيت اليوم والغد (للجدولة عبر اليومين — كما في الإنتاج) */
export function getTodayAndTomorrow(
  latitude: number,
  longitude: number,
  method: CalculationMethodId = "egyptian",
  timezoneId: string = "Africa/Cairo"
): { today: DailyPrayers; tomorrow: DailyPrayers } {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return {
    today: getDayPrayers(latitude, longitude, now, method, timezoneId),
    tomorrow: getDayPrayers(latitude, longitude, tomorrow, method, timezoneId),
  };
}

/**
 * تنسيق الوقت بصيغة عربية (١٢ ساعة + ص/م) — كما في الإنتاج.
 * تستخدم Intl مع المنطقة الزمنية للموقع لعرض وقت المدينة المختارة.
 */
export function formatPrayerTime(date: Date, timezoneId?: string): string {
  if (timezoneId) {
    try {
      const formatted = new Intl.DateTimeFormat("ar-EG", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
        timeZone: timezoneId,
      }).format(date);
      return normalizeArabicTime(formatted);
    } catch {
      /* التجاهل والسقوط للتنسيق المحلي */
    }
  }

  let hours = date.getHours();
  const minutes = date.getMinutes();
  const period = hours >= 12 ? "م" : "ص";
  if (hours > 12) hours -= 12;
  if (hours === 0) hours = 12;
  return `${hours}:${String(minutes).padStart(2, "0")} ${period}`;
}

/** تطبيع ناتج Intl العربي (أرقام هندية → قياسية + توحيد ص/م) */
function normalizeArabicTime(input: string): string {
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
  const { PRAYER_DEFINITIONS } = await import("./prayer-config");
  return today.prayers.map((p) => ({
    name: PRAYER_DEFINITIONS[p.prayerId].nameAr,
    time: formatPrayerTime(p.time, location.timezoneId),
    prayerId: p.prayerId,
  }));
}

export interface SecondaryPrayerTimes {
  duha: string;
  midnight: string;
  firstThird: string;
  lastThird: string;
}

export function calculateSecondaryTimes(
  latitude: number,
  longitude: number,
  date: Date = new Date(),
  method: CalculationMethodId = "egyptian",
  timezoneId: string = "Africa/Cairo"
): SecondaryPrayerTimes {
  const coordinates = new Coordinates(latitude, longitude);
  const params = methodParams(method);
  const ptToday = new AdhanPrayerTimes(coordinates, date, params);

  const tomorrow = new Date(date);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const ptTomorrow = new AdhanPrayerTimes(coordinates, tomorrow, params);

  // Duha: midpoint between sunrise and dhuhr
  const duhaTime = midpoint(ptToday.sunrise, ptToday.dhuhr);

  // Night calculations: from Maghrib today to Fajr tomorrow
  const nightDurationMs = ptTomorrow.fajr.getTime() - ptToday.maghrib.getTime();
  const midnightTime = new Date(ptToday.maghrib.getTime() + nightDurationMs / 2);
  const firstThirdTime = new Date(ptToday.maghrib.getTime() + nightDurationMs / 3);
  const lastThirdTime = new Date(ptTomorrow.fajr.getTime() - nightDurationMs / 3);

  return {
    duha: formatPrayerTime(duhaTime, timezoneId),
    midnight: formatPrayerTime(midnightTime, timezoneId),
    firstThird: formatPrayerTime(firstThirdTime, timezoneId),
    lastThird: formatPrayerTime(lastThirdTime, timezoneId),
  };
}
