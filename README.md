# Lead Operations & Sales Management Platform

## 1. About the Project

منصة ويب مركزية Production-ready لإدارة الـLeads والعمليات البيعية من مكان واحد.

تدير المنصة دورة الـLead من لحظة وصوله من Meta أو أي مصدر آخر، مروراً بالحملة والفرع والتوزيع والتواصل والمتابعة، وصولاً إلى الدفع والاشتراك والتحليلات والأتمتة والـAI.

المنصة هي **Operational Source of Truth** للـLeads والعمليات المرتبطة بها، بينما تتكامل مع الخدمات الخارجية المطلوبة من خلال Connections يتم إعدادها وإدارتها من داخل المنصة حسب الصلاحيات.

---

## 2. Core Workflow

```text
Lead Source
    ↓
Lead Intake
    ↓
Campaign
    ↓
Branch
    ↓
Lead Owner / Agent Assignment
    ↓
AI Initial Contact & Qualification (when enabled)
    ↓
Human Handoff / Agent Follow-up
    ↓
Payment
    ↓
Enrollment
    ↓
Analytics
    ↓
Automation / AI Operations Assistant
```

يمكن تعطيل AI Initial Contact لأي Campaign. عند تعطيله تستمر العملية مباشرة مع الـAgent.

---

## 3. Main Roles

### Super Admin

تحكم كامل بالنظام وجميع Branches والبيانات والإعدادات والتكاملات ضمن الصلاحيات المعرّفة.

### Manager

إدارة Branch واحد والـAgents والـCampaigns والـLeads والإعدادات والتكاملات التي تقع ضمن نطاق Branch والصلاحيات الممنوحة له.

### Agent

المستخدم التشغيلي الذي يتعامل فقط مع الـLeads والمحادثات والإجراءات المسموح له بها.

### Account Access

- لا يوجد Public Signup.
- إنشاء المستخدمين يتم من داخل المنصة بواسطة Role مخول.
- إنشاء **أول Super Admin** يتم عبر Bootstrap آمن لمرة واحدة أثناء الإعداد الأولي، بدون Default Password hardcoded وبدون فتح Public Signup؛ بعد النجاح يجب إبطال/تعطيل bootstrap path أو token حسب التصميم.
- تعطيل المستخدم يمنع تسجيل الدخول والوصول الجديد بدون حذف التاريخ السابق.
- يجب دعم Login آمن، Password Reset/credential recovery، Session invalidation، وتسجيل الخروج.
- تفاصيل Authentication التقنية يتم تحديدها في الـArchitecture، لكن لا يجوز الاعتماد على Frontend فقط لحماية الحسابات.

---

## 4. Main Product Areas

المنصة تشمل:

- Branch Management.
- User Management.
- Contact Management.
- Lead Management.
- Campaign Management.
- Flexible Campaign Fields.
- Lead Sources & Intake.
- Meta Lead Integration.
- Lead Routing & Assignment.
- Conversations & Messaging.
- AI Lead Assistant.
- AI Operations Assistant.
- Human Handoff.
- Follow-ups.
- Activity Timeline.
- Notifications.
- WhatsApp / Messaging Channels.
- Payment Links.
- Payment Confirmation.
- Enrollment.
- Analytics.
- Automations.
- AI-assisted Insights.
- Search & Filters.
- Saved Views.
- Bulk Actions.
- CSV / Excel Import & Export.
- Google Sheets Integration.
- Integration Management.
- Audit Logs.

---

## 5. Flexible Fields

المنصة لا تعتمد على مجموعة ثابتة من الأعمدة.

يمكن لكل Campaign أن تحتوي على Fields مختلفة، مع إمكانية:

- إنشاء Fields.
- اختيار Field Type.
- ترتيب Fields.
- إظهار أو إخفاء Fields.
- تحديد قابلية التعديل.
- تحديد Required Fields.
- تحديد Fields للـTable.
- تحديد Fields للـLead Details.
- استخدام Fields في Filters.
- استخدام Fields في Automations.
- استخدام Fields في AI Qualification عند الحاجة.
- إنشاء Calculated Fields.

