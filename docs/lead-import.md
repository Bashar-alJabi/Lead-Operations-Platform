# استيراد CSV/Excel — الحفظ الخاص والفحص ومراجعة dataset

## اعتماد أصل المصدر — Native181–182

بعد READY يستطيع مالك الملف Super Admin أوManager،بجلسة حقيقية وصلاحيات ونطاق حاليين،اعتماد dataset للحملة ACTIVE. يلزم تأكيد صريح لسياسة `KEEP_VALID_UNIQUE`: الصف الصالح الفريد بلا قرار يصبح `READY_FOR_INTAKE`،وقرار Skip الصريح يبقى `SKIPPED`،وغير الصالح دون Skip يبقى `INVALID`. كل صف صالح مكرر يحتاج قرار Keep/Skip مستقلًا قبل الاعتماد. هذه dispositions مرشحة للتنفيذ اللاحق،وليست أعداد Leads منفذة أوصلاحية لاختيار Contact متعارضة.

الموافقة ذرية: Audit ثم `lead_import_dataset` immutable مع review/version/configuration/policy/real Session/counts،وmanifest لكلورقة في `lead_import_dataset_sheet`،وoriginal `SourceSubmission` لكلصف،ثم `lead_import_dataset_row` تحجز original source ID وtyped contact/Fields/errors ونسخ Mapping والقرار وdisposition/duplicate. complete-capture proof مؤجلة إلى commit تتحقق من العدد والنطاق والتكوين والصفوف والأصول والأوراق معًا؛فشل أيجزء يرجع الجميع. guards تمنع أصلاً مصطنعًا أوsnapshot ناقصة أوتعديل الأصل أوالاعتماد لاحقًا،وunique `(file,sheet,row)` تمنع اعتماد الصف نفسه ثانية عبرمراجعة جديدة. تغيير قرار review بعد الحفظ لا يغير snapshot المعتمدة. لا schema/receipt أوcookie Human مزيفة ولاMeta Connection/Mapping مصطنعة.

Native182 تحفظ headers/name/header-row/count مرة واحدة لكلورقة وMapping immutable بالمرجع. `SourceSubmission.raw_payload` schema2 تحفظ dataset/file/sheet/row/cells/Mapping version/review references،وfile metadata/hash الأصلية محفوظة فيسجل الملف. بذلك لا تتكرر headers/Mapping entries لكلصف. الخلايا هي parsed display values الأصلية وليست أرشيف binary للملف. migration forward تستخرج manifest للـschema1 الموجودة دون إعادة كتابة أيoriginal؛اختبار ترقية ببيانات schema1 سابقة غيرفارغة لم ينفذ في هذه البوابة،ولا يُدّعى ذلك.

هذه الأصول وtyped approval لا تتبع quarantine rows بـcascade؛تبقى بعد cancel/expiry/storage cleanup،ولا يمدد ذلك raw preview TTL. كلصف،بما فيهSkipped/Invalid،له أصل محفوظ للتتبع،ولا يتحول paid/consent claim إلىحقيقة. لا توجد في Native181–182 معالجة Lead أوContact أوPayment/Enrollment أورسالة أوAI action. source state تبقى RECEIVED؛تعديلها محجوب حتى إضافة trusted intake proof التالية. `lead_import_dataset_current` دليل **وقت الموافقة فقط** يتطلب raw TTL وجلسة حاضرة؛لا يجوز استخدامه مستقبلاً كصلاحية worker تاريخية بعدانتهاءالجلسة أوالملف.

API: `POST /api/lead-imports/:id/reviews/:reviewId/approve-dataset` مع `{version,requestId,unreviewedPolicy:'KEEP_VALID_UNIQUE'}` تعيد201 و`{datasetId,state:'SOURCE_CAPTURED'}`. same intent تعيد الاعتماد الملتزم،حتىبعدانتهاءالملف،بعد current private-owner/scope/Session checks؛تغييرالنية409. `GET /:id/approved-datasets?after` تعرض25 metadata/counts،و`GET /:id/approved-datasets/:datasetId/rows?afterSheet&afterRow` تعرض25 receipt metadata فقط دون raw/contact/Field values. هاتان القراءتان تعملان بعدإزالةquarantine،ولا تمنحان Super Admin أخرى أوManager آخر قراءة ملف خاص ليس له. مراجعة Contact التشغيلية التالية تحتاج endpoint وصلاحيات مستقلة،وليست توسيعًا لخصوصية الملف.

