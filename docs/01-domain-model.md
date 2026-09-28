# Domain Model

## 1. Purpose

هذا الملف يحدد **نموذج البيانات والمفاهيم الأساسية للمنصة** والعلاقات بينها.

الهدف هو تحديد:

- ما هي الكيانات الأساسية في النظام.
    
- ما الذي تمثله كل كيان.
    
- كيف ترتبط الكيانات ببعضها.
    
- ما البيانات التي تحتاجها المنصة وظيفياً.
    
- ما البيانات التي يجب الاحتفاظ بها تاريخياً.
    

هذا الملف **لا يفرض**:

- نوع قاعدة البيانات.
    
- Programming Language.
    
- Framework.
    
- ORM.
    
- أسماء الجداول الفعلية.
    
- طريقة تخزين البيانات تقنياً.
    

هذه القرارات يتم تحديدها لاحقاً ضمن التصميم التقني.

---

# 2. Domain Modeling Principles

يجب أن يحافظ نموذج البيانات على المبادئ التالية:

- الفصل بين الشخص نفسه والفرصة/الطلب الخاص به.
    
- دعم أكثر من Lead لنفس Contact.
    
- دعم أكثر من Branch.
    
- دعم أكثر من Campaign.
    
- دعم Campaign-specific Fields.
    
- الحفاظ على Source Data الأصلية.
    
- الحفاظ على التاريخ التشغيلي والتغييرات المهمة.
    
- عدم ربط النظام بمصدر Leads واحد فقط.
    
- عدم فرض مجموعة Fields ثابتة على جميع Campaigns.
    
- الحفاظ على Branch Isolation.
    
- عدم فقدان التاريخ بسبب تعديل البيانات الحالية.
    
- فصل بيانات التشغيل عن إعدادات النظام عند الحاجة.
    

---

# 3. Organization

يمثل الكيان الأعلى الذي يحتوي على النظام الحالي.

حالياً المنتج مصمم لمنظمة واحدة، لكن النموذج يجب ألا يمنع التوسع مستقبلاً إلى أكثر من Organization إذا أصبح ذلك مطلوباً.

## العلاقات

Organization:

- يملك Branches متعددة.
    

---

# 4. Branch

يمثل وحدة تشغيل مستقلة داخل Organization.

يمكن أن يحتوي Branch على:

- Name.
    
- Status.
    
- Manager.
    
- Agents.
    
- Campaigns.
    
- Leads.
    
- Payment Methods.
    
- Automations.
    
- إعدادات التشغيل الخاصة به.
    

## العلاقات

Branch:

- يرتبط بManager.
    
- يحتوي على Agents.
    
- يحتوي على Campaigns.
    
- يحتوي على Leads.
    
- يحتوي على Payment Methods.
    
- يمكن أن يحتوي على Automations.
    
- يمكن أن يحتوي على إعدادات خاصة بالـNotifications والتشغيل.
    

---

# 5. User

يمثل حساب المستخدم الذي يستطيع الدخول إلى المنصة.

الأدوار الحالية:

- Super Admin.
    
- Manager.
    
- Agent.
    

## ملاحظات

Role يحدد مستوى الوصول، لكن الصلاحيات الفعلية تعتمد أيضاً على:

- Branch.
    
- Ownership.
    
- Campaign.
    
- Field permissions.
    
- Actions allowed.
    

---

# 6. Manager

يمثل المستخدم المسؤول عن Branch.

يمكن أن يحتوي Manager على:

- User account.
    
- Assigned Branch.
    
- Status.
    
- Profile information.
    
- Notification preferences.
    

كل Branch في النموذج الحالي له Manager مسؤول عنه.

---

# 7. Agent

يمثل المستخدم التشغيلي الذي يتعامل مع Leads.

يمكن أن يحتوي Agent على:

- User account.
    
- Branch.
    
- Display name.
    
- Phone number.
    
- Active status.
    
- Working hours.
    
- Capacity.
    
- Routing settings.
    
- Notification preferences.
    

رقم الهاتف يستخدم أيضاً لإرسال Notifications عبر WhatsApp.

