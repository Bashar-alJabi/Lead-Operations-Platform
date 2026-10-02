# تعليمات مشروع Lead Operations & Sales Management

## 1. طبيعة المشروع

هذا المشروع هو منصة Production-ready متكاملة لإدارة الـLeads والعمليات البيعية.

المطلوب تنفيذ المنتج الكامل المحدد في وثائق المشروع، وليس MVP أو Prototype أو Demo مبسطة.

المنتج يشمل إدارة:

- Leads.
- Contacts.
- Campaigns.
- Branches.
- Agents.
- Dynamic Fields.
- Routing.
- Conversations.
- Messaging.
- Follow-ups.
- Payments.
- Enrollment.
- Analytics.
- Automations.
- AI Lead Assistant.
- AI Operations Assistant.
- External Integrations.

---

## 2. وثائق المشروع

قبل تنفيذ أي جزء رئيسي من النظام يجب قراءة وفهم:

```text
README.md
docs/00-comprehensive-functional-concept.md
docs/01-domain-model.md
docs/02-business-rules-permissions.md
docs/03-integrations-ui-requirements.md
docs/04-ai-agents-conversations.md
docs/05-messaging-ai-final-architecture.md
docs/06-final-completeness-and-acceptance.md
```

كل وثيقة مسؤولة عن نوع مختلف من المتطلبات، ويجب تفسيرها معاً كمنظومة واحدة.

---

## 3. مصدر الحقيقة

لا تفترض وجود وثيقة واحدة تحتوي جميع المتطلبات.

يجب أخذ:

- Product behavior من الـFunctional Concept.
- Domain semantics من الـDomain Model.
- Permissions وBusiness Rules من ملف القواعد.
- Integration وUI flows من ملف Integrations/UI.
- AI وConversation behavior التفصيلي من ملف AI/Conversations.
- القرارات النهائية الخاصة بـMessaging sender architecture وCampaign AI isolation من `05-messaging-ai-final-architecture.md`.
- Definition of Done والـAcceptance النهائية من `06-final-completeness-and-acceptance.md`.

إذا وجد غموض قديم في **Messaging sender scope أو inbound/outbound resolution أو Central Messaging Policy أو AI configuration inheritance/context isolation**، فإن ملف `05` يحسم هذه النقاط فقط، ولا يستخدم لإلغاء Requirements أخرى.

لا تنشئ Source-of-Truth hierarchy من عندك إذا لم يوجد تعارض فعلي.

---

## 4. التعامل مع التعارضات

عند وجود تعارض:

1. حدده بدقة.
2. حدد الملفات والأجزاء المتعارضة.
3. راجع بقية الوثائق والسياق.
4. لا تغير Business Logic من تلقاء نفسك.
5. لا تحذف Feature لأنها أصعب تقنياً.
6. لا تختر حلاً عشوائياً.

إذا كان التعارض يؤثر على:

- Business Behavior.
- Data Model.
- Permissions.
- Security.
- Integrations.
- AI autonomy.
- Conversation ownership.
- Payments.

فيجب تحديد المشكلة والحل المقترح قبل تنفيذ تغيير جوهري.

أما القرارات التقنية التي لا تغير سلوك المنتج فيمكن حسمها بأفضل تصميم Production-ready.

---

## 5. لا تخترع متطلبات

لا تضف من تلقاء نفسك:

- Roles جديدة.
- صلاحيات تجارية جديدة.
- Workflows تغير سلوك المنتج.
- Provider dependency غير مطلوبة.
- Product scope جديد غير موثق.

إذا ظهرت حاجة تقنية ضرورية لتنفيذ متطلب موجود، يمكن إضافة Abstraction أو Entity أو Service تقنية مناسبة مع توثيق السبب.

---

## 6. القرارات التقنية

المواصفات تحدد **ماذا يجب أن يفعل المنتج**.

أنت مسؤول عن تحديد **كيف يتم بناؤه تقنياً**.

يمكنك اختيار:

- Programming Language.
- Framework.
- Database.
- ORM.
- Infrastructure.
- Queue / Background Jobs.
- Cache.
- Search technology.
- AI technology.
- Integration architecture.
- Deployment architecture.

