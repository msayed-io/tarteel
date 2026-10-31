import { describe, it, expect, vi } from 'vitest';
import {
  ensureLocationPermission, readDevicePosition, timeZoneForCoordinates,
  describePlace, resolveLocation, locationNeedsRefresh, haversineKm,
  describeLocationError, LocationError, ACCURACY_TARGET_M,
} from '../src/engine/location.js';

/**
 * يزرع navigator.geolocation مؤقتًا لمحاكاة WebView2.
 * بيئة الاختبار (node) لا توفّر navigator، فننشئه عند الحاجة.
 */
function withGeo(impl, run) {
  if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  }
  const had = Object.prototype.hasOwnProperty.call(globalThis.navigator, 'geolocation');
  const original = globalThis.navigator.geolocation;
  Object.defineProperty(globalThis.navigator, 'geolocation', { value: impl, configurable: true, writable: true });
  return Promise.resolve(run()).finally(() => {
    if (had) Object.defineProperty(globalThis.navigator, 'geolocation', { value: original, configurable: true, writable: true });
    else delete globalThis.navigator.geolocation;
  });
}

describe('إذن الموقع — عبر WebView2 لا عبر إضافة', () => {
  /* WebView2 يعرض نافذة إذن ويندوز تلقائيًا عند أول قراءة، ويسجّل التطبيق
     في «الخصوصية والأمان ← الموقع». لا وجود لدوال إذن منفصلة. */
  it('يعتبر الإذن متاحًا إذا كانت الواجهة موجودة', async () => {
    await withGeo({ getCurrentPosition() {} }, async () => {
      expect(await ensureLocationPermission()).toBe('granted');
    });
  });

  it('يرفض بوضوح إن لم تكن الواجهة موجودة', async () => {
    await withGeo(undefined, async () => {
      await expect(ensureLocationPermission()).rejects.toMatchObject({ code: 'unsupported' });
    });
  });
});

describe('قراءة الموقع — الدقة والتصعيد', () => {
  const geo = (handler) => ({ getCurrentPosition: handler });

  it('يطلب دقة عالية أولًا ويحوّل الإحداثيات', async () => {
    let seen;
    await withGeo(geo((ok, fail, options) => {
      seen = options;
      ok({ coords: { latitude: 30.5877, longitude: 31.502, accuracy: 65 }, timestamp: 123 });
    }), async () => {
      const fix = await readDevicePosition();
      expect(seen.enableHighAccuracy).toBe(true);
      expect(seen.maximumAge).toBe(0);
      expect(fix).toMatchObject({ latitude: 30.5877, longitude: 31.502, accuracy: 65, source: 'device' });
    });
  });

  it('يُصعّد إلى دقة عادية إذا انتهت المهلة في المحاولة العالية', async () => {
    let attempts = 0;
    await withGeo(geo((ok, fail, options) => {
      attempts += 1;
      if (attempts === 1) fail({ code: 3, message: 'timeout' });
      else ok({ coords: { latitude: 30.5, longitude: 31.5, accuracy: 2000 } });
    }), async () => {
      const fix = await readDevicePosition();
      expect(attempts).toBe(2);
      expect(fix.accuracy).toBe(2000);
    });
  });

  it('لا يعيد المحاولة بعد رفض المستخدم', async () => {
    let attempts = 0;
    await withGeo(geo((ok, fail) => { attempts += 1; fail({ code: 1, message: 'denied' }); }), async () => {
      await expect(readDevicePosition()).rejects.toMatchObject({ code: 'permission-denied' });
      expect(attempts).toBe(1);
    });
  });

  it('يرفض إحداثيات خارج النطاق بدل تمريرها', async () => {
    await withGeo(geo(ok => ok({ coords: { latitude: 190, longitude: 31 } })), async () => {
      await expect(readDevicePosition()).rejects.toMatchObject({ code: 'invalid-coordinates' });
    });
  });

  it('يفسّر أكواد W3C الثلاثة بدقة: رفض / لا مزوّد / مهلة', async () => {
    await withGeo(geo((ok, fail) => fail({ code: 2 })), async () => {
      await expect(readDevicePosition()).rejects.toMatchObject({ code: 'no-provider' });
    });
    await withGeo(geo((ok, fail) => fail({ code: 3 })), async () => {
      await expect(readDevicePosition()).rejects.toMatchObject({ code: 'timeout' });
    });
    await withGeo(geo((ok, fail) => fail({ code: 99 })), async () => {
      await expect(readDevicePosition()).rejects.toMatchObject({ code: 'position-failed' });
    });
  });
});

describe('المنطقة الزمنية IANA — لا فوارق ثابتة', () => {
  for (const spot of [
    { name: 'الزقازيق', lat: 30.5877, lon: 31.502, zone: 'Africa/Cairo' },
    { name: 'الإسكندرية', lat: 31.2001, lon: 29.9187, zone: 'Africa/Cairo' },
    { name: 'أسوان', lat: 24.0889, lon: 32.8998, zone: 'Africa/Cairo' },
    { name: 'مكة المكرمة', lat: 21.4225, lon: 39.8262, zone: 'Asia/Riyadh' },
    { name: 'الرياض', lat: 24.7136, lon: 46.6753, zone: 'Asia/Riyadh' },
    { name: 'لندن', lat: 51.5074, lon: -0.1278, zone: 'Europe/London' },
    { name: 'كراتشي', lat: 24.8607, lon: 67.0011, zone: 'Asia/Karachi' },
  ]) {
    it(`${spot.name} → ${spot.zone}`, () => {
      expect(timeZoneForCoordinates(spot.lat, spot.lon)).toBe(spot.zone);
    });
  }

  it('لا يُعيد مطلقًا صيغة فارق ثابت مثل GMT+2', () => {
    const zone = timeZoneForCoordinates(30.0444, 31.2357);
    expect(zone).toMatch(/^[A-Za-z]+\/[A-Za-z_]+/);
    expect(zone).not.toMatch(/^(GMT|UTC)[+-]/);
  });

  it('يحترم التوقيت الصيفي في المنطقة الناتجة', () => {
    const zone = timeZoneForCoordinates(51.5074, -0.1278);
    const july = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(new Date(Date.UTC(2026, 6, 1))).find(p => p.type === 'timeZoneName').value;
    const january = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(new Date(Date.UTC(2026, 0, 1))).find(p => p.type === 'timeZoneName').value;
    expect(july).not.toBe(january);
  });

  it('تقع إلى منطقة الجهاز عند إحداثيات في البحر بلا منطقة محددة', () => {
    expect(timeZoneForCoordinates(0, 0)).toBeTruthy();
  });
});

