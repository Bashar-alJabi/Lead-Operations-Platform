# Integrations, Data Flows & UI Requirements

# 1. Purpose

هذا الملف يحدد المتطلبات الوظيفية المتعلقة بـ:

- التكامل مع الخدمات الخارجية.
    
- دخول البيانات إلى المنصة وخروجها منها.
    
- سلوك مزودي الخدمات.
    
- كيفية ربط الخدمات الخارجية بالـCampaigns والـBranches.
    
- الشاشات والواجهات المطلوبة.
    
- Workflows التي يجب أن يستطيع المستخدم تنفيذها من خلال المنصة.
    
- حالات الواجهة الأساسية التي يجب التعامل معها.
    

هذه الوثيقة **لا تحدد**:

- Programming Language.
    
- Frontend Framework.
    
- Backend Framework.
    
- Database Technology.
    
- Hosting Provider.
    
- ORM.
    
- Queue Technology.
    
- Cache Technology.
    
- AI Model.
    
- بنية كود محددة.
    

هذه القرارات يتم تحديدها لاحقاً ضمن التصميم التقني بناءً على كامل متطلبات المشروع.

---

# PART A — INTEGRATION REQUIREMENTS

# 2. Integration Principles

يجب أن تعمل التكاملات كخدمات مساعدة للمنصة، وليست بديلاً عنها.

المبادئ الأساسية:

- المنصة هي Source of Truth للبيانات التشغيلية.
    
- كل تكامل يجب أن يكون قابلاً للمراقبة.
    
- فشل التكامل الخارجي لا يجب أن يؤدي تلقائياً إلى فشل Core Operations.
    
- يجب الحفاظ على البيانات الأصلية القادمة من المصادر الخارجية.
    
- يجب فصل إعدادات كل Provider عن Business Logic الأساسي.
    
- يجب أن يكون من الممكن تغيير Provider مستقبلاً دون إعادة بناء النظام الوظيفي بالكامل.
    
- العمليات الخارجية المهمة يجب أن تكون قابلة لإعادة المحاولة عند الحاجة.
    
- لا يجب تنفيذ نفس الحدث أكثر من مرة بطريقة تؤدي إلى بيانات مكررة.
    
- يجب تسجيل حالات الفشل والنجاح والعمليات المهمة للتكاملات.
    

---

# 3. Meta Integration

Meta هو المصدر الأساسي للـLeads في النظام الحالي.

يجب أن تتمكن المنصة من التعامل مع:

- Facebook Pages.
    
- Advertising Campaigns.
    
- Ad Sets.
    
- Ads.
    
- Instant Forms.
    
- Leads الناتجة عن النماذج.
    

---

# 4. Meta Campaign Setup

الإعلانات والنماذج يتم إنشاؤها وإدارتها على Meta.

بعد ذلك يقوم Super Admin أو Manager بربط الحملة أو النموذج المناسب بالمنصة.

داخل المنصة يجب أن يستطيع المسؤول تحديد:

- اسم Campaign داخل المنصة.
    
- المصدر المرتبط.
    
- Branch.
    
- Agents المؤهلين.
    
- Routing.
    
- Fields.
    
- Visibility.
    
- Editability.
    
- Automations.
    
- الإعدادات التشغيلية الخاصة بالحملة.
    

المنصة ليست بديلاً عن Meta Ads Manager.

---

# 5. Meta Lead Flow

المسار الوظيفي:

**Meta Campaign / Form**

↓

**Person submits the Form**

↓

**Lead reaches the Platform**

↓

**Platform identifies the related Campaign**

↓

**Campaign determines Branch**

↓

**Campaign Field Configuration is applied**

↓

**Contact is matched or created**

↓

**Lead is created**

↓

**Routing is applied**

↓

**Agent is assigned**

↓

**Agent is notified**

↓

**Lead becomes available to the Agent**

---

# 6. Meta Source Information

يجب الاحتفاظ بالمعلومات المتاحة عن مصدر Lead عند وصولها.

يمكن أن تشمل:

- Source.
    
- Page.
    
- Campaign.
    
- Ad Set.
    
- Ad.
    
- Form.
    
- Source date/time.
    
- External identifiers.
    

هذه المعلومات تستخدم في:

- Lead Details.
    
- Analytics.
    
- Attribution.
    
- Troubleshooting.
    
- Historical reporting.
    

---

# 7. Meta Form Mapping

Forms مختلفة قد تستخدم أسئلة مختلفة.

مثلاً:

Form A:

> Which language do you want to learn?

