# Domain Model

# 1. Purpose

هذا الملف يحدد المفاهيم والكيانات والعلاقات الأساسية للمنصة.

الهدف هو توضيح:

- ما هي الكيانات الأساسية.
- ما الذي يمثله كل كيان.
- كيف ترتبط الكيانات ببعضها.
- ما الذي يمثل Current State.
- ما الذي يجب الاحتفاظ به تاريخياً.
- كيف تبقى Integrations والـAI والـMessaging منفصلة عن Core Business Domain.

هذا الملف لا يفرض:

- Database engine.
- Programming language.
- ORM.
- Table names.
- Storage technology.
- Specific provider implementation.

---

# 2. Domain Modeling Principles

يجب أن يحافظ النموذج على:

- Contact منفصل عن Lead.
- Campaign منفصلة عن Lead.
- Current State منفصل عن History.
- Source Data منفصلة عن Operational Data.
- Payment منفصل عن Enrollment.
- Lead Owner منفصل عن Conversation Controller.
- Conversation منفصلة عن Notification.
- AI configuration منفصلة عن AI execution.
- Integration Connection منفصلة عن Provider implementation.
- Campaign Knowledge versioned.
- Branch isolation.
- Provider independence.
- Multi-connection support.
- Historical integrity.

---

# 3. Organization

يمثل الكيان الأعلى.

حالياً المنتج لمنظمة واحدة، لكن النموذج لا يجب أن يمنع دعم أكثر من Organization مستقبلاً.

العلاقات:

```text
Organization
  → Branches
  → Integration Connections
  → Global Configurations
```

---

# 4. Branch

يمثل وحدة تشغيل مستقلة.

يمكن أن يحتوي على:

- Name.
- Status.
- Manager.
- Agents.
- Campaigns.
- Leads.
- Payment Methods.
- Automations.
- Integration bindings.
- Messaging connections.
- Operational settings.

---

## Branch Operational Settings

يمكن أن تشمل:

- Timezone.
- Business hours.
- Default messaging hours.
- Default Messaging Sender/Number.
- Default locale.
- Operational escalation settings.
- Branch AI defaults التي يسمح النظام بوراثتها.

يمكن للحملة override بعض هذه الإعدادات عندما يسمح النظام.

---

# 5. User

حساب المستخدم.

الأدوار الأساسية:

- Super Admin.
- Manager.
- Agent.

Role وحده لا يكفي لتحديد الوصول؛ يجب أيضاً مراعاة:

- Branch.
- Ownership.
- Campaign.
- Field permissions.
- Action permissions.
- Integration scope.
- Conversation scope.

---

## User Access Lifecycle

Functional concepts المطلوبة تشمل:

- Active / inactive account.
- Login credential state.
- Password/credential reset lifecycle.
- Session revocation capability.
- Last access/security metadata عند الحاجة.

التنفيذ التقني يمكن أن يستخدم Identity Provider أو Authentication stack مناسب.

---

# 6. Manager

مستخدم مسؤول عن Branch.

يمكن أن يحتوي على:

- User account.
- Assigned Branch.
- Status.
- Profile.
- Notification preferences.

---

# 7. Agent

مستخدم تشغيلي.

يمكن أن يحتوي على:

- User account.
- Branch.
- Display name.
- Phone.
- Active status.
- Working hours.
- Capacity.
- Routing configuration.
- Notification preferences.

رقم الهاتف ليس هو Customer-facing sender الافتراضي؛ Customer conversations تستخدم Messaging Connection مركزية حسب إعداد النظام.

---

# 8. Contact

يمثل الشخص نفسه.

يمكن أن يحتوي على:

- Name.
- Phone.
- Email.
- Other contact data.

العلاقة:

```text
Contact 1 → many Leads
```

وجود Contact سابق لا يمنع إنشاء Lead جديدة.

---

## Contact Identity / Matching

يمكن أن يحتفظ النظام بقيم normalized للمطابقة، مثل:

- Canonical phone.
- Normalized email.
- External participant identifiers.

هذه القيم تساعد المطابقة ولا تستبدل Original user-entered/source values.

إذا كانت المطابقة ambiguous يجب ألا ينتج عنها merge تلقائي غير موثوق.

---

# 9. Lead

يمثل فرصة أو طلباً محدداً.

يمكن أن يرتبط بـ:

- Contact.
- Campaign.
- Branch.
- Current assigned Agent.
- Source.
- Source Submissions.
- Dynamic Field Values.
- Conversation(s).
- Follow-ups.
- Notes.
- Activities.
- Payments.
- Enrollment.
- Notifications.
- AI executions.

