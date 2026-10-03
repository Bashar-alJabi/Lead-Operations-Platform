# المعمارية التقنية

## قرار البناء

المنصة **Modular Monolith**: واجهة React مستقلة، وواجهة API وخدمات تطبيقية وعمال مهام في مستودع واحد. تنشر نسخ API stateless خلف موازن حمل، ويشترك العمال معها في PostgreSQL. حدود الوحدات تحافظ على فصل الـDomain عن مزودي Meta وMessaging وPayment وEmail وAI وGoogle. لا توجد خدمة خارجية تصبح مصدر الحقيقة التشغيلية.

الاختيارات:

| الطبقة | الاختيار | السبب |
|---|---|---|
| اللغة | TypeScript على Node.js 24 | أنواع مشتركة، نظام حزم واحد، ودعم محلي متوفر |
| API | Fastify مع JSON Schema validation | حدود HTTP واضحة، تحقق مدخلات وأداء ملائم |
| الواجهة | React وVite | واجهة متعددة اللغات والشاشات مع تحميل تدريجي |
| قاعدة البيانات | PostgreSQL | معاملات وقيود وفهارس و`FOR UPDATE SKIP LOCKED` للتزامن |
| الوصول للبيانات | SQL parameterized عبر `postgres` | استعلامات وصلاحيات وفهارس صريحة وقابلة للمراجعة |
| المهام | جدول PostgreSQL durable jobs وoutbox | ذرية كتابة الحالة والنية داخل معاملة واحدة؛ لا يعتمد قبول Webhook على Redis |
| المصادقة | Argon2id وsession cookie عشوائية مخزنة hash | إبطال الجلسات وربطها بحالة الحساب، دون JWT طويل الأجل |
| الأسرار التشغيلية | AES-256-GCM بمفتاح deployment منفصل | إدارة Connections داخل المنصة دون إظهار السر بعد حفظه |
| الملفات | Object storage adapter؛ تخزين محلي معزول للتطوير | تحكم الوصول وفحص النوع والحجم وإمكان استبدال التخزين |

Docker Compose يوفر PostgreSQL للتطوير وبيئات الاختبار. تحقق تشغيل PostgreSQL 18 محلياً وتطبيق migrations واختبارات API عليه. لا يُستخدم SQLite كبديل إنتاج صامت.

## حدود الوحدات

`identity`, `organization`, `campaigns`, `fields`, `leads`, `routing`, `conversations`, `messaging`, `integrations`, `ai`, `followups`, `payments`, `analytics`, `automations`, `imports`, `notifications`, `audit`. واجهات HTTP تستدعي application services؛ adapters وحدها تتحدث إلى الخارج. يشترك كل مسار قراءة/تعديل في authorization service، وتُفلتر الصفوف في SQL حسب branch/owner قبل الإرجاع أو export أو AI tool.

## سلامة البيانات والصلاحيات

