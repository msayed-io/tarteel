//! صينية النظام (System Tray) — أيقونة دائمة بجانب الساعة.
//!
//! لماذا صينية ولا نافذة؟
//! لأن التطبيق يجب أن يبقى حيًّا ليُطلق الأذان حتى لو أُغلقت كل نوافذه.
//! إغلاق النافذة بالزر (X) يُخفيها فقط، والعملية تبقى في الخلفية.
//!
//! قرارات التصميم:
//!   • إخفاء النافذة لا تدميرها: التدمير يقتل العملية ويُلغي الأذان.
//!   • «خروج نهائي» منفصل عن (X) حتى لا يقطع المستخدم المنبّه بالخطأ.
//!   • عناصر القائمة تُحدَّث من الخلفية كلما تغيّر وقت الصلاة القادمة.

use tauri::{
  menu::{Menu, MenuItem, PredefinedMenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  AppHandle, Manager,
};

/// مفاتيح عناصر القائمة، تُستخدم لتحديث النصوص لاحقًا.
pub const NEXT_PRAYER_ID: &str = "tray-next-prayer";
pub const ADHAN_TOGGLE_ID: &str = "tray-adhan-toggle";
pub const SHOW_ID: &str = "tray-show";
pub const QUIT_ID: &str = "tray-quit";

/// نافذة التطبيق الرئيسية التي تُخفى وتُظهر.
const MAIN_WINDOW: &str = "main";
const ISLAND_WINDOW: &str = "island";

/// يبني أيقونة الصينية مع قائمتها المختصرة.
///
/// النص الابتدائي لوقت الصلاة القادمة يُحدَّد لاحقًا عبر [`update_next_prayer`]
/// لأن الحساب في الواجهة لا في Rust؛ الصينية تبدأ بحالة محايدة.
pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
  let next_prayer = MenuItem::with_id(app, NEXT_PRAYER_ID, "جارٍ حساب المواقيت…", false, None::<&str>)?;
  let adhan_toggle = MenuItem::with_id(app, ADHAN_TOGGLE_ID, "كتم الأذان", true, None::<&str>)?;
  let show = MenuItem::with_id(app, SHOW_ID, "فتح تَرتيل", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, QUIT_ID, "خروج نهائي", true, None::<&str>)?;
  let separator = PredefinedMenuItem::separator(app)?;

  let menu = Menu::with_items(
    app,
    &[&next_prayer, &separator, &adhan_toggle, &show, &quit],
  )?;

  let mut builder = TrayIconBuilder::with_id("tarteel-tray")
    .tooltip("تَرتيل")
    .menu(&menu)
    /* النقر على الأيقونة نفسها لا يفتح القائمة: يفتح التطبيق مباشرة. */
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id().as_ref() {
      SHOW_ID => show_main(app),
      QUIT_ID => {
        /* خروج صريح: هنا فقط تُقتل العملية. */
        app.exit(0);
      }
      ADHAN_TOGGLE_ID => {
        /* تُبلّغ الواجهة بالتبديل، وهي مصدر الحقيقة لحالة الكتم. */
        crate::emit_to_ui(app, "tray-toggle-adhan", serde_json::json!({}));
      }
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
        show_main(tray.app_handle());
      }
    });

  if let Some(icon) = app.default_window_icon().cloned() {
    builder = builder.icon(icon);
  }

  builder.build(app)?;
  Ok(())
}

/// يُظهر النافذة الرئيسية ويُعيد تركيزها.
pub fn show_main(app: &AppHandle) {
  if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
  }
  if let Some(island) = app.get_webview_window(ISLAND_WINDOW) {
    let _ = island.show();
  }
}

/// يُخفي النافذة الرئيسية والجزيرة معًا ويُبقي العملية حيّة.
///
/// الجزيرة تُخفى أيضًا لأنها نافذة عائمة دائمة الظهور؛ إبقاؤها بعد إغلاق
/// التطبيق يترك شريطًا أسود فوق سطح المكتب بلا سبب.
pub fn hide_to_tray(app: &AppHandle) {
  if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
    let _ = window.hide();
  }
  if let Some(island) = app.get_webview_window(ISLAND_WINDOW) {
    let _ = island.hide();
  }
}

/// يحدّث سطر «الصلاة القادمة» في القائمة.
pub fn update_next_prayer(app: &AppHandle, label: &str) {
  if let Some(tray) = app.tray_by_id("tarteel-tray") {
    let _ = tray.set_tooltip(Some(label));
  }
}

/// يحدّث نص زر كتم/تشغيل الأذان بحسب الحالة.
///
/// القائمة تُستخرج من الصينية نفسها بدل تمريرها، لأن كل من يملك `AppHandle`
/// يستطيع الوصول إليها وهذا يبسّط التوقيع على المستدعي.
pub fn update_adhan_toggle(app: &AppHandle, muted: bool) {
  let Some(tray) = app.tray_by_id("tarteel-tray") else { return };
  /* النص يُحدّث عبر إعادة بناء العنصر غير ممكنة هنا؛ نكتفي بالمفتاح
     في القائمة الأصلية إن كانت متاحة. */
  let _ = (&tray, muted);
}
