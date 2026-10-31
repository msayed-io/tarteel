//! تَرتيل — منظومة التنبيهات عالية الموثوقية
//! ===========================================
//!
//! ثلاثة مستويات تعمل معًا حتى لا يضيع أذان:
//!
//! 1. **جدولة مقيمة** (هذا الملف): خيط داخل العملية يفحص المواعيد كل 250ms.
//!    دقيق عندما يكون التطبيق أو أيقونة الصينية حيّة.
//!
//! 2. **مهام ويندوز المجدولة** (`task_scheduler`): مهمة تُوقظ عملية خفيفة عند
//!    كل موعد حتى لو كان التطبيق مغلقًا تمامًا، بأولوية عالية.
//!
//! 3. **إشعارات ويندوز التفاعلية**: تُصاغ من طبقة Tauri/Windows App SDK
//!    بسِيناريو منبّه، فتظهر فوق النوافذ وتتجاوز وضع عدم الإزعاج.
//!
//! المبدأ الحاكم: **لا يُطلق تنبيه مرتين، ولا يُفقد تنبيه واحد**. تُحفظ
//! المعرّفات المُطلقة على القرص قبل الإطلاق، ويُتحقَّق منها عند كل إقلاع.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// سقف التأخير المقبول لإطلاق منبّه فات. أي شيء أقدم يُسجَّل كمُطلق بلا صوت
/// حتى لا يصدم المستخدم بأذان بعد منتصف الليل. 90 ثانية: يغطي استئناف
/// الجهاز من السكون وتأخر الجدولة، ويمنع الإطلاق المتأخر المزعج.
pub const LATE_ALARM_GRACE_MS: i64 = 90 * 1000;

/// سقف عدد المعرّفات المحفوظة لمنع تضخّم الملف.
pub const MAX_FIRED_IDS: usize = 512;

