# إيقاف الرد الآلي عند حجب Handoff إلزامي

## المشكلة والحدود

04 §§7/28 و05 §21 وAGENTS §§19/22–24 تفرض عدم مواصلة موضوع يحتاج Human وعدم تجاوز Approved Tools. مسار Handoff الصحيح يعيد كامل السياق؛ لذلك قد تصبح original approved HANDOFF محجوبة بعد تغيّر Owner أوPolicy أوKnowledge. إبقاء `AI_ACTIVE` بعد هذا الحجب لا يثبت safety stop.

Native143 تضيف إيقافًا داخليًا محدودًا للمراجعة. **لا تتغير سلطة الأداة أوfull-context proof**: طلب الموظف يبقى BLOCKED؛لا APPLIED receipt أوWAITING_FOR_HUMAN أوHuman controller أوrouting أوcustomer/financial action. الإيقاف يسجل حقيقة تاريخية قابلة للتدقيق، وليس إذنًا لإجراء لاحق أومصدرًا للإشعارات أوSLA الخاصة بـactual Handoff.

## المصدر والإيقاف الذري

- المصدر fresh BLOCKED `ai_customer_handoff_action` فقط، من validated PROPOSED `HANDOFF` مع original admission. Qualification child لا تستخدم هذا الاستثناء: إلغاء شرطها أوتغيير سياقها لا يثبت وجود mandatory classification.
- Scope الحالية تطابق original Organization/Branch/Campaign/Lead/Conversation. Sender/Connection/participant تطابق event الموثقة؛provider thread reference الصريحة تبقى مطابقة. الرسالة المصدر inbound/CUSTOMER الحالية هي أحدث سجل،ولا توجد Customer provider timestamp أحدث منها.
- Controller مازال AI بلاHuman user؛الحالة AI_ACTIVE/AI_WAITING_FOR_LEAD وبلاattention أخرى. Human takeover أوscope/pin/source تغيّرت أوحجبprovider موجود: لا overwrite. لا تغيير للمالك أوإعادة اختيارSender.
- AFTER fresh blocked receipt،تتحول Conversation إلى `AI_HANDOFF_REQUIRED` مع existing `AI_PROCESSING_NOT_READY` وversion+1 فقط. تحفظ immutable `ai_handoff_safety_stop` بالـaction/conversation/version الفعليتين. Native guard تتطلب fresh source وfresh current Conversation stop؛لا old/APPLIED/readonly replay أوforged version.
- Stop receipt وConversation وBLOCKED action وJob DONE وActivity وAudit ذرية. فشل Safety Audit يعيدها كلها ويترك Job QUEUED لتكرارالعامل الموجود. Concurrent workers تحفظ مرة واحدة.
- Audit ذات actor=NULL وreason/source/action IDs فقط؛لاfake employee أوtool execution claim أوcredentials/Field values. لاcustomer message أوHandoff history أوreception event أوnotification/SLA منBLOCKED action.

## التشغيل والواجهة

لا إعداد جديد. Approved Tools الحالية تحكم التنفيذ،والـsafety guard جزء من `worker:ai`/native action path. لا replay/backfill للـblocked history. Missing original tool admission مازال يسلك processing Attention الموجود فيproposal worker دونإنشاءaction؛هذا المسار منفصل عنfresh blocked-action safety receipt.

Execution DTO تعرض `safetyStopped` من receipt الفعلية فقط، وتبقى `toolsExecuted=[]` للطلب المحجوب. UI ar/en/fr تعرض سبب الحجب والإيقاف للمراجعة كنص تاريخي؛لا تدعي أن المحادثة لم تتغير أوأن Human قبلها. السجل لا يكشف context/Field values، ويستخدم current Lead/Conversation authorization الحالية. فشل القراءة يمسح البيانات السابقة.

Inbound جديدة بعد الإيقاف لا تعيد AI_ACTIVE أوتمنح action admission تلقائيًا. قبول الموظف عبر الواجهة/session/CAS الحالية يقبل Human control ويزيل processing blocker المعروفة؛لا يمحو stop history أو يعيد AI تلقائيًا. حالات Provider attention الأخرى تبقى كما هي.

## التحقق وحدود الحالة

تستخدم الاختبارات بيانات اصطناعية وHTTP mocks فقط؛لا Live transfer/full AI activation. **Live Verification Pending External Credential/Approval** للتكاملات الخارجية. نجحت001–143development/test وBackend/Web build/typecheck و176unit و81full Docker PostgreSQL (164.5s) و48full Edge Browser (4.2m)،وفocused PG1/1 وBrowser2/2 أيضًا؛الصورةفُحصت. Current/foreign/newer/Human/provider attention وno duplicate وAudit rollback/worker restart وnative forgery/history وexplicit acceptance مثبتة. هذه safety stage ولا تعني اكتمال كلHandoff triggers أوAI أوالمنصة؛Repeated Misunderstanding وCustomer sends وبقيةruntime باقية.

**فجوة reliability مؤكدة قبل full activation:** `src/ai-worker.ts` تعيد tick بعد SQL failure؛Qualification/Handoff local action jobs فيNative121/125 لا تملك بعد bounded failure counter/backoff/dead-letter وscoped recovery UI مثلSLA queue. Poison local action قد تكرر الفشل وتؤخر بقيةAI steps. ذريةrollback المثبتة هنا تبقي job قابلة للمحاولة،لكنها ليست إثبات اكتمالoperability لهذه queues. الأولوية التالية إكمالهذهالضوابط دونتخفيفcurrent source proof؛core Lead services منفصلة وتبقىمتاحة.