UI ar/en/fr تعرض سياسة checkbox وconfirmation وcounts وreference وreceipt pagination،وتعيد lost201 ACK بنفس UUID عبرتغييراللغة. تفشل reads بإزالةالمعلوماتالقديمة،وتبقى source receipts بعدحذفالملف. تعرض الواجهة بوضوح أن الاعتماد لا ينشئ Leads،وتعطل قرارات الصف بعداعتماد snapshot. **التالي المطلوب Native183: APPROVED_IMPORT authority وField provenance ثم durable row intake/results/recovery وLead UI؛Import end-to-end ما زالت غيرمكتملة.**

## مراجعة كامل الملف — Native180

يختار المالك صراحة sheets وMapping versions الحالية بعد الفحص. `lead_import_review` تحفظ envelope immutable تشمل file/revision/request UUID وreal Session وselection وconfiguration fingerprint وعدد الصفوف،دون منح صلاحية intake. إنشاء مراجعة جديدة يحتاج CAS على آخر revision،ويلغي السابقة ويحذف قيمها المشتقة بمعاملة واحدة. same intent يعيد نفس job؛نية مختلفة أونسخة قديمة409. history metadata وقرارات الصفوف تبقى append-only بعد حذف القيم.

`worker:imports` يتناوب بين فحص ملف ودفعة review،حتى لا يحجب scan backlog التحقق. كلدفعة بحد أقصى100 صف داخل معاملة PostgreSQL واحدة مع file/job lock وcurrent account/Branch/Campaign/Field configuration. لا external I/O في هذه المرحلة،ولذلك المعاملة نفسها هي claim: crash أوfailure يرجع الدفعة كاملة،والعامل التالي يكمل الصفوف الناقصة دون fake Session أوlease قديمة. locks تستخدم SKIP LOCKED للملف وstatement/lock timeouts الموجودة؛كلcycle حتىbatch عمليات scan وbatch عمليات review. تغيّر account/scope أوMapping/configuration يجعلها STALE ويحذف derived values؛خمس failures مسجلة بــ2/4/8/16s إلى FAILED،ثم current real Session/CAS retry. فشل Audit يمنع نشر الصفوف أوالقرار. لا تفاصيل customer values أونصexception في job errors/Audit.

تستخدم جميع الصفوف المحققات والتطبيع نفسيهما المستخدمين في paged preview. تخزن `lead_import_review_row` contact/typed fields/errors المؤقتة،وتعرض progress وvalid/invalid counts. بعد READY فقط تعاد الصفوف25/keyset `(sheet,row)`،مع ALL/INVALID/DUPLICATE/UNREVIEWED filters. phone/email indexes تدعم duplicate advice عبر جميع الأوراق المختارة؛تطابق أحدهما يعني duplicate row،ولا الاسم وحده ولا transitive grouping ولاLead merge. العدد يشمل جميع الصفوف المطابقة،وليس عدد مجموعات هوية. Contact advice تعاد من السجلات والصلاحيات الحالية،ولا تتحول candidate المحجوبة إلىauthority من خلال snapshot قديمة. قيم Fields مرتبطة ببصمة configuration؛تثبت shared locks تعريفات وربوط الحملة أثناء القراءة حتى لا يغير permission update متزامن visibility بين فحص البصمة وإرجاع القيم.

قرار كلصف `SKIP` أو`KEEP_AS_NEW_LEAD` اختياري وصريح،ومحفوظ بنسخة مستقلة وrequest UUID وreal Session/Audit. لا يسمح KEEP لصف غير صالح. تعني KEEP فرصة مستقلة مرشحة **لموافقة لاحقة**؛ليست اختيار Contact ولاpermission لتجاوز ambiguous/restricted identity،ولا تنشئ Lead أوPayment/Enrollment/consent/customer send. القرارات لا تُطبق تلقائيًا على الصفوف المشابهة. summary تبين duplicates/unreviewed/skipped/kept؛التاريخ25/version وCAS تمنع overwrite متزامنة. الواجهة ar/en/fr تدعم اختيار الأوراق والتقدم والصفحات والفلاتر والقرارات وسجلاتها،وتعيد request نفسها عند lost ACK عبر تغيير اللغة،وتمسح derived values عند failed read وparent preview عند فقدصلاحية الملف.

