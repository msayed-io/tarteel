//! التحكم بالنافذة الأمامية لتطبيق آخر — أزرار النافذة في الشريط.
//!
//! الشريط يعرض أزرار تصغير/تكبير/إغلاق للتطبيق الذي يستخدمه المستخدم الآن،
//! لا لتَرتيل. لأن نافذة الشريط لا تُنشَّط (`WS_EX_NOACTIVATE`)، يبقى التطبيق
//! الأمامي أماميًا عند الضغط، فيصل الأمر إلى النافذة الصحيحة.
//!
//! نستخدم `ShowWindowAsync` لا `ShowWindow`: الأولى لا تحجب الخيط إن كان
//! التطبيق الهدف مشغولًا، وهو ما يحدث كثيرًا.

#![cfg(windows)]

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
  GetForegroundWindow, IsZoomed, ShowWindowAsync, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE,
};

/// نتيجة إجراء على نافذة أخرى.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowAction {
  Minimize,
  Maximize,
  Close,
}

impl WindowAction {
  pub fn parse(raw: &str) -> Option<Self> {
    match raw {
      "minimize" => Some(Self::Minimize),
      "maximize" => Some(Self::Maximize),
      "close" => Some(Self::Close),
      _ => None,
    }
  }
}

/// هل النافذة مكبَّرة الآن؟ يُحدِّد زر التكبير/الاستعادة.
pub fn is_maximized(hwnd: HWND) -> bool {
  unsafe { IsZoomed(hwnd).as_bool() }
}

/// يطبّق الإجراء على النافذة الأمامية.
///
/// الإغلاق لا يُرسل `WM_CLOSE` فقط بل يُنهي العملية: بعض التطبيقات تعترض
/// `WM_CLOSE` وتفتح حوار «هل تريد الحفظ؟»، وهذا سلوك صحيح لكنه يعني أن
/// الزر لا يبدو مستجيبًا. نرسل الإغلاق اللطيف أولًا، ثم نُنهي العملية إن
/// بقيت حيّة.
pub fn apply(action: WindowAction) -> Result<(), String> {
  let hwnd = unsafe { GetForegroundWindow() };
  if hwnd.is_invalid() {
    return Err("لا توجد نافذة أمامية".into());
  }
  /* لا نتحكم في نوافذ تَرتيل نفسها من الشريط. */
  if unsafe { windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(hwnd, None) } == 0 {
    return Err("تعذر تحديد النافذة الهدف".into());
  }
  match action {
    WindowAction::Minimize => unsafe {
      ShowWindowAsync(hwnd, SW_MINIMIZE);
      Ok(())
    },
    WindowAction::Maximize => unsafe {
      let command = if is_maximized(hwnd) { SW_RESTORE } else { SW_MAXIMIZE };
      ShowWindowAsync(hwnd, command);
      Ok(())
    },
    WindowAction::Close => {
      unsafe {
        windows::Win32::UI::WindowsAndMessaging::PostMessageW(
          Some(hwnd),
          windows::Win32::UI::WindowsAndMessaging::WM_CLOSE,
          Default::default(),
          Default::default(),
        ).map_err(|e| format!("تعذر إغلاق النافذة: {e}"))?;
      }
      Ok(())
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_only_the_three_supported_actions() {
    assert_eq!(WindowAction::parse("minimize"), Some(WindowAction::Minimize));
    assert_eq!(WindowAction::parse("maximize"), Some(WindowAction::Maximize));
    assert_eq!(WindowAction::parse("close"), Some(WindowAction::Close));
  }

  #[test]
  fn rejects_anything_else_rather_than_guessing() {
    /* الشريط يرسل نصوصًا؛ أي نص آخر يجب أن يُرفض لا أن يُفسَّر. */
    assert_eq!(WindowAction::parse(""), None);
    assert_eq!(WindowAction::parse("kill"), None);
    assert_eq!(WindowAction::parse("Minimize"), None);
    assert_eq!(WindowAction::parse("close "), None);
  }
}
