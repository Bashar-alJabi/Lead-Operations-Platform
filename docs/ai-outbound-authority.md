# سلطة AI في فحص Central Messaging Policy

## نطاق المرحلة — Native147

هذه مرحلة داخلية من `sendConversationMessage` المطلوبة في 04 و05 وAGENTS §§17–24. تفصل سلطة المصدر الآلي عن صلاحيات الموظف، وتستخدم سياسة الإرسال الموجودة نفسها. لا تنشئ Message أوAction receipt أوOutbox، ولا تجعل الأداة أوCustomer runtime مكتملتين. Live AI transfer وCustomer activation تبقيان معطلتين.

## المصدر والسلطة

- تنشأ `ai_customer_send_admission` بصورة ذرية مع **Proposal جديدة** من inbound موثقة عبر `messaging_inbound_authentication`. Native147 تشترط original current full context وcurrent AI control وactive/waiting state دونAttention، وأن تكون `sendConversationMessage` معتمدة صراحة وأن تكون الرسالة الواردة آخر رسالة فعلية.
- Admission غير قابلة للتعديل أوالحذف؛ توقيتها مشتق من DB. لا backfill أوpublic enqueue أوإحياء source قديمة بمنح الأداة لاحقًا، ولا سلطة من Human session أوCopilot أوSimulation أوModel claim.
- `ai_customer_send_admission_context` تقفل الآباء وLead/Contact/Conversation واعتماديات current context، ثم تقارن السياق الكامل بالأصل دون إسقاط أجزاء منه. QUEUED/RUNNING تسمحان **بفحص تمهيدي**؛ PROPOSED مقيدة بـANSWER/QUESTION. كل هذا ليس إذن تنفيذ أوإرسال.
- Internal `AI_ADMISSION` تحمل Proposal ID فقط؛ Org/Branch/Campaign/Lead/Conversation تستخرج من DB المثبتة، مع مطابقة Conversation المطلوبة. لا Agent أوManager اصطناعي ولا استعارة Owner كفاعل. Authority تبقى مرتبطة بالنطاق المقفول عند فحص السياسة ولا تمرر هوية ثانية مستقلة عنه.
- Human entry point `enqueueOutboundMessage` أصبحت صريحة HUMAN-only؛ author آلي مزور يرفض بـ403 قبل DB/credentials. Actual dispatch يبقى Human-only في هذه المرحلة.

## السياسة المشتركة

Human وAI source inspection تستخدمان loader والسياسة نفسيهما: scoped Lead access وcurrent Controller وLead/Campaign/Messaging readiness وConsent/DNC وPinned Sender/Connection/health/capabilities وMeta service window/template وBranch timezone/sending window وproactive maxAttempts/minInterval. عداد المحاولات ووقت آخر محاولة يقرآن من Message history الفعلية عبر Conversations الخاصة بالـLead، ووقت التقييم من PostgreSQL.

فحص source لا يختار Sender بديلًا ولا يعدل Owner/Controller أوPayment/Enrollment. السلوك الحالي للسياسة في تسجيل Attention عند مشكلة Sender/participant محفوظ. Revocation أوتغيّر version أوKnowledge/Fields/Profile/consent/owner/control/source يفقد Admission صلاحيتها وفق current full context؛ الموافقة الأصلية وحدها لا تكفي.

## الحد التشغيلي

لا إعداد تشغيلي جديد أوتعديل env/DB مطلوب من المستخدم. Approved Tools UI الموجودة هي موضع المنح/الإلغاء، ولكن وجود المنح لا يفعّل الأداة غير المكتملة. مصدر Send-only ما زال diagnostic ويتحول للمراجعة وفق worker الحالية؛ لا تخفيف لذلك قبل ربط executor وnative message/outbox proof. default worker تبقى live-off حتى في وجود Admission سليمة. لا Provider calls في هذا المسار.

## الإثبات

`test/outbound-authority.test.ts` تثبت رفض AI/AUTOMATION/FOLLOW_UP عند Human entry قبل أي I/O. `test-integration/ai-outbound-authority-scenarios.ts` تعمل داخل fixture HMAC الحقيقية في `ai-customer-handoff.test.ts` وتثبت source freshness/immutability/no-backfill،Grant/Consent revoke-restore،DNC،eight-way inspection،wrong Conversation/Agent/Branch/Organization،Human takeover،Owner version،Pinned Sender disable،window،وmaxAttempts/frequency من historical records فعلية داخل transaction تُلغى. default live-off وعدم إنشاء customer Message/send job مثبتان؛ الاختبارات السابقة تحمي Human enqueue/dispatch/recovery.

التصنيف: implementation داخلية قابلة للتحقق بـPostgreSQL/HTTP mocks؛ **ليست اكتمال `sendConversationMessage`** أوLive Provider Verified. نتائج البوابة المؤكدة تسجل في progress/coverage عند checkpoint.

## الخطوة التالية الدقيقة

Actual immutable ANSWER/QUESTION action مع content مشتقة من Published references/approved question،وnative receipt/message/outbox proof وdurable bounded action job. بعد إدراج الرسالة المحلية، أثبت exact own-message delta دون تخفيف original full context أوإحياء مصدر قديم. بعدها dispatch بالسلطة الآلية نفسها وCentral Policy الحالية وlive-off gate، ثم provider mocks/idempotency/retry/UNKNOWN/handoff races وscoped Conversation UI وBrowser E2E. Initial contact/returning/follow-up/approved transition والـAI الأوسع والوحدات اللاحقة تبقى ضمن المتطلبات غير المكتملة.