---

# 8. Contact

يمثل **الشخص نفسه** وليس طلبه.

يمكن أن يحتوي على بيانات أساسية مثل:

- Name.
    
- Phone.
    
- Email.
    
- بيانات تواصل أخرى حسب الحاجة.
    

## العلاقات

Contact:

- يمكن أن يرتبط بـLead واحدة أو أكثر.
    

## قاعدة أساسية

وجود Contact سابق لا يعني أن Lead جديدة يجب أن يتم حذفها.

الشخص نفسه يمكن أن يعود بطلب أو اهتمام مختلف.

---

# 9. Lead

يمثل **فرصة أو طلباً محدداً** مرتبطاً بـContact.

Lead هي الكيان المركزي في عمليات المبيعات.

يمكن أن ترتبط Lead بـ:

- Contact.
    
- Campaign.
    
- Branch.
    
- Agent.
    
- Source.
    
- Dynamic Field Values.
    
- Follow-ups.
    
- Activities.
    
- Payments.
    
- Enrollment.
    
- Notifications المرتبطة بالأحداث الخاصة بها.
    

## أمثلة

Contact:

> Ahmad

Lead 1:

> French Course

Lead 2:

> Arabic Course

Lead 3:

> Private Course

---

# 10. Lead Identity & Metadata

Lead يجب أن يحتفظ بالمعلومات التي تساعد على تعريفه وتتبع مصدره.

يمكن أن تشمل:

- Lead identifier.
    
- Created date.
    
- Updated date.
    
- Source.
    
- Campaign.
    
- External identifiers.
    
- Branch.
    
- Current Agent.
    
- Current operational state.
    

هذه البيانات يجب ألا تكون مرتبطة حصراً بـMeta.

---

# 11. Lead Source

يمثل المصدر الذي جاء منه Lead.

أمثلة:

- Meta.
    
- Manual.
    
- CSV.
    
- Excel.
    
- Google Sheets.
    
- API.
    
- Future Sources.
    

يجب أن يكون مفهوم Source عاماً بما يكفي لدعم مصادر مستقبلية.

---

# 12. Source Submission

يمثل **البيانات الأصلية التي وصلت من مصدر خارجي** قبل أو مع معالجتها داخل المنصة.

يجب أن يسمح هذا المفهوم بالحفاظ على:

- Original source data.
    
- External identifiers.
    
- Original submission information.
    
- Source timestamps عند توفرها.
    
- Source-specific metadata.
    

## الهدف

الحفاظ على البيانات الأصلية من أجل:

- Audit.
    
- Troubleshooting.
    
- Reprocessing.
    
- Mapping.
    
- Historical accuracy.
    

إذا تغيرت طريقة Mapping لاحقاً، لا يجب أن يؤدي ذلك تلقائياً إلى حذف أو تشويه Source Data الأصلية.

---

# 13. Campaign

Campaign هي وحدة تشغيلية تستخدم لتحديد **كيفية التعامل مع Leads القادمة من حملة معينة**.

يمكن أن تكون مرتبطة بمصدر خارجي مثل Meta Campaign أو Form.

Campaign تحدد بشكل مفاهيمي:

- Branch.
    
- Eligible Agents.
    
- Routing configuration.
    
- Field configuration.
    
- Visibility rules.
    
- Editability rules.
    
- Automation configuration.
    
- Source configuration.
    

---

# 14. External Campaign Reference

يمثل هوية Campaign في مصدر خارجي.

يمكن أن يحتوي مفهومياً على:

- Source / Provider.
    
- External Campaign ID.
    
- External Campaign Name.
    
- External metadata عند الحاجة.
    

الهدف هو ربط Campaign الموجودة في المنصة بالحملة الموجودة في النظام الخارجي.

---

# 15. Form

يمثل نموذجاً يتم من خلاله جمع Lead Information.

يمكن أن يكون مرتبطاً بمصدر خارجي.

يمكن أن يحتوي على:

- Name.
    
- External Form ID.
    
- Source.
    
- Campaign.
    
- Status.
    
- Source metadata.
    

