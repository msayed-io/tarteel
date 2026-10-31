import { describe, it, expect } from 'vitest';
import {
  computeDay, buildTimeline, civilDateAnchorUtc, civilDateAt, addDays,
  solarPosition, julianDay, methodForCountry, shadowFactorForCountry, nextPrayer, currentPrayer, methodForTimeZone,
} from '../src/engine/astro.js';

const D = Math.PI / 180;

/** يحوّل لحظة مطلقة إلى ثواني اليوم المحلي في منطقة IANA. */
function localSeconds(epochMs, timeZone) {
  const t = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(epochMs));
  const [h, m, s] = t.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

/** خطأ محسوب مقابل وقت مرجعي بصيغة HH:MM. */
function deltaSeconds(epochMs, timeZone, reference) {
  const [h, m] = reference.split(':').map(Number);
  return localSeconds(epochMs, timeZone) - (h * 3600 + m * 60);
}

describe('الموضع الشمسي — الدقة الفلكية', () => {
  it('يطابق القيم المرجعية للانحراف ومعادلة الزمن عند 2026-10-31', () => {
    const jd = julianDay(Date.UTC(2026, 9, 31, 12, 0, 0));
    const { declination, equationOfTime } = solarPosition(jd);
    expect(declination).toBeCloseTo(-14.20, 1);
    expect(equationOfTime).toBeCloseTo(16.4, 0);
  });

  it('يعطي معادلة زمن موجبة في نوفمبر وسالبة في فبراير (اتجاه الإشارة)', () => {
    const november = solarPosition(julianDay(Date.UTC(2026, 10, 3, 12)));
    const february = solarPosition(julianDay(Date.UTC(2026, 1, 11, 12)));
    expect(november.equationOfTime).toBeGreaterThan(15);
    expect(february.equationOfTime).toBeLessThan(-13);
  });
});

describe('مواقيت اليوم — مطابقة المرجع', () => {
  /* المرجع: AlAdhan، نفس اليوم والإحداثيات والطريقة. سماحية دقيقتين لأن
     المرجع يقرّب للدقيقة وله اختلافات صغيرة في نموذج الغلاف الجوي. */
  it('القاهرة — الهيئة المصرية: كل المواقيت داخل دقيقتين من المرجع', () => {
    const day = computeDay({
      latitude: 30.0444, longitude: 31.2357, timeZone: 'Africa/Cairo',
      countryCode: 'EG', year: 2026, month: 10, day: 31,
    });
    expect(day.method).toBe('egyptian');
    expect(day.invalid).toEqual([]);
    const ref = { fajr: '04:40', sunrise: '06:08', dhuhr: '11:39', asr: '14:46', maghrib: '17:09', isha: '18:28' };
    for (const [key, value] of Object.entries(ref)) {
      expect(Math.abs(deltaSeconds(day.instants[key], 'Africa/Cairo', value))).toBeLessThan(120);
    }
  });

  it('لندن — رابطة العالم الإسلامي: الفجر والظهر والمغرب والعشاء داخل دقيقتين', () => {
    const day = computeDay({
      latitude: 51.5074, longitude: -0.1278, timeZone: 'Europe/London',
      countryCode: 'GB', year: 2026, month: 10, day: 31,
    });
    expect(day.method).toBe('muslim_world_league');
    expect(day.invalid).toEqual([]);
    for (const [key, value] of Object.entries({ fajr: '04:59', sunrise: '06:52', dhuhr: '11:44', maghrib: '16:35', isha: '18:22' })) {
      expect(Math.abs(deltaSeconds(day.instants[key], 'Europe/London', value))).toBeLessThan(120);
    }
  });

  it('مكة — أم القرى: العشاء = المغرب + 90 دقيقة بالضبط لا بزاوية', () => {
    const day = computeDay({
      latitude: 21.4225, longitude: 39.8262, timeZone: 'Asia/Riyadh',
      countryCode: 'SA', year: 2026, month: 10, day: 31,
    });
    expect(day.method).toBe('umm_al_qura');
    expect(day.instants.isha - day.instants.maghrib).toBe(90 * 60000);
  });
});

