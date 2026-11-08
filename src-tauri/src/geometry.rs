//! هندسة نافذة Dynamic Island على الشاشة الفعلية، بلا حجز لأي مساحة من Windows.

/// أبعاد مستطيل بالبكسل الفيزيائي.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Rect {
  pub left: i32,
  pub top: i32,
  pub right: i32,
  pub bottom: i32,
}

impl Rect {
  pub fn width(&self) -> i32 { (self.right - self.left).max(0) }
  pub fn height(&self) -> i32 { (self.bottom - self.top).max(0) }
}

/// ارتفاع مساحة الرسم الصغيرة داخل نافذة الجزيرة بوحدات CSS المنطقية.
/// يتضمن خلوصًا حول جسم الكبسولة فقط، بلا امتداد أو عنصر إضافي.
pub const COMPACT_STAGE_LOGICAL_HEIGHT: f64 = 38.0;
pub const CAPSULE_LOGICAL_HEIGHT: f64 = 24.0;
pub const ISLAND_MAX_LOGICAL_HEIGHT: f64 = 430.0;

/// يتحقق من أبعاد حاوية الجزيرة المنطقية التي يسمح بها أمر تغيير الحجم.
/// ارتفاعات اللوحات تشمل إزاحة الارتكاز وبكسل أمان للتقريب؛ الأدوات متغيرة الارتفاع.
pub fn is_supported_island_resize(width: f64, height: f64) -> bool {
  if !width.is_finite() || !height.is_finite() || height.fract() != 0.0 { return false; }
  let widths = [44.0, 112.0, 384.0, 396.0, 400.0, 432.0];
  let fixed_heights = [24.0, 38.0, 91.0, 178.0, 218.0];
  let tools_height = width == 432.0 && (228.0..=395.0).contains(&height);
  widths.contains(&width) && (fixed_heights.contains(&height) || tools_height)
}

fn safe_scale(scale: f64) -> f64 {
  if scale.is_finite() && (0.5..=4.0).contains(&scale) { scale } else { 1.0 }
}

/// يحوّل DPI إلى معامل مقياس؛ DPI غير صالح يعود إلى 100%.
pub fn scale_from_dpi(dpi: u32) -> f64 {
  if dpi == 0 { 1.0 } else { safe_scale(dpi as f64 / 96.0) }
}

/// ارتفاع نافذة المرحلة الصغيرة بالبكسل الفيزيائي.
pub fn compact_stage_height_px(scale: f64) -> i32 {
  (COMPACT_STAGE_LOGICAL_HEIGHT * safe_scale(scale)).round().max(1.0) as i32
}

/// إزاحة مركز الكبسولة عن أعلى الشاشة بالبكسل الفيزيائي، مع إبقاء الكسر.
/// المركز يطابق منتصف مرحلة CSS الصغيرة؛ يُحافظ على كسور DPI قبل تقريب النافذة.
pub fn compact_anchor_offset_px(scale: f64) -> f64 {
  (COMPACT_STAGE_LOGICAL_HEIGHT / 2.0) * safe_scale(scale)
}

/// الهامش البصري بين الكبسولة وحدود مرحلة الرسم الصغيرة.
pub fn compact_capsule_margin_px(scale: f64) -> i32 {
  (((COMPACT_STAGE_LOGICAL_HEIGHT - CAPSULE_LOGICAL_HEIGHT) / 2.0) * safe_scale(scale)).round() as i32
}

/// أعلى ارتفاع مسموح لحاوية الجزيرة الموسّعة بالبكسل الفيزيائي.
pub fn island_max_height_px(scale: f64) -> i32 {
  (ISLAND_MAX_LOGICAL_HEIGHT * safe_scale(scale)).round() as i32
}

/// يوسّط النافذة أفقيًا على الشاشة المحددة ويستخدم أصلها الرأسي الحقيقي.
/// إحداثيات الشاشة الثانوية قد تكون سالبة، لذلك لا تُستبدل بـ(0, 0).
pub fn island_origin(monitor_left: i32, monitor_top: i32, monitor_width: i32, island_width: i32) -> (i32, i32) {
  let centred = monitor_left as i64 + ((monitor_width as i64 - island_width as i64) / 2);
  (centred as i32, monitor_top)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn compact_stage_and_anchor_scale_with_dpi() {
    for dpi in [96u32, 120, 144, 192] {
      let scale = scale_from_dpi(dpi);
      let stage = compact_stage_height_px(scale);
      let capsule = (CAPSULE_LOGICAL_HEIGHT * scale).round() as i32;
      assert!(stage >= capsule, "dpi {dpi}: stage {stage}, capsule {capsule}");
      assert!(compact_capsule_margin_px(scale) >= 3, "dpi {dpi}: margin {}", compact_capsule_margin_px(scale));
      assert!(compact_anchor_offset_px(scale) > 0.0);
    }
    assert_eq!(compact_stage_height_px(1.0), 38);
    assert_eq!(compact_stage_height_px(1.25), 48);
    assert_eq!(compact_anchor_offset_px(1.0), 19.0);
    assert_eq!(compact_anchor_offset_px(1.25), 23.75);
    assert_eq!(compact_anchor_offset_px(1.5), 28.5);
  }

  #[test]
  fn compact_capsule_keeps_a_visible_gap_at_common_scales() {
    assert_eq!(compact_capsule_margin_px(1.0), 7);
    assert_eq!(compact_capsule_margin_px(1.25), 9);
    assert_eq!(compact_capsule_margin_px(1.5), 11);
  }

  #[test]
  fn resize_contract_accepts_only_restored_and_safety_padded_sizes() {
    for (width, height) in [(112.0, 38.0), (384.0, 218.0), (400.0, 178.0), (400.0, 218.0), (396.0, 91.0), (432.0, 228.0), (432.0, 395.0)] {
      assert!(is_supported_island_resize(width, height), "unexpected rejection: {width}x{height}");
    }
    for (width, height) in [(40.0, 38.0), (100.0, 38.0), (346.0, 218.0), (384.0, 210.0), (400.0, 169.0), (432.0, 227.0), (432.0, 396.0), (432.0, 278.5)] {
      assert!(!is_supported_island_resize(width, height), "unexpected acceptance: {width}x{height}");
    }
  }

  #[test]
  fn island_is_centered_on_the_selected_monitor_and_uses_its_true_origin() {
    let (x, y) = island_origin(0, 0, 1920, 70);
    assert_eq!((x, y), (925, 0));
    let (x, y) = island_origin(1920, -1080, 1920, 70);
    assert_eq!((x, y), (1920 + 925, -1080));
  }

  #[test]
  fn centering_stays_whole_pixels_with_odd_widths() {
    let (x, y) = island_origin(-1920, 0, 1921, 70);
    assert_eq!((x, y), (-1920 + 925, 0));
  }

  #[test]
  fn expanded_states_have_room_without_changing_compact_stage() {
    assert_eq!(compact_stage_height_px(1.25), 48);
    assert!(island_max_height_px(1.25) >= 537);
  }

  #[test]
  fn invalid_scale_falls_back_to_one_hundred_percent() {
    assert_eq!(scale_from_dpi(0), 1.0);
    assert_eq!(scale_from_dpi(20), 1.0);
    assert_eq!(scale_from_dpi(9999), 1.0);
    assert_eq!(compact_stage_height_px(f64::NAN), 38);
  }
}
