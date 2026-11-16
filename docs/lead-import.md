# استيراد CSV/Excel — المرحلة الأولى: الحفظ الخاص والفحص والمعاينة

## حدود التنفيذ

هذه مرحلة upload → scan → detect → raw preview، وليست Import end-to-end. يستطيع Super Admin أو Manager حفظ ملف خاص داخل Branch/Campaign مخولة، ومراجعة أوراقه وصفوفه بعد الفحص. لا توجد في هذه المرحلة موافقة لإنشاء Leads، ولا تُنشأ Contacts أو Source Submissions أو Payments أو Enrollment، ولا يرسل محتوى الملف إلى AI أو Provider. Agent لا يملك صلاحية Import جديدة.

تبقى typed mapping/validation/normalization وduplicate analysis/review ثم الموافقة الصريحة وdurable row processing وresults/retry مطلوبة. ستستخدم خدمة intake مشتركة بعقد `APPROVED_IMPORT` أو equivalent موثق، مع current account/scope وimmutable approval وrow receipts. لا يجوز اصطناع cookie أو جلسة `HUMAN_MANUAL` للعامل الخلفي. Contact matching لا يدمج Leads، وraw claims عن consent أو دفع ليست أدلة موثوقة.

## التخزين والصلاحيات

`lead_import_file` تحفظ uploader وrole/branch context وBranch/Campaign الهدف وجلسة الرفع الحقيقية وrequest UUID وSHA-256 وformat/delimiter وstorage reference. السجل خاص بصاحبه حتى أمام Super Admin آخر؛لكل مستخدم رفع نسخته ضمن صلاحياته. لا public URL ولا original-file download endpoint. تستخدم الملفات MediaStorage الخاصة الموجودة، باسم UUID-hash مولّد لا علاقة له باسم العميل أو مساره. label نص غير موثوق يعرضه React كنص فقط. Query strings لا تُسجل في HTTP logs.

الـBackend يعيد التحقق من Session/account/role/Organization/Branch/Campaign قبل استقبال body وبعد storage I/O، وعند metadata/preview/history/retry/cancel. Scope الأصلي immutable؛تغيير role أوBranch context يمنع استخدام الملف القديم. Branch غير الفعالة تمنع القراءة والمعالجة. Worker تعتمد على موافقة الرفع الدائمة والحساب والنطاق الحاليين؛انتهاء جلسة الرفع أو logout لا يصنع جلسة بديلة ولا يسمح بتنزيل بيانات دون جلسة جديدة حقيقية.

Preview تعيد 25 صفًا كحد أقصى باستخدام keyset `(file,sheet,row_number)`،وmetadata/history/catalogs محدودة25،وقائمة الملفات10. الأعمدة Arrays مفهرسة،فتبقى headers المتكررة و`__proto__` بيانات دون تحويلها إلى object keys. تبقى قيم CSV strings دون cast أو تقييم صيغ،ويُعرض رقم record بعد header؛الأسطر المضمنة في حقل quoted لا تغير هذا المعنى. في Excel تحفظ أرقام صفوف الورقة الفعلية وتُقرأ الخلايا كنصها المعروض. الهواتف والمعرّفات يجب أن تكون text في المصدر للحفاظ على leading zeros والدقة التي قد يكون Excel فقدها أصلًا.

## فحص الملفات وحدود الموارد

