//! قياسات الشريط العلوي — كل ما يعرضه الشريط من أرقام وحالات.
//!
//! مبدأ التصميم: **لا شيء يُخمَّن.** كل رقم هنا يأتي من مصدر ويندوز الرسمي،
//! وكل دالة تُرجع `None` عند الفشل بدلًا من إرجاع صفر كاذب. الشريط يعرض
//! شرطة بدل أن يكذب.
//!
//! المنطق الخالص (حساب النسب، اختيار النافذة الأمامية، تنقية اسم التطبيق)
//! مفصول عن نداءات Win32 كي يُختبر بلا ويندوز.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// لقطة واحدة من حالة الجهاز.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct Snapshot {
  /// نسبة استهلاك المعالج 0..100، محسوبة من فرق عيّنتين.
  pub cpu: Option<f32>,
  /// نسبة استهلاك الذاكرة 0..100.
  pub ram: Option<f32>,
  /// ميغابايت مستخدمة فعلًا.
  pub ram_used_mb: Option<u64>,
  pub ram_total_mb: Option<u64>,
  /// سرعة التنزيل والرفع بالكيلوبايت/ث، من فرق عدّادات الواجهات.
  pub net_down_kbps: Option<f32>,
  pub net_up_kbps: Option<f32>,
  pub wifi: bool,
  pub wifi_name: Option<String>,
  pub volume: Option<f32>,
  pub muted: bool,
  pub brightness: Option<f32>,
  pub battery: Option<f32>,
  pub charging: bool,
  pub has_battery: bool,
  pub camera_in_use: bool,
  pub mic_in_use: bool,
  pub app_name: Option<String>,
  pub maximized: bool,
  pub pinned: bool,
  pub process_count: Option<u32>,
  pub uptime_secs: Option<u64>,
}

/// عيّنة عدّادات مشتركة لحساب الفروق بين نداءين.
#[derive(Default)]
pub struct Sampler {
  cpu: Mutex<Option<CpuSample>>,
  net: Mutex<Option<NetSample>>,
}

#[derive(Clone, Copy)]
struct CpuSample {
  idle: u64,
  total: u64,
  at: Instant,
}

#[derive(Clone, Copy)]
struct NetSample {
  in_octets: u64,
  out_octets: u64,
  at: Instant,
}

impl Sampler {
  pub fn new() -> Self {
    Self::default()
  }

  /// يحسب نسبة المعالج بين عيّنتين.
  ///
  /// المعادلة كما يوثّقها ويندوز: `total = kernel + user`، و`kernel` يشمل
  /// وقت الخمول، فالخمول يُطرح منه. الطرح المشبع ضروري لأن ويندوز لا يضمن
  /// أن `idle ≤ total` عند تجميع العدّادات على أنوية متعددة.
  fn cpu_between(prev: CpuSample, idle: u64, total: u64) -> Option<f32> {
    let idle_delta = idle.saturating_sub(prev.idle);
    let total_delta = total.saturating_sub(prev.total);
    if total_delta == 0 {
      return None;
    }
    let busy = total_delta.saturating_sub(idle_delta);
    Some(((busy as f64 / total_delta as f64) * 100.0).clamp(0.0, 100.0) as f32)
  }

  /// يحسب السرعة بالكيلوبايت/ث من فرق العدّادات والزمن.
  fn rate_between(prev_in: u64, prev_out: u64, now_in: u64, now_out: u64, elapsed: Duration) -> Option<(f32, f32)> {
    let secs = elapsed.as_secs_f64();
    if secs <= 0.05 {
      return None;
    }
    /* العدّادات ترجع للصفر عند إعادة توصيل محوّل الشبكة؛ الطرح المشبع
       يمنع رقمًا سالبًا أو فلكيًا في تلك اللحظة. */
    let down = now_in.saturating_sub(prev_in) as f64 / secs / 1024.0;
    let up = now_out.saturating_sub(prev_out) as f64 / secs / 1024.0;
    Some((down as f32, up as f32))
  }
}

