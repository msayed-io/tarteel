/**
 * طبقة عرض اسم المكان — لا تعدّل بيانات المنظومة المرجعية، بل تختار منها
 * ما يصلح لواجهة عربية.
 *
 * السبب: المرجع يرجّح ArcGIS أولًا (كما هو مطلوب)، وArcGIS يعيد أسماء POI
 * لاتينية لبعض النقاط مثل «American Dream Ismailia». الاسم يبقى محفوظًا
 * كما أخرجه المرجع داخل prayerLocation، وهذا الملف يقرر فقط ما يُعرض.
 */
import { findNearestArabPlace } from '../lib/gps-location.ts';

/*
 * حرف عربي حقيقي، لا علامة ترقيم.
 * «،» تقع داخل نطاق U+0600–U+06FF، فلو فحصنا النطاق وحده لعُدّ نص لاتيني
 * مثل "American Dream Ismailia، Qism" عربيًا. نستثني علامات الترقيم:
 * U+060C (،) وU+061B (؛) وU+061F (؟) وU+0640 (ـ) والفاصل العربي.
 */
const hasArabic = text => /[\u0620-\u063F\u0641-\u064A\u0660-\u06FF]/.test(String(text || ''));

/**
 * يعيد اسم المكان العربي الكامل: [القرية/الحي] ، [المركز] ، [المحافظة]
 *
 * الترتيب:
 *   1. cityNameAr إن كان عربيًا — وهو الاسم التفصيلي الكامل من المرجع.
 *   2. cityName إن كان عربيًا.
 *   3. أقرب مكان من قاعدة المرجع العربية أوفلاين (egypt-places).
 *   4. الدولة بالعربية إن وُجدت.
 * ولا يُعاد نص لاتيني أبدًا.
 *
 * @param {object} location كائن PrayerLocation أو الموقع الداخلي
 * @returns {string}
 */
export function displayPlaceName(location) {
  if (!location) return '';

  for (const candidate of [location.cityNameAr, location.cityName, location.label]) {
    const text = String(candidate || '').trim();
    if (text && hasArabic(text)) return text;
  }

  const nearest = findNearestArabPlace(Number(location.latitude), Number(location.longitude));
  if (nearest) return `${nearest.name}، ${nearest.parent}`;

  const country = String(location.countryNameAr || location.country || '').trim();
  return hasArabic(country) ? country : '';
}

/** الاسم مع الدولة: «الإسماعيلية، مصر». */
export function displayPlaceWithCountry(location) {
  const name = displayPlaceName(location);
  const country = String(location?.countryNameAr || location?.country || '').trim();
  if (!name) return hasArabic(country) ? country : '';
  if (!hasArabic(country) || name.includes(country)) return name;
  return `${name}، ${country}`;
}
