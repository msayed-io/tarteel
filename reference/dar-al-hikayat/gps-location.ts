import type { PrayerLocation } from "./prayer-config";
import { CITIES, type CityData } from "./prayer-cities";
import { reverseGeocodeCoordinates } from "./reverse-geocoding";
import { ARAB_INDEXED_PLACES, type IndexedPlace } from "./egypt-places";

/**
 * البحث عن أقرب مركز/مدينة معتمدة من قاعدة البيانات الشاملة
 */
export function findNearestArabPlace(lat: number, lng: number): IndexedPlace | null {
  let best: IndexedPlace | null = null;
  let bestDist = Infinity;
  for (const p of ARAB_INDEXED_PLACES) {
    const d = Math.hypot(p.lat - lat, p.lng - lng);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

/**
 * تخمين المنطقة الزمنية من الإحداثيات (مطابق لخريطة الإنتاج)
 */
export function guessTimezone(lat: number, lng: number): string {
  return (
    (lat >= 22 && lat <= 32 && lng >= 24 && lng <= 37) ? "Africa/Cairo" :
    (lat >= 16 && lat <= 32 && lng >= 35 && lng <= 55) ? "Asia/Riyadh" :
    (lat >= 22 && lat <= 27 && lng >= 51 && lng <= 57) ? "Asia/Dubai" :
    (lat >= 28 && lat <= 31 && lng >= 46 && lng <= 49) ? "Asia/Kuwait" :
    (lat >= 24 && lat <= 27 && lng >= 50 && lng <= 52) ? "Asia/Qatar" :
    (lat >= 25 && lat <= 27 && lng >= 50 && lng <= 51) ? "Asia/Bahrain" :
    (lat >= 16 && lat <= 26 && lng >= 51 && lng <= 60) ? "Asia/Muscat" :
    (lat >= 29 && lat <= 34 && lng >= 34 && lng <= 40) ? "Asia/Amman" :
    (lat >= 31 && lat <= 33 && lng >= 34 && lng <= 36) ? "Asia/Hebron" :
    (lat >= 33 && lat <= 35 && lng >= 35 && lng <= 37) ? "Asia/Beirut" :
    (lat >= 32 && lat <= 37 && lng >= 35 && lng <= 42) ? "Asia/Damascus" :
    (lat >= 29 && lat <= 38 && lng >= 38 && lng <= 49) ? "Asia/Baghdad" :
    (lat >= 27 && lat <= 36 && lng >= -13 && lng <= -1) ? "Africa/Casablanca" :
    (lat >= 30 && lat <= 38 && lng >= 8 && lng <= 12) ? "Africa/Tunis" :
    (lat >= 19 && lat <= 37 && lng >= -2 && lng <= 9) ? "Africa/Algiers" :
    (lat >= 19 && lat <= 33 && lng >= 9 && lng <= 25) ? "Africa/Tripoli" :
    (lat >= 3 && lat <= 23 && lng >= 21 && lng <= 39) ? "Africa/Khartoum" :
    (lat >= 36 && lat <= 42 && lng >= 26 && lng <= 45) ? "Europe/Istanbul" :
    (lat >= 23 && lat <= 37 && lng >= 60 && lng <= 78) ? "Asia/Karachi" :
    (lat >= -11 && lat <= 6 && lng >= 95 && lng <= 141) ? "Asia/Jakarta" :
    (lat >= 1 && lat <= 7 && lng >= 99 && lng <= 119) ? "Asia/Kuala_Lumpur" :
    (lat >= 49 && lat <= 61 && lng >= -8 && lng <= 2) ? "Europe/London" :
    (lat >= 42 && lat <= 51 && lng >= -5 && lng <= 8) ? "Europe/Paris" :
    (lat >= 25 && lat <= 49 && lng >= -125 && lng <= -66) ? "America/New_York" :
    "Africa/Cairo"
  );
}

/**
 * أقرب مدينة من قاعدة البيانات
 */
export function findNearestCity(lat: number, lng: number): CityData | null {
  let best: CityData | null = null;
  let bestDist = Infinity;
  for (const city of CITIES) {
    const d = Math.hypot(city.latitude - lat, city.longitude - lng);
    if (d < bestDist) {
      bestDist = d;
      best = city;
    }
  }
  return best;
}

/**
 * مفتاح التخزين المحلي لآخر موقع محفوظ
 */
export const SAVED_LOCATION_STORAGE_KEY = "dar_prayer_location";

/**
 * الطبقة 5: رسالة الفشل الواضحة والقابلة للتصرف الموحدة
 */
export const LOCATION_ACTIONABLE_ERROR_MESSAGE =
  "تعذر تحديد موقعك الآن. استخدم الموقع المحفوظ أو اختر موقعاً يدوياً، ويمكنك فتح إعدادات الموقع للمحاولة مرة أخرى.";

/**
 * علم الجلسة لمنع تكرار طلب إذن الموقع بشكل مزعج
 */
let hasRequestedPermissionThisSession = false;

export function resetLocationPermissionSessionFlag(): void {
  hasRequestedPermissionThisSession = false;
  if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.removeItem("dar_gps_permission_requested_this_session");
    } catch {
      // ignore
    }
  }
}

