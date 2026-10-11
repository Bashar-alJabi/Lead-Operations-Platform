# تنفيذ طلب Human Handoff من Customer AI

## نطاق هذه المرحلة

هذه مرحلة من Human Handoff: طلب الموظف الفعلي، وقائمة الانتظار والمراجعة المحكومة بالصلاحيات، والقبول البشري الصريح. لا تعتبر اكتمال Handoff بالكامل أو AI Conversation Agent. المصدر: 04 §§6–8/21–30، 02 §§37/49–50، 05 §21 وAGENTS §§8/15/18–26/28–29/38–39.

## السلطة والذرية

- `ai_customer_handoff_admission` مستقلة عن Qualification admission وreadonly/Copilot وHuman session. تُنشأ فقط مع proposal جديدة QUEUED في transaction معالجة inbound ذات HMAC موثّقة، تحت AI_ACTIVE/AI_WAITING_FOR_LEAD ودون Attention، وApproved `requestHumanHandoff` الحالية. لا retrofit/replay للطلبات القديمة بعد grant.
- لا تحتاج هذه الأداة وجود Qualification questions. قاعدة عدم استعمال provider message أقدم من رسالة Customer محفوظة أحدث تبقى سارية. Context تضم Org/Branch/Campaign/Lead/Conversation/Published Knowledge/Profile/grant/Tool policy/Fields/consent/pinned Sender وسائر النسخ الحالية.
- validated HANDOFF proposal تنشئ durable indexed job مستقلة. `worker:ai` يعالجها بعد proposal وQualification jobs. Local transaction قصيرة: Job ثم Branch UPDATE → Campaign SHARE → Lead UPDATE → Contact SHARE → Conversation UPDATE → current dependency locks. لا External I/O تحت Locks.
- `requestAIHumanHandoff` تعيد full current context وتطابق admission/proposal، ثم immutable APPLIED أوBLOCKED receipt. Native125–128 تشتق reason/version من المصدر وتحجب foreign scope وold receipt وAPPLIED دون transition/history. Receipt وJob DONE وConversation/history/Activity/Audit ذرية؛ deferred proof تمنع الالتزام الجزئي.
- Native128 تعيد السياق كاملًا مباشرة قبل transition، فترفض تغيير Owner داخل transaction بعد إنشاء receipt. القبول البشري يطابق أيضًا Branch التي قُفلت مع Lead الحالية، حتى عند نقل Lead أثناء انتظار Super Admin.
- APPLIED تنقل Conversation إلى `WAITING_FOR_HUMAN` وController=`NONE` وAttention=`AI_HUMAN_HANDOFF_REQUESTED`، وتزيد CV version. Lead Owner وpinned Sender/history ثابتة. لا fake employee actor أوCustomer send أوPayment/Enrollment action. BLOCKED لا تغير Conversation، والـJob لا تُعاد إلى QUEUED.
- لا ownership/routing عشوائي: Lead المعينة تبقى مع Owner، وUnassigned تبقى Unassigned. تهيئة Handoff target/availability/routing وautomatic notifications/SLA ليست منفذة في هذه المرحلة.

## المراجعة والقبول

`GET /api/ai/human-handoff-queue` تعرض طلبات WAITING الحالية ضمن Org/Branch/assignment scope، مع pagination bounded وقفل Lead/Conversation وإعادة فحص session قبل إرجاع البيانات. Manager ترى Unassigned في فرعها؛ Agent ترى ملكيتها فقط. Migration127 تفهرس current waiting queue. القائمة متاحة في صفحة Leads وتفتح Lead وفق صلاحيات Backend الحالية؛ قراءة القائمة لا تمنح Controller.

`GET /api/conversations/:id/ai-handoffs` تعرض immutable action history/reason/time/Published version وسؤال Customer عند الطلب كنص، مع current Conversation/Campaign/Lead source وQualification الحالية عبر نفس Field masking للموظف. Aggregate completion/missing لا تتسرب عند Field محجوبة. لا raw execution context/credentials/candidate Fields في DTO عام. Customer execution history تميز HANDOFF proposal عن receipt/tool APPLIED/BLOCKED. UI ar/en/fr تمسح البيانات السابقة عند فشل القراءة وتعرض المحتوى كنص غير موثوق.

Human takeover الحالية هي قبول صريح مع current CV version/current Branch/current Role-session/current Lead access. تنتقل إلى HUMAN_ACTIVE/controllerUser محدد، وتزيل فقط Handoff attention المعروفة؛ provider/pin blockers الأخرى تبقى. إعادة فحص session بعد الانتظار على CV تمنع قبول session أُلغيت بعد initial HTTP authentication. حفظ History/Audit ضمن transaction، ولا AI auto-reactivation. Reassignment القائمة لا تمنح Controller لمحادثة NONE المنتظرة.

## التشغيل والتحقق وحدود الاكتمال

الإعداد من Campaign AI Approved Tools عبر Manager/Super Admin. حفظ grant لا يفعّل full runtime. Live customer-data transfer مازالت معطلة؛ اختبارات Provider تستخدم synthetic HTTP mocks فقط. الحالة الخارجية **Live Verification Pending External Credential/Approval**، ولا حسابات شخصية أوProduction credentials.

اختبارات PostgreSQL تبرهن duplicate/concurrent workers، old/diagnostic admission denial، full context revocation، native scope forgery/old receipt/deferred proof/history immutability/Audit rollback/retry، Human takeover/session-revocation race وField masking/foreign denial/Unassigned Manager queue/pagination/no send/no payment. Browser يبرهن actual synthetic HMAC→mock proposal→action→Manager queue→scoped review→Human acceptance وstale CAS/revocation/no-XSS/failed-read clear/ar-en-fr/RTL. نتائج البوابة النهائية في progress/coverage.

Tool catalog/full readiness تبقى غيرجاهزة للـHandoff baseline حتى اكتمال package/routing/SLA/triggers. وجود actual request executor لا يفعّل Customer AI أو يعلن اكتمال هذه المتطلبات.

**التحديث التالي للمرحلة:** Handoff summary/package منفذة في129–131؛تفاصيل autonomous SUMMARIZATION/real authorized refresh/current source/freshness/Qualification masking/Published refs في[ai-handoff-summary-package.md](ai-handoff-summary-package.md). **الخطوة التالية الحالية:** target/routing/availability وBranch/Campaign SLA/timezone/working-hours/escalation،ثمmandatory/qualification-completion triggers معatomic proof لايخففfull context بعدown answer write. بعداستقرارbaseline كاملة ينتقل العمل إلىCentral Messaging Policy/customer sends/initial contact/returning/follow-up وبقيةAI/Operations ثمmodules التالية. هذهالفجواتمتطلبات فعلية،ولاتُصنفoptional backlog.
