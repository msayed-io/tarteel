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
import { methodForTimeZone } from './astro.js';
/* منظومة الموقع المنقولة حرفيًا من Dar-Al-Hikayat-Desktop. */
import { reverseGeocodeCoordinates } from '../lib/reverse-geocoding.ts';
import {
  autoDetectLocation,
  guessTimezone,
  saveSavedLocation,
  getLastSavedLocation,
  findNearestArabPlace,
  LOCATION_ACTIONABLE_ERROR_MESSAGE,
} from '../lib/gps-location.ts';

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
 * الطبقة 1: جلب الموقع من WebView2
 * ------------------------------------------------------------------ */

/**
 * لماذا navigator.geolocation ولا إضافة Tauri؟
 *
 * WebView2 (وهو محرك واجهة Tauri على ويندوز) يُنفّذ واجهة W3C القياسية
 * navigator.geolocation عبر خدمة منصة ويندوز. حين يُستدعى getCurrentPosition
 * أول مرة، يتولى WebView2 طلب إذن الموقع من النظام تلقائيًا ويُظهر نافذة
 * ويندوز الرسمية، ثم يسجّل التطبيق في «الخصوصية والأمان ← الموقع» تلقائيًا.
 *
 * إضافة tauri-plugin-geolocation تتطلب صلاحيات ACL وتُخفي هذا المسار، ولذلك
 * لم يظهر التطبيق أصلًا في قائمة تطبيقات الموقع — وهو بالضبط ما لاحظه المستخدم.
 */
function geolocationAvailable() {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator && navigator.geolocation;
}

/**
 * لا يوجد إذن صريح نطلبه مسبقًا: WebView2 يعرض نافذة النظام عند أول قراءة.
 * نُبلّغ الواجهة بذلك صراحة بدل ادّعاء وجود حالة إذن لا يمكن فحصها.
 */
export async function ensureLocationPermission() {
  if (!geolocationAvailable()) {
    throw new LocationError('unsupported',
      'هذا النظام لا يوفّر خدمة تحديد الموقع للواجهة.');
  }
  return 'granted';
}

/** يترجم أكواد خطأ W3C إلى حالات دقيقة قابلة للتصرف. */
function classifyGeolocationError(error) {
  const code = Number(error?.code);
  const detail = String(error?.message || '');

  /* 1 = PERMISSION_DENIED */
  if (code === 1) {
    return new LocationError('permission-denied',
      'لم تمنح إذن الموقع. فعّل خدمة الموقع من إعدادات ويندوز ← الخصوصية والأمان ← الموقع، ثم أعد المحاولة.',
      detail);
  }
  /* 2 = POSITION_UNAVAILABLE */
  if (code === 2) {
    return new LocationError('no-provider',
      'ويندوز لم يتمكن من تحديد موقعك. تأكد أن خدمة الموقع مفعّلة وأن Wi-Fi متصل — فهي المصدر المعتمد لتحديد الموقع على الحاسوب.',
      detail);
  }
  /* 3 = TIMEOUT */
  if (code === 3) {
    return new LocationError('timeout',
      'استغرق تحديد الموقع وقتًا أطول من المتوقع. أعد المحاولة؛ قد تحتاج القراءة الأولى بضع ثوانٍ.',
      detail);
  }
  return new LocationError('position-failed', 'تعذّر تحديد موقع الجهاز.', detail);
}

/**
 * يقرأ موقع الجهاز عبر WebView2.
 * المحاولة تصاعدية: دقة عالية أولًا، ثم دقة عادية إن انتهت المدة، لأن أول
 * قراءة على ويندوز قد تستغرق وقتًا أطول وهي تبني مخزون Wi-Fi المحيط.
 */
