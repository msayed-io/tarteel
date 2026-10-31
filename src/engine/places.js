/**
 * تَرتيل — قاعدة المدن العربية الأوفلاين
 * ======================================
 * الطبقة الأخيرة التي لا تفشل أبدًا في محرك الموقع.
 *
 * لماذا؟ لأن كل خدمة شبكة (ArcGIS, BigDataCloud, Nominatim) قد تفشل:
 * بلا إنترنت، أو محجوبة، أو بطيئة، أو مُقيَّدة بسياسة CSP. وحين تفشل جميعها
 * لا يجوز أن نعرض اسمًا إنجليزيًا ولا منطقة زمنية خام — بل اسم مدينة عربي
 * حقيقي، يُحسب محليًا على الجهاز بمسافة هافرساين.
 *
 * البيانات: مدن ومحافظات العالم العربي مرتبة بحسب الأهمية السكانية داخل الدولة،
 * لأن أقرب نقطة قد تكون قرية صغيرة بينما المستخدم يريد اسم المحافظة/المدينة
 * المعروفة التي يتبعها. لذلك نُرجّح المدن الكبرى عند تقارب المسافة.
 *
 * الإحداثيات: مراكز المدن، بدقة كافية (بضعة كيلومترات) لاختيار أقرب مدينة.
 */

/**
 * رتبة الأهمية: 1 = حاضرة/عاصمة، 2 = مدينة كبرى، 3 = مدينة، 4 = محافظة صغرى.
 * تُستخدم لترجيح الأقرب عند التساوي التقريبي.
 */
