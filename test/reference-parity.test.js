import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSchedule, METHOD_NAMES } from '../src/engine/schedule.js';
import { getDayPrayers } from '../src/lib/prayer-times.ts';


const root = resolve(__dirname, '..');
const reference = name => resolve(root, 'reference/dar-al-hikayat', `${name}.ts`);
const local = name => resolve(root, 'src/lib', `${name}.ts`);

describe('مطابقة المستودع المرجعي', () => {
  /* خمسة ملفات منقولة بايت-ببايت بلا أي تعديل. */
  for (const file of ['gps-location', 'egypt-places', 'prayer-times', 'prayer-config', 'prayer-cities']) {
    it(`${file}.ts منقول حرفيًا بلا تعديل`, () => {
      expect(existsSync(local(file))).toBe(true);
      const a = readFileSync(local(file), 'utf8');
      const b = readFileSync(reference(file), 'utf8');
      expect(a).toBe(b);
    });
  }

  /*
   * reverse-geocoding.ts هو الملف الوحيد المعدَّل، وتعديله في موضع واحد:
   * ترتيب المرشحين (Nominatim أولًا) لأن ArcGIS يعيد أسماء POI لاتينية.
   * خوارزميات الهرم الأربع لم تُمس. الاختبار يثبت أن الفرق محصور في الترتيب.
   */
  it('reverse-geocoding: الفرق محصور في ترتيب المرشحين فقط', () => {
    const ours = readFileSync(local('reverse-geocoding'), 'utf8');
    const theirs = readFileSync(reference('reverse-geocoding'), 'utf8');
    for (const fn of ['buildNominatimHierarchy', 'buildBDCHierarchy', 'buildArcGISHierarchy', 'buildPhotonHierarchy']) {
      const extract = src => {
        const i = src.indexOf(`function ${fn}`);
        const j = src.indexOf('\n}', i);
        return src.slice(i, j).replace(/\s+/g, ' ');
      };
      expect(extract(ours), `${fn} عُدِّلت`).toBe(extract(theirs));
    }
    /* الأسطر غير المرتبطة بالترتيب متطابقة */
    const urlLines = src => src.split('\n').filter(l => l.includes('Url =') || l.includes('timeout('));
    expect(urlLines(ours)).toEqual(urlLines(theirs));
  });

  it('reverse-geocoding فيه دوال الهرم الأربع كما في المرجع', () => {
    const src = readFileSync(local('reverse-geocoding'), 'utf8');
    for (const fn of ['buildNominatimHierarchy', 'buildBDCHierarchy', 'buildArcGISHierarchy', 'buildPhotonHierarchy']) {
      expect(src, `${fn} مفقودة`).toContain(fn);
    }
    expect(src).toContain('zoom=18');
    expect(src).toContain('langCode=ARA');
    expect(src).toContain('photon.komoot.io');
  });

  it('gps-location يصدّر الدوال المطلوبة في الوثيقة', () => {
    const src = readFileSync(local('gps-location'), 'utf8');
    expect(src).toContain('export async function enrichCoordinatesToLocation');
    expect(src).toContain('export async function autoDetectLocation');
  });

  it('egypt-places يحمل قاعدة الأماكن العربية', () => {
    const src = readFileSync(local('egypt-places'), 'utf8');
    expect(src).toContain('ARAB_INDEXED_PLACES');
    expect(src.length).toBeGreaterThan(30000);
  });
});

describe('المحرك الفلكي = مكتبة adhan المرجعية', () => {
  const location = { latitude: 30.5965, longitude: 32.2715, timeZone: 'Africa/Cairo', countryCode: 'EG' };

  it('جدول تَرتيل يطابق حساب المرجع حرفيًا', () => {
    const schedule = buildSchedule(location, { now: Date.UTC(2026, 10, 1, 10, 0) });
    const referenceDay = getDayPrayers(30.5965, 32.2715, new Date(Date.UTC(2026, 10, 1, 10, 0)), 'egyptian', 'Africa/Cairo');
    for (const prayer of referenceDay.prayers) {
      if (prayer.prayerId === 'duha') continue;
      const ours = schedule.events.find(e => e.id === `${referenceDay.date}|${prayer.prayerId}`);
      expect(ours, `${prayer.prayerId} مفقود`).toBeTruthy();
      expect(ours.at).toBe(Math.round(prayer.time.getTime()));
    }
  });

  it('الأوقات كلها لحظات صحيحة (شرط IPC)', () => {
    const schedule = buildSchedule(location);
    expect(schedule.events.every(e => Number.isSafeInteger(e.at))).toBe(true);
  });

  it('ستة صفوف لكل يوم في أحداث الآيلاند', () => {
    const schedule = buildSchedule(location);
    const byDate = {};
    for (const event of schedule.events) byDate[event.date] = (byDate[event.date] || 0) + 1;
    for (const count of Object.values(byDate)) expect(count).toBe(6);
  });

  it('يحمل المفتاحين timezone وtimeZone معًا', () => {
    const schedule = buildSchedule(location);
    expect(schedule.timezone).toBe('Africa/Cairo');
    expect(schedule.timeZone).toBe('Africa/Cairo');
  });

  it('ربط الدول بالطرق مطابق للمرجع', () => {
    const cases = [
      ['EG', 'egyptian'], ['SA', 'umm_al_qura'], ['PK', 'karachi'],
      ['US', 'isna'], ['FR', 'mwl'],
    ];
    for (const [cc, method] of cases) {
      const schedule = buildSchedule({ latitude: 30.5, longitude: 31.5, timeZone: 'Africa/Cairo', countryCode: cc });
      expect(schedule.method, cc).toBe(method);
      expect(schedule.methodName).toBe(METHOD_NAMES[method]);
    }
  });

  it('الطريقة اليدوية تتغلب على الدولة', () => {
    const schedule = buildSchedule(location, { methodId: 'umm_al_qura' });
    expect(schedule.method).toBe('umm_al_qura');
  });
});
