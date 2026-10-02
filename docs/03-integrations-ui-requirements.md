# Integrations, Data Flows & UI Requirements

# 1. Purpose

هذه الوثيقة تحدد المتطلبات الوظيفية المتعلقة بـ:

- External integrations.
- In-platform setup.
- Lead sources.
- Meta.
- Messaging / WhatsApp.
- Payment providers.
- Email.
- Google Sheets.
- AI provider connections.
- Data flows.
- UI/UX.
- Screens.
- Setup workflows.
- Error/permission states.

لا تفرض:

- Programming language.
- Frontend/backend framework.
- Database.
- Hosting.
- Queue.
- Cache.
- Specific AI model.
- Specific messaging/payment provider.

---

# PART A — INTEGRATION REQUIREMENTS

# 2. Integration Principles

كل Integration يجب أن:

- يكون منفصلاً عن Core Business Logic.
- يدعم Status واضح.
- يكون قابلاً للمراقبة.
- يسجل failures المهمة.
- يدعم retry حيث يلزم.
- يحمي من duplicate events.
- يحافظ على original source data.
- يسمح بالتغيير أو الإضافة المستقبلية بدون إعادة بناء Core Domain.
- يخضع للصلاحيات.
- يدعم أكثر من Connection عندما يحتاج التشغيل ذلك.

---

# 3. In-Platform Setup Principle

أي Setup تشغيلي مطلوب من Super Admin أو Manager يجب أن يتم من داخل واجهة المنصة حسب الصلاحيات.

لا يجب أن يحتاج المستخدم إلى:

- تعديل Source Code.
- تعديل Environment Variables يدوياً.
- الدخول إلى السيرفر.
- تشغيل CLI.
- تعديل Database.
- كتابة JSON/config files يدوياً.

كل Integration مناسب يجب أن يملك Setup Wizard أو equivalent flow.

---

# 4. Standard Integration Setup UX

عندما يكون ذلك مناسباً، يجب أن يحتوي Setup على:

1. Provider selection.
2. Prerequisites.
3. Scope selection.
4. Connect / Authenticate.
5. Credential/API key/token entry عند الحاجة.
6. Webhook information عند الحاجة.
7. External resource discovery/selection.
8. Test Connection.
9. Validation.
10. Save.
11. Health/Status.
12. Last activity.
13. Last error.
14. Reconnect.
15. Disable.
16. Binding to Branch/Campaign/use case.
17. Audit history.

---

# 5. External Provider Prerequisites

بعض Providers تتطلب خطوات لا تستطيع المنصة تنفيذها نيابة عن المستخدم، مثل:

- إنشاء Provider account.
- إنشاء app/project.
- قبول OAuth consent.
- استخراج API key.
- إعداد business verification.
- خطوات vendor-specific غير متاحة عبر API.

في هذه الحالات:

- تبدأ العملية من داخل المنصة.
- تعرض المنصة شرحاً دقيقاً.
- تعرض ما الذي يحتاجه المستخدم ولماذا.
- توضح من أين يحصل على القيمة.
- توفر Copy buttons للقيم التي يجب نسخها.
- توفر Back-to-platform continuation.
- تنفذ Test Connection بعد الإعداد.

الهدف: لا يحتاج المستخدم إلى معرفة تقنية أو Developer intervention لإكمال setup التشغيلي العادي.

---

# 6. Multi-Connection Requirement

النظام لا يفترض Connection واحدة لكل نوع.

يجب أن يمكن دعم:

- أكثر من Meta account.
- أكثر من Page/Form.
- أكثر من Messaging provider.
- أكثر من WhatsApp sender/number.
- أكثر من Payment account/provider.
- أكثر من AI provider connection.
- أكثر من Email connection.

كل Connection لها Scope وStatus واضحان.

في Messaging تحديداً، يجب دعم Branch Default Sender مع Campaign Sender Override اختياري، ولا يتحول تعدد Connections إلى افتراض أن كل Campaign تحتاج Number مستقلة.

---

# 7. Credentials UX

عند إدخال Secret:

- الحقل Masked.
- لا يعرض secret كاملة بعد Save.
- يمكن Replace/Rotate حسب الصلاحيات.
- لا يعرض للAgent.
- لا تظهر في Logs/Errors.
- يجب إظهار آخر وقت تم Update فيه بدون كشف القيمة.

---

# 8. Integration Status

حالات مفاهيمية مثل:

- Not configured.
- Connected.
- Warning.
- Error.
- Disconnected.
- Disabled.
- Authentication expired.

مع:

- Last successful activity.
- Last error.
- Required action.
- Test connection result.
- Provider capabilities عند الحاجة.

الواجهة لا يجب أن تعرض Feature غير مدعومة من Connection وكأنها متاحة.

---

# 9. Meta Integration

Meta مصدر Leads أساسي.

يجب أن تتمكن المنصة من التعامل مع:

- Meta account/business resources المطلوبة.
- Facebook Pages.
- Campaigns.
- Ad Sets.
- Ads.
- Instant Forms.
- Leads.

---

# 10. Meta Connection Setup

من داخل المنصة، المستخدم المصرح له يبدأ:

```text
Integrations
  → Meta
  → Add Connection
```

الواجهة تعرض الطريقة المناسبة مثل OAuth أو credential flow المدعوم.

بعد الاتصال يجب أن تستطيع المنصة، حسب صلاحيات الـAPI:

- عرض Accounts/Pages المتاحة.
- اختيار الموارد المطلوبة.
- اكتشاف Forms.
- عرض Connection status.
- عرض Webhook/subscription status.
- Test connection.

---

# 11. Meta Webhook Setup

إذا كان استقبال Leads يعتمد Webhook:

المنصة يجب أن:

- تنشئ/تعرض Webhook endpoint المناسب.
- تعرض Verification information المطلوبة.
- تحاول تنفيذ subscription عبر API إذا كان ذلك مدعوماً ومناسباً.
- إذا تطلب Meta خطوة يدوية، تعرض تعليمات دقيقة.
- توفر Verify/Test button.
- تعرض آخر Incoming event.
- تعرض failures.

لا يتطلب Setup تعديل backend code بعد deployment.

---

# 12. Meta Campaign/Form Binding

داخل Campaign setup يستطيع المستخدم:

- اختيار Meta Connection.
- اختيار Page.
- اختيار Form/Campaign المناسب.
- ربطه بالـCampaign الداخلية.
- إعداد Field Mapping.
- Review source metadata.
- Activate binding.

يجب دعم أكثر من External Form/Reference إذا احتاجت Campaign ذلك.

---

## Binding Conflict Validation

قبل تفعيل Binding يجب أن تتحقق المنصة من عدم وجود Active bindings متعارضة لنفس External source context.

إذا كان Form واحد مستخدماً في أكثر من Campaign خارجية، يجب استخدام External campaign/ad context المتاح أو Rule صريحة؛ لا يتم ربط Lead بحملة داخلية عشوائياً.

---

# 13. Meta Lead Flow

```text
Meta Form Submission
    ↓
Webhook / API Intake
    ↓
Validate Connection/Event
    ↓
Preserve Source Submission
    ↓
Resolve Campaign Binding
    ↓
Contact Match/Create
    ↓
Lead Create
    ↓
Field Mapping
    ↓
Branch
    ↓
Routing
    ↓
AI/Messaging flow when enabled
```

---

# 14. Meta Source Information

يجب الحفاظ على المعلومات المتاحة مثل:

- Page.
- Campaign.
- Ad Set.
- Ad.
- Form.
- Source timestamps.
- External IDs.
- Connection.

---

# 15. Meta Form Mapping UI

واجهة Mapping يجب أن تعرض:

```text
Source Field → Platform Field
```

وتدعم:

- Auto-suggest mapping.
- Manual mapping.
- Data type warnings.
- Required field warnings.
- Preview.
- Save.
- Reprocess rules حسب ما يسمح المنتج.

---

# 16. Historical Meta Leads

عند دعم historical sync:

- اختيار Connection/resource.
- تحديد range/options إذا كان المزود يسمح.
- Preview أو summary.
- deduplication.
- preserve original timestamps.
- progress state.
- result report.

---

# 17. Meta Failure Handling

إذا فشل:

- لا تحذف البيانات السابقة.
- سجل failure.
- اعرض status.
- وفر retry/resync.
- لا تعطل بقية المنصة.
- ضع unmatched/unprocessed items في حالة واضحة عند الحاجة.

---

# 18. Messaging Integration

Messaging ليست فقط Notifications.

تستخدم من أجل:

- Customer-facing Lead conversations.
- AI Lead Assistant.
- Human Agent replies.
- Approved follow-ups.
- Internal notifications حسب الاستخدام.

المنصة تبقى Lead Operations Platform وليست Chat platform عامة.

---

# 19. Messaging Provider Independence

المسار الوظيفي:

```text
Platform Conversation
    ↓
Messaging Provider Adapter
    ↓
Business Sender / Channel
    ↓
Lead
```

Core Conversation لا تعتمد على Provider محدد.

---

# 20. Messaging Connection Setup

من داخل:

```text
Integrations
  → Messaging
  → Add Connection
```

الواجهة يجب أن تعرض حسب Provider:

- Provider name.
- Connection method.
- Account/business prerequisites.
- API/OAuth credentials.
- Sender/number selection or configuration.
- Webhook/callback setup.
- Test inbound.
- Test outbound.
- Status.
- Last error.

---

# 21. Messaging Sender / Number

يجب دعم أكثر من Sender/Number، مع فصل واضح بين Provider Connection/Credentials وبين Business Sender identity عندما يميز Provider بينهما.

النموذج النهائي:

```text
Organization Shared Sender (اختياري)
        ↓
Branch Default Sender
        ↓
Campaign Sender Override (اختياري)
        ↓
Conversation Resolved/Pinned Sender
```

يمكن ربط Sender بـ:

- Organization.
- Branch.
- Campaign.
- Brand/use case.

القواعد:

- لا يجب افتراض Number واحدة للنظام كله.
- Branch يمكن أن يحدد Default Sender.
- Campaign ترث Branch Default ما لم تحدد Override صالحاً.
- Dedicated Number لكل Campaign اختيارية وليست شرطاً.
- Shared Organization Sender يحتاج Binding صريح للـBranches المسموحة.
- Existing Conversation لا تنتقل عشوائياً إلى Sender آخر.
- الواجهة تعرض Health/Capabilities وProvider quality/throughput/limit metadata عندما يوفرها المزود.
- لا تصمم UX يوحي بأن إضافة الأرقام هدفها تجاوز Provider limits.

---

# 22. Agent Messaging Experience

Agent:

- لا يدخل Provider API key.
- لا يربط Business Account.
- لا يستخدم رقم شخصي للتواصل مع Leads كجزء من التدفق الأساسي.
- يفتح Lead/Conversation داخل المنصة.
- يرى History المسموحة.
- يكتب Reply.
- المنصة ترسل عبر Messaging Connection المناسبة.

---

# 23. Conversation Routing & Access

كل Conversation مرتبطة بـLead.

الوصول يتبع:

- Branch.
- Lead access.
- Lead ownership.
- permissions.

Agent لا يرى Conversations الخاصة بـAgents آخرين إذا لم يملك صلاحية عليها.

بعد Reassignment يجب أن تنتقل Active access للAgent الجديد، ويخسر Agent السابق الوصول إلا إذا كانت له Permission أخرى.

