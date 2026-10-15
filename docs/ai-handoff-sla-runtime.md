# مؤقتات Human Handoff SLA الدائمة

## النطاق — 2026-10-15

المصدر: `04-ai-agents-conversations.md` §§29/33 مع AGENTS §§8/15/18/27–30/38 وBranch/Campaign isolation. هذه مرحلة Timer فعلية من المصدر الموثوق إلى احتساب دائم وانتهاء موثّق وUI وتعافٍ؛ ليست اكتمال SLA notifications أوHandoff/AI أوالمنصة. تعتمد على [إعداد الساعة والحساب](ai-handoff-sla-clock.md).

Native138–140 و`processOneHandoffSLATimer` و`worker:handoff-sla` تعمل دون Model/Provider I/O أوHuman principal مصطنع. لا تغيّر Owner أوController أوSender، ولا تسجّل Human contact attempt أوHuman performance من عمل AI/System. لا ترسل للعميل أوتؤكد Payment/Enrollment.

## Admission والمصدر الحالي

بعد actual `ai_handoff_reception_event` يُنشأ Timer فريد بحسب action ID في معاملة Handoff نفسها. Actual APPLIED action وreceipt وConversation الحالية `WAITING_FOR_HUMAN/NONE` ونفس Org/Branch/Campaign/Lead شروط native؛ proposal أوdiagnostic أومعرّف مولّد لا تكفي.

Started timestamp مشتقة من receipt الأصلية، وليست وقت poll أوقيمة العميل. Source identity وstartedAt غير قابلتين للتغيير، وversion لهاCAS. Clock snapshot تحفظ قيم mode/timezone/calendar/target والمصادر والنسخ. Native guard تعيد قراءة المصدر تحت Branch→Campaign→Lead→Conversation locks، وتشتق الحالة والوقت والعداد والـcursor حتى لو أرسل caller قيمًا مزورة. السعة أوinactive Owner لا تمنح Owner جديدة ولا تمنع Manager attention المطلوبة لاحقًا.

الطلبات الفعلية التي سبقت migration تُستوعب عبر startup keyset batches محدودة25. Native current-source checks وunique PK تمنع replay أوالتكرار. لا يعاد مسح كل المحادثات المنتظرة في كل tick؛ receipt الجديدة لها trigger ذرية. استئناف العامل يعيد الفحص بأمان لأن timers المكتوبة دائمة.

## Clock وحالات التشغيل

- `UNCONFIGURED`: لا target مهيأة؛ لا انتهاء مفترض.
- `WAITING`: policy محلولة ويُحسب الوقت من cursor الموثوقة.
- `PAUSED`: معالجة معلّقة أثناء تعطيل Branch أوإغلاق Lead؛ لا انتهاء أثناء التعليق. عند العودة، الحساب يستأنف من الأصل وفق elapsed/working policy، ولا يحوّل تعطيل Branch إلى تقويم جديد أويمحو الوقت.
- `EXPIRED`: المدة المحتسبة تجاوزت الهدف؛ `ai_handoff_sla_breach` واحدة immutable مع observedAt ونسخةTimer/snapshot.
- `CANCELLED`: انتهت حالة الانتظار/تغيّر controller أوsource pointer، أوتغيّر النطاق الأصلي؛ لا إعادة تفعيل AI أوfallback إلى نطاق آخر.

تغيّر قيم clock/target أثناء الانتظار ينشئ revision جديدة ويعيد الاحتساب **من وقت receipt الأصلية**؛ لا يمنح waiting window جديدة. تغيّر metadata versions دون تغيّر القيم لا يصفر العداد. الانتهاء السابق terminal وتاريخي؛ تعديل configuration لاحقًا لا يمحو breach ولا ينتج breach ثانية للطلب نفسه. Current access/ownership يعاد تقييمهما عند القراءة بصورة مستقلة عن النسخة التاريخية.

الاحتساب bigint في PostgreSQL بدقة microseconds، وslice≤6h وUTC cells≤361. Catch-up يعاود في دفعة لاحقة مباشرة؛ لا loop غير محدود بحسب target. elapsed تستيقظ قرب الباقي ضمن سقف60s، وبقية الحالات تُراجع كل60s. `observedAt` هو وقت ملاحظة التجاوز، **ليس ادعاء حساب exact deadline**. UI تعرض آخر احتساب؛ لا تدّعي counter live بين polls.

## Worker وretries والتوسّع

