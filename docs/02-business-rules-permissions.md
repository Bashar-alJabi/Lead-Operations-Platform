# Business Rules & Permissions

# 1. Purpose

هذه الوثيقة تحدد:

- صلاحيات كل Role.
    
- نطاق الوصول إلى البيانات.
    
- قواعد إدارة Branches وCampaigns وLeads.
    
- قواعد الحقول الديناميكية.
    
- قواعد التوزيع.
    
- قواعد المتابعة.
    
- قواعد الدفع والاشتراك.
    
- قواعد Notifications.
    
- قواعد Automations.
    
- حدود استخدام AI.
    
- قواعد الحفاظ على البيانات والتاريخ.
    

هذه الوثيقة تحدد **السلوك المطلوب من النظام**، ولا تحدد طريقة تنفيذه تقنياً.

---

# 2. Roles

يوجد ثلاثة أدوار رئيسية فقط:

1. Super Admin
    
2. Manager
    
3. Agent
    

لا يوجد Public Signup.

إنشاء المستخدمين يتم من خلال المستخدمين المصرح لهم بذلك.

---

# 3. Super Admin

Super Admin يمتلك صلاحية الوصول الكاملة إلى النظام.

## 3.1 Users

يستطيع:

- إنشاء Managers.
    
- تعديل Managers.
    
- تعطيل Managers.
    
- إنشاء Agents.
    
- تعديل Agents.
    
- تعطيل Agents.
    
- إدارة بيانات المستخدمين.
    
- إدارة صلاحيات الوصول التي يوفرها النظام.
    
- ربط المستخدمين بالـBranch المناسب.
    

---

## 3.2 Branches

يستطيع:

- إنشاء Branch.
    
- تعديل Branch.
    
- تعطيل Branch.
    
- إدارة Manager.
    
- إدارة Agents.
    
- رؤية جميع البيانات.
    
- نقل Leads بين Branches.
    
- إدارة إعدادات Branch.
    

---

## 3.3 Leads

يستطيع:

- رؤية جميع Leads.
    
- إنشاء Lead.
    
- تعديل Lead.
    
- نقل Lead بين Branches.
    
- إعادة تعيين Agent.
    
- تعديل البيانات التي تسمح بها Business Rules.
    
- الوصول إلى Activity History.
    
- الوصول إلى Payment وEnrollment information.
    
- تنفيذ Bulk Actions على البيانات المسموح بها.
    
- Export البيانات.
    

---

## 3.4 Campaigns

يستطيع:

- إنشاء Campaign.
    
- تعديل Campaign.
    
- تعطيل Campaign.
    
- ربط Campaign بالمصادر.
    
- اختيار Branch.
    
- اختيار Agents.
    
- إعداد Routing.
    
- إعداد Fields.
    
- إعداد Visibility.
    
- إعداد Editability.
    
- إعداد Automations.
    

---

## 3.5 Fields

يستطيع:

- إنشاء Field.
    
- تعديل Field.
    
- تعطيل Field.
    
- إعادة ترتيب Fields.
    
- تحديد Type.
    
- تحديد Required.
    
- تحديد Visibility.
    
- تحديد Editability.
    
- تحديد Options.
    
- تحديد استخدام Field في Tables.
    
- تحديد استخدام Field في Details.
    
- تحديد استخدام Field في Filters.
    
- إعداد Calculated Fields.
    
- إعادة استخدام Fields عند الحاجة.
    

---

## 3.6 Payments

يستطيع:

- إدارة Payment Methods لجميع Branches.
    
- إدارة إعدادات Payment Providers.
    
- رؤية Payments لجميع Branches.
    
- رؤية Payment Links.
    
- رؤية Enrollment results المرتبطة بالدفع.
    

---

## 3.7 Integrations

يستطيع:

- إدارة Integrations.
    
- إدارة إعدادات Meta.
    
- إدارة WhatsApp Provider.
    
