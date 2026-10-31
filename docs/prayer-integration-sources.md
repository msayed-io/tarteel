# مواقيت الصلاة: المصادر والقرارات التقنية

## المصدر الخارجي

- مواقيت الصلاة: AlAdhan Prayer Times API، endpoint تقويم شهري `/v1/calendar/{year}/{month}` بإحداثيات WGS84 ومعلمات `method`, `school`, واختياريًا `timezonestring`. تمت تجربة endpoint الحي يوم 2026-10-31 على إحداثيات اختبارية وأعاد HTTP/API 200، بيانات timings مع اختصار المنطقة الزمنية، وmetadata يصرح بمنطقة IANA وطريقة الحساب والمدرسة. صفحة الوثائق: https://aladhan.com/prayer-times-api . واجهة methods الحية: https://api.aladhan.com/v1/methods .
- تقبل واجهة AlAdhan قيم Asr `school=0` (STANDARD) و`school=1` (HANAFI)، ويجب مطابقة `meta.method.id`, `meta.school`, `meta.timezone` للاستجابة مع الإعداد المتوقع قبل اعتماد البيانات. لا يصح عرض أي وقت افتراضي عند فشل المصدر.
- جيوكودينغ المدينة يدويًا: Open-Meteo Geocoding API `https://geocoding-api.open-meteo.com/v1/search?name=...&language=ar&count=8`, الذي يعيد اسم المكان والإحداثيات والمنطقة الزمنية IANA. الوثيقة: https://open-meteo.com/en/docs/geocoding-api . بيانات الموقع من GeoNames وفق attribution في الوثائق.

## صلاحيات Tauri وWindows

- Tauri geolocation الرسمي: https://v2.tauri.app/plugin/geolocation/ ومرجع JS https://v2.tauri.app/reference/javascript/geolocation/ . الدليل يصرح بدعم Windows/Linux/macOS وغيرها، ويعرّف `checkPermissions`, `requestPermissions`, `getCurrentPosition`, `watchPosition`. الإصدارات المستقرة geolocation 2.5.0 تتطلب Rust 1.90 وفق crates.io؛ لا تستخدم إصدار 3 alpha.
- Tauri notification الرسمي: https://v2.tauri.app/plugin/notification/ . يصرح بدعم Windows، لكن إشعارات Windows تعمل للتطبيقات المثبتة فقط؛ في وضع التطوير قد يظهر اسم/أيقونة PowerShell. إشعارات desktop لا تحترم جدولة plugin الأصلية حسب مرجع `NotificationBuilder`; يلزم مجدول Rust أثناء بقاء التطبيق قيد التشغيل.
- وثائق Microsoft للموقع: https://learn.microsoft.com/en-us/windows/apps/develop/maps-and-location/get-location . تطبيقات Windows غير المعبأة لا تحتاج إعلان capability في manifest حسب هذه الصفحة، لكن يلزم طلب `RequestAccessAsync` في المقدمة. تطبيق Tauri يستخدم plugin Tauri الرسمي ولا يدعي استدعاء WinRT مباشرة.
- مؤقت Rust داخل العملية يستطيع العمل عند تصغير النوافذ/الخلفية ما دامت العملية تعمل. لا يوقظ الجهاز من Sleep أو Hibernate ولا يعمل بعد إغلاق العملية؛ لم يطلب التطبيق خدمة Windows أو Task Scheduler للتشغيل كخدمة/إيقاظ الجهاز. يجب توضيح هذا القيد.

## ما وجد في المرجع

- ملف المستخدم المرفق `/home/ubuntu/upload/Tarteel-Claude-Prayer-Container-Width-Fixed.html` لا يحتوي رابطًا إلى API أو plugin أو موقع؛ مواقيته وأحداثه مؤقتة (`CONFIG.prayerTimes: null`, `demoAt`, `simulate: true`) وفيه tracks ومواضع تقدم ثابتة وأسماء بيانات placeholder وأزرار Demo وانتقالات تلقائية للعرض.
- يجب نقل markup/CSS الخاصة بطبقات `prayer`, `tools`, `alert`, وكبسولة `idle-prayer` من الملف نفسه، مع إعادة وصل الأفعال إلى مشغل Tauri، وعدم نقل البيانات والمحاكاة والعرض التجريبي إلى الإنتاج. يظل ملف المرجع للقراءة فقط.

## المخاطر التشغيلية الواجب بيانها

- المواقيت متصلة بخدمة إنترنت خارجية؛ عند انقطاع الشبكة يمكن استخدام جدول حديث مخزن لنفس الموقع والطريقة والمدرسة فقط مع إظهاره كبيانات مخزنة، وإلا لا تعرض أوقاتًا.
- إشعار Windows يعتمد على سماح المستخدم وإعدادات Focus/Do Not Disturb ودعم الإشعارات المثبتة. لا يوجد صوت أذان مسجل في أصول المشروع، لذا الإخطار المطبق إشعار Windows وبطاقة داخل الجزيرة مع خيار إيقاف التلاوة.
- عملية الجدولة داخل التطبيق لا تضمن تنبيهًا بعد إغلاق البرنامج الكامل أو إيقاظ Windows من النوم. بعد الاستيقاظ يتعامل الجدول مع التوقيت الذي فات ضمن سياسة منع التكرار، ولا يلزم ذلك استيقاظ الجهاز.
