# إعداد Approved Tools للمحادثة

## المتطلبات والقرار

المصادر: `04` §§6–8/19/28–30، `05` §§13–17، `02` §§44/48/50، وAGENTS §§8/19–22/26–29. كل Approved Tool تمر عبر Application Service وcurrent authorization وBusiness Rules. لا يستطيع Branch أوCampaign أومحتوى العميل والنموذج تعطيل Global Guardrails.

`ai_tool_policy` إعداد تقني مستقل له versions للـBranch والـCampaign، ويحافظ على عقد Operational Config الحالية وتاريخها. Catalog Version1 محدودة بالأدوات الموثقة: `getLeadContext` و`getCampaignKnowledge` و`updateQualificationField` و`requestHumanHandoff` و`sendConversationMessage` و`createFollowUp`. هذه أسماء تقنية للحدود الوظيفية المطلوبة، ولا تضيف Roles أوBusiness permissions. لا يمكن إدخال SQL أوأداة لتأكيد Payment أوEnrollment أوتغيير صلاحيات النظام. إضافة أداة مستقبلية تتطلب Application Service واختبارات لها؛ لا تُضاف كنص حر من Prompt أوUI.

## الوراثة والصلاحيات

Definition هي `{allowedTools: null | knownToolNames[]}` فقط. `null` فيCampaign تورّثBranch؛ وفيBranch تعني غير مُعدّة. عند غياب الإعداد تكون القائمة الفعلية **[]**. Campaign array تستبدل القائمة كاملة، ولا تستخدم union. `[]` تمنع كل الأدوات صراحةً، ويبقى المنع عند تغييرBranch.

Campaign لا تتجاوز Fixed Catalog أوGlobal Guardrails أوcurrent Field/scope/Central Messaging Policy. Mandatory Handoff وUnknown Answer Safety تبقيان ملزمتين. غياب الأداة لا يجيز الاستمرار في جواب حساس؛ يجب رفض Activation/Execution أوإنشاء Attention وفق Runtime التي ستُنفذ لاحقًا.

Super Admin يدير الإعداد داخلOrganization وManager داخل فرعه. Agent لا يملك Setup أوHistory. API وnative DB تثبتان current exact user/session/activeBranch/parent identity، مع CAS version وreason وimmutable versions وatomic Audit. Snapshot تحتوي القائمة ونسختها فقط؛ لا Credentials أوConversation/Knowledge body. Historical reason تُعرض كـplain React text. اختيار الأدوات لا يمنح موافقة على نقل بيانات عملاء حقيقية إلىProvider.

## التزامن والسياق الحالي

Service تختار Branch `FOR UPDATE` قبل SHARE أوchild row lock، ثم تفحص Current Campaign/session/policy. Native guard تطلب نفس parent fence لمنع إضافة Policy غائبة أثناء Current Worker Scope Proof. API eight-way CAS تسمح بكتابة واحدة. Trusted DB writer يلتزم Parent-first Lock Order؛ direct SQL تخضع لنفس native checks، وقد تُجهض PostgreSQL transaction متعارضة. Transactions قصيرة ولا تحتفظ بأقفال أثناء HTTP.

`ai_effective_tool_policy` مصدر native موحّد للنسخ والتعريف والوراثة والقائمة الحالية. Effective Preview/Hash تستخدمها. Customer Proposal Context تحفظ `toolPolicy` منفصلة عن `approvedTools=[]` في مرحلة الاقتراح الحالية. Native Current Guards للـCampaign Simulation وHuman Copilot تتحقق من نفس Policy/versions/list.

تغيير Branch/Campaign Policy يبطل Queued/Inflight Context حتى إذا بقيت القائمة الفعلية فارغة، مع حفظ النسخة التاريخية. الدوال تُحدّث بـ`CREATE OR REPLACE` للمحافظة على OIDs المستخدمة في cached plans. لا تُكتب Migration مطبّقة من جديد.

## UI والتشغيل

Campaign Details تعرض Branch Defaults وCampaign Overrides، مع explicit empty denial وknown checklist وreason/CAS وreload وcurrent source وversion history/keyset pagination. Loading يمنع الحفظ قبل تحميل النسخة. Stale Save أوفشل الصلاحية يمسح بيانات المحرر وHistory ويحتاج Reload. الواجهة تدعم ar/en/fr وRTL وplain text rendering، ولا تعرض Secrets أوSQL Editor.

الحفظ **لا يفعّل AI أوTool Executor**. Catalog تعرض `customerRuntimeImplemented=false` وAPI تعرض `runtimeAuthorized=false` و`liveTransferEnabled=false` في هذه المرحلة. Customer Worker تنتج PROPOSED دون mutation/send حتى لو كانت القائمة configured. Field source=HUMAN/native100 ثابتة. الخطوة التالية Separate Current Action Receipt/Proof/Executor وactual Qualification/Handoff، ثم Central Messaging Policy/customer sends وFollow-up/Evaluations/Readiness.

Live Transfer معطّلة وفق إذن المستخدم. التطوير يستخدم بيانات اصطناعية وHTTP Mocks فقط؛ لا ادعاء Live Verification.

## بوابة الإثبات

نجحت بوابة آخر الكود: migrations001–116 development/test،Backend/Web build/typecheck،**171 unit و74 full Docker PostgreSQL integration و43 full Edge Browser E2E**،وfocused PG4/4 وBrowser1/1 وdiff check. Eight-way CAS وcurrent session/scope/Branch وAgent/foreign denial وnative forgery/history immutability/Audit rollback وstrict type validation وCustomer/Copilot/Simulation pre/post-HTTP context invalidation مثبتة. Browser loading/stale-save/reload/permission-failure clear/history/French/RTL390px ناجحة،والصورة فُحصت.

Configuration **Implemented وPostgreSQL/Local Browser Verified**؛HTTP inference regression تستخدم synthetic mocks فقط. **Live Verification Pending External Credential/Approval** والنقل الحي معطّل. هذا إعداد أدوات منفذ،ولا يعني اكتمال AI أوالمنصة. Actual execution تحتاج Current Action Proof مستقلة؛استثناء `AI_HANDOFF_REQUIRED + AI_PROCESSING_NOT_READY` التشخيصي فيProposal ليس إذنًا Tool/send.