يجب أن تستند الاختيارات إلى:

- Correctness.
- Security.
- Reliability.
- Data Integrity.
- Maintainability.
- Performance.
- Scalability.
- Development speed.
- Operational simplicity.
- Reasonable cost.
- Testability.
- Provider independence.
- Suitability for AI-assisted development.

لا تستخدم تقنية معقدة دون حاجة.

---

## 7. المشروع ليس MVP

لا تحذف أو تؤجل Feature موثقة بحجة:

- MVP.
- V1.
- V2.
- Later.
- Nice to have.

يمكن تقسيم التنفيذ إلى مراحل تقنية وTasks، لكن نطاق المنتج الكامل يبقى محفوظاً.

---

## 8. Security وBackend Enforcement

الـBackend هو المرجع الفعلي لتنفيذ:

- Authentication.
- Authorization.
- Role/Scope enforcement.
- Branch isolation.
- Lead access.
- Conversation access.
- Field access.
- Integration access.
- AI tool permissions.
- Validation.
- Business Rules.

لا تعتمد على Frontend hiding كوسيلة حماية.

مثال:

إذا كان Agent لا يملك Lead، يجب أن يمنع الـBackend الوصول إلى:

- Lead details.
- Conversation.
- Messages.
- AI summary.
- Attachments.
- Actions.

حتى لو حاول الوصول عبر URL أو API مباشرة.

---

### Authentication baseline

يجب أن يكون Account lifecycle Production-ready، بما يشمل على الأقل:

- Secure login.
- Password/credential reset flow.
- Secure one-time First Super Admin bootstrap بدون hardcoded default credentials أو Public Signup.
- Bootstrap credential/token/path يجب إبطاله بعد نجاح التهيئة وأن يكون قابلاً للتدقيق حسب التصميم.
- Session expiration and revocation.
- Disabled users cannot create new authenticated sessions.
- Logout invalidates the intended session.
- Protection against brute-force / abusive authentication attempts.
- No secrets in client-side code.

إذا تم اختيار MFA، فيجب تنفيذه بطريقة قابلة للإدارة ولا تكسر الـRole/Account lifecycle.

---

### Untrusted content & file safety

أي Customer/AI/external content يعرض في الواجهة يجب أن يعامل كـUntrusted Content ويُrender بطريقة تمنع XSS/HTML injection.

أي File upload أو attachment أو AI Knowledge asset يجب أن يخضع، بحسب نوعه، إلى:

- Authorization.
- File size/type validation.
- Safe storage naming/path handling.
- Malware/content scanning عندما يكون مناسباً.
- منع تنفيذ الملفات المرفوعة ككود.
- Access control عند download/read.

لا تثق في MIME type أو filename القادم من العميل وحده.

---

## 9. In-Platform Operational Setup

قاعدة أساسية:

> كل Setup تشغيلي يحتاجه Super Admin أو Manager لتشغيل المنتج يجب أن يكون متاحاً من داخل واجهة المنصة حسب الصلاحيات.

يشمل ذلك عند الحاجة:

- Meta connections.
- OAuth.
- API keys / tokens.
- Webhook information.
- Lead source connections.
- WhatsApp / Messaging providers.
- Messaging senders/numbers.
- Payment providers.
- Email providers.
- Google integrations.
- AI providers.
- AI models/profiles.
- Campaign knowledge.
- Qualification questions.
- Follow-up policy.
- Provider-to-Branch/Campaign binding.
- Field mapping.
- Test connection.
- Reconnect.
- Disable.
- Connection status.
- Error information.

لا تبن Feature تتطلب من المستخدم التشغيلي تعديل:

- Source code.
- Server files.
- Environment variables يدوياً.
- Database records يدوياً.
- CLI commands.
- Hardcoded provider IDs.

Deployment/infrastructure secrets اللازمة لتشغيل التطبيق نفسه يمكن إدارتها تقنياً خارج المنتج، لكن **Business-managed integration connections** يجب ألا تعتمد على تعديلات deployment بعد إطلاق المنصة.

