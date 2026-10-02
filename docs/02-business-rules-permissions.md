# Business Rules & Permissions

# 1. Purpose

هذه الوثيقة تحدد:

- Roles.
- Data access.
- Branch isolation.
- Lead rules.
- Campaign rules.
- Field rules.
- Assignment/routing.
- Conversation access.
- Messaging behavior.
- AI permissions.
- Integration setup permissions.
- Payment/enrollment.
- Automation.
- Audit/security rules.

هذه الوثيقة تحدد **السلوك المطلوب** وليس تفاصيل التنفيذ التقنية.

---

# 2. Roles

الأدوار الأساسية:

1. Super Admin
2. Manager
3. Agent

لا يوجد Public Signup.

إنشاء المستخدمين يتم من خلال مستخدم مصرح له.

---

# 3. General Authorization Principle

كل Action يجب أن يمر عبر Authorization حقيقي في الـBackend.

لا يكفي:

- إخفاء زر.
- إخفاء Screen.
- منع Route في Frontend فقط.

أي وصول عبر:

- UI.
- API.
- Export.
- AI Assistant.
- Background action.
- Automation.

يجب أن يحترم نفس Business/Permission boundaries.

---

## Account Access Rules

- لا يوجد Public Signup.
- أول Super Admin ينشأ عبر One-time secure bootstrap mechanism لا يعتمد على hardcoded default password، ويُبطل/يُقفل بعد نجاح التهيئة.
- User غير Active لا يستطيع بدء Session جديدة.
- تعطيل User لا يحذف Historical actions الخاصة به.
- Password/credential recovery يجب أن تكون آمنة ولا تكشف وجود حساب أكثر مما يلزم.
- يجب أن يمكن إبطال Sessions عند تغيير أمني مهم أو تعطيل الحساب.

---

# 4. Super Admin

Super Admin يستطيع، ضمن النظام:

- إدارة جميع Branches.
- إدارة Managers.
- إدارة Agents.
- رؤية جميع Leads/Contacts.
- إدارة Campaigns.
- إدارة Fields.
- إدارة Routing.
- إدارة Integrations.
- إدارة Messaging Connections.
- إدارة AI Providers/configurations.
- إدارة Payment Providers/Methods.
- إدارة Automations.
- الوصول إلى Global Analytics.
- الوصول إلى Audit Logs.

---

# 5. Manager Scope

Manager مرتبط بـBranch.

Manager لا يستطيع:

- رؤية Branch آخر.
- رؤية Leads من Branch آخر.
- رؤية Conversations من Branch آخر.
- إدارة Agents خارج Branch.
- إدارة Campaigns خارج Branch.
- إدارة Payment Methods خارج Branch.
- الوصول إلى Integration Connection خارج Scope المسموح.

كل Query/Action للManager يجب أن يقيد فعلياً بـBranch scope.

---

# 6. Manager — Users

يستطيع:

- إنشاء Agents داخل Branch.
- تعديل Agents داخل Branch.
- تعطيل Agents داخل Branch.
- إدارة operational profile.
- working hours.
- capacity.
- phone/notification information.

لا يستطيع:

- إنشاء Manager آخر.
- إنشاء Super Admin.
- إدارة User خارج Branch.

---

# 7. Manager — Leads

يستطيع:

- رؤية Leads في Branch.
- فتح Lead Details.
- تعديل البيانات المسموحة.
- رؤية Conversations في Branch.
- إعادة تعيين Leads بين Agents داخل Branch.
- إنشاء Leads.
- إضافة Notes.
- إدارة Follow-ups.
- تنفيذ Bulk Actions ضمن Branch.
- Export البيانات المسموحة.

لا يستطيع نقل Lead إلى Branch آخر.

---

# 8. Manager — Campaigns

يستطيع داخل Branch:

- إنشاء Campaign.
- تعديلها.
- تعطيلها.
- ربط Source.
- اختيار Agents.
- إعداد Routing.
- إعداد Fields.
- إعداد Visibility/Editability.
- إعداد Automations.
- إعداد Messaging.
- إعداد AI.
- إعداد Campaign Knowledge.
- إعداد Qualification.
- إعداد AI follow-up policy.
- إعداد Payment availability.

---

# 9. Manager — Integrations

Manager يستطيع إدارة **Branch-scoped Connections** الخاصة بفرعه عندما يدعم Provider هذا النوع من الربط.

Organization-scoped Connections:

- ينشئها ويدير Credentials الخاصة بها Super Admin.
- يمكن إتاحتها/ربطها بBranch من قبل Super Admin.
- يستطيع Manager استخدام Connection المسموح بها داخل Campaigns الخاصة بفرعه بدون رؤية Secret.

Manager لا يستطيع:

- رؤية Secret لـOrganization Connection.
- استخدام Branch Connection من Branch آخر.
- تغيير Scope لConnection بطريقة تتجاوز صلاحياته.

---

# 10. Agent Scope

الافتراضي:

```text
Agent → Leads المخصصة له أو المسموح له بها فقط
```

لا يستطيع Agent رؤية Lead غير مصرح بها حتى إذا عرف ID أو URL.

---

# 11. Agent — Read Permissions

يستطيع رؤية، ضمن Leads المسموحة:

- Contact information.
- Campaign information المسموحة.
- Visible Fields.
- Follow-ups.
- Payment status.
- Enrollment status.
- Permitted Activity.
- Conversation history.
- AI summary/insights المسموحة.
- Notifications الخاصة به.

---

# 12. Agent — Edit/Action Permissions

يمكنه:

- تعديل Editable Fields.
- إضافة Note.
- إنشاء/إكمال Follow-up.
- تسجيل نتيجة تواصل.
- الرد على Conversation التي يملكها/يسمح له بها.
- استخدام AI Copilot ضمن نفس Scope.
- إنشاء Payment Link إذا كان مسموحاً.

لا يمكنه:

- تغيير Campaign structure.
- تغيير Field definitions.
- تغيير Routing.
- إدارة Integration credentials.
- إدارة AI Provider.
- Publish Campaign Knowledge.
- رؤية Leads أخرى.
- تغيير Security/Permissions.

---

# 13. Field Visibility Rules

لكل Field:

- Visible + Editable.
- Visible + Read-only.
- Hidden.
- System-managed.
- Source-managed.
- Calculated.

كل API/Export/Search يجب أن يحترم Visibility.

---

# 14. Contact Rules

عند وصول Lead:

- يتم Normalization للقيم المستخدمة بالمطابقة قدر الإمكان.
- يمكن مطابقة Contact باستخدام phone/email/external identifiers وفق قواعد واضحة.
- وجود Contact سابق لا يمنع Lead جديدة.
- لا يتم merge للـLead تلقائياً لمجرد تطابق Contact.
- لا يتم اختيار Contact عشوائياً عند وجود أكثر من Candidate موثوق.
- الحالات ambiguous يجب أن تستخدم review/needs-attention أو قاعدة deterministic.
- Source Submission تبقى محفوظة.

---

# 15. Lead Creation Rules

Lead يمكن أن تنشأ من:

- Meta.
- Manual.
- CSV/Excel.
- Google Sheets.
- API.
- Webhook.
- Future source.

يجب ربط ما يتوفر من:

- Contact.
- Source.
- Campaign.
- Branch.
- Assignment.
- Field values.
- Source Submission.

---

## Lead Lifecycle Rules

- Lead الجديدة تبدأ `OPEN`.
- `CLOSED` لا تعني حذف Lead أو Contact أو Conversation history.
- `ARCHIVED` تعني إخراجها من التشغيل اليومي المعتاد مع حفظ التاريخ.
- Campaign Status الاختياري لا يحل محل Internal Lifecycle State.
- Close/Reopen/Archive Actions تخضع للصلاحيات وتسجل في Activity/Audit حسب الحاجة.
- Enrollment أو Payment لا يغلقان Lead تلقائياً إلا إذا كان هناك Automation/Business Rule موثقة.

---

# 16. Campaign Rules

Campaign تحدد على الأقل عند الحاجة:

- Branch.
- Source.
- Fields.
- Routing.
- Eligible Agents.
- Messaging بما فيه Branch Default Sender أو Campaign Sender Override المسموح.
- AI باستخدام Global AI Guardrails + Branch AI Defaults + Campaign AI Configuration.
- Automations.
- Payment availability.

---

# 17. Campaign Activation Rules

قبل Activation يجب التحقق من العناصر المطلوبة حسب Features المفعلة.

أمثلة:

- Branch.
- Source binding إذا كانت الحملة تستقبل من Source خارجي.
- Routing/Agent handling.
- Field mapping.
- Messaging Connection/Sender صالح وقابل للحل إذا كان Customer Messaging مفعلاً.
- Campaign Sender Override، إن وجد، ضمن Scope مسموح؛ وإلا Branch Default Sender أو explicit allowed fallback.
- Sender/Connection health مناسب للعملية.
- AI Provider/configuration إذا كان AI Lead Assistant مفعلاً.
- Published Knowledge إذا كان AI يحتاج معرفة.
- Qualification mapping عند تفعيله.

لا يتم Activation بصمت مع Setup ناقص.

---

# 18. Campaign Deactivation

عند تعطيل Campaign:

- لا تستقبل Leads جديدة بالطريقة التشغيلية المعتادة.
- Leads السابقة لا تحذف.
- Conversations السابقة تبقى.
- التاريخ محفوظ.
- إدارة Leads السابقة تبقى ممكنة حسب الصلاحيات.

