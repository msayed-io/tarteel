import { useEffect, useState } from 'react';
import './PrayerSettings.css';

function Icon({ name, size = 18, className = '' }) {
  return <svg className={className || undefined} width={size} height={size} aria-hidden="true" focusable="false"><use href={`#i-${name}`} /></svg>;
}

const TABS = [
  { id: 'pane-prayer', tabId: 'settings-tab-prayer', label: 'الصلاة والتنبيهات' },
  { id: 'pane-audio', tabId: 'settings-tab-audio', label: 'الصوت والتطبيق' },
  { id: 'pane-island', tabId: 'settings-tab-island', label: <bdi>Dynamic</bdi> },
];

export default function PrayerSettingsPage({
  location,
  placeLabel,
  autoMethodName,
  methodOptions,
  methodAngles,
  methodId,
  setMethodId,
  school,
  setSchool,
  effectiveMethod,
  effectiveSchool,
  busy,
  notificationsAllowed,
  requestDeviceLocation,
  requestNotifications,
  preAlarmMinutes,
  setPreAlarmMinutes,
  adhanSound,
  setAdhanSound,
  adhanVolume,
  setAdhanVolume,
  adhanMuted,
  setAdhanMuted,
  onPreviewAlarm,
  activeAudioMode,
  onAudioModeChange,
  autostart,
  toggleAutostart,
  islandPlacement,
  placementLoading,
  chooseIslandPlacementMode,
  nudgeIsland,
  formatPlacementOffset,
  islandAppearance,
  appearanceLoading,
  chooseIslandAppearance,
  onClose,
}) {
  const [activePane, setActivePane] = useState('pane-prayer');
  const paneIndex = Math.max(0, TABS.findIndex(tab => tab.id === activePane));

  useEffect(() => {
    document.documentElement.classList.add('settings-page-active');
    document.body.classList.add('settings-page-active');
    return () => {
      document.documentElement.classList.remove('settings-page-active');
      document.body.classList.remove('settings-page-active');
    };
  }, []);

  const switchPane = id => setActivePane(id);

  return (
    <div className="settings-page" dir="rtl">
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
        <defs>
          <symbol id="i-back" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></symbol>
          <symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></symbol>
          <symbol id="i-chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></symbol>
          <symbol id="i-up" viewBox="0 0 24 24"><path d="M12 19V6M6 11.5L12 5.5l6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></symbol>
          <symbol id="i-down" viewBox="0 0 24 24"><path d="M12 5v13M6 12.5l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></symbol>
          <symbol id="i-left" viewBox="0 0 24 24"><path d="M19 12H6M11.5 6L5.5 12l6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></symbol>
          <symbol id="i-right" viewBox="0 0 24 24"><path d="M5 12h13M12.5 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></symbol>
          <symbol id="i-pin" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21s-7-5.2-7-11a7 7 0 0 1 14 0c0 5.8-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></g></symbol>
          <symbol id="i-refresh" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11a8 8 0 0 0-14.9-3M4 5v4h4" /><path d="M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4" /></g></symbol>
          <symbol id="i-bell" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10.3 20a2 2 0 0 0 3.4 0" /></g></symbol>
          <symbol id="i-vol" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5L6 9H3v6h3l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></g></symbol>
          <symbol id="i-vol-low" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5L6 9H3v6h3l5 4V5z" /><path d="M15.5 9a4 4 0 0 1 0 6" /></g></symbol>
          <symbol id="i-vol-x" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5L6 9H3v6h3l5 4V5z" /><path d="M22 9l-6 6M16 9l6 6" /></g></symbol>
          <symbol id="i-clock" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></g></symbol>
          <symbol id="i-play" viewBox="0 0 24 24"><path d="M8.5 5.5v13l10.5-6.5z" fill="currentColor" /></symbol>
          <symbol id="i-tray" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></g></symbol>
        </defs>
      </svg>

      <div className="wrap">
        <nav className="topbar" aria-label="الإعدادات">
          <button className="glass circle" type="button" aria-label="رجوع إلى المكتبة" onClick={onClose} style={{ '--R': '26px' }}>
            <Icon name="back" size={22} />
          </button>

          <div className="glass seg nav" id="settings-nav" role="tablist" aria-label="أقسام الإعدادات" style={{ '--n': 3, '--i': paneIndex, '--R': '27px' }}>
            <span className="rim on-glass seg-thumb" aria-hidden="true" />
            {TABS.map(tab => (
              <button
                className="seg-item"
                id={tab.tabId}
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activePane === tab.id}
                aria-controls={tab.id}
                tabIndex={activePane === tab.id ? 0 : -1}
                onClick={() => switchPane(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="glass brand" style={{ '--R': '27px' }}>
            <span className="brand-mark" aria-hidden="true">ت</span>
            <span className="brand-name">ترتيل</span>
          </div>
        </nav>

        <header className="page-head">
          <h1 id="ps-title">الإعدادات</h1>
          <p className="sub"><Icon name="check" size={16} />يُحفظ كل تغيير تلقائيًا</p>
        </header>

        <main className="panes">
          <section className={`pane${activePane === 'pane-prayer' ? ' is-active' : ''}`} id="pane-prayer" role="tabpanel" aria-labelledby="settings-tab-prayer" hidden={activePane !== 'pane-prayer'}>
            <div className="col">
              <section className="sec" aria-labelledby="ps-location-title">
                <h2 className="sec-title" id="ps-location-title">الموقع</h2>
                <div className="card">
                  <div className="loc" aria-live="polite">
                    <div className="loc-pin"><Icon name="pin" size={22} /></div>
                    <div className="loc-main">
                      <div className="loc-name">{location ? placeLabel : ''}</div>
                      {location && (
                        <div className="chips">
                          {location.timeZone && <span className="chip"><bdi dir="ltr">{location.timeZone}</bdi></span>}
                          {Number.isFinite(location.accuracy) && <span className="chip">دقة {Math.round(location.accuracy)} م</span>}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="loc-foot">
                    <button className={`glass btn block${busy ? ' is-spinning' : ''}`} type="button" onClick={requestDeviceLocation} disabled={busy} aria-busy={busy} style={{ '--R': '23px' }}>
                      <Icon name="refresh" size={17} />تحديث موقعي الآن
                    </button>
                  </div>
                </div>
                <p className="hint">يُحدَّد موقعك من ويندوز.</p>
              </section>

              <section className="sec" aria-labelledby="ps-method-title">
                <h2 className="sec-title" id="ps-method-title">طريقة الحساب</h2>
                <div className="card">
                  <div className="fields">
                    <label className="field" htmlFor="ps-method">
                      <span className="field-label" id="ps-method-label">الطريقة</span>
                      <div className="glass sel" style={{ '--R': '22px' }}>
                        <select id="ps-method" aria-labelledby="ps-method-label" value={methodId} onChange={event => setMethodId(event.target.value)}>
                          <option value="auto">تلقائي حسب الدولة — {autoMethodName}</option>
                          {methodOptions.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
                        </select>
                        <Icon className="chev" name="chev" size={16} />
                      </div>
                    </label>
                    <label className="field" htmlFor="ps-school">
                      <span className="field-label" id="ps-school-label">حساب العصر</span>
                      <div className="glass sel" style={{ '--R': '22px' }}>
                        <select id="ps-school" aria-labelledby="ps-school-label" value={String(school)} onChange={event => setSchool(event.target.value === 'auto' ? 'auto' : Number(event.target.value))}>
                          <option value="auto">تلقائي حسب الدولة</option>
                          <option value="1">جمهور الفقهاء (ظل ×١)</option>
                          <option value="2">المذهب الحنفي (ظل ×٢)</option>
                        </select>
                        <Icon className="chev" name="chev" size={16} />
                      </div>
                    </label>
                  </div>
                  <div className="applied">
                    <div className="applied-label"><Icon name="check" size={15} />المطبّق الآن</div>
                    <div className="chips">
                      <span className="chip">{effectiveMethod}{methodAngles && <bdi>{` (${methodAngles})`}</bdi>}</span>
                      <span className="chip">{effectiveSchool}</span>
                    </div>
                  </div>
                </div>
                <p className="hint">تُشتق طريقة الحساب من دولتك.</p>
              </section>
            </div>

            <div className="col">
              <section className="sec" aria-labelledby="ps-alerts-title">
                <h2 className="sec-title" id="ps-alerts-title">التنبيهات</h2>
                <div className="card">
                  <div className="row">
                    <span className="ico"><Icon name="bell" /></span>
                    <span className="row-label" id="ps-notify-label">إذن إشعار التنبيه المسبق</span>
                    <button className={`glass btn sm${notificationsAllowed ? ' granted' : ''} row-ctl`} id="ps-notify" type="button" aria-labelledby="ps-notify-label" aria-pressed={notificationsAllowed} onClick={requestNotifications} style={{ '--R': '17px' }}>
                      {notificationsAllowed ? <>ممنوحة<Icon name="check" size={15} /></> : 'طلب الإذن'}
                    </button>
                  </div>

                  <div className="row">
                    <span className="ico"><Icon name="vol" /></span>
                    <span className="row-label" id="ps-sound-label">صوت الأذان عند الموعد</span>
                    <label className="rim switch row-ctl" style={{ '--R': '14px' }}>
                      <input id="ps-sound" type="checkbox" role="switch" aria-labelledby="ps-sound-label" checked={adhanSound} onChange={event => setAdhanSound(event.target.checked)} />
                      <span className="track" />
                    </label>
                  </div>

                  <div className="row row-vol">
                    <div className="row-vol-top">
                      <span className="ico"><Icon name="vol-low" /></span>
                      <label className="row-label" id="ps-volume-label" htmlFor="ps-volume">مستوى صوت الأذان</label>
                      <span className="glass pill" dir="ltr" style={{ '--R': '15px' }}>{`${adhanVolume}%`}</span>
                    </div>
                    <div className="slider-line">
                      <Icon name="vol-low" size={17} />
                      <input className="range" id="ps-volume" type="range" min="0" max="100" value={adhanVolume} aria-labelledby="ps-volume-label" aria-valuetext={`${adhanVolume}%`} style={{ '--p': Number(adhanVolume) / 100 }} onChange={event => setAdhanVolume(Number(event.target.value))} />
                      <Icon name="vol" size={17} />
                    </div>
                  </div>

                  <div className="row">
                    <span className="ico"><Icon name="vol-x" /></span>
                    <span className="row-label" id="ps-mute-label">كتم الأذان مؤقتًا</span>
                    <label className="rim switch row-ctl" style={{ '--R': '14px' }}>
                      <input id="ps-mute" type="checkbox" role="switch" aria-labelledby="ps-mute-label" checked={adhanMuted} onChange={event => setAdhanMuted(event.target.checked)} />
                      <span className="track" />
                    </label>
                  </div>

                  <div className="row">
                    <span className="ico"><Icon name="clock" /></span>
                    <span className="row-label" id="ps-pre-label">تنبيه مسبق</span>
                    <div className="glass sel sm row-ctl" style={{ '--R': '20px' }}>
                      <select id="ps-pre" aria-labelledby="ps-pre-label" value={preAlarmMinutes} onChange={event => setPreAlarmMinutes(Number(event.target.value))}>
                        <option value={0}>بدون</option>
                        <option value={5}>قبل 5 دقائق</option>
                        <option value={10}>قبل 10 دقائق</option>
                        <option value={15}>قبل 15 دقيقة</option>
                        <option value={30}>قبل 30 دقيقة</option>
                      </select>
                      <Icon className="chev" name="chev" size={15} />
                    </div>
                  </div>

                  <div className="card-foot">
                    <button className="glass btn block" type="button" onClick={onPreviewAlarm} style={{ '--R': '23px' }}>
                      <span className="play-dot"><Icon name="play" size={13} /></span>تجربة صوت الأذان
                    </button>
                  </div>
                </div>
              </section>
            </div>
          </section>

          <section className={`pane${activePane === 'pane-audio' ? ' is-active' : ''}`} id="pane-audio" role="tabpanel" aria-labelledby="settings-tab-audio" hidden={activePane !== 'pane-audio'}>
            <div className="col">
              <section className="sec" aria-labelledby="ps-audio-title">
                <h2 className="sec-title" id="ps-audio-title">صوت التلاوة</h2>
                <div className="card">
                  <div className="opts" role="radiogroup" aria-label="صوت التلاوة">
                    {[
                      { id: 'natural', title: 'طبيعي', detail: 'الصوت الأصلي بلا مؤثرات إضافية.' },
                      { id: 'spatial', title: 'العمق المكاني', detail: <><bdi>HRIR</bdi> مقاسة من رأس <bdi>KU100</bdi> لتوسيع المجال بهدوء.</> },
                      { id: 'mosque', title: 'محاكاة المسجد', detail: 'صدى تلافيفي متزن يحافظ على وضوح التلاوة.' },
                    ].map(option => (
                      <label className="opt" key={option.id}>
                        <input type="radio" name="rec" checked={activeAudioMode === option.id} onChange={() => onAudioModeChange?.(option.id)} />
                        <span className="opt-txt"><b>{option.title}</b><small>{option.detail}</small></span>
                        <span className="opt-ind"><Icon name="check" size={15} /></span>
                      </label>
                    ))}
                  </div>
                  <p className="hint">بيانات <bdi>HRTF</bdi> مقاسة عامة وليست مخصصة لأذن المستمع؛ المعالجة تعمل محليًا في <bdi>Rust</bdi>، ويبقى «طبيعي» المشغّل الحالي دون تغيير.</p>
                </div>
              </section>
            </div>

            <div className="col">
              <section className="sec" aria-labelledby="ps-background-title">
                <h2 className="sec-title" id="ps-background-title">التطبيق في الخلفية</h2>
                <div className="card">
                  <div className="row note-row">
                    <span className="ico"><Icon name="tray" /></span>
                    <p><strong>إغلاق النافذة لا يُنهي التطبيق:</strong> يبقى في صينية النظام بجانب الساعة ليُطلق الأذان في موعده. الخروج النهائي من قائمة الصينية.</p>
                  </div>
                  <div className="row">
                    <span className="ico"><Icon name="tray" /></span>
                    <span className="row-label" id="ps-autostart-label">البدء مع تشغيل ويندوز (مصغّرًا في الصينية)</span>
                    <label className="rim switch row-ctl" style={{ '--R': '14px' }}>
                      <input id="ps-autostart" type="checkbox" role="switch" aria-labelledby="ps-autostart-label" checked={autostart} onChange={event => toggleAutostart(event.target.checked)} />
                      <span className="track" />
                    </label>
                  </div>
                </div>
              </section>
            </div>
          </section>

          <section className={`pane${activePane === 'pane-island' ? ' is-active' : ''}`} id="pane-island" role="tabpanel" aria-labelledby="settings-tab-island" hidden={activePane !== 'pane-island'}>
            <div className="col">
              <section className="sec" aria-labelledby="ps-placement-title">
                <h2 className="sec-title" id="ps-placement-title">موضع <bdi>Dynamic</bdi></h2>
                <div className="card pad stack" aria-busy={placementLoading}>
                  <p className="lead">اختر موضع العرض التلقائي أو اضبطه يدويًا بدقة.</p>
                  <div className="glass seg card-seg" role="radiogroup" aria-label="وضع الموضع" style={{ '--n': 2, '--i': islandPlacement.mode === 'manual' ? 1 : 0, '--R': '26px' }}>
                    <span className="rim on-glass seg-thumb" aria-hidden="true" />
                    <button className="seg-item" type="button" role="radio" aria-checked={islandPlacement.mode === 'auto'} aria-selected={islandPlacement.mode === 'auto'} disabled={placementLoading} onClick={() => chooseIslandPlacementMode('auto')}><bdi>Auto</bdi></button>
                    <button className="seg-item" type="button" role="radio" aria-checked={islandPlacement.mode === 'manual'} aria-selected={islandPlacement.mode === 'manual'} disabled={placementLoading} onClick={() => chooseIslandPlacementMode('manual')}>يدوي</button>
                  </div>

                  <div className="remote-panel">
                    <div className={`rim remote${islandPlacement.mode === 'auto' ? ' is-off' : ''}`} aria-label="موضع Dynamic" style={{ '--R': '124px' }}>
                      <button className="dp dp-up" type="button" aria-label="تحريك لأعلى" disabled={placementLoading || islandPlacement.mode !== 'manual'} onClick={() => nudgeIsland('up')}><Icon name="up" size={24} /></button>
                      <button className="dp dp-right" type="button" aria-label="تحريك لليمين" disabled={placementLoading || islandPlacement.mode !== 'manual'} onClick={() => nudgeIsland('right')}><Icon name="right" size={24} /></button>
                      <button className="dp dp-down" type="button" aria-label="تحريك لأسفل" disabled={placementLoading || islandPlacement.mode !== 'manual'} onClick={() => nudgeIsland('down')}><Icon name="down" size={24} /></button>
                      <button className="dp dp-left" type="button" aria-label="تحريك لليسار" disabled={placementLoading || islandPlacement.mode !== 'manual'} onClick={() => nudgeIsland('left')}><Icon name="left" size={24} /></button>
                      <div className="glass remote-core on-glass" aria-live="polite" style={{ '--R': '54px' }}>
                        <span className="cap">الموضع اليدوي</span>
                        <span className="xy" dir="ltr"><i>X</i><b>{formatPlacementOffset(islandPlacement.offsetX)}</b><em>px</em></span>
                        <span className="xy" dir="ltr"><i>Y</i><b>{formatPlacementOffset(islandPlacement.offsetY)}</b><em>px</em></span>
                      </div>
                    </div>
                  </div>
                  <p className="hint">كل ضغطة تحرّك الجزيرة ٢ بكسل منطقيًا بحركة سلسة. وضع <bdi>Auto</bdi> يعيد الحساب الافتراضي دون حذف إزاحتك اليدوية.</p>
                </div>
              </section>
            </div>

            <div className="col">
              <section className="sec" aria-labelledby="ps-appearance-title">
                <h2 className="sec-title" id="ps-appearance-title">مظهر <bdi>Dynamic</bdi></h2>
                <div className="card pad stack" aria-busy={appearanceLoading}>
                  <p className="lead">اختر مادة الجزيرة؛ يتغير السطح فقط وتبقى بقية تفاصيل التصميم كما هي.</p>
                  <div className="glass seg card-seg" role="radiogroup" aria-label="مادة الجزيرة" style={{ '--n': 2, '--i': islandAppearance === 'black' ? 1 : 0, '--R': '26px' }}>
                    <span className="rim on-glass seg-thumb" aria-hidden="true" />
                    <button className="seg-item" type="button" role="radio" aria-checked={islandAppearance === 'glass'} aria-selected={islandAppearance === 'glass'} disabled={appearanceLoading} onClick={() => chooseIslandAppearance('glass')}>زجاج</button>
                    <button className="seg-item" type="button" role="radio" aria-checked={islandAppearance === 'black'} aria-selected={islandAppearance === 'black'} disabled={appearanceLoading} onClick={() => chooseIslandAppearance('black')}>أسود صلب</button>
                  </div>
                  <p className="hint">وضع الزجاج يستخدم طبقة <bdi>CSS</bdi> الحالية دون تغيير. تمويه سطح المكتب خلف الجزيرة غير مضمون مع إبقاء النافذة غير مقفلة وتمرير النقرات كما هو.</p>
                </div>
              </section>
            </div>
          </section>
        </main>

      </div>
    </div>
  );
}