- إدارة Payment Providers.
    
- إدارة Email.
    
- إدارة Google Sheets.
    
- إدارة AI integration.
    
- إدارة أي Integrations مستقبلية.
    

Credentials الحساسة لا يجب عرضها للمستخدمين غير المصرح لهم.

---

## 3.8 Analytics

يستطيع الوصول إلى Analytics على مستوى:

- Organization.
    
- Branch.
    
- Campaign.
    
- Agent.
    
- Lead.
    
- Payment.
    
- Enrollment.
    

---

## 3.9 Audit Logs

يستطيع رؤية Audit Logs على مستوى النظام.

---

# 4. Manager

Manager مسؤول عن Branch واحد فقط.

## 4.1 Branch Scope

Manager:

- لا يستطيع رؤية Branch آخر.
    
- لا يستطيع تعديل Branch آخر.
    
- لا يستطيع الوصول إلى Leads في Branch آخر.
    
- لا يستطيع إدارة Agents من Branch آخر.
    
- لا يستطيع الوصول إلى Campaigns من Branch آخر.
    
- لا يستطيع إدارة Payment Methods من Branch آخر.
    

---

# 5. Manager — Users

يستطيع:

- إنشاء Agents داخل Branch.
    
- تعديل Agents داخل Branch.
    
- تعطيل Agents داخل Branch.
    
- تحديث بيانات Agent التشغيلية.
    
- إدارة Agent phone number.
    
- إدارة Agent working hours.
    
- إدارة Agent capacity.
    
- إدارة إعدادات Agent التشغيلية التي يسمح بها النظام.
    

لا يستطيع:

- إنشاء Manager آخر.
    
- إنشاء Super Admin.
    
- إدارة مستخدم خارج Branch الخاص به.
    

---

# 6. Manager — Leads

يستطيع:

- رؤية جميع Leads في Branch.
    
- فتح Lead Details.
    
- تعديل البيانات المسموح بها.
    
- إعادة تعيين Lead بين Agents في Branch.
    
- إنشاء Lead عند الحاجة.
    
- إضافة Notes عند الحاجة.
    
- إدارة Follow-ups.
    
- تنفيذ Bulk Actions ضمن Branch.
    
- Export البيانات التي يملك صلاحية الوصول إليها.
    

لا يستطيع نقل Lead إلى Branch آخر.

---

# 7. Manager — Campaigns

يستطيع إدارة Campaigns الخاصة بفرعه.

يمكنه:

- إنشاء Campaign.
    
- تعديل Campaign.
    
- تعطيل Campaign.
    
- ربط Campaign بمصدر Leads.
    
- اختيار Agents.
    
- إعداد Routing.
    
- إعداد Fields.
    
- إعداد Visibility.
    
- إعداد Editability.
    
- إعداد Automations.
    
- تحديد الإعدادات التشغيلية الخاصة بالحملة.
    

---

# 8. Manager — Field Management

هذه من أهم صلاحيات Manager.

يمكنه إنشاء وإدارة الحقول الخاصة بالحملات ضمن Branch الخاص به.

يمكنه:

- إنشاء Field.
    
- اختيار Field Type.
    
- تسمية Field.
    
- تعديل Label.
    
- إضافة Options.
    
- تعديل Options.
    
- تحديد Required / Optional.
    
- تحديد Visible / Hidden.
    
- تحديد Editable / Read-only.
    
- تحديد ترتيب Field.
    
- تحديد ظهوره في جدول Leads.
    
- تحديد ظهوره في Lead Details.
    
- تحديد استخدامه في Filters.
    
- تحديد ظهوره للAgent.
    
- تحديد استخدامه في Automations.
    
- إنشاء Calculated Fields عندما يسمح النظام بذلك.
    
- تعطيل Field غير المستخدم.
    

---

# 9. Field Ownership Rules

Field ليس بالضرورة ملكاً للنظام كله.

