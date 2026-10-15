# إعداد ساعة Handoff SLA

**تحديث التشغيل2026-10-15:** Native138–141 والعامل المستقل وUI تنفّذtimers فعلية وانتهاءً موثّقًا وIn-App Owner reminder/Manager escalation؛انظر[عقدالتشغيل](ai-handoff-sla-runtime.md) و[عقدالتنبيه](ai-handoff-sla-notifications.md). Preview الإعداد نفسها لاتمنحaction authority،وfull Handoff runtime/activation لمتكتملبعد. وصف14أكتوبر أدناه يخصمرحلةالإعدادوالحسابالمحفوظة.

## النطاق والحالة — 2026-10-14

هذه مرحلة إعداد وقراءة فعلية مع Backend وDB وAuthorization وUI وHistory/Audit، وهي اعتماد لتشغيل SLA وليست تنفيذًا للمؤقتات. `runtimeReady=false` و`previewOnly=true` في المعاينة. لا تنشئ موعد انتهاء أو Reminder أو Escalation، ولا تمنح AI سلطة إرسال أو إعادة التحكم. Live transfer وfull activation تبقيان معطلتين.

المصدر الوظيفي: `04-ai-agents-conversations.md` §§29/33 (Human Handoff SLA وOutside Human Working Hours)، مع isolation والإعداد من المنصة والتاريخ والاختبارات في AGENTS، وBranch defaults/Campaign overrides في `05`.

## البيانات والوراثة

Migration136 تضيف `ai_handoff_clock_policy` و`ai_handoff_clock_history`. Definition لها ثلاثة مفاتيح فقط:

- `mode`: وراثة `null` أو `ELAPSED` أو `WORKING_HOURS`.
- `timezone`: وراثة `null` أو IANA timezone مع validation مشتركة وnative validation عبر PostgreSQL.
- `calendar`: وراثة `null` أو `{}` (غير مقيدة) أو Weekly calendar. الأيام الغائبة في التقويم الصريح مغلقة، وفترات اليوم مرتبة وغير متداخلة، من بداية مشمولة إلى نهاية مستبعدة. `24:00` نهاية فقط؛ لا فترة تعبر منتصف الليل. يمكن تقسيمها إلى يومين.

الوراثة لكل حقل مستقلة: Campaign غير null → Branch غير null → الافتراضي. افتراضي mode هو `ELAPSED`، وtimezone من Branch، والتقويم من `Branch.business_hours`. كل ساعات التقويم تُفسَّر في timezone الفعلية المختارة. مدة الهدف لا تتكرر في الجدول الجديد: `handoffSlaMinutes` الحالية في operational configuration تتبع Campaign → Branch، وnull تعني عدم وجود هدف.

`ai_effective_handoff_clock` تنتج قراءة deterministic للسياسة والهدف مع مصادر القيم ونسخ Clock/Operational configuration/Branch working hours ووقت التقييم. `calendarOpenAtEvaluation` تختبر الانفتاح في اللحظة فقط؛ ليست احتسابًا لمدة SLA أو deadline. DST preview تستخدم الوقت الحقيقي المحوّل إلى timezone، فتقبل اللحظتين الفعليتين للوقت المحلي المكرر وتمنع ساعات التقويم التي لم تقع عند الانتقال الصيفي. احتساب مجموع مدة العمل عبر DST مطلوب في مرحلة التشغيل التالية.

هذا التقويم مستقل عن Central Messaging Policy وCustomer sending window وعن ساعات الموظف وCapacity. تغيير التقويم لا يعدّل أيًا من تلك السياسات ولا يغيّر Owner أوController.

## الصلاحيات والسلامة

GET/PUT/history تحت `/api/ai/branches/:id/handoff-clock` و`/api/ai/campaigns/:id/handoff-clock`. Super Admin ضمن Organization؛ Manager ضمن Branch؛ Agent ممنوعة. لا requirement لنشر Knowledge أو توفر Provider/Profile لتهيئة الساعة.

Branch lock تسبق current Campaign parent check؛ actual cookie session/current role وOrganization يُعاد فحصها بعد الانتظار حتى لـSuper Admin. Native writes تعيد current active scope/session/role، مع CAS وidentity immutable وhistory لا تقبل إلا snapshot مطابقًا لكتابة جديدة في المعاملة نفسها. Timestamp مشتق native. Audit/history/configuration ذرية؛ فشل Audit يلغي التعديل. DELETE ممنوع. History محدودة بversion cursor ولا تعرض session ID.