Form B:

> What language would you like to study?

يمكن أن ترتبط الأسئلة نفسها بالحقل التشغيلي المناسب داخل المنصة.

يجب أن تسمح المنصة للمسؤول بإنشاء وإدارة هذه Mapping.

---

# 8. Meta Source Fields vs Platform Fields

يجب التمييز بين:

### Source Field

السؤال أو القيمة القادمة من Meta.

### Platform Field

الحقل الذي يستخدم داخل المنصة لإدارة الـLead.

ليس شرطاً أن يكون لكل Source Field نسخة مطابقة بالاسم نفسه داخل المنصة.

كما يجب أن يكون من الممكن إضافة Platform Fields لا تأتي من Meta أصلاً.

---

# 9. Historical Meta Leads

يجب أن تدعم المنصة إمكانية جلب أو إدخال Leads التاريخية المرتبطة بالمصادر المربوطة بها عندما يكون ذلك متاحاً ومطلوباً.

يجب أن تتم المحافظة على:

- تاريخ الوصول.
    
- Source information.
    
- External identifiers.
    
- Campaign association عندما تكون معروفة.
    
- البيانات الأصلية المتاحة.
    

ولا يجب أن تؤدي عملية Historical Sync إلى إنشاء تكرارات غير مقصودة.

---

# 10. Meta Failure Handling

إذا حدثت مشكلة في استقبال أو مزامنة Leads من Meta:

- يجب عدم حذف البيانات الموجودة مسبقاً.
    
- يجب تسجيل المشكلة.
    
- يجب إظهار حالة التكامل للمستخدم المسؤول.
    
- يجب إمكانية إعادة المحاولة أو إعادة المزامنة عند الحاجة.
    
- يجب ألا يؤدي فشل Meta إلى تعطيل بقية المنصة.
    

---

# 11. WhatsApp Integration

WhatsApp هو **Notification Channel** فقط.

المنصة لا تستخدم WhatsApp كـCRM للمحادثات.

لا يوجد ضمن النطاق:

- Customer inbox.
    
- Conversation management.
    
- Customer chat history.
    
- Customer support center.
    
- Chatbot.
    

---

# 12. Agent WhatsApp Experience

الـAgent لا يقوم بإعداد التكامل.

الـAgent يدخل فقط:

- الاسم.
    
- رقم الهاتف.
    

بعد ذلك تستخدم المنصة الرقم لإرسال Notifications.

الـAgent لا يحتاج إلى إدخال أو معرفة:

- API.
    
- API key.
    
- Webhook.
    
- Credentials.
    
- Business Account.
    
- Provider.
    
- Session configuration.
    
- QR configuration.
    

---

# 13. WhatsApp Provider Independence

يجب أن يكون WhatsApp Provider منفصلاً عن منطق المنتج.

المفهوم الوظيفي:

**Platform Notification**

→ **WhatsApp Provider**

→ **Agent Phone**

يمكن أن يتغير Provider مستقبلاً بدون تغيير الـCampaigns أو Leads أو Automation logic.

يمكن استخدام مزود مثل:

- Wasender.
    
- WhatsApp Cloud API.
    
- مزود آخر.
    

اختيار المزود النهائي ليس جزءاً من هذه الوثيقة.

---

# 14. WhatsApp Notifications

يجب أن تدعم المنصة Notifications مثل:

- New Lead.
    
- Lead Reassigned.
    
- Payment Received.
    
- Enrollment Confirmed.
    
- Follow-up Due.
    
- Follow-up Overdue.
    
- Important System Alert.
    

يمكن أن تحتوي الرسالة على معلومات مثل:

- Lead Name.
    
- Phone.
    
- Campaign.
    
- Date/Time.
    
- أي معلومات تشغيلية يسمح النظام بإرسالها.
    

محتوى الرسالة يجب أن يكون قابلاً للإدارة والتخصيص وفق إعدادات النظام.

---

# 15. WhatsApp Delivery Status

عندما يوفر المزود معلومات عن حالة الرسالة، يمكن للمنصة تتبع حالات مثل:

- Queued.
    
- Sent.
    
- Delivered.
    
- Failed.
    

ويجب إظهار حالة الفشل للمسؤول عند الحاجة.

---

# 16. WhatsApp Failure Handling

إذا فشل WhatsApp:

- يبقى Lead موجوداً.
    
- يبقى Assignment موجوداً.
    
- لا يفشل Follow-up.
    
- لا يفشل Payment.
    
- لا يفشل Enrollment.
    