Lead هو الكيان المركزي في دورة المبيعات.

---

## Lead Lifecycle State

يمثل الحالة التشغيلية الداخلية للـLead بشكل مستقل عن Campaign Status Field.

قيم مفاهيمية:

- OPEN.
- CLOSED.
- ARCHIVED.

يمكن حفظ:

- Current lifecycle state.
- Closed/archived timestamp.
- Actor/source.
- Reason عند الحاجة.

Campaign Status يبقى Custom/optional ولا يستخدم وحده كمرجع للـCapacity أو Core lifecycle.

---

# 10. Lead Identity & Metadata

يمكن أن تشمل:

- Internal identifier.
- Created at.
- Updated at.
- Source.
- Campaign.
- Branch.
- Current Agent.
- Current operational state.
- External references.
- Intake timestamps.

هذه المعلومات لا ترتبط حصراً بـMeta.

---

# 11. Lead Source

مفهوم عام يمثل أصل Lead.

أمثلة:

- Meta.
- Manual.
- CSV.
- Excel.
- Google Sheets.
- API.
- Webhook.
- Future source.

---

# 12. Source Submission

يمثل البيانات الأصلية المستلمة من Source.

يحفظ:

- Original payload/data.
- External identifiers.
- Source timestamps.
- Source metadata.
- Processing state.
- Related connection.
- Mapping/reprocessing context عند الحاجة.

يستخدم من أجل:

- Audit.
- Troubleshooting.
- Reprocessing.
- Mapping.
- Historical accuracy.

---

# 13. Campaign

وحدة تشغيل تحدد كيفية التعامل مع Leads.

يمكن أن تحتوي على:

- Branch.
- Source bindings.
- Eligible Agents.
- Routing configuration.
- Field configurations.
- Visibility/editability.
- Automation configuration.
- Messaging configuration بما فيها inherited Branch default sender أو explicit Campaign override.
- AI configuration المبنية من Global Guardrails + Branch Defaults + Campaign Configuration.
- Qualification configuration.
- Follow-up policy.
- Payment availability.
- Conversion definition.
- Status.

---

## Campaign Agent Configuration

يمثل علاقة Agent بـCampaign ويمكن أن يحتوي على:

- Eligibility.
- Active/inactive for campaign.
- Routing weight.
- Campaign-specific capacity override عند الحاجة.
- Routing metadata.

## Routing Configuration

يمثل إعداد طريقة التوزيع للحملة.

يمكن أن يحتوي على:

- Method.
- Eligible agent settings.
- Capacity behavior.
- Working-hours behavior.
- Performance-based policy reference.
- Fallback behavior.

---

## Performance Routing Policy

عندما تستخدم Campaign Performance-Based Routing يمكن أن تحتوي Policy على:

- Enabled metrics.
- Metric weights.
- Lookback window.
- Minimum sample size.
- Normalization/scoring rules.
- Fallback routing method.

المقاييس يجب أن تكون Human Agent metrics وقابلة للتفسير.

---

# 14. External Campaign Reference

يربط Campaign داخل المنصة بمورد خارجي.

يمكن أن يحتوي على:

- Provider.
- Connection.
- External ID.
- External name.
- External type.
- Metadata.

لا يجب أن تعتمد Campaign داخلياً على بنية Provider.

---

# 15. Form

يمثل Form لجمع بيانات Lead.

يمكن أن يحتوي على:

- Name.
- Source.
- Connection.
- External Form ID.
- Campaign association.
- Status.
- Metadata.

Campaign يمكن أن ترتبط بForm واحد أو أكثر حسب المصدر.

---

# 16. Source Field

يمثل سؤالاً أو Field قادماً من Source خارجي.

يمكن أن يحتوي على:

- External identifier.
- Label.
- Source/Form.
- Data type.
- Metadata.

---

## Source Field Mapping

يمثل الربط بين Source Field وPlatform Field.

يمكن أن يحتوي على:

- Source/Connection/Form scope.
- Source Field.
- Platform Field.
- Transformation/normalization rule عند الحاجة.
- Required mapping state.
- Active version/status.

Mapping لا يغير Source Submission الأصلية.

---

# 17. Field Definition

تعريف Field داخلي.

يمكن أن يحتوي على:

- Name.
- Label.
- Key.
- Type.
- Description.
- Scope.
- Options.
- Validation.
- Calculated flag.
- Active state.

---

# 18. Field Scope

قد يكون:

- System-level.
- Branch-level.
- Campaign-level.

---

# 19. Field Types

يدعم مفاهيم مثل:

- Text.
- Long Text.
- Number.
- Phone.
- Email.
- Date.
- Time.
- Date & Time.
- Single Select.
- Multi Select.
- Boolean.
- Status.
- Interest.
- Tags.
- Currency.
- Percentage.
- Duration.
- URL.
- Calculated Field.

القائمة قابلة للتوسع.

---

# 20. Field Option

قيمة مسموحة لحقل يعتمد على Options.

ترتبط بـField Definition.

---

# 21. Campaign Field Configuration

يمثل استخدام Field داخل Campaign.

يمكن أن يحدد:

- Visible.
- Editable.
- Required.
- Display order.
- Show in Lead Table.
- Show in Lead Details.
- Available in filters.
- Available to Agent.
- Available to Manager.
- Usable by automation.
- Usable by AI qualification.
- Validation overrides المسموحة.

---

# 22. Field Visibility

وجود Field لا يعني ظهوره للجميع.

الوصول يعتمد على:

- Role.
- Branch.
- Campaign.
- Lead access.
- Field configuration.
- Permission.

---

# 23. Field Editability

يمكن أن يكون Field:

- Editable.
- Read-only.
- Source-managed.
- System-managed.
- Calculated.

---

# 24. Lead Field Value

القيمة الفعلية لـField على Lead.

يمكن أن تحمل معلومات عن مصدر القيمة:

- Source-provided.
- Manual.
- Imported.
- Calculated.
- Automation-generated.
- AI-extracted/AI-assisted.

AI-generated value لا تعني تجاوز Validation أو Business Rules.

---

# 25. Field Value History

يحفظ تغييرات القيم المهمة.

يمكن أن يحتوي على:

- Lead.
- Field.
- Old value.
- New value.
- Actor.
- Source of change.
- Timestamp.

---

# 26. Calculated Field Definition

تعريف قيمة مشتقة.

قد تعتمد على:

- Fields.
- Activities.
- Timestamps.
- Messages.
- Payments.
- Other supported data.

---

# 27. Assignment

يمثل التعيين الحالي.

يشمل:

- Lead.
- Current Branch.
- Current Agent.
- Assigned at.
- Assignment source.

Lead قد تكون Assigned أو Unassigned.

---

# 28. Assignment History

يحفظ:

- Previous Branch.
- Previous Agent.
- New Branch.
- New Agent.
- Actor/source.
- Reason.
- Timestamp.

---

## Routing Decision

عند Automatic Routing يمكن حفظ:

- Lead.
- Routing configuration/version.
- Eligible candidate set أو summary مناسب.
- Selected Agent.
- Decision reason/method.
- Fallback used.
- Timestamp.

الهدف هو troubleshooting والشفافية، وليس تخزين تفاصيل تقنية غير لازمة.

---

# 29. Lead Owner

مفهوم وظيفي يمثل Agent المسؤول عن Lead حالياً.

Lead Owner لا يساوي بالضرورة الشخص/النظام الذي يتحكم بالمحادثة لحظياً.

---

# 30. Conversation

يمثل سلسلة Customer-facing messages مرتبطة بـLead.

يمكن أن يحتوي على:

- Lead.
- Channel.
- Messaging Connection.
- Resolved/Pinned Messaging Sender/Number.
- External thread/conversation reference عند توفره.
- Status.
- Current Controller.
- Started at.
- Last message at.
- Closed at.
- Current handoff state.

Lead يمكن أن يمتلك Conversation واحدة أو أكثر حسب القنوات أو lifecycle.

---

# 31. Conversation Channel

يمثل القناة المستخدمة.

أمثلة:

- WhatsApp.
- Future messaging channel.
- Email conversation إذا تم دعمه مستقبلاً.

لا يجب ربط Conversation بمنطق WhatsApp حصراً.

---

# 32. Conversation Controller

يمثل من يملك حق auto-send/active control حالياً.

يتكون مفاهيمياً من:

- Controller type: AI / HUMAN / NONE.
- Controller reference عند الحاجة: AI Assistant أو Human User محدد.

إذا كان Controller = HUMAN فيجب معرفة المستخدم البشري الذي يملك Active control، وغالباً يكون Lead Owner بعد Handoff.

هذا المفهوم منفصل عن Lead Owner، لكنه يمنع أكثر من Human من الإرسال المتزامن بدون Takeover واضح.

---

# 33. Conversation State

حالات مفاهيمية يمكن أن تشمل:

- AI_ACTIVE.
- AI_WAITING_FOR_LEAD.
- AI_HANDOFF_REQUIRED.
- WAITING_FOR_HUMAN.
- HUMAN_ACTIVE.
- CLOSED.

