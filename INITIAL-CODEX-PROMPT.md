# الـPrompt النهائي لـCodex — تنفيذ منصة Lead Operations & Sales Management كاملة

أنت مسؤول عن تنفيذ **منصة Lead Operations & Sales Management كاملة وجاهزة للإنتاج** داخل هذا الـRepository:

```text
Bashar-alJabi/Lead-Operations-Platform
```

المطلوب ليس MVP، وليس Prototype، وليس Demo، وليس Scaffold، وليس جزءًا من النظام.

المطلوب هو تنفيذ المنتج الكامل المحدد في وثائق المشروع، وتشغيله واختباره ومراجعته حتى يصل إلى حالة جاهزية حقيقية ضمن ما يمكن تنفيذه بدون Credentials أو Approvals خارجية غير متوفرة.

---

# 1. اقرأ المشروع كاملًا قبل اتخاذ قرارات كبيرة

ابدأ بقراءة وفهم جميع الملفات التالية كمنظومة واحدة:

```text
AGENTS.md
README.md
docs/00-comprehensive-functional-concept.md
docs/01-domain-model.md
docs/02-business-rules-permissions.md
docs/03-integrations-ui-requirements.md
docs/04-ai-agents-conversations.md
docs/05-messaging-ai-final-architecture.md
docs/06-final-completeness-and-acceptance.md
```

ثم افحص كامل الـRepository الحالي وافهم ما هو موجود فعليًا قبل تعديل أي شيء.

ملفا `05` و`06` موجودان بالفعل ضمن النسخة النهائية للمواصفات:

- `05` يحسم معمارية Messaging/WhatsApp والـAI configuration/isolation.
- `06` يحدد Definition of Done والـAcceptance النهائية.

لا تحذفهما ولا تختصرهما. إذا احتاج التنفيذ قرارًا تقنيًا إضافيًا، وثّقه في Technical Architecture بدون تغيير Business Behavior.

---

# 2. القرارات النهائية التي تحسم أي غموض سابق

## 2.1 Messaging / WhatsApp

اعتمد:

```text
Organization Shared Sender (optional)
        ↓
Branch Default Sender
        ↓
Campaign Sender Override (optional)
        ↓
Conversation Resolved/Pinned Sender
```

القواعد:

- لا تفترض رقم WhatsApp واحدًا لكل النظام.
- لا تفرض رقمًا منفصلًا لكل Campaign.
- الـDefault العملي هو Branch Sender مع Campaign Override اختياري.
- Existing Conversation لا تغير Sender بصمت.
- Outbound Sender Resolution يجب أن يكون Deterministic.
- Inbound Resolution يجب أن يكون Deterministic.
- Ambiguous Inbound → Persist + Needs Attention بدل التخمين.
- كل AI/Human/Automation Send يمر عبر Central Messaging Policy.
- Consent / DNC / Templates / Sending Hours / Sender Health / Provider Constraints / Frequency / Max Attempts / Controller كلها تتحقق قبل الإرسال.
- Provider Limits المتغيرة لا يتم Hardcode لها كـBusiness Constants.
- Queues / Backpressure / Retry / Idempotency مطلوبة حسب الحاجة.

Sender Resolution:

- إذا كانت Conversation قائمة ولها Pinned Sender/Thread: استخدمه إذا بقي صالحًا. إذا أصبح غير صالح، Block/Needs Attention أو Explicit migration workflow؛ **لا تعمل fallback تلقائيًا إلى رقم آخر**.
- إذا كانت Conversation جديدة بلا Pinned Sender: Campaign Sender Override → Branch Default Sender → Organization Shared Fallback المسموح صراحة → وإلا Block/Needs Attention.

لا تختَر Sender عشوائيًا.

## 2.2 AI

اعتمد:

```text
Global AI Guardrails
        ↓
Branch AI Defaults
        ↓
Campaign AI Configuration
```

القواعد:

- Global Guardrails غير قابلة للتعطيل من Campaign.
- Branch Defaults قابلة للوراثة فقط في الحدود المسموحة.
- Campaign تحدد Knowledge وQualification وTone وHandoff وFollow-up وسلوكها الخاص.
- يمكن مشاركة نفس AI Provider/Model/Runtime.
- لكن Context كل Campaign يجب أن يبقى معزولًا.
- ممنوع Campaign A أن ترى Knowledge أو Instructions أو Qualification أو Leads أو Conversations الخاصة بـCampaign B.
- Effective AI Configuration يجب أن تكون Deterministic وقابلة للـAudit.