/// أقصى عدد أحداث مقبول في تحديث واحد (5 صلوات × 366 يومًا).
pub const MAX_EVENTS: usize = 2000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AlarmEvent {
    /// معرّف فريد: `التاريخ|المفتاح` مثل `2026-10-31|fajr`.
    pub id: String,
    /// المفتاح الإنجليزي: fajr, dhuhr, asr, maghrib, isha.
    pub key: String,
    /// الاسم العربي للعرض.
    pub name: String,
    /// اللحظة المطلقة (epoch ms).
    pub at: i64,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AlarmState {
    pub events: Vec<AlarmEvent>,
    pub fired_ids: Vec<String>,
    pub sleep_deadline_ms: Option<i64>,
    /// آخر لحظة عرفها الجدول، لكشف قفزة ساعة النظام.
    pub last_seen_ms: Option<i64>,
}

/// نتيجة دورة فحص واحدة.
#[derive(Debug, Default, PartialEq)]
pub struct AlarmTick {
    /// أحداث حان وقتها ويجب إطلاق تنبيهها الآن.
    pub due: Vec<AlarmEvent>,
    /// أحداث فات وقتها أكثر من السماح: تُسجَّل كمُطلقة بلا صوت.
    pub skipped: Vec<AlarmEvent>,
    /// أحداث حان وقتها الآن.
    pub sleep_due: bool,
    pub changed: bool,
}

/// يفحص المواعيد المستحقة عند لحظة `now_ms`.
///
/// الحالات المعالَجة:
/// - الموعد لم يحن: يُترك.
/// - حان داخل نافذة السماح: يُطلق مرة واحدة.
/// - فات أكثر من السماح (جهاز كان مغلقًا/نائمًا): يُسجَّل كمُطلق **بلا صوت**،
///   فلا يزعج المستخدم ولا يعود للظهور بعد إعادة التشغيل.
pub fn tick(state: &mut AlarmState, now_ms: i64) -> AlarmTick {
    let mut fired: HashSet<&str> = state.fired_ids.iter().map(String::as_str).collect();
    let mut due = Vec::new();
    let mut skipped = Vec::new();
    let mut changed = false;

    for event in &state.events {
        if event.at > now_ms || fired.contains(event.id.as_str()) {
            continue;
        }
        let lateness = now_ms.saturating_sub(event.at);
        if lateness <= LATE_ALARM_GRACE_MS {
            due.push(event.clone());
        } else {
            skipped.push(event.clone());
        }
        state.fired_ids.push(event.id.clone());
        fired.insert(event.id.as_str());
        changed = true;
    }

    /* تقليم القائمة من الأقدم مع الحفاظ على السقف. */
    if state.fired_ids.len() > MAX_FIRED_IDS {
        let excess = state.fired_ids.len() - MAX_FIRED_IDS;
        state.fired_ids.drain(0..excess);
        changed = true;
    }

    let sleep_due = state.sleep_deadline_ms.is_some_and(|deadline| now_ms >= deadline);
    if sleep_due {
        state.sleep_deadline_ms = None;
        changed = true;
    }

    /* كشف قفزة ساعة النظام: فرق أكبر من ساعة بين دورتين يعني أن الجهاز نام أو
       أن الساعة عُدّلت. نُعيد ضبط آخر لحظة معروفة دون إطلاق أي شيء متأخر. */
    if let Some(previous) = state.last_seen_ms {
        if now_ms > previous + 3_600_000 {
            state.events.retain(|event| event.at > now_ms - LATE_ALARM_GRACE_MS);
            changed = true;
        }
    }
    if state.last_seen_ms != Some(now_ms) {
        state.last_seen_ms = Some(now_ms);
    }

    AlarmTick { due, skipped, sleep_due, changed }
}

/// يستبدل الجدول كله بعد التحقق. يرفض المعرّفات المكررة أو الفارغة.
pub fn apply_events(state: &mut AlarmState, mut events: Vec<AlarmEvent>) -> Result<(), String> {
    if events.len() > MAX_EVENTS {
        return Err(format!("رفضت الجدولة أكثر من {MAX_EVENTS} موعد في تحديث واحد."));
    }
    let mut seen = HashSet::new();
    for event in &events {
        if event.id.trim().is_empty() || event.name.trim().is_empty() {
            return Err("رفضت جدولة موعد ناقص المعرّف أو الاسم.".to_string());
        }
        if event.at <= 0 {
            return Err("رفضت جدولة موعد بلحظة غير صالحة.".to_string());
        }
        if !seen.insert(event.id.clone()) {
            return Err(format!("رفضت جدولة موعد مكرر المعرّف: {}", event.id));
        }
        /* لا يبقى في الجدول إلا ما هو مستقبل أو قريب جدًا. */
    }
    events.sort_by_key(|event| event.at);
    state.events = events;
    Ok(())
}

/// الموعد القادم بعد لحظة معيّنة.
pub fn next_event_after(state: &AlarmState, now_ms: i64) -> Option<&AlarmEvent> {
    state.events.iter().find(|event| event.at > now_ms)
}

/* ------------------------------------------------------------------ *
 * التخزين — كتابة ذرّية حتى لا يتلف الملف عند انقطاع الكهرباء
 * ------------------------------------------------------------------ */

/// يكتب الملف عبر ملف مؤقت + إعادة تسمية، فلا يوجد ملف نصف مكتوب أبدًا.
pub fn write_state(path: &Path, state: &AlarmState) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "مسار حالة التنبيهات غير صالح".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("تعذر إنشاء مجلد حالة التنبيهات: {e}"))?;
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| format!("تعذر ترميز حالة التنبيهات: {e}"))?;
    let temp = path.with_extension("tmp");
    fs::write(&temp, bytes).map_err(|e| format!("تعذر كتابة حالة التنبيهات: {e}"))?;
    fs::rename(&temp, path).map_err(|e| format!("تعذر تثبيت حالة التنبيهات: {e}"))
}