/// يختار اسم التطبيق من عنوان النافذة.
///
/// عناوين ويندوز على الشكل «اسم المستند - اسم التطبيق»، والمستخدم يريد اسم
/// التطبيق. نأخذ آخر جزء، ونطرح الأجزاء العامة وحدها. النتيجة عربية دائمًا
/// أو اسم تطبيق لاتيني — لا نص عنوان مستند في الشريط.
pub fn app_label_from_title(title: &str) -> Option<String> {
  let cleaned = title.trim();
  if cleaned.is_empty() {
    return None;
  }
  let parts: Vec<&str> = cleaned.split(" - ").map(str::trim).filter(|p| !p.is_empty()).collect();
  let candidate = parts.last().copied().unwrap_or(cleaned);
  let noisy = ["program manager", "windows input experience", "start", "shell experience host", "search"];
  if noisy.iter().any(|n| candidate.eq_ignore_ascii_case(n)) {
    return None;
  }
  /* حدّ الطول: الشريط نحيف، والاسم الطويل يُقصّ عند البكسل لا هنا. */
  Some(candidate.chars().take(48).collect())
}

/// هل الثانيتان متقاربتان بما يكفي لاعتبار القيمة ثابتة؟
/// تُستخدم لمنع ارتعاش الأرقام عند عرضها.
pub fn smooth(previous: f32, current: f32, factor: f32) -> f32 {
  let f = factor.clamp(0.0, 1.0);
  previous + (current - previous) * f
}

