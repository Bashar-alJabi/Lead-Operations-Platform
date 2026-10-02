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
- قيود unique على provider event ID وmessage idempotency key وpayment reference، وتاريخ assignment/field/handoff/payment/knowledge/audit append-only. تتحقق المعاملات من الحالة الحالية قبل transition. callbacks القديمة لا تُرجع الحالة إلى الوراء.
- تسجيل دخول بلا Public Signup. Bootstrap لأول Super Admin يحتاج secret يولد عند deployment ويخزن hash، ويُغلق transactionally عند النجاح. Reset tokens أحادية الاستعمال ومحدودة المدة. تعطيل المستخدم يبطل جلساته. Cookies `HttpOnly`, `Secure` في الإنتاج، `SameSite=Lax`، والتحقق من Origin/CSRF للطلبات المغيّرة.
- credentials مشفرة في قاعدة البيانات، ومفتاح التشفير deployment secret خارج قاعدة البيانات. API لا يعيد قيمتها، ولا تدخل logs أو AI context.

## الرسائل والـAI

يُفصل `IntegrationConnection` عن `MessagingSender`. للإرسال الجديد: Campaign override ثم Branch default ثم Organization shared fallback المسموح. المحادثة القائمة تُثبت sender/thread؛ عند عدم صلاحيته تُحظر الرسالة وتظهر Needs Attention. كل Human/AI/Automation/Follow-up send يدخل خدمة واحدة تفحص الصلاحية، controller، consent/DNC، template، نافذة الوقت والمنطقة الزمنية، الصحة والنطاق، حدود الحملة وقدرات المزود. تُحفظ `QUEUED` داخل معاملة قبل اتصال المزود، ويستهلكها worker مع retries محدودة ومفتاح idempotency. inbound webhook يُتحقق منه ويُحفظ كـIntegration Event قبل حل هوية المحادثة؛ الغموض يذهب لمراجعة بشرية.

الـAI يستقبل Effective Configuration حتمية: Global guardrails الثابتة، Branch defaults المسموحة، Campaign config ونسخة Published Knowledge. كل execution مربوط بـCampaign/Lead/Conversation/knowledge version. لا يحصل النموذج على SQL أو credential. الأدوات المسموحة تستدعي application services ذات الصلاحيات ذاتها. الأسئلة التجارية بلا سند تُصعّد؛ الدفع لا تؤكده رسالة عميل أو قرار نموذج. عند `HUMAN_ACTIVE` لا يحدث AI auto-send.

## التشغيل والنمو

جميع timestamps تخزن UTC؛ نافذة الإرسال والتقارير تُحسب بـIANA timezone للفرع أو override الحملة. القوائم تستخدم keyset pagination وفهارس على branch/campaign/owner/state/time. العمال يستخدمون leases و`SKIP LOCKED`، retries bounded وdead-letter قابل لإعادة المعالجة من واجهة إدارية مصرح بها. فصل queues حسب نوع العمل وأولوية الرسائل، مع حد تزامن لكل connection/sender. إدخال Webhook قصير ويحفظ الحدث قبل المعالجة. Logs منظمة بدون أسرار؛ health وqueue lag وconnection health وerror counters قابلة للرصد.

افتراضات السعة التقنية قابلة للقياس والتعديل: لا يحدد المنتج عدداً ثابتاً للـLeads أو senders؛ تضبط pool size وworker concurrency وbatch size من deployment config، وتُقاس p95 latency وqueue lag ومعدل retries قبل زيادتها. نسخ PostgreSQL احتياطياً مع اختبار استعادة دوري، وملفات object storage بنسخ/retention متوافق. migrations منفصلة وقابلة للتدرج في deploy قبل تفعيل الكود الذي يعتمد عليها.

## التحقق

Unit tests للقواعد، API integration tests مع PostgreSQL، اختبارات permissions ومحاولات URL مباشرة، سيناريوهات webhook/idempotency/out-of-order، simulations للـAI، E2E UI، migration smoke، واختبار حمل لمسارات intake/message. اختبار mock لا يساوي تحققاً مباشراً من Provider. أي Connection بلا credentials حقيقية تعرض حالة غير متصلة ولا تُسجل نجاحاً وهمياً.