FK من derived row إلى quarantine raw row مع ON DELETE CASCADE تجعل cancellation/expiry/revocation/purge تمحو القيم المشتقة أيضًا،معnative delete gates؛لا إطالة صامتة للـTTL. recipes/job metadata/decision history لا تحفظ raw cell values وتبقى للتدقيق. لا raw download endpoint أوصلاحية جديدة لمستخدم آخر. المقادير الحالية bounds تقنية قابلة للقياس،وليست capacity guarantee.

API: `POST /api/lead-imports/:id/reviews` بــrevision/requestId/configurationHash/selection،و`GET /reviews?before`،و`GET /reviews/:reviewId?before` للـprogress/history،و`GET /reviews/:reviewId/rows?filter&afterSheet&afterRow`،و`POST /reviews/:reviewId/decisions` بــsheet/row/version/requestId/action،و`GET /decisions?sheet&row&before`،ثم`POST /retry|cancel` بــjob version. كلقراءة/قرار تحتاج private current owner/scope/real Session وno-store. approved dataset نُفذت لاحقًا في181–182 أعلاه؛تبقى durable intake/results مطلوبة.

## مراجعة الأعمدة والقيم — Native178–179

بعد وصول الملف إلى REVIEW يستطيع مالكه اختيار Mapping صريحة لكل ورقة حسب column index،دون الاعتماد على تفرد headers. الحقول المتاحة تأتي بصفحات25 من الحملة الحالية؛لا تحميل لجميع التعريفات في المتصفح. تشمل Contact name/phone/email وDynamic Fields من نوع MANUAL/SOURCE المسموحة وفق صلاحيات source mapping الحالية. SYSTEM/CALCULATED والحقول غير الفعالة أوخارج scope محجوبة؛Manager تحتاج visibility وإمكانية التحرير للحقول MANUAL. لا تضاف صلاحية Import للـAgent.

`lead_import_mapping_revision` تحفظ recipe بلا raw cell values،بنسخ append-only لكل ورقة وrequest UUID وreal Session evidence وconfiguration fingerprint لجميع تعريفات وربوط الحملة. كل حفظ له Audit داخل المعاملة نفسها وnative current account/scope/session/file/TTL/sheet/column/Field proof. same request/intent تعيد النسخة الملتزمة،والنية المختلفة409،وCAS تمنع تجاوز نسخة أحدث. السجل25/version keyset. تغيير إعدادات الحقول يبطل المعاينة القديمة؛metadata تبين الحاجة لمراجعة جديدة وتخفي entries/target labels القديمة،والتحقق أوreplay القديم يُرفض. حفظ Mapping لا يمنح صلاحية إنشاء Lead أوCustomer send.

التحقق read-only ومحدود25 صفًا لكل صفحة. يستخدم `validateFieldValue` و`normalizeSourceContact` القائمين،ولا يفرض Contact fields ثابتة على كل Campaign. الخلية الفارغة null؛الأرقام decimal ASCII بنقطة دون grouping/exponent أوlocale guessing،والمنطقية true/false،وMULTI_SELECT/TAGS تحتاج JSON string array. القيم تخضع لخيارات الحقل الفعالة وحدوده الحالية،والعملة من configuration،وDATE/TIME/DATETIME لتنسيقها الصريح. الصيغ النصية لا تُنفذ. أخطاء الصف تشير إلى column index/code فقط؛required Fields غير المسموحة لا تُكشف أسماؤها أوUUIDs،ويظهر خطأ عام عند نقص قيمة مطلوبة.

معاينة Contact matching تستخدم الهواتف/E-mails المطَبّعة والحسابات الحالية في Organization،مع lookup مجمعة للصفحة وفهارس identity الموجودة. الحالات NONE/MATCH/AMBIGUOUS/RESTRICTED/NO_IDENTIFIER إرشادية؛لا يتم اختيار Contact أوإنشاء سجل أوتعديل أي Contact قائمة. Manager لا تحصل على IDs أوأسماء أوتفاصيل candidate بلا Lead في فرعها أوالمشتركة بفروع أخرى؛تظهر الحاجة لمراجعة Super Admin. لكلصف حتى5 visible candidates،ولا يخرج العدد المحجوب. كلنتيجة لقطة قراءة تتغير بتغير البيانات؛مرحلة intake اللاحقة يجب أن تعيد الفحص تحت identity locks. Native180 تضيف whole-file duplicate review وقراراتها و181–182 موافقة source؛التنفيذ الفعلي ما زال مطلوبًا.