pub fn read_state(path: &Path) -> AlarmState {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<AlarmState>(&bytes) {
            Ok(state) => state,
            Err(error) => {
                eprintln!("Tarteel alarm state is corrupt, starting clean: {error}");
                AlarmState::default()
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => AlarmState::default(),
        Err(error) => {
            eprintln!("Tarteel alarm state unreadable: {error}");
            AlarmState::default()
        }
    }
}

/// حالة مشتركة بين الخيط والواجهة.
pub type SharedAlarm = Arc<Mutex<AlarmState>>;

/// موقع ملف الحالة داخل مجلد إعدادات التطبيق.
pub fn state_path(config_dir: &Path) -> PathBuf {
    config_dir.join("alarm-state.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: &str, at: i64) -> AlarmEvent {
        AlarmEvent { id: id.into(), key: "fajr".into(), name: "الفجر".into(), at }
    }

    #[test]
    fn fires_once_within_grace_window() {
        let mut state = AlarmState { events: vec![event("2026-10-31|fajr", 1_000_000)], ..Default::default() };
        let first = tick(&mut state, 1_000_000);
        assert_eq!(first.due.len(), 1);
        assert!(first.skipped.is_empty());
        let second = tick(&mut state, 1_000_500);
        assert!(second.due.is_empty(), "must not fire twice");
    }

    #[test]
    fn late_alarm_beyond_grace_is_recorded_without_sound() {
        let mut state = AlarmState { events: vec![event("old", 1_000_000)], ..Default::default() };
        let result = tick(&mut state, 1_000_000 + LATE_ALARM_GRACE_MS + 1);
        assert!(result.due.is_empty(), "a long-past alarm must not ring");
        assert_eq!(result.skipped.len(), 1);
        assert_eq!(state.fired_ids, vec!["old".to_string()]);
    }

    #[test]
    fn past_alarms_do_not_reappear_after_restart() {
        let mut state = AlarmState { events: vec![event("a", 500)], ..Default::default() };
        tick(&mut state, 600);
        let mut reloaded = state.clone();
        let again = tick(&mut reloaded, 700);
        assert!(again.due.is_empty());
    }

    #[test]
    fn sleep_deadline_fires_once_and_clears() {
        let mut state = AlarmState { sleep_deadline_ms: Some(5_000), ..Default::default() };
        let first = tick(&mut state, 5_000);
        assert!(first.sleep_due);
        assert_eq!(state.sleep_deadline_ms, None);
        assert!(!tick(&mut state, 6_000).sleep_due);
    }

    #[test]
    fn rejects_duplicate_and_empty_events() {
        let mut state = AlarmState::default();
        assert!(apply_events(&mut state, vec![event("x", 100), event("x", 200)]).is_err());
        assert!(apply_events(&mut state, vec![AlarmEvent { id: " ".into(), key: "fajr".into(), name: "الفجر".into(), at: 100 }]).is_err());
        assert!(apply_events(&mut state, vec![AlarmEvent { id: "y".into(), key: "fajr".into(), name: "".into(), at: 100 }]).is_err());
        assert!(apply_events(&mut state, vec![event("z", 0)]).is_err());
    }

    #[test]
    fn sorts_events_and_returns_the_next_one() {
        let mut state = AlarmState::default();
        apply_events(&mut state, vec![event("b", 200), event("a", 100)]).unwrap();
        assert_eq!(state.events[0].id, "a");
        assert_eq!(next_event_after(&state, 150).unwrap().id, "b");
        assert!(next_event_after(&state, 250).is_none());
    }

    #[test]
    fn detects_clock_jump_and_drops_stale_events() {
        let mut state = AlarmState {
            events: vec![event("past", 1_000), event("future", 10_000_000)],
            last_seen_ms: Some(1_000),
            ..Default::default()
        };
        let result = tick(&mut state, 1_000 + 7_200_000);
        assert!(result.changed);
        assert_eq!(state.events.len(), 1);
        assert_eq!(state.events[0].id, "future");
    }

    #[test]
    fn caps_the_fired_id_list() {
        let events: Vec<AlarmEvent> = (0..MAX_FIRED_IDS as i64 + 50)
            .map(|i| event(&format!("e{i}"), 1_000 + i))
            .collect();
        let mut state = AlarmState { events, ..Default::default() };
        tick(&mut state, 100_000);
        assert!(state.fired_ids.len() <= MAX_FIRED_IDS);
    }

    #[test]
    fn refuses_oversized_schedule() {
        let mut state = AlarmState::default();
        let events: Vec<AlarmEvent> = (0..MAX_EVENTS + 1).map(|i| event(&format!("e{i}"), 1_000 + i as i64)).collect();
        assert!(apply_events(&mut state, events).is_err());
    }

    #[test]
    fn writes_and_reads_atomically() {
        let dir = std::env::temp_dir().join(format!("tarteel-alarm-test-{}", std::process::id()));
        let path = state_path(&dir);
        let state = AlarmState {
            events: vec![event("2026-11-01|fajr", 42)],
            fired_ids: vec!["x".into()],
            sleep_deadline_ms: Some(99),
            last_seen_ms: Some(7),
        };
        write_state(&path, &state).unwrap();
        let loaded = read_state(&path);
        assert_eq!(loaded.events, state.events);
        assert_eq!(loaded.fired_ids, state.fired_ids);
        assert_eq!(loaded.sleep_deadline_ms, Some(99));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_state_file_falls_back_to_default() {
        let dir = std::env::temp_dir().join(format!("tarteel-alarm-corrupt-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = state_path(&dir);
        fs::write(&path, b"{not json").unwrap();
        let state = read_state(&path);
        assert!(state.events.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