- تسجل Notification failure.
    
- يمكن إعادة المحاولة حسب قواعد النظام.
    

WhatsApp هو خدمة مساعدة وليس جزءاً من Core Lead Processing.

---

# 17. Email Integration

Email يستخدم بشكل أساسي لإرسال Notifications.

يمكن أن تشمل:

- New Lead.
    
- Lead Assignment.
    
- Follow-up.
    
- Payment.
    
- Enrollment.
    
- System alerts.
    

فشل Email لا يجب أن يمنع Core Operations.

---

# 18. Payment Integrations

المنصة يجب أن تدعم فكرة تعدد Payment Providers.

كل Branch يمكن أن يكون لديه:

- Provider واحد.
    
- أو أكثر من Payment Method حسب إعدادات Branch.
    

مثال:

Branch A:

Stripe.

Branch B:

Payment provider مختلف.

Branch C:

Stripe configuration مختلفة.

---

# 19. Payment Provider Configuration

Manager يدير Payment Methods الخاصة بفرعه.

Super Admin يستطيع إدارة جميع الفروع.

يمكن أن تتضمن Payment Method مفاهيم مثل:

- Display name.
    
- Provider.
    
- Active / Inactive.
    
- Availability.
    
- إعدادات مرتبطة بالحساب.
    

Credentials الحساسة يجب أن تبقى محمية ولا تظهر للAgent.

---

# 20. Payment Link Flow

المسار:

**Lead**

↓

**Select Payment Method**

↓

**Create Payment Link**

↓

**Share / Use Payment Link**

↓

**Payment**

↓

**Payment Confirmation**

↓

**Enrollment**

↓

**Notifications**

↓

**Analytics**

---

# 21. Payment Confirmation

فتح Payment Link أو الرجوع إلى صفحة نجاح لا يعتبر وحده إثباتاً نهائياً للدفع.

يجب أن يعتمد النظام على تأكيد موثوق من مزود الدفع.

بعد تأكيد الدفع:

- يتم إنشاء/تحديث Payment.
    
- يتم تحديث Lead.
    
- يتم تسجيل Enrollment.
    
- يتم تحديث Activity.
    
- يتم تحديث Analytics.
    
- يتم إرسال Notifications.
    

---

# 22. Payment Failure

إذا فشل Payment:

- لا يتم تسجيل Payment ناجح.
    
- لا يتم اعتبار الشخص Enrolled بسبب الفشل.
    
- يجب عرض حالة مناسبة.
    
- يمكن إنشاء Payment Link جديد حسب قواعد النظام.
    
- لا تتأثر بيانات Contact وLead.
    

---

# 23. Payment Scope

لا يدخل ضمن التكامل:

- Installments.
    
- Payment Plans.
    
- Refund Management.
    
- Accounting.
    
- Financial Ledger.
    

المطلوب هو إدارة عملية الدفع اللازمة لإتمام التسجيل فقط.

---

# 24. Enrollment Integration Flow

Enrollment ليس مزوداً خارجياً بحد ذاته.

هو نتيجة تشغيلية داخل المنصة.

المسار الأساسي:

**Payment Confirmed**

→ **Enrollment / Subscription**

→ **Activity**

→ **Notifications**

→ **Analytics**

---

# 25. Google Sheets

Google Sheets تكامل مساعد.

يمكن استخدامه من أجل:

- Import.
    
- Export.
    
- Synchronization عند الحاجة.
    

لكن Google Sheets:

**ليست قاعدة النظام الرئيسية.**

---

# 26. Google Sheets Data Flow

عند Import:

**Google Sheet**

→ **Field Mapping**

→ **Validation**

→ **Duplicate Analysis**

→ **Import**

→ **Platform Database**

عند Export:

**Platform Data**

→ **Selected Data**

→ **Google Sheet**

الصلاحيات والنطاق يجب أن يطبقا في كلا الاتجاهين.

---

# 27. Import Sources

المصادر المدعومة:

- CSV.
    
- Excel.
    
- Google Sheets.
    
- Manual Lead Creation.
    
- Future API Sources.
    

يجب أن تدعم عملية Import:

- اختيار Branch.
    
- اختيار Campaign عند الحاجة.
    
- Field Mapping.
    
- Validation.
    
- Duplicate analysis.
    
- Preview قبل التنفيذ.
    
- Import result/report.
    

---

# 28. Import Rules

Import لا يجب أن:

- يكسر Branch Isolation.
    
- يتجاوز Field permissions.
    
- يعدل Source Data بشكل غير متوقع.
    