يمكن أن يكون:

- System-level.
    
- Branch-level.
    
- Campaign-specific.
    

Manager لا يستطيع تعديل Field خارج نطاق الصلاحيات الممنوحة له.

إذا كان Field يستخدم في أكثر من Campaign، يجب ألا يؤدي تعديل إعدادات Campaign واحدة إلى تغيير استخدامه في Campaign أخرى بشكل غير مقصود.

---

# 10. Agent

Agent هو المستخدم التشغيلي.

## Agent Scope

Agent يرى فقط البيانات التي تسمح بها صلاحياته ونطاقه التشغيلي.

الافتراضي:

**Agent → Leads المخصصة له**

---

# 11. Agent — Read Permissions

Agent يستطيع رؤية:

- Lead Details.
    
- Contact information التي يحتاجها.
    
- Campaign information المسموح بها.
    
- Fields المسموح له برؤيتها.
    
- Follow-ups المرتبطة بLeads التي يملك الوصول إليها.
    
- Payment Status.
    
- Enrollment Status.
    
- Activity information المسموح بها.
    
- Notifications الخاصة به.
    

---

# 12. Agent — Edit Permissions

Agent يستطيع تعديل:

- Campaign Fields التي تم السماح له بتعديلها.
    
- Operational information الخاصة بالـLead.
    
- Notes.
    
- Follow-ups.
    
- البيانات المطلوبة لتسجيل نتيجة التواصل.
    

Agent لا يستطيع تعديل:

- Campaign structure.
    
- Field definitions.
    
- Field types.
    
- Field options التي يديرها Manager.
    
- Routing configuration.
    
- Branch configuration.
    
- Payment Method configuration.
    
- Integration credentials.
    

---

# 13. Agent — Field Rules

وجود Field على Lead لا يعني أن Agent يستطيع تعديله.

لكل Field يمكن أن تكون هناك:

- Visibility rule.
    
- Editability rule.
    

وبالتالي يمكن أن يكون Field:

### Visible + Editable

Agent يراه ويعدله.

### Visible + Read-only

Agent يراه ولا يعدله.

### Hidden

Agent لا يراه.

### System-managed

النظام يديره.

### Calculated

النظام يحسبه.

---

# 14. Contact Rules

Contact يمثل الشخص.

عند وصول Lead جديد:

- يتم محاولة ربطه بـContact موجود.
    
- وجود Contact سابق لا يمنع إنشاء Lead جديدة.
    
- نفس الشخص يمكن أن يمتلك عدة Leads.
    
- لا يجب حذف Lead جديدة لمجرد أن Contact موجود.
    
- يجب الحفاظ على Source information.
    

---

# 15. Lead Creation Rules

Lead يمكن أن تُنشأ من:

- Meta.
    
- Manual Entry.
    
- CSV.
    
- Excel.
    
- Google Sheets.
    
- API.
    
- Future Sources.
    

عند إنشاء Lead يجب ربطها بالمعلومات المتوفرة عنها، مثل:

- Contact.
    
- Source.
    
- Campaign عند توفرها.
    
- Branch.
    
- Assignment عند توفره.
    
- Field Values.
    

---

# 16. Campaign Rules

Campaign تحدد طريقة تشغيل مجموعة Leads مرتبطة بها.

يجب أن تحتوي Campaign على الإعدادات اللازمة لتحديد:

- Branch.
    
- Eligible Agents.
    
- Routing.
    
- Fields.
    
- Visibility.
    
- Editability.
    
- Automations.
    

---

# 17. Campaign Activation

قبل تفعيل Campaign، يجب أن تكون الإعدادات الأساسية المطلوبة مكتملة.

مثل:

- Source connection عند الحاجة.
    
- Branch.
    
- Agents أو طريقة مناسبة للتعامل مع عدم وجود Agents.
    
- Field configuration عند الحاجة.
    
