//! تمرير النقرات — لماذا كانت النوافذ «معطّلة» في أعلاها.
//!
//! نافذة الجزيرة شفافة بصريًا (`transparent(true)`) لكنها **ليست شفافة
//! للنقر**. بعد التوسيع يمكن أن تبقى نافذة WebView بأبعاد أكبر من الرسم
//! المطوي؛ لذلك لا يكفي الاعتماد على المستطيل الرسومي وحده لتمرير النقرات.
//!
//! هذا هو السبب الجذري لما وصفه المستخدم: «نص النوافذ معطّل في الأعلى».
//! النص مقروء لأن النافذة شفافة، لكن النقر لا يصل إلى النافذة التي تحته لأن
//! نافذتنا فوقها وهي دائمة البقاء في المقدمة.
//!
//! `WM_NCHITTEST` وحده غير كافٍ: نتيجة `HTTRANSPARENT` تمرر الإدخال إلى
//! نافذة من الخيط نفسه فقط، وليس إلى تطبيق آخر مثل Chrome. في الحالة
//! المطوية تُضبط لذلك منطقة HWND الأصلية بشكل الكبسولة، فيختار النظام
//! نافذة التطبيق الواقعة تحتها للنقاط خارج المنطقة. تزال المنطقة عند
//! التوسع كي تستقبل لوحة الجزيرة الموسعة كل نقراتها.

use std::sync::atomic::{AtomicI32, AtomicBool, Ordering};

#[cfg(test)]
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// مستطيل المنطقة التفاعلية بالبكسل الفيزيائي داخل النافذة.
///
/// 0 عرض أو 0 ارتفاع تعني «لا شيء تفاعلي»، أي تمرير كل النقرات.
static INTERACTIVE: AtomicI32 = AtomicI32::new(0);
static INTERACTIVE_Y: AtomicI32 = AtomicI32::new(0);
static INTERACTIVE_W: AtomicI32 = AtomicI32::new(0);
static INTERACTIVE_H: AtomicI32 = AtomicI32::new(0);
/// هل تُمرَّر النقرات خارج المنطقة التفاعلية؟ مطفأ يعني النافذة تلتقط الكل.
static PASS_THROUGH: AtomicBool = AtomicBool::new(true);

/// يضبط المستطيل التفاعلي (الكبسولة المرئية) بالبكسل الفيزيائي.
pub fn set_interactive_rect(x: i32, y: i32, width: i32, height: i32) {
  INTERACTIVE.store(x.max(0), Ordering::SeqCst);
  INTERACTIVE_Y.store(y.max(0), Ordering::SeqCst);
  INTERACTIVE_W.store(width.max(0), Ordering::SeqCst);
  INTERACTIVE_H.store(height.max(0), Ordering::SeqCst);
}