وبالتالي يمكن أن تكون كل Campaign مختلفة عن الأخرى في طريقة إدارة بيانات Leads.

---

## 6. Lead Model

يفصل النظام بين:

**Contact**

الشخص نفسه.

و:

**Lead**

طلب أو فرصة محددة مرتبطة بهذا الشخص.

يمكن للشخص الواحد امتلاك أكثر من Lead.

كل Lead يمكن أن ترتبط بـ:

- Campaign.
- Branch.
- Assigned Agent / Lead Owner.
- Source.
- Conversation.
- Dynamic Fields.
- Follow-ups.
- Payments.
- Enrollment.
- Activities.
- AI interactions.

---

## Lead Lifecycle vs Campaign Status

المنصة تفرق بين:

- Internal Lead Lifecycle (`OPEN / CLOSED / ARCHIVED`) المستخدمة للتشغيل والـCapacity.
- Campaign Status الاختياري والقابل للتخصيص.

لا يتم استخدام Custom Status كبديل ضمني عن Core lifecycle.

---

## 7. External Integrations

التكاملات الأساسية تشمل:

- Meta.
- WhatsApp / Messaging Providers.
- Payment Providers.
- Email Providers.
- Google Sheets.
- AI Providers.
- Generic API / Webhook Sources.

ويجب أن يكون النظام قابلاً لإضافة Providers وLead Sources أخرى مستقبلاً.

### Integration principles

- المنصة هي Source of Truth للبيانات التشغيلية.
- لا يجوز ربط الـBusiness Logic بمزود واحد بشكل يمنع استبداله.
- يجب دعم أكثر من Connection أو Account لنفس نوع التكامل عندما يحتاج التشغيل ذلك.
- Credentials وTokens تحفظ بشكل آمن ولا تعرض للمستخدمين غير المصرح لهم.
- يجب توفير Status وTest Connection وLast Error وReconnect/Disable عندما يكون ذلك مناسباً.
- فشل مزود خارجي لا يجب أن يؤدي تلقائياً إلى انهيار Core Operations.

---

## 8. In-Platform Setup Principle

أي Setup تشغيلي يحتاجه Super Admin أو Manager لتشغيل المنصة يجب أن يتم من خلال واجهة المنصة حسب الصلاحيات.

يشمل ذلك، حسب التكامل:

- Connect Account.
- OAuth flow.
- API Key / Token entry.
- Webhook URL / Secret configuration.
- Account / Page / Form selection.
- Provider configuration.
- Sender / Channel configuration.
- Payment account configuration.
- AI Provider configuration.
- AI model/profile selection عندما يسمح النظام بذلك.
- Field Mapping.
- Test Connection.
- Connection health.
- Error information.
- Reconnect / Disable.
- Campaign binding.

لا يجب أن يحتاج المستخدم التشغيلي إلى:

- تعديل Source Code.
- تعديل Environment Variables يدوياً.
- الدخول إلى السيرفر.
- تشغيل Commands.
- تعديل Database.
- كتابة Configuration files يدوياً.

إذا كان Provider خارجي يفرض خطوة لا يمكن تنفيذها بالكامل من خلال API، مثل إنشاء Account أو App أو استخراج Credential من بوابة المزود، تبدأ العملية من واجهة المنصة وتعرض للمستخدم تعليمات دقيقة حول:

1. ما المطلوب.
2. أين يحصل عليه.
3. ماذا ينسخ.
4. أين يضعه داخل المنصة.
5. كيف يختبر الربط.
6. ما حالة الاتصال بعد ذلك.

الهدف هو أن تكون **المنصة هي مركز الـSetup والتشغيل** حتى عندما توجد خطوة إلزامية لدى مزود خارجي.

---

## 9. WhatsApp & Customer Conversations

WhatsApp ليس مجرد Notification Channel في هذا المنتج.

يمكن استخدام Messaging Channel مركزي، مثل WhatsApp Business، من أجل:

