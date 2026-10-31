/**
 * إعدادات ومعرّفات مواقيت الصلاة — مستخرجة حرفيًا من النسخة الإنتاجية
 * (نصوص الأذكار، طرق الحساب، معرفات الصلوات)
 */

export type PrayerId =
  | "fajr"
  | "sunrise"
  | "duha"
  | "dhuhr"
  | "asr"
  | "maghrib"
  | "isha";

export type CalculationMethodId =
  | "egyptian"
  | "umm_al_qura"
  | "mwl"
  | "isna"
  | "karachi";

/** تعريفات الصلوات مع النصوص الشرعية للإشعارات (كما في الإنتاج) */
export const PRAYER_DEFINITIONS: Record<
  PrayerId,
  { nameAr: string; exactText: string; preText?: string }
> = {
  fajr: {
    nameAr: "الفجر",
    exactText: "مَن صلّى الصبح فهو في ذمّة الله.",
    preText: "عشر دقائق ويدركك الفجر؛ هبّ لرضوان الله واغتنم بركة البكور.",
  },
  sunrise: {
    nameAr: "الشروق",
    exactText: "سبح بحمد ربك قبل طلوع الشمس وقبل غروبها.",
  },
  duha: {
    nameAr: "الضحى",
    exactText: "صلاة الأوابين حين ترمض الفصال.",
  },
  dhuhr: {
    nameAr: "الظهر",
    exactText: "إنَّ هَذَا وقتٌ تُفْتَحُ فِيهِ أَبْوَابُ السَّمَاءِ.",
    preText: "أزف وقت الظهر؛ أرح قِلبك بوضوءٍ طهور استعداداً للقاء الملك.",
  },
  asr: {
    nameAr: "العصر",
    exactText: "حافِظوا على الصَّلواتِ والصَّلاةِ الوُسْطَى.",
    preText: "اقتربت الصلاة الوسطى؛ سارع لتكون في صفوف الفالحين.",
  },
  maghrib: {
    nameAr: "المغرب",
    exactText: "فسبحان الله حين تمسون وحين تصبحون.",
    preText: "غابت الشمس وآن وقت اللقاء؛ استعد لأداء فريضة المغرب.",
  },
  isha: {
    nameAr: "العشاء",
    exactText: "المشاؤون إلى المساجد في الظلم لهم النور التام يوم القيامة.",
    preText: "سكن الليل واقتربت العشاء؛ اختم يومك بوقوفٍ بين يدي الرحمن.",
  },
};

/** الصلوات التي لها تنبيه مسبق (10 دقائق قبل الأذان) */
export const PRE_ALARM_PRAYERS: PrayerId[] = [
  "fajr",
  "dhuhr",
  "asr",
  "maghrib",
  "isha",
];

/** الدقائق قبل الأذان للتنبيه المسبق */
export const PRE_ALARM_MINUTES = 10;

/** طرق حساب المواقيت (كما في الإنتاج) */
export const CALCULATION_METHODS: {
  id: CalculationMethodId;
  nameAr: string;
  description: string;
}[] = [
  {
    id: "egyptian",
    nameAr: "الهيئة المصرية",
    description: "مصر، أفريقيا، الشام",
  },
  {
    id: "umm_al_qura",
    nameAr: "أم القرى",
    description: "السعودية والخليج",
  },
  {
    id: "mwl",
    nameAr: "رابطة العالم الإسلامي",
    description: "أوروبا وأغلب الدول",
  },
  {
    id: "isna",
    nameAr: "شمال أمريكا (ISNA)",
    description: "الولايات المتحدة وكندا",
  },
  {
    id: "karachi",
    nameAr: "كراتشي",
    description: "باكستان وبنغلاديش",
  },
];

/** موقع المستخدم المُخزَّن */
export interface PrayerLocation {
  latitude: number;
  longitude: number;
  cityName: string;
  cityNameAr?: string;
  countryNameAr?: string;
  timezoneId: string;
  isAutoDetected?: boolean;
  accuracyMeters?: number | null;
  capturedAt?: number;
  source?: "gps_precise" | "gps_approximate" | "network" | "manual_map" | "manual_city" | "legacy";
  displayAddress?: string;
}

/** حالة المواقيت في التطبيق */
export interface PrayerState {
  location: PrayerLocation | null;
  method: CalculationMethodId;
  isInitialized: boolean;
}