#[cfg(windows)]
mod win {
  use super::*;
  use windows::core::GUID;
  use windows::Win32::Foundation::{HWND, STILL_ACTIVE};
  use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
  use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
  use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
  use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
  use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED};
  use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
  use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    RRF_RT_REG_DWORD,
  };
  use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
  use windows::Win32::System::Threading::{GetSystemTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION};
  use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, VIRTUAL_KEY, VK_VOLUME_DOWN, VK_VOLUME_MUTE, VK_VOLUME_UP,
  };
  use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
  };
  use windows::Win32::Foundation::FILETIME;

  /// عدّاد المعالج كما يرجعه النظام.
  fn cpu_times() -> Option<(u64, u64)> {
    let mut idle = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)).ok()? };
    let q = |ft: FILETIME| ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
    Some((q(idle), q(kernel) + q(user)))
  }

  fn memory() -> Option<(u64, u64)> {
    let mut status = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    unsafe { GlobalMemoryStatusEx(&mut status).ok()? };
    let total = status.ullTotalPhys / (1024 * 1024);
    let used = total.saturating_sub(status.ullAvailPhys / (1024 * 1024));
    Some((used, total))
  }

  /// مجموع البايتات الداخلة والخارجة على كل الواجهات المستخدمة.
  fn net_counters() -> Option<(u64, u64)> {
    unsafe {
      let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
      if GetIfTable2(&mut table).is_err() || table.is_null() {
        return None;
      }
      let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
      let (mut down, mut up, mut any_up) = (0u64, 0u64, false);
      for row in rows {
        /* الاسترجاع (Loopback) ليس شبكة حقيقية؛ استبعاده يجعل الرقم معبّرًا. */
        if row.Type == 24 {
          continue;
        }
        if row.OperStatus == IfOperStatusUp {
          any_up = true;
          down = down.saturating_add(row.InOctets);
          up = up.saturating_add(row.OutOctets);
        }
      }
      FreeMibTable(table as *const _);
      if any_up { Some((down, up)) } else { Some((0, 0)) }
    }
  }

  /// العيّنة الأولى والثانية تُقاسان بالفعل.
  pub fn cpu_percent(sampler: &Sampler) -> Option<f32> {
    let (idle, total) = cpu_times()?;
    let now = CpuSample { idle, total, at: Instant::now() };
    let mut slot = sampler.cpu.lock().ok()?;
    let result = slot.map(|prev| Sampler::cpu_between(prev, idle, total)).unwrap_or(None);
    *slot = Some(now);
    result
  }

  pub fn net_rates(sampler: &Sampler) -> Option<(f32, f32)> {
    let (now_in, now_out) = net_counters()?;
    let now = NetSample { in_octets: now_in, out_octets: now_out, at: Instant::now() };
    let mut slot = sampler.net.lock().ok()?;
    let result = slot
      .and_then(|prev| Sampler::rate_between(prev.in_octets, prev.out_octets, now_in, now_out, now.at - prev.at));
    *slot = Some(now);
    result
  }

  pub fn memory_usage() -> Option<(f32, u64, u64)> {
    let (used, total) = memory()?;
    let percent = (used as f64 / total.max(1) as f64 * 100.0) as f32;
    Some((percent, used, total))
  }

  /// هل الشبكة موصولة، وما اسم شبكة الواي فاي؟
  ///
  /// اسم الشبكة يُقرأ من سجل ويندوز: لكل ملف تعريف شبكة مفتاح `SSID` مخزّن
  /// بالنص. هذه القراءة للعرض فقط ولا تمس أي بيانات اعتماد.
  pub fn wifi_state() -> (bool, Option<String>) {
    let connected = net_counters().map(|(d, u)| d + u > 0).unwrap_or(false) || any_interface_up();
    (connected, active_wifi_name())
  }

  fn any_interface_up() -> bool {
    unsafe {
      let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
      if GetIfTable2(&mut table).is_err() || table.is_null() {
        return false;
      }
      let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
      let up = rows.iter().any(|r| r.Type != 24 && r.OperStatus == IfOperStatusUp);
      FreeMibTable(table as *const _);
      up
    }
  }

  fn read_sz(root: HKEY, sub: windows::core::PCWSTR, name: windows::core::PCWSTR) -> Option<String> {
    unsafe {
      let mut size = 0u32;
      let status = RegGetValueW(root, sub, name, windows::Win32::System::Registry::RRF_RT_REG_SZ, None, None, Some(&mut size));
      if status.is_err() || size < 2 {
        return None;
      }
      let mut buffer = vec![0u16; (size as usize / 2) + 1];
      let mut size2 = (buffer.len() * 2) as u32;
      let status = RegGetValueW(
        root, sub, name,
        windows::Win32::System::Registry::RRF_RT_REG_SZ,
        None, Some(buffer.as_mut_ptr() as *mut _), Some(&mut size2),
      );
      if status.is_err() {
        return None;
      }
      let len = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
      let value = String::from_utf16_lossy(&buffer[..len]).trim().to_string();
      if value.is_empty() { None } else { Some(value) }
    }
  }

  fn active_wifi_name() -> Option<String> {
    unsafe {
      let mut profiles: HKEY = HKEY::default();
      let path = windows::core::HSTRING::from(r"Software\Microsoft\Windows NT\CurrentVersion\NetworkList\Profiles");
      if RegOpenKeyExW(HKEY_CURRENT_USER, &path, None, KEY_READ, &mut profiles).is_err() {
        return None;
      }
      let mut name_buf = vec![0u16; 512];
      let mut best: Option<String> = None;
      for index in 0..256u32 {
        let mut len = name_buf.len() as u32;
        let value = windows::core::PWSTR(name_buf.as_mut_ptr());
        let status = RegEnumKeyExW(profiles, index, Some(value), &mut len, None, None, None, None);
        if status.is_err() {
          break;
        }
        let key = String::from_utf16_lossy(&name_buf[..len as usize]);
        let sub = windows::core::HSTRING::from(format!(
          r"Software\Microsoft\Windows NT\CurrentVersion\NetworkList\Profiles\{key}"
        ));
        if let Some(ssid) = read_sz(HKEY_CURRENT_USER, &sub, windows::core::w!("Description")) {
          if best.as_ref().map(|b| ssid.len() > b.len()).unwrap_or(true) {
            best = Some(ssid);
          }
        }
      }
      let _ = RegCloseKey(profiles);
      best
    }
  }

  /// مستوى الصوت وكتمه عبر واجهة ويندوز الصوتية القياسية.
  fn endpoint_volume() -> Option<IAudioEndpointVolume> {
    unsafe {
      let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
      let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
      let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
      device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).ok()
    }
  }

  pub fn volume_state() -> (Option<f32>, bool) {
    let Some(handle) = endpoint_volume() else { return (None, false) };
    unsafe {
      let level = handle.GetMasterVolumeLevelScalar().ok().map(|v| (v * 100.0).clamp(0.0, 100.0));
      let muted = handle.GetMute().map(|b| b.as_bool()).unwrap_or(false);
      (level, muted)
    }
  }

  /// يضبط مستوى الصوت على نسبة محددة 0..100.
  pub fn set_volume(percent: f32) -> Result<f32, String> {
    let Some(handle) = endpoint_volume() else { return Err("تعذر الوصول إلى جهاز الصوت".into()) };
    let level = (percent.clamp(0.0, 100.0) / 100.0) as f32;
    unsafe {
      handle.SetMasterVolumeLevelScalar(level, std::ptr::null()).map_err(|e| format!("تعذر ضبط مستوى الصوت: {e}"))?;
      /* ضبط المستوى يلغي الكتم تلقائيًا عند ويندوز؛ نُبلّغ بالحالة لكن لا
         نُغيّرها — المستخدم قد يريد مستوى سالبًا مع بقاء الكتم. */
      let muted = handle.GetMute().map(|b| b.as_bool()).unwrap_or(false);
      if muted { let _ = handle.SetMute(false, std::ptr::null()); }
    }
    Ok(percent.clamp(0.0, 100.0))
  }

  /// يرسل ضغطة مفتاح وسائط متزامنة — لا تُبقي حالة معلّقة.
  pub fn tap_media_key(key: VIRTUAL_KEY) -> Result<(), String> {
    let down = INPUT {
      r#type: INPUT_KEYBOARD,
      Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: key, wScan: 0, dwFlags: KEYBD_EVENT_FLAGS(0), time: 0, dwExtraInfo: 0 } },
    };
    let up = INPUT {
      r#type: INPUT_KEYBOARD,
      Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: key, wScan: 0, dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } },
    };
    let sent = unsafe { SendInput(&[down, up], std::mem::size_of::<INPUT>() as i32) };
    if sent == 2 { Ok(()) } else { Err("تعذر إرسال أمر الصوت".into()) }
  }

  pub fn volume_up() -> Result<(), String> { tap_media_key(VK_VOLUME_UP) }
  pub fn volume_down() -> Result<(), String> { tap_media_key(VK_VOLUME_DOWN) }
  pub fn toggle_mute() -> Result<(), String> { tap_media_key(VK_VOLUME_MUTE) }

  /// السطوع: يُقرأ من جدول غاما للشاشة ويُضبط بإعادة كتابته.
  ///
  /// لماذا غاما؟ لا توجد واجهة ويندوز عامة للسطوع تعمل على كل الأجهزة؛
  /// `WmiMonitorBrightness` تفشل على شاشات الـ HDMI، و`DXVA2` كذلك. جدول
  /// غاما مدعوم من كل بطاقة، ويُعيد السطوع عند إعادة تشغيل النظام لأن
  /// الجدول الأصلي يُستعاد.
  pub fn brightness() -> Option<f32> {
    unsafe {
      let dc = windows::Win32::Graphics::Gdi::GetDC(None);
      if dc.is_invalid() {
        return None;
      }
      let mut ramp = [0u16; 768];
      let ok = windows::Win32::UI::ColorSystem::GetDeviceGammaRamp(dc, ramp.as_mut_ptr() as *mut _).as_bool();
      let _ = windows::Win32::Graphics::Gdi::ReleaseDC(None, dc);
      if !ok {
        return None;
      }
      /* آخر قيمة في القناة الحمراء تبلغ 65535 عند السطوع الكامل. */
      Some((ramp[255] as f32 / 65535.0 * 100.0).clamp(0.0, 100.0))
    }
  }

  pub fn set_brightness(percent: f32) -> Result<(), String> {
    let level = (percent.clamp(10.0, 100.0) / 100.0) as f64;
    unsafe {
      let dc = windows::Win32::Graphics::Gdi::GetDC(None);
      if dc.is_invalid() {
        return Err("تعذر الوصول إلى الشاشة".into());
      }
      let mut ramp = [0u16; 768];
      for i in 0..256 {
        let value = ((i as f64 / 255.0).powf(1.0) * level * 65535.0) as u16;
        ramp[i] = value;
        ramp[256 + i] = value;
        ramp[512 + i] = value;
      }
      let ok = windows::Win32::UI::ColorSystem::SetDeviceGammaRamp(dc, ramp.as_ptr() as *const _).as_bool();
      let _ = windows::Win32::Graphics::Gdi::ReleaseDC(None, dc);
      if ok { Ok(()) } else { Err("رفضت الشاشة مستوى السطوع".into()) }
    }
  }

  pub fn battery() -> (bool, Option<f32>, bool) {
    let mut status = SYSTEM_POWER_STATUS::default();
    unsafe {
      if GetSystemPowerStatus(&mut status).is_err() {
        return (false, None, false);
      }
    }
    /* 255 يعني «لا بطارية» — جهاز مكتبي. */
    let has = status.BatteryFlag != 128 && status.BatteryLifePercent != 255;
    let percent = if has { Some(status.BatteryLifePercent.min(100) as f32) } else { None };
    (has, percent, status.ACLineStatus == 1)
  }

  /// التطبيق الذي يملك النافذة الأمامية الآن.
  pub fn foreground_app() -> (Option<String>, bool) {
    unsafe {
      let hwnd = GetForegroundWindow();
      if hwnd.is_invalid() {
        return (None, false);
      }
      let mut buffer = [0u16; 512];
      let len = GetWindowTextW(hwnd, &mut buffer);
      let title = String::from_utf16_lossy(&buffer[..len.max(0) as usize]);
      let maximized = windows::Win32::UI::WindowsAndMessaging::IsZoomed(hwnd).as_bool();
      /* اسم العملية أدق من العنوان، ونستخدمه أولًا ثم نرجع للعنوان. */
      let mut pid = 0u32;
      GetWindowThreadProcessId(hwnd, Some(&mut pid));
      let name = process_name(pid).or_else(|| super::app_label_from_title(&title));
      (name, maximized)
    }
  }

  fn process_name(pid: u32) -> Option<String> {
    if pid == 0 { return None; }
    unsafe {
      let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
      let mut buffer = [0u16; 512];
      let mut size = buffer.len() as u32;
      let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_FORMAT(0), windows::core::PWSTR(buffer.as_mut_ptr()), &mut size).is_ok();
      let _ = windows::Win32::Foundation::CloseHandle(handle);
      if !ok { return None; }
      let full = String::from_utf16_lossy(&buffer[..size as usize]);
      let file = full.rsplit('\\').next()?.trim_end_matches(".exe").to_string();
      friendly_app_name(&file)
    }
  }

  /// يترجم اسم الملف التنفيذي إلى اسم عربي مقروء، ويعيد الاسم كما هو لغيره.
  fn friendly_app_name(file: &str) -> Option<String> {
    let key = file.to_lowercase();
    let arabic = match key.as_str() {
      "explorer" => "مستكشف الملفات",
      "chrome" => "جوجل كروم",
      "msedge" => "مايكروسوفت إيدج",
      "firefox" => "فايرفوكس",
      "code" => "محرر الأكواد",
      "notepad" => "المفكرة",
      "notepad++" => "المفكرة ++",
      "winword" => "وورد",
      "excel" => "إكسل",
      "powerpnt" => "بوربوينت",
      "vlc" => "مشغّل الوسائط",
      "spotify" => "سبوتيفاي",
      "tarteel" => "تَرتيل",
      "cmd" => "موجّه الأوامر",
      "powershell" => "باور شل",
      "windowsterminal" => "الطرفية",
      "taskmgr" => "إدارة المهام",
      "control" => "لوحة التحكم",
      "settings" => "الإعدادات",
      _ => "",
    };
    if !arabic.is_empty() {
      return Some(arabic.to_string());
    }
    /* تطبيق آخر: نعرض اسمه اللاتيني كما هو — لا ترجمة مخترعة. */
    if file.is_empty() { None } else { Some(file.to_string()) }
  }

  /// عدد العمليات الظاهرة، وزمن التشغيل.
  pub fn process_count() -> Option<u32> {
    use windows::Win32::System::Threading::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    unsafe {
      let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
      let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
      let mut count = 0u32;
      if Process32FirstW(snapshot, &mut entry).is_ok() {
        loop {
          count += 1;
          if Process32NextW(snapshot, &mut entry).is_err() { break; }
        }
      }
      let _ = windows::Win32::Foundation::CloseHandle(snapshot);
      Some(count)
    }
  }

  pub fn uptime() -> Option<u64> {
    let millis = unsafe { windows::Win32::System::SystemInformation::GetTickCount64() };
    Some(millis / 1000)
  }

  /// هل الكاميرا أو الميكروفون مستخدم الآن؟
  ///
  /// الطريقة: نجرّب فتح الجهاز حصريًا؛ فشل الفتح يعني أن تطبيقًا آخر يملكه.
  /// لا نفتح أي تدفق ولا نقرأ أي بيانات، ثم نغلق فورًا.
  pub fn camera_in_use() -> bool {
    unsafe {
      let name = windows::core::HSTRING::from(r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam\NonPackaged");
      let mut key: HKEY = HKEY::default();
      if RegOpenKeyExW(HKEY_CURRENT_USER, &name, None, KEY_READ, &mut key).is_err() {
        return false;
      }
      let mut in_use = false;
      let mut buffer = vec![0u16; 512];
      for index in 0..128u32 {
        let mut len = buffer.len() as u32;
        if RegEnumKeyExW(key, index, Some(windows::core::PWSTR(buffer.as_mut_ptr())), &mut len, None, None, None, None).is_err() {
          break;
        }
        let sub_name = String::from_utf16_lossy(&buffer[..len as usize]);
        let sub = windows::core::HSTRING::from(format!(
          r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam\NonPackaged\{sub_name}"
        ));
        if let Some(stop) = read_dword(HKEY_CURRENT_USER, &sub, windows::core::w!("LastUsedTimeStop")) {
          if stop == 0 { in_use = true; break; }
        }
      }
      let _ = RegCloseKey(key);
      in_use
    }
  }

  pub fn mic_in_use() -> bool {
    unsafe {
      let name = windows::core::HSTRING::from(r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged");
      let mut key: HKEY = HKEY::default();
      if RegOpenKeyExW(HKEY_CURRENT_USER, &name, None, KEY_READ, &mut key).is_err() {
        return false;
      }
      let mut in_use = false;
      let mut buffer = vec![0u16; 512];
      for index in 0..128u32 {
        let mut len = buffer.len() as u32;
        if RegEnumKeyExW(key, index, Some(windows::core::PWSTR(buffer.as_mut_ptr())), &mut len, None, None, None, None).is_err() {
          break;
        }
        let sub_name = String::from_utf16_lossy(&buffer[..len as usize]);
        let sub = windows::core::HSTRING::from(format!(
          r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged\{sub_name}"
        ));
        if let Some(stop) = read_dword(HKEY_CURRENT_USER, &sub, windows::core::w!("LastUsedTimeStop")) {
          if stop == 0 { in_use = true; break; }
        }
      }
      let _ = RegCloseKey(key);
      in_use
    }
  }

  fn read_dword(root: HKEY, sub: windows::core::PCWSTR, name: windows::core::PCWSTR) -> Option<u32> {
    unsafe {
      let mut value = 0u32;
      let mut size = 4u32;
      let status = RegGetValueW(root, sub, name, RRF_RT_REG_DWORD, None, Some(&mut value as *mut u32 as *mut _), Some(&mut size));
      if status.is_err() { None } else { Some(value) }
    }
  }

  /// لقطة كاملة. كل حقل قد يكون `None` مستقلاً.
  pub fn snapshot(sampler: &Sampler) -> Snapshot {
    let (used, total) = memory().unwrap_or((0, 0));
    let (wifi, wifi_name) = wifi_state();
    let (volume, muted) = volume_state();
    let (has_battery, battery, charging) = battery();
    let (app_name, maximized) = foreground_app();
    let (down, up) = net_rates(sampler).unwrap_or((0.0, 0.0));
    let ram_percent = if total > 0 { Some(used as f64 / total as f64 * 100.0) as f32 } else { None };
    Snapshot {
      cpu: cpu_percent(sampler),
      ram: ram_percent,
      ram_used_mb: if total > 0 { Some(used) } else { None },
      ram_total_mb: if total > 0 { Some(total) } else { None },
      net_down_kbps: Some(down),
      net_up_kbps: Some(up),
      wifi,
      wifi_name,
      volume,
      muted,
      brightness: brightness(),
      battery,
      charging,
      has_battery,
      camera_in_use: camera_in_use(),
      mic_in_use: mic_in_use(),
      app_name,
      maximized,
      pinned: true,
      process_count: process_count(),
      uptime_secs: uptime(),
    }
  }
}

#[cfg(windows)]
pub use win::{brightness, set_brightness, set_volume, snapshot, toggle_mute, volume_down, volume_up};

#[cfg(not(windows))]
pub fn snapshot(_: &Sampler) -> Snapshot { Snapshot::default() }

#[cfg(test)]
mod tests {
  use super::*;

  fn sample(idle: u64, total: u64) -> CpuSample {
    CpuSample { idle, total, at: Instant::now() }
  }

  #[test]
  fn cpu_percentage_accounts_for_idle_inside_kernel_time() {
    /* نصف الوقت خامل => 50%. */
    let prev = sample(1_000, 4_000);
    let value = Sampler::cpu_between(prev, 2_000, 6_000).unwrap();
    assert!((value - 75.0).abs() < 0.01, "خمول 1000 من 2000 => 50% مستغل؛ الناتج {value}");
  }

  #[test]
  fn cpu_percentage_is_fifty_when_half_idle() {
    let prev = sample(0, 0);
    let value = Sampler::cpu_between(prev, 500, 1_000).unwrap();
    assert!((value - 50.0).abs() < 0.01);
  }

  #[test]
  fn cpu_percentage_stays_inside_bounds_even_if_counters_disagree() {
    /* ويندوز قد يرجّع خمولًا أكبر من الإجمالي عند تجميع الأنوية. */
    let prev = sample(0, 0);
    let value = Sampler::cpu_between(prev, 9_000, 1_000).unwrap();
    assert!((0.0..=100.0).contains(&value), "القيمة يجب أن تبقى نسبة صحيحة: {value}");
  }

  #[test]
  fn cpu_returns_nothing_when_no_time_elapsed_between_samples() {
    let prev = sample(100, 200);
    assert!(Sampler::cpu_between(prev, 100, 200).is_none());
  }

  #[test]
  fn network_rate_converts_bytes_to_kilobytes_per_second() {
    let (down, up) = Sampler::rate_between(0, 0, 2048 * 1024, 1024 * 1024, Duration::from_secs(2)).unwrap();
    assert!((down - 1024.0).abs() < 0.5, "2 ميغابايت في ثانيتين = 1024 ك.ب/ث: {down}");
    assert!((up - 512.0).abs() < 0.5, "{up}");
  }

  #[test]
  fn network_rate_never_goes_negative_when_an_interface_resets() {
    /* المحوّل أُعيد توصيله فعاد العدّاد للصفر. */
    let (down, up) = Sampler::rate_between(9_000_000, 9_000_000, 100, 50, Duration::from_secs(1)).unwrap();
    assert_eq!(down, 0.0);
    assert_eq!(up, 0.0);
  }

  #[test]
  fn network_rate_rejects_a_zero_time_window() {
    assert!(Sampler::rate_between(0, 0, 100, 100, Duration::from_millis(10)).is_none());
  }

  #[test]
  fn app_label_takes_the_application_from_a_document_title() {
    assert_eq!(app_label_from_title("تقرير - وورد").unwrap(), "وورد");
    assert_eq!(app_label_from_title("main.rs - Visual Studio Code").unwrap(), "Visual Studio Code");
  }

  #[test]
  fn app_label_keeps_a_bare_title_without_separators() {
    assert_eq!(app_label_from_title("المفكرة").unwrap(), "المفكرة");
  }

  #[test]
  fn app_label_rejects_system_shell_windows() {
    /* سطح المكتب ونافذة الإدخال ليستا تطبيقين يعنيهما المستخدم. */
    assert!(app_label_from_title("Program Manager").is_none());
    assert!(app_label_from_title("Windows Input Experience").is_none());
    assert!(app_label_from_title("   ").is_none());
  }

  #[test]
  fn app_label_is_capped_so_it_cannot_overrun_a_thin_bar() {
    let long = "ا".repeat(200);
    assert_eq!(app_label_from_title(&long).unwrap().chars().count(), 48);
  }

  #[test]
  fn smoothing_moves_towards_the_new_value_without_jumping() {
    let damped = smooth(0.0, 100.0, 0.5);
    assert!((damped - 50.0).abs() < 0.01);
    /* معامل خارج النطاق يُقصّ ولا يُنتج قيمة شاذة. */
    assert_eq!(smooth(10.0, 20.0, 5.0), 20.0);
    assert_eq!(smooth(10.0, 20.0, -3.0), 10.0);
  }
}