- ينشئ بيانات مكررة بلا تحذير أو معالجة.
    
- يحذف بيانات موجودة دون قاعدة واضحة.
    

---

# 29. AI Integration

AI يستخدم كمساعد.

يمكن أن يقدم:

- Lead summaries.
    
- Intent.
    
- Priority.
    
- Follow-up suggestions.
    
- Agent insights.
    
- Campaign insights.
    
- Branch insights.
    
- Trend detection.
    
- Anomaly detection.
    

---

# 30. AI Failure

إذا كان AI unavailable:

- Lead Management يستمر.
    
- Routing يستمر.
    
- Payments تستمر.
    
- Notifications الأساسية تستمر.
    
- Enrollment يستمر.
    
- Analytics الأساسية تستمر.
    

AI ليس Dependency حرجة لـCore Operations.

---

# 31. Future Lead Sources

النظام يجب أن يكون قابلاً لإضافة:

- Website Forms.
    
- Google Ads.
    
- TikTok.
    
- API.
    
- Additional advertising platforms.
    
- Additional import methods.
    

المبدأ:

**أي مصدر جديد يجب أن يتحول إلى Lead داخل نفس Domain Model دون إنشاء نظام Lead منفصل لكل مصدر.**

---

# 32. Integration Source of Truth

الخدمات الخارجية قد تكون:

### Source of Data

مثل Meta.

### Service Provider

مثل WhatsApp أو Payment Provider.

### Optional Data Tool

مثل Google Sheets.

لكن:

**Platform remains the operational Source of Truth.**

---

# 33. Integration Status

يجب أن يكون لدى الإدارة طريقة لمعرفة حالة التكاملات.

مثلاً:

- Connected.
    
- Not configured.
    
- Warning.
    
- Error.
    
- Disconnected.
    

مع إظهار معلومات مفيدة مثل:

- آخر مزامنة.
    
- آخر فشل.
    
- عدد الأحداث الفاشلة.
    
- الإجراء المطلوب.
    

حسب طبيعة التكامل.

---

# 34. Integration Permissions

### Super Admin

تحكم كامل بالتكاملات.

### Manager

يمكنه إدارة التكاملات التي تقع ضمن نطاق Branch الخاص به إذا كان ذلك مسموحاً من النظام.

### Agent

لا يدير Integration Configuration.

---

# 35. Integration History

يجب أن يمكن تتبع العمليات المهمة المرتبطة بالتكاملات.

مثل:

- Connection created.
    
- Configuration changed.
    
- Sync started.
    
- Sync completed.
    
- Sync failed.
    
- Incoming event.
    
- Payment event.
    
- Notification failure.
    

---

# 36. Data Flow Principles

يجب أن تكون تدفقات البيانات واضحة:

### Meta

Meta  
→ Platform  
→ Campaign  
→ Branch  
→ Lead  
→ Agent

### WhatsApp

Platform  
→ Notification  
→ WhatsApp Provider  
→ Agent

### Payment

Lead  
→ Payment Link  
→ Payment Provider  
→ Confirmation  
→ Platform  
→ Enrollment

### Google Sheets

Sheet  
↔ Platform

لكن Platform هي المصدر التشغيلي الرئيسي.

### AI

Platform Data  
→ AI  
→ Suggestions / Insights  
→ Platform UI

AI لا يصبح مصدراً مستقلاً للبيانات الأساسية.

---

# PART B — UI & UX REQUIREMENTS

# 37. General UX Principles

المنصة يجب أن تكون:

- واضحة.
    
- بسيطة.
    
- عملية.
    
- سريعة الفهم.
    
- قليلة الخطوات.
    
- مناسبة للمستخدم غير التقني.
    
- قابلة للاستخدام على الشاشات الصغيرة.
    
- مرنة دون أن تصبح معقدة.
    

المرونة الأكبر يجب أن تكون في إعدادات الإدارة، بينما Agent يحصل على تجربة أبسط.

---

# 38. Global Navigation

Navigation يختلف حسب Role.

## Super Admin

- Dashboard.
    
- Leads.
    
- Contacts.
    
- Branches.
    
- Users.
    
- Campaigns.
    
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
    
- Fields.
    
- Routing.
    
- Payments.
    
- Enrollments.
    
- Analytics.
    
- Automations.
    
- Notifications.
    
- Settings.
    

## Agent

- Dashboard.
    
- My Leads.
    
- Follow-ups.
    
- Notifications.
    
- Profile.
    

يمكن أن تختلف عناصر Navigation الفعلية حسب الصلاحيات.