/// القراءة الحالية — للاختبار وللتحقق.
pub fn interactive_rect() -> (i32, i32, i32, i32) {
  (
    INTERACTIVE.load(Ordering::SeqCst),
    INTERACTIVE_Y.load(Ordering::SeqCst),
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

/// يوسّع منطقة القص بكسلين فيزيائيين كي تمر الحافة الملساء كاملة بلا قصّ.
pub fn expand_for_antialias_fringe(x: i32, y: i32, width: i32, height: i32, radius: i32) -> (i32, i32, i32, i32, i32) {
  let fringe = 2;
  (
    x.saturating_sub(fringe),
    y.saturating_sub(fringe),
    width.saturating_add(2 * fringe),
    height.saturating_add(2 * fringe),
    radius.saturating_add(fringe),
  )
}

fn rounded_region_ellipse_diameter(width: i32, height: i32, radius: i32) -> i32 {
  if width <= 0 || height <= 0 {
    return 0;
  }
    radius.max(0).min(width.min(height) / 2).saturating_mul(2)
}

#[cfg(windows)]
/// Applies a rounded native window region while the island is collapsed.
/// Unlike `HTTRANSPARENT`, the window manager excludes points outside this
/// region before choosing a target, including windows owned by other threads.
pub fn set_collapsed_window_region(
  hwnd: windows::Win32::Foundation::HWND,
  x: i32,
  y: i32,
  width: i32,
  height: i32,
  radius: i32,
) -> Result<(), String> {
  use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, HGDIOBJ, SetWindowRgn};

  if width <= 0 || height <= 0 {
    return clear_window_region(hwnd);
  }
  let ellipse = rounded_region_ellipse_diameter(width, height, radius);
  let region = unsafe { CreateRoundRectRgn(x, y, x + width, y + height, ellipse, ellipse) };
  if region.is_invalid() {
    return Err("تعذر إنشاء منطقة النقر المطابقة لشكل الجزيرة".into());
  }
  let applied = unsafe { SetWindowRgn(hwnd, Some(region), true) };
  if applied == 0 {
    let _ = unsafe { DeleteObject(HGDIOBJ(region.0)) };
    return Err("تعذر تطبيق منطقة النقر المطابقة لشكل الجزيرة".into());
  }
  Ok(())
}

/// Restores the full native window region before an expanded state is shown.
#[cfg(windows)]
pub fn clear_window_region(hwnd: windows::Win32::Foundation::HWND) -> Result<(), String> {
  use windows::Win32::Graphics::Gdi::SetWindowRgn;

  let cleared = unsafe { SetWindowRgn(hwnd, None, true) };
  if cleared == 0 {
    return Err("تعذر استعادة منطقة نافذة الجزيرة الموسعة".into());
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn native_rounding_matches_idle_and_music_shapes() {
    assert_eq!(rounded_region_ellipse_diameter(44, 24, 12), 24);
    assert_eq!(rounded_region_ellipse_diameter(112, 24, 11), 22);
    assert_eq!(rounded_region_ellipse_diameter(48, 28, 14), 28);
    assert_eq!(rounded_region_ellipse_diameter(116, 28, 13), 26);
  }

  #[test]
  fn native_region_leaves_a_two_pixel_fringe_around_the_css_edge() {
    assert_eq!(expand_for_antialias_fringe(2, 7, 44, 24, 12), (0, 5, 48, 28, 14));
    assert_eq!(expand_for_antialias_fringe(2, 7, 112, 24, 11), (0, 5, 116, 28, 13));
  }

  #[test]
  fn native_rounding_is_clamped_to_the_shorter_edge() {
    assert_eq!(rounded_region_ellipse_diameter(30, 20, 18), 20);
    assert_eq!(rounded_region_ellipse_diameter(0, 20, 9), 0);
  }

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
    let _guard = TEST_LOCK.lock().unwrap();
    /* قبل أن تُبلّغ الواجهة عن الكبسولة، لا يجوز ابتلاع أي نقرة. */
    set_interactive_rect(0, 0, 0, 0);
    set_pass_through(true);
    assert_eq!(decide(10, 10), Hit::Transparent);
  }

  #[test]
  fn a_zero_sized_rect_passes_everything() {
    assert!(!point_is_interactive(5, 5, (0, 0, 0, 0)));
    assert!(!point_is_interactive(5, 5, (0, 0, 100, 0)));
  }

  #[test]
  fn expanded_states_can_disable_pass_through_entirely() {
    let _guard = TEST_LOCK.lock().unwrap();
    /* لوحة المشغّل تحتاج كل نقراتها، فلا نمرّر شيئًا. */
    set_pass_through(false);
    assert_eq!(decide(9999, 9999), Hit::Interactive);
    set_pass_through(true);
    assert_eq!(decide(9999, 9999), Hit::Transparent);
  }

  #[test]
  fn interactive_rect_round_trips() {
    let _guard = TEST_LOCK.lock().unwrap();
    set_interactive_rect(100, 5, 120, 40);
    let rect = interactive_rect();
    assert_eq!(rect, (100, 5, 120, 40));
    assert!(point_is_interactive(100, 5, rect), "الحافة العليا تبدأ عند y المبلّغ عنه");
    assert!(!point_is_interactive(100, 4, rect), "لا تلتقط بكسلًا فوق الكبسولة");
    assert!(!point_is_interactive(100, 45, rect), "لا تلتقط بكسلًا تحت الكبسولة");
    set_interactive_rect(0, 0, 0, 0);
  }
}
