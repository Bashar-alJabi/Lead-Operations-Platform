# تنفيذ الصفوف المعتمدة للاستيراد — Native183–184

## السلوك والصلاحيات

تصل هذه المرحلة المصدر المعتمد في 181–182 إلى Lead فعلية. يبدأ Super Admin أو Manager مالك الملف التنفيذ صراحة من واجهة النتائج،بجلسة حقيقية ونطاق حالي وحملة ACTIVE. توجد `lead_import_execution` واحدة لكل dataset ؛نفس UUID يعيد execution نفسها،والنية المختلفة 409. لا backfill أوتشغيل تلقائي للاعتمادات القديمة. يبقى البدء والقراءة ممكنين بعد انتهاء الملف الخاص أوحذفه لأن المصدر المعتمد مستقل عن quarantine.

لكلصف `lead_import_result` بحالة WAITING/IMPORTED/SKIPPED/INVALID/NEEDS_ATTENTION/FAILED و version/failure count/error وتاريخ append-only. SKIP/INVALID نهائيتان دون Lead. الأعداد المعروضة نتائج تنفيذ فعلية منفصلة عنقرارات الموافقة،و Duplicate عدد علامات التكرار الأصلية. كلصف Keep ينشئ Lead مستقلة حتىعند استخدام Contact موجودة؛لا Lead merging.

يعيد كلصف فحص الحساب والدور و Organization/Branch/ACTIVE Campaign و Field scope/activity/visibility/editability والقيم المطلوبة. انتهاءجلسةالموافقة أو TTL لايصنعجلسة worker ولايلغيالمصدر وحده؛تعطيلالحساب أوتغييردوره/نطاقه يمنعالآثارالقادمة ويظهر NEEDS_ATTENTION. الاستعادة تحتاججلسةحقيقيةحالـية. الموافقةالتاريخية لاتمنحصلاحيةدائمة.

تستخدمالخدمة `validateFieldValue` وتتحقق من required LEAD_CREATION و SOURCE/MANUAL Fields المسموحة للموافق الأصلي. لاتعادقراءةالخلايا الخام أوتخمين locale. تغير Configuration لايعيدكتابةالموافقة: القيمة التي تبقىصالحة ومسموحة يمكنتنفيذها،والقيمةالمحجوبة أوغيرالصالحة تحتاجتصحيحًا واستعادةصريحة. أي coercion يغيرالقيمةالمعتمدة يُرفض. attempt تحفظبصمةالتكوينالحالية معبقاءبصمةالموافقة و Mapping الأصلية. Native تعيد استخدام pure typed validator القائمة وتطابق القيم والمراجع الأصلية؛لا AI أو Provider call للتحقق.

يستخدم الاستيراد تحقق الجاهزية نفسه في إدخال المصادر. إذا كانت Messaging مفعلة مع تعطيل AI، يتحقق العامل من Sender في نطاق الحملة قبل إنشاء الفرصة. يؤدي غياب Sender مؤهل أو غياب السياسة الأولية لحملة مفعّل فيها AI إلى `IMPORT_CAMPAIGN_FLOW_NOT_READY`. عند تفعيل AI مع سياسة أولية معتمدة، يسجّل إدخال الفرصة إيصالًا يمكن أن يطلق تقييم الجاهزية الأولية.

## Contacts والمراجعة التشغيلية

تستخدمالخدمة `lockSourceIdentities` و `sourceCandidatePage` و normalized phone/email الحالية داخل identity locks المشتركة مع manual/Meta intake و Contact edit. لا matching بالاسم وحده. Contact اختيارية بحسب Mapping: الصفبلاتواصل يمكنأنيُنشئ Lead دون Contact ،و name-only ينشئ Contact جديدة دونتخمينهوية. Candidate وحيدة متاحة ضمننطاقالموافق يمكنإعادةاستخدامها؛ ambiguous أو shared/other-branch/unattached candidate أمام Manager تذهب للمراجعة.

`/api/import-contact-reviews` قائمةتشغيلية مستقلة عنالملف. Super Admin ضمن Organization أو Manager ضمن Branch يحتاججلسةوصلاحياتحالية عندكلقراءة وحسم. القائمة تعرض source references فقط،و candidates محدودة 25/keyset. تفاصيلالجهاتالمقيدة محجوبة بالكامل عن Manager. يستطيع Super Admin حسمالمصدر المخول دونقراءة ملفرفع Manager الخاص.

القرار صريح: contact/reason/version/requestUUID. تعادفحوص identity/current candidate/role/session عندالحسم،وينفذالصف فيالمعاملةنفسها. same-intent concurrent replay لايصنع Lead ثانية؛تغيرالنية 409. Lead انتقلتلاحقًا خارج Scope لايكشفها resultrow أوقرارقديم معاد. Contact review لاتمنحالمراجع صلاحيةتجاوز Field grants للموافق الأصلي.

## المعاملة والأدلة الأصلية

