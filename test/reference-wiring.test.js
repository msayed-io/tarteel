import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const source = path => readFileSync(resolve(root, path), 'utf8');

describe('ربط منظومة الموقع المرجعية', () => {
  it('resolveLocation يستدعي autoDetectLocation حصرًا', () => {
    const src = source('src/engine/location.js');
    expect(src).toContain('await autoDetectLocation()');
    /* لا التفاف على الدوال الفرعية */
    expect(src).not.toContain('await enrichCoordinatesToLocation(');
    expect(src).not.toContain('await readDevicePosition()');
  });

  it('الاستيراد من gps-location.ts المرجعي', () => {
    const src = source('src/engine/location.js');
    expect(src).toMatch(/from '\.\.\/lib\/gps-location\.ts'/);
    expect(src).toContain('autoDetectLocation,');
  });

  it('autoDetectLocation تشغّل الطبقة عالية الدقة بالمعاملات المرجعية', () => {
    const src = source('src/lib/gps-location.ts');
    const at = src.indexOf('export async function autoDetectLocation');
    const body = src.slice(at, at + 2000);
    expect(body).toContain('enableHighAccuracy: true');
    expect(body).toContain('timeout: 10000');
    expect(body).toContain('maximumAge: 0');
    expect(body).toContain('enrichCoordinatesToLocation');
  });
});

describe('ربط الحساب الفلكي', () => {
  it('schedule يستدعي getPrayerTimeline بالكائن المرجعي', () => {
    const src = source('src/engine/schedule.js');
    expect(src).toContain('getPrayerTimeline');
    expect(src).toContain('toPrayerLocation');
    /* تمرير الموقع كاملًا لا حقلين مبعثرين */
    expect(src).toContain('getPrayerTimeline(toPrayerLocation(');
  });

  it('getPrayerTimeline تتلقى PrayerLocation كاملًا', () => {
    const src = source('src/engine/schedule.js');
    const at = src.indexOf('export function toPrayerLocation');
    const body = src.slice(at, at + 900);
    for (const field of ['latitude', 'longitude', 'cityName', 'cityNameAr', 'timezoneId']) {
      expect(body, field).toContain(field);
    }
    /* تقريب إلى ٦ أرقام عشرية كما في المرجع */
    expect(body).toContain('toFixed(6)');
  });
});

describe('عرض اسم المكان الكامل بلا اقتصاص', () => {
  it('الآيلاند تمرر الاسم عبر طبقة العرض العربية', () => {
    const src = source('src/main.jsx');
    expect(src).toContain('displayPlaceName');
    expect(src).toContain("from './engine/display.js'");
    /* لا اقتصاص للنص في عنوان البطاقة */
    expect(src).not.toMatch(/locationLabel.*\.slice\(/);
  });

  it('شاشة الإعدادات تعرض الاسم التفصيلي كاملًا', () => {
    const src = source('src/PrayerSettings.jsx');
    expect(src).toContain('displayPlaceWithCountry');
    expect(src).toContain("from './engine/display.js'");
  });

  it('طبقة العرض تفضّل cityNameAr ثم cityName ثم الأوفلاين', () => {
    const src = source('src/engine/display.js');
    expect(src).toContain('location.cityNameAr, location.cityName');
    expect(src).toContain('findNearestArabPlace');
    expect(src).toContain('hasArabic');
  });
});

describe('طبقة العرض العربية', () => {
  it('لا تعيد أي نص لاتيني مهما كان مصدره', async () => {
    const { displayPlaceName } = await import('../src/engine/display.js');
    const latin = {
      latitude: 30.596538, longitude: 32.271504,
      cityName: 'American Dream Ismailia, Qism Than',
      cityNameAr: 'American Dream Ismailia',
      countryNameAr: 'Egypt',
    };
    const shown = displayPlaceName(latin);
    expect(shown).not.toMatch(/[A-Za-z]/);
    expect(shown).toMatch(/[\u0600-\u06FF]/);
    expect(shown).toContain('الإسماعيلية');
  });

  it('يعرض الاسم العربي التفصيلي كما هو دون اقتصاص', async () => {
    const { displayPlaceName } = await import('../src/engine/display.js');
    const arabic = {
      latitude: 30.6, longitude: 32.28,
      cityNameAr: 'ميدان المطافي، الإسماعيلية، الإسماعيلية',
    };
    expect(displayPlaceName(arabic)).toBe('ميدان المطافي، الإسماعيلية، الإسماعيلية');
  });

  it('يضيف الدولة العربية عند الحاجة', async () => {
    const { displayPlaceWithCountry } = await import('../src/engine/display.js');
    const loc = { latitude: 30.0444, longitude: 31.2357, cityNameAr: 'المعادي', countryNameAr: 'مصر' };
    expect(displayPlaceWithCountry(loc)).toBe('المعادي، مصر');
  });
});

describe('حارس العربية لا تخدعه علامات الترقيم', () => {
  it('الفاصلة العربية «،» ليست دليل عروبة', async () => {
    const { displayPlaceName } = await import('../src/engine/display.js');
    /* هذا النص الحقيقي من ArcGIS: لاتيني بالكامل لكن فيه «،».
       الفحص الخام لنطاق U+0600–U+06FF كان يعده عربيًا. */
    const arcgisLatin = {
      latitude: 30.596538, longitude: 32.271504,
      cityNameAr: "American Dream Ismailia، Qism Than al-'Isma'eeliyyah، al-'Isma'eeliyyah",
      cityName: "American Dream Ismailia",
    };
    const shown = displayPlaceName(arcgisLatin);
    expect(shown).not.toMatch(/[A-Za-z]/);
    expect(shown).toContain('الإسماعيلية');
  });
});