---

## 10. External Provider Prerequisites

لا تفترض أن المنصة تستطيع إلغاء متطلبات مزود خارجي.

إذا كان Provider يتطلب مثلاً:

- إنشاء Account.
- إنشاء App.
- إنشاء API credential.
- الموافقة على OAuth.
- إعداداً لا يوفر له API.

فيجب أن:

1. تبدأ العملية من داخل المنصة.
2. تعرض الواجهة تعليمات دقيقة.
3. توضح ما الذي يجب إنشاؤه أو نسخه من المزود.
4. تستقبل Credential/authorization بشكل آمن.
5. تختبر الربط.
6. تعرض Status واضحاً.
7. لا تتطلب تعديل الكود أو السيرفر.

لا تحاول Fake أو Hardcode هذا الإعداد فقط لجعل Demo يعمل.

---

## 11. ممنوع استخدام حسابات شخصية أو تجريبية كاعتماد للمنتج

لا تربط المنتج النهائي من تلقاء نفسك بـ:

- حساب OpenAI خاص بالمطور.
- حساب Meta شخصي.
- رقم WhatsApp شخصي.
- Stripe account خاص بالمطور.
- أي API key موجودة على جهاز التطوير بشكل غير موثق.
- أي Provider account خارجي فقط من أجل جعل Feature تبدو عاملة.

التنفيذ يجب أن يكون **جاهزاً للربط من خلال المنصة**.

في الاختبارات استخدم:

- Mocks.
- Fakes.
- Test doubles.
- Provider sandbox عندما يكون مطلوباً ومتاحاً ومصرحاً به.
- Test credentials منفصلة ومخصصة للاختبار فقط عند توفرها صراحة.

لا تستخدم Production credentials أو حسابات المستخدم الفعلية بدون إعداد صريح ومقصود.

---

## 12. Provider Independence

لا تربط Core Business Logic بمزود واحد.

يجب أن تكون البنية قابلة لدعم:

- أكثر من Lead Source.
- أكثر من Meta account/connection.
- أكثر من WhatsApp/Messaging provider.
- أكثر من Messaging sender/number.
- أكثر من Payment provider.
- أكثر من Payment account.
- أكثر من Email provider.
- أكثر من AI provider/model.
- أكثر من AI Assistant/Agent configuration.

استخدم Provider adapters أو equivalent abstraction عندما يكون ذلك مناسباً.

لا تبالغ في abstraction إذا لم تكن هناك حاجة، لكن لا hardcode مزوداً داخل الـDomain Logic.

---

## 13. Integration Connections

عامل كل اتصال خارجي كـConnection مستقل له على الأقل مفاهيم مثل:

- Provider type.
- Scope.
- Owner/Branch/Organization.
- Status.
- Credentials reference.
- Configuration.
- Health information.
- Last success.
- Last failure.
- External identifiers.

يجب دعم تعطيل Connection بدون حذف التاريخ المرتبط به.

---

## 14. Secrets & Credentials

Credentials الحساسة:

- لا تحفظ Plaintext إذا كان بالإمكان تجنب ذلك.
- لا تظهر كاملة بعد الحفظ.
- لا تسجل في Logs.
- لا تظهر في Error messages.
- لا تصل للـAgent.
- لا ترسل للـAI Model.
- لا تستخدم في Frontend إلا بالقدر الضروري جداً لتدفق authorization آمن.

يجب تطبيق أقل صلاحية ممكنة لكل Integration.

---

## 15. Data Integrity

حافظ على سلامة البيانات في:

- Duplicate events.
- Webhook retries.
- Provider retries.
- Concurrent operations.
- Partial failures.
- Import retries.
- Payment callbacks.
- AI tool execution.
- Message delivery callbacks.

استخدم Idempotency أو equivalent safeguards حيث يلزم.

لا تسمح لتكرار Webhook أو Job بإنشاء:

- Lead مكررة غير مقصودة.
- Payment مكرر.
- Message duplicate.
- Automation duplicate.
- AI action duplicate.

---

### Out-of-order events

