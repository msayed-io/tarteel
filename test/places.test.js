import { describe, it, expect } from 'vitest';
import { nearestArabCity, haversineKm, ARAB_CITIES } from '../src/engine/places.js';
import { arabicClock, buildRows } from '../src/DailyPrayerTable.jsx';

describe('المطابق الأوفلاين — الطبقة التي لا تفشل', () => {
  for (const spot of [
    { name: 'الإسماعيلية', lat: 30.5965, lon: 32.2715, city: 'الإسماعيلية', country: 'مصر' },
    { name: 'الزقازيق', lat: 30.5877, lon: 31.5020, city: 'الزقازيق', country: 'مصر' },
    { name: 'القاهرة', lat: 30.0444, lon: 31.2357, city: 'القاهرة', country: 'مصر' },
    { name: 'الإسكندرية', lat: 31.2001, lon: 29.9187, city: 'الإسكندرية', country: 'مصر' },
    { name: 'أسوان', lat: 24.0889, lon: 32.8998, city: 'أسوان', country: 'مصر' },
    { name: 'جدة', lat: 21.4858, lon: 39.1925, city: 'جدة', country: 'السعودية' },
    { name: 'مكة', lat: 21.4225, lon: 39.8262, city: 'مكة المكرمة', country: 'السعودية' },
    { name: 'دبي', lat: 25.2048, lon: 55.2708, city: 'دبي', country: 'الإمارات' },
    { name: 'عمّان', lat: 31.9454, lon: 35.9284, city: 'عمّان', country: 'الأردن' },
    { name: 'الخرطوم', lat: 15.5007, lon: 32.5599, city: 'الخرطوم', country: 'السودان' },
  ]) {
    it(`${spot.name} → ${spot.city}، ${spot.country}`, () => {
      const found = nearestArabCity(spot.lat, spot.lon);
      expect(found.city).toBe(spot.city);
      expect(found.country).toBe(spot.country);
      expect(found.distanceKm).toBeLessThan(15);
    });
  }

  it('كل الأسماء عربية خالصة بلا حروف لاتينية', () => {
    for (const city of ARAB_CITIES) {
      expect(city.ar, `city ${city.en} must be Arabic`).toMatch(/[\u0600-\u06FF]/);
      expect(city.ar).not.toMatch(/[A-Za-z]/);
      expect(city.country).toMatch(/[\u0600-\u06FF]/);
    }
  });

  it('لا يعيد null لإحداثيات صالحة حتى في البحر', () => {
    const found = nearestArabCity(0, 0);
    expect(found).not.toBeNull();
    expect(found.city).toMatch(/[\u0600-\u06FF]/);
  });

  it('يرفض الإحداثيات غير الصالحة بدل التخمين', () => {
    expect(nearestArabCity(NaN, 31)).toBeNull();
    expect(nearestArabCity(30, undefined)).toBeNull();
  });

  it('haversine تعطي مسافات واقعية', () => {
    const d = haversineKm({ lat: 30.0444, lon: 31.2357 }, { lat: 31.2001, lon: 29.9187 });
    expect(d).toBeGreaterThan(160);
    expect(d).toBeLessThan(200);
  });
});

describe('جدول المواقيت — التوقيت العربي والشارات', () => {
  const schedule = {
    timeZone: 'Africa/Cairo',
    events: [
      { id: 'd|fajr', key: 'fajr', name: 'الفجر', date: '2026-11-01', at: Date.UTC(2026, 10, 1, 2, 40) },
      { id: 'd|sunrise', key: 'sunrise', name: 'الشروق', date: '2026-11-01', at: Date.UTC(2026, 10, 1, 4, 8) },
      { id: 'd|dhuhr', key: 'dhuhr', name: 'الظهر', date: '2026-11-01', at: Date.UTC(2026, 10, 1, 9, 39) },
      { id: 'd|asr', key: 'asr', name: 'العصر', date: '2026-11-01', at: Date.UTC(2026, 10, 1, 12, 46) },
      { id: 'd|maghrib', key: 'maghrib', name: 'المغرب', date: '2026-11-01', at: Date.UTC(2026, 10, 1, 15, 9) },
      { id: 'd|isha', key: 'isha', name: 'العشاء', date: '2026-11-01', at: Date.UTC(2026, 10, 1, 16, 28) },
    ],
  };
  /* 12:30 بتوقيت القاهرة = 10:30 UTC → بين الظهر والعصر. */
  const now = Date.UTC(2026, 10, 1, 10, 30);

  it('يعرض الصلوات الست كاملة', () => {
    const rows = buildRows(schedule, now);
    expect(rows.map(r => r.key)).toEqual(['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha']);
  });

  it('يمنح «الآن» للظهر و«التالية» للعصر و«تمت» لما مضى', () => {
    const rows = buildRows(schedule, now);
    const byKey = Object.fromEntries(rows.map(r => [r.key, r.status]));
    expect(byKey.dhuhr).toBe('current');
    expect(byKey.asr).toBe('next');
    expect(byKey.fajr).toBe('done');
    expect(byKey.maghrib).toBe('waiting');
    expect(byKey.isha).toBe('waiting');
  });

  it('الشروق لا يحمل شارة صلاة أبدًا', () => {
    const rows = buildRows(schedule, now);
    const sunrise = rows.find(r => r.key === 'sunrise');
    expect(sunrise.status).not.toBe('current');
    expect(sunrise.status).not.toBe('next');
  });

  it('الأوقات بأرقام عربية وصيغة ص/م', () => {
    const time = arabicClock(Date.UTC(2026, 10, 1, 2, 40), 'Africa/Cairo');
    expect(time).toMatch(/[\u0660-\u0669]/); // أرقام عربية هندية
    expect(time).not.toMatch(/[0-9]/);       // لا أرقام لاتينية
    expect(time).toMatch(/[صم]/);
  });
});