---

# 19. Source / Meta Lead Rules

عند وصول Lead من Source:

1. Verify/identify connection.
2. Preserve source submission.
3. Resolve Campaign binding.
4. Match/create Contact.
5. Create Lead.
6. Apply field mapping.
7. Determine Branch.
8. Execute routing.
9. Start allowed messaging/AI flow if configured.
10. Create activities/notifications.

إذا لم يتم Resolve للحملة:

- لا تربط Lead عشوائياً.
- احتفظ بالبيانات.
- سجل failure state.
- ضعها في queue/list للمعالجة.
- أشعر المسؤول إذا لزم.

---

## Source Binding Resolution Rules

عند وجود أكثر من External identifier، يجب Resolve Campaign باستخدام Combination موثوقة مثل:

- Integration Connection.
- External Form.
- External Campaign/Ad identifiers عندما تتوفر.

لا يجوز أن يكون لنفس External event أكثر من Active binding متعارض يؤدي إلى اختيار Campaign عشوائياً.

إذا بقي resolution ambiguous:

- يتم الاحتفاظ بالSubmission.
- لا يتم التخمين.
- تظهر كNeeds Attention.

---

# 20. Source Data Rules

Source Data الأصلية لا تمحى عند تعديل Operational Data.

أي correction تشغيلي يجب أن يكون منفصلاً عن Raw Source Submission.

---

# 21. Field Rules

لا توجد Fields ثابتة إجبارية لكل Campaign.

Manager/Super Admin يحددان ضمن الصلاحيات:

- Collection.
- Visibility.
- Editability.
- Required behavior.
- Filtering.
- Automation usage.
- AI qualification usage.

---

# 22. Required Fields

Required يمكن أن تعني required عند نقطة محددة من workflow، وليس بالضرورة عند Lead creation.

يجب أن يمنع النظام إكمال Action يعتمد على Field مطلوبة إذا كانت ناقصة، وفق Business Rule.

---

# 23. Calculated Fields

- لا يعدلها Agent يدوياً.
- تحسب من النظام.
- لا يسمح بقيمة manual متناقضة.
- تظهر كCalculated.

---

# 24. Status / Interest / Tags

كلها optional حسب Campaign.

لا تفترض أن جميع Campaigns تستخدم نفس القيم.

---

# 25. Field History

بالنسبة للحقول المهمة، يجب حفظ:

- old value.
- new value.
- actor/source.
- timestamp.

AI/Automation change يجب أن يحمل source واضحاً.

---

# 26. Assignment Rules

Lead يمكن أن تكون:

- Assigned.
- Unassigned.

Automatic routing لا يختار إلا Agent مؤهل.

---

# 27. Agent Eligibility

يمكن أن تعتمد على:

- Active.
- Branch.
- Campaign eligibility.
- Capacity.
- Working hours.
- Availability.

---

# 28. Routing Methods

- Round Robin.
- Weighted.
- Performance-Based.
- Manual.

## Performance-Based rules

- يعتمد على Human Agent metrics فقط.
- لا تدخل AI response speed أو AI attempts في Agent score.
- Campaign تحدد Metrics المفعلة وأوزانها وLookback window ضمن الخيارات التي يوفرها النظام.
- يجب استخدام Minimum sample/fallback حتى لا يُعاقب Agent جديد بلا تاريخ.
- يجب أن تكون الفترة/metrics المستخدمة قابلة للتفسير والمراجعة.
- إذا تعذر حساب score صالح، يستخدم fallback المحدد للحملة بدلاً من التخمين.

الخوارزمية التقنية يمكن تحديدها لاحقاً، لكن النتائج يجب أن تحترم eligibility والـscope.

---

# 29. No Eligible Agent

إذا لا يوجد Agent:

- Lead تبقى موجودة.
- تبقى Unassigned.
- يسجل السبب.
- تظهر ضمن Leads needing attention.
- يشعَر المسؤول حسب الإعدادات.

---

# 30. Reassignment

Manager:

```text
Agent A → Agent B داخل Branch
```

Super Admin:

```text
Branch A / Agent A → Branch B / Agent B
```

يجب حفظ history.

بعد Reassignment:

- Agent السابق يفقد Active access إلى Lead/Conversation إذا لم يكن لديه Permission أخرى تمنحه الوصول.
- Agent الجديد يحصل على التاريخ المسموح بالكامل.
- الرسائل القديمة لا تتغير ownership تاريخياً.
- إذا كان Agent السابق هو Human Controller، يجب نقل/إعادة تقييم Controller بدون ترك Conversation بحالة غير صالحة.

---

# 31. Agent Deactivation

عند تعطيل Agent:

- لا يستقبل Leads جديدة.
- لا يبقى eligible للrouting.
- Leads السابقة لا تختفي.
- Active Leads يجب التعامل معها وفق configuration.
- Conversations تحتاج reassignment/handling واضح.

---

# 32. Capacity Rules

الـCapacity الافتراضية تحسب Leads المعيّنة إلى Agent والتي Internal Lifecycle = `OPEN`.

إذا وصل Agent إلى Capacity المحددة:

- لا يتم إعطاؤه Leads جديدة تلقائياً.
- يمكن Manager أو Super Admin إعادة التوزيع يدوياً.
- Leads الموجودة لديه لا تتأثر.

لا يجوز استخدام Campaign Status اختياري بشكل ضمني لتحديد Active workload بدون Mapping/Rule صريحة.

---

# 33. Working Hours Rules

إذا كانت Working Hours مستخدمة في Routing:

- يجب احترامها عند تحديد Agent eligibility.
- لا يعتبر Agent مؤهلاً للتوزيع خارج وقته إلا إذا سمحت إعدادات Campaign/Branch بذلك.

Working Hours وBranch Timezone يمكن استخدامهما أيضاً في:

- Human handoff expectations.
- Follow-up scheduling.
- Notifications.

Messaging/AI sending hours تبقى Policy منفصلة ويمكن أن تختلف عن Agent working hours.

---

# 34. Conversation Access Rules

Conversation access يتبع Lead access.

إذا User لا يستطيع قراءة Lead:

- لا يستطيع قراءة Conversation.
- لا يستطيع قراءة Message.
- لا يستطيع قراءة AI summary.
- لا يستطيع send message.
- لا يستطيع استخدام AI tool عليها.

---

# 35. Lead Owner vs Conversation Controller

Lead Owner لا يساوي Conversation Controller.

يمكن:

```text
Owner = Sarah
Controller = AI
```

وعند Handoff:

```text
Owner = Sarah
Controller = HUMAN
```

لا يتغير Owner لمجرد تغير Controller.

---

# 36. Conversation Controller Rules

عندما Controller = AI:

- AI يمكنه إرسال Messages فقط ضمن Campaign AI rules.
- Assigned Agent يمكنه القراءة وطلب Manual Takeover إذا كان مصرحاً.

عندما Controller = HUMAN:

- يجب أن يكون هناك Current Human Controller User واضح.
- AI لا يقوم auto-send.
- Human Controller هو الذي يرسل بشكل افتراضي.
- Manager أو User آخر لديه access لا يرسل بالتوازي بصمت؛ يقوم Takeover صريح إذا أراد استلام التحكم.
- AI يمكن أن يعمل كCopilot فقط إذا كان مفعلاً.

عندما Conversation = CLOSED:

- لا auto-send إلا إذا workflow يعيد فتحها بشكل صريح.

---

# 37. Human Handoff Rules

Handoff مطلوب عندما:

- Lead يطلب إنسان.
- AI لا يملك معلومة مؤكدة.
- Campaign rule تطلب handoff.
- AI reaches qualification milestone configured for human.
- complaint/sensitive scenario.
- unsupported request.
- low-confidence/guardrail condition.

بعد Handoff:

- تسجل reason.
- Human controller يصبح active.
- AI auto-send يتوقف.
- Agent يرى full context.

---

# 38. Message Send Authorization

أي outbound message يجب أن يمر عبر:

- Lead access.
- Conversation state.
- Channel status.
- Sender/connection scope.
- Business rules.
- Consent/contactability state.
- Provider policy.
- Required template when applicable.
- Allowed sending window/business hours.
- Sender/Connection health.
- Campaign frequency/max-attempt rules.
- Provider capabilities والـrate/throughput/quality constraints عندما تتوفر.
- Idempotency/duplicate protection.

كل هذه الفحوصات تمر عبر **Central Messaging Policy** مشتركة لكل AI/Human/Automation/Follow-up sends؛ لا يوجد bypass خاص لأي منها.

لا يجوز اختيار Sender من Branch آخر أو Connection غير مصرح بها.

## Message integrity

- Inbound/Outbound messages بعد تسجيلها لا تعدل بصمت.
- Internal Note لا تعتبر Customer Message.
- تصحيح رسالة مرسلة يتم برسالة جديدة.
- حذف Conversation من الواجهة اليومية لا يجوز أن يمحو history المطلوبة.

---

# 39. Messaging Connection Rules

يجب دعم:

- عدة Connections.
- عدة senders/numbers.
- Scope واضح.
- Active/inactive.
- Health state.
- Provider capability/quality/throughput metadata عندما تتوفر.
- Provider independence.

لا تفترض Number واحدة للنظام كله ولا Dedicated Number لكل Campaign.

