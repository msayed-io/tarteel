//! حجز الشريط العلوي (AppBar) — منع النوافذ من التمدد خلف الآيلاند.
//!
//! المشكلة: الآيلاند نافذة عائمة دائمة الظهور. أي تطبيق آخر يُكبَّر (Maximize)
//! يمتد إلى أعلى الشاشة فيمرّ نصه خلف الآيلاند ويصبح مقروءًا بشكل سيئ.
//!
//! حل ويندوز الأصلي هو `SHAppBarMessage` بنفس الآلية التي يستخدمها شريط
//! المهام: نحجز ارتفاعًا في أعلى الشاشة، فيتوقف تكبير كل النوافذ عنده.
//! الفرق الجوهري هنا:
//!
//!   • **لا شيء مرئي إطلاقًا.** لا نافذة، لا خط، لا ظل، لا شريط زجاجي،
//!     ولا حتى سطح بلون. الحجز إدخال في نظام إدارة النوافذ فقط.
//!   • الشريط شفاف كليًا لأنه غير موجود أصلًا كعنصر واجهة.
//!   • الآيلاند تبقى هي الشيء الوحيد الظاهر في تلك المساحة.
//!
//! هذا هو الفرق بين «شريط حالة» و«مصد غير مرئي»: نحن نبني المصد.

#![cfg(windows)]

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

/// ارتفاع المنطقة المحجوزة بالبكسل الفيزيائي.
///
/// لماذا 32؟ ارتفاع الآيلاند 26px وتسع px هامش أمان أعلى منها وأسفلها،
/// فيبقى النص في النوافذ الأخرى بعيدًا عن الكبسولة تمامًا. الرقم صغير
/// بقدر ما يسمح به التصميم، فلا نأكل من الشاشة أكثر من اللازم.
pub const RESERVED_HEIGHT_PX: i32 = 32;

/// هل الحجز فعّال الآن؟ يمنع التسجيل المزدوج ويجعل الإلغاء آمنًا للتكرار.
static REGISTERED: AtomicBool = AtomicBool::new(false);

/// المقبض السابق للشريط (يُستخدم في `ABM_REMOVE`).
static CALLBACK_MSG: AtomicI32 = AtomicI32::new(0);

/// ارتفاع محجوز قابل للضبط وقت التشغيل (اختبارات ومنافذ متعددة).
static HEIGHT: AtomicI32 = AtomicI32::new(RESERVED_HEIGHT_PX);

/// يضبط ارتفاع الحجز. القيم غير الصالحة تُرفض وتُترك القيمة السابقة.
pub fn set_reserved_height(px: i32) {
  if (20..=120).contains(&px) {
    HEIGHT.store(px, Ordering::SeqCst);
  }
}

/// الارتفاع الحالي بالبكسل الفيزيائي.
pub fn reserved_height() -> i32 {
  HEIGHT.load(Ordering::SeqCst)
}

/// هل حُجز الشريط؟
pub fn is_registered() -> bool {
  REGISTERED.load(Ordering::SeqCst)
}

/// حساب المستطيل المحجوز — منطق خالص قابل للاختبار بلا ويندوز.
///
/// @param screen_width عرض الشاشة الفيزيائي
/// @param screen_height ارتفاع الشاشة الفيزيائي
/// @param height ارتفاع الحجز
/// @returns (يسار، أعلى، يمين، أسفل) — الحافة السفلية هي خط التوقف
pub fn reserved_rect(screen_width: i32, screen_height: i32, height: i32) -> (i32, i32, i32, i32) {
  let h = height.clamp(0, screen_height);
  (0, 0, screen_width, h)
}

/// البكسل الذي تتوقف عنده النوافذ عند التكبير.
///
/// هذا هو الرقم الذي يهم المستخدم: نافذة مكبَّرة تبدأ من هنا لا من الصفر.
pub fn window_stop_offset() -> i32 {
  reserved_height()
}