- Routing configuration إذا تم تفعيل التوزيع التلقائي.
    

إذا كانت إعدادات ضرورية ناقصة، يجب ألا يعتبر النظام Campaign جاهزة للعمل بدون تنبيه أو معالجة واضحة.

---

# 18. Campaign Deactivation

عند تعطيل Campaign:

- لا تستقبل Leads جديدة منها بالطريقة التشغيلية المعتادة.
    
- Leads السابقة لا يتم حذفها.
    
- البيانات التاريخية تبقى محفوظة.
    
- Leads النشطة لا تختفي.
    
- يجب استمرار إمكانية إدارة Leads السابقة وفق الصلاحيات.
    

---

# 19. Meta Source Rules

عند وصول Lead من Meta:

1. يتم التعرف على الحملة/المصدر المرتبط.
    
2. يتم تطبيق Campaign configuration.
    
3. يتم ربط Lead بالـBranch.
    
4. يتم إنشاء أو ربط Contact.
    
5. يتم إنشاء Lead.
    
6. يتم تطبيق Field Mapping.
    
7. يتم تنفيذ Routing إذا كان مفعلاً.
    
8. يتم إشعار Agent عند التعيين.
    

إذا تعذر ربط Lead بـCampaign معروفة:

- لا يتم ربطها بحملة عشوائية.
    
- يجب الاحتفاظ بالـLead.
    
- يجب تسجيل المشكلة.
    
- يجب إشعار الجهة المسؤولة وفق الإعدادات.
    

---

# 20. Source Data Rules

البيانات القادمة من Meta أو أي Source خارجي يجب أن تبقى قابلة للتتبع.

لا يتم تغيير Source Data الأصلية لمجرد أن Agent عدّل البيانات التشغيلية.

إذا احتاج العمل إلى قيمة مصححة:

يمكن استخدام Operational Field منفصل.

---

# 21. Field Rules

لا توجد مجموعة Fields إجبارية واحدة لكل Campaign.

كل Campaign يمكن أن تستخدم Fields مختلفة.

Manager / Super Admin يحددان:

- ماذا يتم جمعه.
    
- ماذا يظهر.
    
- ماذا يتم تعديله.
    
- ماذا يتم حسابه.
    
- ماذا يستخدم في Filters.
    
- ماذا يستخدم في Automation.
    

---

# 22. Required Fields

إذا حُدد Field على أنه Required:

- يجب أن تتوفر قيمته عند النقطة التي تتطلبها Business Rule.
    
- يجب منع أو تنبيه المستخدم عند محاولة إكمال العملية بدونها.
    
- لا يعني Required بالضرورة أنه مطلوب عند إنشاء Lead؛ ذلك يعتمد على إعداد الحملة وسياق العملية.
    

---

# 23. Calculated Fields

Calculated Field:

- لا يعدله Agent يدوياً.
    
- يتم حسابه وفق تعريفه.
    
- يجب أن يظهر بوضوح على أنه Calculated.
    
- يجب ألا تكون هناك قيمة يدوية تناقض قيمته المحسوبة.
    

---

# 24. Status Rules

Status هو Field Type اختياري.

إذا استخدمته Campaign:

- Manager يحدد القيم.
    
- يحدد ترتيبها.
    
- يمكن استخدامها في Filters.
    
- يمكن استخدامها في Automations.
    
- يمكن استخدامها في Analytics.
    

ليس مطلوباً أن تستخدم جميع Campaigns نفس Statuses.

---

# 25. Interest Rules

Interest هو Field Type اختياري.

يمكن لكل Campaign أن تحدد:

- هل تستخدمه.
    
- ما القيم المتاحة.
    
- كيف يظهر.
    
- من يستطيع تعديله.
    
- أين يستخدم.
    

---

# 26. Tag Rules

Tags اختيارية.

يمكن استخدامها على مستوى النظام أو Branch أو Campaign وفق الإعدادات.