---

# 39. Super Admin Dashboard

يجب أن يقدم نظرة شاملة عن النظام.

يمكن أن يشمل:

- Total Leads.
    
- New Leads.
    
- Leads by Branch.
    
- Leads by Campaign.
    
- Agent performance.
    
- Payments.
    
- Enrollments.
    
- Conversion.
    
- Revenue.
    
- Follow-ups.
    
- Leads requiring attention.
    
- Integration alerts.
    
- System alerts.
    

---

# 40. Manager Dashboard

يجب أن يركز على Branch.

يمكن أن يعرض:

- Branch Leads.
    
- New Leads.
    
- Unassigned Leads.
    
- Agent workload.
    
- Follow-ups.
    
- Overdue Leads.
    
- Payment Pending.
    
- Enrollments.
    
- Campaign performance.
    
- Leads requiring attention.
    

---

# 41. Agent Dashboard

يجب أن يركز على العمل اليومي.

يمكن أن يعرض:

- New Leads.
    
- My active Leads.
    
- Follow-ups due today.
    
- Overdue Follow-ups.
    
- Priority Leads.
    
- Payment Pending.
    
- Recently updated Leads.
    

يجب ألا يتحول Dashboard الخاص بالAgent إلى لوحة Analytics معقدة.

---

# 42. Campaign Management Screen

يجب أن تسمح الشاشة للمسؤول بإدارة:

- Campaign name.
    
- Source.
    
- Branch.
    
- Eligible Agents.
    
- Routing.
    
- Fields.
    
- Visibility.
    
- Editability.
    
- Automations.
    
- Status.
    
- إعدادات التشغيل المرتبطة بالحملة.
    

---

# 43. Campaign Setup Workflow

المسار:

**Create Campaign**

→ إدخال اسم الحملة

→ ربط المصدر

→ اختيار Branch

→ اختيار Agents

→ تحديد Routing

→ إعداد Fields

→ تحديد Visibility

→ تحديد Editability

→ إعداد Automations عند الحاجة

→ Review

→ Activate

ويجب أن يكون واضحاً للمستخدم ما الذي ينقص قبل تفعيل Campaign.

---

# 44. Field Builder

Field Builder هو من أهم أجزاء الواجهة.

يجب أن يسمح لـManager / Super Admin بـ:

- Add Field.
    
- Edit Field.
    
- Disable Field.
    
- Reorder Field.
    
- Select type.
    
- Add options.
    
- Edit options.
    
- Required / Optional.
    
- Visible / Hidden.
    
- Editable / Read-only.
    
- Show in Lead Table.
    
- Show in Lead Details.
    
- Use in Filters.
    
- Use in Automation عند الحاجة.
    
- Configure Calculated Field عند الحاجة.
    

---

# 45. Field Builder UX

الهدف هو أن يشعر المستخدم أن إنشاء الأعمدة مرن وسهل، قريب من فكرة Spreadsheet:

**Add Column → Name → Type → Configure → Save**

لكن مع:

- Permissions.
    
- Validation.
    
- Field types.
    
- Campaign scope.
    
- Business Rules.
    

لا يجب أن تتحول المنصة إلى Spreadsheet عامة غير منظمة.

---

# 46. Lead List

Lead List يجب أن تكون مرنة.

يجب أن تسمح بـ:

- Search.
    
- Filters.
    
- Sorting.
    
- Saved Views.
    
- Column selection.
    
- Bulk selection.
    
- Bulk actions.
    

الأعمدة المعروضة تعتمد على:

- Campaign.
    
- User permissions.
    
- Field configuration.
    

---

# 47. Lead Table Columns

Manager / Super Admin يستطيعان تحديد الأعمدة المعروضة حسب Campaign.

Agent يرى فقط الأعمدة التي يسمح النظام له برؤيتها.

يجب أن يدعم النظام:

- إظهار عمود.
    
- إخفاء عمود.
    
- ترتيب الأعمدة.
    
- تعديل عرض العمود عندما يكون ذلك مناسباً.
    
- حفظ إعدادات العرض حسب المستخدم أو Campaign وفق التصميم.
    

---

# 48. Lead Details

Lead Details هي الشاشة الرئيسية للتشغيل.

يجب أن تحتوي على مناطق واضحة:

## Contact

بيانات الشخص.

## Campaign

المصدر والحملة.

## Dynamic Fields

الحقول المطبقة على هذه الحملة.

## Assignment

Branch + Agent.

## Follow-ups

المتابعات.

