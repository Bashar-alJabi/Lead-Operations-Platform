# المراجعة النهائية ومعايير اكتمال وقبول المنصة

## 1. الغرض

هذه الوثيقة لا تضيف Business Features جديدة.

هدفها تحويل كل المواصفات الموجودة إلى **Definition of Done** واضحة تمنع اعتبار المشروع مكتملًا لمجرد وجود Architecture أو Database Schema أو شاشات جزئية.

تعتمد على:

```text
README.md
AGENTS.md
docs/00-comprehensive-functional-concept.md
docs/01-domain-model.md
docs/02-business-rules-permissions.md
docs/03-integrations-ui-requirements.md
docs/04-ai-agents-conversations.md
docs/05-messaging-ai-final-architecture.md
```

---

# 2. نتيجة المراجعة الشاملة

المواصفات الحالية تغطي بالفعل:

- Authentication وAccount Lifecycle.
- Roles وصلاحيات Super Admin / Manager / Agent.
- Branch Isolation.
- Contacts وLeads.
- Lead Lifecycle.
- Campaigns.
- Dynamic Fields وCalculated Fields.
- Source Data / Operational Data.
- Meta Lead Integration.
- Generic API / Webhook Sources.
- CSV / Excel Import/Export.
- Google Sheets.
- Routing وAssignment.
- Agent Eligibility وCapacity وWorking Hours.
- Conversations وWhatsApp/Messaging.
- AI Lead Assistant.
- AI Operations Assistant.
- AI Copilot.
- Campaign Knowledge.
- Qualification.
- Human Handoff.
- Follow-ups.
- Notes / Activity.
- Notifications.
- Payments.
- Enrollment.
- Analytics.
- Conversion.
- Revenue/Currency Semantics.
- Automations.
- Search / Filters / Saved Views.
- Bulk Actions.
- Integration Management.
- Audit Logs.
- Arabic RTL / French / English.
- Responsive UI.
- Error/Empty/Loading/Permission States.
- Security.
- Data Integrity.
- Idempotency.
- Failure Isolation.
- Scalability.
- Background Jobs/Queues.
- Provider Independence.
- AI Evaluations.

تم تثبيت القرارات النهائية التالية:

1. Branch Default Sender مع Campaign Sender Override اختياري.
2. عدم فرض رقم WhatsApp واحد لكل النظام.
3. عدم فرض رقم منفصل لكل Campaign.
4. Central Messaging Policy لكل AI/Human/Automation Sends.
5. Deterministic Inbound/Outbound Resolution.
6. Needs Attention للحالات Ambiguous بدل التخمين.
7. Global AI Guardrails → Branch AI Defaults → Campaign AI Configuration.
8. عزل Campaign AI Context حتى عند مشاركة نفس Model/Provider.
9. Definition of Done صارمة قبل إعلان المنصة مكتملة.

---

# 3. ملاحظات توثيقية

يوجد عدم اتساق بسيط في ترقيم بعض Sections في الوثائق الحالية.

يمكن تصحيح الترقيم أثناء تنظيف الوثائق، لكن:

- لا تغير Business Behavior.
- لا تحذف Requirements.
- لا تسقط Requirement بسبب مشكلة ترقيم.

---

# 4. Definition of Done العامة

لا تعتبر المنصة مكتملة إلا إذا تحقق جميع ما يلي:

- Backend حقيقي يطبق Business Rules.
- Frontend حقيقي لكل Roles المطلوبة.
- Database Schema/Migrations قابلة للتشغيل.
- Authentication وAuthorization يعملان فعليًا.
- Branch Isolation مفروضة Backend-side.
- كل Modules الموثقة منفذة أو يوجد External Blocker حقيقي ومعلن.
- Integrations مبنية عبر Adapters وحدود واضحة.
- Operational Setup يتم من UI حيث تتطلب المواصفات.
- لا يوجد اعتماد مخفي على Developer Personal Accounts.
- لا يوجد Fake Success لتكامل غير متصل.
- Background Jobs/Queues مستخدمة حيث تتطلب Reliability.
- Idempotency موجودة في Webhooks/Callbacks/Jobs الحساسة.
- Tests تمر.
- Build/Type-check/Lint تمر حسب الـStack المختار.
- Critical User Flows مختبرة.
- Documentation التقنية محدثة.
- Deployment/Run instructions موجودة.
- First Super Admin bootstrap آمنة وموثقة وبدون Default Password ثابت.
- Backup/Restore strategy موثقة ومناسبة للـStack.
- لا توجد TODOs حرجة أو Placeholder Screens أو Stub Business Logic في المسارات المطلوبة للإنتاج.
- لا يتم اعتبار Mock Provider دليلًا على Live Provider Verification.
- يتم تمييز أي Live External Verification غير ممكن بسبب Credential/Approval مفقود.