لا يجب إجبار Campaign على استخدامها.

---

# 27. Custom Field History

بالنسبة للحقول المهمة، يجب الاحتفاظ بتاريخ التغيير عندما يكون ذلك مطلوباً.

مثلاً:

Contact Status:

New → Contacted → Interested

History يجب أن يسمح بمعرفة:

- القيمة السابقة.
    
- القيمة الجديدة.
    
- من قام بالتغيير.
    
- وقت التغيير.
    

---

# 28. Lead Assignment Rules

Lead يمكن أن تكون:

- Unassigned.
    
- Assigned.
    

إذا تم تفعيل Automatic Routing، يجب اختيار Agent مؤهل.

---

# 29. Agent Eligibility

يمكن اعتماد عوامل مثل:

- Active.
    
- Branch.
    
- Campaign eligibility.
    
- Capacity.
    
- Working hours.
    
- Availability.
    

Agent غير المؤهل لا يجب أن يستلم Lead تلقائياً.

---

# 30. Routing Methods

النظام يدعم:

### Round Robin

توزيع بالتناوب.

### Weighted

التوزيع باستخدام Weights.

### Performance-Based

التوزيع باستخدام معلومات أداء Agent.

### Manual

التعيين اليدوي.

تفاصيل الخوارزمية الداخلية وكيفية حساب Performance Weight هي قرار تقني/تنفيذي لاحق، لكن السلوك الوظيفي يجب أن يلتزم بالنتيجة المطلوبة.

---

# 31. No Eligible Agent

إذا لم يوجد Agent مؤهل:

- يبقى Lead بدون Assignment.
    
- لا يتم التوزيع العشوائي.
    
- يتم إشعار Manager أو المسؤول المحدد.
    
- يجب أن يظهر Lead ضمن قائمة Leads التي تحتاج معالجة.
    

---

# 32. Capacity Rules

إذا وصل Agent إلى Capacity المحددة:

- لا يتم إعطاؤه Leads جديدة تلقائياً.
    
- يمكن Manager أو Super Admin إعادة التوزيع يدوياً.
    
- Leads الموجودة لديه لا تتأثر.
    

---

# 33. Working Hours Rules

إذا كانت Working Hours مستخدمة في Routing:

- يجب احترامها.
    
- لا يعتبر Agent مؤهلاً للتوزيع خارج وقته إلا إذا سمحت الإعدادات بذلك.
    

Working Hours قد تستخدم أيضاً في Notifications أو Follow-ups حسب الإعدادات.

---

# 34. Manual Reassignment

Manager يستطيع:

**Agent A → Agent B**

داخل Branch.

Super Admin يستطيع:

**Branch A / Agent A → Branch B / Agent B**

عند النقل:

- Current assignment يتغير.
    
- Assignment History تحفظ العملية.
    
- Lead لا يتم فقدانها.
    
- Contact لا يتغير.
    

---

# 35. Agent Deactivation Rules

عند تعطيل Agent:

- يتوقف عن استقبال Leads الجديدة تلقائياً.
    
- لا يجوز أن يبقى مؤهلاً للـAutomatic Routing.
    
- لا تختفي Leads السابقة.
    
- يجب تحديد كيفية التعامل مع Leads النشطة.
    
- التاريخ السابق يبقى محفوظاً.
    

النظام يمكن أن يسمح بإعادة التوزيع التلقائي أو اليدوي حسب الإعدادات والقرار التشغيلي.

---

# 36. Follow-up Rules

Follow-up يمكن أن ينشأ من:

- Agent.
    
- Manager.
    
- Automation.
    

يمكن أن يكون:

- Upcoming.
    
- Due.
    
- Overdue.
    
- Completed.
    
- Cancelled.
    

يجب ألا يختفي Follow-up من التاريخ بعد اكتماله.

---

# 37. Activity Rules

