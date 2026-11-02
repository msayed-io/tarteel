//! تمرير النقرات — لماذا كانت النوافذ «معطّلة» في أعلاها.
//!
//! نافذة الجزيرة شفافة بصريًا (`transparent(true)`) لكنها **ليست شفافة
//! للنقر**. حجمها 480×262 منطقية، أي 600×327 بكسل فيزيائية على مقياس
//! 125%. أي أن مستطيلًا بعرض 600 بكسل وارتفاع 327 يجلس فوق الشاشة، ويبتلع
//! كل نقرة تقع فيه ولو كان ما تحته مرئيًا بوضوح.
//!
//! هذا هو السبب الجذري لما وصفه المستخدم: «نص النوافذ معطّل في الأعلى».
//! النص مقروء لأن النافذة شفافة، لكن النقر لا يصل إلى النافذة التي تحته لأن
//! نافذتنا فوقها وهي دائمة البقاء في المقدمة.
//!
//! الحل القياسي في ويندوز: معالجة `WM_NCHITTEST`. لكل نقطة يسأل ويندوز
//! النافذة «هل تريدين هذه النقطة؟». نجيب `HTTRANSPARENT` للنقاط التي لا
//! يوجد فيها شيء مرئي، فيتخطاها ويندوز ويمرّر النقرة إلى ما تحتها. أما
//! النقاط التي عليها الكبسولة فتُترك للنافذة فتبقى قابلة للنقر.
//!
//! القرار يُتخذ داخل النافذة نفسها، حيث تعرف الواجهة شكل الكبسولة بالضبط،
//! ثم يُبلَّغ للخادم عبر استدعاء واحد عند كل تغيير حالة.

use std::sync::atomic::{AtomicI32, AtomicBool, Ordering};

/// مستطيل المنطقة التفاعلية بالبكسل الفيزيائي داخل النافذة.
///
/// 0 عرض أو 0 ارتفاع تعني «لا شيء تفاعلي»، أي تمرير كل النقرات.
static INTERACTIVE: AtomicI32 = AtomicI32::new(0);
static INTERACTIVE_W: AtomicI32 = AtomicI32::new(0);
static INTERACTIVE_H: AtomicI32 = AtomicI32::new(0);
/// هل تُمرَّر النقرات خارج المنطقة التفاعلية؟ مطفأ يعني النافذة تلتقط الكل.
static PASS_THROUGH: AtomicBool = AtomicBool::new(true);

/// يضبط المستطيل التفاعلي (الكبسولة المرئية) بالبكسل الفيزيائي.
pub fn set_interactive_rect(x: i32, y: i32, width: i32, height: i32) {
  INTERACTIVE.store(x.max(0), Ordering::SeqCst);
  INTERACTIVE_W.store(width.max(0), Ordering::SeqCst);
  INTERACTIVE_H.store(height.max(0), Ordering::SeqCst);
}

/// القراءة الحالية — للاختبار وللتحقق.
pub fn interactive_rect() -> (i32, i32, i32, i32) {
  (
    INTERACTIVE.load(Ordering::SeqCst),
    0,
    INTERACTIVE_W.load(Ordering::SeqCst),
    INTERACTIVE_H.load(Ordering::SeqCst),
  )
}

/// تفعيل أو إيقاف تمرير النقرات.
///
/// الإيقاف مطلوب في الحالات الموسّعة: لوحة المشغّل والمواقيت يجب أن تلتقط
/// نقراتها كلها، فلا معنى لتمريرها.
pub fn set_pass_through(enabled: bool) {
  PASS_THROUGH.store(enabled, Ordering::SeqCst);
}

pub fn pass_through() -> bool {
  PASS_THROUGH.load(Ordering::SeqCst)
}

/// هل هذه النقطة تقع داخل الكبسولة المرئية؟
///
/// منطق خالص بلا ويندوز، مكتوب ليُختبر: كل خطأ بكسل واحد هنا يعني إما
/// نقرة ضائعة أو نقرة تتسرب إلى نافذة خلفية.
pub fn point_is_interactive(x: i32, y: i32, rect: (i32, i32, i32, i32)) -> bool {
  let (rx, ry, rw, rh) = rect;
  if rw <= 0 || rh <= 0 {
    return false;
  }
  x >= rx && x < rx + rw && y >= ry && y < ry + rh
}

/// القرار الذي يتخذه `WM_NCHITTEST`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hit {
  /// النقطة على الكبسولة: النافذة تلتقطها.
  Interactive,
  /// لا شيء مرئي هنا: تمرّر إلى ما تحت النافذة.
  Transparent,
}