لا تفترض أن callbacks أو webhooks تصل بالترتيب الصحيح.

خصوصاً:

- Message delivery callbacks.
- Payment events.
- OAuth/token refresh events.
- External synchronization events.

يجب ألا يعيد Event قديم Current State إلى حالة أقدم بشكل غير صحيح.

---

## 16. التكاملات الخارجية غير موثوقة

اعتبر الخدمات الخارجية قابلة للفشل أو التأخير أو إرسال أحداث مكررة.

يجب أن تكون التكاملات:

- قابلة لإعادة المحاولة.
- قابلة للتتبع.
- مقاومة للتكرار.
- معزولة عن Core Business Logic.
- ذات timeouts مناسبة.
- ذات failure states واضحة.
- قابلة للمراقبة.

فشل خدمة خارجية لا يجب أن يؤدي تلقائياً إلى انهيار النظام الأساسي.

---

### Webhook/API security

أي Endpoint يستقبل أحداثاً خارجية يجب أن يطبق ما يناسب المزود من:

- Signature / authenticity verification.
- Replay/duplicate protection.
- Idempotency.
- Strict payload validation.
- Rate limiting / abuse protection.
- Safe logging without secrets.

لا تثق في Payload خارجي لأنه جاء إلى Webhook معروف فقط.

---

## 17. Conversations & Messaging

Customer conversation داخل المنصة جزء من Lead Operations وليس Chat system منفصل.

يجب أن يدعم النظام:

- Conversation مرتبطة بالـLead.
- Messages inbound/outbound.
- Provider message IDs.
- Delivery state.
- Full conversation history.
- AI/Human sender identity.
- Current conversation controller.
- Human handoff.
- Assignment-based access.

الـAgent يرد من داخل المنصة.

لا تسمح لـAgent برؤية أو الرد على Conversation لا يملك صلاحيتها.

---

### Message integrity

Customer-facing Messages المرسلة أو المستلمة تعتبر Historical records:

- لا يتم تعديل محتوى Message بعد إرسالها/استلامها كأنها لم تتغير.
- Correction تتم برسالة جديدة.
- Internal Notes لا يجوز أن تُرسل للعميل بالخطأ.
- Reassignment لا يحذف Conversation history.

### Messaging policies

كل Customer-facing outbound send من AI أو Human أو Automation أو Follow-up يجب أن يمر عبر **Central Messaging Policy** واحدة.

قبل الإرسال طبق:

- Authorization / Lead access.
- Current Conversation Controller.
- consent / do-not-contact state.
- provider policy.
- template requirement إن وجد.
- allowed sending window + timezone.
- sender/connection scope.
- sender/connection health.
- Campaign frequency/max-attempt rules.
- provider capabilities والـrate/throughput/quality constraints عندما تتوفر.
- idempotency / duplicate protection.

النموذج النهائي للـSender:

```text
Organization Shared Sender (اختياري)
        ↓
Branch Default Sender
        ↓
Campaign Sender Override (اختياري)
        ↓
Conversation Resolved/Pinned Sender
```

قواعد الـResolution:

- Existing Conversation ذات Pinned Sender/Thread تستخدمه إذا بقي صالحاً. إذا أصبح غير صالح، يتم Block/Needs Attention أو Explicit migration workflow؛ **لا تسقط تلقائياً إلى Sender آخر**.
- New Conversation بلا Pinned Sender تستخدم: Campaign Sender Override → Branch Default Sender → Organization Shared Fallback المسموح صراحة → وإلا Block/Needs Attention.

لا تفترض رقم WhatsApp واحداً لكل النظام، ولا تفرض رقماً منفصلاً لكل Campaign، ولا تختَر Sender عشوائياً.

Inbound resolution يستخدم Connection + Business Sender + provider thread/reference + participant/contact + active Conversation/Lead + Campaign/external references. إذا بقي Ambiguous، تحفظ الرسالة وتذهب إلى Needs Attention/Review ولا يتم التخمين.

Provider capability يجب أن يحدد ما هو مدعوم فعلياً؛ لا تفترض أن كل مزود يدعم Read receipts أو Templates أو Attachments بنفس الطريقة. كما لا Hardcode لحدود Provider المتغيرة كBusiness constants.