describe('العصر — مطابقة هندسية داخلية لا تعتمد على أي مرجع خارجي', () => {
  /* معيار العصر: طول ظل الجسم = معامل الظل + tan|خط العرض − الانحراف|.
     نتحقق أن الشمس عند اللحظة المحسوبة تحقق المعادلة بدقة 1e-6. */
  for (const spot of [
    { name: 'لندن', lat: 51.5074, lon: -0.1278, tz: 'Europe/London', cc: 'GB', factor: 1 },
    { name: 'القاهرة', lat: 30.0444, lon: 31.2357, tz: 'Africa/Cairo', cc: 'EG', factor: 1 },
    { name: 'سيدني', lat: -33.8688, lon: 151.2093, tz: 'Australia/Sydney', cc: 'AU', factor: 1 },
    { name: 'كراتشي', lat: 24.8607, lon: 67.0011, tz: 'Asia/Karachi', cc: 'PK', factor: 2 },
  ]) {
    it(`${spot.name}: الظل عند لحظة العصر يطابق المعادلة`, () => {
      const day = computeDay({
        latitude: spot.lat, longitude: spot.lon, timeZone: spot.tz,
        countryCode: spot.cc, year: 2026, month: 10, day: 31,
      });
      expect(day.shadowFactor).toBe(spot.factor);
      const asr = day.instants.asr;
      const { declination, equationOfTime } = solarPosition(julianDay(asr));
      const utcHours = (asr / 3600000) % 24;
      const hourAngle = (utcHours * 60 + equationOfTime + spot.lon * 4) / 4 - 180;
      const sinAltitude = Math.sin(spot.lat * D) * Math.sin(declination * D)
        + Math.cos(spot.lat * D) * Math.cos(declination * D) * Math.cos(hourAngle * D);
      const actualShadow = 1 / Math.tan(Math.asin(sinAltitude));
      const requiredShadow = spot.factor + Math.tan(Math.abs(spot.lat - declination) * D);
      expect(Math.abs(actualShadow - requiredShadow)).toBeLessThan(1e-6);
    });
  }
});

describe('الاختيار التلقائي للطريقة والمذهب', () => {
  it('يختار الطريقة من رمز الدولة دون سؤال المستخدم', () => {
    expect(methodForCountry('EG').id).toBe('egyptian');
    expect(methodForCountry('SA').id).toBe('umm_al_qura');
    expect(methodForCountry('pk').id).toBe('karachi');
    expect(methodForCountry('AE').id).toBe('muslim_world_league');
    expect(methodForCountry('ZZ').id).toBe('muslim_world_league');
    expect(methodForCountry(null).id).toBe('muslim_world_league');
  });

  it('يختار معامل ظل العصر من رمز الدولة', () => {
    expect(shadowFactorForCountry('PK')).toBe(2);
    expect(shadowFactorForCountry('EG')).toBe(1);
    expect(shadowFactorForCountry('SA')).toBe(1);
  });

  it('يطبّق إزاحات أم القرى المعتمدة تلقائيًا', () => {
    const day = computeDay({
      latitude: 21.4225, longitude: 39.8262, timeZone: 'Asia/Riyadh',
      countryCode: 'SA', year: 2026, month: 10, day: 31,
    });
    expect(day.adjust.fajr).toBe(-1);
    expect(day.adjust.dhuhr).toBe(2);
  });
});

describe('الضبط اليدوي بالدقائق', () => {
  it('يقتصر على −5..+5 ويُطبَّق على اللحظة الفعلية', () => {
    const base = computeDay({
      latitude: 30.0444, longitude: 31.2357, timeZone: 'Africa/Cairo',
      countryCode: 'EG', year: 2026, month: 10, day: 31, adjust: {},
    });
    const shifted = computeDay({
      latitude: 30.0444, longitude: 31.2357, timeZone: 'Africa/Cairo',
      countryCode: 'EG', year: 2026, month: 10, day: 31, adjust: { maghrib: 5 },
    });
    expect(shifted.instants.maghrib - base.instants.maghrib).toBe(5 * 60000);
    const clamped = computeDay({
      latitude: 30.0444, longitude: 31.2357, timeZone: 'Africa/Cairo',
      countryCode: 'EG', year: 2026, month: 10, day: 31, adjust: { maghrib: 99 },
    });
    expect(clamped.adjust.maghrib).toBe(5);
  });
});