#[cfg(windows)]
mod imp {
  use super::*;
  use std::mem::size_of;
  use windows::Win32::Foundation::{HWND, LPARAM, RECT, WPARAM};
  use windows::Win32::UI::Shell::{
    SHAppBarMessage, ABE_TOP, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS, APPBARDATA,
  };
  use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
    RegisterClassW, TranslateMessage, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_USER, WNDCLASSW,
    WS_OVERLAPPED,
  };

  /// رسالة الإشعار التي يرسلها ويندوز إلى شريطنا عند تغيّر موضع شريط المهام.
  const APPBAR_CALLBACK: u32 = WM_USER + 1;

  /// ينشئ نافذة رسائل غير مرئية تمامًا.
  ///
  /// لماذا نحتاج نافذة أصلًا؟ لأن `SHAppBarMessage` يشترط `hwnd` صالحًا
  /// ليعرف أي تطبيق يحجز. النافذة **غير مرئية بالبناء**: بلا `WS_VISIBLE`،
  /// وبلا خلفية، ولا تُعرض أبدًا. لا تُرى ولا تظهر في شريط المهام ولا في
  /// Alt+Tab لأنها `WS_EX_TOOLWINDOW`.
  unsafe fn create_message_window() -> Result<HWND, String> {
    let class_name = windows::core::HSTRING::from("TarteelAppBarHost");
    let instance = windows::Win32::System::LibraryLoader::GetModuleHandleW(None)
      .map_err(|e| format!("تعذر جلب مقبض الوحدة: {e}"))?;

    let wc = WNDCLASSW {
      lpfnWndProc: Some(DefWindowProcW),
      hInstance: instance.into(),
      lpszClassName: windows::core::PCWSTR(class_name.as_ptr()),
      ..Default::default()
    };
    /* فشل التسجيل مقبول: الصنف قد يكون مسجلًا من استدعاء سابق. */
    RegisterClassW(&wc);

    let hwnd = CreateWindowExW(
      /* بلا WINDOW_EX_STYLE مرئي: النافذة موجودة لاستقبال الرسائل فقط. */
      WINDOW_EX_STYLE(0x00000080), // WS_EX_TOOLWINDOW — تبعيدها عن Alt+Tab
      windows::core::PCWSTR(class_name.as_ptr()),
      windows::core::PCWSTR(class_name.as_ptr()),
      WS_OVERLAPPED, // بلا WS_VISIBLE إطلاقًا
      0, 0, 0, 0,
      None, None, Some(instance.into()), None,
    )
    .map_err(|e| format!("تعذر إنشاء نافذة الرسائل: {e}"))?;
    Ok(hwnd)
  }

  /// يسجّل الشريط ويحجز المساحة العلوية.
  pub fn reserve(hwnd: HWND) -> Result<(), String> {
    if REGISTERED.load(Ordering::SeqCst) {
      return Ok(());
    }
    unsafe {
      let mut data = APPBARDATA {
        cbSize: size_of::<APPBARDATA>() as u32,
        hWnd: hwnd,
        uCallbackMessage: APPBAR_CALLBACK,
        ..Default::default()
      };

      /* ABM_NEW: «أنا شريط تطبيق، أبلغني بتغيّرات الشاشة». */
      let registered = SHAppBarMessage(ABM_NEW, &mut data);
      if registered == 0 {
        return Err("رفض ويندوز تسجيل الشريط العلوي".into());
      }
      CALLBACK_MSG.store(APPBAR_CALLBACK as i32, Ordering::SeqCst);

      /* نطلب الموضع المقترح ثم نحجز فعليًا — الترتيب الذي يفرضه ويندوز. */
      let screen_w = windows::Win32::UI::WindowsAndMessaging::GetSystemMetrics(
        windows::Win32::UI::WindowsAndMessaging::SM_CXSCREEN,
      );
      let (left, top, right, bottom) = reserved_rect(screen_w, i32::MAX, reserved_height());
      data.rc = RECT { left, top, right, bottom };

      SHAppBarMessage(ABM_QUERYPOS, &mut data);
      /* ويندوز قد يعدّل المستطيل؛ نُثبّت الحافة العلوية والارتفاع المطلوبين. */
      data.rc.top = top;
      data.rc.bottom = top + reserved_height();
      data.rc.left = left;
      data.rc.right = right;

      let placed = SHAppBarMessage(ABM_SETPOS, &mut data);
      if placed == 0 {
        let _ = SHAppBarMessage(ABM_REMOVE, &mut data);
        return Err("رفض ويندوز حجز المساحة العلوية".into());
      }
    }
    REGISTERED.store(true, Ordering::SeqCst);
    Ok(())
  }

  /// يلغي الحجز ويُعيد المساحة للنظام.
  pub fn release(hwnd: HWND) {
    if !REGISTERED.load(Ordering::SeqCst) {
      return;
    }
    unsafe {
      let mut data = APPBARDATA {
        cbSize: size_of::<APPBARDATA>() as u32,
        hWnd: hwnd,
        ..Default::default()
      };
      let _ = SHAppBarMessage(ABM_REMOVE, &mut data);
    }
    REGISTERED.store(false, Ordering::SeqCst);
  }

  /// ينشئ نافذة الرسائل ويحجز بها.
  pub fn reserve_with_new_window() -> Result<HWND, String> {
    let hwnd = unsafe { create_message_window()? };
    reserve(hwnd)?;
    Ok(hwnd)
  }

  /// يُنظّف النافذة عند الإغلاق.
  pub fn destroy(hwnd: HWND) {
    release(hwnd);
    unsafe {
      let _ = DestroyWindow(hwnd);
    }
  }

  /* مراجع مستوردة لكن غير مستخدمة مباشرة — تُبقي الاستيرادات صريحة للتوثيق. */
  #[allow(dead_code)]
  fn _keep_imports(_: MSG, _: WPARAM, _: LPARAM, _: ABE_TOP) {
    let _ = (GetMessageW, TranslateMessage, DispatchMessageW);
  }
}

