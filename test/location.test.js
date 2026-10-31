import { describe, it, expect, vi } from 'vitest';
import {
  ensureLocationPermission, readDevicePosition, timeZoneForCoordinates,
  describePlace, resolveLocation, locationNeedsRefresh, haversineKm,
  describeLocationError, LocationError, ACCURACY_TARGET_M,
} from '../src/engine/location.js';

describe('إذن الموقع — الطلب الصحيح من ويندوز', () => {
  it('يعيد granted مباشرة إذا كان الإذن ممنوحًا دون إزعاج المستخدم', async () => {
    const requestPermissions = vi.fn();
    const state = await ensureLocationPermission({
      checkPermissions: async () => ({ location: 'granted' }), requestPermissions,
    });
    expect(state).toBe('granted');
    expect(requestPermissions).not.toHaveBeenCalled();
  });

  it('يطلب الإذن فعليًا عندما تكون الحالة prompt وليس بلا نهاية', async () => {
    const requestPermissions = vi.fn(async () => ({ location: 'granted' }));
    const state = await ensureLocationPermission({
      checkPermissions: async () => ({ location: 'prompt' }), requestPermissions,
    });
    expect(state).toBe('granted');
    expect(requestPermissions).toHaveBeenCalledWith(['location']);
  });

  it('يطلب الإذن أيضًا في حالة prompt-with-rationale', async () => {
    const requestPermissions = vi.fn(async () => ({ location: 'granted' }));
    await ensureLocationPermission({
      checkPermissions: async () => ({ location: 'prompt-with-rationale' }), requestPermissions,
    });
    expect(requestPermissions).toHaveBeenCalled();
  });

  it('لا يطلب مرة أخرى عندما يكون الإذن مرفوضًا، ويعيد denied', async () => {
    const requestPermissions = vi.fn();
    const state = await ensureLocationPermission({
      checkPermissions: async () => ({ location: 'denied' }), requestPermissions,
    });
    expect(state).toBe('denied');
    expect(requestPermissions).not.toHaveBeenCalled();
  });

  it('يميّز فشل طلب الإذن عن الرفض برمز خاص', async () => {
    await expect(ensureLocationPermission({
      checkPermissions: async () => ({ location: 'prompt' }),
      requestPermissions: async () => { throw new Error('plugin unavailable'); },
    })).rejects.toMatchObject({ code: 'permission-request-failed' });
  });
});

describe('قراءة الموقع — الدقة والتصعيد', () => {
  it('يطلب دقة عالية ويحوّل الإحداثيات والأخطاء', async () => {
    const getCurrentPosition = vi.fn(async options => {
      expect(options.enableHighAccuracy).toBe(true);
      expect(options.maximumAge).toBe(0);
      expect(options.timeout).toBeGreaterThan(10000);
      return { coords: { latitude: 30.5877, longitude: 31.502, accuracy: 65 }, timestamp: 123 };
    });
    const fix = await readDevicePosition({ getCurrentPosition });
    expect(fix).toMatchObject({ latitude: 30.5877, longitude: 31.502, accuracy: 65, source: 'device', timestamp: 123 });
  });

  it('يرفض إحداثيات خارج النطاق بدل تمريرها', async () => {
    await expect(readDevicePosition({
      getCurrentPosition: async () => ({ coords: { latitude: 190, longitude: 31 } }),
    })).rejects.toMatchObject({ code: 'invalid-coordinates' });
  });

  it('يفسّر فشل ويندوز بسبب دقيق: لا مزوّد / رفض / عام', async () => {
    await expect(readDevicePosition({
      getCurrentPosition: async () => { throw new Error('Position unavailable'); },
    })).rejects.toMatchObject({ code: 'no-provider' });

    await expect(readDevicePosition({
      getCurrentPosition: async () => { throw new Error('Permission denied'); },
    })).rejects.toMatchObject({ code: 'permission-denied-by-system' });

    await expect(readDevicePosition({
      getCurrentPosition: async () => { throw new Error('weird failure'); },
    })).rejects.toMatchObject({ code: 'position-failed' });
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
  const apiFor = (permission, position) => ({
    checkPermissions: async () => ({ location: permission }),
    requestPermissions: async () => ({ location: permission }),
    getCurrentPosition: async () => ({ coords: position, timestamp: Date.now() }),
  });

  it('تجمع الإحداثيات والمنطقة الزمنية والدولة في نتيجة واحدة', async () => {
    const result = await resolveLocation(
      apiFor('granted', { latitude: 30.5877, longitude: 31.502, accuracy: 45 }),
      { fetchImpl: async () => ({ ok: true, json: async () => ({ city: 'الزقازيق', countryName: 'مصر', countryCode: 'EG' }) }) },
    );
    expect(result).toMatchObject({
      source: 'device', latitude: 30.5877, longitude: 31.502,
      timeZone: 'Africa/Cairo', countryCode: 'EG', city: 'الزقازيق', precise: true,
    });
  });

  it('تمدّد الدقة: دقة 45 مترًا تُعدّ دقيقة، و3000 متر لا', async () => {
    const near = await resolveLocation(apiFor('granted', { latitude: 30.5, longitude: 31.5, accuracy: 45 }));
    expect(near.precise).toBe(true);
    const far = await resolveLocation(apiFor('granted', { latitude: 30.5, longitude: 31.5, accuracy: 3000 }));
    expect(far.precise).toBe(false);
    expect(ACCURACY_TARGET_M).toBe(1500);
  });

  it('ترفض الإذن المرفوض برمز واضح ولا تخمّن موقعًا', async () => {
    await expect(resolveLocation(apiFor('denied', { latitude: 0, longitude: 0 })))
      .rejects.toMatchObject({ code: 'permission-denied' });
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