الأحداث المهمة يجب أن تظهر في Activity Timeline.

مثل:

- Lead Created.
    
- Assignment.
    
- Reassignment.
    
- Field Change.
    
- Note.
    
- Follow-up.
    
- Payment.
    
- Enrollment.
    
- Notification.
    

---

# 38. Notes Rules

Agent يمكنه إضافة Notes على Leads التي يملك الوصول إليها.

Manager يستطيع إضافة Notes على Leads في Branch.

Super Admin يستطيع على مستوى النظام.

Note لا يجب أن تُستخدم كبديل للحقول المنظمة عندما تكون المعلومة مهمة للبحث أو Analytics.

---

# 39. WhatsApp Rules

WhatsApp هو Notification Channel فقط.

Agent لا يقوم بإعداد التكامل.

Agent يحتاج فقط:

- Name.
    
- Phone Number.
    

النظام/الإدارة يدير:

- Provider.
    
- Integration.
    
- Credentials.
    
- Message configuration.
    

---

# 40. WhatsApp Failure Rules

إذا فشل إرسال WhatsApp:

- لا يتم حذف Lead.
    
- لا يتراجع Assignment.
    
- لا يفشل Follow-up.
    
- لا يفشل Payment.
    
- لا يفشل Enrollment.
    
- يسجل Notification failure.
    
- يمكن إعادة المحاولة حسب النظام.
    

---

# 41. Payment Method Rules

Payment Methods مرتبطة بBranch.

Manager:

- يضيف Payment Methods لفرعه.
    
- يعدلها.
    
- يعطلها.
    

Super Admin:

- يدير Payment Methods لكل الفروع.
    

Agent:

- لا يدير Payment Methods.
    
- لا يرى Credentials.
    
- يستخدم Payment Method وفق الصلاحيات المتاحة.
    

---

# 42. Payment Link Rules

Payment Link يرتبط بـ:

- Lead.
    
- Payment Method.
    
- Amount عند الحاجة.
    

يمكن إنشاء Link عند الحاجة إلى الدفع.

إنشاء Link يجب أن يسجل في Activity.

---

# 43. Payment Confirmation Rules

فتح Payment Link أو العودة إلى صفحة نجاح لا يكفي وحده لتأكيد الدفع.

يجب أن يكون Payment confirmed بناءً على حدث موثوق من مزود الدفع.

بعد Confirmation:

Payment  
→ Lead Update  
→ Enrollment  
→ Activity  
→ Analytics  
→ Notifications

---

# 44. Enrollment Rules

Enrollment يحدث في التدفق الأساسي بعد Payment Confirmation.

لا يجب اعتبار الشخص Enrolled فقط لأنه:

- طلب Payment Link.
    
- فتح الرابط.
    
- قال للAgent إنه دفع.
    
- عاد إلى صفحة نجاح غير موثوقة.
    

يجب وجود تأكيد دفع مناسب قبل Enrollment.

---

# 45. Payment Scope

خارج نطاق المشروع:

- Installments.
    
- Payment Plans.
    
- Refund Management.
    
- Accounting.
    
- Financial ledger.
    

---

# 46. Notification Rules

Notifications قد تكون:

- In-App.
    
- Email.
    
- WhatsApp.
    

يمكن للمستخدم تعديل بعض Preferences حسب النظام.

Notifications الحرجة يمكن أن تكون إلزامية.

---

# 47. Automation Rules

Automation تتكون من:

**Trigger → Conditions → Actions**

يجب أن:

- تحترم Permissions.
    
- تحترم Branch boundaries.
    
- تحترم Field configuration.
    
- تمنع loops.
    
- تمنع duplicate execution غير المقصود.
    
- تسجل التنفيذ والنتيجة.
    

---

# 48. AI Rules

AI:

- لا يمثل Source of Truth.
    
- لا يغير Permissions.
    
- لا يكسر Branch Isolation.
    
