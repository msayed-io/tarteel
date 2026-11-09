# مواقيت الصلاة: المصادر والقرارات التقنية

## المصدر الخارجي

- مواقيت الصلاة: AlAdhan Prayer Times API، endpoint تقويم شهري `/v1/calendar/{year}/{month}` بإحداثيات WGS84 ومعلمات `method`, `school`, واختياريًا `timezonestring`. تمت تجربة endpoint الحي يوم 2026-10-31 على إحداثيات اختبارية وأعاد HTTP/API 200، بيانات timings مع اختصار المنطقة الزمنية، وmetadata يصرح بمنطقة IANA وطريقة الحساب والمدرسة. صفحة الوثائق: https://aladhan.com/prayer-times-api . واجهة methods الحية: https://api.aladhan.com/v1/methods .
- تقبل واجهة AlAdhan قيم Asr `school=0` (STANDARD) و`school=1` (HANAFI)، ويجب مطابقة `meta.method.id`, `meta.school`, `meta.timezone` للاستجابة مع الإعداد المتوقع قبل اعتماد البيانات. لا يصح عرض أي وقت افتراضي عند فشل المصدر.
- جيوكودينغ المدينة يدويًا: Open-Meteo Geocoding API `https://geocoding-api.open-meteo.com/v1/search?name=...&language=ar&count=8`, الذي يعيد اسم المكان والإحداثيات والمنطقة الزمنية IANA. الوثيقة: https://open-meteo.com/en/docs/geocoding-api . بيانات الموقع من GeoNames وفق attribution في الوثائق.

## صلاحيات Tauri وWindows

- Tauri geolocation الرسمي: https://v2.tauri.app/plugin/geolocation/ ومرجع JS https://v2.tauri.app/reference/javascript/geolocation/ . الدليل يصرح بدعم Windows/Linux/macOS وغيرها، ويعرّف `checkPermissions`, `requestPermissions`, `getCurrentPosition`, `watchPosition`. الإصدارات المستقرة geolocation 2.5.0 تتطلب Rust 1.90 وفق crates.io؛ لا تستخدم إصدار 3 alpha.
- Tauri notification الرسمي: https://v2.tauri.app/plugin/notification/ . يُستخدم فقط لإشعار التنبيه المسبق الاختياري، ويعتمد على إذن Windows وإعدادات الجهاز؛ لا يستدعيه موعد الصلاة الفعلي. إشعارات desktop لا تُعدّ مجدولًا للأوقات، لذلك تبقى المواعيد في Rust/Task Scheduler.
- وثائق Microsoft للموقع: https://learn.microsoft.com/en-us/windows/apps/develop/maps-and-location/get-location . تطبيقات Windows غير المعبأة لا تحتاج إعلان capability في manifest حسب هذه الصفحة، لكن يلزم طلب `RequestAccessAsync` في المقدمة. تطبيق Tauri يستخدم plugin Tauri الرسمي ولا يدعي استدعاء WinRT مباشرة.
- حلقة Rust تعمل ما دامت العملية قائمة. تُزامَن المواعيد أيضًا مع Windows Task Scheduler؛ تبدأ المهمة التطبيق مخفيًا عند الموعد وتنتظر جاهزية الواجهة ثم تشغّل ملف الأذان وتعرض بطاقة الجزيرة. إعداد `WakeToRun` لا يضمن توقيتًا صفري التأخير، وقد يقيّد Windows التنفيذ وفق الطاقة أو وضع السكون.

## ما وجد في المرجع

- ملف المستخدم المرفق `/home/ubuntu/upload/Tarteel-Claude-Prayer-Container-Width-Fixed.html` لا يحتوي رابطًا إلى API أو plugin أو موقع؛ مواقيته وأحداثه مؤقتة (`CONFIG.prayerTimes: null`, `demoAt`, `simulate: true`) وفيه tracks ومواضع تقدم ثابتة وأسماء بيانات placeholder وأزرار Demo وانتقالات تلقائية للعرض.
- يجب نقل markup/CSS الخاصة بطبقات `prayer`, `tools`, `alert`, وكبسولة `idle-prayer` من الملف نفسه، مع إعادة وصل الأفعال إلى مشغل Tauri، وعدم نقل البيانات والمحاكاة والعرض التجريبي إلى الإنتاج. يظل ملف المرجع للقراءة فقط.

## المخاطر التشغيلية الواجب بيانها

- المواقيت متصلة بخدمة إنترنت خارجية؛ عند انقطاع الشبكة يمكن استخدام جدول حديث مخزن لنفس الموقع والطريقة والمدرسة فقط مع إظهاره كبيانات مخزنة، وإلا لا تعرض أوقاتًا.
- التنبيه المسبق وحده يرسل إشعار Windows عاديًا واحدًا عند تفعيله، بصوت النظام؛ قد يمنعه إذن الإشعارات أو إعدادات Focus/Do Not Disturb. عند الصلاة الفعلية لا يظهر إشعار Windows؛ يعمل ملف `src-tauri/assets/adhan-call.mpeg` المرفق من المستخدم وتظهر بطاقة داخل الجزيرة مع زر إيقاف متصل بمحرك الصوت.
- مهمة Windows تعالج موعد الصلاة عند إغلاق النافذة أو التطبيق ببدء التطبيق مخفيًا. لا نعد بتوقيت صفري التأخير أو بإيقاظ مضمون في كل أوضاع الطاقة؛ بعد تجاوز نافذة السماح يُسجّل الموعد دون صوت لمنع أذان متأخر مزعج.