---

## 18. Lead Owner vs Conversation Controller

لا تخلط بين:

**Lead Owner / Assigned Agent**

و:

**Conversation Controller**

يمكن مثلاً أن يكون:

```text
Lead Owner = Sarah
Conversation Controller = AI
```

ثم بعد Handoff:

```text
Lead Owner = Sarah
Conversation Controller = HUMAN
```

هذا الفصل يجب أن يبقى واضحاً في الـDomain والـBusiness Logic.

---

## 19. AI Architecture Boundary

الـAI ليس Source of Truth.

لا تعط AI Model صلاحية مباشرة غير مقيدة إلى قاعدة البيانات أو Providers.

النمط المطلوب:

```text
AI
↓
Approved Tool / Action
↓
Application Service
↓
Authorization
↓
Business Rules
↓
Database / Provider
```

أي Action حساس يجب أن يمر عبر نفس القواعد التي يمر بها المستخدم العادي.

---

## 20. AI Permission Inheritance

الـAI الداخلي يعمل ضمن Scope المستخدم الذي استدعاه.

مثال:

إذا Agent لا يستطيع رؤية Lead تابعة لـAgent آخر، فلا يجوز أن يستطيع AI Operations Assistant إرجاع معلومات عنها له.

AI customer-facing يعمل ضمن:

- Campaign scope.
- Lead scope.
- Approved knowledge.
- Approved tools.

ولا يحصل على صلاحيات عامة للنظام.

---

## 21. AI Provider Independence

لا تربط Business Logic باسم Model واحد أو Provider واحد.

يجب أن يكون من الممكن تغيير:

- Conversation model.
- Summarization model.
- Classification model.
- Analysis model.

من Configuration مناسبة دون تعديل الـDomain Logic.

يمكن في البداية استخدام نفس Model لكل المهام إذا كان ذلك أبسط، لكن التصميم لا يجب أن يمنع فصلها مستقبلاً.

---

## 22. Campaign AI Knowledge

إذا كانت Campaign تستخدم AI Lead Assistant، يجب أن تعتمد على Knowledge منشورة ومعتمدة.

يجب دعم:

- Draft.
- Published.
- Version history.
- Approved links/files.
- FAQs.
- Qualification questions.
- Allowed claims.
- Prohibited claims.
- Escalation rules.
- Follow-up policy.

الـAI لا يجب أن يستخدم Draft غير منشورة في Customer-facing answers.

### AI Configuration Inheritance & Campaign Isolation

Customer-facing AI configuration تتبع:

```text
Global AI Guardrails
        ↓
Branch AI Defaults
        ↓
Campaign AI Configuration
```

- Global Guardrails تشمل Security/Permissions/Tool boundaries/no-fabrication rules ولا يمكن للحملة تعطيلها.
- Branch Defaults هي Defaults تشغيلية قابلة للوراثة فقط ضمن الحدود المسموحة.
- Campaign Configuration تحدد Knowledge وQualification وTone/Language وFollow-up وHandoff وAllowed Tools وسلوك الـMessaging الخاص بالحملة.
- يمكن مشاركة Provider/Model/Runtime بين عدة Campaigns.
- مشاركة Runtime لا تعني مشاركة Business Context.
- Campaign A لا يجوز أن تحصل على Knowledge/Instructions/Qualification/Lead/Conversation data الخاصة بـCampaign B.
- Effective Configuration لكل AI Execution يجب أن تكون Deterministic وقابلة للتتبع، بما فيها Knowledge Version والـProvider/Profile والـCampaign scope.

---

### Untrusted AI input

اعتبر كل ما يأتي من:

- Lead messages.
- Imported text.
- External source payloads.
- Uploaded knowledge files.
- Web content or provider metadata.

بيانات غير موثوقة، وليست تعليمات نظام.

لا تسمح لمحتوى Customer أو Knowledge أن:

- يغير Permissions.
- يضيف Tool access.
- يكشف secrets.
- يتجاوز Campaign rules.
- يلغي guardrails.