/// يحوّل نقطة الشاشة إلى إحداثي داخل النافذة ثم يقرر.
pub fn decide(local_x: i32, local_y: i32) -> Hit {
  if !pass_through() {
    return Hit::Interactive;
  }
  if point_is_interactive(local_x, local_y, interactive_rect()) {
    Hit::Interactive
  } else {
    Hit::Transparent
  }
}

#[cfg(windows)]
mod imp {
  use windows::Win32::Foundation::{HWND, LPARAM, LRESULT};
  use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
  use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, HTTRANSPARENT, WM_NCHITTEST};

  /// معرّف فريد لهذه المعالجة، يمنع تعارضها مع معالجات أخرى.
  const SUBCLASS_ID: usize = 0x7A11_7E11;

  /// المعالج الذي يقرر مصير كل نقرة.
  ///
  /// `lparam` يحتوي إحداثي الشاشة: النصف السفلي x والنصف العلوي y، وكلاهما
  /// بإشارة. نحوّلهما إلى إحداثي داخل النافذة ثم نمرّر القرار إلى المنطق
  /// الخالص أعلاه.
  unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: LPARAM,
    _id: usize,
    _ref: usize,
  ) -> LRESULT {
    if msg == WM_NCHITTEST {
      let screen_x = (lparam.0 & 0xFFFF) as u16 as i16 as i32;
      let screen_y = ((lparam.0 >> 16) & 0xFFFF) as u16 as i16 as i32;
      let mut rect = windows::Win32::Foundation::RECT::default();
      if GetWindowRect(hwnd, &mut rect).is_ok() {
        let local_x = screen_x - rect.left;
        let local_y = screen_y - rect.top;
        if super::decide(local_x, local_y) == super::Hit::Transparent {
          return LRESULT(HTTRANSPARENT as isize);
        }
      }
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
  }

  /// يُثبّت المعالجة على نافذة الجزيرة.
  pub fn attach(hwnd: HWND) -> Result<(), String> {
    let ok = unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0) };
    if ok.as_bool() {
      Ok(())
    } else {
      Err("تعذر تثبيت معالجة النقرات على نافذة الجزيرة".into())
    }
  }

  /// يزيلها عند الإغلاق.
  pub fn detach(hwnd: HWND) {
    unsafe {
      let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
    }
  }
}

#[cfg(windows)]
pub use imp::{attach, detach};

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_point_inside_the_capsule_is_interactive() {
    let rect = (250, 0, 100, 36);
    assert!(point_is_interactive(250, 0, rect), "الزاوية العليا اليسرى داخل");
    assert!(point_is_interactive(349, 35, rect), "الزاوية السفلى اليمنى داخل");
    assert!(point_is_interactive(300, 18, rect), "المنتصف داخل");
  }

  #[test]
  fn a_point_outside_the_capsule_is_transparent() {
    let rect = (250, 0, 100, 36);
    /* هذه هي النقاط التي كانت تبتلع نقرات المستخدم. */
    assert!(!point_is_interactive(0, 0, rect));
    assert!(!point_is_interactive(249, 10, rect), "بكسل واحد يسار الكبسولة");
    assert!(!point_is_interactive(350, 10, rect), "بكسل واحد يمين الكبسولة");
    assert!(!point_is_interactive(300, 36, rect), "بكسل واحد أسفل الكبسولة");
  }

  #[test]
  fn the_whole_window_passes_through_when_no_rect_is_set() {
    /* قبل أن تُبلّغ الواجهة عن الكبسولة، لا يجوز ابتلاع أي نقرة. */
    assert_eq!(decide(10, 10), Hit::Transparent);
  }

  #[test]
  fn a_zero_sized_rect_passes_everything() {
    assert!(!point_is_interactive(5, 5, (0, 0, 0, 0)));
    assert!(!point_is_interactive(5, 5, (0, 0, 100, 0)));
  }

  #[test]
  fn expanded_states_can_disable_pass_through_entirely() {
    /* لوحة المشغّل تحتاج كل نقراتها، فلا نمرّر شيئًا. */
    set_pass_through(false);
    assert_eq!(decide(9999, 9999), Hit::Interactive);
    set_pass_through(true);
    assert_eq!(decide(9999, 9999), Hit::Transparent);
  }

  #[test]
  fn interactive_rect_round_trips() {
    set_interactive_rect(100, 5, 120, 40);
    let (x, _, w, h) = interactive_rect();
    assert_eq!((x, w, h), (100, 120, 40));
    set_interactive_rect(0, 0, 0, 0);
  }
}
