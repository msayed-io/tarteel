/**
 * تَرتيل — محرك المواقيت الفلكي (Astronomical Prayer Engine)
 * ===========================================================
 * حساب ديناميكي كامل على الطلب (on-the-fly) على أساس التوقيت العالمي UTC.
 *
 * المبدأ: كل المواقيت تُحسب لحظاتٍ مطلقة (epoch ms) لا أرقامَ ساعات. لا يوجد أي
 * "فارق توقيت ثابت" في هذا الملف: المنطقة الزمنية تُستخدم للعرض ولتحديد اليوم
 * المدني فقط. ولهذا يعمل التوقيت الصيفي والشتوي تلقائيًا دون أي فرع في الكود.
 *
 * المرجع الفلكي: Astronomical Almanac (USNO) — دقة موضع الشمس ≈ 0.01°،
 * وهو ما يكافئ أقل من ثانية في زاوية الشروق/الغروب. تُحسب المواقيت بحلٍّ
 * تكراري (iterate) على الموضع الشمسي عند اللحظة نفسها لا عند منتصف الليل،
 * وهو ما يزيل الخطأ المتراكم الذي يظهر في الحسابات المبسطة.
 */

/** زوايا الانخفاض والطرق الفقهية المعتمدة. */
export const METHODS = {
  egyptian: {
    id: 'egyptian',
    name: 'الهيئة المصرية العامة للمساحة',
    fajrAngle: 19.5,
    ishaAngle: 17.5,
    countryCodes: ['EG', 'SD', 'LY', 'SY', 'IQ', 'LB', 'JO', 'YE', 'PS'],
  },
  umm_al_qura: {
    id: 'umm_al_qura',
    name: 'أم القرى — مكة المكرمة',
    fajrAngle: 18.5,
    /* العشاء في أم القرى = المغرب + 90 دقيقة، لا زاوية. */
    ishaIntervalMinutes: 90,
    countryCodes: ['SA'],
    adjust: { fajr: -1, dhuhr: 2, asr: 1, maghrib: 1, isha: 0 },
  },
  muslim_world_league: {
    id: 'muslim_world_league',
    name: 'رابطة العالم الإسلامي',
    fajrAngle: 18,
    ishaAngle: 17,
    countryCodes: ['AE', 'KW', 'QA', 'BH', 'OM', 'DZ', 'MA', 'TN', 'MR', 'SO'],
  },
  karachi: {
    id: 'karachi',
    name: 'جامعة العلوم الإسلامية — كراتشي',
    fajrAngle: 18,
    ishaAngle: 18,
    countryCodes: ['PK', 'IN', 'BD', 'AF', 'LK', 'NP', 'MV'],
  },
  dubai: { id: 'dubai', name: 'الإمارات — دبي', fajrAngle: 18.2, ishaAngle: 18.2, countryCodes: [] },
  kuwait: { id: 'kuwait', name: 'الكويت', fajrAngle: 18, ishaAngle: 17.5, countryCodes: [] },
  turkey: { id: 'turkey', name: 'تركيا — ديانت', fajrAngle: 18, ishaAngle: 17, countryCodes: ['TR'] },
  singapore: { id: 'singapore', name: 'سنغافورة', fajrAngle: 20, ishaAngle: 18, countryCodes: ['SG', 'MY', 'ID', 'BN'] },
  isna: { id: 'isna', name: 'أمريكا الشمالية — ISNA', fajrAngle: 15, ishaAngle: 15, countryCodes: ['US', 'CA'] },
};

/** الدول التي يُعتمد فيها مذهب الحنفي لحساب العصر (معامل ظل = 2). */
const HANAFI_COUNTRIES = new Set(['PK', 'IN', 'BD', 'AF', 'TR', 'LK', 'NP']);

/** حدّ العرض الذي تُشغَّل فوقه قواعد الليالي الطويلة. */
const HIGH_LATITUDE_THRESHOLD = 48;

const DEG = Math.PI / 180;
const sin = d => Math.sin(d * DEG);
const cos = d => Math.cos(d * DEG);
const tan = d => Math.tan(d * DEG);
const asin = x => Math.asin(x) / DEG;
const acos = x => Math.acos(x) / DEG;
const atan2 = (y, x) => Math.atan2(y, x) / DEG;

const fixAngle = a => ((a % 360) + 360) % 360;

