import { describe, it, expect } from 'vitest';
import {
  buildSchedule, alarmEvents, tasksWithinHorizon, scheduleNeedsRebuild,
  upcoming, current, countdownLabel, alarmCopy, TIMELINE_DAYS,
} from '../src/engine/schedule.js';

const zagazig = {
  source: 'device', latitude: 30.5877, longitude: 31.502,
  timeZone: 'Africa/Cairo', countryCode: 'EG', city: 'الزقازيق', resolvedAt: Date.UTC(2026, 9, 31, 6),
};
const NOW = Date.UTC(2026, 9, 31, 9, 0, 0); // 11:00 بتوقيت القاهرة

describe('بناء الجدول من موقع مؤكد', () => {
  const schedule = buildSchedule(zagazig, { now: NOW });

  it('يشتق الطريقة من الدولة تلقائيًا دون سؤال المستخدم', () => {
    expect(schedule.method).toBe('egyptian');
    expect(schedule.methodName).toContain('المصرية');
    expect(schedule.shadowFactor).toBe(1);
    expect(schedule.methodName).toBeTruthy();
    expect(schedule.timeZone).toBe('Africa/Cairo');
  });

  it('ينتج أحداث صلوات باسم عربي ومعرّف فريد ولحظة مطلقة', () => {
    /* المرجع يحسب 4 أيام (−1..+2) × 6 صلوات للآيلاند */
    expect(schedule.events.length).toBe(6 * (TIMELINE_DAYS + 1));
    for (const event of schedule.events) {
      expect(event.name).toMatch(/^(الفجر|الشروق|الظهر|العصر|المغرب|العشاء)$/);
      expect(event.id).toBe(`${event.date}|${event.key}`);
      expect(Number.isFinite(event.at)).toBe(true);
    }
    const ids = schedule.events.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('أحداثه مرتبة تصاعديًا بلا فجوة 28 ساعة', () => {
    for (let i = 1; i < schedule.events.length; i++) {
      const gap = schedule.events[i].at - schedule.events[i - 1].at;
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThan(20 * 3600 * 1000);
    }
  });

  it('يرفض البناء بلا موقع أو بلا منطقة زمنية بدل التخمين', () => {
    expect(() => buildSchedule(null)).toThrow();
    expect(() => buildSchedule({ latitude: 30, longitude: 31 })).toThrow();
  });
});

describe('تغذية جدولة Rust ومهام ويندوز', () => {
  const schedule = buildSchedule(zagazig, { now: NOW });

  it('أحداث التنبيه خمس صلوات فقط — الشروق ليس صلاة', () => {
    const alarms = alarmEvents(schedule, NOW);
    expect(alarms.length).toBeGreaterThan(0);
    expect(alarms.every(e => e.key !== 'sunrise')).toBe(true);
    expect(alarms.every(e => e.at > NOW)).toBe(true);
  });

  it('مهام ويندوز تقتصر على أفق أسبوع', () => {
    const tasks = tasksWithinHorizon(schedule, NOW);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every(t => t.at <= NOW + 7 * 24 * 3600 * 1000)).toBe(true);
    // أسبوع × 5 صلوات = 35 كحد أقصى
    expect(tasks.length).toBeLessThanOrEqual(35);
  });
});

describe('متى يُعاد بناء الجدول', () => {
  const schedule = buildSchedule(zagazig, { now: NOW });

  it('لا يعيد البناء لموقع لم يتحرك', () => {
    expect(scheduleNeedsRebuild(schedule, zagazig, NOW + 60000)).toBe(false);
  });

  it('يعيد البناء عند تغيّر المنطقة الزمنية', () => {
    expect(scheduleNeedsRebuild(schedule, { ...zagazig, timeZone: 'Asia/Riyadh' }, NOW)).toBe(true);
  });

  it('يعيد البناء بعد 24 ساعة', () => {
    expect(scheduleNeedsRebuild(schedule, zagazig, NOW + 25 * 3600 * 1000)).toBe(true);
  });

  it('يعيد البناء إذا انتهت كل المواعيد', () => {
    expect(scheduleNeedsRebuild(schedule, zagazig, NOW + 40 * 24 * 3600 * 1000)).toBe(true);
  });

  it('يعيد البناء إذا لم يوجد جدول', () => {
    expect(scheduleNeedsRebuild(null, zagazig, NOW)).toBe(true);
  });
});

describe('الصلاة القادمة والعدّاد', () => {
  const schedule = buildSchedule(zagazig, { now: NOW });

  it('الصلاة القادمة بعد الحادية عشرة صباحًا هي الظهر', () => {
    expect(upcoming(schedule, NOW).key).toBe('dhuhr');
  });

  it('الصلاة الحالية قبل الظهر هي الفجر', () => {
    expect(current(schedule, NOW).key).toBe('fajr');
  });

  it('العدّاد يعرض ساعات ودقائق وثواني', () => {
    expect(countdownLabel(3_723_000)).toBe('1:02:03');
    expect(countdownLabel(125_000)).toBe('2:05');
    expect(countdownLabel(-5000)).toBe('0:00');
  });
});

describe('نص التنبيه', () => {
  const event = { key: 'fajr', name: 'الفجر' };

  it('يذكر اسم الصلاة في العنوان دائمًا', () => {
    expect(alarmCopy(event).title).toBe('حان وقت صلاة الفجر');
    expect(alarmCopy(event).body).toContain('موقعك');
  });

  it('يشرح إيقاف التلاوة عند حدوثه', () => {
    expect(alarmCopy(event, { paused: true }).body).toContain('أُوقفت التلاوة');
    expect(alarmCopy(event, { resumeDisabled: true }).body).toContain('مؤقت النوم');
  });
});
