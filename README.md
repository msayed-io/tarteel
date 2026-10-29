# تَرتيل
مشغل تلاوات محلي لسطح مكتب Windows مبني بـ Tauri v2.

## الاستخدام
عند التشغيل الأول اختر مجلد الصوت. يفحص التطبيق الملفات المدعومة (`mp3`, `m4a`, `mp4`, `aac`, `flac`, `ogg`, `oga`, `wav`, `webm`) ويعرض اسم الملف كما هو على القرص. لا توجد ملفات صوت أو بيانات تجريبية مضمّنة. الاختيار والمكتبة والمفضلة تحفظ محليًا.

## التطوير
```bash
npm install
npm run dev
npm run build
npm run tauri dev
```
بناء Windows الرسمي يتم عبر GitHub Actions في `.github/workflows/windows.yml`.