/**
 * الطبقة 1: التعامل مع الإذن (Permission) بذكاء
 * - على الويب: تخطَّ طلب الإذن تماماً (المتصفح يتولى ذلك عند أول استدعاء).
 * - على التطبيق الأصلي (Native):
 *   - تحقق أولاً من حالة الإذن الحالية (checkPermissions).
 *   - اقبل أي من الحالتين: إذن الموقع الدقيق أو الموقع التقريبي (Coarse Location) — لا تشترط الدقيق فقط.
 *   - اطلب الإذن مرة واحدة فقط لكل جلسة تشغيل (باستخدام علم الجلسة لمنع الإزعاج المتكرر).
 *   - اطلب النوعين معاً في نفس الطلب: ["location", "coarseLocation"].
 */
export async function checkOrRequestLocationPermissionSmartly(): Promise<boolean> {
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) return false;
  return true;
}

/**
 * مسح جميع البيانات المؤقتة والكاش الخاص بالموقع من الذاكرة المحلية
 */
export function clearAllLocationCache(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(SAVED_LOCATION_STORAGE_KEY);
    localStorage.removeItem("dar_prayer_location");
    localStorage.removeItem("dar_location_cache");
    sessionStorage.removeItem("dar_gps_permission_requested_this_session");
    hasRequestedPermissionThisSession = false;
  } catch (err) {
    console.warn("Failed clearing location cache:", err);
  }
}

/**
 * الطبقة 2: قراءة آخر موقع محفوظ فوراً
 * قبل حتى محاولة جلب موقع جديد، إن وُجد موقع محفوظ سابقاً في التخزين المحلي، يُعرض فوراً في الواجهة.
 */
export function getLastSavedLocation(): PrayerLocation | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SAVED_LOCATION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);

    if (
      parsed &&
      typeof parsed.latitude === "number" &&
      typeof parsed.longitude === "number" &&
      Number.isFinite(parsed.latitude) &&
      Number.isFinite(parsed.longitude)
    ) {
      return parsed as PrayerLocation;
    }
  } catch (err) {
    console.warn("Failed reading saved location from localStorage:", err);
  }
  return null;
}

/**
 * حفظ الموقع المحدث في التخزين المحلي لتغذية "الطبقة 2" للمرات القادمة
 */
export function saveSavedLocation(location: PrayerLocation): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SAVED_LOCATION_STORAGE_KEY, JSON.stringify(location));
  } catch (err) {
    console.warn("Failed saving location to localStorage:", err);
  }
}

export interface RawCoords {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  timestamp: number;
}

export interface FetchCoordsOptions {
  enableHighAccuracy: boolean;
  timeout: number;
  maximumAge: number;
  enableLocationFallback?: boolean;
}

/**
 * تنفيذ استعلام الإحداثيات الخام مع مهلة أمان صارمة
 */
export async function fetchRawCoordinates(options: FetchCoordsOptions): Promise<RawCoords> {
  const safetyTimeoutMs = options.timeout + 1500;

  // Browser Web Geolocation (Tauri WebView uses the standard API).
  // 2. بيئة الويب والمتصفحات القياسية
  if (typeof navigator !== "undefined" && "geolocation" in navigator) {
    return new Promise<RawCoords>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("BROWSER_GPS_TIMEOUT"));
        }
      }, safetyTimeoutMs);

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);

          if (!pos || !pos.coords || !Number.isFinite(pos.coords.latitude) || !Number.isFinite(pos.coords.longitude)) {
            reject(new Error("INVALID_BROWSER_COORDS"));
            return;
          }

          resolve({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy != null && Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
            timestamp: pos.timestamp || Date.now(),
          });
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
        {
          enableHighAccuracy: options.enableHighAccuracy,
          timeout: options.timeout,
          maximumAge: options.maximumAge,
        }
      );
    });
  }

  throw new Error("GEOLOCATION_UNAVAILABLE");
}

