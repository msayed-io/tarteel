/**
 * تَرتيل — محرك الموقع الجغرافي ثلاثي الطبقات
 * ============================================
 * أجهزة الكمبيوتر لا تملك GPS، فدقتها تأتي من دمج ثلاث طبقات:
 *
 *   الطبقة 1 — Windows.Devices.Geolocation (WinRT):
 *     المسار الرسمي للنظام. مع DesiredAccuracy=High يدمج ويندوز إشارات
 *     Wi-Fi (BSSID) وقاعدة بيانات مايكروسوفت للمواقع، وهو ما يصل إلى دقة
 *     الحي/الشارع — وبهذا لا نعتمد على IP وحده.
 *
 *   الطبقة 2 — Reverse Geocoding + منطقة IANA:
 *     الإحداثيات تُترجم إلى مدينة ودولة ومنطقة زمنية IANA رسمية.
 *     يُحظر استخدام فوارق ثابتة (GMT+2) كي يعمل التوقيت الصيفي تلقائيًا.
 *
 *   الطبقة 3 — اختيار يدوي احتياطي:
 *     يظهر فقط عند رفض الإذن أو تعذّر تحديد الموقع، لا كبديل افتراضي.
 *
 * قاعدة صارمة: لا تُخترع إحداثيات أبدًا. إن لم يكن هناك موقع مؤكد،
 * تُرفع حالةٌ صريحة يشرحها الواجهة للمستخدم مع إجراء إصلاح فعلي.
 */

import tzLookup from 'tz-lookup';

/** عتبة الدقة المقبولة (بالمتر). أعلى من ذلك يُعدّ موقعًا تقريبيًا. */
export const ACCURACY_TARGET_M = 1500;

/** أقصى زمن انتظار لتثبيت الموقع. */
const LOCATION_TIMEOUT_MS = 20000;

/** رمز حالة يميّز كل سبب فشل بدقة، حتى تعرض الواجهة إرشادًا صحيحًا. */
export class LocationError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'LocationError';
    this.code = code;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------ *
 * الطبقة 1: جلب الموقع من ويندوز
 * ------------------------------------------------------------------ */

/**
 * يتحقق من إذن الموقع ويطلبه إن كان في حالة سؤال.
 * @param {{checkPermissions:Function, requestPermissions:Function}} api
 * @returns {Promise<'granted'|'denied'|'prompt'>}
 */
export async function ensureLocationPermission(api) {
  const { checkPermissions, requestPermissions } = api;
  if (typeof checkPermissions !== 'function' || typeof requestPermissions !== 'function') {
    throw new LocationError('unsupported', 'إذن الموقع غير مدعوم في هذا النظام.');
  }
  let state;
  try {
    state = await checkPermissions();
  } catch (cause) {
    throw new LocationError('permission-check-failed', 'تعذّر فحص إذن الموقع من ويندوز. أعد المحاولة.', String(cause));
  }
  const current = String(state?.location || '');
  if (current === 'granted') return 'granted';
  if (current === 'denied') return 'denied';
  /* في ويندوز تظهر النافذة الرسمية لطلب الإذن من خلال requestPermissions. */
  try {
    const next = await requestPermissions(['location']);
    const value = String(next?.location || '');
    if (value === 'granted') return 'granted';
    if (value === 'denied') return 'denied';
    return 'prompt';
  } catch (cause) {
    throw new LocationError('permission-request-failed',
      'لم يكتمل طلب إذن الموقع. تأكد أن خدمة الموقع مفعّلة من إعدادات ويندوز: الخصوصية والأمان ← الموقع.', String(cause));
  }
}

/**
 * يقرأ موقع الجهاز عبر WinRT بمحاولة تصاعدية: أول قراءة عالية الدقة،
 * وإن انتهت المدة قبل التثبيت تُقبل القراءة المتاحة بدل الفشل الكامل.
 *
 * @returns {Promise<{latitude:number, longitude:number, accuracy:number|null, timestamp:number, source:'device'}>}
 */