العامل مستقل عن AI inference: `npm run worker:handoff-sla` بعد build، مع نفس deployment Database configuration. الافتراضي25jobs لكل tick و2000ms، ويمكن ضبط `HANDOFF_SLA_WORKER_BATCH` (1–100) و`HANDOFF_SLA_WORKER_POLL_MS` (250–60000) كإعداد infrastructure؛ ليست Business-managed integration setup. يمكن تشغيل عدة instances. لا capacity guarantee من هذه defaults؛ تُقاس بحسب بيانات وحمل البيئة.

Queue row lock و`SKIP LOCKED` ومعاملة محلية قصيرة تغني عن lease عبرHTTP؛ لا I/O خارجي داخلها. Native math/cursor/history/breach/Audit ذرية. Deferred final-expiry proof تمنع تغيّر source/controller/configuration/active scope بعد الحساب داخل المعاملة نفسها. فشل المعاملة لا يثبت انتهاء أوprogress جزئية.

عند failure داخل savepoint، تحفظ queue تقنية خطأ ثابتًا `SLA_STEP_FAILED` مع backoff2/4/8/16/32s وحد5failures؛ لا SQL error أوsecret فيواجهة أوlog. عند الحد يخرج job من due index. المؤقتات terminal لها queue موعدinfinity وتخرج من partial index، فلا يعاد مسح كل التاريخ عند كل tick.

Manager ضمن Branch أوSuper Admin ضمن Organization يستطيعان retry منواجهة Lead بعد مراجعة السبب. Queue lock تسبق parent locks لتطابق العامل، وactual cookie/session/role/parent تعاد بعد الانتظار. Native guard تمنع Agent أوfake session/recovery scope، وCAS وreason وHistory/Audit ذرية. Agent يمكنها مراجعة مؤقت Lead الحالية التي تملكها، ولا يمكنها إصلاح طابور التشغيل. التولّي البشري يسحب waiting authority حتى لو بقي job فاشل كتاريخ؛ retry لا تقبل طلبًا لم يعد current waiting.

## التاريخ والواجهة

Immutable Timer history تسجل تغيّر الحالة/العداد/السياسة/revision، وQueue history تسجل البداية والفشل والتعافي والنهاية؛ no-op polling أوتقدّم cursor في تقويم مغلق لا يولد snapshots متطابقة غير محدودة. لذلك قد توجد gaps في history versions؛ هذا لا يسمح بتعديل تاريخ قديم. Native fresh-row snapshot proof والتوقيت المشتق يطبّقان على كل سجل. Audit تسجل البداية وتغيير clock والانتهاء والإلغاء وdead-letter/manual recovery؛ history/read APIs محدودة≤50.

`GET /api/conversations/:id/handoff-sla` و`/history` يعيدان الحقول التشغيلية المحكومة بالـLead access الحالية فقط، دونknowledge أوcustomer excerpts أوcredentials أوsession ID. بعد Human acceptance تبقى أحدث ملاحظة مطابقة للنطاق كتاريخ مع `waiting=false`. انتقال Lead إلى نطاق آخر يمنع استخدام timer الأصلية حتى لـSuper Admin. `POST /retry` تحتاج actual authorized session/version/reason. UI ar/en/fr وRTL تمسح النتائج عند فشل القراءة أوتغيّر revision/scope/language، وتستخدم text rendering.

## الاختبارات وحدود الاكتمال

Focused PG/Browser تشمل مصدرًا فعليًا، native forged totals/dates/identity/history/old expiry denial، duplicate admission/concurrent workers، closed-calendar/no-op history،configuration revision،pause/resume،atomic Audit rollback،five failures/manual recovery/native Agent denial،revocation أثناءqueue lock wait،parent move،Human takeover،bounded legacy admission،UI failure clearing/history/localization. Dedicated CLI smoke تختبر startup/configuration rejection وindependent process stop.

Clock seam وfailure triggers موجودة فقط في isolated synthetic test fixtures؛ لا production route أوrequest/configuration time override. Live transfer/full activation معطلتان. نتائج البوابة النهائية وحالة checkpoint فيprogress/coverage.

**الخطوة التالية:** trusted fresh breach→idempotent In-App SLA event يعيد تنبيه current Assigned Owner ويصعّد إلىBranch Managers/attention،مع preferences/wording/history/UI/permissions واختبار transaction rollback وout-of-date source. Breach row أوUI جزئية لا تعني اكتمال reminders/escalation. بعدها mandatory/Qualification-completion Handoff triggers ثمبقيةAI/modules المطلوبة.