describe('وصف المكان — تحسين عرض لا شرط نجاح', () => {
  it('يعيد المدينة والدولة ورمزها', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ city: 'الزقازيق', principalSubdivision: 'الشرقية', countryName: 'مصر', countryCode: 'EG' }),
    }));
    const place = await describePlace(30.5877, 31.502, fetchImpl);
    expect(place).toMatchObject({ city: 'الزقازيق', country: 'مصر', countryCode: 'EG' });
  });

  it('لا يُسقط الموقع عند فشل الشبكة', async () => {
    const place = await describePlace(30.5877, 31.502, async () => { throw new Error('offline'); });
    expect(place).toBeNull();
  });
});

describe('الواجهة الموحّدة resolveLocation', () => {
  it('تجمع الإحداثيات والمنطقة الزمنية والدولة في نتيجة واحدة', async () => {
    await withGeo({ getCurrentPosition: ok => ok({ coords: { latitude: 30.5877, longitude: 31.502, accuracy: 45 }, timestamp: Date.now() }) }, async () => {
      const result = await resolveLocation({
        fetchImpl: async () => ({ ok: true, json: async () => ({ city: 'الزقازيق', countryName: 'مصر', countryCode: 'EG' }) }),
      });
      expect(result).toMatchObject({
        source: 'device', latitude: 30.5877, longitude: 31.502,
        timeZone: 'Africa/Cairo', countryCode: 'EG', city: 'الزقازيق', precise: true,
      });
    });
  });

  it('دقة 45 مترًا تُعدّ دقيقة، و3000 متر لا', async () => {
    await withGeo({ getCurrentPosition: ok => ok({ coords: { latitude: 30.5, longitude: 31.5, accuracy: 45 } }) }, async () => {
      expect((await resolveLocation()).precise).toBe(true);
    });
    await withGeo({ getCurrentPosition: ok => ok({ coords: { latitude: 30.5, longitude: 31.5, accuracy: 3000 } }) }, async () => {
      expect((await resolveLocation()).precise).toBe(false);
    });
    expect(ACCURACY_TARGET_M).toBe(1500);
  });

  it('ترفض الرفض برمز واضح ولا تخمّن موقعًا', async () => {
    await withGeo({ getCurrentPosition: (ok, fail) => fail({ code: 1 }) }, async () => {
      await expect(resolveLocation()).rejects.toMatchObject({ code: 'permission-denied' });
    });
  });
});

describe('تحديث الموقع — متى نعيد الحساب', () => {
  const base = { latitude: 30.5877, longitude: 31.502, timeZone: 'Africa/Cairo', resolvedAt: 1000 };

  it('يعيد الحساب عند أول مرة', () => {
    expect(locationNeedsRefresh(null, base)).toBe(true);
  });

  it('لا يعيد الحساب لحركة أقل من نصف كيلومتر', () => {
    expect(locationNeedsRefresh(base, { ...base, latitude: 30.5890 }, 2000)).toBe(false);
  });

  it('يعيد الحساب لحركة تتجاوز نصف كيلومتر', () => {
    expect(locationNeedsRefresh(base, { ...base, latitude: 30.62 }, 2000)).toBe(true);
  });

  it('يعيد الحساب فورًا عند تغيّر المنطقة الزمنية', () => {
    expect(locationNeedsRefresh(base, { ...base, timeZone: 'Asia/Riyadh' }, 2000)).toBe(true);
  });

  it('يعيد الحساب بعد ثلاثين دقيقة حتى بدون حركة', () => {
    expect(locationNeedsRefresh(base, base, 1000 + 31 * 60 * 1000)).toBe(true);
  });

  it('haversineKm تعطي مسافات معقولة', () => {
    const cairo = { latitude: 30.0444, longitude: 31.2357 };
    const alex = { latitude: 31.2001, longitude: 29.9187 };
    expect(haversineKm(cairo, alex)).toBeGreaterThan(160);
    expect(haversineKm(cairo, alex)).toBeLessThan(200);
  });
});

describe('رسائل الخطأ — إرشاد عملي لا اعتذار', () => {
  it('لكل رمز رسالة تحتوي خطوة إصلاح ملموسة', () => {
    for (const code of ['permission-denied', 'no-provider', 'position-failed', 'unsupported']) {
      const message = describeLocationError(new LocationError(code, 'x'));
      expect(message.length).toBeGreaterThan(20);
    }
    expect(describeLocationError(new LocationError('no-provider', 'x'))).toContain('Wi-Fi');
    expect(describeLocationError(new LocationError('permission-denied', 'x'))).toContain('الإعدادات');
  });
});
