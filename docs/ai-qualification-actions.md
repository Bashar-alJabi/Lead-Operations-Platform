# تنفيذ AI Qualification

## النطاق والسلطة

المصادر: 04 §§6–8/18–20، 05 §§13–17، 02 §§44/48/50 وAGENTS §§8/19–22/26–29. تنفّذ `updateQualificationField` إجابة typed واحدة مرتبطة بسؤال الحملة الحالي وحقلها عند وجود mapping. تعتمد على Published Knowledge وProfile وConnection وgrant وconfiguration الحالية، ضمن Organization/Branch/Campaign/Lead/Conversation وpinned Sender والرسالة الواردة الموثّقة الأحدث. Human writers تحتفظ بسلطة المستخدم وجلسته الفعليتين. هذه الأداة لا ترسل رسالة ولا تغيّر Controller أوPayment أوEnrollment أوcore status أوsecurity.

## قبول وارد جديد

`ai_customer_action_admission` مستقلة عن الاقتراح وسجل BLOCKED التشخيصي. تُنشأ مع proposal QUEUED جديدة في transaction معالجة authenticated inbound نفسها، بسياق مطابق وController=AI وحالة AI_ACTIVE/AI_WAITING_FOR_LEAD دون Attention، وApproved Tool صريحة وسؤال Qualification مفعّل. تثبت native117/119/120 المصدر الجديد المرئي داخل transaction أوSAVEPOINT عبر xmin/pg_xact_status. تغيير الإعدادات أوإعادة Controller لا يمنح قبولًا لاقتراح قديم.

المسار القديم `AI_HANDOFF_REQUIRED + AI_PROCESSING_NOT_READY` يصلح لتسجيل اقتراح تشخيصي فقط. عند غياب أهلية الأداة يبقى incoming path محجوبًا للمراجعة. Default live inference معطّلة قبل قراءة Credential وبناء Provider payload؛ الاختبارات تستخدم synthetic HTTP mocks وقاعدة معزولة.

## العامل والتطبيق الذري

Native124 تمنع قبول Action من رسالة واردة ذات provider timestamp أقدم من رسالة Customer محفوظة في Conversation نفسها. ترتيب الوصول وحده لا يسمح باستبدال إجابة أحدث؛ تبقى الرسالة المتأخرة في التاريخ والمراجعة والاقتراح التشخيصي دون Action. التوقيتات المتساوية تبقى مقبولة مع source identity/idempotency/current context، لأن provider timestamp قد يكون بدقة الثانية. Index مخصصة تمنع مسح التاريخ لهذا الفحص. Native123 تقفل Contact أيضًا قبل Consent، لتمنع first INSERT متزامنة عبر Lead أخرى تشارك Contact نفسها.

ينفّذ `src/ai/customer-qualification.ts` local DB action مستقلة عن HTTP. بعد PROPOSED QUALIFICATION المقبولة تنشئ native121 سجل `ai_customer_action_job`. Pending index وSKIP LOCKED تفصل العمل المنتظر عن حجم التاريخ. لا lease مطلوبة لأن transaction قصيرة وبدون Provider I/O. ترتيب الأقفال: Job ثم Branch→Campaign→Lead→Conversation ثم بقية dependencies. Parent Branch UPDATE تمنع ظهور config مفقودة أوتغيير policy أثناء الكتابة؛ يجب قياس throughput مع زيادة الحجم دون إضعاف authority. لا تُحمل أقفال أثناء inference.

قبل Action يُعاد full context match مع admission/proposal الأصليتين. تغيّر owner/controller/Lead/Branch/Campaign/Knowledge/Profile/grant/pin/consent/config/tool policy أوField definition/binding/value أوanswer versions يمنع تطبيق نتيجة قديمة. تستخدم typed value الدالة المشتركة `normalizeQualificationAnswer` وField validator، مع native structural/type/options/range guards. Receipt تضبط current question/value/versions نفسها، وnative122 ترفض caller scope المخالفة.

`ai_customer_action` terminal immutable: APPLIED أوBLOCKED بسبب current context/value. تحفظ APPLIED الحقل بـsource=AI وupdated_by=NULL وreceipt ID، والإجابة بـsource=AI وactor/session/request=NULL، مع Field/answer history وActivity وAudit metadata وJob DONE. تشترط Native guards receipt من transaction الحالية وCAS وtyped current target؛ يمنع deferred proof commit بلاanswer/history/Field proof. فشل Audit أوcrash يعيدان كل الكتابة، ويبقى Job قابلًا لإعادة المحاولة محليًا. Duplicate workers/calls لا تنشئ action ثانية. BLOCKED لا تكتب Field/answer.

Human answer لاحقة تستخدم request/session المفروضة في native100 دون تخفيف، وتحفظ AI history وتزيل current AI provenance عند override. المصدر المعروض للسؤال غير المرتبط يأتي من answer نفسها. Field history المرتبطة بـAI ترفض التعديل والحذف وreceipt القديمة، مع unique action proof.

## الواجهة والحدود

تعرض Lead Qualification القيم والمصدر والتاريخ والنتيجة وفق Field visibility الحالية. الحقل المخفي يمنع ظهور سؤاله وقيمته وتسريب completion/missing data. تعرض Customer execution history الاقتراح مستقلًا وAction ID/tool/state/error/time؛ لا qualification value أوquestion/schema في DTO العام. النص untrusted plain text، مع ar/en/fr/RTL. يمسح فشل access المعلومات المحمّلة وفق current read boundary. لا يوجد endpoint عام لإدراج action أوتزوير source=AI.

Proposal error أوقرار غير QUALIFICATION حين توجد admission ولم تُنفّذ أداته بعد يعيد latest AI conversation إلى processing Attention. لا يغيّر Human أوsource أحدث. Actual Human Handoff/package/SLA وsends/initial contact/follow-up وfull AI activation باقية. Runtime readiness وlive transfer محجوبان؛ هذه الأداة لا تعني اكتمال AI أوالمنصة أوLive Provider verification.

## التحقق

الاختبارات تغطي actual HMAC inbound→queue→managed synthetic proposal→durable typed action→Lead UI/history، default live-off، diagnostic/old source rejection، duplicate/multiple workers، current Human ownership/controller/policy/Field/pin/Branch/Profile/Published fences، mapped/unmapped/Currency values، Human override، native forgery/deferred atomic proof/Audit rollback، hidden Field/foreign scope وعدم send/Payment/Enrollment. تُسجَّل نتائج البوابة النهائية بعد تشغيلها في progress/coverage.