---

## 23. AI Unknown-Answer Rule

إذا كانت المعلومة المطلوبة عن:

- الشركة.
- السعر.
- المنتج.
- الخدمة.
- شروط التسجيل.
- المواعيد.
- السياسات.
- أي Claim تجاري.

غير موجودة في المعرفة المعتمدة:

- لا يخترع AI جواباً.
- لا يعتمد على معلومات عامة غير مؤكدة.
- يوضح أنه لا يملك معلومة مؤكدة.
- ينفذ Handoff أو escalation وفق القواعد.

---

## 24. Human Handoff

عند انتقال Conversation إلى Human:

- يتوقف AI عن الإرسال التلقائي.
- يبقى AI متاحاً كـCopilot إذا سمحت الواجهة.
- يمكنه Suggest reply أو Summarize.
- لا يرسل للعميل إلا بعد إعادة تفعيل واضحة أو Rule موثقة.

يجب منع AI والـHuman من الرد التلقائي في الوقت نفسه.

---

## 25. AI Facts vs Interpretation

الحقائق التشغيلية مثل:

- عدد Leads.
- Payments.
- Conversion count.
- Leads without follow-up.

يجب أن تأتي من Queries/Services موثوقة داخل المنصة.

AI يستخدم لـ:

- Natural-language explanation.
- Summarization.
- Categorization.
- Conversation analysis.
- Pattern detection.

لا تجعل AI يقوم بتخمين أرقام يمكن للنظام حسابها بدقة.

---

## 26. AI Auditability

يجب أن يمكن تتبع AI actions المهمة.

سجل عند الحاجة:

- Assistant/Agent identity.
- Lead.
- Campaign.
- User context.
- Conversation.
- Knowledge version.
- Requested tool.
- Executed action.
- Result.
- Failure reason.
- Timestamp.

لا تسجل أسراراً أو بيانات غير لازمة في AI logs.

---

## 27. Historical Data

لا تستبدل Current State بطريقة تمحو التاريخ المطلوب.

حافظ عند الحاجة على:

- Assignment history.
- Conversation history.
- Message history.
- Field history.
- Payment events.
- Enrollment events.
- Integration events.
- AI action history.
- Knowledge versions.
- Audit logs.

---

## 28. Testing

لا تعتبر Feature مكتملة لمجرد أن الكود Compiles.

اختبر:

- Business Logic.
- Permissions.
- Branch isolation.
- Lead access.
- Conversation access.
- Validation.
- Integrations.
- Webhooks.
- Retries.
- Idempotency.
- Background jobs.
- Payment confirmation.
- AI tools.
- AI guardrails.
- Handoff behavior.
- Failure behavior.

---

### Routing tests

اختبر خصوصاً:

- Round Robin concurrency.
- Weighted distribution.
- Agent capacity.
- Working hours.
- No eligible agent.
- Reassignment.
- Performance-based routing with insufficient historical data.

لا تنسب AI-created speed أو AI contact attempts إلى Human Agent performance metrics.

---

## 29. AI Evaluation Tests

إضافة إلى Unit/Integration tests، أنشئ Evaluation scenarios للـAI.

أمثلة إلزامية:

### Unknown campaign question

Expected:

- AI does not invent.
- AI escalates or hands off.

### Agent asks about unauthorized Lead

Expected:

- Access denied.
- No hidden data leaks.

### Human took over conversation

Expected:

- AI does not auto-send.

### Published knowledge changed

Expected:

- New eligible responses use the new published version.
- Historical trace retains the version used previously.

### AI provider unavailable

Expected:

- Core Lead operations continue.
- Failure is visible/retryable according to rules.

### Duplicate webhook

Expected:

- No duplicate Lead/message/payment action.

---

## 30. تشغيل المشروع والتحقق

بعد تنفيذ أي جزء مهم:

1. شغّل المشروع.
2. نفّذ الاختبارات.
3. اختبر السلوك الفعلي.
4. اختبر failure paths.
5. اختبر permissions.
6. اختبر integrations باستخدام mocks/sandbox المناسبة.
7. أصلح المشاكل.
8. أعد الاختبار.