export const ARAB_CITIES = [
  /* ── مصر ── */
  { ar: 'القاهرة', en: 'Cairo', country: 'مصر', cc: 'EG', lat: 30.0444, lon: 31.2357, rank: 1 },
  { ar: 'الجيزة', en: 'Giza', country: 'مصر', cc: 'EG', lat: 30.0131, lon: 31.2089, rank: 2 },
  { ar: 'شبرا الخيمة', en: 'Shubra El Kheima', country: 'مصر', cc: 'EG', lat: 30.1286, lon: 31.2422, rank: 2 },
  { ar: 'الإسكندرية', en: 'Alexandria', country: 'مصر', cc: 'EG', lat: 31.2001, lon: 29.9187, rank: 1 },
  { ar: 'الزقازيق', en: 'Zagazig', country: 'مصر', cc: 'EG', lat: 30.5877, lon: 31.5020, rank: 3 },
  { ar: 'الإسماعيلية', en: 'Ismailia', country: 'مصر', cc: 'EG', lat: 30.5965, lon: 32.2715, rank: 3 },
  { ar: 'بورسعيد', en: 'Port Said', country: 'مصر', cc: 'EG', lat: 31.2653, lon: 32.3019, rank: 2 },
  { ar: 'السويس', en: 'Suez', country: 'مصر', cc: 'EG', lat: 29.9668, lon: 32.5498, rank: 2 },
  { ar: 'المنصورة', en: 'Mansoura', country: 'مصر', cc: 'EG', lat: 31.0409, lon: 31.3785, rank: 2 },
  { ar: 'طنطا', en: 'Tanta', country: 'مصر', cc: 'EG', lat: 30.7865, lon: 31.0004, rank: 2 },
  { ar: 'المحلة الكبرى', en: 'El Mahalla El Kubra', country: 'مصر', cc: 'EG', lat: 30.9706, lon: 31.1669, rank: 3 },
  { ar: 'دمياط', en: 'Damietta', country: 'مصر', cc: 'EG', lat: 31.4165, lon: 31.8133, rank: 3 },
  { ar: 'كفر الشيخ', en: 'Kafr El Sheikh', country: 'مصر', cc: 'EG', lat: 31.1107, lon: 30.9388, rank: 3 },
  { ar: 'دمنهور', en: 'Damanhur', country: 'مصر', cc: 'EG', lat: 31.0341, lon: 30.4682, rank: 3 },
  { ar: 'شبين الكوم', en: 'Shebin El Kom', country: 'مصر', cc: 'EG', lat: 30.5503, lon: 31.0090, rank: 3 },
  { ar: 'بنها', en: 'Banha', country: 'مصر', cc: 'EG', lat: 30.4660, lon: 31.1837, rank: 3 },
  { ar: 'الفيوم', en: 'Fayoum', country: 'مصر', cc: 'EG', lat: 29.3084, lon: 30.8428, rank: 3 },
  { ar: 'بني سويف', en: 'Beni Suef', country: 'مصر', cc: 'EG', lat: 29.0661, lon: 31.0994, rank: 3 },
  { ar: 'المنيا', en: 'Minya', country: 'مصر', cc: 'EG', lat: 28.1099, lon: 30.7503, rank: 3 },
  { ar: 'أسيوط', en: 'Asyut', country: 'مصر', cc: 'EG', lat: 27.1809, lon: 31.1837, rank: 3 },
  { ar: 'سوهاج', en: 'Sohag', country: 'مصر', cc: 'EG', lat: 26.5591, lon: 31.6957, rank: 3 },
  { ar: 'قنا', en: 'Qena', country: 'مصر', cc: 'EG', lat: 26.1551, lon: 32.7160, rank: 3 },
  { ar: 'الأقصر', en: 'Luxor', country: 'مصر', cc: 'EG', lat: 25.6872, lon: 32.6396, rank: 3 },
  { ar: 'أسوان', en: 'Aswan', country: 'مصر', cc: 'EG', lat: 24.0889, lon: 32.8998, rank: 3 },
  { ar: 'الغردقة', en: 'Hurghada', country: 'مصر', cc: 'EG', lat: 27.2579, lon: 33.8116, rank: 3 },
  { ar: 'شرم الشيخ', en: 'Sharm El Sheikh', country: 'مصر', cc: 'EG', lat: 27.9158, lon: 34.3300, rank: 3 },
  { ar: 'مرسى مطروح', en: 'Marsa Matruh', country: 'مصر', cc: 'EG', lat: 31.3543, lon: 27.2373, rank: 3 },
  { ar: 'العريش', en: 'Arish', country: 'مصر', cc: 'EG', lat: 31.1316, lon: 33.7983, rank: 3 },
  { ar: 'الخارجة', en: 'Kharga', country: 'مصر', cc: 'EG', lat: 25.4514, lon: 30.5464, rank: 4 },
  { ar: 'سيوة', en: 'Siwa', country: 'مصر', cc: 'EG', lat: 29.2032, lon: 25.5195, rank: 4 },

  /* ── السعودية ── */
  { ar: 'مكة المكرمة', en: 'Makkah', country: 'السعودية', cc: 'SA', lat: 21.4225, lon: 39.8262, rank: 1 },
  { ar: 'المدينة المنورة', en: 'Madinah', country: 'السعودية', cc: 'SA', lat: 24.4672, lon: 39.6111, rank: 1 },
  { ar: 'الرياض', en: 'Riyadh', country: 'السعودية', cc: 'SA', lat: 24.7136, lon: 46.6753, rank: 1 },
  { ar: 'جدة', en: 'Jeddah', country: 'السعودية', cc: 'SA', lat: 21.4858, lon: 39.1925, rank: 1 },
  { ar: 'الدمام', en: 'Dammam', country: 'السعودية', cc: 'SA', lat: 26.4207, lon: 50.0888, rank: 2 },
  { ar: 'الطائف', en: 'Taif', country: 'السعودية', cc: 'SA', lat: 21.2703, lon: 40.4158, rank: 2 },
  { ar: 'بريدة', en: 'Buraydah', country: 'السعودية', cc: 'SA', lat: 26.3260, lon: 43.9750, rank: 2 },
  { ar: 'تبوك', en: 'Tabuk', country: 'السعودية', cc: 'SA', lat: 28.3835, lon: 36.5662, rank: 2 },
  { ar: 'أبها', en: 'Abha', country: 'السعودية', cc: 'SA', lat: 18.2164, lon: 42.5053, rank: 2 },
  { ar: 'الخبر', en: 'Khobar', country: 'السعودية', cc: 'SA', lat: 26.2794, lon: 50.2080, rank: 3 },
  { ar: 'حائل', en: 'Hail', country: 'السعودية', cc: 'SA', lat: 27.5219, lon: 41.6907, rank: 2 },
  { ar: 'نجران', en: 'Najran', country: 'السعودية', cc: 'SA', lat: 17.4917, lon: 44.1322, rank: 3 },
  { ar: 'جيزان', en: 'Jazan', country: 'السعودية', cc: 'SA', lat: 16.8892, lon: 42.5511, rank: 3 },

  /* ── الخليج ── */
  { ar: 'دبي', en: 'Dubai', country: 'الإمارات', cc: 'AE', lat: 25.2048, lon: 55.2708, rank: 1 },
  { ar: 'أبوظبي', en: 'Abu Dhabi', country: 'الإمارات', cc: 'AE', lat: 24.4539, lon: 54.3773, rank: 1 },
  { ar: 'الشارقة', en: 'Sharjah', country: 'الإمارات', cc: 'AE', lat: 25.3463, lon: 55.4209, rank: 2 },
  { ar: 'العين', en: 'Al Ain', country: 'الإمارات', cc: 'AE', lat: 24.2075, lon: 55.7447, rank: 2 },
  { ar: 'الكويت', en: 'Kuwait City', country: 'الكويت', cc: 'KW', lat: 29.3759, lon: 47.9774, rank: 1 },
  { ar: 'الدوحة', en: 'Doha', country: 'قطر', cc: 'QA', lat: 25.2854, lon: 51.5310, rank: 1 },
  { ar: 'المنامة', en: 'Manama', country: 'البحرين', cc: 'BH', lat: 26.2285, lon: 50.5860, rank: 1 },
  { ar: 'مسقط', en: 'Muscat', country: 'عُمان', cc: 'OM', lat: 23.5880, lon: 58.3829, rank: 1 },
  { ar: 'صلالة', en: 'Salalah', country: 'عُمان', cc: 'OM', lat: 17.0151, lon: 54.0924, rank: 2 },
  { ar: 'صنعاء', en: "Sana'a", country: 'اليمن', cc: 'YE', lat: 15.3694, lon: 44.1910, rank: 1 },
  { ar: 'عدن', en: 'Aden', country: 'اليمن', cc: 'YE', lat: 12.7855, lon: 45.0187, rank: 2 },

  /* ── الشام والعراق ── */
  { ar: 'عمّان', en: 'Amman', country: 'الأردن', cc: 'JO', lat: 31.9454, lon: 35.9284, rank: 1 },
  { ar: 'إربد', en: 'Irbid', country: 'الأردن', cc: 'JO', lat: 32.5556, lon: 35.8500, rank: 2 },
  { ar: 'بيروت', en: 'Beirut', country: 'لبنان', cc: 'LB', lat: 33.8938, lon: 35.5018, rank: 1 },
  { ar: 'طرابلس', en: 'Tripoli', country: 'لبنان', cc: 'LB', lat: 34.4367, lon: 35.8497, rank: 3 },
  { ar: 'دمشق', en: 'Damascus', country: 'سوريا', cc: 'SY', lat: 33.5138, lon: 36.2765, rank: 1 },
  { ar: 'حلب', en: 'Aleppo', country: 'سوريا', cc: 'SY', lat: 36.2021, lon: 37.1343, rank: 2 },
  { ar: 'حمص', en: 'Homs', country: 'سوريا', cc: 'SY', lat: 34.7324, lon: 36.7137, rank: 3 },
  { ar: 'بغداد', en: 'Baghdad', country: 'العراق', cc: 'IQ', lat: 33.3152, lon: 44.3661, rank: 1 },
  { ar: 'البصرة', en: 'Basra', country: 'العراق', cc: 'IQ', lat: 30.5085, lon: 47.7804, rank: 2 },
  { ar: 'الموصل', en: 'Mosul', country: 'العراق', cc: 'IQ', lat: 36.3350, lon: 43.1189, rank: 2 },
  { ar: 'أربيل', en: 'Erbil', country: 'العراق', cc: 'IQ', lat: 36.1911, lon: 44.0092, rank: 2 },
  { ar: 'القدس', en: 'Jerusalem', country: 'فلسطين', cc: 'PS', lat: 31.7683, lon: 35.2137, rank: 1 },
  { ar: 'غزة', en: 'Gaza', country: 'فلسطين', cc: 'PS', lat: 31.5017, lon: 34.4668, rank: 2 },
  { ar: 'رام الله', en: 'Ramallah', country: 'فلسطين', cc: 'PS', lat: 31.9038, lon: 35.2034, rank: 2 },

  /* ── شمال أفريقيا ── */
  { ar: 'طرابلس', en: 'Tripoli', country: 'ليبيا', cc: 'LY', lat: 32.8872, lon: 13.1913, rank: 1 },
  { ar: 'بنغازي', en: 'Benghazi', country: 'ليبيا', cc: 'LY', lat: 32.1167, lon: 20.0667, rank: 2 },
  { ar: 'تونس', en: 'Tunis', country: 'تونس', cc: 'TN', lat: 36.8065, lon: 10.1815, rank: 1 },
  { ar: 'صفاقس', en: 'Sfax', country: 'تونس', cc: 'TN', lat: 34.7406, lon: 10.7603, rank: 2 },
  { ar: 'الجزائر', en: 'Algiers', country: 'الجزائر', cc: 'DZ', lat: 36.7538, lon: 3.0588, rank: 1 },
  { ar: 'وهران', en: 'Oran', country: 'الجزائر', cc: 'DZ', lat: 35.6971, lon: -0.6308, rank: 2 },
  { ar: 'قسنطينة', en: 'Constantine', country: 'الجزائر', cc: 'DZ', lat: 36.3650, lon: 6.6147, rank: 2 },
  { ar: 'الدار البيضاء', en: 'Casablanca', country: 'المغرب', cc: 'MA', lat: 33.5731, lon: -7.5898, rank: 1 },
  { ar: 'الرباط', en: 'Rabat', country: 'المغرب', cc: 'MA', lat: 34.0209, lon: -6.8416, rank: 1 },
  { ar: 'فاس', en: 'Fez', country: 'المغرب', cc: 'MA', lat: 34.0181, lon: -5.0078, rank: 2 },
  { ar: 'مراكش', en: 'Marrakesh', country: 'المغرب', cc: 'MA', lat: 31.6295, lon: -7.9811, rank: 2 },
  { ar: 'نواكشوط', en: 'Nouakchott', country: 'موريتانيا', cc: 'MR', lat: 18.0735, lon: -15.9582, rank: 1 },
  { ar: 'الخرطوم', en: 'Khartoum', country: 'السودان', cc: 'SD', lat: 15.5007, lon: 32.5599, rank: 1 },
  { ar: 'أم درمان', en: 'Omdurman', country: 'السودان', cc: 'SD', lat: 15.6445, lon: 32.4777, rank: 2 },
  { ar: 'بورتسودان', en: 'Port Sudan', country: 'السودان', cc: 'SD', lat: 19.6158, lon: 37.2164, rank: 3 },
  { ar: 'مقديشو', en: 'Mogadishu', country: 'الصومال', cc: 'SO', lat: 2.0469, lon: 45.3182, rank: 1 },
  { ar: 'جيبوتي', en: 'Djibouti', country: 'جيبوتي', cc: 'DJ', lat: 11.5721, lon: 43.1456, rank: 1 },

  /* ── آسيا الإسلامية ── */
  { ar: 'إسطنبول', en: 'Istanbul', country: 'تركيا', cc: 'TR', lat: 41.0082, lon: 28.9784, rank: 1 },
  { ar: 'أنقرة', en: 'Ankara', country: 'تركيا', cc: 'TR', lat: 39.9334, lon: 32.8597, rank: 1 },
  { ar: 'كراتشي', en: 'Karachi', country: 'باكستان', cc: 'PK', lat: 24.8607, lon: 67.0011, rank: 1 },
  { ar: 'لاهور', en: 'Lahore', country: 'باكستان', cc: 'PK', lat: 31.5204, lon: 74.3587, rank: 1 },
  { ar: 'إسلام آباد', en: 'Islamabad', country: 'باكستان', cc: 'PK', lat: 33.6844, lon: 73.0479, rank: 1 },
  { ar: 'دلهي', en: 'Delhi', country: 'الهند', cc: 'IN', lat: 28.6139, lon: 77.2090, rank: 1 },
  { ar: 'مومباي', en: 'Mumbai', country: 'الهند', cc: 'IN', lat: 19.0760, lon: 72.8777, rank: 1 },
  { ar: 'دكا', en: 'Dhaka', country: 'بنغلاديش', cc: 'BD', lat: 23.8103, lon: 90.4125, rank: 1 },
  { ar: 'كابول', en: 'Kabul', country: 'أفغانستان', cc: 'AF', lat: 34.5553, lon: 69.2075, rank: 1 },
  { ar: 'كوالالمبور', en: 'Kuala Lumpur', country: 'ماليزيا', cc: 'MY', lat: 3.1390, lon: 101.6869, rank: 1 },
  { ar: 'جاكرتا', en: 'Jakarta', country: 'إندونيسيا', cc: 'ID', lat: -6.2088, lon: 106.8456, rank: 1 },
  { ar: 'كولمبو', en: 'Colombo', country: 'سريلانكا', cc: 'LK', lat: 6.9271, lon: 79.8612, rank: 1 },

  /* ── أوروبا وأمريكا الشمالية (وجود عربي) ── */
  { ar: 'لندن', en: 'London', country: 'المملكة المتحدة', cc: 'GB', lat: 51.5074, lon: -0.1278, rank: 1 },
  { ar: 'باريس', en: 'Paris', country: 'فرنسا', cc: 'FR', lat: 48.8566, lon: 2.3522, rank: 1 },
  { ar: 'برلين', en: 'Berlin', country: 'ألمانيا', cc: 'DE', lat: 52.5200, lon: 13.4050, rank: 1 },
  { ar: 'نيويورك', en: 'New York', country: 'الولايات المتحدة', cc: 'US', lat: 40.7128, lon: -74.0060, rank: 1 },
  { ar: 'شيكاغو', en: 'Chicago', country: 'الولايات المتحدة', cc: 'US', lat: 41.8781, lon: -87.6298, rank: 1 },
  { ar: 'تورونتو', en: 'Toronto', country: 'كندا', cc: 'CA', lat: 43.6532, lon: -79.3832, rank: 1 },
];