هذه القرارات تحسم أي غموض أقدم في نفس المواضيع، ولا تلغي أي Requirement آخر في الملفات السابقة.

---

# 3. وحّد الوثائق قبل التنفيذ الكبير

حدّث مراجع الوثائق داخل:

```text
README.md
AGENTS.md
```

بحيث تشمل:

```text
docs/05-messaging-ai-final-architecture.md
docs/06-final-completeness-and-acceptance.md
```

صحح مشاكل ترقيم العناوين البسيطة إذا وجدت، لكن:

- لا تغير Business Behavior.
- لا تحذف Requirements.
- لا تعيد كتابة المواصفات بشكل يفقد تفاصيلها.

---

# 4. لغة التوثيق داخل المشروع

كل Product/Requirements documentation وأي `technical-architecture.md` أو `implementation-plan.md` أو `codex-progress.md` أو Completion/Review report تنشئه داخل الـRepository يجب أن يكون بالعربية، مع استخدام المصطلحات التقنية وأسماء الـAPIs والـClasses والـIdentifiers بالإنجليزية عندما يكون ذلك أوضح.

لا تترجم أسماء الكود أو المكتبات أو البروتوكولات بشكل يضر بالدقة التقنية.

---

# 5. لا تسألني عن الـTechnology Stack

أنت مسؤول عن اختيار أفضل طريقة تقنية لبناء المنتج.

اختر بنفسك ما يناسب المشروع من:

- Programming Language.
- Backend Framework.
- Frontend Framework.
- Database.
- ORM / Query Layer.
- Authentication Architecture.
- Authorization Architecture.
- Queue / Background Jobs.
- Cache.
- Search Strategy.
- File/Object Storage.
- Messaging Architecture.
- AI Integration Architecture.
- Payment Integration Architecture.
- Testing Stack.
- Container/Deployment Strategy.
- Observability.
- CI/CD.

اختر على أساس:

- Correctness.
- Security.
- Reliability.
- Maintainability.
- Scalability.
- Performance.
- Data Integrity.
- Testability.
- Operational Simplicity.
- Provider Independence.
- Reasonable Cost.

لا تستخدم Microservices لمجرد أن المنتج كبير.

Modular Monolith قوي ومنظم مقبول إذا كان هو الأنسب.

لا تسألني أي Framework أو Database أو ORM أو Hosting أفضل إذا لم يوجد Requirement تجاري يفرض الاختيار.

---

# 6. نفّذ ولا تتوقف عند التخطيط

أنشئ داخل الـRepository وثائق تقنية مثل:

```text
docs/technical-architecture.md
docs/implementation-plan.md
```

أو أسماء أفضل إذا رأيت ذلك.

لكن **لا تتوقف بعد إنشائها**.

بعد الخطة تابع مباشرة إلى:

- إنشاء المشروع الفعلي.
- Database.
- Migrations.
- Backend.
- Frontend.
- Authentication.
- Authorization.
- كل Modules.
- Integrations.
- Queues.
- AI.
- Tests.
- Deployment/Run setup.
- Verification.

لا ترجع لي بمجرد Roadmap أو Architecture Proposal.

---

# 7. لا تختصر المنتج إلى MVP

لا تؤجل Feature موثقة بحجج مثل:

- MVP.
- V1.
- Phase 2.
- Later.
- Nice to have.

يمكن تقسيم التنفيذ إلى Milestones وTasks فقط لتنظيم العمل، لكن النطاق النهائي يبقى كاملًا.

إذا كانت Feature صعبة:

- لا تحذفها.
- لا تحولها إلى Fake Version.
- ابحث عن أبسط تنفيذ صحيح Production-ready.

---

# 8. لا تسأل سؤالًا تمت الإجابة عنه

قبل أي سؤال لي:

1. ابحث في كل الوثائق.
2. ابحث في الـCodebase.
3. حدد إن كان القرار Technical ويمكنك حسمه.
4. اختر أفضل حل آمن وقابل للصيانة إذا لم يغير Business Behavior.

اسأل فقط عند Blocker حقيقي مثل:

- تناقض Business فعلي لا يمكن حسمه.
- قرار قانوني/تجاري غير موجود ويغير السلوك جذريًا.
- Credential/Approval Production خارجي لا يمكن محاكاته أو استبداله أثناء التطوير.

حتى عند غياب Credential خارجي:

- لا توقف المشروع.
- ابنِ Adapter.
- ابنِ Setup UI.
- ابنِ Mock/Fake/Sandbox Path.
- ابنِ Validation.
- ابنِ Failure Handling.
- ابنِ Tests.
- أكمل بقية النظام.

---

# 9. لا تعتمد على حسابات شخصية

ممنوع ربط المنتج النهائي أو التطوير تلقائيًا بـ:

- حساب OpenAI شخصي.
- حساب Meta شخصي.
- رقم WhatsApp شخصي.
- Payment Account شخصي.
- API Key محلية غير موثقة.

Operational Integrations يجب أن تُدار من واجهة المنصة حسب الصلاحيات.

---

# 10. الـBackend هو مرجع الصلاحيات

يجب فرض:

- Authentication.
- Authorization.
- Role Scope.
- Branch Isolation.
- Lead Access.
- Conversation Access.
- Field Visibility/Editability.
- Integration Access.
- AI Tool Permissions.
- Payment Permissions.
- Validation.
- Business Rules.

على الـBackend.

Frontend hiding ليس Security.

اختبر Direct URL/API attempts.

---

# 11. Authentication والحسابات

نفّذ بشكل Production-ready:

- Login.
- Logout.
- Forgot/Reset Credentials.
- Session Expiration.
- Session Revocation.
- Disabled Account Behavior.
- No Public Signup.
- Authorized User Creation/Invitation.
- Secure one-time First Super Admin bootstrap بدون Public Signup أو Hardcoded default credentials؛ بعد إنشاء أول Super Admin يتم تعطيل/إبطال bootstrap path أو token حسب التصميم، وتكون العملية قابلة للتدقيق.
- Safe Error Handling.
- Abuse/Brute-force Protection المناسب للـStack.
- Secure Password/Credential handling.

---

# 12. الأدوار

الأدوار الأساسية:

```text
Super Admin
Manager
Agent
```

ولا تضف Roles جديدة بدون Requirement.

## Super Admin

Global Scope حسب المواصفات.

## Manager

Branch-scoped فعليًا.

## Agent

فقط Leads/Conversations/Fields/Actions المسموحة.

---

# 13. Contacts وLeads

حافظ على الفصل:

```text
Contact = الشخص
Lead = فرصة/طلب محدد
```

نفّذ:

- Contact Matching.
- Phone Normalization المناسب.
- Ambiguous Matching Handling.
- Multiple Leads per Contact.
- Source Submission Preservation.
- Internal Lead Lifecycle:
  - OPEN
  - CLOSED
  - ARCHIVED
- Manual Lead Creation.
- Close/Reopen/Archive.
- Notes.
- Activity Timeline.
- History/Audit.

لا تعمل Automatic Lead Merge فقط لأن Contact متطابق.

---

# 14. Campaigns

Campaign هي وحدة تشغيل أساسية.

نفّذ:

- Branch.
- Source Bindings.
- Eligible Agents.
- Routing.
- Fields.
- Visibility/Editability.
- Messaging.
- AI.
- Qualification.
- Follow-up.
- Automations.
- Payments.
- Conversion Definition.
- Activation/Deactivation.
- Readiness.

لا تسمح Activation بصمت مع Setup ناقص.

---

# 15. Dynamic Fields

نفّذ النظام المرن الموثق، بما فيه:

- Add/Edit/Disable.
- Reorder.
- Required.
- Visible.
- Editable.
- Table/Details Visibility.
- Filters.
- Automation Usage.
- AI Qualification Usage.
- Calculated Fields.
- Options.
- Field History.
- Campaign-specific Configuration.

لا تفترض أعمدة ثابتة لكل Campaign.

---

# 16. Lead Sources وMeta

نفّذ:

- Meta Connection Setup.
- OAuth/API setup المناسب.
- Pages/Forms Resources حسب Provider Capabilities.
- Webhook Setup.
- Signature/Authenticity Verification.
- Replay/Duplicate Protection.
- Campaign/Form Binding.
- Binding Conflict Validation.
- Field Mapping.
- Preserve Raw Source Data.
- Historical Sync إذا كان Provider/المواصفات تسمح.
- Retry/Failure State.
- Status/Health.