العمل DB-only ،وكلصف معاملةبـ statement10s/lock750ms و branch→campaign→account→file/Fields→result locks. لا external I/O أو network lease. crash يرجعالصفكاملًا،والـ version تمنععاملًا متأخرًا مننشرنتيجة فوقنسخةأحدث. worker تتناوب scan/review ثمحتى 25rowtransactions مستقلة لكلتكرار IMPORT_WORKER_BATCH ؛الافتراضيحتى 50 صفًا/cycle مع batch2. هذه budgets تقنية وليست Business limits أو capacity guarantees. يمكنضبط batch1..20/poll250..60000 وفققياسالبيئة؛العملياتالأخرى لاتنتظرانتهاءالملف كله.

`lead_import_attempt` immutable تربط source/result version/new Lead/contact/current configuration ،وتحفظ resolver/session/request/reason عندالحسمالبشري. Native guards تتحققمن current authority و fresh Audit. التسلسل ضمنالمعاملة: Contact resolution/create →attempt →fresh Lead birth →trusted source link →SOURCE Fields/history →Lead activity →shared Routing →IMPORTED result/history →APPROVED_IMPORT receipt →existing Initial admission/notification/automation hooks.

Source raw_payload/scope/identity لاتتغير؛المسموحفقط RECEIVED→PROCESSED وربط Lead/contact الفعليتينبـ fresh proof. لايمكنأنتلتزم attempt منفردة: deferred complete proof تحتاج result/source/receipt وكل approved Fields/history بالآثارذاتها. لا old Lead أو source مصطنعة أو partial commit.

Field provenance تحفظ `source_submission_id` و `source_mapping_version` ،وتضيف `source_import_dataset_id`/`source_import_sheet_index` و FK إلى manifest ؛مفاتيح Meta تبقىمستقلة. SOURCE هناقيمةمستوردة،حتىإنكانت Field من value mode MANUAL. Human/AI المصرحلهما يمكنتغيير current manual Field عبرالخدماتالحالية معمسح current import pointers وبقاء history الأصلية. Native تمنعتعديلالتاريخ أواستعمال approval لإنشاءقيمةعلى Lead قديمة. APPROVED_IMPORT مستقلة عن HUMAN_MANUAL و Meta SOURCE ،وسياقاتالسجلاتالقديمة لاتُعادكتابتها.

## الفشل والواجهة والتشغيل

Business failures تسجل NEEDS_ATTENTION بكودآمن بعد rollback لأيآثارجزئية. DB/Audit failures ترجعالجميع وتُحاول 2/4/8/16s ثم FAILED عند 5. لانص exception أو customer values في errors. recovery تحتاج current real-session/version/request identity وتعيد WAITING دونتكرار Lead ملتزمة. فشلحفظ failure نفسها يبقيالصفالأصلي ويظهر worker-cycle error آمنة؛لاحقًا يعادالفحص دون partial effects. لا SQL repair للمستخدمالتشغيلي.

UI ar/en/fr تشمل start confirmation/counts/filters/results25/history25/retry/Contact review وفتح Lead المخولة. lost202/200ACK تعادنفس intent عبرتغييراللغة. failed reads تمحوالبياناتالقديمة،وفقدصلاحيةالملف يمسح parent preview. Lead Details تميز APPROVED_IMPORT و routing التاريخية؛ Search/Analytics/Campaign source choices تشمل IMPORT_CSV و IMPORT_EXCEL. typed Fields تستخدم Lead UI القائمة بصلاحياتهاالحالية.

حذف quarantine أوانتهاء TTL لايلغي approved execution أو originals/results. raw claim أو receipt أو CSV Field لايؤكد Payment/Enrollment أو consent. لاتوجد Provider credentials جديدة أو send داخلخدمةالاستيراد؛ CMP و sender و AI prerequisites الحالية تطبقعلىأي action لاحقة.

## API والقبول

الجذرالخاص `/api/lead-imports/:id/approved-datasets/:datasetId`:

- POST `/execute` مع requestId →202 execution ID.
- GET `/execution` →counts/metadata أو null قبلالبدء.
- GET `/execution/rows?state&afterSheet&afterRow` →25metadata ؛لا raw/contact/Field values ،و Lead ID عند current Lead access فقط.
- GET `/execution/rows/:submissionId/history?before` →25version metadata.
- POST `/execution/rows/:submissionId/retry` مع version/requestId →same-intent recovery.

المراجعةالتشغيلية: GET `/api/import-contact-reviews?after` ثم GET `/:submissionId/candidates?after` ثم POST `/:submissionId/resolve` مع version/requestId/contactId/reason. JSON الخاصة no-store ؛لا Agent import privilege ولااعتمادعلىإخفاءالواجهة.

الدليل والأعداد النهائية في progress/coverage بعدالبوابات. Google Sheets و generic API/source adapters وبقيةالمنصة تبقى Required. sustained load/restore و legacy nonempty migration و cross-module AI/provider acceptance قبولأوسع باقٍ. لا Platform Complete أو Live verification claim.
