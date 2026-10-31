const API = 'https://api.aladhan.com/v1';
const GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search';
export const PRAYER_ITEMS = [
  ['الفجر', 'Fajr'], ['الظهر', 'Dhuhr'], ['العصر', 'Asr'], ['المغرب', 'Maghrib'], ['العشاء', 'Isha']
];

export class PrayerDataError extends Error {
  constructor(message, code = 'prayer-data') { super(message); this.name = 'PrayerDataError'; this.code = code; }
}

export async function requestJson(url, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(15000) });
  } catch (cause) {
    throw new PrayerDataError(`تعذر الاتصال بمصدر المواقيت: ${String(cause?.message || cause)}`, 'network');
  }
  if (!response?.ok) throw new PrayerDataError(`رفض المصدر الطلب (HTTP ${response?.status ?? 'غير معروف'}).`, 'http');
  let data;
  try { data = await response.json(); }
  catch (cause) { throw new PrayerDataError(`استجابة المصدر ليست JSON صالحًا: ${String(cause)}`, 'invalid-json'); }
  return data;
}

function apiDateParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(now));
  const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { year: Number(v.year), month: Number(v.month), day: Number(v.day) };
}

function shiftMonth(year, month, by) {
  const d = new Date(Date.UTC(year, month - 1 + by, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

function dateKey({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const wallFormatter = timeZone => new Intl.DateTimeFormat('en-GB', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

function zonedParts(epochMs, formatter) {
  return Object.fromEntries(formatter.formatToParts(new Date(epochMs)).map(p => [p.type, Number(p.value)]));
}

function wallClockToEpoch(date, hour, minute, timeZone) {
  const formatter = wallFormatter(timeZone);
  const [year, month, day] = date.split('-').map(Number);
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const targetKey = `${year}-${month}-${day}-${hour}-${minute}-0`;
  const offsets = new Set();
  // Sampling both sides of possible DST transitions lets us choose the correct
  // local offset; ambiguous fall-back wall times resolve to the earlier instant.
  for (let delta = -36; delta <= 36; delta += 3) {
    const probe = targetUtc + delta * 3600000;
    const p = zonedParts(probe, formatter);
    const representedUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    offsets.add(Math.round((representedUtc - probe) / 60000));
  }
  const candidates = [...offsets].map(offset => targetUtc - offset * 60000).filter(epoch => {
    const p = zonedParts(epoch, formatter);
    return `${p.year}-${p.month}-${p.day}-${p.hour}-${p.minute}-${p.second}` === targetKey;
  }).sort((a, b) => a - b);
  if (!candidates.length) {
    throw new PrayerDataError(`تعذر تحويل ${date} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} في المنطقة الزمنية ${timeZone} دون افتراض وقت.`, 'timezone');
  }
  return candidates[0];
}

function parseClock(raw, date, timeZone) {
  const match = String(raw || '').match(/^\s*(\d{1,2}):(\d{2})\b/);
  if (!match) throw new PrayerDataError(`صيغة وقت غير صالحة من المصدر: ${String(raw)}`, 'invalid-time');
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new PrayerDataError(`وقت خارج النطاق من المصدر: ${String(raw)}`, 'invalid-time');
  return wallClockToEpoch(date, hour, minute, timeZone);
}

function assertLocation(location) {
  if (!location || !Number.isFinite(Number(location.latitude)) || !Number.isFinite(Number(location.longitude)) || Math.abs(Number(location.latitude)) > 90 || Math.abs(Number(location.longitude)) > 180) {
    throw new PrayerDataError('لا يوجد موقع صالح. اسمح بموقع الجهاز أو اختر مدينة يدويًا؛ لن تُستخدم إحداثيات افتراضية.', 'location');
  }
  if (location.source === 'manual' && (!location.timezone || !location.city)) {
    throw new PrayerDataError('اختر مدينة يدوية تتضمن منطقة زمنية معروفة قبل طلب المواقيت.', 'location');
  }
}

export async function fetchCalculationMethods(fetchImpl = fetch) {
  const data = await requestJson(`${API}/methods`, fetchImpl);
  if (data?.code !== 200 || !data.data || typeof data.data !== 'object') {
    throw new PrayerDataError('لم يرسل مصدر المواقيت قائمة طرق حساب صالحة.', 'methods');
  }
  return Object.entries(data.data)
    .filter(([key, item]) => key !== 'CUSTOM' && Number.isInteger(Number(item?.id)) && item?.name)
    .map(([key, item]) => ({ key, id: Number(item.id), name: String(item.name) }));
}

export async function searchCities(query, fetchImpl = fetch) {
  const name = String(query || '').trim();
  if ([...name].length < 2) return [];
  const url = new URL(GEOCODING);
  url.search = new URLSearchParams({ name, count: '8', language: 'ar', format: 'json' }).toString();
  const data = await requestJson(url.toString(), fetchImpl);
  if (data?.error) throw new PrayerDataError(`تعذر البحث عن المدينة: ${data.reason || 'خطأ من المصدر'}`, 'geocoding');
  if (!Array.isArray(data?.results)) throw new PrayerDataError('أعاد مصدر المدن بيانات غير مفهومة.', 'geocoding');
  return data.results.filter(item => Number.isFinite(item.latitude) && Number.isFinite(item.longitude) && typeof item.timezone === 'string' && item.timezone).map(item => ({
    source: 'manual', city: String(item.name), country: String(item.country || ''), admin1: String(item.admin1 || ''),
    latitude: Number(item.latitude), longitude: Number(item.longitude), timezone: item.timezone,
    geonamesId: Number.isFinite(item.id) ? item.id : null
  }));
}

export async function getDeviceLocation({ checkPermissions, requestPermissions, getCurrentPosition }) {
  let permission;
  try { permission = await checkPermissions(); }
  catch (cause) { throw new PrayerDataError(`تعذر فحص إذن الموقع في النظام: ${String(cause)}`, 'location-permission'); }
  if (permission?.location === 'prompt' || permission?.location === 'prompt-with-rationale') {
    try { permission = await requestPermissions(['location']); }
    catch (cause) { throw new PrayerDataError(`تعذر طلب إذن الموقع: ${String(cause)}`, 'location-permission'); }
  }
  if (permission?.location !== 'granted') {
    throw new PrayerDataError('إذن الموقع غير ممنوح. لم نخمن موقعك؛ اختر مدينة يدويًا أو غيّر إذن الموقع من إعدادات Windows.', 'location-denied');
  }
  let position;
  try { position = await getCurrentPosition({ enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }); }
  catch (cause) { throw new PrayerDataError(`فشل تحديد موقع الجهاز: ${String(cause)}. لم تُنشأ إحداثيات بديلة؛ يمكنك اختيار مدينة يدويًا.`, 'location-failed'); }
  const latitude = Number(position?.coords?.latitude), longitude = Number(position?.coords?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new PrayerDataError('أعاد النظام قراءة موقع غير صالحة؛ لم تُستخدم إحداثيات افتراضية.', 'location-invalid');
  }
  return { source: 'device', city: 'موقع الجهاز', country: '', latitude, longitude, timezone: null, accuracy: Number(position.coords.accuracy) || null };
}

function parseMonthResponse(payload, { year, month, methodId, school, expectedTimezone }) {
  if (payload?.code !== 200 || !Array.isArray(payload.data) || payload.data.length < 27) {
    throw new PrayerDataError(`لم يُرجع مصدر المواقيت تقويمًا شهريًا صالحًا لـ ${year}-${String(month).padStart(2, '0')}.`, 'calendar');
  }
  const firstMeta = payload.data[0]?.meta;
  const timezone = String(firstMeta?.timezone || '');
  if (!timezone) throw new PrayerDataError('لم يحدد مصدر المواقيت المنطقة الزمنية؛ لن نعرض أوقاتًا محولة بالتخمين.', 'timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); }
  catch { throw new PrayerDataError(`المنطقة الزمنية التي أعادها المصدر غير معروفة: ${timezone}`, 'timezone'); }
  if (expectedTimezone && timezone !== expectedTimezone) {
    throw new PrayerDataError(`أعاد مصدر المواقيت المنطقة ${timezone} بينما المدينة المختارة هي ${expectedTimezone}. راجع المدينة قبل الاعتماد.`, 'timezone-mismatch');
  }
  if (Number(firstMeta?.method?.id) !== methodId) throw new PrayerDataError('لم تطابق طريقة الحساب في رد المصدر الطريقة المختارة.', 'method-mismatch');
  const expectedSchool = school === 1 ? 'HANAFI' : 'STANDARD';
  if (String(firstMeta?.school || '').toUpperCase() !== expectedSchool) throw new PrayerDataError('لم تطابق طريقة حساب العصر في رد المصدر الاختيار المحدد.', 'school-mismatch');
  const events = [];
  for (const day of payload.data) {
    if (Number(day?.meta?.method?.id) !== methodId || String(day?.meta?.school || '').toUpperCase() !== expectedSchool || day?.meta?.timezone !== timezone) {
      throw new PrayerDataError('تغيرت بيانات طريقة الحساب أو المنطقة الزمنية داخل رد التقويم؛ أُلغي التقويم كله.', 'inconsistent-calendar');
    }
    const [dd, mm, yyyy] = String(day?.date?.gregorian?.date || '').split('-').map(Number);
    if (!dd || !mm || !yyyy || mm !== month || yyyy !== year) throw new PrayerDataError('يتضمن رد المصدر تاريخًا لا يطابق الشهر المطلوب.', 'invalid-date');
    const date = dateKey({ year: yyyy, month: mm, day: dd });
    for (const [name, key] of PRAYER_ITEMS) {
      const at = parseClock(day?.timings?.[key], date, timezone);
      events.push({ name, key, date, at, localTime: String(day.timings[key]).match(/^\s*\d{1,2}:\d{2}/)?.[0] || '', timezone });
    }
  }
  return { timezone, events };
}

export async function loadPrayerSchedule({ location, methodId, school, now = Date.now() }, fetchImpl = fetch) {
  assertLocation(location);
  const method = Number(methodId), madhhab = Number(school);
  if (!Number.isInteger(method) || method < 0 || ![0, 1].includes(madhhab)) {
    throw new PrayerDataError('اختر طريقة حساب الصلاة وطريقة حساب العصر قبل تحميل المواقيت.', 'settings');
  }
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const startZone = location.source === 'manual' ? location.timezone : deviceZone;
  let firstMonth = apiDateParts(now, startZone);
  let first = null;
  if (location.source !== 'manual') {
    const probeUrl = new URL(`${API}/calendar/${firstMonth.year}/${firstMonth.month}`);
    probeUrl.search = new URLSearchParams({ latitude: String(location.latitude), longitude: String(location.longitude), method: String(method), school: String(madhhab) }).toString();
    const probePayload = await requestJson(probeUrl.toString(), fetchImpl);
    const probeMeta = probePayload?.data?.[0]?.meta;
    const zone = String(probeMeta?.timezone || '');
    if (!zone) throw new PrayerDataError('لم يتمكن مصدر المواقيت من تحديد منطقة موقع الجهاز الزمنية.', 'timezone');
    try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); }
    catch { throw new PrayerDataError(`منطقة الموقع غير معروفة: ${zone}`, 'timezone'); }
    firstMonth = apiDateParts(now, zone);
    const probeYear = Number(probePayload?.data?.[0]?.date?.gregorian?.year);
    const probeMonth = Number(probePayload?.data?.[0]?.date?.gregorian?.month?.number);
    if (probeYear === firstMonth.year && probeMonth === firstMonth.month) first = probePayload;
  }
  const targetMonths = [0, 1, 2].map(delta => shiftMonth(firstMonth.year, firstMonth.month, delta));
  const fetched = await Promise.all(targetMonths.map(async item => {
    if (first && item.year === firstMonth.year && item.month === firstMonth.month) return first;
    const url = new URL(`${API}/calendar/${item.year}/${item.month}`);
    const params = { latitude: String(location.latitude), longitude: String(location.longitude), method: String(method), school: String(madhhab) };
    if (location.source === 'manual') params.timezonestring = location.timezone;
    url.search = new URLSearchParams(params).toString();
    return requestJson(url.toString(), fetchImpl);
  }));
  let timezone = location.source === 'manual' ? location.timezone : '';
  const events = [];
  for (let index = 0; index < fetched.length; index++) {
    const expected = location.source === 'manual' ? location.timezone : (timezone || undefined);
    const parsed = parseMonthResponse(fetched[index], { ...targetMonths[index], methodId: method, school: madhhab, expectedTimezone: expected });
    if (timezone && timezone !== parsed.timezone) throw new PrayerDataError('اختلفت المنطقة الزمنية بين أشهر التقويم؛ لم يُعتمد الجدول.', 'timezone-mismatch');
    timezone = parsed.timezone;
    events.push(...parsed.events);
  }
  if (events.length < 90 || !timezone) throw new PrayerDataError('التقويم المستلم غير مكتمل؛ لا توجد مواقيت مؤكدة للعرض.', 'calendar-incomplete');
  const coordinateKey = `${Number(location.latitude).toFixed(5)},${Number(location.longitude).toFixed(5)}`;
  const schedule = events.map(event => ({ ...event, id: `${event.date}|${event.key}|${coordinateKey}|m${method}|s${madhhab}` }));
  return { version: 1, source: 'AlAdhan Prayer Times API', locationSource: location.source, locationLabel: location.source === 'manual' ? `يدوي: ${location.city}${location.country ? `، ${location.country}` : ''}` : 'موقع الجهاز', timezone, methodId: method, school: madhhab, fetchedAt: Number(now), events: schedule };
}

export function findNextPrayer(schedule, now = Date.now()) {
  if (!Array.isArray(schedule?.events)) return null;
  return schedule.events.find(event => Number.isFinite(event.at) && event.at > now) || null;
}

export function getTodayPrayerEvents(schedule, now = Date.now()) {
  if (!Array.isArray(schedule?.events) || !schedule.timezone) return [];
  const today = dateKey(apiDateParts(now, schedule.timezone));
  return schedule.events.filter(event => event.date === today);
}

export function getCurrentPrayer(schedule, now = Date.now()) {
  if (!Array.isArray(schedule?.events)) return null;
  for (let i = schedule.events.length - 1; i >= 0; i--) if (schedule.events[i].at <= now) return schedule.events[i];
  return null;
}

export function prayerTransition({ wasPlaying, pauseAtAdhan }) {
  return { shouldPause: Boolean(wasPlaying && pauseAtAdhan), canOfferResume: Boolean(wasPlaying && pauseAtAdhan) };
}

export function sleepTransition({ mode, deadline, now = Date.now(), trackEnded = false }) {
  if (mode === 'minutes' && Number.isFinite(deadline) && now >= deadline) return { stop: true, clear: true, reason: 'deadline' };
  if (mode === 'end' && trackEnded) return { stop: true, clear: true, reason: 'track-end' };
  return { stop: false, clear: false, reason: null };
}

export function haversineKm(a, b) {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(Number(b.latitude) - Number(a.latitude));
  const dLon = rad(Number(b.longitude) - Number(a.longitude));
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(Number(a.latitude))) * Math.cos(rad(Number(b.latitude))) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