ودعم:

- Manual.
- CSV.
- Excel.
- Google Sheets.
- Generic API.
- Generic Webhook.
- Future Sources عبر abstraction مناسب.

---

# 17. Routing وAssignment

نفّذ القواعد الموثقة حول:

- Agent Eligibility.
- Campaign Eligibility.
- Active/Inactive.
- Working Hours.
- Capacity.
- Routing Method.
- Weighted behavior عندما يكون جزءًا من الإعداد.
- Performance-based Routing عندما يفعّل.
- Fallback.
- No Eligible Agent.
- Reassignment.
- Agent Deactivation.
- Assignment History.
- Concurrency Safety.

Performance metrics الخاصة بالـAI لا تُنسب لأداء Human Agent.

---

# 18. Conversations وMessaging

Customer Conversation جزء من Lead Operations وليس Chat System عامًا.

نفّذ:

- Conversation.
- Messages.
- Inbound/Outbound.
- Provider Message IDs.
- Attachments عند الدعم.
- Delivery States.
- AI/Human Sender Identity.
- Current Controller.
- Handoff.
- History.
- Agent Reply from Platform.
- Assignment-based Access.
- Multiple Messaging Connections.
- Multiple Senders/Numbers.

وطبق المعمارية النهائية للـSender المذكورة في هذا الـPrompt.

---

# 19. Central Messaging Policy

كل Customer-facing Send من:

- AI.
- Human.
- Automation.
- Follow-up.

يمر عبر نفس Policy Layer.

تحقق من:

- Authorization.
- Conversation Controller.
- Consent/Opt-in.
- Do-not-contact.
- Provider Policy.
- Template Requirement.
- Sending Hours.
- Timezone.
- Campaign Max Attempts.
- Frequency.
- Sender Scope.
- Connection/Sender Health.
- Provider Capability.
- Rate/Throughput Constraints.
- Duplicate/Idempotency.

لـOutbound Messaging:
- بعد نجاح Authorization/Policy، Persist الـOutbound Message/Send Intent بحالة `QUEUED` مع idempotency context **قبل** استدعاء Provider.
- ثم enqueue/send عبر Provider Adapter.
- حدّث Provider Reference وDelivery State بعد الاستجابة/callbacks.
- لا تعتمد على Provider call قبل وجود durable internal record.

لا يوجد bypass.

---

# 20. حل الرسائل الواردة

استخدم:

- Connection.
- Business Sender.
- Provider Thread.
- Participant Identity.
- Contact.
- Existing Conversation.
- Active Leads.
- Campaign Context.
- External References.

عند Inbound Provider Event:

- Verify authenticity وidempotency أولاً.
- Persist raw Integration Event / inbound event بشكل آمن قبل routing.
- ثم Resolve Connection/Sender/Contact/Conversation/Lead/Campaign.
- إذا بقيت Ambiguous:

```text
Persist/attach Message or Unmatched record
→ Needs Attention
→ Human Resolution
```

لا تجعل AI يخمن Campaign عشوائيًا.

---

# 21. High-volume Messaging

استخدم حسب الحاجة:

- Queue.
- Background Workers.
- Backpressure.
- Bounded Retry.
- Backoff.
- Idempotency.
- Dead-letter/Recovery.
- Per-Connection/Per-Sender Isolation.
- Observability.

لا Hardcode لمحدودية Provider متغيرة كـBusiness Constants.

---

# 22. AI Architecture

الـAI ليس Source of Truth.

يجب تنفيذ المكونات الموثقة كاملة:

- AI Lead Assistant للـCustomer-facing flow.
- AI Operations Assistant للمستخدمين الداخليين حسب Scope.
- AI Copilot للـHuman Agent.
- Campaign Knowledge/Qualification/Handoff/Follow-up/Evaluations.

نفّذ:

```text
AI
↓
Approved Tool
↓
Application Service
↓
Authorization
↓
Validation
↓
Business Rules
↓
Database / Provider
```

لا Direct Unrestricted DB Access للـAI.

كل Customer/Knowledge/External Input يعتبر Untrusted Data وليس System Instruction.

---

# 23. AI Configuration Hierarchy

الترتيب:

```text
Global AI Guardrails
        ↓
Branch AI Defaults
        ↓
Campaign AI Configuration
```

Global Guardrails لا يمكن تعطيلها.

Branch Defaults قابلة للوراثة حيث يسمح النظام.

Campaign Configuration تحدد:

- Knowledge.
- Qualification.
- Tone/Language.
- Handoff.
- Follow-up.
- Allowed Tools.
- Messaging Behavior.
- AI Provider/Profile Override عند السماح.

---

# 24. Campaign AI Isolation

يمكن استخدام Model/Provider/Runtime مشترك.

لكن لكل Execution:

- Current Lead.
- Current Campaign.
- Current Conversation.
- Published Campaign Knowledge.
- Campaign Qualification.
- Campaign Rules.
- Allowed Tools.

ولا يجوز خلط Campaign B داخل Campaign A.

اختبر Cross-Campaign Leakage صراحة.

---

# 25. Campaign Knowledge

نفّذ:

- Draft.
- Preview.
- Validation.
- Publish.
- Version History.
- Approved Links.
- Approved Assets.
- FAQs.
- Facts.
- Prices/Locations/Schedules/Requirements حسب الحملة.
- Allowed/Prohibited Claims.

Customer-facing AI يستخدم Published Version فقط.

كل Historical AI Execution المهمة تشير إلى Knowledge Version الصحيحة.

---

# 26. Qualification

لكل Campaign Qualification خاصة بها.

نفّذ:

- Questions.
- Required/Optional.
- Order.
- Field Mapping.
- Structured Data Extraction.
- Backend Validation.
- Completion Rules.
- Handoff Trigger.
- Audit/Source.

AI لا يكتب Database مباشرة.

---

# 27. AI Unknown Answer

إذا كانت معلومة Company/Campaign غير موجودة بشكل موثوق:

- لا يخترع AI.
- لا يستخدم Generic Model Knowledge كأنها حقيقة للشركة.
- يوضح عدم وجود معلومة مؤكدة.
- يسجل أو يصعد حسب Policy.
- يعمل Handoff عند الحاجة.

---

# 28. Human Handoff وController

حافظ على:

```text
Lead Owner != Conversation Controller
```

ومعاني الـStates الموثقة مثل:

- AI_ACTIVE.
- AI_WAITING_FOR_LEAD.
- AI_HANDOFF_REQUIRED.
- WAITING_FOR_HUMAN.
- HUMAN_ACTIVE.
- CLOSED.

عندما HUMAN_ACTIVE:

- AI Auto-send متوقف.
- AI Copilot يمكن أن يعمل.
- Takeover Explicit.
- لا Concurrent Conflicting Replies.

---

# 29. AI Operations Assistant

Internal-facing وPermission-scoped.

يستخدم Platform Queries/Services للحقائق.

يمكنه:

- Summarize.
- Analyze.
- Explain.
- Suggest.
- Drill-down.
- Limited Approved Write Actions.

لا يخمن أرقام Operational Metrics.

---

# 30. Follow-ups

نفّذ Human وAI Follow-ups حسب المواصفات.

يشمل:

- Create/Edit/Complete/Cancel/Reschedule.
- Due/Upcoming/Overdue.
- AI Delays.
- Max Attempts.
- Sending Hours.
- Stop Conditions.
- Final Action.
- No Duplicate Sends.
- Re-check Policy وقت التنفيذ الفعلي.

---

# 31. Payments

نفّذ:

- Provider Connections.
- Branch Payment Methods.
- Payment Links.
- Trusted Provider Confirmation.
- Payment Status.
- Webhook Idempotency.
- Failure States.
- Permission Checks.

Customer يقول "دفعت" لا يعني Payment Confirmed.

AI لا يثبت Payment من نفسه.

---

# 32. Enrollment

يبقى Entity منفصلًا عن Payment.

Enrollment يحدث فقط وفق Trusted Confirmation/Business Rule الموثقة.

لا تخلط Payment وEnrollment.

---

# 33. Analytics

نفّذ:

- Global/Branch/Campaign/Agent Analytics حسب الصلاحيات.
- Date Filters.
- Source.
- Custom Fields المناسبة.
- Conversion Definition.
- Drill-down.
- Revenue متعدد العملات بدون Total مضلل.
- Human vs AI Metrics منفصلة.

