import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = path => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('فصل الأذان عن إشعار التنبيه المسبق', () => {
  it('حدث موعد الصلاة يصل إلى التطبيق فقط ولا ينشئ إشعار ويندوز أو toast حلقيًا', () => {
    const rust = source('src-tauri/src/lib.rs');
    const delivery = rust.split('fn deliver_alarm(')[1].split('fn start_alarm_loop(')[0];
    expect(delivery).toContain('app.emit("prayer-adhan"');
    expect(delivery).not.toContain('.notification()');
    expect(delivery).not.toContain('show_alarm_notification');
    expect(rust).not.toContain('notification_error');
    expect(rust).not.toContain('mod toast;');
    expect(rust).not.toContain('show_alarm_notification');
  });

  it('يرسل التنبيه المسبق إشعارًا عاديًا واحدًا فقط عند منح الإذن ويحفظ أنه أُرسل', () => {
    const main = source('src/main.jsx');
    const start = main.indexOf("const preAlarmFiredRef = useRef(new Set(readJson('tarteel.prayer.pre-alerts', [])));");
    const end = main.indexOf('  const handleAdhan = payload => {', start);
    const preAlert = main.slice(start, end);
    expect(preAlert).toContain('config.notificationsAllowed');
    expect(preAlert).toContain('preAlarmFiredRef.current.add(firedId)');
    expect(preAlert).toContain("localStorage.setItem('tarteel.prayer.pre-alerts'");
    expect(preAlert.match(/sendNotification\(/g)).toHaveLength(1);
    expect(preAlert).not.toContain('play_adhan');
  });

  it('موعد الصلاة لا يعتمد على إذن الإشعارات ولا يستدعي أي نظام إشعارات', () => {
    const main = source('src/main.jsx');
    const start = main.indexOf('  const handleAdhan = payload => {');
    const end = main.indexOf('  /** التجربة تشغّل ملف الأذان', start);
    const handler = main.slice(start, end);
    expect(handler).toContain("invoke('play_adhan'");
    expect(handler).not.toContain('notificationsAllowed');
    expect(handler).not.toContain('sendNotification');
    expect(handler).not.toContain('show_alarm_notification');
    expect(handler).not.toContain('notificationError');
  });

  it('زر التجربة يشغّل الأذان نفسه بلا استدعاء حدث مجدول أو إشعار نظام', () => {
    const main = source('src/main.jsx');
    const start = main.indexOf('  const previewAlarm = async () => {');
    const end = main.indexOf('  const stopAdhan = async () => {', start);
    const preview = main.slice(start, end);
    expect(preview).toContain('handleAdhan(sample)');
    expect(preview).toContain("emit('prayer-alarm-restore'");
    expect(preview).not.toContain('fire_alarm_now');
    expect(preview).not.toContain('sendNotification');
  });

  it('زر البطاقة موصول بمحرك الصوت ويختفي بعد الإيقاف', () => {
    const main = source('src/main.jsx');
    const island = source('island.html');
    const rust = source('src-tauri/src/lib.rs');
    expect(island).toContain('id="alStop"');
    expect(island).toContain("control('stop-adhan')");
    expect(island).toContain("listen('adhan-playback-state'");
    expect(main).toContain("payload.action === 'stop-adhan'");
    expect(main).toContain("invoke('stop_adhan'");
    expect(rust).toContain('fn stop_adhan(app: tauri::AppHandle');
    expect(rust).toContain('"stopped": true');
  });

  it('إخفاء بطاقة الأذان يوقف الصوت ولا يتركه يعمل بلا تحكم', () => {
    const main = source('src/main.jsx');
    expect(main).toContain('dismissAdhan: async () => { await stopAdhan(); clearAdhanAlert(); }');
    expect(main).toContain("await invoke('stop_adhan').catch(() => {});");
    expect(source('island.html')).not.toContain('setTimeout(()=>dismissAlert(true),25000)');
  });

  it('مهمة Windows تبدأ التطبيق مخفيًا وتنتظر الواجهة وتشارك سجل منع التكرار', () => {
    const scheduler = source('src-tauri/src/task_scheduler.rs');
    const alarm = source('src-tauri/src/alarm.rs');
    const rust = source('src-tauri/src/lib.rs');
    expect(scheduler).toContain('--hidden --adhan-task');
    expect(scheduler).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(rust).toContain('fn scheduled_task_argument');
    expect(rust).toContain('queue_scheduled_task(app, task_name)');
    expect(rust).toContain('process_pending_scheduled_tasks(app.handle())');
    expect(rust).toContain('app.listen_any("main-ready"');
    expect(rust).toContain('app.listen_any("island-ready"');
    expect(rust).toContain('pending.main_ready.load');
    expect(rust).toContain('pending.island_ready.load');
    expect(source('src/main.jsx')).toContain("Tarteel startup-ready acknowledgement failed");
    expect(alarm).toContain('pub fn claim_scheduled_task');
    expect(rust).not.toContain('run_headless_alarm');
    expect(rust).not.toContain('--adhan-ring');
  });

  it('نافذة الإعدادات والجزيرة تتبعان ألوان الهوية وحجم النافذة مدمج', () => {
    const settings = source('src/PrayerSettings.css');
    const styles = source('src/styles.css');
    const island = source('island.html');
    const config = JSON.parse(source('src-tauri/tauri.conf.json'));
    expect(styles).toContain('--bg:#0A0B0D');
    expect(styles).toContain('--accent:#5AA9FF');
    expect(settings).toContain('--ps-surface-modal: var(--bg)');
    expect(settings).toContain('--ps-text: var(--text)');
    expect(settings).toContain('--ps-blue: var(--accent)');
    expect(settings).not.toContain('ps-violet');
    expect(island).toContain('--accent:#5AA9FF');
    expect(config.app.windows[0].width).toBe(920);
    expect(config.app.windows[0].height).toBe(640);
    expect(config.app.windows[0].minWidth).toBe(720);
    expect(config.app.windows[0].minHeight).toBe(560);
  });

  it('الحزمة تفك ملف adhan-call.mpeg المرفق ولا تعود إلى ملف MP3 السابق', () => {
    const cargo = source('src-tauri/Cargo.toml');
    const audio = source('src-tauri/src/audio.rs');
    const rust = source('src-tauri/src/lib.rs');
    const config = JSON.parse(source('src-tauri/tauri.conf.json'));
    expect(config.bundle.resources).toContain('assets/adhan-call.mpeg');
    expect(config.bundle.resources).not.toContain('assets/adhan.mp3');
    expect(rust).toContain('assets/adhan-call.mpeg');
    expect(audio).toContain('.join("adhan-call.mpeg")');
    expect(cargo).toContain('"symphonia-aac"');
    expect(cargo).toContain('"symphonia-isomp4"');
  });
});
