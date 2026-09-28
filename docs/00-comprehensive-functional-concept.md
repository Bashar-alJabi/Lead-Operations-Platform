# Comprehensive Functional Concept of the Platform

# 1. تعريف المنصة

المنصة هي **نظام مركزي Production-ready لإدارة الـLeads والعمليات البيعية**.

تدير دورة الـLead كاملة من لحظة وصوله من Meta أو أي مصدر آخر، مروراً بالحملة والفرع والتوزيع والتواصل والمتابعة والدفع، وصولاً إلى Enrollment والتحليلات والأتمتة والـAI.

المنصة هي **Operational Source of Truth** للـLeads والعمليات المرتبطة بها.

الخدمات الخارجية مثل Meta وWhatsApp ومزودي الدفع والبريد والـAI هي Providers أو Sources تتكامل مع المنصة، ولا تصبح بديلاً عن الـCore Platform.

---

# 2. الهدف الرئيسي

الهدف هو جمع العملية التشغيلية في نظام واحد:

```text
Lead Source
    ↓
Lead Intake
    ↓
Campaign
    ↓
Branch
    ↓
Assignment
    ↓
AI Initial Contact / Qualification (when enabled)
    ↓
Human Agent / Follow-up
    ↓
Payment
    ↓
Enrollment
    ↓
Analytics
    ↓
Automation / AI Operations
```

---

# 3. المبادئ الأساسية

## 3.1 Platform = Source of Truth

البيانات التشغيلية الأساسية تحفظ داخل المنصة.

## 3.2 Flexible Campaign Data

لا توجد مجموعة Fields ثابتة لجميع الحملات.

## 3.3 الإدارة تتحكم في التشغيل

Super Admin وManager، ضمن صلاحياتهما، يحددان:

- Campaign setup.
- Lead sources.
- Eligible Agents.
- Routing.
- Fields.
- Visibility.
- Editability.
- Follow-up policies.
- Automations.
- AI configuration.
- Campaign knowledge.
- Messaging connection.
- Payment methods.

## 3.4 Agent يعمل ضمن النظام المجهز له

Agent لا يدير بنية النظام أو Integrations، بل يعمل على الـLeads والمحادثات والإجراءات المسموحة له.

## 3.5 External Failure Isolation

فشل Provider خارجي لا يجب أن يعطل Core Lead Operations إلا عندما تكون العملية نفسها تعتمد عليه بشكل لا يمكن تجاوزه.

## 3.6 In-Platform Setup

كل Setup تشغيلي مطلوب لتشغيل Integration أو Campaign أو AI يجب أن يكون متاحاً من داخل المنصة للمستخدم المصرح له.

لا يحتاج المستخدم التشغيلي إلى تعديل الكود أو السيرفر أو Environment Variables أو Database يدوياً.

## 3.7 Provider Independence

Core Business Logic لا يعتمد على Provider واحد ثابت.

يجب دعم تعدد Connections والحسابات والمزودين عند الحاجة.

---

## 3.8 Account Security

لا يوجد Public Signup.

المستخدمون يتم إنشاؤهم أو دعوتهم من داخل المنصة بواسطة Role مخول.

يجب أن يدعم المنتج على الأقل:

- Login.
- Credential/password reset.
- Logout.
- Session invalidation.
- منع المستخدم المعطل من الدخول.
- إدارة Account status من داخل المنصة.

---

# 4. الأدوار الرئيسية

الأدوار الأساسية:

- Super Admin
- Manager
- Agent

---

# 5. Super Admin

يمتلك أوسع صلاحية ضمن النظام.

يستطيع:

- إدارة Branches.
- إدارة Managers وAgents.
- الوصول إلى جميع Contacts وLeads.
- نقل Leads بين Branches.
- إدارة Campaigns.
- إدارة Lead Sources.
- إدارة Integrations.
- إدارة Messaging Connections.
- إدارة AI Providers وAI configurations.
- إدارة Payment Providers.
- إدارة Fields.
- إدارة Routing.
- إدارة Automations.
- الوصول إلى Analytics.
- الوصول إلى Audit Logs.
- إدارة System Settings.

---

# 6. Manager

Manager مسؤول عن Branch واحد.

يستطيع، ضمن صلاحياته:

- إدارة Agents في Branch.
- إدارة Leads في Branch.
- إعادة التعيين داخل Branch.
- إنشاء وإدارة Campaigns الخاصة بالفرع.
- ربط Campaigns بالمصادر المسموحة.
- إدارة Fields.
- إدارة Routing.
- إدارة Follow-ups.
- إدارة Payment Methods الخاصة بالفرع.
- إدارة Integrations المسموح بها ضمن Branch.
- إدارة Campaign AI configuration.
- إدارة Campaign Knowledge.
- متابعة Conversations.
- استخدام AI Operations Assistant ضمن Branch.
- الوصول إلى Branch Analytics.

لا يستطيع تجاوز Branch boundary.

---

# 7. Agent

Agent مستخدم تشغيلي.

يستطيع:

- رؤية Leads المخصصة له أو المسموح له بها.
- فتح Lead Details.
- رؤية Conversation history المسموح بها.
- الرد على Leads الخاصة به من داخل المنصة.
- رؤية رسائل AI السابقة.
- استخدام AI Copilot إذا كان مفعلاً.
- تعديل Fields المسموحة.
- تسجيل نتائج التواصل.
- إضافة Notes.
- إنشاء وإكمال Follow-ups.
- استخدام Payment Link حسب الصلاحية.
- رؤية Payment وEnrollment status.
- استقبال Notifications.

لا يستطيع:

- إدارة Campaign configuration.
- إدارة Integrations.
- رؤية Credentials.
- رؤية Leads أو Conversations غير المسموح بها.
- تجاوز Branch/ownership rules.

---

# 8. Branches

الهيكل:

```text
Organization
  ↓
Branches
  ↓
Managers / Agents
  ↓
Campaigns / Leads
```

لكل Branch يمكن أن يوجد:

- Manager.
- Agents.
- Campaigns.
- Leads.
- Routing configuration.
- Integration connections أو bindings.
- Messaging connections.
- Payment methods.
- Automations.
- Analytics.

---

# 9. Contact وLead

## Contact

الشخص نفسه.

## Lead

فرصة أو طلب محدد مرتبط بالشخص.

يمكن أن يكون للشخص نفسه Leads متعددة.

وجود Contact سابق لا يعني حذف Lead جديدة أو دمجها تلقائياً.

---

## Contact Matching

يجب أن تكون عملية المطابقة deterministic وقابلة للتتبع.

المبادئ:

- تطبيع رقم الهاتف إلى صيغة canonical قدر الإمكان قبل المقارنة.
- يمكن استخدام Email أو External identifiers كإشارات إضافية.
- لا يتم merge تلقائي إذا كانت المطابقة ambiguous.
- إذا وجد أكثر من Candidate مناسب، توضع الحالة للمراجعة أو تستخدم قاعدة واضحة بدلاً من التخمين.
- Contact matching لا يعني Lead merging.

---

# 10. Lead Sources

مصادر الـLeads تشمل:

- Meta.
- Manual Entry.
- CSV.
- Excel.
- Google Sheets.
- Generic API.
- Generic Webhook.
- Future sources.

Meta مصدر أساسي، لكن النظام لا يعتمد عليه حصراً.

---

# 11. Campaign Concept

Campaign داخل المنصة هي **وحدة تشغيلية** تحدد كيف تتم إدارة Leads المرتبطة بها.

يمكن أن تحدد:

- Branch.
- Source connection.
- External campaign/form bindings.
- Eligible Agents.
- Routing.
- Fields.
- Visibility.
- Editability.
- Automations.
- Messaging channel.
- AI enabled/disabled.
- AI knowledge.
- Qualification questions.
- Handoff rules.
- Follow-up policy.
- Payment availability.
- Conversion milestone/definition عند استخدام Conversion analytics.

---

# 12. Campaign Setup Workflow

المسار المفاهيمي:

```text
Create Campaign
    ↓
Select Branch
    ↓
Connect / Select Lead Source
    ↓
Bind External Form/Campaign
    ↓
Configure Fields & Mapping
    ↓
Configure Eligible Agents
    ↓
Configure Routing
    ↓
Configure Messaging Channel
    ↓
Configure AI (optional)
    ↓
Configure Follow-up / Automation
    ↓
Review
    ↓
Activate
```