## Payment

الدفع.

## Enrollment

الاشتراك.

## Activity

التاريخ.

## Actions

الإجراءات التي يسمح بها المستخدم.

---

# 49. Lead Details Dynamic Behavior

Lead Details لا يجب أن تعرض مجموعة ثابتة من الحقول.

يجب أن تعتمد على:

- Campaign.
    
- Field configuration.
    
- Role.
    
- User permissions.
    

مثلاً:

Campaign A تعرض 12 Field.

Campaign B تعرض 25 Field.

Campaign C تعرض 8 Fields.

ويستطيع Agent رؤية subset فقط من الحقول إذا كانت صلاحياته تتطلب ذلك.

---

# 50. Agent Lead Editing

Agent يستطيع من Lead Details:

- تحديث Fields المسموحة.
    
- تسجيل نتيجة التواصل.
    
- إضافة Note.
    
- إنشاء Follow-up.
    
- إكمال Follow-up.
    
- استخدام إجراءات Payment المسموحة.
    
- رؤية حالة Enrollment.
    

يجب أن تكون الخطوات الأساسية قليلة وواضحة.

---

# 51. Lead Status Editing

إذا كانت Campaign تستخدم Status:

يجب أن تكون عملية تغييره سهلة وسريعة من Lead Details.

ولا يجب إجبار Campaigns الأخرى على استخدام Status.

---

# 52. Follow-up UI

يجب توفير:

- Create Follow-up.
    
- Edit.
    
- Complete.
    
- Cancel.
    
- Reschedule.
    

Dashboard وLead Details يمكن أن يعرضا:

- Upcoming.
    
- Due Today.
    
- Overdue.
    

---

# 53. Payment UI

## Manager / Super Admin

يمكنهما إدارة:

- Payment Methods.
    
- Availability.
    
- Configuration المناسبة.
    

## Agent

يمكنه:

- إنشاء Payment Link أو استخدامه حسب الصلاحية.
    
- رؤية Payment Status.
    
- الوصول إلى Payment Link عند الحاجة.
    

---

# 54. Enrollment UI

Lead Details يجب أن تعرض بوضوح:

- هل الشخص Enrolled / Subscribed؟
    
- متى تم التسجيل؟
    
- Payment المرتبط عند الحاجة.
    

ولا يجب السماح بتغيير Enrollment بطريقة تتجاوز قواعد Payment.

---

# 55. Notification Center

Notification Center يعرض:

- New Lead.
    
- Assignment.
    
- Reassignment.
    
- Follow-up.
    
- Payment.
    
- Enrollment.
    
- System Alerts.
    

يجب التمييز بين:

- Read.
    
- Unread.
    
- Important.
    

---

# 56. Notification Preferences

المستخدم يمكنه إدارة Preferences التي يسمح النظام بتخصيصها.

يمكن أن تشمل:

- In-App.
    
- Email.
    
- WhatsApp.
    

بعض Notifications قد تبقى إلزامية.

---

# 57. Analytics UI

Analytics يجب أن تدعم:

- Date range.
    
- Branch.
    
- Campaign.
    
- Agent.
    
- Source.
    
- Relevant custom fields عند الحاجة.
    

يجب أن تكون قابلة للفهم بدون الحاجة إلى تحليل تقني.

---

# 58. Analytics Drill-down

عند الضغط على Metric:

يمكن عند الحاجة الانتقال إلى:

**Metric → Filtered Lead List**

مثال:

**Enrolled = 43**

→ عرض الـ43 Lead المرتبطة بالرقم.

---

# 59. Automation UI

يجب أن يكون إنشاء Automation واضحاً:

**Trigger**

↓

**Conditions**

↓

**Actions**

مثال:

Payment Confirmed  
→ Mark Enrollment  
→ Notify Agent

أو:

Follow-up Overdue  
→ Notify Agent  
→ Notify Manager

---

# 60. AI UI

AI features يجب ألا تسيطر على الواجهة.

يمكن عرض:

- Lead Summary.
    
- Lead Priority.
    
- Suggested Next Action.
    
- Agent Insights.
    
- Campaign Insights.
    
- Leads Needing Attention.
    

ويجب أن تكون توصيات AI واضحة على أنها suggestions/insights وليست Business Truth.

---

# 61. Search & Filters UI

Search:

- Name.
    
- Phone.
    
- Email.
    
- Lead ID.
    

Additional search حسب الحملة والحقول المناسبة.

Filters:

- Campaign.
    
- Branch.
    
- Agent.
    