خصوصًا:

- First AI Contact.
- First Human Contact.
- First Customer Response.
- AI Attempts.
- Human Attempts.
- AI Response Time.
- Human Response Time.
- Qualification Source.

---

# 34. Automations

النمط:

```text
Trigger
↓
Conditions
↓
Actions
```

مع:

- Validation.
- Permissions.
- Loop Prevention.
- Idempotency.
- Failure Handling.
- Audit.
- عدم تجاوز Conversation/AI/Payment/Messaging Rules.

---

# 35. Search / Filters / Saved Views / Bulk

نفّذ حسب الصلاحيات:

- Search.
- Filters.
- Sorting.
- Saved Views.
- Column Selection.
- Bulk Actions.
- Server-side Pagination.
- Permission-safe Results.
- Hidden Field Protection.

---

# 36. Import / Export / Google Sheets

## Import

- CSV.
- Excel.
- Google Sheets عندما يطبق.
- Branch/Campaign Scope.
- Mapping.
- Validation.
- Preview.
- Duplicate Review.
- Result Report.
- Background Job عند الحجم الكبير.

## Export

- Current Filters.
- Saved View.
- Selected Columns.
- Permissions.
- No Hidden Fields.
- Background Job عند الحجم الكبير.

Google Sheets لا تصبح قاعدة البيانات الأساسية.

---

# 37. Notifications

نفّذ:

- In-App.
- Email/Messaging عندما يكون ضمن الإعداد.
- Preferences.
- Critical Notifications عند الحاجة.
- Assignment.
- Reassignment.
- Follow-up.
- AI Handoff.
- Payment.
- Enrollment.
- Integration/System Alerts.

Customer Conversation منفصلة عن Internal Notification.

---

# 38. UI لكل Role

نفّذ Navigation/Screens الموثقة.

## Super Admin

مثل:

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

كل ما يخص Branch ضمن Scope.

## Agent

- Dashboard.
- My Leads.
- My Conversations.
- Follow-ups.
- AI Copilot.
- Notifications.
- Profile.

التفاصيل النهائية تتبع الوثائق.

---

# 39. UX واللغات

دعم:

- Arabic RTL.
- French/English LTR.
- Responsive Desktop/Tablet/Mobile.
- Empty States.
- Loading States.
- Error States.
- Permission States.
- Large Data UX.
- Safe recoverable flows عندما يكون مناسبًا.

أولوية Agent Mobile Experience مهمة.

---

# 40. Integration Setup من داخل المنصة

أي Setup تشغيلي موثق يجب أن يتم من UI حسب الصلاحيات.

لا تجعل المستخدم التشغيلي يعدل:

- Source Code.
- Server Files.
- Database Rows.
- CLI.
- Hardcoded IDs.

وفر:

- Provider Selection.
- Prerequisites.
- Authentication/Credential Flow.
- Webhook Information.
- Resource Selection.
- Test Connection.
- Status.
- Health.
- Last Error.
- Reconnect.
- Disable.
- Branch/Campaign Binding.
- Help.

---

# 41. Security

طبق حسب الـStack:

- Secure Authentication.
- Backend Authorization.
- Branch Isolation.
- Secret Encryption/Secure Storage.
- Input Validation.
- Output Encoding.
- XSS Protection.
- CSRF Protection عند الانطباق.
- Webhook Authenticity.
- Replay Protection.
- Rate/Abuse Protection.
- Safe File Upload.
- Access-controlled File Download.
- Safe Logging.
- No Secrets to AI.
- No Hidden Data Leakage via Search/Export/API.

---

# 42. Data Integrity وReliability

تعامل مع:

- Duplicate Events.
- Retries.
- Partial Failures.
- Concurrency.
- Out-of-order Callbacks.
- Provider Timeouts.
- Job Retries.
- Payment Callbacks.
- Message Delivery Callbacks.
- AI Tool Execution.

استخدم:

- Idempotency.
- Transactions المناسبة.
- Constraints.
- Recovery Paths.
- Audit.

---

# 43. Scalability

افترض نموًا حقيقيًا في:

- Branches.
- Campaigns.
- Agents.
- Leads.
- Conversations.
- Messages.
- Webhooks.
- AI Jobs.
- Payments.
- Analytics.

استخدم ما يلزم من:

- Production Database.
- Proper Indexes.
- Connection Pooling.
- Server-side Pagination.
- Efficient Queries.
- Background Jobs.
- Queue Backpressure.
- Bounded Concurrency.
- Safe Bulk Processing.
- Cache عند الحاجة بدون كسر Correctness.
- Horizontal Scaling عندما يكون مناسبًا.
- Observability.
- Load/Performance Tests.

لا تبنِ على Dataset صغيرة.

---

# 44. Timezone وDate/Time correctness

- استخدم تمثيلاً داخلياً غير مبهم للـtimestamps مع الحفاظ على Source/Provider timestamps المهمة.
- Branch timezone هي الـDefault التشغيلي، وCampaign override يستخدم عندما تسمح المواصفات.
- Scheduled Messaging/Follow-ups يجب أن تكون DST-safe.
- Analytics وDate Filters يجب أن تستخدم timezone semantics واضحة.
- لا تسمح لاختلاف timezone أن يسبب Duplicate send أو موعداً مفقوداً أو اختلافاً صامتاً في Daily metrics.

---

# 45. Observability والتشغيل

اجعل النظام قابلًا للتشغيل الحقيقي.

وفر حسب الـArchitecture:

- Structured Logs.
- Health Checks.
- Backup/Restore strategy واختبار قابلية الاستعادة بما يناسب الـDatabase/Object Storage.
- Environment separation مناسب بين development/staging/production.
- Queue Visibility.
- Integration Health.
- Database/Latency Observability المناسبة.
- Error Tracking Strategy.
- Safe Operational Diagnostics بدون Secrets.

---

# 46. Testing جزء من التنفيذ

لا تعتبر Feature مكتملة بدون اختبار مناسب.

نفّذ:

- Unit Tests.
- Integration Tests.
- Authorization/Permission Tests.
- Routing Tests.
- Webhook/Idempotency Tests.
- Messaging Tests.
- AI Evaluations.
- Payment Tests.
- Import/Export Tests.
- Critical E2E/UI Flows.
- Migration Tests.
- Build/Type/Lint Checks.
- Load/Performance Tests أو Scripts للمسارات الحرجة.

---

# 47. End-to-End Scenarios إلزامية

اختبر على الأقل:

## Meta → AI → Human → Payment → Enrollment

```text
Meta Lead
→ Campaign
→ Contact Match/Create
→ Lead
→ Routing
→ AI Initial Contact
→ Qualification
→ Handoff
→ Human Reply
→ Payment Link
→ Trusted Payment Confirmation
→ Enrollment
→ Analytics
```

## AI Disabled

```text
Lead
→ Campaign
→ Routing
→ Human Agent
→ Follow-up
→ Payment/Enrollment
```

## No Eligible Agent

يجب أن يعمل Fallback/Attention الصحيح بدون Random Assignment.

## Multiple Active Leads for Contact

Ambiguous Inbound → Needs Attention، لا تخمين.

## Provider Failure

Data Preserved + Retry/Recovery + Visible Status.

## Permission Attack

Agent يحاول URL/API خارج Scope → Backend Deny.

## Prompt Injection

لا Scope Expansion ولا Secret Leak ولا Unauthorized Tool.

---

# 48. Definition of Done

لا تعتبر المشروع مكتملًا إلا إذا:

- كل Requirement داخلي قابل للتنفيذ تم تنفيذه.
- لا يوجد Placeholder لمسار Required.
- لا يوجد Stub/Fake Data في Production Paths المطلوبة.
- لا توجد TODO حرجة.
- Migrations تعمل.
- Critical Indexes/Constraints موجودة.
- Backend Permissions تعمل.
- UI المطلوبة موجودة.
- RTL يعمل.
- Messaging Sender Resolution مكتملة.
- Campaign AI Isolation مختبرة.
- Payment Confirmation موثوقة.
- Tests الحرجة تمر.
- Build يمر.
- Run/Deployment Documentation موجودة.
- First Super Admin bootstrap موثقة وآمنة ولا تعتمد على Default Password.
- Backup/Restore strategy موثقة وقابلة للاختبار بما يناسب الـStack.
- External Integrations غير المتاحة بسبب Credential فقط لديها Adapter + Setup UI + Mock/Sandbox + Tests + واضح أنها لم تُختبر Live.

---