- الامتداد المقصود مع signature/encoding؛لا نثق في MIME أو filename وحدهما. CSV: UTF-8 صارمة مع optional BOM وdelimiter صريح comma/semicolon/tab وstrict quotes/column count. HTML/XML masquerading وbinary/control bytes غير المناسبة مرفوضة.
- Scan عبر ClamAV قبل تحليل المحتوى أو نشر preview. غياب scanner أو stale definitions يفشل بصورة مغلقة،ولا يحول الملف إلى REVIEW.
- XLSX: فحص ZIP streaming بـ`yauzl` مع `lazyEntries` و`validateEntrySizes` وstrict names وقراءة expanded bytes الفعلية. تُرفض duplicate/path traversal/encryption/embedded objects/VBA entries والأرشيفات غير المتسقة. لا extraction إلى filesystem.
- Parser تعمل في process Node مستقلة: V8 heap128MiB وdeadline15s،بدون أسرار environment الموروثة أوstdout/stderr للمحتوى،وبـNode permission model لقراءة مجلد parser وnode_modules وpackage metadata اللازمة فقط،دون إذن كتابة أوchild processes إضافية. ليست هذه ضمان hard RSS أوOS/container sandbox؛ZIP expansion bounded والحدود أدناه هي طبقات الحماية الفعلية،وتبقى اختبارات الحمل الشاملة مطلوبة.
- صيغ Excel/array formulas وerror cells والماكرو مرفوضة،ولا تُستخدم cached formula result كحقيقة. Hyperlinks لا تُفتح ولا تُنفذ،ولا يوجد network lookup للمحتوى. `CodeName` وحدها ليست دليل ماكرو في XLS عادية.

الحدود التقنية الحالية:8MiB input،10,000 data rows إجمالًا،10 non-empty sheets،64 columns،8192 characters/cell و256/header،64KiB CSV record،16MiB مجموع نص Excel،512 ZIP entries و16MiB لكل entry و32MiB expanded total. تجاوز الحد يرفض الملف كله؛لا truncation أو partial success. الحد 128MiB يخص V8 heap،ولا يعني قياس RSS. هذه budgets قابلة لإعادة التقييم بالقياس وليست Business capacity guarantees. هناك uploads2 متزامنتان لكل API process،و10uploads/minute/IP،وحصة10 ملفات غير منظفة لكل مستخدم و200 لكلOrganization. حصص التخزين تُراجع داخل advisory lock،وتشمل cancelled files التي لم تحذف مادتها بعد لمنع ملء القرص عبر cancel المتكرر.

## العامل والأدلة والفشل

`worker:imports` تستعمل `FOR UPDATE SKIP LOCKED` وlease token240s؛تترك DB أثناء storage/scan/parse ثم تعيد current scope والlease بساعة DB قبل الحفظ. إذا أُلغي الملف أوانتهت lease فلا يمكن للعامل القديم نشر بياناته. الصفوف والأوراق immutable،ولا تُكتب إلا مع current RUNNING lease وfresh same-transaction parse Audit. REVIEW تحتاج scanner evidence وتطابق count مع الصفوف والأوراق. حالات job:WAITING/RUNNING/REVIEW/REJECTED/DEAD_LETTER/REVOKED/CANCELLED/EXPIRED.

الفشل transient يعاد خمس محاولات مع2/4/8/16s ثم DEAD_LETTER؛الـlease المنتهية تُستعاد بدل فقد job. Parser/security rejection دائمة ولا تعيد معالجة محتوى مرفوض بلا رفع جديد. رد worker يخفي تفاصيل الأخطاء/المحتوى. بعد Dead Letter يستطيع صاحب الملف ضمن current Session/scope طلب CAS recovery صريحة تعيد attempts،مع Audit جديدة؛لا يؤدي replay لنفس upload request إلى recovery ضمنية. فشل Audit أوحفظ الصفوف يرجع المعاملة كلها،ثم تسجل محاولة فاشلة دون partial preview. تحفظ history25/version keyset دون raw cell values.

TTL افتراضية24h وبحد أقصى7days،محسوبة بساعة DB. القراءة تمنع فور انقضائها دون انتظار worker. Cancel/expiry/rejection/revocation تمحو parsed rows وتبقي metadata/history/Audit؛storage cleanup تحذف object بصورة idempotent. فشل حذف object لا يعطل scan/parse لملف آخر: native persisted backoff يبدأ10/20/40/80s،وبعد خمس failures housekeeping واحدة كل ساعة حتى تعافي storage. يظهر `IMPORT_FILE_PURGE_FAILED` في status/UI وAudit؛لا تُعاد إتاحة البيانات بسببه. هذا مسار تنظيف تقني متكرر لعملية delete آمنة،وليس retry غير محدود لفعل Business. `purged_at` تثبت نجاح الحذف،ولا ندعي حذف bytes فعلًا قبلها.

