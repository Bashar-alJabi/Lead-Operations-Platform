# استيراد CSV/Excel — الحفظ الخاص والفحص ومراجعة Mapping

## مراجعة الأعمدة والقيم — Native178–179

بعد وصول الملف إلى REVIEW يستطيع مالكه اختيار Mapping صريحة لكل ورقة حسب column index،دون الاعتماد على تفرد headers. الحقول المتاحة تأتي بصفحات25 من الحملة الحالية؛لا تحميل لجميع التعريفات في المتصفح. تشمل Contact name/phone/email وDynamic Fields من نوع MANUAL/SOURCE المسموحة وفق صلاحيات source mapping الحالية. SYSTEM/CALCULATED والحقول غير الفعالة أوخارج scope محجوبة؛Manager تحتاج visibility وإمكانية التحرير للحقول MANUAL. لا تضاف صلاحية Import للـAgent.

`lead_import_mapping_revision` تحفظ recipe بلا raw cell values،بنسخ append-only لكل ورقة وrequest UUID وreal Session evidence وconfiguration fingerprint لجميع تعريفات وربوط الحملة. كل حفظ له Audit داخل المعاملة نفسها وnative current account/scope/session/file/TTL/sheet/column/Field proof. same request/intent تعيد النسخة الملتزمة،والنية المختلفة409،وCAS تمنع تجاوز نسخة أحدث. السجل25/version keyset. تغيير إعدادات الحقول يبطل المعاينة القديمة؛metadata تبين الحاجة لمراجعة جديدة وتخفي entries/target labels القديمة،والتحقق أوreplay القديم يُرفض. حفظ Mapping لا يمنح صلاحية إنشاء Lead أوCustomer send.

التحقق read-only ومحدود25 صفًا لكل صفحة. يستخدم `validateFieldValue` و`normalizeSourceContact` القائمين،ولا يفرض Contact fields ثابتة على كل Campaign. الخلية الفارغة null؛الأرقام decimal ASCII بنقطة دون grouping/exponent أوlocale guessing،والمنطقية true/false،وMULTI_SELECT/TAGS تحتاج JSON string array. القيم تخضع لخيارات الحقل الفعالة وحدوده الحالية،والعملة من configuration،وDATE/TIME/DATETIME لتنسيقها الصريح. الصيغ النصية لا تُنفذ. أخطاء الصف تشير إلى column index/code فقط؛required Fields غير المسموحة لا تُكشف أسماؤها أوUUIDs،ويظهر خطأ عام عند نقص قيمة مطلوبة.

معاينة Contact matching تستخدم الهواتف/E-mails المطَبّعة والحسابات الحالية في Organization،مع lookup مجمعة للصفحة وفهارس identity الموجودة. الحالات NONE/MATCH/AMBIGUOUS/RESTRICTED/NO_IDENTIFIER إرشادية؛لا يتم اختيار Contact أوإنشاء سجل أوتعديل أي Contact قائمة. Manager لا تحصل على IDs أوأسماء أوتفاصيل candidate بلا Lead في فرعها أوالمشتركة بفروع أخرى؛تظهر الحاجة لمراجعة Super Admin. لكلصف حتى5 visible candidates،ولا يخرج العدد المحجوب. كلنتيجة لقطة قراءة تتغير بتغير البيانات؛مرحلة intake اللاحقة يجب أن تعيد الفحص تحت identity locks. **تحليل التكرار عبر كامل الملف وحفظ قرارات المراجعة والموافقة والتنفيذ ليست منفذة في هذه الشريحة.**

API: `GET /api/lead-imports/:id/fields?after` ثم`GET /:id/mapping?sheet&before` و`POST /:id/mapping` بــsheet/version/configurationHash/requestId/entries،ثم`GET /:id/validation?sheet&version&after`. تشمل كل قراءة current private owner/scope/real Session وno-store. UI تحفظ request intent عند lost ACK حتى عبر تغيير اللغة،وتخفي القيم المشتقة عند failed read أوconfiguration conflict. بعد expiry/cancel لا يُسمح بمعاينة القيم؛recipe/history بلاقيم العملاء تبقى للتدقيق.

Native179 forward fix تزيل ambiguity لاسم متغير PL/pgSQL اكتشفتها PG integration عندربط Dynamic Field؛لم تُعدّل178 المطبقة. أعداد البوابات المعتمدة وحالة العمل الحالية فيprogress/coverage،ولا يُعد وجود Mapping وpaged validation استيرادًا مكتملًا.

## الاعتماديات التالية — تصميم غير منفذ بعد

تبدأ Native180 بمراجعة كامل dataset المختارة في الخلفية: sheet indices وMapping revisions صريحة،وcurrent configuration fingerprint،وصفوف محققة وprogress/errors وduplicate analysis داخل الملف،ثم قرارات مراجعة قابلة للتدقيق. معاينة25 صفًا الحالية ليست بديلًا عن تحقق الملف كله. تطابق identity بين صفين لا يعني دمج فرصتين؛تحتاج واجهة المراجعة بيان الأثر قبل الموافقة.