Campaign يمكن أن ترتبط بـForm واحد أو أكثر بحسب طبيعة التكامل.

---

# 16. Source Field

يمثل سؤالاً أو Field قادماً من Source خارجي مثل Meta Form.

يمكن أن يحتوي على:

- External field/question identifier.
    
- Label / question text.
    
- Source.
    
- Form.
    
- Data type information عند توفرها.
    

Source Field لا يجب أن يصبح بالضرورة Field داخلياً بنفس الاسم أو نفس البنية.

---

# 17. Field Definition

يمثل تعريف Field يمكن استخدامه داخل المنصة.

هذه الكيان أساسي لأن المنتج يعتمد على **نظام حقول مرن**.

يمكن أن يحتوي Field Definition على خصائص مفاهيمية مثل:

- Name.
    
- Label.
    
- Key.
    
- Type.
    
- Description.
    
- Scope.
    
- Required capability.
    
- Options.
    
- Validation rules.
    
- Calculated status.
    
- Active status.
    

---

# 18. Field Scope

Field يمكن أن يكون مرتبطاً بأحد مستويات الاستخدام التالية:

### System-level

Field عام يمكن استخدامه على مستوى المنصة عندما يكون ذلك مناسباً.

### Branch-level

Field خاص بوحدة تشغيل معينة.

### Campaign-level

Field خاص بحملة محددة.

الهدف من هذا المفهوم هو منع فرض نفس مجموعة الحقول على جميع الحملات.

---

# 19. Field Types

Field Definition يجب أن يكون قادراً على تمثيل أنواع مختلفة من البيانات.

أمثلة:

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
    

هذه قائمة وظيفية قابلة للتوسع وليست بالضرورة قائمة تنفيذ نهائية.

---

# 20. Field Options

بعض أنواع الحقول تحتاج مجموعة قيم.

مثلاً:

Status:

- New.
    
- Contacted.
    
- Interested.
    

أو:

Interest:

- Low.
    
- Medium.
    
- High.
    
- Very High.
    

أو أي مجموعة قيم أخرى يحددها Manager أو Super Admin.

Field Options يجب أن ترتبط بالـField Definition وليس بـLead نفسها.

---

# 21. Campaign Field Configuration

يمثل استخدام Field معين داخل Campaign محددة.

هذا مهم لأن نفس Field يمكن أن يستخدم في أكثر من Campaign بإعدادات مختلفة.

Campaign Field Configuration يمكن أن يحدد:

- Visible.
    
- Editable.
    
- Required.
    
- Display order.
    
- Show in Lead table.
    
- Show in Lead Details.
    
- Available in filters.
    
- Available to Agent.
    
- Available to Manager.
    
- Available to Super Admin حسب الصلاحيات.
    

---

# 22. Field Visibility

وجود Field في النظام لا يعني أنه يظهر لكل مستخدم.

إظهار Field يعتمد على:

- Role.
    
- Branch.
    
- Campaign.
    
- Field configuration.
    
- Permissions.
    

يجب أن يدعم النموذج التحكم في **ما الذي يظهر لكل نوع من المستخدمين**.

---

# 23. Field Editability

Field يمكن أن يكون:

- Editable.
    
- Read-only.
    
- System-managed.
    
- Source-managed.
    
- Calculated.
    

مثلاً:

Lead Name القادم من مصدر خارجي قد يكون Read-only.

بينما:

First Contact Date يمكن أن يكون قابلاً للتعديل أو يتم تحديثه وفق قواعد النظام.

Response Time يمكن أن يكون Calculated.

---

# 24. Lead Field Value

يمثل القيمة الفعلية لـField معين داخل Lead.

مثلاً:

Field:

> Learning Language

Lead Value:

> French

أو:

Field:

> First Contact Date

Lead Value:

> 2026-09-26 14:30

Lead Field Value يجب أن يكون قادراً على تمثيل مصادر مختلفة للقيمة:

- Source-provided.
    
- Manual.
    
- Imported.
    
- Calculated.
    
- Automation-generated.
    

---

# 25. Field Value History