يجب أن توضح المنصة ما الذي ينقص قبل Activation.

---

# 13. Meta Integration

الإعلانات والنماذج يمكن أن تُنشأ وتدار على Meta.

من داخل المنصة يستطيع المستخدم المصرح له:

- Connect Meta account.
- اختيار Account/Page.
- اكتشاف أو اختيار Forms/Campaigns المتاحة.
- ربط Form/Campaign بـCampaign داخل المنصة.
- إعداد Field Mapping.
- رؤية Webhook/connection status.
- Test connection.
- إعادة الربط عند الحاجة.

إذا كان Meta يتطلب خطوة خارجية لا يمكن تنفيذها عبر API، تعرض المنصة تعليمات دقيقة للمستخدم.

---

# 14. Dynamic Forms & Mapping

Source Forms قد تستخدم أسئلة مختلفة.

يجب أن تسمح المنصة بربط Source Fields بـPlatform Fields.

Source Field لا يساوي بالضرورة Platform Field.

كما يمكن إنشاء Platform Fields لا تأتي من المصدر.

---

# 15. Flexible Field System

يمكن لكل Campaign امتلاك Fields مختلفة.

يدعم النظام:

- Add/Edit/Disable Field.
- Reorder.
- Type.
- Required.
- Visible.
- Editable.
- Table visibility.
- Lead Details visibility.
- Filters.
- Automation usage.
- AI qualification usage.
- Calculated fields.
- Options.

---

# 16. Field Types

أمثلة:

- Text
- Long Text
- Number
- Phone
- Email
- Date
- Time
- Date & Time
- Single Select
- Multi Select
- Yes / No
- Status
- Interest
- Tags
- Currency
- Percentage
- Duration
- URL
- Calculated Field

النظام قابل للتوسع لأنواع أخرى.

---

# 17. Source Data vs Operational Data

## Source Data

البيانات الأصلية القادمة من المصدر.

## Operational Data

البيانات التي يتم إدارتها داخل المنصة.

تعديل Operational Data لا يمحو Source Data الأصلية.

---

# 18. Campaign-Specific Fields

Campaign A وCampaign B يمكن أن تختلفا بالكامل في:

- Fields.
- Status values.
- Qualification data.
- Required data.
- Visibility.
- Editability.

لا يوجد نموذج Lead ثابت لكل الحملات.

---

# 19. Calculated Fields

أمثلة:

- First Platform Contact Time.
- First AI Contact Time.
- First Human Contact Time.
- Human Agent Response Time.
- Time Since Last Contact.
- AI Contact Attempts.
- Human Contact Attempts.
- Other derived values.

يجب ألا يكون هناك Calculated Field مبهم باسم Response Time إذا كان سيخلط AI response مع Human response.

Agent لا يعدّل Calculated Fields يدوياً.

---

# 20. Lead Details

Lead Details هي مركز التشغيل.

يجب أن تحتوي حسب الصلاحيات على:

## Contact

- Name.
- Phone.
- Email.

## Source & Campaign

- Source.
- Campaign.
- Form/Ad metadata عندما يكون مناسباً.

## Dynamic Fields

Campaign-specific data.

## Assignment

- Branch.
- Lead Owner / Agent.
- Assignment history عند الحاجة.

## Conversation

- Full permitted conversation history.
- Message sender identity.
- Message timestamps/status.
- AI/Human state.
- Handoff state.

## AI

- AI summary.
- Qualification result.
- Suggested next action.
- Copilot actions.
- Knowledge version/context عند الحاجة للإدارة.

## Follow-ups

- Current.
- Upcoming.
- Overdue.
- Completed.

## Payment

- Method.
- Link.
- Amount.
- Status.
- Date.

## Enrollment

- Status.
- Date.

## Activity

Historical events.

---

## Internal Lead Lifecycle State

بالإضافة إلى Campaign-specific Status الاختياري، يجب أن تملك Lead حالة تشغيل داخلية ثابتة لا تعتمد على Custom Fields.

الحالات المفاهيمية الأساسية:

- `OPEN`: Lead ما زالت ضمن العمل التشغيلي.
- `CLOSED`: تم إنهاء العمل التشغيلي عليها بدون حذفها.
- `ARCHIVED`: محفوظة تاريخياً وغير موجودة في التشغيل اليومي المعتاد.

