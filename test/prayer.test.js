import { describe, expect, it, vi } from 'vitest';
import {
  PrayerDataError, fetchCalculationMethods, findNextPrayer, getCurrentPrayer,
  getDeviceLocation, getTodayPrayerEvents, haversineKm, loadPrayerSchedule,
  prayerTransition, searchCities, sleepTransition
} from '../src/prayer.js';

const fixedNow = Date.UTC(2026, 9, 31, 12, 0, 0);
const timeValues = { Fajr: '05:12 (EET)', Dhuhr: '12:10 (EET)', Asr: '15:22 (EET)', Maghrib: '17:48 (EET)', Isha: '19:03 (EET)' };
function calendar(year, month, timezone = 'Africa/Cairo', method = 5, school = 'STANDARD') {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { code: 200, data: Array.from({ length: days }, (_, i) => {
    const day = i + 1;
    return {
      meta: { timezone, method: { id: method }, school },
      date: { gregorian: { date: `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`, year: String(year), month: { number: month } } },
      timings: { ...timeValues }
    };
  }) };
}
const ok = data => ({ ok: true, status: 200, json: async () => data });
const manualLocation = { source: 'manual', city: 'القاهرة', country: 'مصر', latitude: 30.0444, longitude: 31.2357, timezone: 'Africa/Cairo' };

function manualFetch(urls, { fail = false } = {}) {
  return vi.fn(async url => {
    if (fail) throw new Error('offline');
    const parsed = new URL(url);
    const [, year, month] = parsed.pathname.match(/calendar\/(\d+)\/(\d+)/) || [];
      const method = Number(parsed.searchParams.get('method')) || 5;
      const school = parsed.searchParams.get('school') === '1' ? 'HANAFI' : 'STANDARD';
      return ok(calendar(Number(year), Number(month), 'Africa/Cairo', method, school));
  });
}