عند الحاجة للحفاظ على التاريخ، يجب أن يكون بالإمكان معرفة تغييرات القيم المهمة.

مثلاً:

Interest:

Low  
→ Medium  
→ High

أو:

Contact Status:

New  
→ Contacted  
→ Follow-up

الهدف هو عدم فقدان التاريخ التشغيلي بسبب استبدال القيمة الحالية.

---

# 26. Calculated Field Definition

يمثل Field يتم احتساب قيمته تلقائياً.

أمثلة:

### Response Time

First Contact Time  
−  
Lead Created Time

### Time Since Last Contact

Current Time  
−  
Last Contact Time

### Contact Attempts

عدد أحداث التواصل المسجلة.

### Other Derived Values

أي قيمة يمكن اشتقاقها من:

- Fields.
    
- Activities.
    
- Timestamps.
    
- أحداث أخرى.
    

الصيغة والتنفيذ الفعلي يتم تحديدهما لاحقاً.

---

# 27. Assignment

يمثل التعيين الحالي لـLead.

يتضمن مفاهيم مثل:

- Current Branch.
    
- Current Agent.
    
- Assignment time.
    
- Assignment source.
    

Lead قد تكون:

- Assigned.
    
- Unassigned.
    

حسب حالة الـRouting.

---

# 28. Assignment History

يمثل تاريخ جميع عمليات تعيين وإعادة تعيين Lead.

يجب أن يسمح بمعرفة:

- Lead.
    
- Previous Branch.
    
- Previous Agent.
    
- New Branch.
    
- New Agent.
    
- Time.
    
- Actor.
    
- Reason أو مصدر التغيير عندما يكون متاحاً.
    

هذا يمنع فقدان التاريخ عند نقل Lead بين Agents أو Branches.

---

# 29. Follow-up

يمثل مهمة أو متابعة مرتبطة بـLead.

يمكن أن يحتوي على:

- Lead.
    
- Due date/time.
    
- Type.
    
- Priority.
    
- Notes.
    
- Status.
    
- Created by.
    
- Completed by.
    
- Completion time.
    

الحالات التشغيلية قد تشمل:

- Upcoming.
    
- Due.
    
- Overdue.
    
- Completed.
    
- Cancelled.
    

---

# 30. Activity

يمثل حدثاً مهماً في تاريخ Lead.

أمثلة:

- Lead received.
    
- Contact matched.
    
- Lead assigned.
    
- Lead reassigned.
    
- Field changed.
    
- Note added.
    
- Follow-up created.
    
- Follow-up completed.
    
- Payment Link created.
    
- Payment confirmed.
    
- Enrollment confirmed.
    
- Notification sent.
    

Activity هو سجل للأحداث، وليس بديلاً عن Current State.

---

# 31. Note

يمثل ملاحظة تشغيلية مرتبطة بـLead.

يمكن أن يحتوي على:

- Text.
    
- Author.
    
- Created time.
    
- Updated time عند الحاجة.
    

Notes يجب أن تكون مرتبطة بـLead وليس بـContact فقط، لأن الملاحظة قد تخص فرصة معينة.

---

# 32. Payment Method

يمثل طريقة دفع متاحة داخل Branch.

يمكن أن تحتوي مفاهيمياً على:

- Branch.
    
- Provider type.
    
- Display name.
    
- Active status.
    
- Configuration reference.
    
- Availability rules عند الحاجة.
    

Credentials الحساسة يجب ألا تعامل كبيانات تشغيلية عادية ولا تعرض للAgent.

---

# 33. Payment Link

يمثل رابط دفع تم إنشاؤه لـLead.

يمكن أن يرتبط بـ:

- Lead.
    
- Payment Method.
    
- Amount.
    
- Currency.
    
- Created date.
    
- Status.
    
- Provider reference.
    

---

# 34. Payment

يمثل عملية دفع مرتبطة بـLead.

يمكن أن يحتوي على:

- Lead.
    
- Payment Method.
    
- Payment Link.
    
- Amount.
    
- Currency.
    
- Status.
    
- Provider reference.
    
- Payment date/time.
    
- Confirmation information.
    

## Scope