- التواصل الأولي مع Lead.
- AI qualification.
- Human Agent follow-up.
- Customer replies.
- Approved follow-up messages.
- Internal notifications عند الحاجة.

### Customer-facing model

```text
Lead
  ↓
Company Messaging Channel
  ↓
Platform Conversation
  ↓
AI Lead Assistant or Human Agent
```

الـAgent يرد من داخل المنصة ولا يحتاج إلى استخدام رقم WhatsApp شخصي للتواصل مع Leads.

يجب أن يبقى وصول كل Agent مقيداً بالـLeads والمحادثات المسموح له بها.

يمكن أن توجد عدة Messaging Connections أو Senders حسب Organization / Branch / Brand / operational configuration.

النموذج التشغيلي النهائي للـMessaging/WhatsApp هو:

```text
Organization Shared Sender (اختياري)
        ↓
Branch Default Sender
        ↓
Campaign Sender Override (اختياري)
        ↓
Conversation Resolved/Pinned Sender
```

القواعد الأساسية:

- لا تفترض المنصة رقم WhatsApp واحداً لكل النظام.
- لا تفرض رقماً منفصلاً لكل Campaign.
- الـDefault العملي هو Sender/Number على مستوى Branch.
- Campaign ترث Branch Default Sender ما لم تحدد Override صالحاً ومسموحاً.
- Organization-scoped Sender يمكن مشاركته بين Branches فقط عبر Binding صريح.
- Conversation القائمة لا تنتقل بصمت إلى Sender آخر.
- إذا كان Provider يفصل Account/Connection عن Sender/Number، يجب أن يعكس الـDomain هذا الفصل.

يجب أن تحترم الرسائل الآلية والبشرية:

- Consent / opt-in عندما يكون مطلوباً.
- Provider messaging policies.
- Template requirements عندما يفرضها المزود.
- Allowed sending windows / business hours.
- Suppression / do-not-contact state عندما تكون موجودة.
- Sender/Connection scope.
- Connection/Sender health.
- Campaign frequency/max-attempt rules.
- Provider capabilities والـrate/throughput/quality constraints عندما تكون متاحة.

كل Outbound Message للعميل، سواء جاءت من AI أو Human أو Automation أو Follow-up، تمر عبر **Central Messaging Policy** واحدة قبل Provider send. هذه الطبقة تنفذ Authorization وController check وSender resolution وConsent/DNC وTemplate requirements وSending hours وHealth/Provider constraints وIdempotency.

Sender resolution يفرق بين:
- **Existing Conversation**: إذا كان لها Pinned Sender/Thread صالح يستخدم نفسه. إذا أصبح غير صالح، يتم Block/Needs Attention أو Explicit migration workflow؛ لا يتم التحويل تلقائياً إلى رقم آخر.
- **New Conversation**: Campaign Sender Override → Branch Default Sender → Organization Shared Fallback المسموح صراحة → وإلا Block/Needs Attention.

Inbound Message لا تُربط بـCampaign أو Lead بالتخمين. يتم Resolve باستخدام Connection + Business Sender + Provider thread/reference + Contact + Active Conversations/Leads + Campaign/External References. إذا بقي أكثر من Candidate صالح، تحفظ الرسالة وتوضع `Needs Attention` أو Review بدل اختيار Campaign عشوائياً.

حدود Provider المتغيرة مثل Messaging limits أو throughput أو quality لا تُحفظ كأرقام Business ثابتة hardcoded؛ يتم التعامل معها كProvider capabilities/status ديناميكية قدر الإمكان.

المنصة ليست WhatsApp CRM عاماً أو Customer Support Suite؛ المحادثات الموجودة فيها تخدم Lead Operations lifecycle فقط.

---

## 10. AI

الـAI جزء مساعد من المنتج وليس Source of Truth.

المنصة تدعم مفهومين رئيسيين:

### AI Lead Assistant

Customer-facing عند تفعيله للحملة.

يمكنه:

- بدء التواصل الأولي.
- الإجابة من Campaign Knowledge المنشورة والمسموحة فقط.
- جمع Qualification data.
- تحديث Structured Qualification Fields عبر Actions مسموحة.
- تنفيذ Follow-up policy المسموحة.
- طلب Human Handoff.
- إنشاء Summary للـAgent.

لا يجوز له اختراع معلومات غير موجودة في المعرفة المعتمدة.

### AI Operations Assistant

Internal-facing.

يساعد الإدارة والـAgents ضمن صلاحيات المستخدم في:

- Summaries.
- Operational questions.
- Lead and Campaign insights.
- Leads needing attention.
- Follow-up analysis.
- Conversation analysis.
- Suggested next actions.
- Reporting explanations.

الأرقام والحقائق التشغيلية يجب أن تأتي من Platform data / approved tools، بينما يستخدم AI للتفسير والتلخيص والتحليل اللغوي.

يجب التفريق في الـAnalytics بين:

- First Platform Contact.
- First AI Contact.
- First Human Contact.
- First Customer Response.
- AI Contact Attempts.
- Human Contact Attempts.
- AI Response Time.
- Human Agent Response Time.

حتى لا تُنسب سرعة الـAI أو محاولاته إلى أداء الـHuman Agent.

---

## 11. AI Permissions & Provider Independence

الـAI لا يملك صلاحيات تتجاوز المستخدم أو الـCampaign أو الـBranch.

المبدأ:

```text
User / System Permission
        ↓
Allowed AI Tool
        ↓
Application Service
        ↓
Authorization + Business Rules
        ↓
Data / External Provider
```

لا يجب إعطاء الـAI وصولاً حراً مباشراً إلى قاعدة البيانات لتنفيذ Business Actions.

يجب فصل الـAI Provider عن Core Business Logic بحيث يمكن:

- تغيير Model.
- استخدام Model مختلف لمهمة مختلفة.
- إضافة Provider آخر مستقبلاً.
- تشغيل أكثر من AI Assistant / Agent configuration.

بدون إعادة بناء الـLead Operations domain.

---

## 12. Campaign AI Configuration

كل Campaign يمكن أن تمتلك AI Configuration خاصة بها.

يمكن أن تشمل:

- AI enabled / disabled.
- Campaign Knowledge.
- FAQs.
- Product / service information.
- Prices إذا كانت مسموحة.
- Locations.
- Schedules.
- Requirements.
- Approved links.
- Approved files.
- Qualification questions.
- Allowed claims.
- Prohibited claims.
- Escalation rules.
- Human handoff rules.
- Follow-up policy.
- AI language/tone settings عند الحاجة.

يتم إعداد هذه المعلومات من داخل المنصة.

إعداد الـAI Customer-facing يتبع التسلسل النهائي:

```text
Global AI Guardrails
        ↓
Branch AI Defaults
        ↓
Campaign AI Configuration
```

- Global Guardrails تشمل القيود الأمنية وحدود الصلاحيات والـTools والقواعد غير القابلة للتجاوز.
- Branch AI Defaults توفر Defaults تشغيلية قابلة للوراثة فقط، مثل timezone/locale/escalation/provider profile عندما يكون ذلك مناسباً.
- Campaign AI Configuration تحدد فعلياً Knowledge وQualification وTone/Language وFollow-up وHandoff وAllowed Tools والسلوك الخاص بالحملة.
- يمكن مشاركة نفس AI Provider/Model/Runtime بين Campaigns متعددة؛ المطلوب هو **عزل الـContext والـConfiguration لكل Campaign** وليس Model مادي منفصل لكل حملة.
- Campaign A لا يجوز أن تقرأ Knowledge أو Instructions أو Qualification أو Lead/Conversation data الخاصة بـCampaign B بسبب مشاركة نفس Provider/Model.

يجب دعم Draft وPublished knowledge/versioning بحيث يستخدم الـAI النسخة المنشورة المعتمدة فقط.

---

## 13. Payments

كل Branch يمكن أن يملك Payment Methods الخاصة به.

يمكن دعم أكثر من Payment Provider أو أكثر من Connection.

