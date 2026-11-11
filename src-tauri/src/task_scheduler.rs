//! تَرتيل — تكامل مجدول مهام ويندوز (Task Scheduler)
//! ==================================================
//!
//! لماذا مهام ويندوز وليس خيطًا داخل التطبيق؟
//! لأن الخيط يموت بموت العملية. مهمة ويندوز تعيش في خدمة النظام، فتُوقظ
//! التطبيق مخفيًا عند موعد الأذان حتى لو كان مغلقًا تمامًا أو الجهاز مقفلًا.
//!
//! نستخدم واجهة `schtasks.exe` الرسمية لأنها:
//!   • موجودة في كل نسخة Windows 11 بلا أي حزمة إضافية.
//!   • لا تتطلب رفع صلاحيات لمهام المستخدم الحالي.
//!   • تُدار عبر XML رسمي يمنحنا التحكم في كل خاصية نحتاجها.
//!
//! الخصائص المستخدمة في XML:
//!   • `<RunLevel>LeastPrivilege</RunLevel>` — لا نطلب admin عبثًا.
//!   • `<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>` —
//!     الأذان يجب أن يعمل على البطارية أيضًا.
//!   • `<StartWhenAvailable>true</StartWhenAvailable>` — يُنفّذ عند أول فرصة
//!     إن كان الجهاز نائمًا وقت الموعد.
//!   • `<WakeToRun>true</WakeToRun>` — إيقاظ الجهاز من السكون للن تطبيق.
//!   • `<Priority>4</Priority>` — أولوية عالية (المدى 0–10؛ 4 مرتفع بلا خطر).
//!   • `<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>` بلا حد زمني — التطبيق
//!     يبدأ مخفيًا ويبقى متاحًا لبقية المواعيد، ولا يُقطع ملف الأذان بعد دقيقتين.
//!
//! بادئة أسماء المهام `TarteelAdhan_` تجعل حذفها كله آمنًا ومحددًا، فلا نلمس
//! أي مهمة أخرى للمستخدم.

use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Command;

/// بادئة ثابتة لكل مهام تَرتيل. تُستخدم للتنظيف الآمن.
pub const TASK_PREFIX: &str = "TarteelAdhan_";

/// أقصى عدد مهام نُنشئها. 5 صلوات × 7 أيام = 35، ونمنح هامشًا.
pub const MAX_TASKS: usize = 60;

/// وصف مهمة أذان واحدة.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct TaskSpec {
    pub name: String,
    pub at_epoch_ms: i64,
    pub label: String,
}

fn stale_task_names(existing: &[String], desired: &[TaskSpec]) -> Vec<String> {
    let desired: HashSet<&str> = desired.iter().map(|spec| spec.name.as_str()).collect();
    existing
        .iter()
        .filter(|name| name.starts_with(TASK_PREFIX) && !desired.contains(name.as_str()))
        .cloned()
        .collect()
}

/// فشل في التفاعل مع مجدول المهام.
#[derive(Debug)]
pub struct TaskError(pub String);

impl std::fmt::Display for TaskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for TaskError {}

/// يبني اسم مهمة آمنًا من معرّف الحدث (تاريخ|مفتاح).
/// الأسماء تقبل الحروف والأرقام والشرطة فقط، فنستبدل كل ما عداها.
pub fn task_name_for(event_id: &str) -> String {
    let safe: String = event_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' })
        .collect();
    format!("{TASK_PREFIX}{safe}")
}