لا تفترض أن الكود صحيح لأنه يبدو صحيحاً.

---

## 31. التعامل مع Tasks

عند تنفيذ Task:

1. اقرأ المتطلبات المرتبطة.
2. افهم Dependencies.
3. افحص الكود الحالي.
4. نفذ أقل تغيير صحيح.
5. لا تكسر extensibility الحالية.
6. اختبر.
7. تحقق من Regression.
8. وثق القرار إذا كان طويل الأمد.

لا تتعامل مع Task كأنها نظام مستقل.

---

## 32. جودة الكود

الكود يجب أن يكون:

- واضحاً.
- منظماً.
- آمناً.
- قابلاً للصيانة.
- قابلاً للاختبار.
- قابلاً للتوسع.
- غير معقد بلا داعٍ.

تجنب:

- Overengineering.
- Duplicate logic.
- Provider-specific logic داخل Core Domain بلا حاجة.
- Dead code.
- Temporary hacks.
- Hardcoded credentials.
- Hardcoded external account IDs.
- Hidden production dependencies.

---

### Production operability

التصميم يجب أن يتضمن ما يناسب التطبيق من:

- Structured logs.
- Health checks.
- Error monitoring.
- Queue/job observability.
- Integration health.
- Backup/restore strategy.
- Safe database migrations.
- Environment separation بين development/staging/production.

لا تجعل Production recovery تعتمد على تعديل يدوي غير موثق في قاعدة البيانات.

---

## 33. Documentation

لغة وثائق المنتج والـArchitecture والـImplementation Plan والـProgress/Completion reports داخل هذا المشروع تكون **العربية**، مع إبقاء أسماء الـAPIs والـClasses والـEntities والـtechnical terms بالإنجليزية عندما يكون ذلك أوضح. أسماء الكود والIdentifiers يمكن أن تبقى بالإنجليزية وفق أفضل الممارسات.

وثائق المنتج هي المرجع الوظيفي.

أي قرار تقني مهم طويل الأمد يؤثر على:

- Architecture.
- Security.
- Data.
- Integrations.
- AI.
- Messaging.
- Deployment.

يجب توثيقه في المكان التقني المناسب داخل المشروع.

لا تحول Product docs إلى Implementation dump، لكن لا تترك Architecture مؤثرة بلا توثيق.

---

## 34. المتطلبات غير الواضحة

إذا كان المتطلب:

- ناقصاً.
- متناقضاً.
- غامضاً.
- مؤثراً على Business Logic.
- مؤثراً على Data Model.
- مؤثراً على Security/Permissions.

لا تخمّن.

حدد:

1. المشكلة.
2. الخيارات.
3. الحل المقترح.
4. السبب.
5. الأجزاء المتأثرة.

التفاصيل الصغيرة التي لا تغير Product Behavior يمكن حسمها بأبسط حل صحيح.

---

## 35. أول خطوة قبل التنفيذ الكبير

قبل بدء التنفيذ البرمجي الرئيسي:

1. اقرأ `AGENTS.md`.
2. اقرأ `README.md`.
3. اقرأ كل `docs/`.
4. افحص Repository الحالي.
5. افهم Architecture الموجودة إن وجدت.
6. استخرج التعارضات والنقاط الناقصة.
7. صمم Technical Architecture.
8. حدد Integration abstractions.
9. حدد Security model.
10. حدد AI/provider strategy.
11. حدد Data model/migrations.
12. حدد خطة تنفيذ واختبار.
13. لا تبدأ النظام الكبير قبل اكتمال هذه المرحلة.

---

## 36. قاعدة القرار

عند المفاضلة بين الحلول التقنية، الأولوية:

1. صحة المتطلبات.
2. Security وPermissions.
3. Data Integrity.
4. Reliability.
5. Maintainability.
6. Extensibility.
7. Performance وScalability.
8. Operational simplicity.
9. Reasonable cost.
10. Development convenience.

لا تضحي بمتطلب أساسي لتسهيل البرمجة.

---

## 37. القاعدة الأساسية