التدفق الأساسي:

```text
Payment Method
    ↓
Payment Link
    ↓
Trusted Payment Confirmation
    ↓
Enrollment
```

المشروع لا يتضمن:

- Installments.
- Payment Plans.
- Refund Management.
- Accounting System.
- Financial Ledger.

---

## 14. Languages

المنصة تدعم:

- Arabic.
- French.
- English.

Arabic:

**RTL**

French / English:

**LTR**

والواجهة Responsive للـDesktop والTablet والMobile.

---

## 15. Documentation

المواصفات الأساسية للمشروع موجودة داخل:

```text
docs/
```

وتتكون من:

```text
00-comprehensive-functional-concept.md
01-domain-model.md
02-business-rules-permissions.md
03-integrations-ui-requirements.md
04-ai-agents-conversations.md
05-messaging-ai-final-architecture.md
06-final-completeness-and-acceptance.md
```

### `00-comprehensive-functional-concept.md`

المرجع الوظيفي العام للمنتج:

- Product concept.
- Roles.
- Campaigns.
- Leads.
- Fields.
- Routing.
- Conversations.
- Payments.
- Analytics.
- Automation.
- AI.
- Product boundaries.

### `01-domain-model.md`

المرجع الخاص بـ:

- Entities.
- Relationships.
- Current state vs history.
- Integration connections.
- Conversations / messages.
- AI configurations / executions.
- Data responsibilities.

### `02-business-rules-permissions.md`

المرجع الخاص بـ:

- Roles.
- Permissions.
- Branch isolation.
- Lead access.
- Conversation access.
- Field rules.
- Routing.
- Payments.
- AI permissions.
- Integration setup rules.
- Security-related business rules.

### `03-integrations-ui-requirements.md`

المرجع الخاص بـ:

- External integrations.
- In-platform setup.
- Meta.
- Messaging / WhatsApp.
- Payments.
- Google Sheets.
- AI provider connections.
- UI / UX.
- Screens.
- User workflows.

### `04-ai-agents-conversations.md`

المواصفة التفصيلية الخاصة بـ:

- AI Lead Assistant.
- AI Operations Assistant.
- Campaign AI Knowledge.
- Qualification.
- Conversation lifecycle.
- Human handoff.
- AI tools.
- AI permissions.
- AI follow-ups.
- Failure handling.
- Auditability.
- AI evaluation requirements.

### `05-messaging-ai-final-architecture.md`

المرجع النهائي الذي يحسم:

- Branch Default Sender وCampaign Sender Override.
- Messaging Connection مقابل Business Sender.
- Deterministic inbound/outbound resolution.
- Central Messaging Policy.
- High-volume messaging behavior.
- Global → Branch → Campaign AI configuration.
- Campaign AI context isolation.

إذا وجد غموض أقدم في هذه النقاط تحديداً، فهذا الملف هو التوضيح النهائي دون إلغاء المتطلبات الأخرى.

### `06-final-completeness-and-acceptance.md`

المرجع الخاص بـDefinition of Done والـAcceptance الشاملة للمنتج:

- اكتمال Modules.
- Security/Reliability.
- Required tests.
- Critical End-to-End scenarios.
- Requirement Coverage Matrix.
- شروط إعلان المنصة جاهزة.

---

## 16. AI Development Instructions

يوجد في جذر المشروع:

```text
AGENTS.md
```

وهو يحتوي على قواعد العمل التي يجب على AI Coding Agent اتباعها أثناء تطوير المشروع.

يجب على أي AI Coding Agent قراءة:

```text
AGENTS.md
README.md
docs/
```

وفهمها كمنظومة واحدة قبل تنفيذ الأجزاء الرئيسية من النظام.

---

## 17. Technical Architecture

الـTechnology Stack والـTechnical Architecture ليست مفروضة مسبقاً داخل وثائق المنتج.

المطلوب من Software Architect / AI Coding Agent اختيار الحل التقني الأنسب بناءً على المتطلبات الكاملة.

يجب أن يحقق الاختيار:

- Correctness.
- Security.
- Reliability.
- Data Integrity.
- Maintainability.
- Performance.
- Scalability.
- Reasonable Cost.
- Operational Simplicity.
- Provider Independence.
- Testability.
- Suitability for AI-assisted development.

لا يجوز اختيار Architecture تجعل إضافة Provider أو Lead Source أو AI configuration جديدة تتطلب إعادة بناء Core Business Logic.

---

## 18. Product Boundaries

المشروع ليس:

- LMS.
- Course Marketplace.
- General WhatsApp CRM.
- General-purpose Chat Platform.
- Customer Support Suite.
- ERP.
- Accounting Software.
- Full Financial System.

لكن المنتج **يتضمن Messaging وConversation capabilities الضرورية لإدارة الـLead والتواصل معه ضمن دورة المبيعات**.

ولا يعتمد على:

- Google Sheets كقاعدة بيانات رئيسية.
- AI كمصدر حقيقة.
- Provider واحد ثابت.
- AI Model واحد ثابت.
- مجموعة ثابتة من Fields لكل Campaign.
- حسابات شخصية للمطور لتشغيل Integrations في المنتج النهائي.

---

## 19. Development Principle

المبدأ الأساسي للمشروع:

> **نحن نحدد ماذا يجب أن يفعل المنتج، بينما يتم اختيار طريقة التنفيذ التقنية بناءً على المتطلبات، دون تغيير Business Behavior لتسهيل التنفيذ.**

ويجب أن تكون النتيجة النهائية منصة يستطيع المستخدم المصرح له إعداد وتشغيل التكاملات والحملات والـAI من داخلها، بدون الاعتماد على تعديلات يدوية في الكود أو السيرفر أثناء التشغيل اليومي.

## 20. Scalability & High-Volume Operation

المنصة يجب أن تُبنى من البداية لبيئة تشغيل حقيقية يمكن أن تحتوي على عدد كبير من الـCampaigns والـAgents والـLeads اليومية والـConversations والـMessages والـWebhooks والـAutomations والـAI jobs والـPayment events مع نمو مستمر في البيانات التاريخية.

لا يجوز تصميم الـBackend أو الـDatabase أو الـUI على افتراض Dataset صغير.

يجب أن يختار التصميم التقني ما يلزم من:

- Production-grade database.
- Proper indexes and constraints.
- Connection pooling.
- Server-side pagination.
- Efficient filtering/sorting.
- Background jobs / queues.
- Retry + idempotency.
- Provider rate-limit handling.
- Bounded concurrency.
- Safe bulk processing.
- Caching عندما يكون مناسباً دون كسر correctness.
- Horizontal scaling عندما يكون مناسباً.
- Observability للـlatency والـqueue lag والـdatabase load.
- Load/performance testing للمسارات الحرجة.

لا تفرض المواصفات أرقام Throughput أو Hardware sizing من عندها. على الـTechnical Architecture وضع Capacity assumptions قابلة للقياس ومنع العمليات الثقيلة مثل Import/Export/Analytics/AI batch work من تعطيل Lead intake أو Conversations اليومية.

## 21. Codex Execution Prompt

يوجد في جذر المشروع:

```text
INITIAL-CODEX-PROMPT.md
```

وهو الـPrompt الذي يُعطى لـCodex لبدء تنفيذ المشروع.

هذا الملف لا يحدد Technology Stack مسبقاً. المطلوب من Codex قراءة كامل المواصفات بما فيها `05` و`06`، فحص Repository الحالي، اختيار الـArchitecture والـStack الأفضل، توثيق القرارات التقنية، ثم متابعة التنفيذ الكامل مباشرة بدون تحويل المستخدم إلى مصدر للقرارات التقنية اليومية.

النسخة الحالية من `INITIAL-CODEX-PROMPT.md` هي الـPrompt العربي النهائي المعتمد لـCodex. لا تعتبر المنصة مكتملة قبل المرور على Definition of Done وRequirement Coverage Matrix المعرّفة في المواصفات.