هذه الحالة مختلفة عن Campaign Status.

تستخدم في:

- Agent capacity.
- My active Leads.
- Routing workload.
- Operational filters.
- Close/Reopen behavior.

Lead الجديدة تكون `OPEN` افتراضياً.

إغلاق Lead أو إعادة فتحها يجب أن يكون Action واضحاً وقابلاً للتتبع.

---

# 21. Status

Status Field Type اختياري.

يمكن لكل Campaign تعريف قيمها الخاصة.

لا تفرض Status موحدة على جميع الحملات.

---

# 22. Interest

Interest Field اختياري ويمكن تخصيص قيمه حسب Campaign.

---

# 23. Tags

Tags اختيارية وتستخدم عند الحاجة للتنظيم والفلترة والأتمتة والتحليلات.

---

# 24. Lead Assignment & Routing

الطرق الأساسية:

- Round Robin.
- Weighted.
- Performance-Based.
- Manual.

## Performance-Based Routing

يجب أن يعتمد على Human Agent metrics قابلة للقياس من المنصة، وليس على نشاط الـAI.

لا تدخل في Human Agent score:

- AI first response time.
- AI contact attempts.
- AI qualification messages.

إذا لم يوجد Historical sample كافٍ لAgent، يجب استخدام fallback عادل ومحدد بدلاً من Score عشوائي.

---

# 25. Agent Eligibility

يمكن أن يعتمد التوزيع على:

- Active state.
- Branch.
- Campaign eligibility.
- Capacity.
- Working hours.
- Availability.

إذا لا يوجد Agent مؤهل:

- يبقى Lead unassigned.
- يسجل السبب.
- يتم إشعار المسؤول وفق الإعدادات.
- يمكن لـAI Lead Assistant بدء التواصل الأولي فقط إذا كانت Campaign مفعلة لذلك ويوجد Handoff fallback واضح؛ لا يتم تعيين Agent عشوائياً.
---

# 26. Agent Capacity

يمكن تحديد Capacity.

الـCapacity الافتراضية تحسب Leads المعيّنة إلى Agent والتي تكون Internal Lifecycle = `OPEN`، ما لم توجد قاعدة موثقة مختلفة.

عند الوصول للحد، لا يستقبل Agent Leads جديدة تلقائياً وفق قواعد التوزيع.

---

# 27. Working Hours

يمكن استخدامها في:

- Routing.
- Notifications.
- AI handoff expectations.
- Follow-ups.

يجب أن يكون لكل Branch Timezone تشغيلية واضحة.

يمكن للحملة أن تحدد Messaging/AI sending window مختلفاً عند الحاجة.

---

# 28. Reassignment

Manager يعيد التعيين داخل Branch.

Super Admin يمكنه النقل بين Branches.

يجب حفظ Assignment History.

---

# 29. Agent Deactivation

عند تعطيل Agent:

- لا يستقبل Leads جديدة.
- لا يختفي التاريخ.
- لا تختفي Leads.
- يمكن إعادة توزيع Leads النشطة.
- Conversation ownership/controller يعاد تقييمه حسب القواعد.

---

# 30. Conversations & Messaging

المنصة تدعم Conversations مرتبطة بالـLeads لخدمة دورة المبيعات.

يمكن أن تأتي الرسائل عبر:

- WhatsApp.
- Future messaging channels.
- Potential email conversation channel إذا تم دعمه لاحقاً.

الـAgent يرد من داخل المنصة.

Customer-facing conversation لا تعتمد على رقم Agent الشخصي.

---

## Messaging Policy

أي outbound message يجب أن يحترم:

- Consent / opt-in المطلوب للقناة.
- Do-not-contact / suppression state.
- Provider policies.
- Template requirement عندما يفرضها Provider.
- Allowed sending hours.
- Messaging Connection scope.

Messages المرسلة أو المستلمة تبقى جزءاً من التاريخ ولا يتم تعديلها بعد الإرسال/الاستلام كأنها لم تحدث.

Internal Notes منفصلة عن Customer Messages ولا ترسل للعميل.

---

# 31. Lead Owner vs Conversation Controller

يجب الفصل بين:

**Lead Owner**

الموظف المسؤول عن Lead.

و:

**Conversation Controller**

من يرسل تلقائياً أو يدير المحادثة حالياً.

إذا كان Human، يجب أن يكون Active Human Controller مستخدماً محدداً حتى لا يرد أكثر من شخص بالتوازي بدون Takeover.

أمثلة:

```text
Lead Owner = Sarah
Conversation Controller = AI
```

ثم:

```text
Lead Owner = Sarah
Conversation Controller = HUMAN
```

---

# 32. AI Lead Assistant

عند تفعيله للحملة يستطيع:

- إرسال أول رسالة.
- تعريف نفسه وفق قواعد المنتج.
- الإجابة من Campaign Knowledge المنشورة.
- جمع Qualification data.
- تحديث Structured Fields عبر Tools مسموحة.
- تنفيذ Follow-up policy المسموحة.
- طلب Human Handoff.
- إنشاء Summary للـAgent.

لا يختلق معلومات.

---

# 33. AI Operations Assistant

مساعد داخلي للإدارة والـAgents.

يمكنه ضمن صلاحيات المستخدم:

- تلخيص Lead أو Conversation.
- الإجابة عن أسئلة تشغيلية.
- عرض Leads التي تحتاج متابعة.
- شرح Campaign performance.
- تحليل أسئلة العملاء المتكررة.
- اقتراح next action.
- إنشاء تقارير أو summaries.

الحقائق الرقمية تأتي من Platform queries/tools.

---

# 34. Campaign AI Knowledge

كل Campaign يمكن أن تمتلك Knowledge خاصة بها:

- Description.
- Product/service data.
- Prices.
- Locations.
- Schedules.
- Requirements.
- FAQs.
- Qualification questions.
- Allowed claims.
- Prohibited claims.
- Approved links.
- Approved files.

Follow-up policy وHandoff behavior جزء من Campaign AI Configuration وليسا Knowledge facts.

يجب دعم:

- Draft.
- Published.
- Version history.

AI customer-facing يستخدم Published version فقط.

---

# 35. Human Handoff

يحدث Handoff عند شروط مثل:

- Lead requests a human.
- AI lacks confirmed knowledge.
- Low-confidence or unsupported case.
- Qualified Lead ready for Agent.
- Complaint.
- Sensitive/commercial exception.
- Rule configured by Campaign.

بعد Handoff:

- Human يصبح Conversation Controller.
- AI يتوقف عن auto-send.
- AI يبقى Copilot عند السماح.
- Full conversation وsummary تبقى متاحة للـAgent.

---

# 36. Follow-ups

Follow-up يمكن أن ينشأ من:

- Agent.
- Manager.
- Automation.
- AI policy.

حالات مثل:

- Upcoming.
- Due.
- Overdue.
- Completed.
- Cancelled.

AI follow-up policy يجب أن تكون Campaign-configurable وغير hardcoded.

---

# 37. Activity Timeline

يسجل الأحداث المهمة مثل:

- Lead received.
- Lead assigned.
- Lead reassigned.
- Conversation started.
- AI contacted Lead.
- Human handoff.
- Message delivery failure.
- Field changed.
- Follow-up created/completed.
- Payment link created.
- Payment confirmed.
- Enrollment confirmed.
- AI action.
- Integration change.

---

# 38. Notifications

القنوات قد تشمل:

- In-App.
- Email.
- WhatsApp / Messaging.

Notifications تختلف عن Customer Conversation.

يمكن أن تشمل:

- New Lead.
- Assignment.
- Reassignment.
- Follow-up.
- Payment.
- Enrollment.
- System/Integration alerts.

صياغة Notification/templates يجب أن تكون قابلة للإدارة من داخل المنصة عندما يسمح نوع الإشعار والقناة بذلك، مع وجود Defaults آمنة حتى لا يتطلب كل Event إعداداً يدوياً.

---

# 39. Payment Methods

Payment Methods مرتبطة بالـBranch أو النطاق المناسب.

يمكن دعم أكثر من Provider أو Account.

Agent لا يرى Provider credentials.

---

# 40. Payment Flow