---

# 5. Authentication والحسابات

يجب التحقق من:

- Login.
- Logout.
- Forgot/Reset Credential.
- Session Expiry.
- Session Revocation.
- Disabled User Behavior.
- No Public Signup.
- Authorized User Creation/Invitation.
- Secure one-time First Super Admin bootstrap بدون Default Password hardcoded، مع إبطال bootstrap mechanism بعد النجاح.
- Safe Error Messages.
- Brute-force/Abuse Protection المناسب.
- Backend Enforcement.

لا يكفي وجود Login UI بدون Security Behavior حقيقي.

---

# 6. Roles والصلاحيات

## Super Admin

Global Scope حسب المواصفات.

## Manager

Branch-scoped فعلًا.

## Agent

فقط Leads/Conversations/Fields/Actions المسموحة.

يجب اختبار Direct URL/API Access وليس الواجهة فقط.

---

# 7. Contacts وLeads

يجب تحقق:

- Contact منفصل عن Lead.
- Contact Matching.
- Ambiguous Matching Handling.
- Multiple Leads per Contact.
- Lead Lifecycle OPEN/CLOSED/ARCHIVED.
- Manual Lead Creation.
- Historical Source Submission.
- Activity/History.
- Reopen/Close/Archive حسب الصلاحيات.
- عدم دمج Leads خطأ.

---

# 8. Campaigns والحقول

يجب تنفيذ:

- Campaign Creation/Edit/Activation/Deactivation.
- Source Binding.
- Branch.
- Eligible Agents.
- Routing.
- Messaging.
- AI.
- Qualification.
- Follow-up.
- Payments.
- Conversion Definition.
- Dynamic Fields.
- Field Types الموثقة.
- Required/Visible/Editable Rules.
- Options.
- Field Mapping.
- Calculated Fields.
- Field History.
- Campaign Readiness.

---

# 9. Routing

يجب دعم واختبار:

- Eligibility.
- Active Agent.
- Working Hours.
- Capacity.
- Weighted behavior عند وجوده.
- Performance-based policy عند تفعيلها.
- Fallback.
- No Eligible Agent.
- Reassignment.
- Agent Deactivation.
- Assignment History.
- Concurrency.

لا تنسب AI Metrics لأداء Human Agent.

---

# 10. Lead Sources وMeta

يجب أن يوجد:

- Connection Setup.
- Secure Credentials.
- Webhook Verification.
- Replay/Duplicate Protection.
- Page/Form Discovery/Selection حسب capabilities.
- Campaign/Form Binding.
- Binding Conflict Validation.
- Field Mapping.
- Preserve Raw Source Submission.
- Historical Sync عند دعمه.
- Failure/Retry.
- Status/Health.
- Unmatched/Needs Attention عند اللزوم.

---

# 11. Messaging وWhatsApp

يجب تطبيق `docs/05-messaging-ai-final-architecture.md` بالكامل.

لا تعتبر المنطقة مكتملة بدون:

- Multiple Connections.
- Multiple Senders.
- Branch Default Sender.
- Campaign Sender Override.
- Conversation Sender Pinning.
- Inbound Resolution.
- Outbound Resolution.
- Central Messaging Policy.
- Consent/DNC.
- Templates.
- Sending Hours.
- Delivery Status.
- Durable outbound record بحالة Queued/Pending قبل Provider send.
- Durable inbound Integration Event قبل routing/resolution.
- Queue/Retry.
- Health/Provider Constraints.
- Human/AI Controller.
- Handoff.
- Ambiguous Inbound Review.
- Tests.

---

# 12. الـAI

يجب وجود:

- AI Provider Setup.
- Model/Profile Configuration.
- AI Lead Assistant.
- AI Operations Assistant.
- AI Copilot.
- Approved Tools Boundary.
- No unrestricted DB access.
- Campaign Knowledge Draft/Published/Versions.
- Qualification.
- Structured updates عبر validated Tools.
- Unknown-answer behavior.
- Prompt Injection Protection.
- Handoff.
- Follow-up.
- Effective AI Config.
- Campaign Context Isolation.
- Failure visibility.
- Audit.
- AI Evaluations.

الـAI ليس Source of Truth.

---

# 13. Follow-ups

يشمل:

- Human Follow-up tasks.
- Create/Edit/Complete/Cancel/Reschedule.
- Due/Upcoming/Overdue.
- AI Follow-up Policy.
- Stop Conditions.
- Max Attempts.
- Sending Window.
- Timezone.
- No duplicate scheduled sends.
- Re-evaluation before actual send.

---

# 14. Payments وEnrollment

يجب تنفيذ:

- Payment Provider Connection.
- Branch Payment Methods.
- Payment Link Creation.
- Trusted Confirmation.
- Payment Status.
- Webhook/Callback Idempotency.
- Failure Handling.
- Agent Permissions.
- Enrollment منفصل.
- Enrollment only from trusted rule/event.
- لا يعتمد النظام على Customer Claim لتأكيد الدفع.

---

# 15. Analytics

يجب دعم:

- Date Filters.
- Branch.
- Campaign.
- Agent.
- Source.
- Conversation State.
- AI/Human.
- Relevant Custom Fields.
- Conversion Definition.
- Drill-down.
- Currency-safe Revenue.
- فصل AI Metrics عن Human Metrics.
- Server-side / scalable query strategy.
- عدم تخمين الأرقام عبر LLM.

---

# 16. Automations

يجب وجود:

```text
Trigger
  ↓
Conditions
  ↓
Actions
```

مع:

- Authorization.
- Validation.
- Loop Protection.
- Idempotency.
- Failure State.
- Audit/History المناسب.
- عدم تجاوز Messaging أو AI أو Payment Rules.

---

# 17. Search/Filters/Views/Bulk

يجب تنفيذ:

- Search حسب الصلاحيات.
- Filters.
- Sorting.
- Saved Views.
- Column Selection.
- Bulk Selection/Actions.
- Permission-safe Export.
- Large-data server-side behavior.
- عدم كشف Hidden Fields.

---

# 18. Import/Export/Google Sheets

## Import

- Mapping.
- Validation.
- Preview.
- Duplicate Review.
- Progress.
- Result Counts.
- Background processing عند الحجم الكبير.

## Export

- Current filters/views/columns.
- Permissions.
- No hidden data leakage.
- Background processing عند الحجم الكبير.

## Google Sheets

تنفذ وفق المواصفات بدون جعل Sheets قاعدة البيانات الأساسية.

---

# 19. Notifications

يشمل:

- In-App.
- Email/Messaging عندما يكون مفعّلًا.
- Preferences.
- Critical mandatory notifications عند الحاجة.
- Templates/wording حسب الصلاحيات.
- Assignment/Handoff/Payment/Errors.

Customer Conversation تبقى منفصلة عن Internal Notification.

---

# 20. UI/UX

يجب تنفيذ الشاشات الموثقة لكل Role، ومنها:

- Dashboards.
- Leads.
- Contacts.
- Branches.
- Users/Agents.
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
- Notifications/Follow-ups حيث ينطبق.

ويجب دعم:

- Arabic RTL.
- French/English LTR.
- Desktop.
- Tablet.
- Mobile.
- Empty States.
- Loading States.
- Error States.
- Permission States.
- Large Data UX.

---

# 21. Integration Setup

المستخدم التشغيلي المصرح له لا يجب أن يحتاج لتعديل:

- Source Code.
- Server Files.
- Database manually.
- CLI.
- Hardcoded Provider IDs.

يجب توفير:

- Setup Wizard أو UX مناسب.
- Help.
- Secret Handling.
- Test Connection.
- Status.
- Last Error.
- Reconnect.
- Disable.
- Scope/Binding.

إذا Provider يطلب خطوة خارجية إلزامية، تشرحها المنصة بوضوح بدل Fake Automation.

---

# 22. Security

على الأقل بحسب الـStack والـFeature:

- Authentication Security.
- Authorization.
- Branch Isolation.
- Secret Protection.
- Input Validation.
- Output Encoding.
- XSS/CSRF Protections عند انطباقها.
- Webhook Authenticity.
- Replay Protection.
- Rate/Abuse Protection.
- Safe File Handling.
- Safe Logging.
- No secret exposure to AI.
- No hidden data exposure via Search/Export/API.
- Dependency/configuration security المناسبة.

---

# 23. Reliability وData Integrity

يجب التعامل مع:

- Duplicate Events.
- Retries.
- Partial Failures.
- Concurrency.
- Out-of-order Events.
- Background Jobs.
- Provider Timeouts.
- Dead-letter/Recovery عند الحاجة.
- Transaction Boundaries.
- Auditability.
- Historical Integrity.
- Backup/Restore strategy المناسبة واختبار الاستعادة.
- Environment separation بين development/staging/production حسب الـArchitecture.

لا يتم تغيير Current State بشكل خاطئ بسبب Callback قديم.

---

# 24. Scalability

التصميم لا يفترض Dataset صغير.

يجب اختيار وتنفيذ ما يلزم من:

- Production Database.
- Indexes.
- Constraints.
- Connection Pooling.
- Server-side Pagination.
- Efficient Filtering/Sorting.
- Background Jobs.
- Queue Backpressure.
- Bounded Concurrency.
- Safe Bulk Processing.
- Caching عند الحاجة.
- Horizontal Scalability عندما يكون مناسبًا.
- Observability.
- Load/Performance tests للمسارات الحرجة.

