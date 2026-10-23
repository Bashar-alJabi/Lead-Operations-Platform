# قبول Initial AI من إنشاء Lead الموثوق

**تحديث Native158–163:** هذا العقد يصف prerequisite الأصلية وحدودها وقت154–157. [Initial Contact الفعلية](ai-initial-contact.md) تضيف approved initial-message context وfresh-only job/Conversation/action/outbox/dispatch وUI. عبارات «لا Runtime/إرسال» وSource/full activation gate أدناه تخص تلك المرحلة التاريخية؛الحالة الحالية وحدودlive-off فيالعقد الأحدث وprogress/coverage. لا تتغير admissions القديمة ولا تستمد سلطة جديدة بأثر رجعي.

## النطاق والحدود

هذه مرحلة prerequisite لـInitial Contact في 04 §11 و05 §18. Native154–157 تنشئ `ai_initial_admission` تلقائيًا عند INSERT الفعلي لـ`lead_intake_receipt`، داخل transaction إنشاء Lead وبعد Routing، فقط إذا كانت AI مفعلة للحملة وقت الإنشاء. لا backfill ولا polling لمصادر قديمة. Lead أنشئت مع AI معطلة لا تكتسب admission بعد التفعيل، وقرار BLOCKED لا يتحول إلى ADMITTED بعد إصلاح الإعدادات.

`ADMITTED` تعني أن إعدادات القبول الأولي اجتازت فحص هذه المرحلة وقت الإنشاء؛ لا تعني Ready للإرسال، ولا بدء Runtime أو نجاح التواصل أو التسليم. `BLOCKED` تحفظ أسباب المنع مع Lead الأصلية. القبول وحده لا ينشئ durable job أوConversation أوcustomer proposal أوMessage أوPayment/Enrollment، ولا يستدعي AI/Messaging provider. هذه الأجزاء هي الاعتماد التالي، ولا يُرفع Source readiness/full Campaign activation gate بسبب هذا السجل. Human Copilot يبقى مستقلًا عنCustomer Conversation Agent.

## السياق والإعدادات

Native context من نوع `LEAD_INTAKE_INITIAL`، وليست `CUSTOMER_INBOUND`. تحفظ:

- actual immutable intake receipt/submission/routing IDs وOrganization/Branch/Campaign/Lead scope.
- Lead version/lifecycle/Contact/Owner وattention؛ availability للمالك وفق active Agent وCampaign membership وBranch/User working hours وtimezone.
- Global Guardrails version وBranch defaults/Campaign overrides بإصداراتها وeffective language/tone/disclosure/handoff، وqualification/follow-up configuration.
- CONVERSATION Profile/Model/Connection/catalog versions وcurrent explicit Branch entitlement عند مشاركة Runtime.
- أحدث Published Knowledge version وcontent hash وasset manifest hashes وcurrent approval/state. لا Draft أوcustomer content أوraw source payload.
- Qualification questions وmapped Field definition/binding/value/answer versions وscope/usable flags، دون قيم العميل.
- original effective Tool policy بإصداراتها، واشتراط `sendConversationMessage` الأصلي قبل ADMITTED؛ لا retroactive grant لمصدر BLOCKED.
- deterministic new-conversation Sender وفق Campaign override ثمBranch default ثمexplicit shared fallback الوحيدة. invalid override لا يسقط إلى بديل وshared ambiguity تُمنع؛ حالاتresolver تقارن بالـCentral resolver فيالاختبارات.
- consent state/version كحقيقة مستقلة، دون استنتاج opt-in أو24h Messaging window من وقت المصدر. `ADMITTED` قد تحمل UNKNOWN consent؛ يجب على Central Messaging Policy رفض الإرسال إلى أن تتوافر الشروط الفعلية.

Contact snapshot تحتفظ بـversion وrecipient hash محليين، دونphone/name/email value. Native155 تضيف هذا الفحص لأن تعديلContact لا يستلزم تعديلLead. Native156 ترفض context إذا اختلف actual current Lead scope عن immutable intake scope، حتى عند تشابه Campaign configuration. لا تعدل migrations مطبقة ولا تُعاد كتابة snapshots التاريخية؛ snapshots الأقدم التي لا تحقق الشكل الحالي لا تُمنح سلطة جديدة بأثر رجعي.

إذا لم يوجد Owner متاح، يلزم `initialContactWithoutAgent=true` صراحة. fallback هو مسار Branch Manager attention القائم، محفوظ كوجهة واضحة فيsnapshot والواجهة؛ ليس اختيارAgent عشوائيًا ولاNotification مزعومة. Lead تبقى Unassigned عند فشلRouting، أوتحتفظ بمالكها الأصلي إن وجد. Owner وConversation Controller مفهومان منفصلان؛ لا Conversation/controller transition في هذه المرحلة.

## سلامة الحفظ وإعادة التحقق

Admission immutable وواحدة لكلreceipt، معhash وDB-clock timestamp مشتقين فيNative guard. يلزمreceipt وINSERT-only birth جديدتان فيtransaction نفسها. deferred proof تقارن actual context عندcommit. Branch ثمCampaign/Lead/Contact ثمconfiguration/profile/connection/grants/assets/Fields/Owner/sender/consent locks تفحص current dependencies، بمافيهاقراءةالإعدادات بعدparent-lock wait. configuration غيرجاهزة أوprovider غيرمتاح تُسجل BLOCKED دونإلغاءLead؛ فشلAudit أوخرقatomic proof يلغيtransaction كاملة حفاظًا علىسلامةالتاريخ.