export function getDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * إثراء الإحداثيات الخام باسم المكان والدولة والمنطقة الزمنية وحفظها محلياً
 */
export async function enrichCoordinatesToLocation(
  latitude: number,
  longitude: number,
  accuracy: number | null,
  timestamp: number,
  source: "gps_precise" | "gps_approximate"
): Promise<PrayerLocation> {
  const timezoneId = guessTimezone(latitude, longitude);
  const existing = getLastSavedLocation();

  let cityName = "موقعي الحالي";
  let cityNameAr = "موقعي الحالي";
  let countryNameAr: string | undefined = undefined;
  let displayAddress: string | undefined = undefined;

  // جلب اسم المكان باللغة العربية عبر التحويل العكسي في الخلفية
  try {
    const geocode = await reverseGeocodeCoordinates(latitude, longitude);
    if (geocode && geocode.placeName) {
      cityName = geocode.placeName;
      cityNameAr = geocode.placeName;
      countryNameAr = geocode.countryName || undefined;
      displayAddress = geocode.displayAddress || undefined;
    } else if (
      existing &&
      existing.cityNameAr &&
      getDistanceKm(existing.latitude, existing.longitude, latitude, longitude) < 15
    ) {
      // الاحتفاظ باسم المكان السابق إذا كان قريباً جداً وصالحاً
      cityName = existing.cityName;
      cityNameAr = existing.cityNameAr;
      countryNameAr = existing.countryNameAr;
      displayAddress = existing.displayAddress;
    } else {
      const nearestArab = findNearestArabPlace(latitude, longitude);
      const distArab = nearestArab ? getDistanceKm(latitude, longitude, nearestArab.lat, nearestArab.lng) : Infinity;

      if (nearestArab && distArab <= 15) {
        cityName = nearestArab.name;
        cityNameAr = `${nearestArab.name} (${nearestArab.parent})`;
        countryNameAr = nearestArab.country || "مصر";
      } else {
        const nearest = findNearestCity(latitude, longitude);
        const distCity = nearest ? getDistanceKm(latitude, longitude, nearest.latitude, nearest.longitude) : Infinity;

        if (nearest && distCity <= 15) {
          cityName = nearest.nameAr;
          cityNameAr = nearest.nameAr;
          countryNameAr = nearest.countryAr || "مصر";
        } else {
          // كاشف المسافة الصارم: أبعد من 15 كم، نمنع فرض أي مدينة بعيدة
          cityName = "موقعي الحالي";
          cityNameAr = "موقعي الحالي";
          countryNameAr = undefined;
        }
      }
    }
  } catch (err) {
    console.warn("Reverse geocoding error, falling back safely:", err);
    if (existing && existing.cityNameAr && getDistanceKm(existing.latitude, existing.longitude, latitude, longitude) < 15) {
      cityName = existing.cityName;
      cityNameAr = existing.cityNameAr;
      countryNameAr = existing.countryNameAr;
    } else {
      const nearestArab = findNearestArabPlace(latitude, longitude);
      const distArab = nearestArab ? getDistanceKm(latitude, longitude, nearestArab.lat, nearestArab.lng) : Infinity;
      if (nearestArab && distArab <= 15) {
        cityName = nearestArab.name;
        cityNameAr = `${nearestArab.name} (${nearestArab.parent})`;
        countryNameAr = nearestArab.country || "مصر";
      } else {
        cityName = "موقعي الحالي";
        cityNameAr = "موقعي الحالي";
        countryNameAr = undefined;
      }
    }
  }

  const location: PrayerLocation = {
    latitude: Number(latitude.toFixed(6)),
    longitude: Number(longitude.toFixed(6)),
    cityName,
    cityNameAr,
    countryNameAr,
    timezoneId,
    isAutoDetected: true,
    accuracyMeters: accuracy != null ? Math.round(accuracy) : null,
    capturedAt: timestamp,
    source,
    displayAddress,
  };

  // حفظ الموقع الجديد فوراً لتغذية الطبقة 2
  saveSavedLocation(location);

  return location;
}