- Date.
    
- Payment.
    
- Enrollment.
    
- Custom Fields.
    
- Status عند توفره.
    
- Interest عند توفره.
    
- Tags عند توفرها.
    

---

# 62. Saved Views UI

المستخدم يستطيع:

1. اختيار Filters.
    
2. اختيار Sorting.
    
3. اختيار Columns.
    
4. حفظ View.
    
5. إعادة استخدامها لاحقاً.
    

Saved Views لا تتجاوز Permissions الحالية.

---

# 63. Bulk Actions UI

يتم تحديد مجموعة Leads ثم اختيار Action.

Examples:

- Assign.
    
- Change Field.
    
- Change Status.
    
- Add Tag.
    
- Remove Tag.
    
- Create Follow-up.
    
- Export.
    

يجب إظهار Confirmation قبل الإجراءات الحساسة أو واسعة النطاق.

---

# 64. Import UI

Import workflow:

**Upload**

→ **Detect**

→ **Map Fields**

→ **Validate**

→ **Preview**

→ **Duplicate Review**

→ **Import**

→ **Result**

النتيجة يجب أن توضح:

- Imported.
    
- Skipped.
    
- Invalid.
    
- Duplicate.
    
- Failed.
    

---

# 65. Integration Management UI

Super Admin يجب أن يرى صفحة واضحة للتكاملات.

يمكن أن تعرض:

- Integration name.
    
- Status.
    
- Connected / Not connected.
    
- Last activity.
    
- Last synchronization.
    
- Last error.
    
- Required action.
    

Manager يرى فقط التكاملات التي تقع ضمن صلاحياته.

Agent لا يدير Integrations.

---

# 66. WhatsApp Management UI

الإدارة تتولى:

- Provider configuration.
    
- Connection status.
    
- Sender configuration.
    
- Message templates / wording.
    
- Delivery status.
    
- Error state.
    

Agent لا يرى إعدادات Provider.

Agent يرى فقط:

**Phone Number**

ويستخدم الإشعارات دون إعداد تقني.

---

# 67. Payment Management UI

Manager يرى Payment Methods الخاصة بفرعه.

Super Admin يرى الجميع.

المعلومات الحساسة الخاصة بالمزود يجب ألا تظهر في واجهات لا تحتاجها.

---

# 68. Agent Profile

Agent Profile يجب أن يسمح له بإدارة البيانات الشخصية التي يحتاجها، مثل:

- Name.
    
- Phone.
    
- Notification preferences.
    

رقم الهاتف المستخدم لـWhatsApp يدخل من هنا.

لا يوجد أي إعداد API أو Business Account للـAgent.

---

# 69. Manager Agent Management

Manager يجب أن يستطيع:

- Create Agent.
    
- Edit Agent.
    
- Activate / Deactivate Agent.
    
- Set phone.
    
- Set working hours.
    
- Set capacity.
    
- Manage operational settings.
    
- معرفة حالة Agent.
    

---

# 70. Empty States

كل شاشة رئيسية يجب أن توفر Empty State واضحة.

مثلاً:

لا توجد Leads بعد.

يجب أن توضّح:

- ماذا يعني ذلك.
    
- ما الإجراء التالي.
    
- هل يمكن إنشاء/ربط البيانات من هذه الشاشة.
    

---

# 71. Loading States

العمليات التي تحتاج وقتاً يجب أن تظهر Loading State واضحة.

خصوصاً:

- Import.
    
- Sync.
    
- Analytics.
    
- Payment.
    
- Integration actions.
    

---

# 72. Error States

عند حدوث خطأ:

- شرح مفهوم وواضح.
    
- عدم إظهار معلومات تقنية حساسة للمستخدم العادي.
    
- إعطاء الإجراء الممكن عند الحاجة.
    
- عدم فقدان البيانات التي تم إدخالها.
    

---

# 73. Permission States

إذا لم يكن المستخدم يملك صلاحية:

- لا يجب إظهار Action كأنه متاح ثم يفشل فقط بعد الضغط.
    
- يجب توضيح أن الوصول غير مسموح إذا كان من المفيد إظهار العنصر.
    
- يجب ألا تتحول الواجهة إلى وسيلة للوصول إلى بيانات غير مسموح بها.
    

---

# 74. Responsive Design

يجب أن تعمل الواجهة على:

- Desktop.
    
- Tablet.
    
- Mobile.
    

لكن الأولوية التشغيلية للـAgent على الهاتف.