/** مسافة هافرساين بالكيلومترات. */
export function haversineKm(a, b) {
  const rad = n => (Number(n) * Math.PI) / 180;
  const dLat = rad(Number(b.lat ?? b.latitude) - Number(a.lat ?? a.latitude));
  const dLon = rad(Number(b.lon ?? b.longitude) - Number(a.lon ?? a.longitude));
  const lat1 = rad(a.lat ?? a.latitude);
  const lat2 = rad(b.lat ?? b.latitude);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/**
 * يجد أقرب مدينة عربية محليًا.
 *
 * الترجيح: نطرح خصمًا من المسافة بحسب رتبة المدينة، لأن المستخدم في ضاحية
 * القاهرة يريد «القاهرة» لا قرية صغيرة أقرب إليه ببضعة كيلومترات.
 * الخصم: رتبة 1 ⇒ −25كم، رتبة 2 ⇒ −15كم، رتبة 3 ⇒ −8كم، رتبة 4 ⇒ 0.
 *
 * @returns {{city:string, country:string, countryCode:string, distanceKm:number}|null}
 */
export function nearestArabCity(latitude, longitude) {
  const point = { lat: Number(latitude), lon: Number(longitude) };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;

  const RANK_BONUS_KM = { 1: 25, 2: 15, 3: 8, 4: 0 };
  let best = null;
  for (const city of ARAB_CITIES) {
    const distanceKm = haversineKm(point, city);
    const score = distanceKm - (RANK_BONUS_KM[city.rank] || 0);
    if (!best || score < best.score) best = { city, distanceKm, score };
  }
  if (!best) return null;
  /* أسماء موحّدة مع بقية المحرك: city/region/country/countryCode. */
  return {
    city: best.city.ar,
    region: '',
    country: best.city.country,
    countryCode: best.city.cc,
    distanceKm: best.distanceKm,
    ar: best.city.ar,
    cc: best.city.cc,
  };
}


/* ------------------------------------------------------------------ *
 * الهرم الجغرافي الثلاثي (Micro-Location Hierarchy)
 * ------------------------------------------------------------------ *
 * لماذا لا يكفي اسم المركز؟
 * لأن المستخدم في «عزبة أبو عطوة» يريد أن يرى قريته لا اسم المركز الذي
 * يتبعها. لكن اسم المركز لا يُحذف أيضًا: هو ما يعرف به الناس عنوانهم.
 *
 * الترتيب المطلوب: [القرية/الحي/العزبة] ، [المركز/المدينة] ، [المحافظة]
 * والحذف عند التكرار: إن كان الحي هو نفسه المدينة لا يُكرر.
 */

/** أعلى دقة: مكان محلي دقيق (حي، قرية، عزبة، شارع). */
const LOCAL_PLACE_KEYS = [
  'neighbourhood', 'suburb', 'quarter', 'village', 'hamlet',
  'residential', 'road', 'amenity', 'place_of_worship',
  'isolated_dwelling', 'locality_place', 'croft',
];

/** المدينة أو المركز. */
const CITY_KEYS = [
  'city', 'town', 'locality', 'city_district', 'district',
  'municipality', 'county',
];

/** المحافظة أو الولاية. */
const GOVERNORATE_KEYS = ['state', 'governorate', 'province', 'region'];

const firstOf = (address, keys) => {
  for (const key of keys) {
    const value = String(address?.[key] || '').trim();
    if (value) return { value, key };
  }
  return null;
};

/**
 * يبني الهرم الجغرافي الثلاثي من عنوان Nominatim/OSM.
 *
 * @param {object} address كائن address من استجابة Nominatim
 * @returns {{label:string, localPlace:string, city:string, governorate:string}}
 */
export function buildLocationHierarchy(address) {
  const local = firstOf(address, LOCAL_PLACE_KEYS);
  const city = firstOf(address, CITY_KEYS);
  const gov = firstOf(address, GOVERNORATE_KEYS);

  const localPlace = local?.value || '';
  const cityOrCenter = city?.value || '';
  const governorate = gov?.value || '';

  const parts = [];
  if (localPlace) parts.push(localPlace);
  if (cityOrCenter && cityOrCenter !== localPlace) parts.push(cityOrCenter);
  if (governorate && governorate !== cityOrCenter && governorate !== localPlace) parts.push(governorate);

  return {
    label: parts.join('، '),
    localPlace,
    city: cityOrCenter,
    governorate,
  };
}

/**
 * يبني الهرم من أي شكل استجابة (ArcGIS / BigDataCloud / Nominatim / أوفلاين).
 * نوحّد المدخلات أولًا إلى قاموس address، ثم نطبّق نفس الخوارزمية — منطق
 * واحد لجميع المصادر حتى لا يختلف الناتج باختلاف الخدمة.
 */
export function hierarchyFromProvider(provider, data) {
  let address = null;

  if (provider === 'nominatim') {
    address = data?.address || null;
  } else if (provider === 'arcgis') {
    const a = data?.address || {};
    address = {
      neighbourhood: a.Neighbourhood,
      suburb: a.District,
      city: a.City,
      town: a.Municipality,
      county: a.Subregion,
      state: a.Region || a.Subregion,
    };
  } else if (provider === 'bigdatacloud') {
    address = {
      neighbourhood: data?.locality,
      suburb: data?.localityInfo?.administrative?.slice?.(-1)?.[0]?.name,
      city: data?.city || data?.locality,
      county: data?.principalSubdivision,
      state: data?.principalSubdivision,
    };
  } else if (provider === 'offline') {
    return {
      label: [data?.city, data?.country].filter(Boolean).join('، '),
      localPlace: '',
      city: data?.city || '',
      governorate: '',
    };
  }

  if (!address) return null;
  const hierarchy = buildLocationHierarchy(address);
  return hierarchy.label ? hierarchy : null;
}