/* ------------------------------------------------------------------ *
 * 1. الموضع الشمسي — Astronomical Almanac، صالح لعقود حول 2000.0
 * ------------------------------------------------------------------ */

/** اليوم اليولياني من لحظة مطلقة (epoch ms). */
export function julianDay(epochMs) {
  return epochMs / 86400000 + 2440587.5;
}

/** اليوم اليولياني من التاريخ الميلادي (UTC). */
function julianDayFromCivil(year, month, day) {
  let y = year, m = month;
  if (m <= 2) { y -= 1; m += 12; }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5;
}

/** يضع الزاوية في المدى [-180, 180] لحساب فروق صحيحة. */
const wrap180 = a => ((a + 540) % 360) - 180;

/**
 * انحراف الشمس ومعادلة الزمن عند اليوم اليولياني jd.
 *
 * تُحسب معادلة الزمن من الفرق بين الطول الوسطي والمطلع المستقيم الظاهرى:
 *   EoT = 4 × (L0 − α + Δψ·cos ε)   بالدقائق
 * وهي الصيغة الدقيقة (Astronomical Algorithms / NOAA)، بخلاف المتسلسلات
 * التقريبية التي تنحرف بدقائق كاملة فتزيح كل المواقيت عن موضعها.
 *
 * الدقة: الانحراف < 0.01°، ومعادلة الزمن < ثانية واحدة.
 */
