# Bulk Fields/Status/Tags — Native170–171

هذه شريحة من Bulk الأساسية؛ليست اكتمالًا للـBulk أوImport/Export أوAutomation. الشريحة Implemented وPostgreSQL/Local Browser Verified بالبوابة النهائية المسجلة أدناه،ولا Live أوProduction claim.

## العقد والصلاحيات

عملية Human مؤكدة ومحدودة حتى50 Lead،بثلاث عمليات typed فقط: SET أوADD_TAGS أوREMOVE_TAGS. Status وInterest وTags تتبع Campaign Fields الحقيقية،ولا توجد Status/Tags تجارية ثابتة جديدة أوصلاحية إضافية. Agent لا يغير إلا Lead المخصصة له وField مرئية قابلة للتحرير. Manager ضمن Branch الحالية،وSuper Admin ضمن Organization. SOURCE/SYSTEM/CALCULATED والحقول المخفية أوغيرالقابلة للتحرير ليست قابلة للكتابة.

أول Lead مختارة توفر قائمة الحقول الحالية المخولة. Preview واحدة bounded/set-based تجمع current snapshots لكل عنصر دون N+1 metadata requests. Field definition version يجب أن تطابق ما عرضته قائمة الحقول. unknown/hidden/out-of-scope Field/Lead تعيد نفس فشل preview الآمن،دون values أووصف Field مخفية. تراجع UI Lead version المعروضة وقت التحديد،وتوضح عدد المؤهلة/المحددة قبل confirmation؛الإخفاقات تظل ضمن نتائج العملية.

كل تنفيذ يعيد current Role/Organization/Branch/Lead/Field/Session والـeditable/active/source/type checks. Lead → current User/Session → Field/Binding/value locks،مع versions للـLead وdefinition وbinding وvalue. Typed normalization وrequired-stage rules والكتابة والتاريخ تأتي من `writeManualFieldValue` نفسها المستخدمة في التعديل الفردي وHuman Qualification. ADD يحافظ على بقية الوسوم ويمنع التكرار،وREMOVE تزيل الوسوم المطلوبة فقط؛SET تتبع semantics الحقل القائمة.

## Idempotency والتاريخ والفشل

Envelope immutable تربط actor/request UUID بـhash للـselection/versions/action/value دون نسخ قيم العميل إلى request table أوAudit. لا FK من Field المطلوبة إلى definition لتجنب اختلاف خطأ Field غير الموجودة عن المخفية؛هذه envelope ليست authorization. Session حقيقية لازمة عند القبول وكل عنصر،ولا تُنشأ fake Human session أوbackground authority.

كل عنصر transaction مستقلة: Field/value history وActivity وAudit وnative receipt ذرية. receipt مرتبطة بـfresh same-transaction MANUAL history/value وcurrent session/scope/versions وAudit؛unique batch/Lead وhistory وimmutable guards تمنع claim/replay/تغيير التاريخ. Replay يتحقق أولًا من current Lead وField write authority؛نجاح قديم لا يتيح قراءة نتيجة بعد فقدان الوصول. إذا تغيرت صلاحية/نسخة بين preview والتنفيذ يفشل ذلك العنصر بلا overwrite.

فشل Audit يرجع العنصر المتأثر؛العناصر التي committed تملك receipts. إعادة نفس immutable request تكمل المتبقي دون تكرار أثر المكتمل. تغيير payload/selection/versions لنفس key مرفوض409. UI توفر Retry same request بعد lost ACK أوretryable/pause،وتعرض نتيجة كل عنصر؛لا success شاملًا مفترضًا ولا إعادة تلقائية بتفويض قديم. تغيير التحديد أوالقيمة يلغي retry draft المحلية ويتطلب review/confirmation جديدة. سجل Field المخول المعتاد يحتفظ بالـMANUAL values/history؛Audit تحمل Batch/Field/operation دون قيمة العميل.

تغيير لغة الواجهة لا يغيّر Human authority أوintent،ولا يلغي request قيد التنفيذ أوretry key. تُعاد الصياغة باللغة الحالية فقط؛تغيير user/role/branch أوالتحديد يعيد سياق الواجهة،والـBackend يعيد authorization لكل محاولة في جميع الحالات.

## حدود التشغيل

هذه synchronous bounded writes وليست large import engine. request budget افتراضي15s،قابل للضبط تقنيًا عبر `BULK_FIELD_REQUEST_BUDGET_MS` من100 إلى30000ms. بعد انتهاء budget لا تبدأ عناصر جديدة وتعود BULK_REQUEST_PAUSED؛يمكن retry للطلب نفسه. لكل statement8s ولكل lock750ms؛العنصر الذي بدأ قد ينتهي بعد deadline،ولا connection محتجزة طوال batch أوlocks عبر Provider I/O. هذه حدود تقنية وليست business capacity guarantee. Native170 additive بلا backfill أوتغيير بيانات تطوير حالية.

واجهة Bulk تعرض نتائج ثابتة للعملية وتترك إعادة تحميل قائمة Leads للفلاتر الحالية إلى Refresh المعتادة؛الحقول نفسها تُقرأ من API الحالية في التفاصيل/التاريخ. لا تغيير لـPayment/Enrollment/Conversation/controller ولاAI/Customer send من هذه الإجراءات. external integrations/live AI تبقى معطلة. lifecycle/follow-up/export وبقية Bulk وlarge-data/cross-module acceptance تبقى Requirements منفصلة.

## التحقق الحالي

focused unit2/2 وPG5/5 (9.7s) وBrowser1/1 (5.4s للرحلة/8.8s إجماليًا) ناجحة. تشمل actual services وثماني retries متزامنة وpartial Audit rollback/resume وcurrent ownership/Field scope/session/native immutability وbudget pause/resume و50 actual writes. Browser تثبتconfirmation/cancel وactual fields/status/tags/history UI وlost ACK/current scope وar/en/fr وArabic390px/failed-read clearing بلاoverflow/XSS/duplicate keys. Native171 forward fix لمقارنةAudit target text/UUID؛لم تُعدّل170 المطبقة.

البوابة النهائية الحالية 2026-11-16 ناجحة: migrations001–171 development/test وBackend/Web build/typecheck،182/182unit و109/109full Docker PostgreSQL integration (281.0s) و61/61full Edge Browser (3.5m). Bulk ضمنfull2.4s؛focused recovery Initial/Qualification/Bulk3/3 (13.5s) ناجحة. تشمل fullBrowser بقاءretry intent عندتغييراللغة دونإعادةإنشاءrequest key. الصورةالعربية390px فُحصت،ولاoverflow/XSS/duplicate keys. هذه القياسات المحلية ليستcapacity guarantee.

استعادةBrowser كشفتselector اختارتLead قديمةذاتContact/name مشتركة أثناءrefresh؛أثبتtrace URL وtestDB الفارق،وصُححاستهدافLead الجديدةبالـID معfresh/old admission assertions. بقيSENT/UNKNOWN/current-policy enforcement كماهو؛لم يتغيرAI Product logic أوProvider/worker behavior. الإصلاح يمنع تداخلoutbox المتروك معالسيناريوهاتالتالية ولا يخففassertions.
