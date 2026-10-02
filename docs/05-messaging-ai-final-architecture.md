# المعمارية النهائية للرسائل والواتساب والذكاء الاصطناعي

## 1. الغرض والمرجعية

هذه الوثيقة تثبت القرارات النهائية المتعلقة بـ:

- WhatsApp وقنوات الرسائل الموجهة للعملاء.
- نطاق أرقام الإرسال وربطها بالمؤسسة والفروع والحملات.
- اختيار رقم/مرسل الرسالة الصادرة.
- معالجة الرسائل الواردة وربطها بالمحادثة والـLead والحملة الصحيحة.
- حماية الإرسال من الحظر أو الاستخدام الخاطئ.
- إعداد الـAI على مستوى المؤسسة والفرع والحملة.
- عزل سياق ومعرفة كل Campaign عن الحملات الأخرى.
- العلاقة بين AI وHuman داخل Conversation.
- التشغيل عالي الحجم والـQueues والـRate Limits.
- الـUI والـReadiness والـAudit والاختبارات الخاصة بهذه المنطقة.

هذه الوثيقة تكمل ولا تستبدل المتطلبات الأخرى الموجودة في:

```text
README.md
AGENTS.md
docs/00-comprehensive-functional-concept.md
docs/01-domain-model.md
docs/02-business-rules-permissions.md
docs/03-integrations-ui-requirements.md
docs/04-ai-agents-conversations.md
```

إذا وجد غموض قديم يتعلق تحديدًا بنطاق Sender/Number أو عزل Campaign AI أو اختيار Sender أو حل الرسائل الواردة أو Messaging Safety، فهذه الوثيقة هي التوضيح النهائي المقصود.

---

# 2. القرار الأساسي لأرقام WhatsApp والـMessaging

لا يجب أن تفترض المنصة:

- رقم WhatsApp واحدًا لكل المؤسسة.
- ولا رقم WhatsApp منفصلًا وإلزاميًا لكل Campaign.

النموذج التشغيلي الافتراضي هو:

```text
Organization
│
├── Shared Senders اختيارية
│
├── Branch A
│   ├── Default Sender A
│   ├── Campaign A1 → ترث Sender A
│   ├── Campaign A2 → ترث Sender A
│   └── Campaign A3 → Sender Override اختياري ومسموح
│
├── Branch B
│   ├── Default Sender B
│   └── Campaigns → ترث Sender B ما لم يوجد Override
│
└── Branch C
    └── ...
```

الـDefault العملي الموصى به هو Business Sender/Number لكل Branch عندما يناسب التشغيل.

لكن يجب أن تدعم المنصة أيضًا:

- Sender واحدًا مشتركًا بين عدة Branches عند السماح بذلك صراحة.
- أكثر من Sender داخل Branch واحدة.
- Sender Override لحملة محددة.
- أكثر من Messaging Provider.
- أكثر من Provider Account / Connection.
- قنوات Messaging أخرى مستقبلًا.

وجود Dedicated Sender لكل Campaign خيار تشغيلي وليس Requirement.

---

# 3. الفصل بين Messaging Connection وBusiness Sender

لا يجب افتراض أن Messaging Connection وBusiness Sender هما دائمًا نفس الشيء.

قد يكون Provider بالشكل التالي:

```text
Provider Account / Messaging Connection
        ↓
One or more Business Senders / Numbers
```

لذلك يجب أن تكون الـArchitecture قادرة على الفصل بين:

## Messaging Connection

يمكن أن تحتوي على:

- Provider Type.
- Credential Reference.
- Organization/Branch Scope.
- Connection Status.
- Capability Metadata.
- Webhook/Callback Configuration.
- Last Success.
- Last Error.
- Health Information.

## Messaging Sender / Number

يمثل الهوية التي ترسل وتستقبل فعليًا أمام العميل، ويمكن أن يحتوي على:

- Messaging Connection Reference.
- External Sender/Phone Identifier.
- Display Identity.
- Status.
- Health.
- Organization/Branch Bindings.
- Provider Quality Metadata عندما تتوفر.
- Throughput/Limit Metadata عندما تتوفر.
- Default/Override Usage Metadata.

لا يتم فرض شكل Provider واحد داخل Core Conversation Domain.

---

# 4. نطاق الـSender والوراثة

التسلسل النهائي هو:

```text
Organization Shared Sender (اختياري)
        ↓
Branch Default Sender
        ↓
Campaign Sender Override (اختياري)
        ↓
Conversation Resolved/Pinned Sender
```

## 4.1 Branch Default Sender

يمكن لكل Branch تحديد Default Sender/Number للتواصل مع العملاء.

هذا هو الـSender الطبيعي لكل Campaign داخل الفرع ما لم يوجد Campaign Override صالح.

## 4.2 Campaign Sender Override

يمكن للحملة اختيار Sender آخر إذا:

- كان Active.
- كان ضمن Scope مسموح للـBranch أو Organization.
- كان المستخدم المصرح له يستطيع اختياره.
- كان Health/Capability مناسبًا للعملية.
- لم يخالف أي Provider/Business Rule.

لا يجوز للحملة استخدام Sender تابع لفرع آخر لمجرد أنه متاح.

## 4.3 Organization Shared Sender

يمكن لـOrganization-scoped Sender أن يخدم عدة Branches فقط من خلال Binding واضح وصريح.

يمكن للManager استخدام Shared Sender المسموح لفرعه بدون رؤية Credentials السرية.

## 4.4 Sender الخاص بالمحادثة القائمة

بعد إنشاء Conversation على Sender/Thread معين:

- لا يتم نقلها بصمت إلى Sender آخر.
- لا يتم تبديل الرقم عشوائيًا.
- أي تغيير يحتاج Workflow صريحًا وآمنًا إذا كانت القناة تسمح بذلك.
- الرسائل التاريخية تبقى مرتبطة بالـSender والـProvider الحقيقيين المستخدمين وقتها.

---

# 5. حل الـSender للرسائل الصادرة

قبل كل رسالة Customer-facing يجب التفريق بين Conversation قائمة وConversation جديدة.

### Conversation قائمة

إذا كانت Conversation مرتبطة بـPinned Sender/Thread:

- يستخدم الـPinned Sender إذا بقي صالحًا.
- إذا أصبح Disabled أو Unauthorized أو Unhealthy أو غير قادر على تنفيذ العملية، يتم `BLOCK / NEEDS ATTENTION` أو يبدأ Explicit migration/restart workflow مناسب للقناة.
- **لا يتم fallback تلقائيًا إلى Sender آخر** لأن ذلك سيغير هوية القناة/الرقم أمام العميل ويكسر historical/thread semantics.

### Conversation جديدة بلا Pinned Sender

يتم حل الـSender بالترتيب:

```text
1. Campaign Sender Override إن وجد وكان صالحًا
2. Branch Default Sender
3. Organization Shared Fallback إذا كان مسموحًا صراحة
4. إذا لم يوجد Sender صالح → BLOCK / NEEDS ATTENTION
```

ممنوع اختيار Sender عشوائي.

إذا كان الـSender:

- Disabled.
- Unauthorized.
- Unhealthy.
- خارج Scope.
- لا يدعم capability مطلوبة.

يتم منع الإرسال وإظهار سبب واضح وقابل للتتبع.

---

# 6. طبقة Messaging Policy مركزية

كل رسالة صادرة للعميل يجب أن تمر عبر طبقة Policy واحدة مشتركة.

ينطبق ذلك على:

- AI Lead Assistant.
- Human Agent.
- Manager عند الإرسال.
- Automation.
- Scheduled Follow-up.
- أي مصدر Customer-facing مستقبلي.

المسار:

```text
Send Request
    ↓
Authorization / Lead Access
    ↓
Conversation Controller Check
    ↓
Sender Resolution
    ↓
Central Messaging Policy
    ↓
Persist Outbound Message / Send Intent as QUEUED with idempotency context
    ↓
Queue / Provider Adapter
    ↓
Provider Send
    ↓
Persist Provider Reference / Delivery State
    ↓
Delivery Callback Tracking
```

تتحقق هذه الطبقة حسب الحاجة من:

- صلاحية الوصول للـLead والـConversation.
- Conversation State.
- Current Controller.
- Consent / Opt-in.
- Do-not-contact / Suppression.
- Provider Policy.
- Template Requirement.
- Allowed Sending Hours.
- Branch/Campaign Timezone.
- Campaign Maximum Attempts.
- Campaign Frequency Controls.
- Sender/Connection Scope.
- Sender/Connection Health.
- Provider Capabilities.
- Provider Rate/Throughput Constraints.
- Provider Quality/Health Signals عندما تتوفر.
- Validation لمحتوى الإرسال.
- Idempotency ومنع Duplicate Send.

لا يوجد bypass خاص للـAI أو Human أو Automation.

---

# 7. حماية الرقم وحدود المزود

لا يتم Hardcode لحدود WhatsApp أو أي Provider المتغيرة كـBusiness Rules ثابتة.

يجب:

- قراءة Provider Capability/Status عندما يكون متاحًا.
- إظهار Health/Quality/Limit Metadata عند توفرها.
- احترام Provider responses.
- استخدام Queues وBackpressure وRetry/Throttle.
- عدم افتراض أرقام ثابتة داخل Core Domain.
- عدم تصميم تعدد الأرقام كطريقة للتحايل على Provider Limits.

تعدد الأرقام مفيد لأسباب تشغيلية مثل:

- فصل الفروع.
- فصل العلامات التجارية.
- اختلاف الفرق.
- Routing.
- Business Continuity.
- اختلاف المنطقة أو اللغة.
- اختلاف الإعدادات التشغيلية.

لكنه ليس بديلًا عن Messaging Compliance.

---

# 8. التشغيل عالي الحجم

Customer Messaging يجب أن يتحمل Burst حقيقية.

عند الحاجة يستخدم:

- Background Jobs.
- Queues.
- Bounded Retries.
- Provider-appropriate Backoff.
- Idempotent Workers.
- Dead-letter / Recovery Strategy.
- Per-Sender / Per-Connection Throttling.
- Backpressure.
- Queue Observability.
- Failure Visibility.
- No Message Loss.

يفضل إعطاء الرسائل Customer-facing العاجلة أولوية على Batch Analysis غير العاجلة عندما يلزم.

تعطل Sender/Connection واحد لا يجب أن يشل باقي Senders/Connections بلا داعٍ.

---

# 9. حل الرسائل الواردة

الرسالة الواردة يجب أن تُحل Deterministically.

المسار:

```text
Provider Webhook
    ↓
Authenticity + Idempotency Verification
    ↓
Persist raw Integration Event / inbound event safely
    ↓
Resolve Messaging Connection
    ↓
Resolve Business Sender / Number
    ↓
Use Provider Thread/Conversation Reference when available
    ↓
Resolve Contact
    ↓
Resolve Active Conversation / Lead / Campaign
    ↓
Persist/attach Message or mark Unmatched/Needs Attention
    ↓
Apply Controller Workflow
```

إشارات الـResolution تشمل:

- Messaging Connection.
- Business Sender.
- Provider Thread/Conversation Reference.
- External Participant Identifier.
- Contact Identity.
- Existing Active Conversation.
- Active Leads.
- Campaign Context.
- External/Source References.

---

# 10. نفس Contact مع عدة Leads أو Campaigns

يمكن للشخص نفسه امتلاك عدة Leads.

مثال:

```text
Ahmed
├── Lead 1 → IELTS Campaign
└── Lead 2 → General English Campaign
```

إذا كانت الحملتان تستخدمان نفس Business Sender ولم يوجد Thread/Conversation Context يحسم المقصود:

- لا تخمن المنصة الحملة.
- لا يجعل الـAI نص الرسالة وحده مرجعًا نهائيًا لاختيار Campaign.
- تحفظ الرسالة أولًا.
- توضع في Needs Attention / Review.
- يقوم User مصرح له بحسم الربط إذا لم توجد قاعدة Deterministic أخرى.

Form Submission جديدة تبقى Lead جديدة وفق قواعد Contact/Lead الحالية حتى لو كان Contact موجودًا سابقًا.

---

# 11. التاريخ والـAudit

يجب الحفاظ على:

- Message Content.
- Direction.
- Provider Message IDs.
- Messaging Connection المستخدمة.
- Sender Identity المستخدمة.
- Timestamps.
- Delivery State.
- AI/Human Sender Identity.
- Handoff History.
- Campaign Context المناسب.
- Knowledge Version للـAI عند الحاجة.

Reassignment لا يعيد كتابة التاريخ.

تغيير Branch/Campaign Messaging Configuration لا يغير تاريخ الرسائل السابقة.

---

# 12. القرار النهائي لمعمارية الـAI

لا تحتاج المنصة إلى Model أو Runtime منفصل ماديًا لكل Branch أو Campaign.

يمكن مشاركة:

- AI Provider.
- Model Profile.
- Inference Runtime.
- Tool Infrastructure.

لكن Customer-facing AI Context يجب أن يبقى معزولًا لكل Campaign.

التسلسل:

```text
Global AI Guardrails
        ↓
Branch AI Defaults
        ↓
Campaign AI Configuration
```

---

# 13. Global AI Guardrails

هي قواعد غير قابلة للتعطيل من Branch أو Campaign.

تشمل:

- Permission Boundaries.
- Approved Tool Boundary.
- منع Direct Unrestricted Database Access.
- منع Secret Leakage.
- منع Cross-Branch Data Access.
- منع Cross-Campaign Knowledge Leakage.
- منع اختراع Company Facts.
- Payment Confirmation Boundary.
- Security Rules.
- Prompt Injection Protections.
- Required Auditability.

---

# 14. Branch AI Defaults

يمكن للـBranch تحديد Defaults قابلة للوراثة مثل:

- Default AI Provider/Profile.
- Default Supported/Preferred Language.
- Locale.
- Timezone.
- Default Human Escalation Target.
- Default Handoff SLA.
- Default Tone/Brand Guidance عند الحاجة.
- Default Messaging Hours.
- أي Operational Defaults مصرح بوراثتها.

Branch Defaults ليست Campaign Knowledge.

---

# 15. Campaign AI Configuration

لكل Campaign إعداد مستقل لسلوك الـAI Customer-facing.

يمكن أن يحتوي على:

- AI Enabled / Disabled.
- AI Provider/Profile Override عندما يكون مسموحًا.
- Published Campaign Knowledge.
- Qualification Questions/Schema.
- Structured Field Mapping.
- Tone.
- Language Behavior.
- Allowed/Prohibited Claims.
- Approved Assets/Links.
- Handoff Rules.
- Follow-up Policy.
- Allowed Tools.
- Campaign Messaging Behavior.
- Optional Messaging Sender Override.
- Closed / Returning Contact Policy.
- Activation / Readiness State.

Campaign AI Configuration لا يعني Model منفصلًا ماديًا.

---

# 16. عزل سياق الـAI بين الحملات

هذه قاعدة Security وCorrectness إلزامية.

إذا Campaign A وCampaign B تستخدمان نفس Provider/Model/Runtime:

```text
Campaign A Execution
    → Campaign A Lead
    → Campaign A Conversation
    → Campaign A Published Knowledge
    → Campaign A Qualification
    → Campaign A Handoff/Follow-up Rules
```

لا يجوز أن تحصل على بيانات Campaign B مثل:

