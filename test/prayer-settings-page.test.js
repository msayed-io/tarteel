import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const source = path => readFileSync(resolve(root, path), 'utf8');
const page = source('src/PrayerSettingsPage.jsx');
const logic = source('src/PrayerSettings.jsx');
const css = source('src/PrayerSettings.css');
const main = source('src/main.jsx');

describe('صفحة إعدادات تَرتيل', () => {
  it('تستبدل التراكب بصفحة كاملة وتعرض التبويبات الثلاثة والأقسام السبعة', () => {
    expect(main).toContain('if (prayerSettingsOpen)');
    expect(main).not.toContain('{prayerSettingsOpen && <PrayerSettings');
    expect(page).not.toContain('role="dialog"');
    expect(page).not.toContain('prayer-settings-backdrop');
    for (const id of ['settings-tab-prayer', 'settings-tab-audio', 'settings-tab-island', 'pane-prayer', 'pane-audio', 'pane-island']) {
      expect(page).toContain(id);
    }
    for (const text of ['الموقع', 'طريقة الحساب', 'التنبيهات', 'صوت التلاوة', 'التطبيق في الخلفية', 'موضع', 'مظهر']) {
      expect(page).toContain(text);
    }
    expect(page).toContain('onClick={onClose}');
  });

  it('يعرض بيانات النظام الفعلية بدل قيم معاينة HTML الثابتة', () => {
    expect(page).not.toContain('عزبة الحمامصة');
    expect(page).not.toContain('Africa/Cairo');
    expect(page).not.toContain('دقة 85 م');
    expect(page).not.toContain('لم يُحدَّد الموقع بعد');
    expect(page).not.toContain('settings-feedback');
    expect(page).not.toContain('value="100"');
    expect(page).toContain('location ? placeLabel');
    expect(page).toContain('{location.timeZone}');
    expect(page).toContain('Math.round(location.accuracy)');
    expect(page).toContain('value={adhanVolume}');
    expect(page).toContain('aria-pressed={notificationsAllowed}');
    expect(page).toContain('aria-checked={islandPlacement.mode ===');
    expect(page).toContain('formatPlacementOffset(islandPlacement.offsetX)');
    expect(page).toContain('checked={autostart}');
  });

  it('تحافظ على معرّفات عناصر الإعدادات الموجودة', () => {
    for (const id of [
      'ps-title', 'ps-location-title', 'ps-method-title', 'ps-alerts-title',
      'ps-audio-title', 'ps-background-title', 'ps-placement-title', 'ps-appearance-title',
      'ps-method', 'ps-school', 'ps-notify', 'ps-notify-label', 'ps-sound',
      'ps-sound-label', 'ps-volume', 'ps-volume-label', 'ps-mute', 'ps-mute-label',
      'ps-pre', 'ps-pre-label', 'ps-autostart', 'ps-autostart-label',
    ]) expect(page).toContain(`id="${id}"`);
  });

  it('يربط الحقول بمعالجات التطبيق الحالية ولا ينقل سكربت المعاينة', () => {
    for (const binding of [
      'onChange={event => setMethodId(event.target.value)}',
      'onChange={event => setSchool(',
      'onClick={requestDeviceLocation}',
      'onClick={requestNotifications}',
      'onChange={event => setAdhanSound(event.target.checked)}',
      'onChange={event => setAdhanVolume(Number(event.target.value))}',
      'onChange={event => setAdhanMuted(event.target.checked)}',
      'onChange={event => setPreAlarmMinutes(Number(event.target.value))}',
      'onClick={onPreviewAlarm}',
      'onAudioModeChange?.(option.id)',
      'onChange={event => toggleAutostart(event.target.checked)}',
      "chooseIslandPlacementMode('auto')",
      "chooseIslandPlacementMode('manual')",
      "chooseIslandAppearance('glass')",
      "chooseIslandAppearance('black')",
      "nudgeIsland('up')", "nudgeIsland('right')", "nudgeIsland('down')", "nudgeIsland('left')",
    ]) expect(page).toContain(binding);
    expect(page).not.toContain('addEventListener');
    expect(page).not.toContain('history.replaceState');
    expect(page).not.toContain('let x=0,y=-2');
    expect(page).not.toContain('const paint=');
    expect(logic).toContain("invoke('set_island_placement'");
    expect(logic).toContain("invoke('set_island_appearance'");
    expect(logic).toContain("invoke('set_autostart'");
    expect(logic).toContain("invoke('set_adhan_preferences'");
  });

  it('يقرأ حالة إذن الإشعارات الحقيقية قبل حفظ الإعدادات تلقائيًا', () => {
    expect(logic).toContain('isPermissionGranted()');
    expect(logic).toContain('setNotificationsAllowed(Boolean(granted))');
    expect(logic).toContain('if (!location || !notificationPermissionReady) return;');
    expect(logic).toContain('setTimeout(async () =>');
    expect(logic).toContain('await onSave(payload)');
  });

  it('يحافظ على قيم التصميم والحافة والريموت الدائري حرفيًا مع إخفاء شريط التمرير', () => {
    for (const value of [
      '--bg:#0a0b0d', '--card:#151617', '--card-line:#252628', '--raised:#1d1f22',
      '--pill:#36383b', '--rim-rgb:255 255 255', '--rim:1', '--rim-w:1px',
      'max-width:1134px', 'padding-inline:42px', 'height:54px', 'font-size:48px',
      'scrollbar-width:none', 'mask-composite:exclude', '-webkit-mask-composite:xor',
      'clip-path:path(', 'width:248px;height:248px', 'prefers-reduced-transparency:reduce',
      'prefers-reduced-motion:reduce',
    ]) expect(css).toContain(value);
    expect(css).not.toContain('--accent');
    expect(css).not.toContain('--ps-blue');
  });
});