`ai_initial_admission_current` دالة داخلية فقط؛ لا public execution endpoint. تقبل ADMITTED الأصلية فقط، وتقفل current parents/dependencies وتطابق snapshot ثم تعيد فحص availability فيالوقت الحالي. تغيرOwner/Lead scope/version أوrecipient أوPublished knowledge أوProfile/Connection/grant أوField أوTool policy يبطل السياق القديم. الدالة ليست بديلًا لـCentral Messaging Policy وليست outbound authority بعد؛ `sendAuthorized=false` و`liveTransferEnabled=false` دائمتان فيهذاالعقد. لا secrets فيcontext أوAudit. Schema owner وDDL موثوقان ضمنحدود تشغيلDB؛ لا client-set GUC للإثبات.

### تعارض أقفال إدارة Connection — Native157

إدارة Connection تستخدم Connection ثمBranch، بينماintake تملكBranch أصلًا بعدRouting. اختبارrace فعلية أثبت500 عندتزامنالمسارين قبلالإصلاح. Native157 تحصرdependency-lock assessment فيsubtransaction بانتظار100ms لكلقفل، وتستعيد `lock_timeout` الأصلي بعدالنجاح أوrollback الداخلي. هذاحدتقني لانتظارالأقفال، وليسBusiness sending window أوCapacity guarantee. timeout/deadlock يعيدفشلًا مغلقًا إلىcaller؛ عندfresh intake تحفظadmission **BLOCKED/AI_INITIAL_DEPENDENCY_BUSY** منimmutable receipt scope فقط، دونادعاءقراءةconfiguration أوavailability أوKnowledge أوSender. deferred proof لهذاالفشل يثبتsource والscope وBLOCKED state بدلادعاءconfig snapshot غيرمقروءة. Lead وRouting وAudit تستمرatomically؛لاprovider I/O أوإحياءلاحق. current-authority helper تعيدNULL عندالانشغال،ولاtimeout يصبحإذنًا.

UI تعرض«غير مُقيّم» بدلادعاءأنOwner غيرمتاح،ولاfallback مزعومة عندعدمقراءةavailability. Integration تعيدنفسConnection→Branch/Branch→Connection race وتثبت201 للـLead ونجاحoperational writer وBLOCKED source، وDTO null facts وtimeout restoration. Browser تختبرDTO الانشغال عبرHTTP mock مستقل عنإثباتDB الحقيقي.

Audit وLead activity تسجل `AI_INITIAL_INTAKE_ASSESSED` معIDs/state/blockers/hash/Knowledge version فقط، وHuman actor الحقيقي أوNULL لمصدر SOURCE. لا fabricated Session/Principal.

## القراءة والواجهة

`GET /api/leads/:id/intake-origin` تضيف `origin.initialAI` محدودة: historical state/blockers/Knowledge version/Owner availability/explicit policy/Sender reason وflags تبين أنRuntime/send لمتبدأ. لاcontext أوcredentials أوContact values أوProfile/Connection details. نفس current real Session وOrganization/Branch/assigned Agent checks؛ لا يعتمد الوصول علىالمالك التاريخي.

واجهة Lead تعرضالتقييم التاريخي بـar/en/fr/RTL، وتميزالقبول عنإرسالفعلي؛ تعالجالقيم كنصescaped وتمسحالمعروض بعدfailed/stale read. `initialAI:null` تعنيعدموجودadmission محفوظة، ولا تُستنتج واحدة منcurrent config. Source intake gate القائمة تمنعحاليًاflow معAI قبل اكتمالInitial Contact؛ تفعيلAI فيBrowser fixture معزول بـlocalhost/test DB +Bearer test control، وليسproduct activation path.

## الإثبات والخطوة التالية

Integration `ai-initial-admission.test.ts`: actual API intake معblocked/missing configuration مع بقاءLead، current scoped read، fresh-only/no revival، eight concurrent intakes، اصلSend grant، Branch defaults وshared runtime entitlement/revocation، recipient/scope/Owner/version/profile/connection/consent/Field changes،working hours وexplicit unassigned fallback،Published version change/history،sender parity/invalid override/shared ambiguity،deferred extra-write/Audit rollback وactual parent-lock wait ثمSender disable. تثبتzero provider inference/send وzeroConversation/Message/jobs/financial records. Browser `ai-initial-admission.spec.ts` تستخدمmanaged setup وactual manual creation وHTTP mocks، وتثبتblocked/ADMITTED history/عدمإحياءالأصل/permissions/ثلاثلغات/ar390px/noXSS/failed-read clearing.

**التالي:** إعدادapproved campaign-specific initial content وtemplate/language/parameters منداخلالمنصة، معcurrent Published/config snapshot. ثمfresh admission-derived durable bounded job وoriginal-grant/current authority وCentral Policy/consent/window/template/health/frequency وatomic initial Conversation/action/message/outbox/current dispatch وfailure/recovery/UI/evaluations. لا تُنشأcustomer inbound/proposal مصطنعة ولايُعاد تشغيلold admission بعدتوسيعالصلاحيات. بعدهاreturning/follow-up/transition وبقيةAI والوحداتالرئيسية. Live Verification تبقى `Live Verification Pending External Credential/Approval`؛ نتائج البوابةالمحلية الفعلية فيprogress/coverage.