الأسماء التنفيذية النهائية قرار تقني، لكن المعنى الوظيفي يجب أن يبقى.

---

# 34. Message

يمثل رسالة داخل Conversation.

يمكن أن يحتوي على:

- Conversation.
- Direction: inbound/outbound.
- Sender type: customer/AI/user/system.
- Sender reference.
- Body/content.
- Attachments reference.
- Provider message ID.
- Created/sent/received time.
- Delivery status.
- Failure information المناسبة.
- AI execution reference عند الحاجة.

---

## Messaging Consent / Contactability

يمثل حالة السماح بالتواصل عند الحاجة للقناة أو القانون/السياسة.

يمكن أن يحتوي على:

- Contact/Lead.
- Channel.
- Status.
- Source.
- Granted/revoked time.
- Evidence/reference عند الحاجة.
- Suppression / do-not-contact reason.

## Provider Message Template

عندما يفرض Provider templates معتمدة، يمكن للنظام تمثيل:

- Connection.
- External template ID.
- Name.
- Language.
- Approval/status.
- Allowed use context.

لا تفرض Template model على Providers التي لا تحتاجها.

---

# 35. Message Delivery State

قد تشمل:

- Queued.
- Sent.
- Delivered.
- Read عندما يوفر المزود ذلك.
- Failed.

حالة المزود لا تغير التاريخ الداخلي للرسالة.

---

# 36. Conversation Handoff

يمثل انتقال التحكم من AI إلى Human أو العكس وفق قواعد مسموحة.

يمكن أن يحتوي على:

- Conversation.
- From controller.
- To controller.
- Reason.
- Requested by.
- Timestamp.
- Resolved at.

---

# 37. Follow-up

مهمة مرتبطة بـLead.

يمكن أن يحتوي على:

- Due date/time.
- Type.
- Priority.
- Notes.
- Status.
- Created by/source.
- Completed by.
- Completion time.

يمكن أن يكون مصدره:

- Agent.
- Manager.
- Automation.
- AI policy.

---

# 38. Note

ملاحظة تشغيلية مرتبطة بـLead.

ليست بديلاً عن Structured Fields.

---

# 39. Activity

حدث مهم في تاريخ Lead.

أمثلة:

- Lead received.
- Lead assigned.
- Conversation started.
- AI message sent.
- Human handoff.
- Field changed.
- Follow-up created.
- Payment confirmed.
- Enrollment confirmed.

Activity ليس بديلاً عن Current State.

---

# 40. Notification

إشعار للمستخدم وليس Customer Conversation.

يمكن أن يحتوي على:

- Recipient.
- Lead.
- Event.
- Channel.
- Status.
- Delivery information.

---

# 41. Notification Preference

يحدد:

- Event type.
- Channel.
- Enabled/disabled.

بعض Notifications قد تكون إلزامية.

---

## Notification Template

يمثل صياغة Notification قابلة للإدارة عندما تحتاج القناة/الحدث ذلك.

يمكن أن يحتوي على:

- Event type.
- Channel.
- Scope: system/branch/campaign عند الحاجة.
- Language.
- Content/template reference.
- Active status.

Notification Template مختلفة عن Provider Message Template الخاصة بقيود Messaging provider.

---

# 42. Payment Method

طريقة دفع ضمن Scope مناسب.

يمكن أن يحتوي على:

- Branch.
- Provider type.
- Integration Connection.
- Display name.
- Active state.
- Availability rules.
- Configuration reference.

Credentials لا تعامل كبيانات تشغيلية عادية.

---

# 43. Payment Link

يمكن أن يحتوي على:

- Lead.
- Payment Method.
- Amount.
- Currency.
- Status.
- Provider reference.
- Created at.
- Expiry عند توفرها.

---

# 44. Payment

يمثل عملية دفع.

يمكن أن يحتوي على:

- Lead.
- Payment Method.
- Payment Link.
- Amount.
- Currency.
- Status.
- Provider reference.
- Confirmation event.
- Payment timestamp.

---

# 45. Enrollment

يمثل حالة الاشتراك الناتجة عن التدفق التشغيلي.

يمكن أن يحتوي على:

- Lead.
- Status.
- Enrollment date.
- Payment reference.
- Metadata.

Payment وEnrollment كيانان منفصلان.

---

# 46. Automation

قاعدة:

```text
Trigger → Conditions → Actions
```

قد تكون:

- System-level.
- Branch-level.
- Campaign-level.

---

# 47. Automation Trigger

أمثلة:

- Lead created.
- Lead assigned.
- Message received.
- Conversation state changed.
- Field changed.
- Follow-up due.
- Payment confirmed.
- Enrollment confirmed.

---

# 48. Automation Condition

قد تعتمد على:

- Branch.
- Campaign.
- Agent.
- Field values.
- Conversation state.
- AI state.
- Payment.
- Enrollment.
- Dates.

---

# 49. Automation Action

أمثلة:

- Change Field.
- Create Follow-up.
- Send Notification.
- Assign Lead.
- Add Tag.
- Change Status.
- Request human attention.
- Start/stop allowed AI workflow.

لا تتجاوز Business Rules.

---

# 50. Automation Execution

يحفظ عند الحاجة:

- Automation.
- Trigger.
- Lead.
- Result.
- Started/completed time.
- Success/failure.
- Error context.

---

# 51. Integration Provider Type

مفهوم يصف نوع Provider/adapter.

أمثلة:

- Meta.
- WhatsApp Cloud API.
- Other messaging provider.
- Stripe.
- Other payment provider.
- AI provider.
- Email provider.
- Google.

هذا المفهوم لا يعني hardcoding provider داخل الـDomain.

---

# 52. Integration Connection

يمثل اتصالاً فعلياً بحساب/مزود خارجي.

يمكن أن يحتوي على:

- Provider type.
- Organization/Branch scope.
- Display name.
- Status.
- Configuration.
- Credentials reference.
- External account identifiers.
- Last successful activity.
- Last error.
- Health information.
- Capability metadata.
- Created/updated by.

يجب دعم أكثر من Connection لنفس Provider type.

Organization-scoped Connection يمكن أن تُشارك مع Branches بدون كشف Credentials عندما يسمح النظام.

Branch-scoped Connection لا تستخدم خارج Branch الخاص بها.

---

# 53. Integration Binding

يربط Connection بكيان تشغيلي.

أمثلة:

- Meta Connection → Campaign.
- Messaging Connection → Branch/Campaign.
- Payment Connection → Payment Method.
- AI Provider Connection → AI profile/configuration.

يفصل Binding بين Connection نفسها واستخدامها التشغيلي.

---

# 54. Credential Reference

يمثل مرجعاً آمناً للسر أو الـtoken.

الـDomain لا يحتاج تخزين السر كنص عادي.

يجب الفصل بين:

- Credential metadata.
- Actual encrypted/secure secret.

---

# 55. Integration Event

يمثل حدثاً متعلقاً بتكامل.

أمثلة:

- Incoming webhook.
- Outgoing request.
- Sync.
- Delivery callback.
- Payment event.
- OAuth refresh.
- Connection failure.

---

## Messaging Inbound Resolution Record / Needs Attention

عندما يصل Messaging Provider Event ولا يمكن Resolve الـConversation/Lead/Campaign بشكل Deterministic، يجب حفظه بدون اختراع Conversation عشوائية.

يمكن تمثيل ذلك كتخصص/حالة من `Integration Event` أو ككيان تقني مستقل مناسب، بشرط الاحتفاظ على الأقل بـ:

- Messaging Connection.
- Business Sender.
- External participant identifier.
- Provider event/message ID.
- Received timestamp.
- Safe payload/content reference.
- Resolution state: pending/resolved/ignored/error أو equivalent.
- Candidate context summary عند الحاجة بدون تجاوز Permissions.
- Resolved Lead/Conversation/Campaign عند الحسم.
- Resolved by / resolved at.
- Resolution audit/history.

الـ`Message` التشغيلية المرتبطة بـConversation تنشأ/ترتبط بعد Resolution الصحيح. عدم وجود Conversation لحظة الاستقبال لا يجوز أن يؤدي إلى فقدان الحدث أو ربطه عشوائياً.

---

# 56. External Reference

يربط كياناً داخلياً بمعرف خارجي.

يمكن استخدامه مع:

- Lead.
- Campaign.
- Form.
- Page.
- Ad.
- Payment.
- Message.
- Other provider resources.

---

# 57. Messaging Connection

تخصص وظيفي لـIntegration Connection لقناة Messaging.

يمكن أن يمثل اتصالاً إلى:

- Business/provider account.
- Provider.
- Branch/Organization scope.
- Credential reference.
- Status.
- Capability/health metadata.

Connection واحدة قد تحتوي Sender/Number واحدة أو أكثر حسب Provider، لذلك لا يجب دمج Credential/Account Connection مع Business Sender identity قسراً إذا كان Provider يميز بينهما.

## Messaging Sender / Number Identity

يمثل الهوية Customer-facing المستخدمة فعلياً للإرسال والاستقبال.