describe('real prayer-data integration', () => {
  it('loads three months from AlAdhan for a manually selected city and passes calculation, Asr school, and IANA timezone', async () => {
    const fetcher = manualFetch();
    const schedule = await loadPrayerSchedule({ location: manualLocation, methodId: 5, school: 1, now: fixedNow }, fetcher);
    expect(schedule.source).toBe('AlAdhan Prayer Times API');
    expect(schedule.locationSource).toBe('manual');
    expect(schedule.timezone).toBe('Africa/Cairo');
    expect(schedule.events.length).toBeGreaterThanOrEqual(90);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const urls = fetcher.mock.calls.map(([url]) => new URL(url));
    expect(urls[0].searchParams.get('method')).toBe('5');
    expect(urls[0].searchParams.get('school')).toBe('1');
    expect(urls[0].searchParams.get('timezonestring')).toBe('Africa/Cairo');
    expect(schedule.events.every(event => Number.isFinite(event.at) && event.id.includes('|m5|s1'))).toBe(true);
  });

  it('does not use previous timings when the network is unavailable', async () => {
    await expect(loadPrayerSchedule({ location: manualLocation, methodId: 5, school: 0, now: fixedNow }, manualFetch([], { fail: true })))
      .rejects.toMatchObject({ code: 'network' });
    expect(findNextPrayer(null, fixedNow)).toBeNull();
    expect(getTodayPrayerEvents(null, fixedNow)).toEqual([]);
  });

  it('validates the returned method, school, timezone, and required timings before accepting any calendar', async () => {
    const fetcher = vi.fn(async url => {
      const parsed = new URL(url), [, year, month] = parsed.pathname.match(/calendar\/(\d+)\/(\d+)/) || [];
      return ok(calendar(Number(year), Number(month), 'Africa/Cairo', 5, 'STANDARD'));
    });
    await expect(loadPrayerSchedule({ location: manualLocation, methodId: 5, school: 1, now: fixedNow }, fetcher))
      .rejects.toMatchObject({ code: 'school-mismatch' });
    const noLocation = await loadPrayerSchedule({ location: null, methodId: 5, school: 0, now: fixedNow }, fetcher).catch(error => error);
    expect(noLocation).toBeInstanceOf(PrayerDataError);
    expect(noLocation.code).toBe('location');
  });

  it('obtains city choices from geocoding and does not invent a location for empty or failed results', async () => {
    const fetcher = vi.fn(async url => {
      expect(new URL(url).searchParams.get('language')).toBe('ar');
      return ok({ results: [{ id: 1, name: 'القاهرة', country: 'مصر', latitude: 30.04, longitude: 31.23, timezone: 'Africa/Cairo' }] });
    });
    expect(await searchCities('القاهرة', fetcher)).toEqual([expect.objectContaining({ city: 'القاهرة', source: 'manual', timezone: 'Africa/Cairo' })]);
    expect(await searchCities('ا', fetcher)).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(searchCities('القاهرة', async () => { throw new Error('offline'); })).rejects.toMatchObject({ code: 'network' });
  });

  it('requests device permission explicitly and returns coordinates only after a granted, valid system fix', async () => {
    const checkPermissions = vi.fn(async () => ({ location: 'prompt' }));
    const requestPermissions = vi.fn(async () => ({ location: 'granted' }));
    const getCurrentPosition = vi.fn(async () => ({ coords: { latitude: 25.2, longitude: 55.3, accuracy: 30 } }));
    const location = await getDeviceLocation({ checkPermissions, requestPermissions, getCurrentPosition });
    expect(requestPermissions).toHaveBeenCalledWith(['location']);
    expect(location).toMatchObject({ source: 'device', latitude: 25.2, longitude: 55.3 });

    await expect(getDeviceLocation({ checkPermissions: async () => ({ location: 'denied' }), requestPermissions, getCurrentPosition }))
      .rejects.toMatchObject({ code: 'location-denied' });
    await expect(getDeviceLocation({ checkPermissions: async () => ({ location: 'granted' }), requestPermissions, getCurrentPosition: async () => { throw new Error('no fix'); } }))
      .rejects.toMatchObject({ code: 'location-failed' });
    await expect(getDeviceLocation({ checkPermissions: async () => ({ location: 'granted' }), requestPermissions, getCurrentPosition: async () => ({ coords: {} }) }))
      .rejects.toMatchObject({ code: 'location-invalid' });
  });

  it('handles local dates across midnight and DST without interpreting local wall time in the computer timezone', async () => {
    const berlin = { ...manualLocation, city: 'Berlin', country: 'Deutschland', latitude: 52.52, longitude: 13.4, timezone: 'Europe/Berlin' };
    const fetcher = vi.fn(async url => {
      const parsed = new URL(url), [, year, month] = parsed.pathname.match(/calendar\/(\d+)\/(\d+)/) || [];
      const result = calendar(Number(year), Number(month), 'Europe/Berlin');
      if (Number(month) === 3) result.data.find(item => item.date.gregorian.date.startsWith('29-')).timings.Fajr = '03:15 (CEST)';
      return ok(result);
    });
    const dstSchedule = await loadPrayerSchedule({ location: berlin, methodId: 5, school: 0, now: Date.UTC(2026, 2, 28, 12) }, fetcher);
    const transitionDay = dstSchedule.events.find(event => event.date === '2026-03-29' && event.name === 'الفجر');
    expect(transitionDay).toBeTruthy();
    expect(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(transitionDay.at))).toBe('03:15');
    const springGap = vi.fn(async url => {
      const parsed = new URL(url), [, year, month] = parsed.pathname.match(/calendar\/(\d+)\/(\d+)/) || [];
      const result = calendar(Number(year), Number(month), 'Europe/Berlin');
      if (Number(month) === 3) result.data.find(item => item.date.gregorian.date.startsWith('29-')).timings.Fajr = '02:30 (CET)';
      return ok(result);
    });
    await expect(loadPrayerSchedule({ location: berlin, methodId: 5, school: 0, now: Date.UTC(2026, 2, 28, 12) }, springGap)).rejects.toMatchObject({ code: 'timezone' });
  });

  it('updates next/current prayer by real instants across midnight and prevents a false next time', () => {
    const now = Date.UTC(2026, 9, 31, 21, 0);
    const schedule = { timezone: 'Africa/Cairo', events: [
      { name: 'العشاء', date: '2026-10-31', at: now - 60_000 },
      { name: 'الفجر', date: '2026-11-01', at: now + 8 * 60 * 60_000 }
    ] };
    expect(getCurrentPrayer(schedule, now).name).toBe('العشاء');
    expect(findNextPrayer(schedule, now).name).toBe('الفجر');
    expect(getTodayPrayerEvents(schedule, now).map(item => item.name)).toEqual(['العشاء']);
    expect(findNextPrayer({ events: [] }, now)).toBeNull();
  });

  it('pauses only when the user enabled it, preserves explicit resume gating, and implements both sleep modes', () => {
    expect(prayerTransition({ wasPlaying: true, pauseAtAdhan: true })).toEqual({ shouldPause: true, canOfferResume: true });
    expect(prayerTransition({ wasPlaying: false, pauseAtAdhan: true }).canOfferResume).toBe(false);
    expect(prayerTransition({ wasPlaying: true, pauseAtAdhan: false }).shouldPause).toBe(false);
    expect(sleepTransition({ mode: 'minutes', deadline: fixedNow - 1, now: fixedNow }).reason).toBe('deadline');
    expect(sleepTransition({ mode: 'end', deadline: null, now: fixedNow, trackEnded: false }).stop).toBe(false);
    expect(sleepTransition({ mode: 'end', deadline: null, now: fixedNow, trackEnded: true }).reason).toBe('track-end');
    expect(haversineKm({ latitude: 30, longitude: 31 }, { latitude: 30, longitude: 31 })).toBe(0);
  });

  it('loads calculation method choices from the API instead of presenting fabricated defaults', async () => {
    const methods = await fetchCalculationMethods(async url => {
      expect(url).toContain('/methods');
      return ok({ code: 200, data: { EGYPT: { id: 5, name: 'Egyptian General Authority of Survey' }, CUSTOM: { id: 99, name: 'Custom' } } });
    });
    expect(methods).toEqual([{ key: 'EGYPT', id: 5, name: 'Egyptian General Authority of Survey' }]);
    await expect(fetchCalculationMethods(async () => ok({ code: 503 }))).rejects.toMatchObject({ code: 'methods' });
  });
});
