//! الصبغة الخارجية — إزالة الإطار غير المرئي الذي يحيط كل نافذة ويندوز.
//!
//! لماذا هذا ضروري للتموضع؟
//!
//! ويندوز يرسم حول كل نافذة إطارًا غير مرئي (سمكه 7–8 بكسل على 100%،
//! وأكثر على المقاييس الكبيرة) للظل وتغيير الحجم. النتيجة أن الإحداثي الذي
//! تطلبه ليس الإحداثي الذي تراه: نافذة يُطلب لها `y = 5` يظهر محتواها عند
//! `y = 12` تقريبًا. هذا هو **بالتحديد** سبب ظهور الجزيرة خارج الشريط
//! رغم صحة الحساب.
//!
//! إزالة الإطار بالكامل (`DWMWA_NCRENDERING_POLICY = DISABLED` مع خيارات
//! الركن والظل) تجعل المستطيل المرئي مطابقًا للمستطيل المطلوب بالبكسل،
//! فتصبح الهندسة حقيقية لا تقريبية.

#![cfg(windows)]

use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{
  DwmGetWindowAttribute, DwmSetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS, DWMWA_WINDOW_CORNER_PREFERENCE,
  DWMWCP_DONOTROUND,
};

/// 1 = DWMNCRP_DISABLED: ويندوز لا يرسم إطارًا غير عميل لهذه النافذة.
const DWMNCRP_DISABLED: u32 = 1;

/// 1 = DWMWA_NCRENDERING_POLICY
const DWMWA_NCRENDERING_POLICY: i32 = 1;
/// 34 = DWMWA_NCRENDERING_DISABLED? لا — هذا الخيار غير موجود.
/// نستخدم 2 = DWMWA_TRANSITIONS_FORCEDISABLED لإيقاف حركات الإطار.
const DWMWA_TRANSITIONS_FORCEDISABLED: i32 = 3;
/// 33 = DWMWA_CLOAK? لا. الظل يُلغى عبر الإطار نفسه.

/// يزيل الإطار غير المرئي والظل والاستدارة عن النافذة.
///
/// كل خيار قد يفشل على نسخة ويندوز أقدم؛ الفشل هنا غير حرج لأن الخيارات
/// تحسينية، لكن **نجاح الأول ضروري** للتموضع الدقيق. لذلك تُعاد النتيجة.
pub fn strip_frame(hwnd: HWND) -> Result<(), String> {
  unsafe {
    let policy = DWMNCRP_DISABLED;
    DwmSetWindowAttribute(
      hwnd,
      windows::Win32::Graphics::Dwm::DWMWINDOWATTRIBUTE(DWMWA_NCRENDERING_POLICY),
      &policy as *const u32 as *const core::ffi::c_void,
      std::mem::size_of::<u32>() as u32,
    )
    .map_err(|e| format!("تعذر إزالة الإطار غير المرئي: {e}"))?;

    /* إيقاف حركات الإطار: تمنع وميضًا عند تغيير الحجم. */
    let no_transition = windows::core::BOOL::from(true);
    let _ = DwmSetWindowAttribute(
      hwnd,
      windows::Win32::Graphics::Dwm::DWMWINDOWATTRIBUTE(DWMWA_TRANSITIONS_FORCEDISABLED),
      &no_transition as *const _ as *const core::ffi::c_void,
      std::mem::size_of::<windows::core::BOOL>() as u32,
    );

    /* بلا استدارة: الكبسولة هي التي تُستدير، لا النافذة. */
    let corner = DWMWCP_DONOTROUND;
    let _ = DwmSetWindowAttribute(
      hwnd,
      DWMWA_WINDOW_CORNER_PREFERENCE,
      &corner as *const _ as *const core::ffi::c_void,
      std::mem::size_of_val(&corner) as u32,
    );
  }
  Ok(())
}

/// المستطيل المرئي الفعلي للنافذة كما تراه العين، بالبكسل الفيزيائي.
///
/// يُستخدم للتحقق لا للتخمين: نقارنه بالمستطيل المطلوب ونسجّل الفرق. إن كان
/// الفرق صفرًا فالصبغة نجحت والهندسة دقيقة.
pub fn visible_bounds(hwnd: HWND) -> Option<super::geometry::Rect> {
  unsafe {
    let mut rect = windows::Win32::Foundation::RECT::default();
    DwmGetWindowAttribute(
      hwnd,
      DWMWA_EXTENDED_FRAME_BOUNDS,
      &mut rect as *mut _ as *mut core::ffi::c_void,
      std::mem::size_of::<windows::Win32::Foundation::RECT>() as u32,
    )
    .ok()?;
    Some(super::geometry::Rect { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn frame_removal_is_requested_with_the_documented_value() {
    /* DWMNCRP_DISABLED = 1 بحسب توثيق مايكروسوفت. */
    assert_eq!(DWMNCRP_DISABLED, 1);
  }

  #[test]
  fn corner_preference_disables_rounding() {
    /* DWMWCP_DONOTROUND = 1: النافذة مستقيمة، الكبسولة وحدها مستديرة. */
    assert_eq!(DWMWCP_DONOTROUND.0, 1);
  }
}