الـOutbound Sender resolution:

- Conversation قائمة مع Pinned Sender/Thread تستخدمه إذا كان صالحاً؛ إذا لم يعد صالحاً يتم Block/Needs Attention أو Explicit migration workflow، ولا يتم fallback تلقائياً إلى رقم آخر.
- Conversation جديدة بلا Pinned Sender تستخدم: Campaign Sender Override → Branch Default Sender → Organization Shared Fallback المسموح صراحة → وإلا Block/Needs Attention.

Inbound resolution يستخدم Connection/Sender/provider thread + Contact + active Conversation/Lead + Campaign/external references. عند ambiguity يحفظ Provider/Integration Event في Needs Attention ولا يتم التخمين.

حسم Unmatched/Needs Attention inbound يحتاج User مصرحاً ضمن Branch/Lead scope، ويُسجل Resolution audit. لا يجوز عرض Candidate Leads خارج Scope المستخدم.

Agent لا يدير credentials.

---

# 40. Messaging Failure Rules

إذا فشل send:

- Lead لا يحذف.
- Conversation history لا تحذف.
- Message تظهر Failed.
- failure يسجل.
- retry policy يمكن تطبيقها.
- لا يتم الادعاء بأن الرسالة أرسلت بنجاح.
- يمكن تصعيدها للAgent/Manager.

---

# 41. Follow-up Rules

Follow-up يمكن أن ينشأ من:

- Agent.
- Manager.
- Automation.
- AI policy.

يجب حفظ completed/cancelled history.

---

# 42. AI General Rules

AI:

- ليس Source of Truth.
- لا يغير Permissions.
- لا يتجاوز Branch isolation.
- لا يتجاوز Lead access.
- لا يؤكد Payment.
- لا يغير Security.
- لا ينفذ Action غير موجودة ضمن approved tools.
- يمكن تعطيله بدون توقف Core Operations.

---

# 43. AI Permission Inheritance

## Internal AI Operations Assistant

يعمل ضمن صلاحيات User الحالي.

مثال:

Agent لا يستطيع أن يسأل AI عن Lead لا يملكها.

Manager لا يحصل عبر AI على بيانات Branch آخر.

## Customer-facing AI Lead Assistant

يعمل ضمن:

- Current Lead.
- Current Campaign.
- Effective AI Configuration الناتجة من Global AI Guardrails + Branch AI Defaults + Campaign AI Configuration.
- Published Knowledge الخاصة بالحملة.
- Approved tools.
- Resolved Messaging Connection/Sender.
- Campaign policy.

مشاركة نفس Provider/Model/Runtime بين Campaigns لا توسع الـScope ولا تسمح بخلط Knowledge أو Instructions أو Qualification أو Lead/Conversation data بينها.

---

# 44. AI Tool Rules

AI لا يحصل على Direct unrestricted DB access لتنفيذ Actions.

أي Tool:

```text
AI Request
  ↓
Application Service
  ↓
Authorization
  ↓
Validation
  ↓
Business Rules
  ↓
Execution
```

---

# 45. AI Facts vs Interpretation

الأرقام والحقائق مثل:

- lead count.
- paid count.
- no follow-up count.
- conversion.

تأتي من Platform queries/tools.

AI يستخدم للتفسير والتلخيص والتحليل.

لا تعتمد على LLM memory لحساب operational facts.

---

# 46. Campaign Knowledge Rules

AI customer-facing يستخدم Knowledge منشورة فقط.

يجب دعم:

- Draft.
- Publish.
- Version history.

إذا تغيرت Knowledge:

- المحادثات الجديدة تستخدم version current حسب policy.
- AI execution التاريخي يمكن تتبعه إلى version المستخدمة.

---

# 47. Unknown Answer Rule

إذا سأل Lead عن معلومة تخص الشركة/الحملة وغير موجودة في Published Knowledge:

AI:

- لا يخترع.
- لا يعتمد على generic model knowledge كبديل.
- يوضح أنه لا يملك معلومة مؤكدة.
- يسجل/يطلب Handoff حسب policy.

---

# 48. AI Qualification Rules

Qualification questions/configuration تُدار داخل Campaign.

AI يمكن أن:

- يسأل.
- يستخرج value.
- يقترح/يحدث structured field عبر Tool مسموحة.

كل update يخضع validation والـfield rules.

---

# 49. AI Follow-up Rules

Policy Campaign-configurable.

يمكن أن تحدد:

- Initial message timing.
- Follow-up delays.
- Max attempts.
- Allowed time windows.
- Stop conditions.
- Handoff conditions.

لا توجد policy واحدة hardcoded لكل Campaigns.

---

## AI Follow-up Delivery Rules

كل AI send يخضع أيضاً لنفس Central Messaging Policy المستخدمة للHuman والAutomation، بما فيها:

- Consent/contactability.
- Provider policy.
- Template requirement.
- Messaging Connection/Sender health.
- Branch/Campaign timezone.
- Campaign frequency/max-attempt rules.
- Provider rate/throughput/quality constraints عندما تتوفر.
- Deterministic sender resolution.
- Queue/backpressure behavior عند الحاجة.

## No eligible human at handoff

إذا احتاج AI Handoff ولم يوجد Agent مؤهل/متاح:

- Conversation تنتقل إلى WAITING_FOR_HUMAN أو equivalent.
- لا يستمر AI في موضوع يتطلب Human.
- يتم إشعار Manager/queue المخصصة.
- Lead لا تضيع ولا تُربط عشوائياً.
- يمكن للـAI إرسال رسالة انتقالية معتمدة فقط إذا policy تسمح.

---

# 50. AI Status/Field Mutation Rules

AI لا يغير arbitrary Statuses أو Fields.

فقط Tools/Fields المسموحة صراحة.

Sensitive states مثل:

- PAID.
- ENROLLED.
- Security/access.

لا يغيرها AI إلا إذا كانت نتيجة deterministic system event وبنفس Business Rule، وليس قرار LLM.

---

# 51. AI Provider Failure

إذا AI Provider unavailable:

- Lead intake يستمر.
- Assignment يستمر.
- Human agents يستطيعون العمل.
- Conversation يمكن تحويلها للhuman.
- failure يسجل.
- retry/fallback حسب policy.
- لا تفقد incoming message.

---

# 52. AI Audit Rules

سجل عند الحاجة:

- Assistant.
- User/Lead/Campaign scope.
- Conversation.
- Knowledge version.
- Tool requested.
- Action executed.
- Result.
- Timestamp.
- Error.

لا تسجل secrets أو unnecessary sensitive data.

---

# 53. AI Operations Assistant Rules

يمكنه ضمن permission:

- summarize.
- explain metrics.
- list leads needing attention.
- analyze conversation themes.
- suggest next actions.
- prepare drafts.

لا يمكنه كشف بيانات خارج scope.

Actions write-capable تحتاج Tool واضحة وصلاحية مناسبة.

---

# 54. Integration Setup Rule

كل Integration تشغيلي يجب أن يدار من واجهة المنصة.

حسب Provider يمكن أن تشمل الواجهة:

- prerequisites.
- Connect.
- OAuth.
- API key/token input.
- Webhook details.
- account/resource selection.
- test connection.
- health/status.
- last error.
- reconnect.
- disable.
- scope/binding.

لا يحتاج المستخدم التشغيلي لتعديل server config.

---

# 55. Provider External Prerequisite Rule

إذا Provider يفرض خطوة خارج المنصة ولا يمكن أتمتتها:

- تعرض المنصة تعليمات step-by-step.
- تحدد الرابط/المكان/القيمة المطلوبة.
- يعود المستخدم للمنصة لإكمال الربط.
- يتم Test Connection.
- لا يحتاج تدخل Developer.

هذا لا يعني أن المنصة تنشئ Accounts خارجية إذا Provider لا يسمح بذلك.

---

# 56. No Personal Developer Account Dependency

التنفيذ لا يعتمد على:

- OpenAI account شخصي.
- Meta account شخصي.
- WhatsApp number شخصي.
- Stripe account شخصي.
- hardcoded test credentials.

استخدم mocks/sandbox/test doubles أثناء التطوير.

Production connection يتم من UI بواسطة المستخدم المصرح له.

---

# 57. Credential Security Rules

Secrets:

- لا تظهر للAgent.
- لا تظهر كاملة بعد save.
- لا تدخل Logs.
- لا ترسل للAI.
- تخزن securely.
- rotation/update تخضع permissions.
- deletion/disconnection لا تمحو history التشغيلي المرتبط.

---

# 58. Multi-Connection Rules

لا تفترض:

- Meta account واحدة.
- WhatsApp number واحد.
- Dedicated WhatsApp number لكل Campaign.
- Payment account واحد.
- AI provider واحد.

يجب أن يدعم Domain/Architecture تعدد Connections حسب scope، مع Branch Default Sender وCampaign Sender Override اختياري وOrganization Shared Sender عند السماح به صراحة.

---

# 59. Payment Method Rules

Manager يدير Methods ضمن Branch.

Super Admin يدير الجميع.

Agent:

- لا يرى credentials.
- يستخدم Methods المسموحة.

---

# 60. Payment Link Rules

كل Payment Link يرتبط بـ:

- Lead.
- Payment Method.
- amount/currency عند الحاجة.

إنشاء Link يسجل Activity.

---

# 61. Payment Confirmation Rules

لا يعتبر Payment Confirmed بسبب:

- فتح Link.
- success page فقط.
- قول العميل إنه دفع.

يجب تأكيد موثوق من Provider/event المعتمد.

---

# 62. Enrollment Rules

التدفق الأساسي:

```text
Trusted Payment Confirmation → Enrollment
```

لا يتم Enrollment تلقائياً من claim غير موثوق.

---

# 63. Payment Scope

خارج النطاق:

- Installments.
- Payment Plans.
- Refund management.
- Accounting.
- Ledger.

---

# 64. Notification Rules

القنوات:

- In-App.
- Email.
- WhatsApp/Messaging.

Notification تختلف عن Customer Conversation.

Super Admin يدير Global notification templates/settings.

Manager يمكنه إدارة Branch-level wording/templates التي يسمح بها النظام بدون تعديل Global security/mandatory notifications.

Agent يدير Preferences الشخصية المسموحة فقط، ولا يعدل Administrative templates.

---

# 65. Automation Rules

Automation:

```text
Trigger → Conditions → Actions
```

يجب أن:

- تحترم permissions.
- تحترم Branch.
- تمنع loops.
- تمنع duplicate execution.
- تسجل result.
- لا تتجاوز conversation controller rules.

---

# 66. Import Rules

قبل Import:

- اختيار Branch ضمن Scope المستخدم.
- اختيار Campaign عندما تتطلب البيانات ذلك.
- mapping.
- validation.
- data types.
- duplicate analysis.
- source attribution.
- preview.

لا يتجاوز Import Branch isolation.

Manager لا يستطيع Import إلى Branch آخر، وAgent لا يحصل على Import scope أوسع من صلاحياته إن تم السماح له بالاستيراد مستقبلاً.

---

# 67. Duplicate Rules

Contact matching لا يعني Lead merging.

يجب الحفاظ على Source Submission.

يجب منع duplicate events التقنية من إنشاء duplicate business records غير المقصودة.

---

# 68. Bulk Action Rules

تعتمد على:

- Role.
- Branch.
- Lead access.
- Field/action permission.

Actions الحساسة/wide-scope تحتاج confirmation.

---

# 69. Export Rules

Export يحترم:

- Role.
- Branch.
- Lead access.
- Field visibility.
- data sensitivity.

---

# 70. Search & Filter Rules

Search/Filters لا تصبح وسيلة لكشف hidden data.

نتائجها تخضع للpermissions نفسها.

---

# 71. Saved View Rules

Saved View لا تحفظ أو تكشف صلاحية أوسع من Current Permission.

---

# 72. Audit Rules

سجل العمليات الحساسة مثل:

- user/permission changes.
- branch changes.
- campaign changes.
- field configuration.
- routing.
- assignment.
- conversation control/handoff المهم.
- integration configuration.
- credential rotation event.
- AI configuration.
- knowledge publish.
- payment method/config.
- payment event.
- enrollment.
- sensitive bulk actions.

---

# 73. Failure Isolation

فشل:

- Meta.
- Messaging.
- Email.
- AI.
- Google Sheets.
- Payment integrations.

لا يجب أن ينهار معه Core Platform.

لكن يجب أن يوجد failure state واضح وretry/handling مناسب.

---

## External Event Ordering

External callbacks قد تصل out-of-order؛ يجب ألا يعيد Callback قديم Message/Payment/Connection إلى state أقدم بشكل غير صحيح.

---

# 74. Historical Data Rules

Current State لا يمحو:

- Assignment history.
- Conversation history.
- Message history.
- Handoff history.
- Field history.
- Payment events.
- Enrollment events.
- Integration events.
- Knowledge versions.
- AI actions.
- Audit events.

---

# 75. Source of Truth Rules

- Platform = operational source of truth.
- External systems = sources/providers.
- Google Sheets ≠ primary DB.
- AI ≠ source of truth.
- AI summary ≠ factual state.
- Customer message ≠ payment confirmation.

---

## Communication Analytics Rules

يجب أن تحفظ الـAnalytics الفصل بين Human وAI:

- First AI contact ≠ First human contact.
- AI attempts ≠ Human attempts.
- AI response time ≠ Agent response time.
- AI-qualified Lead لا يعني أن Agent قام بالتأهيل يدوياً.

أي Performance-Based routing أو Agent performance dashboard يجب أن يستخدم Human metrics المعرّفة فقط.

## Archive / Delete Rules

- Deactivate/Close/Archive هو default للسجلات التشغيلية التاريخية.
- Hard Delete لLead/Conversation/Payment/Audit data ليس Action يومي عادي.
- أي Delete فعلي يجب أن يكون authorized + audited + relationship-safe.
- Audit events نفسها يجب ألا تكون قابلة للتعديل من المستخدم العادي.

---

