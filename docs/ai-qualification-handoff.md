# Qualification → Human Handoff

## المتطلبات والقرار

المصادر: 04 §§6–8/18–20/28–30 و05 §21 و02 §50 وAGENTS §§8/15/18–29/38–39. شرط الحملة المعرّف، لا تفسير النموذج لكلمة Qualified، يحدد التحويل. `handoff.onCompletion` و`handoff.conditions` الحالية تُقيّم من القيم typed الحالية. لا Roles أوصلاحيات تجارية جديدة، ولا Owner assignment أوCustomer send أوPayment/Enrollment mutation.

المشكلة التقنية: كتابة Qualification الصحيحة تغيّر نسختي الإجابة والحقل، فتُبطل full original proposal context. **لا تُحذف هذه الأجزاء من الفحص العام.** Native142 تضيف `ai_qualification_handoff_source` immutable مرتبطة بالـactual APPLIED Qualification receipt وبـoriginal Handoff admission، مع exact own-write delta فقط. المصدر الأصلي والنتيجة والـadmissions تبقى كما كانت.

## إثبات المصدر والتنفيذ

- المصدر لا يُقبل إلا في transaction كتابة الإجابة: fresh APPLIED action وfresh answer history، وcurrent answer source/value/question/version، وmapped Field/history/provenance عند وجودها. readonly/proposal وحدها أوHuman answer أوold action لا تمنح سلطة إنشاء child source.
- Snapshot الجديدة تُشتق من original context مع تغيير **نسخة السؤال المكتوب فقط** و**نسخة قيمة الحقل المرتبط فقط**. باقي الأسئلة والحقول وكل Org/Branch/Campaign/Lead/Owner/controller/Knowledge/Profile/grant/Tool policy/consent/pin/source/config تبقى متطابقة تمامًا. لا caller-provided context omissions.
- native outcome تطابق `evaluateQualification`: false/zero إجابات؛ empty/null غيرمجابة؛ required لا تُلغى بـANY؛ empty conditions لا تحقق شرطًا؛ missing items بالترتيب. mapped values تعتمد Field الحالية، وunmapped values تتطلب نفس question snapshot. Invalid current Field/condition تمنع نتيجة مؤهلة، ولا يُخمن completion.
- original **والـcurrent** `requestHumanHandoff` مطلوبة، إضافة إلى Qualification admission الأصلية. تغيير grant لاحقًا لا يمنح مصدرًا قديمًا سلطة جديدة. Explicit `[]` لا تُتجاوز.
- AFTER answer history ينشئ child source وdurable indexed Handoff job في transaction الإجابة نفسها. فشل source proof/Audit أوcrash يعيد الإجابة والحقل والـsource/job معًا. لا استدعاء Provider إضافي لإثبات completion.
- Worker الحالية تعيد current full snapshot تحت Job→Branch→Campaign→Lead→Contact→Conversation/dependency locks، وتتحقق من شرط التحويل مجددًا. APPLIED أوBLOCKED terminal receipt تحمل `qualification_action_id` وreason=`QUALIFICATION` مشتقتين من المصدر، لا من النموذج.
- تغيير Owner/controller/config/Field/version/policy/pin/knowledge/consent أوsource بعد الكتابة يحجب child action؛ الإجابة الملتزمة سابقًا تبقى تاريخًا صحيحًا. Immediate pre-transition full-context check الحالية تمنع own unrelated writes داخل transaction أيضًا.
- APPLIED تستخدم نفس atomic WAITING_FOR_HUMAN/NONE/history/Activity/Audit/reception/initial notification/SLA admission، وUnassigned/Manager queue والقبول البشري الصريح الموجود. لا reactivation أوrandom assignment أورسالة انتقال تلقائية.

## Mandatory decisions والواجهة

أسباب HANDOFF التسعة المعرّفة في customer proposal تستخدم نفس current approved action path. عند validated HANDOFF دونoriginal tool admission، تتوقف AI conversation الحديثة في existing processing Attention للمراجعة؛ لا تُنشأ action بتجاوز المنع ولا يستمر إرسال حساس. هذا ليس actual Handoff receipt أوإشعار Handoff. Manual takeover الحالية تبقى إجراء موظف بصلاحياته. Runtime الخاصة بـRepeated Misunderstanding وباقيالتصنيفات/initial contact/customer sends ليست مكتملة في هذه المرحلة.

Execution DTO تضيف `actions[]` بالـmetadata فقط، وتحافظ على `action` السابقة للتوافق. `toolsExecuted` تأتي من APPLIED receipts الفعلية. UI ar/en/fr تعرض Qualification وHandoff كإجراءين مستقلين بمفاتيح receipt IDs، دونإظهار value/question/schema/context داخل metadata أوتجاوز Field masking. Handoff review تعرض سبب التحويل ورابط receipt التقني، وLead Qualification تعرض القيم ضمنالصلاحيات الحالية. النصوص Untrusted plain React text.

## التشغيل والتحقق وحدود الحالة

إعداد completion/conditions وApproved Tools من Campaign UI الحالية، وتشغيل `worker:ai` الحالية. لا deployment secret أوCLI إعداد تشغيلي جديد. Native142 تُطبق بأداة migrations العادية؛ لا replay/backfill لإجابات قديمة. Queue/history/notifications/SLA تستخدم مسارات recovery الحالية. No external I/O تحت الأقفال.

التطوير والاختبارات بياناتاصطناعية وHTTP mocks فقط؛Live transfer/full AI activation معطلتان. **Live Verification Pending External Credential/Approval**؛لاLive claim. هذه مرحلة Qualification→Handoff،ولا يعني نجاحها اكتمال full AI/Handoff/Notifications أوالمنصة. نجحت migrations001–142 development/test وBackend/Web build/typecheck و176unit و81full Docker PostgreSQL (146.7s) و48full Edge Browser (2.2m) علىالواجهةالنهائية،والصورةفُحصت. Mandatory action التيتحجببعدoriginal admission تحتاج safety Attention مستقلة؛Repeated Misunderstanding وبقيةruntime باقية كمافي progress/coverage.