/**
 * نظام تحديد الموقع الجغرافي الخماسي (The 5-Layer GPS System)
 *
 * الطبقة 1: فحص الإذن بذكاء وطلبه مرة واحدة فقط لكل جلسة تشغيل (قبول الدقيق أو التقريبي).
 * الطبقة 2: عرض الموقع المحفوظ فوراً في الواجهة دون انتظار (تتم قبل الاستدعاء واستخدامه كـ fallback).
 * الطبقة 3: محاولة عالية الدقة طازجة (10 ثوانٍ، maximumAge = 0 لضمان قراءة حقيقية جديدة، تفعيل fallback الشبكة).
 * الطبقة 4: محاولة احتياطية أسرع وأقل دقة (6 ثوانٍ فقط، قبول مخزن < 30 ثانية).
 * الطبقة 5: رسالة فشل عربية واضحة وقابلة للتصرف عند فشل الطبقتين 3 و 4 معاً.
 */
export async function autoDetectLocation(): Promise<PrayerLocation> {
  // الطبقة 1: التحقق من الإذن بذكاء
  let rawCoords: RawCoords | null = null;
  let source: "gps_precise" | "gps_approximate" = "gps_precise";

  // الطبقة 3: محاولة عالية الدقة (المحاولة الأولى)
  // enableHighAccuracy: true
  // timeout: 10000        (10 ثوانٍ)
  // maximumAge: 0         (طلب موقع فوري طازج بدون أي كاش قديم)
  // enableLocationFallback: true   (يسمح للنظام بالتحول لموقع الشبكة لو فشل GPS الفعلي — Tauri فقط)
  try {
    rawCoords = await fetchRawCoordinates({
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
      enableLocationFallback: true,
    });
    source = "gps_precise";
  } catch (layer3Error) {
    console.warn("Layer 3 (High accuracy GPS) failed, falling back to Layer 4 (Fast fallback)...", layer3Error);

    // الطبقة 4: محاولة احتياطية أسرع وأقل دقة (عند فشل الطبقة 3 فقط)
    // enableHighAccuracy: false
    // timeout: 6000          (6 ثوانٍ فقط)
    // maximumAge: 30000       (قبول موقع مخزَّن عمره أقل من 30 ثانية)
    try {
      rawCoords = await fetchRawCoordinates({
        enableHighAccuracy: false,
        timeout: 6000,
        maximumAge: 30000,
        enableLocationFallback: true,
      });
      source = "gps_approximate";
    } catch (layer4Error) {
      console.warn("Layer 4 (Fast fallback) also failed:", layer4Error);
      // الطبقة 5: رسالة فشل واضحة وقابلة للتصرف (فقط لو فشلت الطبقتان 3 و4 معاً)
      throw new Error(LOCATION_ACTIONABLE_ERROR_MESSAGE);
    }
  }

  if (!rawCoords) {
    throw new Error(LOCATION_ACTIONABLE_ERROR_MESSAGE);
  }

  // إثراء الإحداثيات وتخزينها
  return await enrichCoordinatesToLocation(
    rawCoords.latitude,
    rawCoords.longitude,
    rawCoords.accuracy,
    rawCoords.timestamp,
    source
  );
}

let lastSilentResumeRefreshTimestamp = 0;

/**
 * طبقة إضافية: تحديث هادئ عند عودة التطبيق للواجهة (Resume)
 *
 * عند رجوع المستخدم للتطبيق بعد تصغيره (Foreground)، نفّذ تحديثاً هادئاً للموقع في الخلفية
 * إعدادات معتدلة: enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 (5 دقائق)
 * بدون إظهار أي خطأ للمستخدم إن فشل — لأن لديه أصلاً موقعاً سابقاً معروضاً.
 */
export async function performSilentResumeLocationRefresh(): Promise<PrayerLocation | null> {
  const now = Date.now();
  // منع الاستدعاء المتكرر المفرط لو تم التبديل السريع بين التطبيقات (خلال أقل من 20 ثانية)
  if (now - lastSilentResumeRefreshTimestamp < 20000) {
    return null;
  }
  lastSilentResumeRefreshTimestamp = now;

  try {
    const rawCoords = await fetchRawCoordinates({
      enableHighAccuracy: false,
      timeout: 8000,
      maximumAge: 300000, // 5 دقائق
      enableLocationFallback: true,
    });

    return await enrichCoordinatesToLocation(
      rawCoords.latitude,
      rawCoords.longitude,
      rawCoords.accuracy,
      rawCoords.timestamp,
      "gps_approximate"
    );
  } catch (err) {
    // بدون إظهار أي خطأ للمستخدم إطلاقاً
    console.log("Silent resume location update gracefully skipped:", err);
    return null;
  }
}