يمكن أن يحتوي على:

- Messaging Connection.
- External sender/phone identifier.
- Display identity.
- Status/health.
- Organization/Branch bindings.
- Provider capability/quality/throughput metadata عندما تتوفر.
- Default/override usage metadata.

العلاقة التشغيلية:

```text
Organization Shared Sender (اختياري)
        ↓
Branch Default Sender
        ↓
Campaign Sender Override (اختياري)
        ↓
Conversation Resolved/Pinned Sender
```

يجب دعم عدة senders/connections عند الحاجة، لكن Dedicated Sender لكل Campaign ليس Requirement.

---

# 58. AI Provider Connection

تخصص وظيفي لاتصال AI Provider.

يمكن أن يحتوي على:

- Provider type.
- Secure credential reference.
- Available/configured model profiles.
- Status.
- Scope.
- Health information.

لا يجب أن يحمل Business Rules الخاصة بالحملة.

---

# 59. AI Model/Profile Configuration

يمثل اختياراً configurable للمهام.

يمكن أن يحدد:

- Conversation model/profile.
- Summarization model/profile.
- Classification model/profile.
- Analysis model/profile.

يمكن أن تستخدم كلها نفس model مبدئياً، لكن النموذج لا يمنع الفصل لاحقاً.

---

# 60. AI Assistant Definition

يمثل Assistant/Agent configuration عامة.

أمثلة مفاهيمية:

- AI Lead Assistant.
- AI Operations Assistant.

يمكن أن يحتوي على:

- Type.
- Enabled state.
- Provider/model profile.
- Tool permissions profile.
- Behavior configuration.
- Scope.

---

# 61. Campaign AI Configuration

إعداد AI خاص بحملة.

الـEffective AI Configuration تتبع:

```text
Global AI Guardrails
        ↓
Branch AI Defaults
        ↓
Campaign AI Configuration
```

- Global Guardrails تمثل القيود غير القابلة للتجاوز.
- Branch AI Defaults تمثل Defaults تشغيلية قابلة للوراثة فقط.
- Campaign Configuration تحدد السلوك النهائي للحملة وتعمل Override فقط لما هو مسموح.

يمكن أن يحتوي على:

- Enabled/disabled.
- AI Assistant reference.
- Knowledge reference.
- Qualification configuration.
- Follow-up policy.
- Handoff rules.
- Approved tool scope.
- Language/tone configuration.
- Messaging binding / optional Sender override.
- Activation state.

يمكن مشاركة AI Provider/Model/Runtime بين Campaigns متعددة، لكن كل AI Execution يجب أن يحمل Campaign scope وEffective Configuration واضحة. Shared runtime لا يسمح بقراءة Knowledge/Instructions/Qualification/Lead/Conversation الخاصة بحملة أخرى.

---

# 62. Campaign Knowledge Base

يمثل المعرفة المعتمدة للحملة.

قد تحتوي على:

- Product/service info.
- Pricing.
- Locations.
- Schedules.
- Requirements.
- FAQs.
- Approved links.
- Approved files.
- Allowed claims.
- Prohibited claims.

---

# 63. Knowledge Version

كل Publish ينتج Version يمكن الرجوع إليها.

يمكن أن يحتوي على:

- Campaign.
- Version.
- Status: draft/published/archived.
- Content snapshot/reference.
- Published by.
- Published at.

AI customer-facing يستخدم Published version فقط.

---

# 64. Knowledge Item / Asset

عنصر داخل Knowledge Base.

قد يمثل:

- FAQ.
- Text section.
- Link.
- File.
- Structured fact.
- Policy.

التنفيذ الفعلي يمكن أن يختلف، لكن يجب الحفاظ على Versioning وapproval semantics.

---

# 65. Qualification Definition

تعريف البيانات والأسئلة المطلوبة لتأهيل Lead.

يمكن أن يحتوي على:

- Campaign.
- Questions.
- Related platform fields.
- Required/optional status.
- Order.
- Completion criteria.

---

# 66. Qualification Result

يمثل نتائج التأهيل لـLead.

يمكن أن يعتمد على Structured Field Values بدلاً من duplication، لكن يجب أن يمكن معرفة:

- ما الذي تم جمعه.
- ما الذي بقي ناقصاً.
- Completion state.
- Source: AI/Human/Form.

---

# 67. AI Follow-up Policy

إعداد Campaign يحدد:

- Whether enabled.
- Delays.
- Maximum attempts.
- Allowed time windows.
- Stop conditions.
- Handoff conditions.

لا يجب Hardcode policy واحدة لكل الحملات.

---