/// يحوّل لحظة مطلقة إلى توقيت محلي بصيغة ISO التي يفهمها schtasks (بلا منطقة).
/// نستخدم التوقيت المحلي لأن مهمة ويندوز تُقرأ بساعة الحائط المحلية.
#[cfg(windows)]
fn local_iso(epoch_ms: i64) -> Result<String, TaskError> {
    use windows::Win32::Foundation::{FILETIME, SYSTEMTIME};
    use windows::Win32::System::Time::{
        FileTimeToSystemTime, GetDynamicTimeZoneInformation,
        SystemTimeToTzSpecificLocalTimeEx, DYNAMIC_TIME_ZONE_INFORMATION,
        TIME_ZONE_ID_INVALID,
    };
    /* FILETIME = 100ns intervals since 1601-01-01 */
    let filetime = (epoch_ms as i128 + 11_644_473_600_000) * 10_000;
    let ft = FILETIME {
        dwLowDateTime: (filetime & 0xFFFF_FFFF) as u32,
        dwHighDateTime: ((filetime >> 32) & 0xFFFF_FFFF) as u32,
    };
    let mut utc = SYSTEMTIME::default();
    unsafe { FileTimeToSystemTime(&ft, &mut utc) }
        .map_err(|e| TaskError(format!("تعذر تحويل وقت المهمة إلى UTC: {e}")))?;
    let mut time_zone = DYNAMIC_TIME_ZONE_INFORMATION::default();
    let status = unsafe { GetDynamicTimeZoneInformation(&mut time_zone) };
    if status == TIME_ZONE_ID_INVALID {
        return Err(TaskError("تعذر قراءة منطقة التوقيت الحالية في Windows".into()));
    }
    let mut local = SYSTEMTIME::default();
    unsafe {
        SystemTimeToTzSpecificLocalTimeEx(Some(&time_zone), &utc, &mut local)
    }
    .map_err(|e| TaskError(format!("تعذر تحويل وقت المهمة إلى توقيت Windows المحلي: {e}")))?;
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        local.wYear, local.wMonth, local.wDay, local.wHour, local.wMinute, local.wSecond
    ))
}

/// يبني XML المهمة الكامل. مُفصول عن تنفيذ النظام ليكون قابلًا للاختبار.
pub fn build_task_xml(spec: &TaskSpec, exe_path: &str, local_start: &str) -> String {
    /* XML يتطلب &amp; و&lt; داخل المسارات. مسارات ويندوز قد تحتوي & في أسماء المستخدمين. */
    let exe = exe_path
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Tarteel</Author>
    <Description>تَرتيل — {label}</Description>
    <URI>\{name}</URI>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>{start}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{exe}</Command>
      <Arguments>--hidden --adhan-task "{id}"</Arguments>
    </Exec>
  </Actions>
</Task>"#,
        label = xml_escape(&spec.label),
        name = xml_escape(&spec.name),
        start = local_start,
        exe = exe,
        id = xml_escape(&spec.name),
    )
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// مسار التطبيق التنفيذي الحالي.
pub fn current_exe() -> Result<PathBuf, TaskError> {
    std::env::current_exe().map_err(|e| TaskError(format!("تعذر تحديد مسار تَرتيل: {e}")))
}

/* ------------------------------------------------------------------ *
 * تنفيذ schtasks
 * ------------------------------------------------------------------ */

#[cfg(windows)]
fn run_schtasks(args: &[&str]) -> Result<(), TaskError> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = Command::new("schtasks.exe")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| TaskError(format!("تعذر تشغيل مجدول مهام ويندوز: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(TaskError(format!(
            "رفض مجدول المهام الأمر: {}",
            stderr.trim()
        )));
    }
    Ok(())
}

/// ينشئ أو يحدّث مهمة واحدة.
#[cfg(windows)]
pub fn register_task(spec: &TaskSpec) -> Result<(), TaskError> {
    let exe = current_exe()?;
    let exe = exe.to_string_lossy().to_string();
    let start = local_iso(spec.at_epoch_ms)?;
    let xml = build_task_xml(spec, &exe, &start);

    /* نكتب XML بترميز UTF-16 لأن schtasks يرفض غير ذلك مع الأحرف العربية. */
    let xml_path = std::env::temp_dir().join(format!("{}.xml", spec.name));
    let mut bytes = Vec::with_capacity(xml.len() * 2 + 2);
    bytes.extend_from_slice(&[0xFF, 0xFE]);
    for unit in xml.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    std::fs::write(&xml_path, bytes)
        .map_err(|e| TaskError(format!("تعذر كتابة تعريف المهمة: {e}")))?;

    let result = run_schtasks(&[
        "/Create", "/TN", &spec.name, "/XML", &xml_path.to_string_lossy(), "/F",
    ]);
    let _ = std::fs::remove_file(&xml_path);
    result
}