نجاح put ثم DB outcome غير معروف قد يترك orphan؛لا يحذفه التطبيق عميانيًا كيلا يحذف object ملتزمة. Housekeeping موثقة أدناه،ولا توجد public access للـorphans.

## API والتشغيل

`POST /api/lead-imports?branchId&campaignId&label&format&delimiter&requestId` بbody `application/octet-stream` →202. نفس UUID ونفس bytes/options تعيد نفس الملف بعد current access checks؛intent مختلفة409. response lost تُعاد من UI بنفس File/UUID حتى عبر تغيير اللغة. ترك retry لا يحذف سجلًا قد يكون التزم؛يمكن إيجاده من Refresh ثم cancel.

`GET /api/lead-imports/catalog?kind=BRANCH|CAMPAIGN&branchId&after` اختيارات25 معالحفاظ على الاختيار أثناء pagination. `GET /api/lead-imports?after` قائمة10. `GET /:id?before=version` status/history. `GET /:id/rows?sheet&after` current scanned rows25. `POST /:id/retry` أو`/:id/cancel` مع`{version}`. كلJSON الخاصة `Cache-Control:no-store`،ولا expose storage key أوlease token.

بعد build/migrations001–177 وprivate storage/ClamAV deployment configuration شغّل `npm run worker:imports`. متغيرات infrastructure:

| الإعداد | default | الحدود |
|---|---|---|
|IMPORT_RETENTION_SECONDS|86400|1..604800|
|IMPORT_WORKER_BATCH|2|1..20|
|IMPORT_WORKER_POLL_MS|2000|250..60000|
|IMPORT_WORKER_ONCE|غيرمضبوط|1 لتشغيل smoke علىtest فقط|

Business setup واختيار الملف/الفرع/الحملة تتم من UI؛لا تعديل DB/CLI للمستخدم التشغيلي. لا تشغّل worker على preview أوبيانات اختبار بالتوازي مع الاختبارات التي تعيدfixtures. عند تغيير storage backend احتفظ بوصول عامل cleanup إلى backend القديمة حتى `purged_at` أوانقل objects بخطة بنية تحتية موثقة؛لا تبدل reference يدويًا. راقب Audit لأخطاء cleanup وDead Letter وage/count للملفات غير المنظفة. راجع orphans بinventory خاصة،واستثنِ كل key referenced منDB وكلupload حديثة/قيدالعمل؛أي bulk deletion تحتاج خطة reviewed مستقلة ولا ينفذها هذا الكود تلقائيًا.

## المكتبات والتحقق

CSV عبر `csv-parse`7.0.3؛[خيارات المحلل الرسمية](https://csv.js.org/parse/options/). Excel عبر SheetJS0.20.3 من[التوزيع الرسمي](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)،مثبتة بالرابط وintegrity فيlockfile،مع[خيارات القراءة الرسمية](https://docs.sheetjs.com/docs/api/parse-options/). ZIP عبرyauzl3.4.0؛[العقد الرسمي لحجم entries والـstream](https://github.com/thejoshwolfe/yauzl#openpath-options-callback). لا نستعمل نسخةSheetJS0.18.5 القديمة فيnpm registry. تحديثات Fastify/fast-uri/Nodemailer/Vite المتوافقة ضمنlockfile أعطتnpm audit0 vulnerabilities محليًا؛هذا ليس ضمان خلو شامل من الثغرات.

الأدلة النهائية والأعداد المعتمدة فيprogress/coverage. لا يُصنف Import مكتملًا حتىتنفيذ mapping/intake/report وبقية الرحلة،ولا توجد Live Provider verification أوcustomer data في هذه الاختبارات.
