//! إشعارات ويندوز 11 بنمط المنبّه (`<toast scenario="alarm">`).
//!
//! لماذا WinRT لا PowerShell؟
//! لأن PowerShell يبني إشعارًا عاديًا يختفي في مركز الإشعارات ويحترم
//! «عدم الإزعاج». أما هذا النمط فيُصنَّف منبّهًا في نظام ويندوز نفسه:
//!   • يظهر فوق جميع النوافذ بما فيها الألعاب بملء الشاشة.
//!   • يبقى على الشاشة حتى يتفاعل المستخدم معه.
//!   • يتجاوز Focus Assist / Do Not Disturb.
//!
//! يحتاج تطبيق سطح مكتب كلاسيكي وجود اختصار في قائمة ابدأ بمعرّف AppUserModelID
//! صريح، وإلا رفض ويندوز الإشعار. لذلك نُنشئ الاختصار تلقائيًا عند أول إقلاع.
//!
//! ملاحظة معمارية: هذا الملف مستقل تمامًا عن منظومة الموقع والتوقيت.

#![cfg(windows)]

use std::path::PathBuf;

/// معرّف التطبيق في ويندوز. يجب أن يطابق `identifier` في tauri.conf.json.
pub const APP_ID: &str = "com.tarteel.desktop";

/// معرّفات أزرار الإشعار التفاعلية.
pub const ACTION_SILENCE: &str = "tarteel-silence-adhan";
pub const ACTION_OPEN: &str = "tarteel-open-app";

/// يبني XML المنبّه.
///
/// الدالة منفصلة عن الإرسال لتكون قابلة للاختبار بلا ويندوز ولا WinRT:
/// نتحقق من الوسم `scenario="alarm"` ومن الأزرار داخل النص الناتج.
///
/// @param title عنوان الإشعار (اسم الصلاة)
/// @param body نص قصير
pub fn build_alarm_xml(title: &str, body: &str) -> String {
  /* الهروب إلزامي: عناوين الصلوات عربية وقد يحمل النص محارف خاصة. */
  let title = escape_xml(title);
  let body = escape_xml(body);

  format!(
    r#"<toast scenario="alarm" launch="tarteel://adhan" activationType="foreground">
  <visual>
    <binding template="ToastGeneric">
      <text>{title}</text>
      <text>{body}</text>
    </binding>
  </visual>
  <actions>
    <action content="إسكات الأذان" arguments="{ACTION_SILENCE}" activationType="background"/>
    <action content="فتح تَرتيل" arguments="{ACTION_OPEN}" activationType="foreground"/>
  </actions>
  <audio src="ms-winsoundevent:Notification.Looping.Alarm2" loop="true"/>
</toast>"#
  )
}

/// هروب محارف XML الخمسة الأساسية.
fn escape_xml(value: &str) -> String {
  value
    .replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
    .replace('"', "&quot;")
    .replace('\'', "&apos;")
}

/// مسار اختصار قائمة ابدأ الذي يطلبه ويندوز لتسجيل المعرّف.
pub fn shortcut_path() -> Option<PathBuf> {
  let appdata = std::env::var_os("APPDATA")?;
  let mut path = PathBuf::from(appdata);
  path.push("Microsoft");
  path.push("Windows");
  path.push("Start Menu");
  path.push("Programs");
  path.push("Tarteel.lnk");
  Some(path)
}

/// يُنشئ اختصار قائمة ابدأ إن لم يكن موجودًا.
///
/// بدونه يرفض ويندوز إشعارات سطح المكتب بصمت — وهو أشهر سبب لفشل
/// `toast scenario="alarm"` في التطبيقات غير المعبّأة داخل المتجر.
pub fn ensure_start_menu_shortcut() -> Result<(), String> {
  let Some(path) = shortcut_path() else { return Err("تعذر تحديد مجلد APPDATA".into()) };
  if path.exists() {
    return Ok(());
  }
  let exe = std::env::current_exe().map_err(|e| format!("تعذر تحديد مسار التطبيق: {e}"))?;
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("تعذر إنشاء مجلد الاختصارات: {e}"))?;
  }
  create_shortcut(&exe, &path, APP_ID)
}