## Conversion Metric Rule

Campaign يجب أن تحدد milestone المستخدمة لاحتساب Conversion إذا كانت تريد هذه Metric.

لا يجوز للنظام أو AI افتراض أن `Interested` أو `Qualified` أو `Paid` أو `Enrolled` تعني Conversion لكل Campaigns.

---

## Revenue Currency Rule

Analytics لا تجمع Payment amounts بعملات مختلفة كأنها نفس الوحدة.

أي Cross-currency reporting يحتاج Reporting Currency + conversion rule موثقة؛ وإلا تعرض النتائج مفصولة حسب Currency.

---

# 76. Core Permission Matrix

| Capability | Super Admin | Manager | Agent |
|---|---|---|---|
| رؤية جميع Branches | نعم | لا | لا |
| إنشاء/إدارة Branch | نعم | لا | لا |
| إدارة Managers | نعم | لا | لا |
| إدارة Agents | جميع الفروع | Branch الخاص به | لا |
| رؤية Leads | جميعها | Branch الخاص به | Leads المسموحة |
| رؤية Conversations | جميعها حسب النظام | Branch الخاص به | Leads المسموحة |
| الرد على Customer Conversation | بعد امتلاك/Takeover control | بعد امتلاك/Takeover control ضمن Branch | Leads المسموحة + Human control |
| نقل Lead بين Branches | نعم | لا | لا |
| نقل Lead بين Agents | نعم | داخل Branch | لا |
| إنشاء Campaign | نعم | Branch الخاص به | لا |
| إدارة Campaign | نعم | Branch الخاص به | لا |
| إدارة Fields | نعم | Branch الخاص به | لا |
| إدارة Routing | نعم | Branch الخاص به | لا |
| إدارة Messaging Connection | جميع Scopes | Branch-scoped فقط؛ shared org connection بدون Secret | لا |
| إدارة Meta Connection | جميع Scopes | Branch-scoped فقط؛ shared org connection بدون Secret | لا |
| إدارة Payment Provider/Method | جميع Scopes | Branch-scoped connections/methods | لا |
| إدارة AI Provider | جميع Scopes | Branch-scoped connection/profile فقط؛ shared org connection بدون Secret | لا |
| إدارة Campaign AI Knowledge | نعم | Campaigns ضمن Branch | لا |
| Publish AI Knowledge | نعم | Campaigns ضمن Branch | لا |
| استخدام AI Copilot | نعم | نعم | ضمن Leads المسموحة |
| استخدام AI Operations Assistant | Global | Branch | Personal/Lead scope |
| إدارة Automations | نعم | Branch | لا |
| رؤية Global Analytics | نعم | لا | لا |
| رؤية Branch Analytics | نعم | نعم | حسب النطاق |
| Audit Logs | نعم | لا كـGlobal Audit؛ يرى operational/integration history ضمن Branch | لا |
| Export | حسب النظام | Branch | بياناته المسموحة |

---

# 77. Final Business Rule Principle

المبدأ النهائي:

> **الإدارة تضبط النظام والحملات والتكاملات والـAI من داخل المنصة ضمن الصلاحيات، والـAgent ينفذ العمل اليومي فقط ضمن Leads والمحادثات المسموحة له.**

ولا يستطيع أي Role أو AI Assistant أو Automation تجاوز:

- Branch isolation.
- Lead access.
- Conversation access.
- Security.
- Payment trust rules.
- Field rules.
- Integration scope.
- Business Rules.

# 78. High-Volume Reliability Rules

عند ارتفاع حجم التشغيل:

- لا يجوز إسقاط Lead بسبب Queue pressure مؤقت.
- لا يجوز فقدان Webhook موثوق بسبب ضغط مؤقت.
- لا يجوز إنشاء Lead/Message/Payment مكرر بسبب Retry.
- لا يجوز أن تقوم عملية Import أو Export كبيرة بحجب العمل اليومي.
- لا يجوز أن تجعل Analytics الثقيلة Lead Details أو Conversation reply غير قابلة للاستخدام.
- يجب أن يكون للـBackground processing حالات قابلة للتتبع والفشل والاستئناف حسب طبيعة العملية.
- Provider rate limits يجب أن تؤدي إلى queueing/backoff/retry مناسب.
- Messaging throughput يجب أن يسمح Per-Sender/Per-Connection throttling/isolation عند الحاجة.
- Sender/Connection health وProvider quality/throughput signals تراقب عندما تكون متاحة.
- Sender متعثر لا يجب أن يشل Senders أخرى بلا داعٍ.
- Bulk actions يجب أن تكون bounded وقابلة للتتبع.
- أي degraded external provider يجب أن يظهر كحالة تشغيلية قابلة للمراقبة بدلاً من انهيار Core Platform.