الـManager وSuper Admin يحتاجان إلى واجهة إدارة أكثر اتساعاً على Desktop مع دعم الأجهزة الصغيرة.

---

# 75. Arabic RTL

عند اختيار العربية:

- Navigation يدعم RTL.
    
- Tables تتعامل مع RTL بشكل صحيح.
    
- Forms تعمل بشكل طبيعي.
    
- Filters.
    
- Modals.
    
- Sidebars.
    
- Text alignment.
    
- الاتجاه العام للواجهة.
    

---

# 76. French & English

French وEnglish تستخدمان LTR.

التخطيط يجب أن يتكيف مع اللغات المختلفة دون كسر:

- Tables.
    
- Buttons.
    
- Labels.
    
- Forms.
    
- Navigation.
    

---

# 77. Date & Time Experience

التاريخ والوقت يجب أن يظهرا بطريقة مفهومة للمستخدم.

عند عرض أوقات مهمة مثل:

- Lead received.
    
- First contact.
    
- Last contact.
    
- Payment.
    
- Follow-up.
    

يجب أن يكون السياق الزمني واضحاً.

أي تحويل زمني يجب ألا يسبب فقدان الوقت الأصلي.

---

# 78. Core UX Principles

يجب أن تحقق الواجهة:

- أقل عدد مناسب من الخطوات.
    
- وضوح الإجراء التالي.
    
- عدم إخفاء المعلومات المهمة.
    
- عدم عرض إعدادات لا تخص المستخدم.
    
- مرونة الحقول دون تعقيد.
    
- سهولة التشغيل اليومية.
    
- سرعة الوصول إلى Lead Details.
    
- وضوح الحالة الحالية.
    
- وضوح الخطوة التالية.
    

---

# 79. Central User Experience

الهدف الأساسي:

عند فتح Lead يجب أن يعرف المستخدم:

1. من هو الشخص؟
    
2. ماذا يريد؟
    
3. من أين جاء؟
    
4. لأي Campaign ينتمي؟
    
5. لأي Branch ينتمي؟
    
6. من المسؤول عنه؟
    
7. ما البيانات المهمة عنه؟
    
8. ماذا حدث معه؟
    
9. ما الذي يجب فعله الآن؟
    
10. هل يوجد Follow-up؟
    
11. هل يوجد Payment؟
    
12. هل أصبح Enrolled؟
    

---

# 80. Manager Experience

Manager يجب أن يستطيع تشغيل Branch دون الحاجة إلى أدوات خارجية لإدارة العملية اليومية.

من إعداد Campaign:

**Campaign → Agents → Routing → Fields → Automations**

إلى التشغيل:

**Leads → Follow-ups → Payments → Enrollments → Analytics**

---

# 81. Agent Experience

Agent يجب أن يحصل على تجربة بسيطة:

**New Lead**

→ Open

→ Contact

→ Update

→ Follow-up

→ Payment

→ Enrollment

ولا يحتاج إلى معرفة كيف تم بناء النظام أو كيف تعمل التكاملات خلفه.

---

# 82. Product Boundary

الواجهة والتكاملات لا يجب أن توسع المنتج إلى:

- WhatsApp CRM.
    
- Full accounting.
    
- LMS.
    
- Course management.
    
- ERP.
    
- Complex financial management.
    

كل UI وIntegration يجب أن يخدم الـLead Operations lifecycle الأساسي.

---

# 83. Technical Decision Boundary

هذه الوثيقة تحدد **السلوك الوظيفي والتجربة المطلوبة**.

لا تفرض أي تقنية محددة.

على التصميم التقني لاحقاً اختيار الطريقة الأنسب لتحقيق:

- Functional requirements.
    
- Security.
    
- Reliability.
    
- Data integrity.
    
- Maintainability.
    
- Performance.
    
- Scalability.
    
- Reasonable cost.
    
- Simple operational experience.
    
- Provider independence.
    

---

# 84. Final Integration & UI Principle

كل التكاملات والشاشات يجب أن تخدم نفس المنظومة:

**Lead Source**

→ **Campaign**

→ **Branch**

→ **Agent**

→ **Follow-up**

→ **Payment**

→ **Enrollment**

→ **Analytics**

→ **Automation / AI**

مع بقاء:

- Meta كمصدر Leads أساسي.
    
- WhatsApp كقناة Notifications.
    
- Payment Providers كخدمات دفع.
    
- Google Sheets كأداة مساعدة.
    
- AI كطبقة مساعدة.
    

والمنصة نفسها هي **المركز الرئيسي للبيانات والعمليات التشغيلية**.