/// يكتب ملف `.lnk` بصيغة IShellLink عبر COM.
#[cfg(windows)]
fn create_shortcut(exe: &std::path::Path, link: &std::path::Path, app_id: &str) -> Result<(), String> {
  use windows::core::{Interface, HSTRING, PCWSTR};
  use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
  };
  use windows::Win32::UI::Shell::{
    FileSystem, IShellLinkW, SetCurrentDirectoryW, ShellLink, PROPERTYKEY,
  };
  use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;

  /* PKEY_AppUserModel_ID = {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 5 */
  const PKEY_APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
    fmtid: windows::core::GUID::from_u128(0x9F4C2855_9F79_4B39_A8D0_E1D42DE1D5F3),
    pid: 5,
  };

  unsafe {
    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    let result = (|| -> Result<(), String> {
      let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
        .map_err(|e| format!("تعذر إنشاء IShellLink: {e}"))?;

      let exe_wide: Vec<u16> = exe.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
      shell_link
        .SetPath(PCWSTR(exe_wide.as_ptr()))
        .map_err(|e| format!("تعذر ضبط مسار الاختصار: {e}"))?;

      if let Some(dir) = exe.parent() {
        let dir_wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let _ = shell_link.SetWorkingDirectory(PCWSTR(dir_wide.as_ptr()));
      }

      let store: IPropertyStore = shell_link
        .cast()
        .map_err(|e| format!("تعذر الوصول إلى خصائص الاختصار: {e}"))?;
      let app_id_value = windows::core::PROPVARIANT::from(HSTRING::from(app_id));
      store
        .SetValue(&PKEY_APP_USER_MODEL_ID, &app_id_value)
        .map_err(|e| format!("تعذر ضبط معرّف التطبيق: {e}"))?;
      store.Commit().map_err(|e| format!("تعذر حفظ خصائص الاختصار: {e}"))?;

      let link_wide: Vec<u16> = link.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
      let persist: windows::Win32::UI::Shell::IPersistFile = shell_link
        .cast()
        .map_err(|e| format!("تعذر تحويل واجهة الاختصار: {e}"))?;
      persist
        .Save(PCWSTR(link_wide.as_ptr()), true)
        .map_err(|e| format!("تعذر حفظ ملف الاختصار: {e}"))?;
      Ok(())
    })();
    CoUninitialize();
    result
  }
}

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

/// يُرسل إشعار المنبّه عبر WinRT.
///
/// يفشل بهدوء عند غياب الدعم حتى لا يُسقط الأذان نفسه: الصوت يعمل مستقلاً.
pub fn show_alarm_toast(title: &str, body: &str) -> Result<(), String> {
  use windows::core::HSTRING;
  use windows::Data::Xml::Dom::XmlDocument;
  use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

  ensure_start_menu_shortcut()?;

  unsafe {
    let xml = XmlDocument::new().map_err(|e| format!("تعذر إنشاء مستند الإشعار: {e}"))?;
    xml.LoadXml(&HSTRING::from(build_alarm_xml(title, body)))
      .map_err(|e| format!("تعذر تحميل XML الإشعار: {e}"))?;

    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))
      .map_err(|e| format!("تعذر إنشاء مُنشئ الإشعارات: {e}"))?;
    let toast = ToastNotification::CreateToastNotification(&xml)
      .map_err(|e| format!("تعذر إنشاء الإشعار: {e}"))?;
    notifier
      .Show(&toast)
      .map_err(|e| format!("تعذر عرض الإشعار: {e}"))?;
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn alarm_xml_uses_the_alarm_scenario() {
    let xml = build_alarm_xml("حان وقت صلاة الفجر", "حان موعد الصلاة وفق موقعك.");
    assert!(xml.contains(r#"scenario="alarm""#), "نمط المنبّه إلزامي");
    assert!(xml.contains("حان وقت صلاة الفجر"));
  }

  #[test]
  fn alarm_xml_has_both_interactive_buttons() {
    let xml = build_alarm_xml("الفجر", "نص");
    assert!(xml.contains(ACTION_SILENCE));
    assert!(xml.contains(ACTION_OPEN));
    assert!(xml.contains("إسكات الأذان"));
    assert!(xml.contains("فتح تَرتيل"));
  }

  #[test]
  fn alarm_xml_loops_the_alarm_sound() {
    let xml = build_alarm_xml("الفجر", "نص");
    assert!(xml.contains(r#"loop="true""#));
    assert!(xml.contains("ms-winsoundevent:Notification.Looping.Alarm2"));
  }

  #[test]
  fn dangerous_characters_are_escaped() {
    let xml = build_alarm_xml(r#"a & b <tag> "q""#, "x");
    assert!(xml.contains("a &amp; b &lt;tag&gt; &quot;q&quot;"));
    assert!(!xml.contains("<tag>"));
  }

  #[test]
  fn shortcut_targets_the_expected_folder() {
    let path = shortcut_path();
    /* يعتمد على APPDATA وهو موجود في بيئة CI. */
    if let Some(path) = path {
      assert!(path.to_string_lossy().contains("Start Menu"));
      assert!(path.to_string_lossy().ends_with("Tarteel.lnk"));
    }
  }
}