export async function readDevicePosition({ timeoutMs = LOCATION_TIMEOUT_MS } = {}) {
  const geolocation = geolocationAvailable();
  if (!geolocation) {
    throw new LocationError('unsupported', 'هذا النظام لا يوفّر خدمة تحديد الموقع.');
  }

  const attempt = options => new Promise((resolve, reject) => {
    let settled = false;
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new LocationError('timeout', 'انتهت مهلة تحديد الموقع.'));
    }, options.timeout + 2000);

    geolocation.getCurrentPosition(
      position => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        resolve(position);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        reject(classifyGeolocationError(error));
      },
      options,
    );
  });

  let position;
  try {
    position = await attempt({ enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs });
  } catch (highAccuracyError) {
    /* رفض المستخدم نهائي — لا معنى لإعادة المحاولة بدقة أقل. */
    if (highAccuracyError.code === 'permission-denied' || highAccuracyError.code === 'unsupported') {
      throw highAccuracyError;
    }
    position = await attempt({ enableHighAccuracy: false, maximumAge: 60_000, timeout: timeoutMs });
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

export async function describePlace(latitude, longitude, fetchImpl = fetch) {
  /*
   * المصدر الوحيد للحقيقة هو reverseGeocodeCoordinates المنقولة حرفيًا:
   * Nominatim (zoom=18) وBigDataCloud وArcGIS وPhoton، كلها بالتوازي، وكل
   * واحدة تفكك الهرم بقواعدها الصارمة (buildNominatimHierarchy وغيرها).
   */
  const geocode = await reverseGeocodeCoordinates(Number(latitude), Number(longitude));
  /*
   * حارس العرض الوحيد: المرجع يرجّح ArcGIS أولًا، وArcGIS يعيد أسماء POI
   * لاتينية لبعض النقاط («American Dream Ismailia»). الاسم نفسه يبقى كما
   * أخرجه المرجع، ولا يُعدَّل؛ لكن إن خلا تمامًا من أي حرف عربي فلا يصلح
   * لواجهة عربية، فننتقل إلى قاعدة الأماكن العربية المرفقة بالمرجع نفسه.
   */
  /* حرف عربي حقيقي لا علامة ترقيم: «،» تقع داخل U+0600–U+06FF. */
  const hasArabic = text => /[\u0620-\u063F\u0641-\u064A\u0660-\u06FF]/.test(String(text || ''));
  if (!geocode || (!hasArabic(geocode.placeName) && !hasArabic(geocode.countryName))) {
    /* الطبقة الأخيرة أوفلاين: أقرب مركز من قاعدة المرجع نفسها. */
    const nearest = findNearestArabPlace(Number(latitude), Number(longitude));
    if (!nearest) return null;
    return {
      city: nearest.name,
      region: nearest.parent,
      country: nearest.country,
      countryCode: '',
      provider: 'offline',
      label: `${nearest.name}، ${nearest.parent}`,
      hierarchy: { label: `${nearest.name}، ${nearest.parent}`, localPlace: nearest.name, city: nearest.parent, governorate: '' },
    };
  }
  return {
    city: geocode.placeName,
    region: '',
    country: geocode.countryName,
    countryCode: '',
    provider: geocode.source,
    /* cityName في عقد المرجع = الاسم التفصيلي الكامل */
    label: geocode.placeName,
    displayAddress: geocode.displayAddress || '',
    hierarchy: { label: geocode.placeName, localPlace: '', city: '', governorate: '' },
  };
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
export async function resolveLocation() {
  /*
   * نقطة الدخول الرسمية للمنظومة: autoDetectLocation من gps-location.ts.
   * لا التفاف ولا محاولات مفرقة — هي وحدها المسؤولة عن:
   *   • الطبقة عالية الدقة (enableHighAccuracy: true, timeout: 10000, maximumAge: 0)
   *   • الطبقة الاحتياطية الأسرع عند الفشل
   *   • استدعاء enrichCoordinatesToLocation
   *   • تشغيل المزودين الأربعة بالتوازي وتفكيك الهرم وحفظ الكاش فورًا
   *
   * الوظيفة الوحيدة المتبقية هنا هي الترجمة إلى العقد الداخلي لتَرتيل
   * (countryCode و رمز المنطقة الزمنية)، ورسالة الخطأ العربية الموحدة.
   */
  /*
   * المرجع يبتلع رمز رفض الإذن ويستبدله برسالته الموحّدة، فلا يمكن تمييز
   * «مرفوض» من «تعذر» بعد الاستدعاء. لذلك نراقب استدعاء المتصفح نفسه
   * أثناء تنفيذ autoDetectLocation، ثم نستنطق السبب منه.
   */
  let lastGeoError = null;
  const originalPosition = globalThis.navigator?.geolocation?.getCurrentPosition;
  if (typeof originalPosition === 'function') {
    const patched = function (success, failure, options) {
      return originalPosition.call(this, success, error => { lastGeoError = error; if (failure) failure(error); }, options);
    };
    try { globalThis.navigator.geolocation.getCurrentPosition = patched; } catch { /* خاصية للقراءة فقط */ }
  }

  let location;
  try {
    location = await autoDetectLocation();
  } catch (cause) {
    const observed = lastGeoError || cause;
    /*
     * المرجع يبتلع رمز الخطأ ويُرجع رسالة موحّدة (الطبقة 5). لكن الواجهة
     * تحتاج التمييز بين «إذن مرفوض» و«تعذر التحديد» لأن الإصلاح مختلف:
     * الأول يُحل من إعدادات ويندوز، والثاني يعاد المحاولة. لذلك نستنطق
     * سبب الفشل ونعيد الرمز مع رسالة المرجع نفسها دون تغييرها.
     */
    /* GeolocationPositionError: 1 = مرفوض، 2 = غير متاح، 3 = انتهت المهلة. */
    const domCode = Number(observed?.code);
    const raw = cause?.message || '';
    const code = domCode === 1 || /PERMISSION|denied|إذن|رفض/i.test(raw)
      ? 'permission-denied'
      : domCode === 3 || /TIMEOUT|timeout/i.test(raw) ? 'position-failed'
      : 'location-unavailable';
    throw new LocationError(code, raw.includes('تعذر') ? raw : LOCATION_ACTIONABLE_ERROR_MESSAGE);
  } finally {
    if (typeof originalPosition === 'function') {
      try { globalThis.navigator.geolocation.getCurrentPosition = originalPosition; } catch { /* تجاهل */ }
    }
  }

  if (!location || !Number.isFinite(Number(location.latitude))) {
    throw new LocationError('location-unavailable', LOCATION_ACTIONABLE_ERROR_MESSAGE);
  }

  const timeZone = location.timezoneId || timeZoneForCoordinates(location.latitude, location.longitude);
  const countryCode = methodForTimeZone(timeZone).defaultCountryCode || '';
  const detailed = String(location.cityNameAr || location.cityName || '').trim();

  return {
    source: 'device',
    /* المرجع يقرّب إلى ٦ أرقام عشرية — دقة كافية للتطابق مع أذان المسجد. */
    latitude: location.latitude,
    longitude: location.longitude,
    accuracy: location.accuracyMeters ?? null,
    precise: Number.isFinite(Number(location.accuracyMeters))
      ? Number(location.accuracyMeters) <= ACCURACY_TARGET_M
      : false,
    timeZone,
    timezoneId: timeZone,
    /* عقد PrayerLocation حرفيًا */
    cityName: location.cityName || detailed,
    cityNameAr: detailed,
    countryNameAr: location.countryNameAr || '',
    displayAddress: location.displayAddress || '',
    /* توافق مع بقية الواجهة */
    city: detailed,
    region: '',
    country: location.countryNameAr || '',
    countryCode,
    label: detailed,
    isAutoDetected: location.isAutoDetected !== false,
    capturedAt: location.capturedAt || Date.now(),
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