describe('المسار الزمني المتصل — لا خطأ 28 ساعة', () => {
  const spot = { latitude: 30.5877, longitude: 31.5020, timeZone: 'Africa/Cairo', countryCode: 'EG' };

  it('ينتج أحداثًا مرتبة تصاعديًا بلا تكرار معرّفات', () => {
    const events = buildTimeline({ ...spot, from: Date.UTC(2026, 9, 31, 20, 0, 0), daysAhead: 2 });
    const ids = events.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < events.length; i++) expect(events[i].at).toBeGreaterThan(events[i - 1].at);
  });

  it('العشاء ثم فجر الغد داخل النافذة بفرق منطقي لا 28 ساعة', () => {
    const events = buildTimeline({ ...spot, from: Date.UTC(2026, 9, 31, 12), daysAhead: 2 });
    const isha = events.find(e => e.date === '2026-10-31' && e.key === 'isha');
    const nextFajr = events.find(e => e.date === '2026-11-01' && e.key === 'fajr');
    const gapHours = (nextFajr.at - isha.at) / 3600000;
    /* ليل القاهرة في أكتوبر ≈ 10 ساعات؛ الخطأ 28 ساعة سيظهر كقيمة ≈ 4 أو ≈ 38. */
    expect(gapHours).toBeGreaterThan(6);
    expect(gapHours).toBeLessThan(14);
  });

  it('الصلاة التالية والحالية صحيحتان عبر منتصف الليل', () => {
    const events = buildTimeline({ ...spot, from: Date.UTC(2026, 9, 31, 12), daysAhead: 2 });
    const lateNight = Date.UTC(2026, 9, 31, 22, 0, 0); // 00:00 بتوقيت القاهرة
    const next = nextPrayer(events, lateNight);
    expect(next.key).toBe('fajr');
    expect(civilDateAt(next.at, spot.timeZone).day).toBe(1);
    const current = currentPrayer(events, lateNight);
    expect(current.key).toBe('isha');
  });
});

describe('التوقيت الصيفي والشتوي — تلقائي عبر IANA', () => {
  it('يحوّل التاريخ المدني إلى لحظة صحيحة في الجانبين', () => {
    /* مصر: 2026 تعيد التوقيت الصيفي في أبريل وتلغيه في أكتوبر. */
    const summer = civilDateAnchorUtc(2026, 7, 1, 'Africa/Cairo');
    const winter = civilDateAnchorUtc(2026, 1, 1, 'Africa/Cairo');
    expect(localSeconds(summer, 'Africa/Cairo')).toBeCloseTo(0, -2);
    expect(localSeconds(winter, 'Africa/Cairo')).toBeCloseTo(0, -2);
    /* مصر تعيد التوقيت الصيفي (UTC+3) في أبريل وتلغيه (UTC+2) في أكتوبر.
       لذلك يجب أن يظهر فرق ساعة كاملة بين منتصف ليل الصيف ومنتصف ليل الشتاء
       بعدد أيام صحيح — وهذا دليل أن المرساة تحترم الإزاحة الفعلية لا ثابتًا. */
    const days = (winter - summer) / 86400000;
    const wholeDays = Math.round(days);
    const extraHours = (days - wholeDays) * 24;
    expect(Math.abs(extraHours)).toBeCloseTo(1, 1);
  });

  it('مواقيت يوم تغيير التوقيت الصيفي تبقى متسلسلة', () => {
    for (const [y, m, d] of [[2026, 3, 29], [2026, 10, 25], [2026, 4, 24], [2026, 10, 29]]) {
      const day = computeDay({
        latitude: 51.5074, longitude: -0.1278, timeZone: 'Europe/London',
        countryCode: 'GB', year: y, month: m, day: d,
      });
      expect(day.invalid).toEqual([]);
    }
  });
});