- ثلاثة Roles فقط: `SUPER_ADMIN`, `MANAGER`, `AGENT`. Manager محصور بفرعه، وAgent بالـLeads المسندة له. Conversation وMessage وAI summary تتبع Lead access. الحقول تُفحص عند القراءة والكتابة والتصفية والتصدير.
- `Contact` منفصل عن `Lead`؛ Source Submission غير قابلة للاستبدال بقيم Lead التشغيلية. الحالات `OPEN/CLOSED/ARCHIVED` منفصلة عن Campaign Status. `Payment` منفصل عن `Enrollment`.
- في Manual intake تُحفظ قيم Contact الأصلية داخل `source_submission`، بينما تستخدم المطابقة هاتف E.164 بعد إزالة فواصل العرض وبريداً مطبّعاً بـNFKC والحروف الصغيرة. القيمة غير الصالحة تُرفض حتى لو وُجد معرّف آخر صالح؛ لا يُخمن Country code. تُؤخذ أقفال PostgreSQL advisory بترتيب ثابت لكل هوية قبل المطابقة والإنشاء، فلا تنشئ الطلبات المتزامنة Contact مكرراً لنفس الهوية في هذا المسار. وجود Contact سابق لا يدمج Leads.
- عند تطابق أكثر من Contact، أو تطابق Contact موجود خارج فرع Manager دون Lead سابقة في فرعه، تُحفظ Source Submission في `NEEDS_ATTENTION` ولا تنشأ Lead. صفحة المراجعة تعرض مرشحي الفرع فقط؛ إذا تضمّن القرار أي مرشح خارج الفرع أو Contact مشتركة بين فروع، يحسمه Super Admin. تُقفل Submission عند الحسم ويصبح تكرار الطلب بالقرار نفسه آمناً، بينما يُرفض قرار مختلف. تعديل الهوية يستخدم `version` لمنع الكتابة المتزامنة المفقودة، ويحفظ `contact_history` و`audit_log`، ولا يسمح لManager بتعديل Contact مشتركة بين فروع. فهارس البحث والقوائم وkeyset pagination تحصر البيانات في Leads المصرح بها.
- `Field Definition` لها نطاق Global/Branch/Campaign و`value_mode` يميّز Manual/Source/System/Calculated؛ لا يسمح مسار المستخدم بكتابة Source/System/Calculated. الربط بالحملة يحمل ترتيب العرض، صلاحيات Agent/Manager، مواضع العرض، والفترة التي تُطلب فيها القيمة (`LEAD_CREATION` أو `CLOSE` أو `ENROLLMENT`). الكتابة تمر بتحقق النوع والخيارات والحدود في Backend، و`version` يمنع فقد تعديل التعريف/الربط/القيمة المتزامن. `field_value_history` يحفظ التغييرات ولا يمحو Raw Source Submission. الحقول المحسوبة تستخدم سجل وظائف مشتقة محدد مسبقاً من Queries موثوقة؛ لا تُقبل صيغ حرة من المستخدم أو ناتج AI كحقيقة تشغيلية، ولا تدخل محاولات AI في عداد Human Agent. تحقق `ENROLLMENT` يُربط بخدمة Enrollment عند بنائها. بحث Leads بحقل مخصص يتحقق من `filterable` وVisibility ونوع القيمة في Backend، بينما Export ينتظر مساره.
- إعداد Campaign يستخدم `version` لمنع ضياع تعديلين متزامنين، ويمنع تعديل خصائص التشغيل وهي `ACTIVE` حتى تُعطّل صراحة. التفعيل والتعطيل وتغييرات Agent تُقفل صف Campaign داخل معاملة وتُدقّق؛ Manual intake يقفل Branch ثم Campaign ويعيد فحص الحالة داخل المعاملة، حتى لا تنشأ Lead بعد سبق تعطيل الحملة. تعرض Readiness أسباباً قابلة للفهم؛ يبقى Source الخارجي وMessaging وAI وPerformance routing محجوباً عن Activation إلى أن تعمل خدماتها والتحققات الفعلية. تعريف Conversion الاختياري لا يُستنتج من إغلاق Lead؛ حالياً يُقبل Milestone مؤكد للدفع أو التسجيل كإعداد فقط، ولا يُعرض Conversion rate قبل بناء Analytics المرتبطة.
- إعادة إسناد Lead داخل الفرع تقفل صف Lead وتفحص `version` ودور المستدعي وفرع Agent المستهدف. تُحفظ `assignment_history` و`lead_activity` و`audit_log` داخل المعاملة نفسها، وتنتقل المهام المفتوحة المملوكة للـAgent السابق وHuman conversation controller معه مع حفظ تاريخ كل انتقال. لا يحدث نقل فرع ضمن هذا المسار، إذ يتطلب معالجة Campaign وSender وConversation منفصلة. الملاحظات الداخلية تسجل في النشاط ولا تدخل مسار الرسائل الخارجية. متابعة Human لها `version` وتاريخ append-only؛ إكمالها/إلغاؤها لا يحذف السجل.
- البحث يطبق نطاق Lead في SQL قبل الفلاتر وkeyset pagination؛ حقل Campaign غير المرئي أو غير القابل للتصفية يُرفض قبل الاستعلام. Sorting لتاريخ الإنشاء صعوداً/هبوطاً يستخدم `(created_at, id)` كمفتاح ثابت ويطابق اتجاه المؤشر مع `ORDER BY`؛ قيمة الاتجاه الخام لا تأتي من المستخدم بل من enum موثوق. Saved View تحتفظ بالفلتر والأعمدة الاسمية والمالك والنطاق والنسخة، ولا تحمل صلاحية مستقلة؛ عند تطبيقها يعيد مسار Leads فحص صلاحيات المستخدم الحالية. اختيار الأعمدة في الواجهة محصور بحقول Lead التشغيلية المصرح بها، والـAPI يتحقق من القائمة عند الحفظ. إنشاء/تعديل المشهد يتحقق من النطاق والحقل ويستخدم `version` وتعارض الاسم. Bulk assignment المتزامن محدود بـ50 Lead ويتطلب تأكيدًا؛ يستدعي خدمة الإسناد الفردي نفسها في معاملة مستقلة لكل Lead، ويعيد نتيجة كل عنصر. تمنع نسخة Lead تكرار الأثر عند retry أو طلبين متزامنين. العمليات الكبيرة ذات Progress دائم، وبقية إجراءات Bulk ومفاتيح ترتيب إضافية، لا تزال غير مكتملة.
- قيود unique على provider event ID وmessage idempotency key وpayment reference، وتاريخ assignment/field/handoff/payment/knowledge/audit append-only. تتحقق المعاملات من الحالة الحالية قبل transition. callbacks القديمة لا تُرجع الحالة إلى الوراء.
- تسجيل دخول بلا Public Signup. Bootstrap لأول Super Admin يحتاج secret عشوائياً في بيئة النشر ويُقفل transactionally عند النجاح؛ يقارن الرمز بآلية ثابتة الزمن ولا يُحفظ في قاعدة البيانات. Reset tokens أحادية الاستعمال ومحدودة المدة. تعطيل المستخدم يبطل جلساته. Cookies `HttpOnly`, `Secure` في الإنتاج، `SameSite=Lax`، والتحقق من Origin/CSRF للطلبات المغيّرة.
- إنشاء المستخدم بعد التهيئة يتم بالدعوة: لا يحدد المسؤول كلمة مرور الموظف. `credential_token` يحتفظ بـSHA-256 للرمز فقط، وتُشفّر نسخة التسليم في job بـAES-GCM وAAD خاص بالـjob؛ رابط البريد يضع الرمز في URL fragment فلا يُرسل إلى خادم الواجهة ضمن HTTP request. Reset/Invitation تستهلك الرمز atomically وتُبطل الرموز القديمة، وReset يبطل جلسات المستخدم. Email adapter يفصل SMTP عن منطق الحسابات، وConnection المشفرة تضبط من داخل المنصة. Worker مستقل يستخدم PostgreSQL leases و`SKIP LOCKED` وretries bounded؛ لوحة الإدارة تعرض حالات التسليم دون payload أو secrets. لا يُعد اختبار fake تحققاً مباشراً من SMTP.
- credentials مشفرة في قاعدة البيانات، ومفتاح التشفير deployment secret خارج قاعدة البيانات. API لا يعيد قيمتها، ولا تدخل logs أو AI context.

