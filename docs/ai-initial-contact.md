# Initial AI Contact — المسار الفعلي

## النطاق

تنفذ Native158–163 الوظائف الأساسية في04 §11 و05 §18: إعداد أول تواصل من الحملة، ثم Lead جديدة موثوقة بعدRouting، ثم durable job وConversation وapproved action وMessage/outbox، ثم Central Messaging Policy والـworker الحالي وصولًا إلى provider adapter. رد العميل الموثق يدخل مسار AI inbound/reply القائم. Human Copilot مستقل عن هذا المسار.

الحالة **Implemented وMock/Sandbox Verified** محليًا وفق البوابة المسجلة فيprogress/coverage. التحقق ببيانات اصطناعية وHTTP mocks، وليس بحساب Sandbox خارجي. Live AI transfer/send ما زالت معطلة؛ **Live Verification Pending External Credential/Approval**. لا تعني هذه المرحلة اكتمال AI أو المنصة.

## الإعداد المصرح به

من Campaign workspace يختار Manager/SA قالبًا APPROVED ومربوطًا بالحملة، ويحدد body/header/URL parameters الثابتة وسبب الاعتماد. API `/api/ai/campaigns/:id/initial-message` تتحقق من current real Session وOrganization/Branch/Campaign والصلاحيات والنسخة. الحفظ versioned مع immutable history وAudit؛لا إرسال من شاشة الإعداد.

يلزم أحدث Published Campaign Knowledge، وSender الحالي المحسوم مركزيًا، ولغة مدعومة وAI disclosure الحالية ضمن النص. القالب النصي ومعاملاته معتمدة بشريًا؛لا يولد النموذج claim تجارية لأولى الرسائل. approval تحتفظ بالقالب الخام وbinding/Knowledge versions/hash، وdispatch snapshot تستخدم projection آمنة ومتطابقة مع parser، دون provider approval examples. تغيير أي اعتماد مؤثر يبطل ready والسلطة القديمة؛لا backfill أوإحياء admissions تاريخية.

`initialCampaignIssues` تتحقق من جاهزية هذه الإعدادات عند تفعيل الحملة؛التفعيل لا يلغي live-off أوconsent/controller/provider policy. Source AI flow يتطلب initial-message policy صريحة. قيد Source القديم للحملات Messaging-enabled/AI-disabled لم يُرفع: المراجعة التلقائية رفضت التوسيع لعدم إثبات المسار الأوسع؛هذه فجوة مستقلة يجب إثبات جاهزيتها قبل تغيير القيد.

## المصدر والتنفيذ الذري

لا تنشأ job إلا من fresh ADMITTED intake receipt داخل transaction إنشاء Lead الفعلية وبعدRouting، مع initialMessage ready فيsnapshot. Native163 تمنع admission إذا وُجد إعداد أولي لكنه أصبح غير معتمد/غير مطابق؛غياب الإعداد يحتفظ بسلوك prerequisite التاريخية دون job. Source timestamp ليستcustomer inbound أوconsent أونافذة24h. Source receipt تحتفظ بـnull actor/session؛لا fabricated Human Principal.

`worker:ai` يفحص due jobs بدفعات محدودة، ويقفل Branch قبلjob معSKIP LOCKED. المصدر الأصلي وcurrent scope/Owner/recipient/Published Knowledge/Profile/grants/config/Fields/Tools/Sender/availability يعاد فحصها. ينشئ Conversation مستقلة عنLead Owner، ويثبت resolved/pinned Sender وAI controller. Central Messaging Policy القائمة تفحص consent/DNC/window/template/health/capabilities/frequency وسائر القواعد؛UNKNOWN consent لا يجيز الإرسال.

داخل savepoint واحدة تُحفظ immutable action وMessage وmessaging job/outbox وActivity/Audit، وتتحقق deferred native proofs قبلcommit. Action APPLIED تعني نية إرسال فيالطابور، ولا تعنيDelivery. السياق الحالي يسمح بدلتا own Conversation/Message فقط. لايمكن إنشاءConversation أوAI Message صورية دون fresh action/outbox متطابقة. فشلAudit يلغي الآثار كلها.

`worker:messaging` يستخدم typed initial-action authority مع نفس policy وحدودlease/throttling/retry. AI live-off تُفحص قبلdecrypt/provider I/O؛synthetic override محصورة فيisolated test DB وadapter صريح. ACK ناجح ينقل الحالة إلىAI_WAITING_FOR_LEAD فقط إذا بقيتConversation تحتAI ولميتغيرالسياق المناسب؛لا إلغاءHuman takeover. لا وصول مباشر للنموذج إلىDB/Provider ولا writes مالية.

## الفشل والتاريخ

- تعطلAI/config لا يمحوLead موثوقة. BLOCKED admission أوaction تحتفظ بالسبب، وpolicy denial قدتضعConversation فيAI_HANDOFF_REQUIRED للمراجعة البشرية.
- local failure تعيدjob بعدbackoff محدود حتىخمس محاولات ثمDEAD_LETTER. لا public replay أوlocal dead-letter recovery UI جديدة فيbaseline هذه؛الاسترداد التشغيلي المتبقي مسجل كفجوة، والمتابعة البشرية المصرح بها متاحة.
- تغيرcurrent authority يمنع الإرسال القديم. Human takeover قبلdispatch يوقفAI؛لا تلقائيًا يعودللتحكم.
- UNKNOWN provider outcome لا يعاد إرساله؛Needs Attention باقية ولا يمحوهاcustomer inbound.
- Lead intake-origin API/UI تعرض job/action/message/delivery/error facts الحالية بصلاحياتLead الحالية. runtimeStarted لا تعنيsend،وsendAuthorized تخصlocal action فقط. الرسائل immutable،والتغييرات تصحح برسائل جديدة.

## الإثبات

`test-integration/ai-initial-contact.test.ts` تختبر setup/activation APIs وmanual intake→actual mocked Meta template send→signed customer reply→existing AI reply، وactual Source intake→first send، وconsent block/Human takeover/UNKNOWN no-replay/config changes/four concurrent intakes/local retry/Audit rollback/native forged-Conversation denial/history/no financial effects.

`test-e2e/ai-initial-contact.spec.ts` تختبر managed setup UI وtemplate preview/reason، actual Campaign configuration/activation وmanual Lead creation وqueued→sent UI، وثلاثلغات/RTL/390px/no overflow/no page errors. endpoints تحريكworker فيBrowser محصورة بالـtest server المعزول ومحميةبتوكن؛ليست production execution API. الاختباراتالكاملة ونتائجها النهائية فيprogress/coverage.

## ترتيب العمل بعد هذه baseline

لا توسيع اختياري لـAI أوmedia/provider-specific features. راجع جميع فجوات المنصة، ثم أكمل Notifications وAutomation وAnalytics وImport/Export والتكاملات المطلوبة وفق الاعتماديات. returning/follow-up/transition وAI Operations وبقيةAI الموثقة تبقى ضمن نطاق المنتج، ولا تُدّعى مكتملة.