---

# 24. Conversation UI

يجب أن تعرض:

- Lead identity.
- Campaign.
- Assigned Agent.
- Current Controller: AI/Human.
- Conversation state.
- Messages chronological.
- Sender identity.
- Delivery status.
- Attachments when supported.
- Handoff events.
- AI summary.
- Reply composer when permitted.

---

# 25. Inbound Message Flow

```text
Lead sends message
    ↓
Provider webhook
    ↓
Verify authenticity + deduplicate/idempotency
    ↓
Persist raw Integration Event / inbound event safely
    ↓
Resolve Messaging Connection + Business Sender
    ↓
Use provider thread/reference when available
    ↓
Resolve Contact
    ↓
Resolve Active Conversation / Lead / Campaign deterministically
    ↓
Persist/attach Message or mark Unmatched/Needs Attention
    ↓
Apply Conversation Controller rules
    ↓
AI or Human workflow
```

Resolution signals تشمل:

- exact Connection/Sender.
- provider thread/conversation reference.
- participant identity.
- existing active Conversation.
- Contact.
- active Lead(s).
- Campaign context.
- external/source references.

إذا تعذر Resolve أو بقي أكثر من Candidate صالح:

- لا تفقد الرسالة.
- سجلها كUnmatched/Needs Attention.
- لا تربطها عشوائياً.
- لا تجعل AI يخمن Campaign من نص الرسالة وحده كقرار حاسم.
- وفر Review/resolution action للمستخدم المصرح له.

---

# 26. Outbound Message Flow

```text
AI / Human / Automation send request
    ↓
Authorization + Conversation Controller check
    ↓
Resolve Sender deterministically
    ↓
Central Messaging Policy
    ↓
Persist Outbound Message / Send Intent as Queued with idempotency context
    ↓
Queue / Provider capability / health / rate checks
    ↓
Provider send
    ↓
Persist provider reference + delivery state
    ↓
Track delivery callbacks
```

Sender resolution:

- Existing Conversation ذات Pinned Sender/Thread تستخدمه إذا كان صالحاً. إذا أصبح غير صالح، يتم Block/Needs Attention أو Explicit migration workflow؛ لا يتم التحويل تلقائياً إلى Sender آخر.
- New Conversation بلا Pinned Sender تستخدم: Campaign Sender Override → Branch Default Sender → Organization Shared Fallback المسموح صراحة → وإلا Block/Needs Attention.

Central Messaging Policy تتحقق من Consent/DNC وTemplates وSending hours/timezone وCampaign max attempts/frequency وSender scope/health وProvider constraints وCurrent Controller وIdempotency.

---

# 27. Human Handoff UI

عند Handoff يجب أن يظهر للAgent:

- reason.
- AI summary.
- qualification data.
- full conversation.
- campaign context.
- suggested next action.

وعند قبول Human control:

- AI auto-send يتوقف.
- reply composer يصبح للHuman.
- AI Copilot يبقى متاحاً إذا كان مفعلاً.

---

# 28. Messaging Delivery Status

عند توفره:

- Queued.
- Sent.
- Delivered.
- Read.
- Failed.

يجب عرض failure بوضوح بدون كشف معلومات حساسة.

---

## Messaging Consent & Policy UI

يجب أن يكون من الممكن، حسب القناة/المتطلبات:

- رؤية Contactability / consent state.
- تسجيل source/time للحالة.
- منع الإرسال عند Do-not-contact.
- إدارة Provider templates عندما تكون مطلوبة.
- رؤية template approval/status.
- ضبط Branch/Campaign sending hours.
- ضبط Campaign frequency/max-attempt rules.
- رؤية Branch Default Sender وCampaign Override والEffective Sender.
- رؤية Connection/Sender health.
- رؤية Provider quality/throughput/limit metadata عندما تكون متاحة.
- إظهار سبب منع Message قبل الإرسال.

لا يتم hardcode قواعد Provider واحدة داخل Core Conversation UI، ولا يتم hardcode أرقام Limits متغيرة كBusiness constants.

---

# 29. Messaging Failure Handling

إذا فشل الإرسال:

- Message تبقى مسجلة.
- status = failed.
- retry ممكن حسب policy.
- Agent/Manager يرى السبب المناسب.
- Lead/Assignment لا يتراجع.
- AI لا يفترض أن الرسالة وصلت.

---

# 30. Internal Notifications over Messaging

يمكن استخدام WhatsApp/Messaging أيضاً لإشعارات Agents.

لكن يجب الفصل بين:

- Customer Conversation.
- Internal Notification.

حتى لو استخدما نفس Provider.

---

# 31. Email Integration

Email يمكن أن يستخدم:

- Notifications.
- Future customer messaging use cases إذا أضيفت لاحقاً.

Setup من الواجهة حسب نفس Standard Integration UX.

---

# 32. Payment Integrations

يجب دعم عدة Payment Providers/Connections.

كل Branch قد يملك:

- Provider واحد.
- أكثر من Method.
- Accounts مختلفة.

---

# 33. Payment Provider Setup

من داخل:

```text
Integrations / Payments
  → Add Provider Connection
```

الواجهة تعرض:

- Provider.
- prerequisites.
- authentication/credentials.
- webhook/callback information.
- Test Connection.
- supported currencies/options عند الحاجة.
- status.

---

# 34. Payment Method Configuration

بعد Connection يمكن إنشاء Payment Method:

- Display name.
- Branch.
- Provider Connection.
- Currency/availability.
- Active/inactive.
- Agent availability rules.

لا تعرض secrets للAgent.

---

# 35. Payment Link Flow

```text
Lead
    ↓
Authorized user/action
    ↓
Payment Method
    ↓
Provider API
    ↓
Payment Link
    ↓
Customer
```