لا تستخدم Microservices لمجرد أن المشروع كبير.

---

# 25. اختبارات القبول النهائية

قبل اعتبار المشروع مكتملًا يجب تشغيل وتوثيق:

- Unit Tests.
- Integration Tests.
- Permission/Authorization Tests.
- Webhook/Idempotency Tests.
- Routing Tests.
- Messaging Tests.
- AI Evaluations.
- Payment Callback Tests.
- Import/Export Tests.
- Critical UI/E2E Flows.
- Build.
- Type Check إن كان الـStack يدعمه.
- Lint/Static Checks.
- Database Migration Test.
- Production Startup/Smoke Test.
- Load/Performance Tests أو Scripts للمسارات الحرجة.

---

# 26. Critical End-to-End Scenarios

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
Lead Intake
→ Campaign
→ Branch
→ Assignment
→ Human Agent
→ Follow-up
→ Payment/Enrollment
```

## No Eligible Agent

```text
Lead
→ Routing
→ No Eligible Agent
→ Correct Fallback/Unassigned behavior
→ Manager Attention
```

## Ambiguous Contact

```text
Inbound
→ Contact has multiple active Leads
→ no unique Conversation context
→ persist
→ Needs Attention
→ authorized resolution
```

## Provider Failure

```text
Inbound/Outbound event
→ Provider unavailable/rate-limited
→ data preserved
→ retry/recovery
→ visible status
```

## Permission Attack

Agent يحاول فتح Lead/Conversation خارج Scope عبر URL/API.

Expected:

- Backend denies.
- No data leak.

## Prompt Injection

Customer يحاول جعل AI يكشف معلومات أو يستخدم Tool غير مسموحة.

Expected:

- لا scope expansion.
- لا secret leak.
- لا unauthorized action.

---

# 27. Credentials الخارجية

إذا لم تتوفر Production Credentials:

لا يوقف Codex المشروع.

يجب أن يكمل:

- Provider Adapter.
- Setup UI.
- Validation.
- Mock/Fake/Sandbox path.
- Error Handling.
- Tests.
- Documentation.

لكن لا يجوز أن يدعي أن Live Provider Integration تم التحقق منها إذا لم يتم ذلك فعليًا.

في التقرير النهائي يميز:

```text
Implemented
Mock/Sandbox Verified
Live Provider Verified
Live Verification Pending External Credential/Approval
```

---

# 28. ممنوعات قبل إعلان الاكتمال

لا يجوز اعتبار المنصة مكتملة مع وجود:

- Placeholder Screen لمسار Required.
- Stub API يعيد Fake Data في Production Path.
- TODO حرجة.
- Permissions مطبقة Frontend فقط.
- Hardcoded Credentials.
- Personal Developer Account Dependency.
- Fake Integration Success.
- Unhandled Duplicate Webhooks.
- Missing Migrations.
- Missing Critical Indexes/Constraints.
- Broken RTL.
- Missing Required Role Screens.
- AI يخلط Campaign Knowledge.
- Messaging Sender Resolution غير محدد.
- Payment Confirmation غير موثوق.
- Tests حرجة فاشلة.

---

# 29. Requirement Coverage Matrix

قبل إعلان الجاهزية، ينشئ Codex Matrix داخل Repository:

```text
Requirement Area | Source Docs | Implementation | Tests | Status
```

وتشمل على الأقل:

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
- Integrations UI.
- Audit.
- Security.
- Languages/RTL.
- Responsive UI.
- Scalability.
- Observability.
- Testing.
- Deployment/Runbook.

أي Area غير مكتملة لا تكون Status = Complete.

---

# 30. التقرير النهائي المطلوب

عند الانتهاء يجب أن يتضمن التقرير:

1. Architecture المختارة ولماذا.
2. Stack.
3. Modules المنفذة.
4. Database/Migrations.
5. Security Model.
6. Permissions Model.
7. Integrations.
8. Messaging Architecture.
9. AI Architecture.
10. Queues/Background Jobs.
11. Tests ونتائجها.
12. Build/Type/Lint Results.
13. End-to-end scenarios.
14. Requirement Coverage Matrix.
15. أي Live External Verification لم يتم بسبب Credential/Approval حقيقي.
16. أي Known Issue حقيقية.

لا يوصف المشروع بأنه مكتمل إذا بقي Requirement داخلي قابل للتنفيذ غير منجز.

---

# 31. معيار الجاهزية النهائي

تكون المنصة جاهزة عندما:

> كل Requirement داخلي قابل للتنفيذ في المواصفات تم تنفيذه واختباره، وكل External Dependency غير المتاحة تم عزلها عبر Adapter/Setup/Mock/Test Path واضح، ولا توجد فجوة معروفة يتم إخفاؤها تحت عبارة MVP أو Later أو Placeholder.