# 49. لا تدّعِ اكتمال Live Integration بدون تحقق

إذا Meta أو WhatsApp أو Payment أو AI Provider يحتاج Production Credential/Approval غير متوفر:

اكمل كل ما يمكن إنجازه تقنيًا.

لكن في التقرير النهائي ميّز بوضوح بين:

```text
Implemented
Mock/Sandbox Verified
Live Provider Verified
Live Verification Pending External Credential/Approval
```

لا تستخدم Fake Success.

---

# 50. نظافة الـRepository

حافظ على Repository Production-oriented.

- لا تترك ملفات مؤقتة.
- لا ترفع Secrets.
- لا تترك Debug Artifacts.
- لا تترك Dead Code بلا سبب.
- لا تكسر Structure بدون حاجة.
- وثق قرارات Architecture المهمة.
- حافظ على Migrations/Versioning بشكل سليم.

---

# 51. طريقة العمل

نفّذ بشكل مستمر:

1. اقرأ المواصفات.
2. افحص الموجود.
3. وثق Architecture.
4. ضع Implementation Plan.
5. نفّذ Milestone.
6. اختبره.
7. أصلح الأخطاء.
8. انتقل لما بعده.
9. راجع Coverage مقابل كل docs.
10. لا تتوقف حتى يكتمل النطاق أو يظهر Blocker خارجي حقيقي.

إذا فرضت بيئة التنفيذ Hard execution/context limit قبل اكتمال المشروع، لا تدّعِ الاكتمال. اترك Repository في حالة متسقة قدر الإمكان وأنشئ/حدّث `docs/codex-progress.md` يتضمن بدقة:

- ما تم تنفيذه واختباره.
- ما هو In Progress.
- ما بقي من Requirement Coverage Matrix.
- آخر Test/Build results.
- أي migrations أو setup state مهمة.
- Blockers الحقيقية فقط.
- **Exact next action** لاستكمال العمل في Codex run التالية بدون إعادة اكتشاف المشروع.

لا تنتظر مني Approval على قرارات تقنية عادية.

---

# 52. Requirement Coverage Matrix إلزامية

قبل أن تقول إن المنصة جاهزة، أنشئ Matrix داخل Repository:

```text
Requirement Area | Source Docs | Implementation | Tests | Status
```

يجب أن تشمل على الأقل:

- Authentication.
- Roles/Permissions.
- Branches.
- Contacts.
- Leads.
- Campaigns.
- Fields.
- Meta/Sources.
- Routing.
- Messaging.
- AI.
- Follow-ups.
- Notifications.
- Payments.
- Enrollment.
- Analytics.
- Automations.
- Search/Views/Bulk.
- Import/Export.
- Google Sheets.
- Email integration/notifications where documented.
- Integrations UI.
- Audit.
- Security.
- Languages/RTL.
- Responsive UI.
- Scalability.
- Observability.
- Testing.
- Deployment/Runbook.

أي Area ليست مكتملة يجب ألا تكون `Complete`.

---

# 53. التقرير النهائي الذي أريده منك

عندما تنتهي، لا تعطِني مجرد "Done".

أعطني:

1. ملخص Architecture.
2. Stack المختار وسبب الاختيار.
3. Modules المنفذة.
4. Database وأهم Migrations.
5. Authentication/Authorization.
6. Messaging Architecture.
7. AI Architecture.
8. Integrations.
9. Queues/Background Jobs.
10. Security Safeguards.
11. Tests التي شُغلت ونتائجها.
12. Build/Lint/Type-check Results.
13. End-to-end Scenarios التي اختبرتها.
14. Requirement Matrix النهائية.
15. أي Live External Verification بقيت بسبب Credential/Approval خارجي فقط.
16. أي Known Issue حقيقية.

لا تصف المشروع بأنه جاهز إذا بقي Requirement داخلي قابل للتنفيذ وغير منجز.

---

# 54. المهمة الآن

ابدأ من الـRepository الحالي.

لا تسألني عن الـStack.

لا تتوقف عند التخطيط.

لا تختصر المنتج.

ثبّت القرارات النهائية للـMessaging والـAI في الوثائق.

ثم ابنِ **المنصة الكاملة** وفق جميع المواصفات، شغّلها، اختبرها، أصلح المشاكل، وراجع Coverage حتى تصل إلى Definition of Done أعلاه.