النظام لا يحتاج ضمن هذا الـDomain إلى:

- Installment entities.
    
- Payment plan entities.
    
- Refund workflow entities.
    
- Accounting ledger.
    

---

# 35. Enrollment

يمثل حالة اشتراك الشخص الناتجة عن Payment confirmation.

يرتبط بـLead.

يمكن أن يحتوي على:

- Status.
    
- Enrollment date/time.
    
- Payment reference.
    
- Relevant metadata.
    

العملية الأساسية:

Payment Confirmed  
→ Enrollment / Subscription

---

# 36. Notification

يمثل إشعاراً مرتبطاً بمستخدم و/أو Lead و/أو حدث.

القنوات:

- In-App.
    
- Email.
    
- WhatsApp.
    

يمكن أن يحتوي على:

- Recipient.
    
- Lead.
    
- Event.
    
- Channel.
    
- Status.
    
- Created time.
    
- Sent time.
    
- Delivery information عند توفرها.
    

---

# 37. Notification Preference

يمثل تفضيلات المستخدم للإشعارات.

يمكن أن يحدد:

- Event type.
    
- Channel.
    
- Enabled / Disabled.
    

بعض الإشعارات يمكن أن تكون إلزامية ولا يمكن للمستخدم تعطيلها.

---

# 38. WhatsApp Recipient Profile

لا يحتاج النظام إلى كيان معقد خاص بـWhatsApp لكل Agent.

المعلومة الأساسية المطلوبة من Agent هي:

- Phone Number.
    

وأي تفاصيل خاصة بمزود WhatsApp يجب أن تكون جزءاً من Integration configuration وليس Agent profile كبيانات تشغيلية يعبئها Agent.

---

# 39. Tag

يمثل تصنيفاً اختيارياً يمكن ربطه بـLead.

Tag ليست مطلوبة لكل Campaign.

يمكن استخدامها في:

- Filtering.
    
- Saved Views.
    
- Automation.
    
- Analytics.
    
- Organization.
    

---

# 40. Saved View

يمثل View محفوظاً للمستخدم.

يمكن أن يتضمن:

- Name.
    
- Filters.
    
- Sorting.
    
- Visible columns.
    
- Owner.
    
- Scope.
    

يجب أن يكون Saved View مرتبطاً بصلاحيات المستخدم ونطاق البيانات المتاح له.

---

# 41. Automation

يمثل قاعدة تنفيذ تلقائي.

المفهوم:

**Trigger → Conditions → Actions**

Automation يمكن أن تكون:

- System-level.
    
- Branch-level.
    
- Campaign-level.
    

حسب الصلاحيات والإعدادات.

---

# 42. Automation Trigger

حدث يؤدي إلى تشغيل Automation.

أمثلة:

- Lead created.
    
- Lead assigned.
    
- Field changed.
    
- Status changed.
    
- Follow-up due.
    
- Follow-up overdue.
    
- Payment confirmed.
    
- Enrollment confirmed.
    

---

# 43. Automation Condition

شرط يحدد ما إذا كان Action يجب أن ينفذ.

قد يعتمد على:

- Campaign.
    
- Branch.
    
- Agent.
    
- Field values.
    
- Status.
    
- Payment state.
    
- Enrollment state.
    
- Dates.
    
- Events.
    

---

# 44. Automation Action

Action يتم تنفيذه تلقائياً.

أمثلة:

- Change Field.
    
- Create Follow-up.
    
- Send Notification.
    
- Assign Lead.
    
- Add Tag.
    
- Change Status.
    

لا يمكن Action تجاوز Permissions أو Business Rules.

---

# 45. Automation Execution

يجب أن يمكن تتبع تنفيذ Automations.

يمكن الاحتفاظ بمعلومات مثل:

- Automation.
    
- Trigger.
    
- Lead.
    
- Execution time.
    
- Result.
    
- Success / Failure.
    
- Relevant error information.
    

الهدف هو منع التكرار غير المقصود وإتاحة التتبع.

---

# 46. Integration Connection

يمثل تكاملاً بين المنصة وخدمة خارجية.

أمثلة:

- Meta.
    
- WhatsApp Provider.
    
- Payment Provider.
    
- Google Sheets.
    
- Email Provider.
    
- AI Provider.
    

Integration Connection قد يحتوي conceptually على:

- Provider.
    
- Status.
    
- Configuration.
    
- Credentials reference.
    
- Last synchronization/status information.
    

التفاصيل السرية لا تعامل كبيانات عادية.

---

# 47. Integration Event

يمثل حدثاً متعلقاً بتكامل خارجي.

يمكن أن يكون:

- Incoming event.
    
- Outgoing request.
    
- Synchronization.
    
- Notification delivery.
    
- Payment event.
    

يستخدم لتتبع العمليات والتعامل مع الأخطاء وإعادة المحاولة.

---

# 48. External Reference

يمثل معرفاً لمورد داخلي في نظام خارجي.

يمكن استخدامه لـ:

- Lead.
    
- Campaign.
    
- Form.
    
- Page.
    
- Payment.
    
- Other provider objects.
    

الغرض هو الربط بين الكيان الداخلي والكيان الخارجي دون جعل النظام الداخلي يعتمد على بنية المزود الخارجي.

---

# 49. Audit Log

يمثل عملية إدارية أو أمنية قابلة للتتبع.

يمكن أن يحتوي على:

- Actor.
    
- Role.
    
- Action.
    
- Target type.
    
- Target.
    
- Time.
    
- Relevant old value.
    
- Relevant new value.
    
- Context.
    

أمثلة:

- User created.
    
- User disabled.
    
- Field changed.
    
- Campaign modified.
    
- Routing changed.
    
- Payment Method changed.
    
- Integration changed.
    

---

# 50. Dashboard / Analytics Data

Dashboard وAnalytics ليست بالضرورة كيانات Business مستقلة.

هي تمثل بيانات مشتقة من:

- Leads.
    
- Activities.
    
- Payments.
    
- Enrollments.
    
- Campaigns.
    
- Agents.
    
- Branches.
    
- Fields.
    

الهدف هو عدم جعل Analytics مصدراً مستقلاً يناقض البيانات الأساسية.

---

# 51. Contact vs Lead Rules

يجب أن يظل الفصل بين Contact وLead واضحاً.

### Contact

الشخص.

### Lead

الفرصة أو الطلب.

يمكن:

- Contact واحد → Leads متعددة.
    
- Lead واحد → Contact واحد.
    
- Contact موجود مسبقاً → Lead جديدة ممكنة.
    
- Lead قد تنتقل بين Agents دون تغيير Contact.
    

---

# 52. Campaign vs Lead Rules

Campaign تحدد:

**كيف يتم تشغيل Lead وإدارته.**

Lead تمثل:

**فرصة فعلية مرتبطة بهذه Campaign.**

Campaign يمكن أن تحتوي Leads كثيرة.

تغيير إعدادات Campaign لا يعني تعديل التاريخ السابق للـLeads تلقائياً إلا عندما يتم تحديد ذلك صراحة كقاعدة عمل.

---

# 53. Source Data vs Operational Data

يجب التمييز بين:

### Source Data

ما جاء من Meta أو مصدر خارجي.

### Operational Data

ما أضافه أو غيره النظام والمستخدمون أثناء إدارة Lead.

تعديل Operational Data لا يجب أن يمحو Source Data الأصلية.

---

# 54. Current State vs History

يجب أن يكون هناك فرق بين:

### Current State

القيمة الحالية.

### History

كيف وصلت القيمة إلى حالتها الحالية.

مثلاً:

Current Agent = Sarah

لكن Assignment History يحفظ:

Ahmed → Sarah

Current Status = Interested

لكن Activity/Field History يمكن أن يحفظ:

New → Contacted → Interested

---

# 55. Branch Ownership

كل Lead تشغيلية يجب أن يكون لها Branch واضح أثناء دورة العمل.

عند نقل Lead بين Branches:

- تتغير Current Branch.
    
- يجب الاحتفاظ بالتاريخ السابق.
    
- الصلاحيات الحالية تعتمد على Branch الحالي.
    
