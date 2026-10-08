# Effective AI Configuration prerequisite

## التحقق — 2026-10-09

001–099 development/test migrations و159unit/65full Docker PostgreSQL integration/33full Edge Browser E2E (1.2m)،focused Browser1/1 وfocused PG1/1 بعد current Field type-change negative،Backend/Webbuild/typecheck ناجحة. UI Arabic390px وFrench/XSS/long text/secret omission/inheritance/history/disable-clear/Agent denial مثبتة؛ الصورة فُحصت. Native current session/scope/version/task/grant/target/history/Audit rollback/concurrency وdeterministic Published-only isolated trace/current typed Field validity مثبتة. لا inference أوLive Provider Verified؛ **Live Verification Pending External Credential/Approval**. البقية أدناه مطلوبة قبل customer-facing activation.

## حدود المرحلة

إعداد versioned Branch defaults وCampaign overrides من الواجهة، ومعاينة deterministic configuration دون inference أوLead/Conversation mutation. Global guardrails ثابتة في التطبيق، وليست configurable prompt؛ unknown keys وguardrail overrides مرفوضة في API/native schema. هذه الخطوة شرط سابق للـapproved tools/runtime/assistants وليست تفعيلًا لها.

## الإعدادات والوراثة

كل scope تحفظ أربعة task Profile references اختيارية: CONVERSATION/SUMMARIZATION/CLASSIFICATION/ANALYSIS، وlanguage supported/preferred/detect وtone وdefault human escalation target وhandoff SLA بالدقائق. null في Campaign تعني وراثة، وفي Branch تعني غير محدد؛ لا model/provider أوtarget عشوائي. Tone فارغة override صريحة لمسح guidance، وdetect=false لا تُتجاهل. Supported language tags محدودة تقنيًا بعشرة BCP47-style identifiers/35 chars؛ tone2000 chars وSLA positive PostgreSQL integer. هذه حدود payload تقنية وليست claims عن capacity أوSLA تجارية.

timezone وsending hours وproactive frequency/maxAttempts تؤخذ من Branch/Campaign Central Messaging configuration الحالية؛ لا سياسة موازية يمكنها تجاوزها. Branch defaults ليست Knowledge. Handoff target مستخدم Manager/Agent نشط من الفرع؛ Agent eligibility للحملة تظهر كreadiness blocker إذا مفقودة. لا تغير Lead Owner أوConversation Controller؛ runtime المستقبلية تعيد فحص الأهلية والسعة وhandoff path قبل التنفيذ، مع WAITING_FOR_HUMAN عند غياب مؤهل حسب المواصفات.

## الأمن والتتبع

Manager ضمن فرعه وSuper Admin ضمن Organization، current session/role/Branch checks قبل القراءة والحفظ؛ Agent403 وforeign resource404. Profiles تتطلب current task/active catalog/Connection ونفس Organization/Branch، أوexplicit Organization shared-use grant. لا fallback عند revoke أوdisable؛ المعاينة تعرض unavailable configured ID دون model/connection metadata مخفية. الحفظ يرفض reference غير متاحة؛ يمكن مسحها إلى null. Catalog verification لا تثبت inference.

Migration099: strict native definition/current authorization/reference validation، identity/version guards وimmutable configuration history وatomic Audit. Optimistic version وresource advisory lock يمنعان سباق أول insert؛ current Branch/profile/Connection/grant/user references تؤخذ بقفل transaction مناسب. History بصفحات metadata؛ النسخة الأصلية تُقرأ منفصلة دون secret أوsession token.

`ai_operational_config` هي source التشغيلية versioned لهذا العقد؛ legacy `branch.ai_defaults` العامة غير المستخدمة لا تدخل effective config، ولا يعاد تفسير JSON قديمة كصلاحيات أوإرشادات. Campaign `ai_config.enabled` القائمة تبقى طلب enablement منفصلًا، مع activation/readiness guard الحالية إلى اكتمال الاعتماديات.

Campaign effective preview تُحمّل latest Published Knowledge فقط وimmutable approved asset manifests الخاصة بالحملة، current Qualification definition والـField definition/binding versions عند تفعيلها، مع إعادة فحص types/options/validation للـcriteria. لا Draft أوKnowledge من حملة أخرى حتى عند مشاركة Profile. Canonical SHA256 يعكس Global version، configuration versions وcontent/current dependencies/availability وMessaging resolution؛ نفس الحالة تنتج نفس hash. هذه معاينة إعداد Campaign؛ execution trace اللاحقة يجب أن تضيف Lead/Conversation وPinned Sender والـactor/tool/result، وتحفظ snapshot مستخدمة تاريخيًا وتعيد فحص current policy قبل أي action/send.

## الجاهزية والأعمال اللاحقة

assistantReady=false دائمًا في هذه المرحلة مع blockers صريحة لـruntime/approved tools/follow-up policy/simulation غير المنفذة، بالإضافة إلى missing/current-invalid dependencies. Allowed tools فارغة فعلًا؛ ليست أسماء capabilities غير منفذة. Campaign AI Enabled الحالية لا تتجاوز readiness activation guard. Disclosure/formality وfollow-up/closed-returning behavior والتفاصيل التشغيلية المتبقية ستُضاف مع policy/tools/runtime gates قبل customer-facing activation. لا inference أوLive AI verification؛ **Live Verification Pending External Credential/Approval**.