- Knowledge.
- Instructions.
- Prices.
- Qualification Questions.
- Follow-up Rules.
- Handoff Rules.
- Leads.
- Conversations.

Shared Runtime لا يعني Shared Business Context.

---

# 17. Effective AI Configuration

قبل أي Customer-facing AI Execution يبني الـBackend Effective Configuration:

```text
Effective Config
    =
Global Guardrails
    +
Allowed Branch Defaults
    +
Allowed Campaign Overrides
```

ويجب أن يكون قابلًا للتتبع.

يجب أن نعرف عند الحاجة:

- Global Rules.
- Inherited Branch Defaults.
- Campaign Overrides.
- Published Knowledge Version.
- AI Provider/Profile.
- Allowed Tools.
- Conversation.
- Resolved Messaging Sender.

لا يعتمد النظام على Prompt Text وحده كمصدر لهذه القواعد.

---

# 18. Initial AI Contact

المسار:

```text
Lead Created
    ↓
Campaign Resolved
    ↓
Branch Resolved
    ↓
Routing / Lead Owner
    ↓
Build Effective AI Configuration
    ↓
Load Current Published Campaign Knowledge
    ↓
Resolve Messaging Sender
    ↓
Create / Resolve Conversation
    ↓
Central Messaging Policy
    ↓
Queue / Provider Send
```

إذا فشل Messaging أو AI:

- لا تضيع Lead.
- لا تحذف Conversation.
- يظهر Failure واضح.
- يستخدم Retry أو Human Attention حسب القواعد.
- لا يتم Fake Success.

---

# 19. AI Follow-up

Follow-up يبقى Campaign-specific.

يمكن أن يحدد:

- Initial Timing.
- Delays.
- Maximum Attempts.
- Allowed Sending Hours.
- Timezone.
- Stop on Inbound Reply.
- Stop on Handoff.
- Stop on Human Takeover.
- Stop on Closed.
- Final No-response Action.

قبل كل Send فعلي يعاد التحقق من Central Messaging Policy.

---

# 20. Lead Owner وConversation Controller

يبقى الفصل واضحًا:

```text
Lead Owner = Sarah
Conversation Controller = AI
```

وبعد Handoff:

```text
Lead Owner = Sarah
Conversation Controller = HUMAN (Sarah)
```

عندما Controller = AI:

- يسمح Auto-send فقط عبر Tools/Policies المسموحة.

عندما Controller = HUMAN:

- يتوقف AI Auto-send.
- يمكن للـAI العمل كـCopilot.
- Human Controller الفعلي يجب أن يكون واضحًا.
- Takeover يكون Explicit.
- يمنع Concurrent Conflicting Replies.

---

# 21. Human Handoff

يشمل الحالات الموثقة مثل:

- طلب العميل موظفًا.
- نقص معلومة تجارية مؤكدة.
- Qualified Milestone.
- Complaint.
- Sensitive Scenario.
- Pricing Exception.
- Payment Issue.
- Repeated Misunderstanding.
- Campaign Condition.
- Manual Takeover.

إذا لم يوجد Agent مؤهل:

- WAITING_FOR_HUMAN أو equivalent.
- إشعار Manager/Attention Queue.
- لا يتم Random Assignment.
- Transition Message فقط إذا كانت Approved Policy تسمح.

---

# 22. متطلبات الـUI

## Messaging Management

تعرض:

- Provider Connections.
- الفرق بين Connection وSender.
- Business Senders/Numbers.
- Organization/Branch/Campaign Bindings.
- Branch Default Sender.
- Campaign Overrides.
- Scope.
- Connection/Sender Health.
- Inbound Webhook Status.
- Outbound Test.
- Templates عند الحاجة.
- Delivery Callbacks.
- Provider Capabilities.
- Quality/Throughput/Limit Metadata عندما تتوفر.
- Queue/Blocked-send Indicators عند الحاجة.
- Errors وRequired Action.

## Branch Settings

تشمل:

- Timezone.
- Working/Business Hours.
- Default Messaging Hours.
- Default Messaging Sender/Number.
- Allowed Shared Senders.
- Branch AI Defaults.
- Escalation Defaults.

## Campaign Messaging UI

تعرض:

- Inherited Branch Sender.
- Optional Campaign Sender Override.
- Effective Sender.
- Sending Hours.
- Follow-up Frequency / Max Attempts.
- Templates عند الحاجة.
- Closed/Returning-contact Policy.
- Readiness/Errors.

## Campaign AI UI

تعرض:

```text
Global Guardrails
    ↓
Inherited Branch Defaults
    ↓
Campaign Overrides
    ↓
Effective Configuration
```

---

# 23. Campaign Readiness

قبل Activation مع Messaging/AI يتحقق النظام حسب الحاجة من:

- Branch.
- Source/Binding.
- Routing.
- Required Field Mapping.
- Messaging Configuration.
- Valid Resolved Sender.
- Campaign Sender Override Scope.
- Sender/Connection Health.
- AI Provider/Profile.
- Published Knowledge.
- Qualification Mapping.
- Handoff Path.
- Follow-up Policy.
- Required Templates.
- Timezone/Sending Hours.
- Required Tools/Permissions.
- Test/Simulation Requirements.

لا يتم Activation بصمت مع Setup غير صالح.

---

# 24. الـAuditability

يجب تتبع التغييرات المهمة مثل:

- Messaging Connection Changes.
- Sender Bindings.
- Branch Default Sender.
- Campaign Sender Override.
- AI Provider/Profile.
- Branch AI Defaults.
- Campaign AI Configuration.
- Knowledge Publish/Version.
- Handoff Rules.
- Follow-up Policy.
- Blocked Send Reasons المهمة.

لا يلزم تخزين Hidden Chain-of-thought.

---

# 25. حالات الفشل المطلوبة

يجب وجود سلوك واضح لـ:

- Messaging Provider Unavailable.
- Sender Unavailable.
- Authentication Expired.
- Sender Health Degraded.
- Provider Rate Limit.
- Required Template Missing/Unavailable.
- Consent/Do-not-contact Block.
- Sending-hours Block.
- Invalid Campaign Sender Binding.
- Ambiguous Inbound Mapping.
- AI Provider Unavailable.
- Missing Knowledge.
- AI Tool Failure.
- No Eligible Human.

الفشل لا يحذف Lead أو Conversation أو Inbound Message.

---

# 26. اختبارات إلزامية

يجب اختبار:

- Branch Default Sender.
- Campaign Sender Override.
- Unauthorized Cross-Branch Sender.
- Existing Conversation Sender Pinning.
- No Valid Sender.
- Do-not-contact.
- Missing Template.
- Sending-hours Block.
- Frequency/Max-attempt Block.
- Unhealthy Sender.
- Provider Throttling.
- Duplicate Send Idempotency.
- Exact Thread Resolution.
- Multiple Active Leads Ambiguity.
- Needs Attention.
- Campaign AI Context Isolation.
- Global Guardrails.
- Branch Defaults Inheritance.
- Campaign Override.
- Historical Knowledge Version.
- HUMAN_ACTIVE يمنع AI Auto-send.
- No Eligible Human.
- Burst Webhooks.
- Out-of-order Callbacks.
- Queue Recovery.

---

# 27. المبدأ النهائي

```text
Lead Source
    ↓
Campaign
    ↓
Branch
    ↓
Lead / Contact
    ↓
Assignment
    ↓
Conversation
    ↓
Resolved Business Sender
    ↓
AI or Human Controller
    ↓
Central Messaging Policy
    ↓
Messaging Provider
```

والـAI:

```text
Global AI Guardrails
        ↓
Branch AI Defaults
        ↓
Campaign AI Configuration
        ↓
Current Lead + Conversation
        ↓
Published Campaign Knowledge
        ↓
Approved Tools
        ↓
Central Messaging Policy
        ↓
Customer
```
