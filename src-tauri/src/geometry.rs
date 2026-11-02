//! هندسة الشريط العلوي — **مصدر واحد للحقيقة**.
//!
//! كل قرار في هذا الملف مبني على قياس فعلي من الشاشة، لا على تقدير.
//! القياسات التي كشفت الخللين السابقين:
//!
//!   • الجزيرة تظهر بعرض 70 بكسل وارتفاع 33 على شاشة مقياسها 125%.
//!     56 × 1.25 = 70 و26 × 1.25 = 32.5 ≈ 33. أي أن **ويندوز يضرب
//!     أبعاد النافذة في المقياس**، والنتيجة الفيزيائية أطول من الشريط
//!     المحجوز (32 ثابتة لا تتأثر بالمقياس). لذلك كانت الجزيرة أطول من
//!     الشريط ولا يمكن أن تدخله مهما صحّت المعادلة.
//!
//!   • أعلى الجزيرة يقيس 32 بالضبط، وهو أعلى منطقة عمل الشاشة. أي أن
//!     ويندوز لا يسمح بوضع نافذة عادية فوق `rcWork`، فالشرط الذي نطلبه
//!     (الجزيرة داخل الشريط) مستحيل تحقيقه بنافذة عادية.
//!
//! الحل المعماري: النافذة تصبح **بلا إطار ممتد** (DWM frame removed)،
//! وبذلك تصبح حدودها المرئية مطابقة لحدودها المنطقية، ويمكن وضعها في أي
//! بكسل — بما في ذلك داخل الشريط بالضبط.

/// أبعاد مستطيل بالبكسل الفيزيائي.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Rect {
  pub left: i32,
  pub top: i32,
  pub right: i32,
  pub bottom: i32,
}

impl Rect {
  pub fn width(&self) -> i32 {
    (self.right - self.left).max(0)
  }
  pub fn height(&self) -> i32 {
    (self.bottom - self.top).max(0)
  }
}

/// الإطار العلوي المرئي بوحدات التصميم المنطقية.
///
/// 28 = 20 للجزيرة الصغيرة + 4 فوقها + 4 تحتها. صغير بالقدر الذي طلبه
/// المستخدم («مش طويل ولا بياخد مساحة كبيرة») وكافٍ لعناصر مقروءة.
pub const BAR_LOGICAL_HEIGHT: f64 = 28.0;

/// أكبر ارتفاع تتوقعه الجزيرة، وهو التوسعة الكاملة (tools = 300).
pub const ISLAND_MAX_LOGICAL_HEIGHT: f64 = 300.0;

/// معامل المقياس من DPI.
///
/// 96 DPI = مقياس 100%. على 125% يُرجع 1.25، وعلى 150% يُرجع 1.5.
/// القيمة التالفة تُعامل كـ 100% بدلًا من إنتاج هندسة مجنونة.
pub fn scale_from_dpi(dpi: u32) -> f64 {
  if dpi == 0 {
    return 1.0;
  }
  let scale = dpi as f64 / 96.0;
  if scale.is_finite() && (0.5..=4.0).contains(&scale) {
    scale
  } else {
    1.0
  }
}

/// ارتفاع الشريط بالبكسل الفيزيائي.
///
/// **هذا هو السطر الذي كان مفقودًا.** الشريط كان يبقى 32 فيزيائية على كل
/// المقاييس، بينما الجزيرة تُضرب في المقياس فتصير 33 على 125%. الآن
/// الاثنان يشتقان من نفس المعامل، فتبقى العلاقة صحيحة على أي شاشة.
pub fn bar_height_px(scale: f64) -> i32 {
  let safe = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
  (BAR_LOGICAL_HEIGHT * safe).round().max(1.0) as i32
}

/// ارتفاع نافذة الجزيرة الفيزيائي الذي يضمن دخولها في الشريط.
///
/// النافذة لا تُملى عليها أبعاد من الخارج: هي تبدأ صغيرة وتكبر عند التوسعة.
/// لذلك نعطيها ارتفاع الشريط نفسه كحد أدنى، فتتمركز فيه بدقة. وبما أن
/// المحتوى داخلها يُرسم بمحاذاة أعلى الشريط، تظهر الكبسولة في منتصفه.
pub fn island_floor_height_px(scale: f64) -> i32 {
  bar_height_px(scale)
}