- لا يؤكد Payments.
    
- لا ينشئ صلاحيات.
    
- لا يتجاوز Business Rules.
    
- يمكن تعطله دون إيقاف العمليات الأساسية.
    

إذا كان AI يقترح Action، يجب أن يظل تنفيذ Action خاضعاً للقواعد والصلاحيات.

---

# 49. Import Rules

قبل Import يجب أن يتم التعامل مع:

- Field mapping.
    
- Validation.
    
- Data types.
    
- Required fields عند الحاجة.
    
- Duplicates.
    
- Source attribution.
    

Import لا يجب أن يؤدي إلى تجاوز Permissions أو Branch isolation.

---

# 50. Duplicate Rules

Duplicate handling يجب أن يوازن بين:

- عدم إنشاء سجلات مكررة بشكل غير مقصود.
    
- عدم حذف Lead صحيحة لمجرد أن Contact موجود.
    
- الحفاظ على Source Submission.
    
- السماح لنفس Contact بامتلاك Leads متعددة.
    

Contact matching لا يعني Lead merging تلقائياً.

---

# 51. Bulk Action Rules

Bulk Action متاحة حسب:

- Role.
    
- Branch.
    
- Lead access.
    
- Field permissions.
    

Agent لا يستطيع تنفيذ Bulk Action على Leads لا يملكها.

Manager لا يستطيع تنفيذها خارج Branch.

Super Admin يستطيع على مستوى النظام.

---

# 52. Export Rules

Export يخضع إلى:

- Role.
    
- Branch.
    
- Lead access.
    
- Field visibility.
    
- Data sensitivity.
    

لا يجب أن يحصل المستخدم على Fields أو Leads غير مسموح له بها عبر Export.

---

# 53. Search & Filter Rules

Search وFilters يجب أن تحترم:

- Role.
    
- Branch.
    
- Lead access.
    
- Field visibility.
    

إذا كان Field مخفياً أو غير مسموح به للمستخدم، لا يجب أن يصبح وسيلة للوصول إلى بيانات مخفية.

---

# 54. Saved View Rules

Saved View لا تتجاوز Permissions.

إذا تغيرت صلاحيات المستخدم:

- يجب ألا تصبح View وسيلة للوصول إلى بيانات غير مصرح بها.
    
- يجب أن تتكيف نتائجها مع الصلاحيات الحالية.
    

---

# 55. Audit Rules

العمليات الحساسة يجب أن تكون قابلة للتتبع.

خصوصاً:

- User creation/deactivation.
    
- Permission changes.
    
- Branch changes.
    
- Campaign changes.
    
- Field changes.
    
- Routing changes.
    
- Assignment/Reassignment.
    
- Payment configuration.
    
- Payment events.
    
- Enrollment.
    
- Integration configuration.
    

---

# 56. Security Rules

يجب عدم:

- كشف Secrets.
    
- كشف Provider Credentials للـAgent.
    
- استخدام صلاحيات الواجهة كحماية وحيدة.
    
- السماح لـAgent بالوصول إلى Branch آخر.
    
- السماح لـManager بالوصول إلى Branch آخر.
    
- تجاوز صلاحيات Backend من خلال URL أو API أو Export.
    

الصلاحيات يجب أن تطبق فعلياً على مستوى النظام.

---

# 57. Historical Data Rules

تعديل Current State لا يجب أن يمحو التاريخ المهم.

يجب الحفاظ عند الحاجة على:

- Assignment history.
    
- Field change history.
    
- Activity Timeline.
    
- Payment events.
    
- Enrollment events.
    
- Integration events.
    

---

# 58. Source of Truth Rules

### Platform

هي Source of Truth للبيانات التشغيلية.

### External sources

توفر البيانات أو الخدمات.

### Google Sheets

ليست قاعدة البيانات الرئيسية.

### AI

ليس Source of Truth.

### Agent