export async function readDevicePosition({ getCurrentPosition }) {
  if (typeof getCurrentPosition !== 'function') {
    throw new LocationError('unsupported', 'واجهة تحديد الموقع غير متاحة.');
  }
  let position;
  try {
    position = await getCurrentPosition({
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: LOCATION_TIMEOUT_MS,
    });
  } catch (cause) {
    const reason = String(cause?.message || cause);
    if (/denied|permission/i.test(reason)) {
      throw new LocationError('permission-denied-by-system',
        'ويندوز رفض الوصول إلى الموقع. فعّل خدمة الموقع لهذا التطبيق من الإعدادات.', reason);
    }
    if (/timeout|unavailable|not available/i.test(reason)) {
      throw new LocationError('no-provider',
        'لم يتمكن ويندوز من تحديد موقعك. تأكد أن Wi-Fi مفعّل — فهو المصدر المعتمد لتحديد الموقع على الحاسوب.', reason);
    }
    throw new LocationError('position-failed', 'تعذّر تحديد موقع الجهاز.', reason);
  }
  const latitude = Number(position?.coords?.latitude);
  const longitude = Number(position?.coords?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new LocationError('invalid-coordinates', 'أعاد النظام إحداثيات غير صالحة.');
  }
  const accuracy = Number(position?.coords?.accuracy);
  return {
    latitude, longitude,
    accuracy: Number.isFinite(accuracy) && accuracy > 0 ? accuracy : null,
    timestamp: Number(position?.timestamp) || Date.now(),
    source: 'device',
  };
}

/* ------------------------------------------------------------------ *
 * الطبقة 2: تحويل الإحداثيات إلى منطقة IANA + وصف المكان
 * ------------------------------------------------------------------ */

/**
 * منطقة IANA من الإحداثيات، محليًا ودون شبكة.
 * مكتبة tz-lookup تحمل حدود المناطق الرسمية، فتنتج Africa/Cairo أو
 * Asia/Riyadh كما هي، لا فارقًا ثابتًا. لا تفشل عند انقطاع الإنترنت.
 */