describe('العروض العالية وحدود الإدخال', () => {
  it('يرفض إحداثيات غير صالحة بدل أن يخمّن', () => {
    expect(() => computeDay({ latitude: 91, longitude: 0, timeZone: 'UTC' })).toThrow();
    expect(() => computeDay({ latitude: 0, longitude: 181, timeZone: 'UTC' })).toThrow();
    expect(() => computeDay({ latitude: 0, longitude: 0, timeZone: '' })).toThrow();
  });

  it('يستخدم قاعدة تقسيم الليل في العروض العالية بدل إسقاط الصلاة', () => {
    const tromso = computeDay({
      latitude: 69.6492, longitude: 18.9553, timeZone: 'Europe/Oslo',
      countryCode: 'NO', year: 2026, month: 6, day: 21,
    });
    expect(tromso.highLatitude).toBe(true);
    expect(Number.isFinite(tromso.instants.fajr)).toBe(true);
    expect(Number.isFinite(tromso.instants.isha)).toBe(true);
  });

  it('addDays يعبر حدود الشهر والسنة', () => {
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(addDays({ year: 2026, month: 3, day: 1 }, -1)).toEqual({ year: 2026, month: 2, day: 28 });
  });
});


describe('اللحظات المطلقة أعداد صحيحة — منع فشل IPC', () => {
  /* عطل حقيقي: قيمة مثل 179332850336.03 أُرسلت إلى Rust التي تتوقع i64،
     ففشل فك الترميز وسقطت الجدولة كلها. المصدر: تحويل JD يعطي كسورًا. */
  it('كل مواقيت اليوم أعداد صحيحة', () => {
    const day = computeDay({
      latitude: 30.7717, longitude: 31.8982, timeZone: 'Africa/Cairo',
      countryCode: 'EG', year: 2026, month: 11, day: 1,
    });
    for (const [key, value] of Object.entries(day.instants)) {
      expect(Number.isInteger(value), `${key} must be an integer, got ${value}`).toBe(true);
    }
  });

  it('كل أحداث المسار أعداد صحيحة وصالحة كـ i64', () => {
    const events = buildTimeline({
      latitude: 30.7717, longitude: 31.8982, timeZone: 'Africa/Cairo',
      countryCode: 'EG', from: Date.UTC(2026, 9, 31, 12), daysAhead: 3,
    });
    for (const event of events) {
      expect(Number.isInteger(event.at)).toBe(true);
      expect(Number.isSafeInteger(event.at)).toBe(true);
      expect(event.at).toBeGreaterThan(1_600_000_000_000);
      expect(event.at).toBeLessThan(4_100_000_000_000);
    }
  });
});

describe('اشتقاق الدولة من المنطقة الزمنية', () => {
  /* عطل حقيقي: موقع في مصر حُسب برابطة العالم الإسلامي لأن رمز الدولة
     كان فارغًا بعد فشل جلب اسم المكان. */
  it('مصر تُعطي الهيئة المصرية لا الافتراضي العالمي', () => {
    const { method, defaultCountryCode } = methodForTimeZone('Africa/Cairo');
    expect(defaultCountryCode).toBe('EG');
    expect(method.id).toBe('egyptian');
    expect(method.fajrAngle).toBe(19.5);
    expect(method.ishaAngle).toBe(17.5);
  });

  it('السعودية تُعطي أم القرى والخليج يُعطي رابطة العالم الإسلامي', () => {
    expect(methodForTimeZone('Asia/Riyadh').method.id).toBe('umm_al_qura');
    expect(methodForTimeZone('Asia/Dubai').method.id).toBe('muslim_world_league');
    expect(methodForTimeZone('America/New_York').method.id).toBe('isna');
    expect(methodForTimeZone('Asia/Karachi').method.id).toBe('karachi');
  });

  it('منطقة زمنية مجهولة تسقط إلى الافتراضي بلا انهيار', () => {
    expect(methodForTimeZone('Antarctica/Troll').method.id).toBe('muslim_world_league');
    expect(methodForTimeZone(undefined).method.id).toBe('muslim_world_league');
  });
});