```text
Lead
  ↓
Select Payment Method
  ↓
Create Payment Link
  ↓
Share Link
  ↓
Provider Payment
  ↓
Trusted Confirmation
  ↓
Payment Record
  ↓
Enrollment
  ↓
Activity / Analytics / Notifications
```

---

# 41. Payment Scope

خارج النطاق:

- Installments.
- Payment Plans.
- Refund Management.
- Accounting.
- Financial ledger.

---

# 42. Enrollment

Payment وEnrollment كيانان منفصلان.

التدفق الأساسي:

```text
Confirmed Payment → Enrollment
```

---

# 43. Analytics

Analytics تشغيلية وليست مجرد Charts.

تشمل حسب الصلاحية:

- Leads.
- Branch performance.
- Campaign performance.
- Agent performance.
- Contact/response metrics.
- Conversations.
- AI contact/qualification metrics.
- Follow-ups.
- Payments.
- Enrollment.
- Conversion.
- Revenue.
- Leads needing attention.

Agent يمكن أن يرى Personal performance المسموح به، مع استخدام Human-only metrics عندما يكون القياس متعلقاً بأداء Agent.

---

## Communication Metric Semantics

يجب الفصل بين:

- Lead received time.
- First platform outbound contact.
- First AI contact.
- First human contact.
- First customer response.
- AI contact attempts.
- Human contact attempts.
- AI response time.
- Human Agent response time.

Agent performance لا يُحسب من رسائل أو سرعة AI.

---

## Revenue & Currency Semantics

Payment/Revenue metrics يجب أن تحافظ على Currency.

لا يجوز جمع مبالغ بعملات مختلفة في رقم Revenue واحد بدون Conversion policy صريحة.

عند وجود عدة عملات:

- تعرض Analytics totals per currency.
- أو تستخدم Reporting currency فقط إذا تم تعريف Exchange-rate source/time policy بشكل واضح.

---

# 44. Campaign Analytics

يجب ألا تفترض Analytics نفس Fields أو Statuses لكل Campaign.

تستخدم Campaign-specific configuration.

---

## Conversion Definition

`Conversion` لا يجب أن تكون Metric عالمية مبهمة.

يمكن لكل Campaign تحديد Conversion milestone مناسب، مثل:

- Enrollment confirmed.
- Payment confirmed.
- Campaign Status/Field value محددة.
- Business milestone آخر تدعمه المنصة.

إذا لم يتم تحديد Conversion definition، لا تعرض المنصة Conversion rate وكأن معناها معروف تلقائياً.

---

# 45. Drill-down

Metric قابل للتحويل عند الحاجة إلى Filtered Lead List.

---

# 46. Automations

النمط:

```text
Trigger → Conditions → Actions
```

أمثلة Actions:

- Change Field.
- Create Follow-up.
- Send Notification.
- Assign Lead.
- Add Tag.
- Change Status.
- Start/stop allowed AI workflow.
- Request human attention.

---

# 47. Automation Safety

يجب منع:

- Infinite loops.
- Duplicate execution.
- Unintended repeated messages.
- Unauthorized actions.

كل Execution مهم قابل للتتبع.

---

# 48. Search

البحث يمكن أن يشمل:

- Name.
- Phone.
- Email.
- Lead ID.
- Campaign.
- Agent.
- Branch.
- Permitted campaign fields.

---

# 49. Filters

تشمل حسب الصلاحيات:

- Branch.
- Campaign.
- Agent.
- Dates.
- Payment.
- Enrollment.
- Conversation state.
- AI/Human controller.
- Status.
- Interest.
- Tags.
- Custom fields.

---

# 50. Saved Views

تحتوي:

- Filters.
- Sorting.
- Columns.
- Name.
- Owner/scope.

ولا تتجاوز Permissions الحالية.

---

# 51. Bulk Actions

مثل:

- Assign.
- Update Field.
- Change Status.
- Add/Remove Tag.
- Create Follow-up.
- Export.

تخضع للصلاحيات.

---

# 52. Import

يدعم:

- CSV.
- Excel.
- Google Sheets.
- Manual creation.
- API/source imports.

مع:

- اختيار Branch ضمن صلاحية المستخدم.
- اختيار Campaign عند الحاجة.
- Mapping.
- Validation.
- Preview.
- Duplicate review.
- Result report.

---

# 53. Export

يخضع إلى:

- Role.
- Branch.
- Lead access.
- Field visibility.
- Data sensitivity.

---

# 54. Google Sheets

تكامل مساعد فقط.

ليست قاعدة البيانات الأساسية.

---

# 55. Audit Logs

يجب تسجيل العمليات الإدارية والحساسة مثل:

- User/role changes.
- Campaign changes.
- Field configuration.
- Routing.
- Assignment.
- Integration connection changes.
- Credentials rotation event بدون تسجيل السر نفسه.
- AI configuration changes.
- Knowledge publish.
- Payment method changes.
- Payment events.
- Enrollment.
- Sensitive bulk actions.

---

# 56. Languages

اللغات:

- Arabic.
- French.
- English.

Arabic = RTL.

French / English = LTR.

---

# 57. Responsive & Mobile Experience

المنصة تعمل على:

- Desktop.
- Tablet.
- Mobile.

Agent workflow يجب أن يكون عملياً جداً على الهاتف.

---

# 58. Main Screens

## General

- Login.
- Dashboard.
- Notifications.
- Profile.

## Super Admin

- Dashboard.
- Leads.
- Contacts.
- Branches.
- Users.
- Campaigns.
- Forms / Source Bindings.
- Conversations.
- Fields.
- Mapping.
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
- Forms / Source Bindings.
- Conversations.
- Fields.
- Mapping.
- Routing.
- Payments.
- Enrollments.
- Analytics.
- Automations.
- AI.
- Integrations حسب الصلاحية.
- Notifications.
- Settings.

## Agent

- Dashboard.
- My Leads.
- Lead Details.
- My Conversations.
- Follow-ups.
- Payment Status/Links.
- AI Copilot.
- Notifications.
- Profile.

---

# 59. Campaign Management Experience

Campaign setup يجب أن يجمع:

- Source.
- Branch.
- Agents.
- Routing.
- Fields.
- Messaging.
- AI.
- Qualification.
- Follow-up.
- Automation.
- Payment options.
- Review/activation.

---

# 60. Field Management Experience

واجهة قريبة من Spreadsheet في البساطة، لكن محكومة بالـPermissions والـBusiness Rules.

---

# 61. Lead Table Experience

الأعمدة تعتمد على:

- Campaign.
- Field configuration.
- Role.
- User permissions.

---

# 62. Data Visibility

وجود Field أو Conversation أو AI insight في النظام لا يعني ظهوره لكل مستخدم.

الوصول يعتمد على:

- Role.
- Branch.
- Lead ownership/access.
- Campaign.
- Field configuration.
- Conversation access.
- Permissions.

---

# 63. Integration Setup Experience

كل Integration يجب أن يملك، حسب طبيعته:

- Setup wizard.
- Required prerequisites.
- Exact instructions.
- Connect/authenticate.
- Credential entry عند الحاجة.
- Test connection.
- Status.
- Last success.
- Last error.
- Reconnect.
- Disable.
- Scope/binding.
- Audit history.

لا يجب أن يحتاج المستخدم إلى مطور فقط لإتمام setup تشغيلي عادي.

---

# 64. Multi-Connection Flexibility

يجب ألا يفترض النظام Connection واحدة فقط.

أمثلة:

- عدة Meta accounts.
- عدة Pages/Forms.
- عدة WhatsApp numbers.
- عدة AI provider connections.
- عدة Payment accounts.
- عدة Branch-specific configurations.

---

# 65. Error & Failure Behavior

إذا فشل Messaging Provider:

- Lead لا يضيع.
- Conversation تحفظ.
- Failure يسجل.
- Retry أو fallback يطبق حسب القواعد.
- Agent يستطيع رؤية الحالة.

إذا فشل AI:

- Lead management يستمر.
- Human agents يستطيعون المتابعة.
- AI failure يظهر.
- يمكن retry أو handoff.

إذا فشل Payment Provider:

- لا يسجل Payment ناجح بدون confirmation موثوق.

---

# 66. Data Integrity

يجب الحفاظ على:

- Source submissions.
- Lead history.
- Assignment history.
- Conversation history.
- Message history.
- Field history.
- Payment events.
- Enrollment events.
- Integration events.
- AI execution history عند الحاجة.
- Knowledge versions.

---