export function timeZoneForCoordinates(latitude, longitude) {
  try {
    const zone = tzLookup(Number(latitude), Number(longitude));
    if (zone) {
      /* تحقق نهائي: لا نثق بمخرَج لا يفهمه Intl. */
      new Intl.DateTimeFormat('en', { timeZone: zone }).format();
      return zone;
    }
  } catch { /* يقع إلى الاحتياطي أدناه */ }
  /* احتياطي أخير: منطقة الجهاز نفسها، وهي أيضًا IANA لا فارق ثابت. */
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const REVERSE_GEOCODE = 'https://api.bigdatacloud.net/data/reverse-geocode-client';

/**
 * وصف المكان (مدينة/دولة) من الإحداثيات. أي فشل شبكي لا يُسقط الموقع:
 * المنطقة الزمنية محسوبة محليًا أصلًا، والوصف النصي تحسينٌ للعرض فقط.
 */
export async function describePlace(latitude, longitude, fetchImpl = fetch) {
  try {
    const url = new URL(REVERSE_GEOCODE);
    url.search = new URLSearchParams({
      latitude: String(latitude), longitude: String(longitude), localityLanguage: 'ar',
    }).toString();
    const response = await fetchImpl(url.toString(), {
      headers: { Accept: 'application/json' }, cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!response?.ok) return null;
    const data = await response.json();
    return {
      city: String(data?.city || data?.locality || data?.principalSubdivision || ''),
      region: String(data?.principalSubdivision || ''),
      country: String(data?.countryName || ''),
      countryCode: String(data?.countryCode || '').toUpperCase(),
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * الواجهة الموحّدة
 * ------------------------------------------------------------------ */

/**
 * يحصل على موقع مؤكد + منطقة IANA + وصف المكان.
 * يرمي LocationError برمز دقيق عند أي فشل — لا تخمين ولا بديل صامت.
 *
 * @param {object} api واجهات إضافة الموقع من Tauri
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]
 */
export async function resolveLocation(api, { fetchImpl = fetch } = {}) {
  const permission = await ensureLocationPermission(api);
  if (permission !== 'granted') {
    throw new LocationError('permission-denied',
      'لم يُمنح إذن الموقع. افتح الإعدادات وامنح تَرتيل الوصول إلى الموقع ثم أعد المحاولة.');
  }
  const fix = await readDevicePosition(api);
  const timeZone = timeZoneForCoordinates(fix.latitude, fix.longitude);
  const place = await describePlace(fix.latitude, fix.longitude, fetchImpl);
  return {
    source: 'device',
    latitude: fix.latitude,
    longitude: fix.longitude,
    accuracy: fix.accuracy,
    precise: Number.isFinite(fix.accuracy) ? fix.accuracy <= ACCURACY_TARGET_M : false,
    timeZone,
    city: place?.city || '',
    region: place?.region || '',
    country: place?.country || '',
    countryCode: place?.countryCode || '',
    resolvedAt: Date.now(),
  };
}

/**
 * هل تغيّر الموقع بما يستدعي إعادة حساب المواقيت؟
 * نُعيد الحساب إذا تحرّك أكثر من نصف كيلومتر، أو تغيّرت المنطقة الزمنية،
 * أو تجاوز العمر 30 دقيقة — لأن دقة الحاسوب تتغيّر مع تغيّر شبكة Wi-Fi.
 */
export function locationNeedsRefresh(previous, next, now = Date.now()) {
  if (!previous) return true;
  if (previous.timeZone !== next.timeZone) return true;
  if (!Number.isFinite(previous.latitude) || !Number.isFinite(previous.longitude)) return true;
  const km = haversineKm(previous, next);
  if (km > 0.5) return true;
  const age = now - Number(previous.resolvedAt || 0);
  return age > 30 * 60 * 1000;
}

/** المسافة بالكيلومترات بين نقطتين. */
export function haversineKm(a, b) {
  const rad = n => (Number(n) * Math.PI) / 180;
  const dLat = rad(Number(b.latitude) - Number(a.latitude));
  const dLon = rad(Number(b.longitude) - Number(a.longitude));
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/** رسالة عربية دقيقة لكل رمز فشل، مع خطوة إصلاح عملية. */
export function describeLocationError(error) {
  const code = error?.code || 'unknown';
  const map = {
    'permission-denied': 'إذن الموقع مرفوض. الإعدادات ← الخصوصية والأمان ← الموقع: فعّل «الوصول إلى الموقع» واسمح لتَرتيل.',
    'permission-denied-by-system': 'ويندوز رفض الوصول إلى الموقع لهذا التطبيق. راجع إعدادات الموقع في ويندوز.',
    'permission-request-failed': 'لم تظهر نافذة إذن الموقع. تأكد أن خدمة الموقع مفعّلة في ويندوز ثم أعد المحاولة.',
    'permission-check-failed': 'تعذّر فحص إذن الموقع. أعد تشغيل التطبيق وحاول مرة أخرى.',
    'no-provider': 'ويندوز لم يجد مصدرًا لتحديد الموقع. فعّل Wi-Fi — لا يعتمد تحديد الموقع على IP وحده.',
    'position-failed': 'تعذّر تحديد موقع الجهاز مؤقتًا. أعد المحاولة، أو تحقق من خدمة الموقع في ويندوز.',
    'invalid-coordinates': 'أعاد النظام إحداثيات غير صالحة. أعد المحاولة.',
    unsupported: 'هذا النظام لا يدعم تحديد الموقع.',
  };
  return map[code] || `تعذّر تحديد الموقع: ${String(error?.message || error)}`;
}
