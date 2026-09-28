# Lead Operations & Sales Management Platform

## 1. About the Project

منصة ويب مركزية لإدارة الـLeads والعمليات البيعية.

تدير المنصة دورة الـLead من لحظة وصوله من مصدر إعلاني أو مصدر آخر، مروراً بالحملة والفرع وتوزيع الـLead على Agent والمتابعة والتواصل، وصولاً إلى الدفع وتأكيد الاشتراك والتحليلات والأتمتة والـAI.

المنصة هي النظام المركزي لإدارة الـLeads والعمليات التشغيلية، بينما تتكامل مع الخدمات الخارجية المطلوبة.

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
Agent Assignment
    ↓
Notification
    ↓
Contact & Follow-up
    ↓
Payment
    ↓
Enrollment
    ↓
Analytics
    ↓
Automation / AI
```

---

## 3. Main Roles

### Super Admin

تحكم كامل بالنظام وجميع Branches والبيانات والإعدادات.

### Manager

إدارة Branch واحد والـAgents والـCampaigns والـLeads والإعدادات المرتبطة به.

### Agent

المستخدم التشغيلي الذي يتعامل مع الـLeads المخصصة له.

---

## 4. Main Product Areas

المنصة تشمل:

- Branch Management.
    
- User Management.
    
- Contact Management.
    
- Lead Management.
    
- Campaign Management.
    
- Flexible Campaign Fields.
    
- Meta Lead Integration.
    
- Lead Routing.
    
- Follow-ups.
    
- Activity Timeline.
    
- Notifications.
    
- WhatsApp Notifications.
    
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
    
- إنشاء Calculated Fields.
    

وبالتالي يمكن أن تكون كل حملة مختلفة عن الأخرى في طريقة إدارة بيانات Leads.

---

## 6. Lead Model

يفصل النظام بين:

**Contact**

الشخص نفسه.

و

**Lead**

طلب أو فرصة محددة مرتبطة بهذا الشخص.

يمكن للشخص الواحد امتلاك أكثر من Lead.

---

## 7. External Integrations

التكاملات الأساسية:

- Meta.
    
- WhatsApp Provider.
    
- Payment Providers.
    
- Email.
    
- Google Sheets.
    
- AI Services.
    

يمكن إضافة مصادر وتكاملات أخرى مستقبلاً.

المنصة هي Source of Truth للبيانات التشغيلية.

---

## 8. WhatsApp

WhatsApp يستخدم كقناة Notifications فقط.

Agent لا يحتاج إلى إعداد:

- API.
    
- Webhook.
    
- Business Account.
    
- Provider.
    
- Credentials.
    

Agent يدخل فقط:

**Name + Phone Number**

والمنصة تتولى إرسال Notifications من خلال مزود WhatsApp.

---

## 9. Payments

كل Branch يمكن أن يملك Payment Methods الخاصة به.

التدفق الأساسي:

```text
Payment Method
    ↓
Payment Link
    ↓
Payment Confirmation
    ↓
Enrollment
```

المشروع لا يتضمن:

- Installments.
    
- Payment Plans.
    
- Refund Management.
    
- Accounting System.
    

---

## 10. Languages

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

## 11. Documentation

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
```

### `00-comprehensive-functional-concept.md`

المرجع الوظيفي الرئيسي للمنتج.

يشرح:

- ما هي المنصة.
    
- الوظائف.
    
- Workflows.
    
- Roles.
    
- Campaigns.
    
- Leads.
    
- Fields.
    
- Payments.
    
- Notifications.
    
- Analytics.
    
- Automations.
    
- AI.
    
- حدود المنتج.
    

### `01-domain-model.md`

يشرح:

- Entities.
    
- Relationships.
    
- Data responsibilities.
    
- Historical data.
    
- Domain principles.
    

### `02-business-rules-permissions.md`

يشرح:

- Roles.
    
- Permissions.
    
- Branch isolation.
    
- Lead rules.
    
- Field rules.
    
- Routing.
    
- Payment rules.
    
- Enrollment.
    
- Automation.
    
- AI boundaries.
    
- Security-related business rules.
    

### `03-integrations-ui-requirements.md`

يشرح:

- External integrations.
    
- Data flows.
    
- Meta.
    
- WhatsApp.
    
- Payments.
    
- Google Sheets.
    
- AI.
    
- UI.
    
- UX.
    
- Screens.
    
- User workflows.
    

---

## 12. AI Development Instructions

يوجد في جذر المشروع:

```text
AGENTS.md
```

وهو يحتوي على قواعد العمل التي يجب على AI Coding Agent اتباعها أثناء تطوير المشروع.

ويجب على أي AI Coding Agent قراءة:

```text
AGENTS.md
```

ثم وثائق:

```text
docs/
```

قبل تنفيذ الأجزاء الرئيسية من النظام.

---

## 13. Technical Architecture

الـTechnology Stack والـTechnical Architecture ليست مفروضة مسبقاً داخل وثائق المنتج.

المطلوب من Software Architect / AI Coding Agent هو اختيار الحل التقني الأنسب بناءً على المتطلبات الكاملة.

يجب أن يحقق الاختيار:

- Security.
    
- Reliability.
    
- Data Integrity.
    
- Maintainability.
    
- Performance.
    
- Scalability.
    
- Reasonable Cost.
    
- Operational Simplicity.
    

---

## 14. Product Boundaries

المشروع ليس:

- LMS.
    
- Course Marketplace.
    
- WhatsApp CRM.
    
- Chat Platform.
    
- ERP.
    
- Accounting Software.
    
- Full Financial System.
    

ولا يعتمد على:

- Google Sheets كقاعدة بيانات رئيسية.
    
- AI كمصدر حقيقة.
    
- مجموعة ثابتة من Fields لكل Campaign.
    

---

## 15. Development Principle

المبدأ الأساسي للمشروع:

> **نحن نحدد ماذا يجب أن يفعل المنتج، بينما يتم اختيار طريقة التنفيذ التقنية بناءً على المتطلبات.**

لا يجوز تغيير Business Requirements فقط لتسهيل التنفيذ التقني.

---