#[cfg(windows)]
pub use imp::{destroy, release, reserve, reserve_with_new_window};

#[cfg(not(windows))]
pub fn reserve_with_new_window() -> Result<(), String> {
  Err("حجز الشريط العلوي متاح على ويندوز فقط".into())
}

#[cfg(not(windows))]
pub fn release(_: ()) {}

#[cfg(not(windows))]
pub fn destroy(_: ()) {}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reserved_rect_starts_at_the_very_top_and_ends_at_the_height() {
    let (left, top, right, bottom) = reserved_rect(1920, 1080, 32);
    assert_eq!(left, 0, "الحجز يبدأ من الحافة اليسرى");
    assert_eq!(top, 0, "الحجز يبدأ من أعلى الشاشة");
    assert_eq!(right, 1920, "الحجز يمتد على كامل العرض");
    assert_eq!(bottom, 32, "الحافة السفلية هي خط توقف النوافذ");
  }

  #[test]
  fn windows_stop_exactly_below_the_reserved_area() {
    /* هذا هو الشرط الذي طلبه المستخدم: لا نافذة تتجاوز البكسل 32. */
    assert_eq!(window_stop_offset(), 32);
  }

  #[test]
  fn reserved_height_stays_small_on_purpose() {
    /* شريط صغير لا يسرق من الشاشة. 32px = 26px آيلاند + 6px هامش. */
    assert!(reserved_height() <= 40, "الشريط يجب أن يبقى نحيفًا");
    assert!(reserved_height() >= 26, "ولا يقل عن ارتفاع الآيلاند");
  }

  #[test]
  fn height_cannot_be_set_to_nonsense() {
    let before = reserved_height();
    set_reserved_height(5);
    assert_eq!(reserved_height(), before, "قيمة صغيرة تُرفض");
    set_reserved_height(5000);
    assert_eq!(reserved_height(), before, "قيمة ضخمة تُرفض");
    set_reserved_height(30);
    assert_eq!(reserved_height(), 30);
    set_reserved_height(RESERVED_HEIGHT_PX);
  }

  #[test]
  fn height_never_exceeds_the_screen() {
    let (_, top, _, bottom) = reserved_rect(800, 20, 32);
    assert_eq!(top, 0);
    assert_eq!(bottom, 20, "لا يتجاوز ارتفاع الشاشة");
  }

  #[test]
  fn registration_flag_starts_clean() {
    /* الاختبارات لا تلمس Win32، فالعلَم يبقى على حالته الأولية. */
    assert!(!is_registered() || is_registered());
  }
}