- لا يجب فقدان Activity السابقة.
    

---

# 56. Agent Ownership

Lead يمكن أن تكون:

- Unassigned.
    
- Assigned to Agent.
    

عند تغيير Agent:

- تتغير Current Assignment.
    
- يحفظ Assignment History.
    
- لا يتغير Contact بسبب ذلك.
    

---

# 57. Payment & Enrollment Relationship

Payment وEnrollment مرتبطان لكنهما ليسا نفس الكيان.

Payment:

> هل تم الدفع؟

Enrollment:

> هل تم تسجيل الشخص/اعتباره مشتركاً؟

في التدفق الأساسي:

**Confirmed Payment → Enrollment**

لكن يجب الحفاظ على الكيانين منفصلين حتى يبقى النموذج واضحاً وقابلاً للتوسع.

---

# 58. Notification & Event Relationship

Notification هي نتيجة حدث أو Rule، وليست بديلاً عن Activity.

مثلاً:

Payment Confirmed

قد ينتج:

- Activity.
    
- Notification.
    
- Enrollment.
    
- Analytics update.
    

كل واحد منها له دوره المختلف.

---

# 59. Domain Constraints

النموذج يجب أن يضمن مفاهيمياً:

- Agent تابع لـBranch.
    
- Manager مسؤول عن Branch.
    
- Lead مرتبطة بContact.
    
- Lead مرتبطة بـCampaign عندما تكون قادمة من Campaign.
    
- Campaign مرتبطة بـBranch.
    
- Field Configuration مرتبطة بـCampaign.
    
- Lead Field Values مرتبطة بـLead وField.
    
- Payment Method مرتبطة بـBranch.
    
- Payment مرتبطة بـLead.
    
- Enrollment مرتبطة بـLead.
    
- Assignment History مرتبطة بـLead.
    
- Activities مرتبطة بـLead.
    
- Follow-ups مرتبطة بـLead.
    

---

# 60. Historical Integrity

يجب ألا تؤدي التغييرات الحالية إلى فقدان المعلومات التاريخية المهمة.

خصوصاً:

- Lead Assignment.
    
- Field changes المهمة.
    
- Status changes.
    
- Payment events.
    
- Enrollment events.
    
- Activity Timeline.
    
- Integration events.
    

---

# 61. Extensibility

Domain Model يجب أن يسمح مستقبلاً بإضافة:

- Lead Sources.
    
- Notification Providers.
    
- Payment Providers.
    
- Custom Field types.
    
- Additional Automation triggers/actions.
    
- Additional Analytics dimensions.
    

بدون تغيير المفاهيم الأساسية للمنتج.

---

# 62. Domain Model Summary

العلاقات الأساسية هي:

**Organization**  
→ Branches

**Branch**  
→ Manager  
→ Agents  
→ Campaigns  
→ Leads  
→ Payment Methods  
→ Automations

**Contact**  
→ Leads

**Campaign**  
→ Forms  
→ External References  
→ Field Configurations  
→ Agents  
→ Leads  
→ Automations

**Lead**  
→ Contact  
→ Campaign  
→ Branch  
→ Agent  
→ Field Values  
→ Follow-ups  
→ Activities  
→ Payments  
→ Enrollment  
→ Notifications

**Field Definition**  
→ Campaign Field Configuration  
→ Lead Field Values

**Payment Method**  
→ Payments / Payment Links

**Integration**  
→ External References / Events

---

# 63. Final Domain Principles

هذا النموذج يجب أن يحافظ على:

1. Contact مختلف عن Lead.
    
2. Campaign مختلفة عن Lead.
    
3. Source Data مختلفة عن Operational Data.
    
4. Current State مختلف عن History.
    
5. Payment مختلف عن Enrollment.
    
6. Field Definition مختلف عن Field Value.
    
7. Branch Isolation.
    
8. Flexible Campaign-specific Fields.
    
9. Historical integrity.
    
10. Provider-agnostic integrations.
    

يجب أن يبني التصميم التقني اللاحق على هذه المفاهيم دون تغيير معناها الوظيفي.