---

# 36. Payment Confirmation

```text
Provider trusted webhook/event
    ↓
Verify authenticity + idempotency
    ↓
Persist Payment/Integration Event
    ↓
Resolve Payment
    ↓
Apply state transition transactionally
    ↓
Mark Confirmed
    ↓
Enrollment according to trusted Business Rule
    ↓
Activity / Notifications / Analytics
```

Success page وحدها لا تكفي.

---

# 37. Payment Failure Handling

إذا فشل:

- لا يتم Mark paid.
- لا يتم Enrollment.
- failure يظهر.
- يمكن إنشاء Link جديد حسب rule.
- Lead data تبقى.

---

# 38. Payment Scope

خارج النطاق:

- Installments.
- Payment Plans.
- Refund workflows.
- Accounting.
- Ledger.

---

# 39. Google Sheets

تكامل مساعد لـ:

- Import.
- Export.

ليست primary database.

Continuous two-way synchronization **ليس متطلباً افتراضياً** ما لم تتم إضافة قواعد واضحة لاحقاً لـ:

- conflict resolution.
- deletion behavior.
- update direction.
- scheduling.
- ownership.

لا يجوز لـCodex اختراع Sync ثنائي عام من نفسه.

Setup من داخل المنصة.

---

# 40. Google Sheets Import Flow

```text
Connect Google
  ↓
Select Sheet
  ↓
Select worksheet/range
  ↓
Map Fields
  ↓
Validate
  ↓
Preview
  ↓
Duplicate Review
  ↓
Import
  ↓
Result
```

---

# 41. Generic API / Webhook Lead Sources

يجب أن يسمح التصميم بإضافة Lead Source عام.

يمكن أن توفر الواجهة:

- Create Source Connection.
- Generate endpoint/API credentials.
- Webhook secret.
- Sample payload/schema guidance.
- Field mapping.
- Test event.
- Status/logs.

لا يجب إنشاء Lead pipeline منفصل لكل Source جديد.

---

# 42. AI Provider Integration

AI Provider Connection يتم إعداده من داخل المنصة للمستخدم المصرح له.

يمكن أن تشمل:

- Provider.
- Credential/API connection.
- Connection test.
- Available/configured model profiles.
- Status.
- Scope.
- Cost/usage metadata إذا تم دعمها لاحقاً.

لا يتم ربط المنتج بحساب المطور الشخصي.

---

# 43. AI Model/Profile UI

يجب أن تسمح المنصة بإدارة configuration بدون hardcoding اسم model في Business Logic.

يمكن تعريف Profiles مثل:

- Conversation.
- Summarization.
- Classification.
- Analysis.

يمكن استخدام نفس model خلف عدة profiles.

---

# 44. AI Lead Assistant Configuration UI

داخل Campaign:

```text
Campaign
  → AI
```

يمكن إدارة:

- Enabled/disabled.
- Effective Configuration Preview: Global AI Guardrails → Branch AI Defaults → Campaign AI Configuration/Overrides.
- Provider/model profile.
- Knowledge.
- Qualification.
- Handoff rules.
- Follow-up policy.
- Allowed assets.
- Language/tone.
- Messaging connection / Effective Sender / optional Campaign Sender Override.
- Test/simulation.
- Publish/activate.

---

# 45. Campaign Knowledge UI

يجب دعم:

- Draft editor.
- Structured sections.
- FAQs.
- Facts.
- Prices.
- Locations.
- Requirements.
- Approved links.
- File attachments/assets.
- Allowed claims.
- Prohibited claims.
- Preview.
- Publish.
- Version history.

AI يستخدم Published version فقط.

---

# 46. Qualification UI

المستخدم يستطيع:

- Add question.
- Map question to Platform Field.
- Set required/optional.
- Set order.
- Define completion condition.
- Define handoff trigger.
- Preview.

---

# 47. AI Follow-up Policy UI

يمكن إدارة:

- enabled/disabled.
- initial response timing.
- follow-up delays.
- max attempts.
- allowed sending hours.
- stop on reply.
- stop on handoff.
- stop on closed.
- final status/action.

---

# 48. AI Operations Assistant UI

واجهة داخلية يمكن أن تسمح للمستخدم بكتابة أسئلة مثل:

- كم Lead وصل اليوم؟
- أي Leads بدون Follow-up؟
- ما أكثر الأسئلة تكراراً؟
- اعطيني ملخص حملة.
- ما Leads التي تحتاج attention؟

الإجابة يجب أن تحترم Scope المستخدم.

---

# 49. AI Facts UI

إذا كانت الإجابة تعتمد على Metrics:

- يجب أن تكون مبنية على Platform query.
- يمكن إظهار filters/time range المستخدمة.
- يمكن توفير drill-down إلى Leads عند الحاجة.

---

# 50. AI Failure Handling

إذا AI غير متاح:

- Customer message لا تضيع.
- يمكن handoff للHuman.
- Core lead operations تستمر.
- يظهر status.
- retry/fallback حسب policy.

---

# 51. Integration History

يجب تتبع أحداث مهمة مثل:

- Connection created.
- Connection updated.
- Auth expired.
- Sync started/completed/failed.
- Webhook received/failed.
- Provider error.
- AI connection changed.
- Knowledge published.
- Payment event.

---

# 52. Integration Permissions

## Super Admin

يدير كل Connections.

## Manager

يدير Branch-scoped Connections الخاصة بفرعه.

إذا استخدم Branch Connection مشتركة على مستوى Organization:

- يستطيع Manager ربطها واستخدامها داخل Branch إذا أتاحها Super Admin.
- لا يرى Credentials الخاصة بها.
- لا يغير Organization scope.

## Agent

لا يدير Integration configuration.

