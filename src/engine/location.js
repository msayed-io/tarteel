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
import { nearestArabCity, hierarchyFromProvider } from './places.js';

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

/* ------------------------------------------------------------------ *
 * الطبقة 2أ: الترجمة الجغرافية العكسية — ثلاث خدمات بالتوازي
 * ------------------------------------------------------------------ */

/**
 * نجمع نتائج ثلاث خدمات مستقلة بدل الاعتماد على واحدة:
 * كل خدمة لها نقاط قوة وضعف، وأي واحدة تنجح تكفي. الفشل الكامل لا يُسقط
 * الموقع، لأن الطبقة الأوفلاين أدناه تتولى المهمة.
 *
 * كل الاستدعاءات تطلب العربية صراحة:
 *   • ArcGIS: langCode=ARA
 *   • BigDataCloud: localityLanguage=ar
 *   • Nominatim: accept-language=ar
 */
function buildProviders(latitude, longitude) {
  const lat = Number(latitude), lon = Number(longitude);
  return [
    {
      name: 'arcgis',
      url: `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?location=${lon},${lat}&f=json&langCode=ARA`,
      parse: data => {
        const a = data?.address;
        if (!a) return null;
        const city = a.City || a.Municipality || a.District || a.Subregion || '';
        const region = a.Region || a.Subregion || a.Province || '';
        return {
          city: String(city).trim(),
          region: String(region).trim(),
          country: String(a.CountryCode === 'EG' ? 'مصر' : (a.CountryCode || '')).trim(),
          countryCode: String(a.CountryCode || '').toUpperCase(),
        };
      },
    },
    {
      name: 'bigdatacloud',
      url: `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=ar`,
      parse: data => ({
        city: String(data?.city || data?.locality || '').trim(),
        region: String(data?.principalSubdivision || '').trim(),
        country: String(data?.countryName || '').trim(),
        countryCode: String(data?.countryCode || '').toUpperCase(),
      }),
    },
    {
      name: 'nominatim',
      url: `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1&accept-language=ar`,
      parse: data => {
        const a = data?.address || {};
        const city = a.city || a.town || a.village || a.municipality || a.county || a.state_district || '';
        const region = a.state || a.province || a.region || '';
        return {
          city: String(city).trim(),
          region: String(region).trim(),
          country: String(a.country || '').trim(),
          countryCode: String(a.country_code || '').toUpperCase(),
        };
      },
    },
  ];
}

/** يستدعي خدمة واحدة بمهلة قصيرة، ويعيد null عند أي فشل. */
async function askProvider(provider, fetchImpl) {
  try {
    const response = await fetchImpl(provider.url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    });
    if (!response?.ok) return null;
    const data = await response.json();
    const parsed = provider.parse(data);
    if (!parsed) return null;
    /* الهرم الجغرافي من نفس الاستجابة: لا طلب شبكة إضافي. */
    let hierarchy = null;
    try { hierarchy = hierarchyFromProvider(provider.name, data); } catch { hierarchy = null; }
    /* نص عربي فقط: نرفض أي اسم لاتيني لأنه لا يخدم واجهة عربية. */
    const city = latinFree(parsed.city);
    if (!city && !latinFree(parsed.country)) return null;
    return {
      ...parsed,
      city,
      region: latinFree(parsed.region),
      country: latinFree(parsed.country),
      provider: provider.name,
      hierarchy,
    };
  } catch {
    return null;
  }
}

/**
 * يرفض النص اللاتيني ويعيد العربي فقط.
 * الخدمات قد تعيد أسماء بخط لاتيني رغم طلب العربية (قرى صغيرة بلا ترجمة)،
 * فلا نعرضها في واجهة عربية.
 */
function latinFree(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return /[\u0600-\u06FF]/.test(text) ? text : '';
}

/**
 * نتيجة الوصف: المدينة والدولة بالعربية، مع تحديد المصدر.
 * يُجرَّب كل شيء بالتوازي ثم تُختار أفضل نتيجة عربية متاحة.
 */
export async function describePlace(latitude, longitude, fetchImpl = fetch) {
  const providers = buildProviders(latitude, longitude);
  const settled = await Promise.allSettled(providers.map(provider => askProvider(provider, fetchImpl)));
  const results = settled
    .filter(entry => entry.status === 'fulfilled' && entry.value)
    .map(entry => entry.value);

  /* الأفضلية للنتيجة التي تحمل اسمًا محليًا دقيقًا (عزبة/قرية/حي) عربيًا،
     لأنها الأدق وصفًا للمكان؛ ثم الأفضلية لوجود رمز الدولة. */
  const score = r => (r.hierarchy?.localPlace ? 2 : 0) + (r.countryCode ? 1 : 0);
  const best = results.slice().sort((a, b) => score(b) - score(a))[0];
  if (best) {
    return {
      city: best.city,
      region: best.region,
      country: best.country,
      countryCode: best.countryCode,
      provider: best.provider,
      /* الهرم الكامل هو ما يُعرض للمستخدم. */
      hierarchy: best.hierarchy,
      label: best.hierarchy?.label || [best.city, best.country].filter(Boolean).join('، '),
    };
  }

  /* الطبقة الأوفلاين: تعمل بلا إنترنت إطلاقًا. */
  const offline = nearestArabCity(latitude, longitude);
  if (offline) {
    return {
      city: offline.city, region: offline.region, country: offline.country,
      countryCode: offline.countryCode, provider: 'offline', distanceKm: offline.distanceKm,
      hierarchy: hierarchyFromProvider('offline', offline),
      label: [offline.city, offline.country].filter(Boolean).join('، '),
    };
  }
  return null;
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
export async function resolveLocation({ fetchImpl = fetch } = {}) {
  const permission = await ensureLocationPermission();
  if (permission !== 'granted') {
    throw new LocationError('permission-denied',
      'لم يُمنح إذن الموقع. افتح الإعدادات وامنح تَرتيل الوصول إلى الموقع ثم أعد المحاولة.');
  }
  const fix = await readDevicePosition();
  const timeZone = timeZoneForCoordinates(fix.latitude, fix.longitude);
  const place = await describePlace(fix.latitude, fix.longitude, fetchImpl);
  /* إن فشل الوصف الشبكي، تُستنتج الدولة من المنطقة الزمنية حتى لا تسقط
     طريقة الحساب إلى الافتراضي العالمي داخل مصر أو السعودية. */
  const countryCode = place?.countryCode || methodForTimeZone(timeZone).defaultCountryCode || '';
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
    countryCode,
    /* الهرم الجغرافي الكامل: [القرية/الحي] ، [المركز] ، [المحافظة] */
    label: place?.label || '',
    localPlace: place?.hierarchy?.localPlace || '',
    governorate: place?.hierarchy?.governorate || '',
    placeProvider: place?.provider || '',
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
