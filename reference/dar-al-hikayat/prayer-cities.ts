/**
 * قاعدة بيانات المدن لمواقيت الصلاة — مستخرجة حرفيًا من النسخة الإنتاجية
 * 58 مدينة في 24 دولة (مصر 27، السعودية 5، ...)
 */

export interface CityData {
  nameAr: string;
  countryAr: string;
  latitude: number;
  longitude: number;
  timezoneId: string;
}

export const CITIES: CityData[] = [
  // ── مصر ──
  // ── مصر ──
  {
    nameAr: "القاهرة",
    countryAr: "مصر",
    latitude: 30.0444,
    longitude: 31.2357,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "الجيزة",
    countryAr: "مصر",
    latitude: 29.9765,
    longitude: 31.1313,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "القليوبية",
    countryAr: "مصر",
    latitude: 30.3293,
    longitude: 31.2263,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "الإسكندرية",
    countryAr: "مصر",
    latitude: 31.2001,
    longitude: 29.9187,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "البحيرة",
    countryAr: "مصر",
    latitude: 30.8481,
    longitude: 30.3436,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "الغربية",
    countryAr: "مصر",
    latitude: 30.7865,
    longitude: 31.0004,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "المنوفية",
    countryAr: "مصر",
    latitude: 30.4592,
    longitude: 30.9422,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "الدقهلية",
    countryAr: "مصر",
    latitude: 31.0409,
    longitude: 31.3785,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "كفر الشيخ",
    countryAr: "مصر",
    latitude: 31.1176,
    longitude: 30.9413,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "دمياط",
    countryAr: "مصر",
    latitude: 31.4175,
    longitude: 31.8144,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "الشرقية",
    countryAr: "مصر",
    latitude: 30.7327,
    longitude: 31.7195,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "بورسعيد",
    countryAr: "مصر",
    latitude: 31.2653,
    longitude: 32.3019,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "الإسماعيلية",
    countryAr: "مصر",
    latitude: 30.5852,
    longitude: 32.2638,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "السويس",
    countryAr: "مصر",
    latitude: 29.9668,
    longitude: 32.5498,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "شمال سيناء",
    countryAr: "مصر",
    latitude: 31.056,
    longitude: 33.824,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "جنوب سيناء",
    countryAr: "مصر",
    latitude: 28.557,
    longitude: 33.9769,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "الفيوم",
    countryAr: "مصر",
    latitude: 29.3084,
    longitude: 30.8428,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "بني سويف",
    countryAr: "مصر",
    latitude: 29.0661,
    longitude: 31.0975,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "المنيا",
    countryAr: "مصر",
    latitude: 28.1099,
    longitude: 30.7503,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "أسيوط",
    countryAr: "مصر",
    latitude: 27.181,
    longitude: 31.1837,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "سوهاج",
    countryAr: "مصر",
    latitude: 26.5591,
    longitude: 31.6948,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "قنا",
    countryAr: "مصر",
    latitude: 26.1551,
    longitude: 32.716,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "الأقصر",
    countryAr: "مصر",
    latitude: 25.6872,
    longitude: 32.6396,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "أسوان",
    countryAr: "مصر",
    latitude: 24.0889,
    longitude: 32.8998,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "البحر الأحمر",
    countryAr: "مصر",
    latitude: 25.25,
    longitude: 34.25,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "الوادي الجديد",
    countryAr: "مصر",
    latitude: 24.5183,
    longitude: 29.7289,
    timezoneId: "Africa/Cairo",
  },
  {
    nameAr: "مطروح",
    countryAr: "مصر",
    latitude: 31.3543,
    longitude: 27.2273,
    timezoneId: "Africa/Cairo",
  },
  // ── السعودية ──
  {
    nameAr: "مكة المكرمة",
    countryAr: "السعودية",
    latitude: 21.3891,
    longitude: 39.8579,
    timezoneId: "Asia/Riyadh",
  },
  {
    nameAr: "المدينة المنورة",
    countryAr: "السعودية",
    latitude: 24.5247,
    longitude: 39.5692,
    timezoneId: "Asia/Riyadh",
  },
  {
    nameAr: "الرياض",
    countryAr: "السعودية",
    latitude: 24.7136,
    longitude: 46.6753,
    timezoneId: "Asia/Riyadh",
  },
  {
    nameAr: "جدة",
    countryAr: "السعودية",
    latitude: 21.5433,
    longitude: 39.1728,
    timezoneId: "Asia/Riyadh",
  },
  {
    nameAr: "الدمام",
    countryAr: "السعودية",
    latitude: 26.3927,
    longitude: 49.9777,
    timezoneId: "Asia/Riyadh",
  },
  // ── الإمارات ──
  {
    nameAr: "دبي",
    countryAr: "الإمارات",
    latitude: 25.2048,
    longitude: 55.2708,
    timezoneId: "Asia/Dubai",
  },
  {
    nameAr: "أبوظبي",
    countryAr: "الإمارات",
    latitude: 24.4539,
    longitude: 54.3773,
    timezoneId: "Asia/Dubai",
  },
  {
    nameAr: "الشارقة",
    countryAr: "الإمارات",
    latitude: 25.3463,
    longitude: 55.4209,
    timezoneId: "Asia/Dubai",
  },
  // ── الكويت ──
  {
    nameAr: "الكويت",
    countryAr: "الكويت",
    latitude: 29.3759,
    longitude: 47.9774,
    timezoneId: "Asia/Kuwait",
  },
  // ── قطر ──
  {
    nameAr: "الدوحة",
    countryAr: "قطر",
    latitude: 25.2854,
    longitude: 51.531,
    timezoneId: "Asia/Qatar",
  },
  // ── البحرين ──
  {
    nameAr: "المنامة",
    countryAr: "البحرين",
    latitude: 26.2285,
    longitude: 50.586,
    timezoneId: "Asia/Bahrain",
  },
  // ── عُمان ──
  {
    nameAr: "مسقط",
    countryAr: "عُمان",
    latitude: 23.588,
    longitude: 58.3829,
    timezoneId: "Asia/Muscat",
  },
  // ── الأردن ──
  {
    nameAr: "عمّان",
    countryAr: "الأردن",
    latitude: 31.9454,
    longitude: 35.9284,
    timezoneId: "Asia/Amman",
  },
  // ── فلسطين ──
  {
    nameAr: "القدس",
    countryAr: "فلسطين",
    latitude: 31.7683,
    longitude: 35.2137,
    timezoneId: "Asia/Hebron",
  },
  // ── لبنان ──
  {
    nameAr: "بيروت",
    countryAr: "لبنان",
    latitude: 33.8938,
    longitude: 35.5018,
    timezoneId: "Asia/Beirut",
  },
  // ── سوريا ──
  {
    nameAr: "دمشق",
    countryAr: "سوريا",
    latitude: 33.5138,
    longitude: 36.2765,
    timezoneId: "Asia/Damascus",
  },
  // ── العراق ──
  {
    nameAr: "بغداد",
    countryAr: "العراق",
    latitude: 33.3152,
    longitude: 44.3661,
    timezoneId: "Asia/Baghdad",
  },
  // ── المغرب ──
  {
    nameAr: "الرباط",
    countryAr: "المغرب",
    latitude: 34.0209,
    longitude: -6.8416,
    timezoneId: "Africa/Casablanca",
  },
  {
    nameAr: "الدار البيضاء",
    countryAr: "المغرب",
    latitude: 33.5731,
    longitude: -7.5898,
    timezoneId: "Africa/Casablanca",
  },
  // ── تونس ──
  {
    nameAr: "تونس",
    countryAr: "تونس",
    latitude: 36.8065,
    longitude: 10.1815,
    timezoneId: "Africa/Tunis",
  },
  // ── الجزائر ──
  {
    nameAr: "الجزائر",
    countryAr: "الجزائر",
    latitude: 36.7538,
    longitude: 3.0588,
    timezoneId: "Africa/Algiers",
  },
  // ── ليبيا ──
  {
    nameAr: "طرابلس",
    countryAr: "ليبيا",
    latitude: 32.8872,
    longitude: 13.1913,
    timezoneId: "Africa/Tripoli",
  },
  // ── السودان ──
  {
    nameAr: "الخرطوم",
    countryAr: "السودان",
    latitude: 15.5007,
    longitude: 32.5599,
    timezoneId: "Africa/Khartoum",
  },
  // ── تركيا ──
  {
    nameAr: "إسطنبول",
    countryAr: "تركيا",
    latitude: 41.0082,
    longitude: 28.9784,
    timezoneId: "Europe/Istanbul",
  },
  // ── باكستان ──
  {
    nameAr: "إسلام أباد",
    countryAr: "باكستان",
    latitude: 33.6844,
    longitude: 73.0479,
    timezoneId: "Asia/Karachi",
  },
  {
    nameAr: "كراتشي",
    countryAr: "باكستان",
    latitude: 24.8607,
    longitude: 67.0011,
    timezoneId: "Asia/Karachi",
  },
  // ── إندونيسيا ──
  {
    nameAr: "جاكرتا",
    countryAr: "إندونيسيا",
    latitude: -6.2088,
    longitude: 106.8456,
    timezoneId: "Asia/Jakarta",
  },
  // ── ماليزيا ──
  {
    nameAr: "كوالالمبور",
    countryAr: "ماليزيا",
    latitude: 3.139,
    longitude: 101.6869,
    timezoneId: "Asia/Kuala_Lumpur",
  },
  // ── بريطانيا ──
  {
    nameAr: "لندن",
    countryAr: "بريطانيا",
    latitude: 51.5074,
    longitude: -0.1278,
    timezoneId: "Europe/London",
  },
  // ── فرنسا ──
  {
    nameAr: "باريس",
    countryAr: "فرنسا",
    latitude: 48.8566,
    longitude: 2.3522,
    timezoneId: "Europe/Paris",
  },
  // ── أمريكا ──
  {
    nameAr: "نيويورك",
    countryAr: "أمريكا",
    latitude: 40.7128,
    longitude: -74.006,
    timezoneId: "America/New_York",
  },
];