---

# 53. Data Flow Summary

## Meta

```text
Meta → Platform Intake → Campaign → Branch → Lead → Agent/AI
```

## Customer Messaging

```text
Lead
  ↔ Messaging Provider
  ↔ Resolved Business Sender
  ↔ Central Messaging Policy
  ↔ Platform Conversation
  ↔ AI/Human
```

## Internal Notification

```text
Platform Event → Notification Service → Channel → User
```

## Payment

```text
Lead → Payment Link → Provider → Trusted Confirmation → Platform → Enrollment
```

## Google Sheets

```text
Sheet → Platform Import
Platform → Sheet/Export Output
```

هذا يلخص Import/Export فقط؛ لا يعني Continuous two-way synchronization افتراضي.

## AI

```text
Platform Context
  → Approved AI Provider
  → Tool Requests / Language Output
  → Platform Authorization/Services
  → Result
```

---

# PART B — UI & UX REQUIREMENTS

# 54. General UX Principles

الواجهة يجب أن تكون:

- واضحة.
- بسيطة.
- عملية.
- قليلة الخطوات.
- مناسبة للمستخدم غير التقني.
- Responsive.
- Role-aware.
- Permission-aware.

الإدارة تحصل على مرونة أكبر.

Agent يحصل على تجربة تشغيلية بسيطة.

---

## Authentication UX

يجب أن يوجد:

- Login.
- Logout.
- Forgot/Reset credential flow.
- Secure initial setup/bootstrap UX أو deployment bootstrap path لأول Super Admin، مرة واحدة فقط وبدون Default Password ثابت.
- Clear disabled/invalid account state.
- Safe expired-session handling without losing unsaved work where practical.

---

# 55. Global Navigation

## Super Admin

- Dashboard.
- Leads.
- Contacts.
- Branches.
- Users.
- Campaigns.
- Conversations.
- Fields.
- Routing.
- Payments.
- Enrollments.
- Analytics.
- Automations.
- AI.
- Integrations.
- Audit Logs.
- Settings.

## Manager

- Dashboard.
- Leads.
- Contacts.
- Agents.
- Campaigns.
- Conversations.
- Fields.
- Routing.
- Payments.
- Enrollments.
- Analytics.
- Automations.
- AI.
- Integrations (Branch-scoped / shared connections المسموحة).
- Notifications.
- Settings.

## Agent

- Dashboard.
- My Leads.
- My Conversations.
- Follow-ups.
- AI Copilot.
- Notifications.
- Profile.

Navigation الفعلي يتكيف مع permissions.

---

# 56. Super Admin Dashboard

يمكن أن يعرض:

- Total Leads.
- New Leads.
- Leads by Branch.
- Campaign performance.
- Agent performance.
- Conversations needing attention.
- AI handoffs.
- Payments.
- Enrollments.
- Conversion.
- Revenue.
- Follow-ups.
- Integration alerts.
- System alerts.

---

# 57. Manager Dashboard

يمكن أن يعرض:

- Branch Leads.
- New/Unassigned.
- Agent workload.
- Follow-ups.
- Conversations needing human response.
- AI handoffs.
- Payment pending.
- Enrollments.
- Campaign performance.
- Integration alerts ضمن scope.

---

# 58. Agent Dashboard

يركز على:

- New assigned Leads.
- My active Leads.
- Conversations needing reply.
- AI handoffs.
- Follow-ups due.
- Overdue.
- Payment pending.
- Priority Leads عندما توفر تعريف/Field مناسب.
- Personal performance المبني على Human Agent metrics.
- Recently updated.

---

# 59. Campaign Management Screen

تحتوي Sections/Tabs مثل:

- Overview.
- Source.
- Branch & Agents.
- Routing.
- Fields.
- Mapping.
- Messaging بما فيها Branch Default Sender والCampaign Override والEffective Sender.
- AI بما فيها Effective inherited configuration.
- Qualification.
- Follow-up policy.
- Automations.
- Payments.
- Analytics / Conversion definition.
- Status/Activation.

---

## Routing UI

Routing configuration يجب أن تسمح حسب Method بـ:

- Eligible Agents.
- Weights للWeighted.
- Capacity behavior.
- Working-hours behavior.
- Performance policy/status.
- Performance metrics + weights.
- Lookback window / minimum sample.
- Fallback when no score/no eligible agent.

ويجب تمييز Human Agent performance metrics عن AI metrics.

---

## Closed Lead / Returning Contact Policy

ضمن Campaign Messaging settings يجب أن يكون واضحاً ماذا يحدث عندما يرسل Contact رسالة على Conversation مرتبطة بـLead مغلقة:

- Reopen Lead.
- Send to review/attention queue.
- Create new Lead فقط إذا كانت Rule صريحة وتوجد معلومات كافية.

لا يتم إنشاء Lead جديدة عشوائياً من مجرد inbound message.

---

# 60. Campaign Setup Wizard

المسار:

```text
Create Campaign
  → Basic Info
  → Source
  → Branch
  → Agents
  → Routing
  → Fields
  → Mapping
  → Messaging
  → AI (optional)
  → Qualification
  → Follow-up
  → Automations
  → Review
  → Activate
```

يمكن تخطي Steps غير المفعلة وظيفياً.

---

# 61. Campaign Readiness Checklist

قبل Activation تظهر Checklist مثل:

- Source connected?
- Branch selected?
- Routing valid?
- Required fields mapped?
- Messaging configured if required?
- A valid/healthy Sender resolves through Conversation/Campaign/Branch rules?
- Campaign Sender Override is within allowed scope if configured?
- AI provider available if AI enabled?
- Published knowledge available?
- Qualification mapping valid?
- Payment method ready if required?

---

# 62. Field Builder

يدعم:

- Add/Edit/Disable.
- Reorder.
- Type.
- Add/Edit/Reorder Options.
- Required.
- Visible.
- Editable.
- Table.
- Details.
- Filters.
- Automation.
- AI qualification mapping.
- Calculated fields.
- Column/display settings المناسبة عندما يكون ذلك مفيداً.

---

# 63. Lead List

تدعم:

- Search.
- Filters.
- Sorting.
- Saved Views.
- Column selection.
- Bulk selection/actions.

الأعمدة حسب Campaign + permissions.

---

# 64. Lead Details

يجب أن تجمع:

- Contact.
- Source.
- Campaign.
- Dynamic fields.
- Assignment.
- Conversation.
- AI summary.
- Follow-ups.
- Payment.
- Enrollment.
- Activity.
- Actions.

---

## Agent Lead Editing

من Lead Details يستطيع Agent ضمن الصلاحيات:

- تحديث Editable Fields.
- تحديث Campaign Status إذا كانت Campaign تستخدم Status وكان Field قابلاً للتعديل له.
- تسجيل نتيجة التواصل.
- إضافة Note داخلية.
- إنشاء/إكمال Follow-up.
- استخدام Payment actions المسموحة.

## Lead Status Editing

Status ليس إلزامياً لكل Campaign.

إذا كان موجوداً:

- يظهر بطريقة واضحة وسريعة.
- القيم تأتي من Campaign Field configuration.
- Agent يرى/يعدّل فقط ما تسمح به Field permissions.
- تغيير Status يسجل في التاريخ عند الحاجة.

---

## Lead Lifecycle Controls

Lead Details يجب أن تعرض Internal Lifecycle State بشكل منفصل عن Campaign Status.

Authorized users يمكن أن يروا Actions مثل:

- Close Lead.
- Reopen Lead.
- Archive حسب الصلاحية/الـworkflow.

يجب توضيح أن تغيير Campaign Status لا يعني تلقائياً Close للـLead إلا إذا وجدت Automation/Rule واضحة.

---

# 65. Conversation Panel

داخل Lead Details أو Screen مخصصة:

- messages.
- inbound/outbound distinction.
- AI/Human badges.
- timestamps.
- delivery state.
- current controller type.
- current Human Controller user عندما يكون HUMAN.
- handoff state.
- Takeover action للمخولين.
- reply composer فقط عندما يملك المستخدم Active control.
- attachments.
- AI Copilot controls.

---

# 66. AI Summary Panel

يمكن أن يعرض:

- qualification summary.
- captured structured data.
- customer intent/needs.
- unanswered question.
- handoff reason.
- suggested next action.

يجب تمييز AI-generated content بصرياً.

---

# 67. AI Copilot Actions

للAgent:

- Summarize.
- Suggest reply.
- What should I ask next?
- Show campaign knowledge.
- Draft follow-up.
- Explain conversation.

الإرسال للعميل يبقى Human action عندما Controller = HUMAN.

---

# 68. Follow-up UI

- Create.
- Edit.
- Complete.
- Cancel.
- Reschedule.
- Upcoming/Due/Overdue.

---

# 69. Payment UI

## Admin/Manager

- Methods.
- Provider connection.
- availability.
- status.

## Agent

- Create/use payment link حسب الصلاحية.
- view payment status.
- copy/share link.

---

# 70. Enrollment UI

تعرض:

- status.
- date.
- linked payment.
- source of confirmation.

---

# 71. Notification Center

يعرض:

- New Lead.
- Assignment.
- Reassignment.
- Follow-up.
- AI handoff.
- Conversation needing attention.
- Payment.
- Enrollment.
- Integration/System alerts.

---

# 72. Analytics UI

Filters:

- Date.
- Branch.
- Campaign.
- Agent.
- Source.
- Conversation state.
- AI/Human.
- relevant custom fields.

Communication metrics يجب أن تعرض بشكل منفصل عند الحاجة:

- First AI Contact.
- First Human Contact.
- First Customer Response.
- AI Attempts.
- Human Attempts.
- AI Response Time.
- Human Agent Response Time.
- AI Qualified / Human Qualified source.

لا يجوز عرض AI response time كAgent response time.

---

## Conversion Configuration UI

Campaign settings يجب أن تسمح بتحديد Conversion milestone من الخيارات المناسبة لبياناتها.

Analytics تعرض تعريف الـConversion المستخدم حتى يفهم المستخدم معنى النسبة.

---

## Revenue Currency UI

عندما تحتوي النتائج على أكثر من Currency:

- تعرض totals منفصلة حسب Currency.
- لا تعرض Total موحد مضلل.
- إذا تم دعم Reporting Currency، يجب إظهار العملة وطريقة/وقت التحويل بشكل مفهوم.

---

# 73. Analytics Drill-down

Metric يمكن أن يفتح filtered Lead List.

---

# 74. Automation UI

واضح:

```text
Trigger
  ↓
Conditions
  ↓
Actions
```

مع validation وتحذير من loops.

---

# 75. AI Operations UI

يمكن أن تكون:

- global assistant screen.
- contextual assistant داخل Campaign/Lead/Analytics.

يجب أن تبقى الإجابات permission-scoped.

---

# 76. Integration Management UI

صفحة Integrations تعرض Cards/List:

- Provider.
- Connection name.
- Scope.
- Connected/Disconnected.
- Health.
- Last activity.
- Last sync.
- Last error.
- Required action.

Actions:

- Add Connection.
- Open.
- Test.
- Reconnect.
- Edit.
- Disable.
- View history.

---

# 77. Integration Setup Wizard UX

كل Wizard يجب أن:

- يشرح المصطلحات.
- لا يفترض خبرة تقنية.
- يستخدم step-by-step.
- يعرض Copy buttons.
- يعرض validation.
- يمنع Save invalid config.
- يحافظ على entered data عند recoverable errors.
- يوضح الفرق بين provider-side step وplatform-side step.
- ينتهي بـTest Connection/Success state.

---

# 78. Meta Management UI

تعرض:

- Connections.
- Pages.
- Forms.
- Campaign bindings.
- Webhook status.
- Last lead received.
- Sync/import.
- Mapping.
- Errors.

---

# 79. Messaging Management UI

تعرض:

- Provider connections.
- الفرق بين Provider Connection وBusiness Sender identity عندما يميز Provider بينهما.
- Business senders/numbers.
- Organization/Branch/Campaign bindings.
- Branch Default Sender.
- Campaign Sender Overrides.
- Scope.
- Inbound webhook status.
- Outbound test.
- Templates عند الحاجة.
- Delivery callbacks.
- Connection/Sender health.
- Provider quality/throughput/limit metadata عندما تتوفر.
- Queue/backpressure/blocked-send indicators عند الحاجة.
- Unmatched / Needs Attention inbound queue.
- Resolution action للمستخدم المصرح له مع Candidate context وAudit، بدون كشف Leads خارج Scope.
- Errors.

---

# 80. AI Management UI

تعرض:

- AI Provider Connections.
- Model/Profile configurations.
- Assistants.
- Global AI Guardrails summary.
- Branch AI Defaults.
- Campaign AI configurations.
- Effective inherited/overridden configuration عند الحاجة.
- Usage/status metadata عند توفرها.
- Knowledge versions.
- Evaluation/test tools.

---

# 81. Payment Management UI

تعرض:

- Provider connections.
- Branch methods.
- status.
- webhook status.
- last payment event.
- errors.

---

# 82. Agent Profile

Agent يدير فقط المعلومات الشخصية/التشغيلية المسموحة مثل:

- Name.
- Phone.
- Notification preferences.

لا يوجد Provider/API setup للAgent.

---

# 83. Empty States

كل Screen رئيسية توضح:

- ما الذي يعنيه Empty State.
- ما الخطوة التالية.
- CTA مناسب.

مثال Integrations:

> لا يوجد Meta Connection بعد → Add Connection.

---

# 84. Loading States

مطلوبة لـ:

- Sync.
- Import.
- AI operations.
- Analytics.
- Provider tests.
- Payment.
- historical fetch.

---

# 85. Error States

يجب:

- شرح الخطأ بلغة مفهومة.
- عدم عرض secrets.
- عرض next action.
- الحفاظ على user input.
- توفير retry عندما يكون مناسباً.

---

# 86. Permission States

إذا Action غير مسموحة:

- لا تظهر كمتاحة بشكل مضلل.
- لا يتم كشف hidden data.
- direct URL/API access يبقى ممنوعاً.

---

# 87. Responsive Design

يدعم:

- Desktop.
- Tablet.
- Mobile.

الأولوية التشغيلية للAgent على الهاتف.

---

# 88. Arabic RTL

كل:

- Navigation.
- Tables.
- Forms.
- Filters.
- Modals.
- Conversation UI.
- AI panels.

تدعم RTL.

---

# 89. French & English

LTR مع responsive layouts.

---

# 90. Date & Time

يجب عرض:

- Lead received.
- Message times.
- First contact.
- Last contact.
- Payment.
- Follow-up.
- Handoff.

بسياق زمني واضح.

قواعد الزمن:

- احفظ timestamps كـunambiguous instants بطريقة مناسبة للـStack، مع الحفاظ على provider/source timestamp الأصلي عند الحاجة للتتبع.
- العرض يستخدم User/Branch locale/timezone المناسب.
- Scheduled messaging/follow-ups تستخدم Campaign timezone override إن وجد، وإلا Branch timezone.
- Date-based Analytics/Filters يجب أن يكون لها timezone semantics واضحة حتى لا تختلف النتائج بصمت عند حدود اليوم.
- التعامل مع DST يجب ألا يسبب إرسالاً مكرراً أو موعداً مفقوداً.

لا تفقد original timestamps.

---

# 91. Manager Experience

Manager يجب أن يستطيع تشغيل Branch يومياً من داخل المنصة:

```text
Integrations
  → Campaigns
  → Agents
  → Routing
  → Fields
  → Messaging
  → AI
  → Leads
  → Conversations
  → Follow-ups
  → Payments
  → Enrollment
  → Analytics
```

---

# 92. Agent Experience

```text
Assigned Lead
  → Open Lead
  → Read AI/Conversation context
  → Reply
  → Update
  → Follow-up
  → Payment
  → Enrollment
```

بدون أي Provider setup.

---

# 93. Product Boundary

المنصة ليست:

- General WhatsApp CRM.
- General chat system.
- Customer support suite.
- Full accounting.
- LMS.
- ERP.

لكن Conversations/Messaging الضرورية لدورة Lead جزء أساسي من المنتج.

---

# 94. Search & Filters UI

Search يجب أن يدعم حسب الصلاحيات:

- Name.
- Phone.
- Email.
- Lead ID.
- Campaign.
- Agent.
- Permitted custom fields.

Filters يمكن أن تشمل:

- Branch.
- Campaign.
- Agent.
- Date.
- Source.
- Payment.
- Enrollment.
- Conversation state.
- AI/Human controller.
- Status عند توفره.
- Interest عند توفره.
- Tags عند توفرها.
- Custom fields.

لا يجب أن تصبح Search أو Filters وسيلة لكشف Field أو Lead غير مسموح بها.

---

# 95. Saved Views UI

المستخدم يستطيع:

1. اختيار Filters.
2. اختيار Sorting.
3. اختيار Columns.
4. حفظ View.
5. إعادة استخدامها لاحقاً.