الموافقة على Import يجب أن تحفظ أصل SourceSubmission وعلاقتها بالملف/الورقة/الصف وMapping المستخدمة بصورة دائمة قبل السماح بالإدخال،وبما لا يجعل business execution تعتمد على raw quarantine قابلة للانتهاء والحذف. تبقى سياسة retention للحفظ المؤقت مستقلة عن التاريخ التشغيلي المعتمد. كل صف يحتاج مفتاحًا ونتيجة idempotent تمنع retry أوlost DB ACK من إنشاءLead مكررة،مع تقدم ونتائج Imported/Skipped/Invalid/Duplicate/Failed وفشل قابل للاستعادة حسب السبب.

Native153 تقبل origin HUMAN_MANUAL بجلسة حالية حقيقية أوSOURCE بإثبات Meta processing؛وNative053 تربط SOURCE Field provenance بـMeta mapping revision. يجب إضافة approved Import authority/provenance مستقلتين وإبقاء المسارين الحاليين محميين،لا اصطناع Session أوConnection أوMeta mapping. الإدخال يعيد current account/Branch/Campaign/Field checks وtyped normalization وidentity locks وContact review وRouting،ثم fresh post-routing origin وInitial admission المعتادين ضمن القواعد الحالية. لا يُفترض أن recipe أوhistorical approval تمنح صلاحيات دائمة.

مراجعة candidate المحجوبة/ambiguous تحتاج workflow مخولة مرتبطة بالمصدر التشغيلي وقراراته،دون منح Super Admin قراءة raw file خاصة بمستخدم آخر لمجرد مراجعة مطابقة. يشترك هذا المسار مع قواعد Contact review الحالية ولا ينشئ Role جديدة أوLead merge أوfinancial/consent confirmation منraw claims. هذه متطلبات تصميم للمرحلة التالية،وليست تنفيذًا أوإثبات اختبار لها.

## حدود التنفيذ

Native175–177 هي مرحلة upload → scan → detect → raw preview،وتضيف Native178–179 مراجعة Mapping والتحقق الموضحة أعلاه؛ليستا Import end-to-end. يستطيع Super Admin أو Manager حفظ ملف خاص داخل Branch/Campaign مخولة ومراجعة أوراقه وصفوفه بعد الفحص. لا توجد موافقة لإنشاء Leads،ولا تُنشأ Contacts أوSource Submissions أوPayments أوEnrollment،ولا يرسل محتوى الملف إلى AI أوProvider. Agent لا يملك صلاحية Import جديدة.

تبقى file-wide validation/duplicate analysis/review ثم الموافقة الصريحة وdurable row processing وresults/retry مطلوبة. ستستخدم خدمة intake مشتركة بعقد `APPROVED_IMPORT` أو equivalent موثق،مع current account/scope وimmutable approval وrow receipts. لا يجوز اصطناع cookie أوجلسة `HUMAN_MANUAL` للعامل الخلفي. Contact matching لا يدمج Leads،وraw claims عن consent أودفع ليست أدلة موثوقة.

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

بعد build/migrations001–179 وprivate storage/ClamAV deployment configuration شغّل `npm run worker:imports`. متغيرات infrastructure:

| الإعداد | default | الحدود |
|---|---|---|
|IMPORT_RETENTION_SECONDS|86400|1..604800|
|IMPORT_WORKER_BATCH|2|1..20|
|IMPORT_WORKER_POLL_MS|2000|250..60000|
|IMPORT_WORKER_ONCE|غيرمضبوط|1 لتشغيل smoke علىtest فقط|

Business setup واختيار الملف/الفرع/الحملة تتم من UI؛لا تعديل DB/CLI للمستخدم التشغيلي. لا تشغّل worker على preview أوبيانات اختبار بالتوازي مع الاختبارات التي تعيدfixtures. عند تغيير storage backend احتفظ بوصول عامل cleanup إلى backend القديمة حتى `purged_at` أوانقل objects بخطة بنية تحتية موثقة؛لا تبدل reference يدويًا. راقب Audit لأخطاء cleanup وDead Letter وage/count للملفات غير المنظفة. راجع orphans بinventory خاصة،واستثنِ كل key referenced منDB وكلupload حديثة/قيدالعمل؛أي bulk deletion تحتاج خطة reviewed مستقلة ولا ينفذها هذا الكود تلقائيًا.

## المكتبات والتحقق

CSV عبر `csv-parse`7.0.3؛[خيارات المحلل الرسمية](https://csv.js.org/parse/options/). Excel عبر SheetJS0.20.3 من[التوزيع الرسمي](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)،مثبتة بالرابط وintegrity فيlockfile،مع[خيارات القراءة الرسمية](https://docs.sheetjs.com/docs/api/parse-options/). ZIP عبرyauzl3.4.0؛[العقد الرسمي لحجم entries والـstream](https://github.com/thejoshwolfe/yauzl#openpath-options-callback). لا نستعمل نسخةSheetJS0.18.5 القديمة فيnpm registry. تحديثات Fastify/fast-uri/Nodemailer/Vite المتوافقة ضمنlockfile أعطتnpm audit0 vulnerabilities محليًا؛هذا ليس ضمان خلو شامل من الثغرات.

الأدلة النهائية والأعداد المعتمدة فيprogress/coverage. لا يُصنف Import مكتملًا حتىتنفيذ file-wide review/approval/intake/report وبقية الرحلة،ولا توجد Live Provider verification أوcustomer data في هذه الاختبارات.