## الرسائل والـAI

مرحلة إعداد Messaging الحالية تُخزن `IntegrationConnection` بنطاق Organization أو Branch ونسخة تحديث متفائلة، وتُشفّر مجموعة credential باستخدام AAD المرتبط بالاتصال. `MessagingProviderAdapter` يفصل اكتشاف Senders عن قاعدة البيانات؛ Adapter الخاص بـMeta يجلب Phone Numbers من Graph API بمسار/حقول ثابتة وصفحات محدودة ومهلة اتصال، ولا يتبع `paging.next` القادم من المزود كعنوان URL. اختبار الاكتشاف لا يثبت الإرسال، لذلك يعيد `WARNING/SEND_NOT_TESTED` وSender health `UNKNOWN`. يعرض Manager اتصال Organization وأرقامه المربوطة بفرعه فقط، ويبقى تعديل هذا الاتصال لدى Super Admin. إعادة التهيئة تتطلب فحصًا جديدًا؛ ويظل Sender غير المكتشف غير نشط. هذا checkpoint لا يربط بعد قواعد الإرسال بخدمة API أو Worker.

يُفصل `messaging_sender.active` الذي يعكس وجود الرقم في آخر اكتشاف عن `operator_enabled` الذي يعكس قرار الإدارة؛ لا يعيد اكتشاف الرقم تشغيل Sender عطّلته الإدارة. يتطلب ربط Sender واسع النطاق بفروع بعينها حدثًا صريحًا من Super Admin، وخيار `allow_shared_fallback` منفصل عن مجرد السماح باستخدامه. تخزن `branch.default_sender_id` و`campaign.sender_override_id` اختيارات إعداد قابلة للإبطال؛ تغييرها يستخدم version، ويمنع Backend اختيار رقم خارج نطاق الفرع أو غير متاح. يبقى `WARNING/UNKNOWN` حاجزًا للإرسال حتى عندما يمكن حفظ الإعداد. لا يُفك Binding مستخدمة في Default/Override بصمت؛ إبطال Sender لاحقًا سيجعل المحادثة المثبتة Needs Attention بدل تغيير هويتها تلقائيًا. ربط قواعد الحسم بقراءة PostgreSQL وتثبيت Sender في Conversation هما الخطوة التالية.