Campaign config من Branch قديمة بعد انتقال Campaign لا تُقرأ ولا تُستخدم ولا يعاد ربطها صامتًا. Workflow النقل الكامل يحتاج migration مصرحًا للإعدادات والتاريخ؛ هذا الجزء ما زال ضمن النطاق غير المكتمل. Branch المعطلة تمنع الحفظ. Raw JSON types تُفحص قبل AJV coercion، وvalidation تقبل فقط IANA timezone صحيحة وتقويمًا صالحًا وreason مطلوبة دون control characters.

## الواجهة

Campaign details تحتوي Branch default وCampaign override منفصلتين؛ تحميل/حفظ/وراثة/تقويم أسبوعي/سبب/History ومعاينة فعلية مع source labels مترجمة ar/en/fr. Reason تعرض كنص غير موثوق دون HTML. Stale edit409 تتطلب reload ومراجعة؛ لا overwrite صامتًا. فشل القراءة أو تغير scope/language يمسح القيم والمعاينة والتاريخ السابقة.

## التشغيل التالي

### محرك احتساب المدة — native137

`ai_handoff_clock_slice` و`calculateHandoffDurationSlice` تحسبان مدة فعلية مستقلة عن admission/action authority. المدخلات mode/timezone/calendar محلولة، ونافذة UTC من بداية إلى نهاية مشمولة/مستبعدة. Native validation تمنع calendar/timezone/mode غير صحيحة وnull/infinity أو ترتيبًا عكسيًا.

الاستدعاء يعالج **6 ساعات فعلية كحد تقني للعمل** فقط، ويعيد `processedUntil` و`complete` و`accountedMicroseconds` وalgorithmVersion1. هذا لا يقيّد `handoffSlaMinutes` ولا يعد deadline. Elapsed أوتقويم{} يستعملان الفرق الحقيقي مباشرة. Working calendar تقسم النافذة إلى UTC minute cells محدودة (≤361)، وتقاطع الوقت المحلي الحقيقي داخل كل جزء مع فترات التقويم. ليست تقريبًا إلى الدقيقة: الأجزاء الكسرية محفوظة بدقة PostgreSQL microseconds. تغيّر offset داخل خلية يحدد في الزمن المطلق ويقسم الجزء؛ لا يستعمل inverse conversion لوقت محلي مكرر أوغير موجود. DST المتكرر يُحسب في كل وقوع فعلي، والمفقود لا يولّد وقتًا وهميًا؛ نصف ساعة/تاريخ محلي مفقود/offset تاريخية بالثواني اختُبرت. الحساب يستخدم timezone data في PostgreSQL نفسها، ومستقل عن session TimeZone.

Application Service تمرر timestamp text وتحتفظ بـcursor JSON string كما هي؛ **ممنوع تحويل cursor عبر JavaScript Date** لأن ذلك يفقد microseconds. القيمة لكل slice أقل من2^53؛ جمع catch-up الطويل في timer التالية يجب أن يبقى PostgreSQL bigint أوJavaScript bigint، ولا يجمع target كبيرًا في floating Number. الدفعات قابلة للجمع دون فقد/تكرار عندحدودها، ويجب حفظ progress ذرّيًا مع source/version/proof فيمرحلة المؤقتات.

لا job أوTimer أوNotification أوAudit/action receipt من الحساب وحده؛ `authorityGranted=false`. هذه foundation داخلية غير مكشوفة كAPI عامة، وconfiguration UI المحفوظة لا تدّعي تشغيل timers. قياس catch-up عطلة نهاية الأسبوع11slices نحو77–82ms محليًا دليل على العمل المحدود فقط، **ليس capacity guarantee**. لا SLA runtime completion claim؛ البوابة الشاملة للمرحلة تتوثق في progress/coverage بعد نجاحها.

Durable timer source من trusted actual Handoff receipt/current waiting state، وnative clock accounting وbounded jobs/leases/retries/current scope/controller/owner/source/idempotency؛ ثم Assigned Owner reminder وManager escalation عبر Notification boundary. لا تُشتق سلطة مؤقت أو إرسال من preview أو diagnostic/old receipt. يجب اختبار elapsed/working clocks وDST وأوقات الإغلاق وتغيير الإعداد والتولّي البشري/reassignment والتزامن وAudit rollback قبل إعلان SLA منفذة.

بعد SLA تبقى mandatory/Qualification-completion Handoff triggers ثم Customer sends عبر Central Messaging Policy وبقية AI/Automation/Analytics/import/export/Sheets/Email والقبول النهائي.