export function solarPosition(jd) {
  const d = jd - 2451545.0;               // أيام من J2000.0
  const T = d / 36525;                    // قرون يوليانية من J2000.0
  const meanLongitude = fixAngle(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
  const meanAnomaly = fixAngle(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
  const eccentricity = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
  const omega = fixAngle(125.04 - 1934.136 * T);

  /* معادلة المركز ثم الطول الظاهرى. */
  const equationOfCenter =
    1.914602 * sin(meanAnomaly)
    + 0.019993 * sin(2 * meanAnomaly)
    + 0.000289 * sin(3 * meanAnomaly);
  const trueLongitude = meanLongitude + equationOfCenter;
  const nutation = -0.00478 * sin(omega);
  const apparentLongitude = trueLongitude + nutation;

  /* الميل الحقيقي + تصحيح النوتيشن. */
  const meanObliquity = 23 + 26 / 60 + 21.448 / 3600 - (46.815 * T + 0.00059 * T * T - 0.001813 * T ** 3) / 3600;
  const obliquity = meanObliquity + 0.00256 * cos(omega);

  const declination = asin(sin(obliquity) * sin(apparentLongitude));
  const rightAscension = fixAngle(atan2(cos(obliquity) * sin(apparentLongitude), cos(apparentLongitude)));

  /* معادلة الزمن بالدقائق. */
  const equationOfTime = 4 * wrap180(meanLongitude - rightAscension + nutation * cos(obliquity));

  return { declination, equationOfTime, rightAscension, obliquity, apparentLongitude };
}

/**
 * لحظة الزوال الشمسي (الظهر الحقيقي) قرب اليوم اليولياني jd0 لخط الطول lon.
 * تُحلّ بالتكرار لأن معادلة الزمن نفسها تتوقف على لحظة الزوال.
 */
function transitJdFor(jd0, lon) {
  const base = jd0 + 0.5 - lon / 360;
  let jd = base;
  for (let i = 0; i < 3; i++) {
    const { equationOfTime } = solarPosition(jd);
    const next = base - equationOfTime / 1440;
    if (Math.abs(next - jd) < 1e-9) return next;
    jd = next;
  }
  return jd;
}

/**
 * الزمن الزاوي (بالساعات) الذي تصل فيه الشمس إلى ارتفاع معيّن (سالب = تحت الأفق).
 * يُرجع NaN إذا لم تصل الشمس لذلك الارتفاع (الليالي القطبية).
 */
function hourAngleForAltitude(lat, declination, altitude) {
  const numerator = sin(altitude) - sin(lat) * sin(declination);
  const denominator = cos(lat) * cos(declination);
  if (denominator === 0) return NaN;
  const ratio = numerator / denominator;
  if (ratio > 1 || ratio < -1) return NaN;
  return acos(ratio) / 15;
}

/**
 * الزمن الزاوي لصلاة العصر: عندما يصبح ظل الجسم مساويًا لطوله أو ضعفه.
 * shadowFactor = 1 (جمهور الفقهاء) أو 2 (الحنفي).
 */
function asrHourAngle(lat, declination, shadowFactor) {
  const altitude = Math.atan(1 / (shadowFactor + tan(Math.abs(lat - declination)))) / DEG;
  return hourAngleForAltitude(lat, declination, altitude);
}

/* ------------------------------------------------------------------ *
 * 2. حلّ اللحظة المطلقة لكل حدث
 * ------------------------------------------------------------------ */

/**
 * يحلّ اللحظة المطلقة لحدث يقع قبل الزوال (direction = -1) أو بعده (+1).
 *
 * التكرار ثلاثي المستوى: الموضع الشمسي ← الزمن الزاوي ← اللحظة، ثم يُعاد
 * تقييم الموضع عند اللحظة الجديدة. هذا يزيل الخطأ المتراكم بعشرات الثواني
 * الذي تنتجه الحسابات المبسطة التي تفترض ثبات موضع الشمس طوال اليوم.
 *
 * @returns {number} اليوم اليولياني للحظة الحدث، أو NaN إن تعذّر.
 */
function solveEventJd(jd0, lon, lat, direction, angle, shadowFactor) {
  const base = jd0 + 0.5 - lon / 360;
  let jd = base;
  for (let i = 0; i < 4; i++) {
    const { declination, equationOfTime } = solarPosition(jd);
    const transit = base - equationOfTime / 1440;
    const ha = shadowFactor != null
      ? asrHourAngle(lat, declination, shadowFactor)
      : hourAngleForAltitude(lat, declination, angle);
    if (!Number.isFinite(ha)) return NaN;
    const next = transit + (direction < 0 ? -ha : ha) / 24;
    if (Math.abs(next - jd) < 1e-10) return next;
    jd = next;
  }
  return jd;
}

/**
 * حدّ خط العرض عند أقرب قيمة تصل فيها الشمس إلى الزاوية المطلوبة.
 *
 * في العروض القطبية (شمس منتصف الليل أو ليل قطبي) لا تعبر الشمس الأفق أصلًا،
 * فتصبح زاوية الساعة غير معرّفة. الحل المعتمد (PrayTimes) هو تقييد خط العرض
 * عند أقرب قيمة يتحقق عندها العبور، فينتج نهار أو ليل اسمي يُستخدم بعد ذلك
 * مع قاعدة تقسيم الليل. لا يُسقط أي حدث ولا يُخترع وقت من عدم.
 */
function clampLatitudeForAltitude(lat, declination, angle) {
  const limit = 90 - Math.abs(angle) - Math.abs(declination);
  const sign = lat < 0 ? -1 : 1;
  if (Math.abs(lat) <= limit) return lat;
  return sign * Math.max(0, limit - 0.001);
}

/** يحوّل اليوم اليولياني إلى لحظة مطلقة (epoch ms). */
function jdToEpoch(jd) {
  if (!Number.isFinite(jd)) return NaN;
  return (jd - 2440587.5) * 86400000;
}

/* ------------------------------------------------------------------ *
 * 3. الواجهة العامة
 * ------------------------------------------------------------------ */

/** يختار الطريقة تلقائيًا من رمز الدولة. لا يُسأل المستخدم. */
export function methodForCountry(countryCode) {
  const code = String(countryCode || '').toUpperCase();
  for (const method of Object.values(METHODS)) {
    if (method.countryCodes.includes(code)) return method;
  }
  return METHODS.muslim_world_league;
}

/** معامل ظل العصر تلقائيًا من رمز الدولة. */
export function shadowFactorForCountry(countryCode) {
  return HANAFI_COUNTRIES.has(String(countryCode || '').toUpperCase()) ? 2 : 1;
}

/** إزاحات يدوية مسموحة لكل صلاة، بالدقائق. */
export const MANUAL_ADJUST_LIMIT = 5;

function normaliseAdjust(adjust) {
  const out = { fajr: 0, sunrise: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 };
  if (!adjust) return out;
  for (const key of Object.keys(out)) {
    const value = Number(adjust[key]);
    if (Number.isFinite(value)) out[key] = Math.max(-MANUAL_ADJUST_LIMIT, Math.min(MANUAL_ADJUST_LIMIT, Math.round(value)));
  }
  return out;
}

/**
 * تحويل التاريخ المدني (سنة/شهر/يوم) في منطقة زمنية IANA إلى لحظة منتصف ليل UTC التقريبية.
 * لا يُستخدم لإزاحة ثابتة: نستعمل Intl للحصول على الإزاحة الفعلية لذلك التاريخ،
 * فتكون النتيجة صحيحة في أيام تغيير التوقيت الصيفي.
 */
export function civilDateAnchorUtc(year, month, day, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  /* نقيس إزاحة ذلك التاريخ عند الظهر لا عند منتصف الليل: الظهر لا يقع أبدًا
     داخل فجوة التوقيت الصيفي، بخلاف منتصف الليل الذي قد يكون غائبًا أو مكررًا.
     ثم نطرح الإزاحة من منتصف الليل UTC للحصول على منتصف الليل المحلي. */
  const noonUtc = Date.UTC(year, month - 1, day, 12, 0, 0);
  const parts = Object.fromEntries(formatter.formatToParts(new Date(noonUtc)).map(x => [x.type, x.value]));
  const wallClockAtNoon = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMs = wallClockAtNoon - noonUtc;
  return Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMs;
}

/** التاريخ المدني في منطقة زمنية للحظة مطلقة. */
export function civilDateAt(epochMs, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(epochMs)).map(p => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

const PRAYER_ORDER = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

/**
 * يحسب مواقيت يوم مدني واحد.
 *
 * @param {object} input
 * @param {number} input.latitude   خط العرض
 * @param {number} input.longitude  خط الطول
 * @param {string} input.timeZone   منطقة IANA (Africa/Cairo)
 * @param {string} [input.countryCode] رمز الدولة لاختيار الطريقة تلقائيًا
 * @param {string} [input.methodId] تجاوز يدوي للطريقة (اختياري)
 * @param {number} [input.shadowFactor] تجاوز يدوي لمعامل العصر (اختياري)
 * @returns {{date:string, timeZone:string, method:string, times:object, instants:object}}
 */
export function computeDay({ latitude, longitude, timeZone, countryCode, methodId, shadowFactor, year, month, day, adjust }) {
  const lat = Number(latitude), lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new RangeError('إحداثيات غير صالحة لحساب المواقيت.');
  }
  if (!timeZone) throw new RangeError('منطقة زمنية IANA مطلوبة.');
  const method = (methodId && METHODS[methodId]) || methodForCountry(countryCode);
  const shadows = Number.isFinite(Number(shadowFactor)) ? Number(shadowFactor) : shadowFactorForCountry(countryCode);
  const offsets = normaliseAdjust(adjust || method.adjust);

  /* التاريخ المدني المطلوب: من الوسائط أو من اللحظة الحالية. */
  const civil = (year && month && day)
    ? { year: Number(year), month: Number(month), day: Number(day) }
    : civilDateAt(Date.now(), timeZone);

  /* اليوم اليولياني للتاريخ المدني عند 00:00 UT، ثم حلّ كل حدث منه. */
  const jd0 = julianDayFromCivil(civil.year, civil.month, civil.day);
  const transitJd = transitJdFor(jd0, lon);

  /* خط عرض آمن لكل زاوية على حدة، يحل العروض القطبية دون إسقاط حدث. */
  const latFor = angle => clampLatitudeForAltitude(lat, solarPosition(jd0).declination, angle);

  const raw = {};
  raw.fajr = jdToEpoch(solveEventJd(jd0, lon, latFor(-method.fajrAngle), -1, -method.fajrAngle, null)) + offsets.fajr * 60000;
  raw.sunrise = jdToEpoch(solveEventJd(jd0, lon, latFor(-0.833), -1, -0.833, null)) + offsets.sunrise * 60000;
  raw.dhuhr = jdToEpoch(transitJd) + offsets.dhuhr * 60000;
  raw.asr = jdToEpoch(solveEventJd(jd0, lon, latFor(0), 1, null, shadows)) + offsets.asr * 60000;
  raw.maghrib = jdToEpoch(solveEventJd(jd0, lon, latFor(-0.833), 1, -0.833, null)) + offsets.maghrib * 60000;
  raw.isha = method.ishaIntervalMinutes
    ? raw.maghrib + method.ishaIntervalMinutes * 60000
    : jdToEpoch(solveEventJd(jd0, lon, latFor(-method.ishaAngle), 1, -method.ishaAngle, null)) + offsets.isha * 60000;

  /* قاعدة تقسيم الليل: في العروض العالية يُقسَّم الليل الحقيقي (من المغرب إلى
     شروق الغد) على سبعة أجزاء، فيُشتق منها الفجر والعشاء عند تعذّر الزاوية. */
  if (Math.abs(lat) >= HIGH_LATITUDE_THRESHOLD) {
    const realNight = (raw.sunrise + 86400000) - raw.maghrib;
    if (!Number.isFinite(raw.fajr) || (raw.fajr < raw.sunrise - realNight * 0.9)) raw.fajr = raw.sunrise - realNight / 7;
    if (!Number.isFinite(raw.isha) || (raw.isha > raw.maghrib + realNight * 0.9)) raw.isha = raw.maghrib + realNight / 7;
  }

  const instants = {
    fajr: raw.fajr, sunrise: raw.sunrise, dhuhr: raw.dhuhr,
    asr: raw.asr, maghrib: raw.maghrib, isha: raw.isha,
  };
  /* تثبيت الترتيب الزمني: أي حدث NaN أو خارج التسلسل يُعلَّم لا يُسكَت عنه. */
  let previous = -Infinity;
  const invalid = [];
  for (const key of PRAYER_ORDER) {
    if (!Number.isFinite(instants[key]) || instants[key] <= previous) invalid.push(key);
    else previous = instants[key];
  }
  const nightMs = instants.sunrise + 86400000 - instants.maghrib;

  return {
    date: `${civil.year}-${String(civil.month).padStart(2, '0')}-${String(civil.day).padStart(2, '0')}`,
    timeZone,
    method: method.id,
    methodName: method.name,
    shadowFactor: shadows,
    adjust: offsets,
    highLatitude: Math.abs(lat) >= HIGH_LATITUDE_THRESHOLD,
    invalid,
    instants,
  };
}

function toEpoch(jd) {
  if (!Number.isFinite(jd)) return NaN;
  return (jd - 2440587.5) * 86400000;
}

/** مضاعف اليوم بالأيام، يحفظ التقويم في تغيير الشهر والسنة. */
export function addDays(civil, delta) {
  const d = new Date(Date.UTC(civil.year, civil.month - 1, civil.day + delta));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * المسار الزمني المتصل: يبني قائمة أحداث مرتبة تغطي نافذة من الأيام
 * بداية من عشاء الأمس فجر اليوم ... عشاء اليوم فجر الغد.
 * يحتوي كل حدث على id فريد من تاريخه واسمه، فلا تكرار عبر الأيام.
 */
export function buildTimeline({ latitude, longitude, timeZone, countryCode, methodId, shadowFactor, adjust, from = Date.now(), daysAhead = 3 }) {
  const start = civilDateAt(from, timeZone);
  const events = [];
  for (let delta = -1; delta <= daysAhead; delta++) {
    const civil = addDays(start, delta);
    const day = computeDay({ latitude, longitude, timeZone, countryCode, methodId, shadowFactor, adjust, ...civil });
    for (const key of PRAYER_ORDER) {
      const at = day.instants[key];
      if (!Number.isFinite(at)) continue;
      events.push({
        id: `${day.date}|${key}`,
        key,
        date: day.date,
        at,
        localTime: formatLocalTime(at, timeZone),
        timeZone,
      });
    }
  }
  events.sort((a, b) => a.at - b.at);
  return events;
}

/** عرض الوقت المحلي بصيغة 12 ساعة عربية. */
export function formatLocalTime(epochMs, timeZone) {
  if (!Number.isFinite(epochMs)) return '—';
  return new Intl.DateTimeFormat('ar-EG', {
    timeZone, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(epochMs));
}

/** الصلاة التالية بعد لحظة معيّنة، مع أسماء عربية. */
export const ARABIC_NAMES = {
  fajr: 'الفجر', sunrise: 'الشروق', dhuhr: 'الظهر',
  asr: 'العصر', maghrib: 'المغرب', isha: 'العشاء',
};

export function nextPrayer(events, now = Date.now()) {
  if (!Array.isArray(events)) return null;
  return events.find(event => event.at > now) || null;
}

export function currentPrayer(events, now = Date.now()) {
  if (!Array.isArray(events)) return null;
  let found = null;
  for (const event of events) {
    if (event.at <= now) found = event;
    else break;
  }
  return found;
}