يُفصل `IntegrationConnection` عن `MessagingSender`. للإرسال الجديد: Campaign override ثم Branch default ثم Organization shared fallback المسموح. المحادثة القائمة تُثبت sender/thread؛ عند عدم صلاحيته تُحظر الرسالة وتظهر Needs Attention. كل Human/AI/Automation/Follow-up send يدخل خدمة واحدة تفحص الصلاحية، controller، consent/DNC، template، نافذة الوقت والمنطقة الزمنية، الصحة والنطاق، حدود الحملة وقدرات المزود. تُحفظ `QUEUED` داخل معاملة قبل اتصال المزود، ويستهلكها worker مع retries محدودة ومفتاح idempotency. inbound webhook يُتحقق منه ويُحفظ كـIntegration Event قبل حل هوية المحادثة؛ الغموض يذهب لمراجعة بشرية.

الـAI يستقبل Effective Configuration حتمية: Global guardrails الثابتة، Branch defaults المسموحة، Campaign config ونسخة Published Knowledge. كل execution مربوط بـCampaign/Lead/Conversation/knowledge version. لا يحصل النموذج على SQL أو credential. الأدوات المسموحة تستدعي application services ذات الصلاحيات ذاتها. الأسئلة التجارية بلا سند تُصعّد؛ الدفع لا تؤكده رسالة عميل أو قرار نموذج. عند `HUMAN_ACTIVE` لا يحدث AI auto-send.

## التشغيل والنمو

جميع timestamps تخزن UTC؛ نافذة الإرسال والتقارير تُحسب بـIANA timezone للفرع أو override الحملة. القوائم تستخدم keyset pagination وفهارس على branch/campaign/owner/state/time. العمال يستخدمون leases و`SKIP LOCKED`، retries bounded وdead-letter قابل لإعادة المعالجة من واجهة إدارية مصرح بها. فصل queues حسب نوع العمل وأولوية الرسائل، مع حد تزامن لكل connection/sender. إدخال Webhook قصير ويحفظ الحدث قبل المعالجة. Logs منظمة بدون أسرار؛ health وqueue lag وconnection health وerror counters قابلة للرصد.

افتراضات السعة التقنية قابلة للقياس والتعديل: لا يحدد المنتج عدداً ثابتاً للـLeads أو senders؛ تضبط pool size وworker concurrency وbatch size من deployment config، وتُقاس p95 latency وqueue lag ومعدل retries قبل زيادتها. نسخ PostgreSQL احتياطياً مع اختبار استعادة دوري، وملفات object storage بنسخ/retention متوافق. migrations منفصلة وقابلة للتدرج في deploy قبل تفعيل الكود الذي يعتمد عليها.

## التحقق

Unit tests للقواعد، API integration tests مع PostgreSQL، اختبارات permissions ومحاولات URL مباشرة، سيناريوهات webhook/idempotency/out-of-order، simulations للـAI، E2E UI، migration smoke، واختبار حمل لمسارات intake/message. اختبار mock لا يساوي تحققاً مباشراً من Provider. أي Connection بلا credentials حقيقية تعرض حالة غير متصلة ولا تُسجل نجاحاً وهمياً.