## Archive / Deletion Principle

التشغيل اليومي يفضل Deactivate / Close / Archive على Hard Delete للسجلات التاريخية المهمة.

أي حذف فعلي مطلوب لأسباب قانونية أو إدارية يجب أن:

- يكون Workflow صريحاً ومصرحاً.
- يكون Audited.
- يحترم علاقات البيانات.
- لا يتم تنفيذه كBulk destructive action عادي بدون safeguards.

---

# 67. Product Boundaries

المنصة ليست:

- LMS.
- Course Marketplace.
- General WhatsApp CRM.
- General-purpose Chat Platform.
- Customer Support Suite.
- ERP.
- Accounting System.
- Full Financial System.

لكنها تحتوي Messaging/Conversation capabilities اللازمة لإدارة الـLead ضمن دورة المبيعات.

---

# 68. Future Extensibility

يجب أن يمكن إضافة:

## Lead Sources

- Website.
- Google Ads.
- TikTok.
- Other APIs.

## Messaging

- Additional providers/channels.

## Payments

- Additional providers/accounts.

## AI

- Additional providers/models/assistants.

## Data Integrations

- Future systems.

بدون إعادة بناء المفاهيم الأساسية.

---

# 69. Core End-to-End Workflow

```text
External Lead Source
    ↓
Lead Intake
    ↓
Campaign Identification
    ↓
Contact Match/Create
    ↓
Field Mapping
    ↓
Branch
    ↓
Lead Owner Assignment
    ↓
AI Initial Contact (if enabled)
    ↓
Qualification / Conversation
    ↓
Human Handoff
    ↓
Agent Follow-up
    ↓
Payment
    ↓
Trusted Confirmation
    ↓
Enrollment
    ↓
Analytics / Automation / AI Operations
```

---

# 70. Manager End-to-End Workflow

```text
Configure allowed integrations
    ↓
Create Campaign
    ↓
Connect source
    ↓
Configure Branch/Agents/Routing
    ↓
Configure Fields/Mapping
    ↓
Configure Messaging
    ↓
Configure AI Knowledge/Qualification (optional)
    ↓
Activate
    ↓
Monitor Leads/Conversations
    ↓
Manage Follow-ups
    ↓
Manage Payments/Enrollment
    ↓
Analyze performance
```

---

# 71. Agent End-to-End Workflow

```text
Receive assigned Lead
    ↓
Open Lead Details
    ↓
Read AI summary / previous conversation
    ↓
Continue conversation from platform
    ↓
Update allowed fields
    ↓
Add note / follow-up
    ↓
Use AI Copilot if needed
    ↓
Payment
    ↓
Enrollment tracking
```

---

# 72. المرجعية الوظيفية

هذا الملف يحدد:

- ما هو المنتج.
- الوظائف الأساسية.
- تجربة التشغيل العامة.
- الحدود.
- العلاقات الوظيفية الكبرى.

ولا يفرض:

- Technology stack.
- Framework.
- Database.
- Hosting.
- Specific AI model.
- Specific WhatsApp provider.
- Specific payment provider.

القرارات التقنية يجب أن تحقق المتطلبات مع الحفاظ على Security وReliability وProvider independence وIn-platform operational setup.

# 79. High-Volume Operational Requirement

المنصة يجب أن تبقى عملية عند نمو عدد Campaigns وAgents وLeads اليومية وConversations وMessages وFollow-ups وWebhook events وAutomation executions وAI executions وPayments والسجلات التاريخية.

لا يجوز أن يعتمد UX أو Backend على تحميل كل البيانات دفعة واحدة.

القوائم الرئيسية والـDrill-down يجب أن تعتمد على Server-side pagination وSearch وEfficient filtering/sorting وBounded bulk operations.

العمليات الطويلة أو الكثيفة مثل Historical imports وLarge exports وBulk actions وAI batch analysis وProvider synchronization وLarge analytics refresh يجب أن تعمل بطريقة لا تمنع Lead intake أو Agent login أو Lead Details أو Conversation replies أو Payment processing.

الهدف الوظيفي: نمو حجم التشغيل يجب أن يُعالج عبر Architecture قابلة للتوسع ومراقبة الأداء، وليس عبر إعادة بناء المنصة من الصفر.