/// موضع الجزيرة: أفقياً في منتصف الشاشة تماماً، وعمودياً في أعلى الشريط.
///
/// @param monitor_left إحداثي الشاشة الأيسر (قد يكون سالباً على شاشة ثانية)
/// @param monitor_width عرض الشاشة الفيزيائي
/// @param island_width عرض نافذة الجزيرة الفيزيائي
pub fn island_origin(monitor_left: i32, monitor_width: i32, island_width: i32) -> (i32, i32) {
  /* القسمة على 2 بعد جمع اليسار: الفرق مقسوم على اثنين يبقى عدداً صحيحاً،
     فلا يظهر انزياح نصف بكسل على المقاييس الكسرية. */
  let centred = monitor_left as i64 + ((monitor_width as i64 - island_width as i64) / 2);
  (centred as i32, 0)
}

/// هل تقع النافذة كلها داخل الشريط؟
///
/// تُستخدم كفحص تحقق لا كتخمين: تُشغَّل بعد كل تغيير حجم وتُسجَّل النتيجة.
pub fn island_fits_in_bar(island_height: i32, bar_height: i32) -> bool {
  island_height > 0 && island_height <= bar_height
}

/// أقصى ارتفاع مسموح لنافذة الجزيرة عند التوسعة الكاملة.
pub fn island_max_height_px(scale: f64) -> i32 {
  let safe = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
  (ISLAND_MAX_LOGICAL_HEIGHT * safe).round() as i32
}

#[cfg(test)]
mod tests {
  use super::*;

  /* القياسات الحقيقية من شاشة المستخدم. كل اختبار هنا يمنع تكرار خلل
     ظهر فعلاً، لا خلل متخيَّل. */

  #[test]
  fn detects_a_125_percent_display_from_the_measured_capsule() {
    /* العرض المقيس 70 والمنطقي 56 => 70/56 = 1.25 */
    let scale = 70.0 / 56.0;
    assert_eq!(scale_from_dpi((96.0 * scale).round() as u32), 1.25);
  }

  #[test]
  fn bar_and_island_scale_together_so_the_island_fits() {
    /* الخلل القديم: شريط 32 ثابتة ضد جزيرة 33 على 125%. */
    for dpi in [96u32, 120, 144, 192] {
      let scale = scale_from_dpi(dpi);
      let band = bar_height_px(scale);
      let island = island_floor_height_px(scale);
      assert!(island_fits_in_bar(island, band), "dpi {dpi}: جزيرة {island} في شريط {band}");
      /* الهامش المطلوب: لا تقل المساحة الفارغة عن 6 بكسل فيزيائية. */
      assert!(band - island >= 6, "dpi {dpi}: هامش {band}-{island} صغير جدًا");
    }
  }

  #[test]
  fn bar_is_thin_at_every_scale() {
    /* طلب المستخدم: شريط نحيف لا يأكل الشاشة. */
    for dpi in [96u32, 120, 144, 192] {
      let band = bar_height_px(scale_from_dpi(dpi));
      assert!(band <= 56, "dpi {dpi}: الشريط {band} بكسل سميك");
    }
    assert_eq!(bar_height_px(1.0), 28);
    assert_eq!(bar_height_px(1.25), 35);
  }

  #[test]
  fn island_is_centred_on_the_screen_not_merely_inside_the_bar() {
    /* 1920 شاشة و70 جزيرة => 925 و925. */
    let (x, y) = island_origin(0, 1920, 70);
    assert_eq!(x, 925);
    assert_eq!(y, 0);
    assert_eq!(1920 - 70 - x, 925, "المسافتان متساويتان");
  }

  #[test]
  fn centring_holds_on_a_secondary_monitor() {
    /* شاشة ثانية يمين الشاشة الأولى تبدأ من 1920. */
    let (x, _) = island_origin(1920, 1920, 70);
    assert_eq!(x, 1920 + 925);
  }

  #[test]
  fn centring_stays_whole_pixels_with_odd_widths() {
    /* عرض فردي لا ينتج كسر بكسل، فلا تهتز الجزيرة. */
    let (x, _) = island_origin(0, 1921, 70);
    assert_eq!(x, 925);
  }

  #[test]
  fn island_taller_than_the_bar_is_rejected_by_the_check() {
    assert!(!island_fits_in_bar(33, 32), "الجزيرة القديمة: 33 داخل 32 مستحيل");
    assert!(island_fits_in_bar(20, 35));
  }

  #[test]
  fn expansion_states_still_have_room() {
    /* التوسعة الكاملة تتجاوز الشريط بالتصميم، والحد الأقصى يسمح بها. */
    assert!(island_max_height_px(1.25) >= 375);
  }

  #[test]
  fn nonsense_dpi_falls_back_to_one_hundred_percent() {
    assert_eq!(scale_from_dpi(0), 1.0);
    assert_eq!(scale_from_dpi(20), 1.0);
    assert_eq!(scale_from_dpi(9999), 1.0);
  }
}