> **وثائق المشروع تحدد ماذا يجب أن يفعل المنتج.**

نفّذ المنتج كما هو موثق، مع Architecture Production-ready تسمح للإدارة بإعداد وتشغيل Integrations والـAI والحملات من داخل المنصة، وتحافظ على Security وPermissions وProvider independence بدون الاعتماد على حسابات شخصية أو إعدادات يدوية مخفية.

## 38. Scalability & High-Volume Operation

افترض أن المنصة ستعمل مع عدد كبير ومتزايد من Campaigns وBranches وAgents المتزامنين وLeads اليومية وConversations/Messages وWebhooks وAutomations وAI jobs وPayment events وAnalytics records.

لا تبن Architecture مناسبة فقط لبيئة صغيرة أو Demo.

يجب أن يراعي التصميم عند الحاجة:

- Horizontal scalability.
- Stateless application services قدر الإمكان.
- Background jobs/queues للعمليات الطويلة أو القابلة لإعادة المحاولة.
- Database connection pooling.
- Proper indexes بناءً على query patterns الفعلية.
- Server-side pagination.
- عدم تحميل آلاف السجلات دفعة واحدة.
- Avoiding N+1 queries.
- Idempotent workers.
- Backpressure وProvider rate limits.
- Per-Sender/Per-Connection throttling أو isolation عندما يكون ذلك مناسباً.
- Sender/Connection health وProvider quality/throughput signals عندما يوفرها المزود.
- Bounded retries.
- Dead-letter/recovery strategy عند الحاجة.
- Efficient analytics strategy.
- Safe bulk operations.
- Queue/job observability.
- Database migration strategy مناسبة مع نمو البيانات.
- Load/performance tests على المسارات الحرجة.

لا تفترض أرقام Capacity غير موجودة في المواصفات كحقائق Business. وثّق Technical Capacity assumptions واجعلها قابلة للتعديل والقياس.

لا تختَر Microservices لمجرد أن المنتج كبير؛ اختر أبسط Architecture Production-ready يمكن توسيعها فعلياً.

---

## 39. Final Completeness Review

قبل إعلان المشروع جاهزاً:

- راجع `docs/06-final-completeness-and-acceptance.md`.
- أنشئ Requirement Coverage Matrix تربط كل Requirement Area بالـSource Docs والتنفيذ والاختبارات والحالة.
- لا تستخدم `Complete` لأي Area فيها Placeholder أو Stub أو TODO حرجة أو Permission ناقصة أو Test حرج فاشل.
- ميّز بين `Implemented` و`Mock/Sandbox Verified` و`Live Provider Verified` و`Live Verification Pending External Credential/Approval`.
- غياب Production credential لا يبرر ترك Adapter أو Setup UI أو Validation أو Tests غير منفذة.
- لا تدّعِ أن Live Integration تم التحقق منها إن لم يتم ذلك فعلياً.

---

## 40. Autonomous Technical Execution

بعد قراءة المواصفات كاملة:

- لا تسأل المستخدم عن Framework أو Database أو ORM أو Queue أو Cache أو AI SDK أو Hosting preference إذا لم تفرضها المتطلبات.
- اختر أفضل Stack وArchitecture للمشروع ودوّن أسباب الاختيار.
- أنشئ Technical Architecture وImplementation Plan داخل Repository ثم تابع التنفيذ مباشرة.
- لا تنتظر موافقة المستخدم على القرارات التقنية العادية.
- إذا وجدت غموضاً تقنياً لا يغير Business Behavior، احسمه بأفضل قرار Production-ready ودوّنه.
- لا توقف التنفيذ بسبب سؤال يمكن حله من المواصفات أو reasoning هندسي واضح.

اطلب User input فقط عند blocker حقيقي مثل تعارض Business لا يمكن حسمه، أو Credential/approval خارجي لا يمكن استبداله بـmock/sandbox، أو قرار قانوني/تجاري غير موجود ويغير Product behavior جذرياً.

حتى عند غياب External credential، أكمل كل ما يمكن بناؤه واختباره باستخدام adapters/mocks/sandbox.