Saved View تبقى محكومة بالصلاحيات الحالية حتى لو تغيرت صلاحيات المستخدم بعد إنشائها.

---

# 96. Bulk Actions UI

يمكن تحديد Leads متعددة ثم تنفيذ Actions مسموحة مثل:

- Assign.
- Change Field.
- Change Status.
- Add Tag.
- Remove Tag.
- Create Follow-up.
- Export.

الإجراءات الحساسة أو واسعة النطاق تحتاج Confirmation واضحة.

---

# 97. Import UI

المسار:

```text
Upload / Select Source
  → Select Branch
  → Select Campaign when applicable
  → Detect
  → Map Fields
  → Validate
  → Preview
  → Duplicate Review
  → Import
  → Result
```

Branch/Campaign choices يجب أن تكون محدودة بالـScope المسموح للمستخدم.

النتيجة تعرض:

- Imported.
- Skipped.
- Invalid.
- Duplicate.
- Failed.

---

# 98. Export UI

Export يجب أن يسمح باختيار البيانات المسموحة فقط.

يمكن أن يعتمد على:

- Current filters.
- Saved View.
- Campaign.
- Branch.
- Selected columns.
- User permissions.

لا يصدر Field مخفية أو Leads غير مسموح بها.

---

# 99. Notification Preferences UI

المستخدم يمكنه إدارة Preferences التي يسمح النظام بتخصيصها مثل:

- In-App.
- Email.
- WhatsApp/Messaging.

بعض Notifications الحرجة يمكن أن تبقى إلزامية.

الإدارة يجب أن تملك شاشة/جزءاً لإدارة Notification wording/templates المسموحة حسب:

- Event.
- Channel.
- Language.
- Branch/Campaign scope عند الحاجة.

مع Preview وDefault fallback واضح.

---

## User Management UI

Super Admin يستطيع من داخل المنصة:

- Create/Invite Manager or Agent.
- Activate/Deactivate account.
- Assign Branch/Role.
- Trigger credential reset/invitation resend حسب Authentication design.
- View account status.

Manager يدير Agents داخل Branch فقط.

لا يوجد Public Signup.

## Manual Lead Creation UI

Authorized user يستطيع إنشاء Lead يدوياً من داخل المنصة مع:

- Contact match/create.
- Branch selection ضمن scope.
- Campaign selection عند الحاجة.
- Required field validation.
- Source = Manual.
- Optional assignment حسب rules.

---

# 100. Manager Agent Management

Manager يجب أن يستطيع ضمن Branch:

- Create Agent.
- Edit Agent.
- Activate / Deactivate.
- Set phone/profile information.
- Set working hours.
- Set capacity.
- Manage operational settings.
- View current workload/status.

لا يعرض له إعدادات Provider غير المسموحة.

---

## Branch Settings UI

Manager/Super Admin حسب الصلاحية يستطيعان إدارة:

- Branch timezone.
- Working/business hours.
- Default messaging hours.
- Default Messaging Sender/Number.
- Allowed Organization Shared Senders.
- Branch AI Defaults القابلة للوراثة.
- Operational defaults.

Timezone يجب أن تظهر بوضوح في أي AI follow-up أو scheduled operation.

---

# 101. Integration Setup Help Pattern

كل Setup تقني نسبياً يجب أن يملك Help واضح داخل نفس الواجهة.

يجب أن يشرح:

- ما هذه القيمة؟
- لماذا نحتاجها؟
- من أين أحصل عليها؟
- هل هي secret؟
- مثال لشكلها بدون كشف credential حقيقية.
- ماذا أفعل إذا فشل Test Connection؟
- رابط أو زر للخطوة التالية عندما يكون مناسباً.

الهدف هو أن يستطيع مستخدم إداري غير تقني إكمال Setup دون الرجوع إلى Developer في التشغيل اليومي.

---

# 102. Central Lead Experience

عند فتح Lead يجب أن يعرف المستخدم المصرح له بسرعة:

1. من هو الشخص؟
2. ماذا يريد؟
3. من أين جاء؟
4. لأي Campaign ينتمي؟
5. لأي Branch ينتمي؟
6. من هو Lead Owner؟
7. من يتحكم بالمحادثة الآن: AI أم Human؟
8. ماذا قال AI أو العميل سابقاً؟
9. ما البيانات المهمة؟
10. ماذا يجب أن يحدث الآن؟
11. هل يوجد Follow-up؟
12. هل يوجد Payment؟
13. هل أصبح Enrolled؟

---

# 103. Final Integration & UI Principle

كل Integration يجب أن تعمل حول نفس Core Domain:

```text
Lead Source
  → Campaign
  → Branch
  → Lead
  → Assignment
  → Conversation
  → AI/Human
  → Follow-up
  → Payment
  → Enrollment
  → Analytics / Automation
```

والمنصة هي مركز:

- التشغيل.
- الإعداد.
- الصلاحيات.
- المراقبة.
- التاريخ.
- الربط بين Providers.

# 104. Large-Data UX

الشاشات التي يمكن أن تحتوي عدداً كبيراً جداً من السجلات لا تعتمد على تحميل جميع النتائج.

يشمل ذلك Leads وConversations وMessages وActivities وAudit Logs وIntegration Events وPayments وAI Executions وAnalytics drill-down.

يجب دعم Server-side pagination وSearch وFilters وSorting وProgressive loading عند الحاجة.

Large imports/exports/bulk actions يجب أن تظهر كعمليات قابلة للتتبع مثل Queued / Processing / Completed / Failed، مع Progress وResult عندما يكون ذلك ممكناً.

لا يجب إبقاء واجهة المستخدم معلقة بانتظار عملية طويلة داخل Request واحد إذا كان Background processing أكثر موثوقية.