ليس Source of Truth مستقل.

البيانات يجب أن تسجل داخل المنصة وفق القواعد المحددة.

---

# 59. Failure Isolation

فشل خدمة خارجية يجب ألا يؤدي تلقائياً إلى فشل Core Operations.

الخدمات التي يجب عزل فشلها تشمل:

- Meta synchronization.
    
- WhatsApp.
    
- Email.
    
- AI.
    
- Google Sheets.
    
- Payment integrations.
    

العمليات الحرجة يجب أن يكون لها سلوك واضح عند فشل التكامل.

---

# 60. Business Rules vs Technical Decisions

هذه الوثيقة تحدد **ما يجب أن يحدث**.

لا تحدد:

- Framework.
    
- Database technology.
    
- Hosting.
    
- Queue system.
    
- Cache.
    
- Programming language.
    
- API framework.
    
- AI model.
    

اختيار طريقة التنفيذ التقنية مسؤولية مرحلة التصميم التقني.

---

# 61. Undetermined Business Rule

إذا واجه النظام حالة لا يوجد لها Rule واضح في هذه الوثيقة أو الـFunctional Concept:

- لا يتم اختراع Business Rule بصمت.
    
- يجب تحديد القرار قبل تنفيذ الجزء المتأثر إذا كان القرار يؤثر على السلوك النهائي للمستخدم أو البيانات.
    

أما التفاصيل الصغيرة التي لا تغير Business Behavior فيمكن حسمها أثناء التنفيذ وفق أبسط حل Production-ready.

---

# 62. Core Permission Matrix

|Capability|Super Admin|Manager|Agent|
|---|---|---|---|
|رؤية جميع Branches|نعم|لا|لا|
|إنشاء Branch|نعم|لا|لا|
|إدارة Managers|نعم|لا|لا|
|إدارة Agents|جميع الفروع|Branch الخاص به|لا|
|رؤية جميع Leads|نعم|Branch الخاص به|Leads المسموحة له|
|نقل Lead بين Branches|نعم|لا|لا|
|نقل Lead بين Agents|نعم|داخل Branch|لا|
|إنشاء Campaign|نعم|Branch الخاص به|لا|
|إدارة Campaign|نعم|Branch الخاص به|لا|
|إنشاء Fields|نعم|Branch الخاص به|لا|
|إدارة Field Configuration|نعم|Branch الخاص به|لا|
|تعديل Lead Fields|حسب الصلاحية|حسب الصلاحية|Fields المسموحة|
|إدارة Routing|نعم|Branch الخاص به|لا|
|إدارة Payment Methods|جميع الفروع|Branch الخاص به|لا|
|استخدام Payment Link|نعم|نعم|حسب الصلاحية|
|إدارة Integrations|نعم|حسب النطاق المسموح|لا|
|إدارة WhatsApp Provider|نعم|حسب الصلاحية|لا|
|إدارة Automations|نعم|Branch الخاص به|لا|
|رؤية Global Analytics|نعم|لا|لا|
|رؤية Branch Analytics|نعم|نعم|ضمن النطاق|
|رؤية Personal Analytics|نعم|نعم|نعم|
|Audit Logs|نعم|وفق النطاق المسموح|لا|
|Export|كامل حسب النظام|Branch|بياناته المسموحة|

---

# 63. Final Business Rule Principle

النظام يجب أن يحقق المبدأ التالي:

**الإدارة تحدد كيف تعمل Campaign والبيانات والـRouting والصلاحيات، والـAgent ينفذ العمليات اليومية ضمن الإعدادات المسموحة له.**

لا يجوز أن يتمكن Agent من تغيير البنية التي تعمل بها المنصة.

ولا يجوز أن يتمكن Manager من تجاوز حدود Branch الخاص به.

ولا يجوز أن يتمكن أي Role من تجاوز Security أو Business Rules من خلال واجهة مختلفة أو API أو Export.