API: `GET /api/lead-imports/:id/fields?after` ثم`GET /:id/mapping?sheet&before` و`POST /:id/mapping` بــsheet/version/configurationHash/requestId/entries،ثم`GET /:id/validation?sheet&version&after`. تشمل كل قراءة current private owner/scope/real Session وno-store. UI تحفظ request intent عند lost ACK حتى عبر تغيير اللغة،وتخفي القيم المشتقة عند failed read أوconfiguration conflict. بعد expiry/cancel لا يُسمح بمعاينة القيم؛recipe/history بلاقيم العملاء تبقى للتدقيق.

Native179 forward fix تزيل ambiguity لاسم متغير PL/pgSQL اكتشفتها PG integration عندربط Dynamic Field؛لم تُعدّل178 المطبقة. أعداد البوابات المعتمدة وحالة العمل الحالية فيprogress/coverage،ولا يُعد وجود Mapping وpaged validation استيرادًا مكتملًا.

## اعتماديات الإدخال المتبقية — تصميم غير منفذ بعد

بعد حفظ الموافقة في Native181–182 تأتي trusted row execution. لا تكفي معاينة25 صفًا أوreview decision للمعالجة؛يحتاج العامل immutable approved dataset وcurrent account/scope/Fields وfresh per-row proof. تطابق identity بين صفين لا يعني دمج فرصتين. لا تستخدم review decision أوsource approval كـpayment/consent/Contact resolution proof.

أصل SourceSubmission وعلاقته بالملف/الورقة/الصف وMapping محفوظ بالفعل خارجraw TTL. كل صف ما زال يحتاج execution identity ونتيجة idempotent تمنع retry أوlost DB ACK من إنشاءLead مكررة،مع تقدم ونتائج Imported/Skipped/Invalid/Duplicate/Failed وفشل قابل للاستعادة حسب السبب. rawquarantine ليستاعتمادًاوقتالتنفيذ،ولاتمددحياةجلسةالموافقة.

Native153 تقبل origin HUMAN_MANUAL بجلسة حالية حقيقية أوSOURCE بإثبات Meta processing؛وNative053 تربط SOURCE Field provenance بـMeta mapping revision. يجب إضافة approved Import authority/provenance مستقلتين وإبقاء المسارين الحاليين محميين،لا اصطناع Session أوConnection أوMeta mapping. الإدخال يعيد current account/Branch/Campaign/Field checks وtyped normalization وidentity locks وContact review وRouting،ثم fresh post-routing origin وInitial admission المعتادين ضمن القواعد الحالية. لا يُفترض أن recipe أوhistorical approval تمنح صلاحيات دائمة.

مراجعة candidate المحجوبة/ambiguous تحتاج workflow مخولة مرتبطة بالمصدر التشغيلي وقراراته،دون منح Super Admin قراءة raw file خاصة بمستخدم آخر لمجرد مراجعة مطابقة. يشترك هذا المسار مع قواعد Contact review الحالية ولا ينشئ Role جديدة أوLead merge أوfinancial/consent confirmation منraw claims. هذه متطلبات تصميم للمرحلة التالية،وليست تنفيذًا أوإثبات اختبار لها.

## حدود التنفيذ

Native175–177 هي مرحلة upload → scan → detect → raw preview،وتضيف Native178–179 Mapping/paged validation،ثمNative180 whole-dataset validation/duplicate review/decisions وNative181–182 immutable source approval/capture؛ليست Import end-to-end. يستطيع Super Admin أو Manager حفظ ملف خاص داخل Branch/Campaign مخولة ومراجعته واعتماد مصدره. توجد SourceSubmissions محفوظة لكلصف معتمد،ولا توجد بعدصلاحية لإنشاء Leads أوContacts أوPayments أوEnrollment،ولا يرسل محتوى الملف إلى AI أوProvider. Agent لا يملك صلاحية Import جديدة.

الموافقة الصريحة وأصلها نُفذا في181–182؛تبقى durable row processing وresults/retry مطلوبة. ستستخدم خدمة intake مشتركة بعقد `APPROVED_IMPORT` أو equivalent موثق،مع current account/scope وimmutable approval وrow receipts. لا يجوز اصطناع cookie أوجلسة `HUMAN_MANUAL` للعامل الخلفي. Contact matching لا يدمج Leads،وraw claims عن consent أودفع ليست أدلة موثوقة.

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

بعد build/migrations001–182 وprivate storage/ClamAV deployment configuration شغّل `npm run worker:imports`. متغيرات infrastructure:

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