/// يحذف مهمة واحدة. حذف مهمة غير موجودة ليس خطأً.
#[cfg(windows)]
pub fn delete_task(name: &str) -> Result<(), TaskError> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = Command::new("schtasks.exe")
        .args(["/Delete", "/TN", name, "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| TaskError(format!("تعذر تشغيل مجدول مهام ويندوز: {e}")))?;
    /* كود 1 مع "cannot find" يعني أنها غير موجودة — وهي حالة سليمة. */
    if !output.status.success() {
        let text = String::from_utf8_lossy(&output.stderr).to_lowercase();
        if text.contains("cannot find") || text.contains("لا يمكن العثور") || text.contains("not exist") {
            return Ok(());
        }
        return Err(TaskError(format!("تعذر حذف المهمة {name}")));
    }
    Ok(())
}

/// يسرد مهام تَرتيل الموجودة دون لمس مهام المستخدم الأخرى.
#[cfg(windows)]
fn list_tarteel_tasks() -> Result<Vec<String>, TaskError> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = Command::new("schtasks.exe")
        .args(["/Query", "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| TaskError(format!("تعذر قراءة مهام مجدول ويندوز: {e}")))?;
    let text = format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    if !output.status.success() {
        let lower = text.to_lowercase();
        if lower.contains("no scheduled tasks") || lower.contains("لا توجد مهام مجدولة") || lower.contains("nenhuma tarefa agendada") {
            return Ok(Vec::new());
        }
        return Err(TaskError(format!("تعذر قراءة المهام الموجودة من Windows Task Scheduler: {}", text.trim())));
    }
    Ok(text
        .lines()
        .filter_map(|line| line.split(',').next())
        .map(|first| first.trim().trim_matches('"').trim_start_matches('\\').to_string())
        .filter(|name| name.starts_with(TASK_PREFIX))
        .collect())
}

/// يحذف كل مهام تَرتيل فقط. يعتمد على البادئة، فلا يمسّ مهام المستخدم الأخرى.
#[cfg(windows)]
pub fn delete_all_tasks() -> usize {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Ok(output) = Command::new("schtasks.exe")
        .args(["/Query", "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return 0;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut removed = 0;
    for line in text.lines() {
        let Some(first) = line.split(',').next() else { continue };
        let name = first.trim().trim_matches('"').trim_start_matches('\\');
        if name.starts_with(TASK_PREFIX) && delete_task(name).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// يزامن مهام ويندوز مع الجدول المعطى.
/// تُحدّث المهام المطلوبة أولًا؛ لا تُحذف القديمة إلا بعد نجاح الإنشاء الكامل،
/// حتى لا نخسر التنبيهات العاملة عند رفض Windows لمهمة أو أكثر.
#[cfg(windows)]
pub fn sync_tasks(specs: &[TaskSpec]) -> Result<usize, TaskError> {
    let specs: Vec<TaskSpec> = specs.iter().take(MAX_TASKS).cloned().collect();
    let mut created = 0;
    let mut failures = Vec::new();
    for spec in &specs {
        match register_task(spec) {
            Ok(()) => created += 1,
            Err(error) => failures.push(format!("{}: {error}", spec.name)),
        }
    }
    if !failures.is_empty() {
        let details = failures.iter().take(3).cloned().collect::<Vec<_>>().join("؛ ");
        return Err(TaskError(format!(
            "تعذر إنشاء {} من {} مهمة أذان في Windows Task Scheduler؛ احتُفظ بالمهام السابقة. {}",
            failures.len(), specs.len(), details
        )));
    }
    let existing = list_tarteel_tasks()?;
    for name in stale_task_names(&existing, &specs) {
        delete_task(&name)?;
    }
    Ok(created)
}

/* بدائل غير ويندوز: تُبقي الواجهة صالحة للاختبار على أي نظام. */
#[cfg(not(windows))]
pub fn register_task(_spec: &TaskSpec) -> Result<(), TaskError> {
    Ok(())
}
#[cfg(not(windows))]
pub fn delete_task(_name: &str) -> Result<(), TaskError> {
    Ok(())
}
#[cfg(not(windows))]
pub fn delete_all_tasks() -> usize {
    0
}
#[cfg(not(windows))]
pub fn sync_tasks(_specs: &[TaskSpec]) -> Result<usize, TaskError> {
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_names_are_safe_for_windows() {
        let name = task_name_for("2026-10-31|fajr");
        assert_eq!(name, "TarteelAdhan_2026_10_31_fajr");
        assert!(name.starts_with(TASK_PREFIX));
        assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    }

    #[test]
    fn task_name_never_empty_for_odd_ids() {
        let name = task_name_for("|مفتاح غريب|");
        assert!(name.starts_with(TASK_PREFIX));
        assert!(name.len() > TASK_PREFIX.len());
    }

    #[test]
    fn stale_cleanup_keeps_desired_tasks_and_other_users_tasks() {
        let desired = TaskSpec {
            name: "TarteelAdhan_2026_11_09_fajr".into(), at_epoch_ms: 1_800_000_000_000, label: "الفجر".into(),
        };
        let existing = vec![
            desired.name.clone(),
            "TarteelAdhan_2026_11_08_isha".into(),
            "OtherApplication_daily".into(),
        ];
        assert_eq!(stale_task_names(&existing, &[desired]), vec!["TarteelAdhan_2026_11_08_isha"]);
    }

    #[test]
    fn xml_contains_the_required_windows_11_settings() {
        let spec = TaskSpec {
            name: "TarteelAdhan_2026_10_31_fajr".into(),
            at_epoch_ms: 1_800_000_000_000,
            label: "الفجر".into(),
        };
        let xml = build_task_xml(&spec, r"C:\Program Files\Tarteel\tarteel.exe", "2026-10-31T04:52:00");
        assert!(xml.contains("<StartBoundary>2026-10-31T04:52:00</StartBoundary>"));
        assert!(xml.contains("<WakeToRun>true</WakeToRun>"));
        assert!(xml.contains("<StartWhenAvailable>true</StartWhenAvailable>"));
        assert!(xml.contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(xml.contains("<Priority>4</Priority>"));
        assert!(xml.contains("--adhan-task \"TarteelAdhan_2026_10_31_fajr\""));
        assert!(xml.contains("--hidden --adhan-task"));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(xml.contains("الفجر"));
    }

    #[test]
    fn xml_escapes_paths_with_ampersands() {
        let spec = TaskSpec { name: "TarteelAdhan_x".into(), at_epoch_ms: 0, label: "الفجر".into() };
        let xml = build_task_xml(&spec, r"C:\Tom & Jerry\tarteel.exe", "2026-10-31T04:52:00");
        assert!(xml.contains("Tom &amp; Jerry"));
        assert!(!xml.contains("Tom & Jerry"));
    }

    #[test]
    fn xml_is_well_formed_enough_to_count_balanced_tags() {
        let spec = TaskSpec { name: "TarteelAdhan_y".into(), at_epoch_ms: 0, label: "الظهر".into() };
        let xml = build_task_xml(&spec, r"C:\t\tarteel.exe", "2026-10-31T12:00:00");
        for tag in ["<Triggers>", "</Triggers>", "<Settings>", "</Settings>", "<Actions", "</Actions>"] {
            assert_eq!(xml.matches(tag).count(), 1, "tag {tag} must appear once");
        }
    }
}