# 68. AI Tool Definition / Capability

يمثل Action مسموحة للـAI عبر Application layer.

أمثلة:

- getLeadContext.
- getCampaignKnowledge.
- updateQualification.
- sendMessage.
- requestHumanHandoff.
- getCampaignStats.
- getUnfollowedLeads.
- createFollowUpTask.

الـAI لا يتصل مباشرة بالـDatabase لتنفيذ هذه الإجراءات.

---

# 69. AI Execution

يمثل عملية AI مهمة قابلة للتتبع.

يمكن أن يحتوي على:

- Assistant definition.
- Lead/Conversation/User context.
- Knowledge version.
- Model/profile.
- Started/completed time.
- Result state.
- Failure state.

لا يلزم تخزين كل reasoning الداخلي؛ المطلوب هو التتبع التشغيلي الآمن.

---

# 70. AI Tool Execution

يمثل محاولة استخدام Tool.

يمكن أن يحتوي على:

- AI Execution.
- Tool.
- Input metadata المناسبة.
- Authorization context.
- Result.
- Success/failure.
- Timestamp.

لا تسجل secrets.

---

# 71. AI Summary

ملخص مشتق من Conversation/Lead.

ليس Source of Truth.

يمكن إعادة توليده.

---

# 72. AI Insight

Insight أو recommendation مشتقة.

أمثلة:

- Suggested next action.
- Potential intent.
- Conversation themes.
- Leads needing attention.

يجب أن تبقى منفصلة مفاهيمياً عن factual operational state.

---

# 73. Audit Log

يسجل عمليات إدارية أو أمنية مهمة.

يمكن أن يحتوي على:

- Actor.
- Role.
- Action.
- Target.
- Time.
- Old/new values المناسبة.
- Context.

أمثلة:

- Campaign changed.
- Integration connection changed.
- Knowledge published.
- Permission changed.
- Payment method changed.

---

# 74. Saved View

يتضمن:

- Name.
- Filters.
- Sorting.
- Columns.
- Owner.
- Scope.

لا يتجاوز صلاحيات المستخدم الحالية.

---

# 75. Tag

تصنيف اختياري للـLead.

---

# 76. Current State vs History

أمثلة:

```text
Current Agent = Sarah
Assignment History = Ahmed → Sarah
```

```text
Current Conversation Controller = HUMAN
Handoff History = AI → HUMAN
```

```text
Current Knowledge = v4
Historical AI Execution may reference v3
```

لا يجوز استبدال التاريخ بالقيمة الحالية فقط.

---

# 77. Contact vs Lead Rules

- Contact واحد يمكن أن يملك Leads متعددة.
- Lead واحدة ترتبط بـContact واحد.
- Contact matching لا يعني Lead merge.
- Assignment changes لا تغير Contact.

---

# 78. Campaign vs Lead Rules

Campaign تحدد Configuration.

Lead تمثل فرصة فعلية.

تغيير Campaign configuration لا يعيد كتابة التاريخ السابق تلقائياً.

---

# 79. Source Data vs Operational Data

Source Data أصلية.

Operational Data تتغير أثناء العمل.

يجب الاحتفاظ بالاثنين بدون تشويه الأصل.

---

# 80. Lead Owner vs Conversation Controller Rules

- Lead Owner يحدد الموظف المسؤول.
- Controller يحدد من يدير Customer conversation حالياً.
- يمكن أن يكون AI Controller بينما Lead Owner موجود.
- Human handoff لا يحتاج تغيير Lead Owner بالضرورة.

---

# 81. Payment & Enrollment Relationship

Payment يجيب: هل تم الدفع؟

Enrollment يجيب: هل تم التسجيل/الاشتراك؟

في التدفق الأساسي:

```text
Confirmed Payment → Enrollment
```

لكن الكيانين منفصلان.

---

# 82. Notification vs Conversation Relationship

Notification موجهة للمستخدم الداخلي غالباً.

Conversation موجهة للتواصل مع Customer/Lead.

لا يجب استخدام Notification model كبديل للرسائل.

---

# 83. Integration Connection vs Business Configuration

Connection تمثل الربط الخارجي.

Campaign/Branch configuration تحدد كيف يستخدم النظام هذا الربط.

مثال:

```text
Meta Connection
  → External Form Binding
  → Campaign
```

ولا يجب تخزين Meta-specific IDs داخل Core Campaign fields إذا يمكن فصلها في External References/Bindings.

---

# 84. Domain Constraints

يجب أن يضمن النموذج مفاهيمياً:

- Agent تابع لـBranch.
- Manager مسؤول عن Branch.
- Lead مرتبطة بـContact.
- Campaign مرتبطة بـBranch.
- Lead Branch واضح.
- Assignment history محفوظ.
- Conversation مرتبطة بـLead.
- Customer-facing Conversation مرتبطة بـResolved/Pinned Messaging Sender ضمن Scope صالح.
- Message مرتبطة بـConversation.
- AI customer-facing execution مرتبطة بالـLead/Conversation/Campaign وبـEffective AI Configuration/Knowledge Version المناسبة.
- Payment Method ضمن Scope واضح.
- Payment مرتبطة بـLead.
- Enrollment مرتبطة بـLead.
- Integration Connection ذات Scope واضح.
- Knowledge Version مرتبطة بـCampaign.
- AI tool execution لا يتجاوز authorization context.

---

# 85. Historical Integrity

يجب الحفاظ عند الحاجة على:

- Source submissions.
- Assignment history.
- Field changes.
- Conversation history.
- Message history.
- Handoff history.
- Payment events.
- Enrollment events.
- Integration events.
- Knowledge versions.
- AI action history.
- Audit logs.

---

# 86. Extensibility

النموذج يجب أن يسمح بإضافة:

- Lead sources.
- Messaging providers.
- Messaging channels.
- Payment providers.
- AI providers.
- AI models/profiles.
- AI assistants.
- Field types.
- Automation triggers/actions.
- Analytics dimensions.

بدون تغيير المعنى الأساسي للكيانات.

---

# 87. Domain Model Summary

```text
Organization
  → Branches
  → Integration Connections

Branch
  → Manager
  → Agents
  → Campaigns
  → Leads
  → Payment Methods

Contact
  → Leads

Campaign
  → Source Bindings
  → Forms
  → Source Field Mappings
  → Field Configurations
  → Campaign Agent Configurations
  → Routing Configuration
  → Eligible Agents
  → Automations
  → Messaging Configuration
  → Campaign AI Configuration
  → Knowledge Versions
  → Qualification Definition

Lead
  → Contact
  → Campaign
  → Branch
  → Internal Lifecycle State
  → Lead Owner
  → Field Values
  → Conversations
  → Follow-ups
  → Notes
  → Activities
  → Payments
  → Enrollment
  → AI Executions

Conversation
  → Messages
  → Controller
  → Handoffs

Integration Connection
  → Messaging Sender(s) when applicable
  → External References
  → Bindings
  → Integration Events
  → Unmatched/Needs-Attention inbound resolution records when needed

AI Provider Connection
  → Model/Profile Configuration
  → AI Assistant Definitions

Campaign AI Configuration
  → Knowledge
  → Qualification
  → Follow-up Policy
  → Handoff Rules
```

---

# 88. Final Domain Principles

النموذج النهائي يجب أن يحافظ على:

1. Contact ≠ Lead.
2. Campaign ≠ Lead.
3. Source Data ≠ Operational Data.
4. Current State ≠ History.
5. Payment ≠ Enrollment.
6. Notification ≠ Conversation.
7. Lead Owner ≠ Conversation Controller.
8. AI Insight ≠ Business Truth.
9. Integration Connection ≠ Core Business Logic.
10. Provider independence.
11. Branch isolation.
12. Campaign-specific flexibility.
13. Historical integrity.
14. Secure credential separation.
15. Multi-connection extensibility.
16. Messaging Connection ≠ Business Sender عندما يميز Provider بينهما.
17. Shared AI runtime ≠ Shared Campaign Context.

# 89. Scale-Oriented Data Model Requirements

مع نمو البيانات يجب أن يبقى الـDomain قابلاً للاستعلام بكفاءة.

يجب أن يسمح التصميم التقني بإنشاء Indexes وConstraints مناسبة للمسارات الأكثر استخداماً، خصوصاً حول:

- Lead by Branch / Campaign / Agent.
- Lead lifecycle / created / updated time.
- Conversation by Lead / channel / participant.
- Message by Conversation / time / provider message ID.
- Follow-up by owner / status / due time.
- External references / provider IDs.
- Payment by Lead / provider / status / reference.
- Integration Event by connection / provider / external event ID.
- AI Execution by Lead / Conversation / Campaign / time.

لا تفرض هذه الوثيقة Database engine أو أسماء Indexes، لكنها تفرض أن Full-table scans ليست المسار الطبيعي للاستعلامات التشغيلية المتكررة.

يجب أن يدعم التصميم Idempotency keys عند الحاجة وPagination-friendly ordering وSafe archival/retention مع إمكانية optimization إضافية عندما يثبت الحجم الحاجة.
