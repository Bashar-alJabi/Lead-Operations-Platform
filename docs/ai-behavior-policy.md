# سياسات سلوك AI للحملة

## النطاق والحالة

المرجع: 02 §§36–37/49،03 §§44/47/59،04 §§28–38/70–73،05 §§13–15/20–21،06 §12 وAGENTS §§8/19–22/26–29.

هذه المرحلة تضيف إعدادًا تشغيليًا versioned وقرارًا حتميًا قابلًا للمعاينة. لا تنفذ inference أوhandoff/send/job أوتفتح Lead/Conversation أوتنشئ Lead فعلية. الحالة: Implemented وPostgreSQL/Local Browser Verified للإعداد وdecision prerequisite فقط،بـ164unit/68integration/36Browser و001–102 وBackend/Web build/typecheck. بدأ العمل من`b206107`؛لاactual inference/tools/actions/activation منالإعداد.

## الإعداد والوراثة

`ai_behavior_policy` منفصلة عن Knowledge والـProfiles، لأن إعداد التشغيل ليس حقيقة تجارية منشورة. تعريفها strict بأربعة أقسام:

- `formality`: نص إرشادات رسمية حتى1000 حرف؛`null` وراثة،و`""` تجاوز صريح فارغ.
- `disclosure`: `FIRST_AI_MESSAGE` أو`EVERY_AI_MESSAGE` ونص معتمد حتى2000 حرف. لاHIDE_AI أوtext فارغة. إعداد النص يحتاج مراجعة المسؤول وفق سياسة المؤسسة القانونية والتشغيلية؛ المنصة لا تدعي اعتمادًا قانونيًا آليًا.
- `handoff`: السماح بالتواصل الأولي دونAgent،نص انتقالي معتمد اختياري،وعدد سوء الفهم الاختياري قبل التحويل. لاعددBusiness مفترض. عند غياب limit،trigger مثبت لسوء الفهم المتكرر يبقى سببًا للتحويل. النص الانتقالي إعداد؛ليس Message مرسلة.
- `returningContact`: قاعدة خاصة بالحملة،تختار للمحادثة المغلقة معLead مفتوحة `REVIEW` أو`REOPEN_EXISTING`،ولـLead المغلقة `REVIEW` أو`REOPEN_EXISTING` أو`CREATE_NEW`.

Formality/disclosure/handoff يمكنها وراثة Branch defaults؛Campaign override غيرnull تتجاوز القسم كاملًا،ولاdeep merge غامضة. Returning-contact لا تُورث منBranch،وتُرفض native/API علىBranch scope. Tone/brand guidance الموجودة في operational configuration تُستعمل كما هي بلاdefinition مكررة. Effective preview تعرضcurrent versions/source/mandatory triggers ضمنcanonical hash؛لاDraft Knowledge أوبيانات حملة أخرى.

كل section غيرمُعد تبقى `UNCONFIGURED` ظاهرة. غياب disclosure/handoff/returning policy يضيف readiness blocker؛runtime/tools/simulation blockers باقية،و`assistantReady=false` و`allowedTools=[]`.

## حدود التحويل والمطابقة

طلب موظف،نقص جواب مؤكد،سؤال خارج النطاق،شكوى،حالة حساسة،استثناء سعر،استثناء قانوني،مشكلة دفع،low-confidence guardrail وmanual takeover هي triggers لايمكن للـpolicy تعطيلها. Qualification milestone يعتمد علىcriteria الفعلية منQualification config الحالية؛لاشرط مكرر يغيّر حقيقتها. Campaign condition تحتاج rule/action مثبتة منالتطبيق،ولا يفسرModel نصًا حرًا كإذن تنفيذ.

عندhandoff بلاHuman مؤهل،decision تكون`WAITING_FOR_HUMAN` معManager attention؛لاrandom assignment ولاAI continuation لموضوع يحتاجHuman. إعداد initial contact withoutAgent يحتاج عندالتنفيذCampaign eligibility ومسارManager/attention موثوقًا؛القيمةtrue وحدها لا تبدأ التفاعل. Target/SLA يأتيان منoperational configuration الحالية،ويجب تطبيقtimezone/working-hours فيruntime/SLA worker الفعلية.

Returning decision تتوقف علىcurrent trusted resolution/lifecycle/controller/state:

- Ambiguous/unresolved أوARCHIVED → `REVIEW`.
- Lead CLOSED → القاعدة الصريحة؛عدمإعدادها → `REVIEW`.
- `CREATE_NEW` تحتاجunique resolution وexplicit current Campaign reference وcurrent required Lead data. غياب أحدها → `REVIEW`.
- Conversation CLOSED معLead OPEN → القاعدة الصريحة؛لاAI restart منreopen وحدها.
- WAITING_FOR_HUMAN/AI_HANDOFF_REQUIRED → Human review،بلاauto-return إلىAI.
- Current Human Controller → التوجيه إلىHuman.
- AI_ACTIVE/AI_WAITING_FOR_LEAD معAI Controller → eligibility فقط؛runtime authorization وCentral Messaging Policy إلزاميتان قبلالإرسال.

`CREATE_NEW` نفسها هي اختيارrule صريحة مسجلة بسبب وActor/Session/version/history. تحقق unique Contact/Lead وCampaign source-reference وrequired current Fields يجب أن تنفذه خدمةinbound/application منأدلة المنصة،لا منclaim العميل أوModel. فيهذهالمرحلة هذهinputs hypothetical فقط ولايسمح استخدامها لتنفيذmutation. Form submission جديدة تبقىLead جديدة وفققواعدSource الحالية؛لا يعاد استعمالreturning policy بدلها.

## Backend وDB وUI

- `GET/PUT /api/ai/branches/:id/behavior-defaults`.
- `GET/PUT /api/ai/campaigns/:id/behavior-policy`.
- `GET .../history?before=&limit=` و`GET .../versions/:version` لكلscope.
- `POST /api/ai/campaigns/:id/behavior-policy/preview`: نسختاBranch/Campaign وstrict hypothetical context؛saved current effective policy فقط. تعارض النسخة409.

Manager ضمنفرعه وSuper Admin ضمنOrganization؛Agent403 وforeignscope404. Branch/current Session/role/active account تُفحص فيBackend؛native102 تضيفcurrent locks/session/version/identity/shape guards وimmutable snapshots/history وAudit ذريًا. Disabled Branch تمنعالحفظ وتبقيhistorical review. Advisory lock وoptimisticversion ينظمانfirst insert/edits؛لاforce overwrite أوDelete للتاريخ.

UI ar/en/fr تتيحالأقسام/وراثةclear/reason/history/pagination/reload وhypothetical saved-policy preview. التحرير مقفل أثناءinitial load/save،والـloads/previews المتأخرة تحجب بعدreload/scope change. المحتوى render كنصغيرموثوق؛لاHTML execution. Preview دائمًا`mutationsAllowed=false` و`sendAllowed=false`،وإرسالtransition/disclosure يجب أن يمر بالسياسة المركزية عنداكتمالapproved runtime/actions.

## التحقق والاستكمال

Focused Docker PostgreSQL1/1 وpolicy unit2/2 وfocused Browser1/1 ناجحة؛full164unit/68Docker PostgreSQL integration/36Edge Browser (3.9m) وdevelopment/test001–102 وBackend/Web build/typecheck ناجحة. Branch/Campaign Arabic RTL390px screenshots فُحصت؛Vite707.15KB/gzip201.81KB warning ضمنbacklog. Native/role/current session/expiry/revoke/Branch/version/history/Audit rollback/concurrency/isolation وwrite-free preview تختبر،إضافة إلىactual Browser setup/inheritance/closed/new-context review/handoff/history/stale/Agent denial/XSS/French/RTL.

التالي: approved AI/Form Qualification/tools/source provenance،trusted Lead/Conversation/controller/pinned Sender execution snapshots،durable runtime/provider inference،actual handoff/returning transitions وfollow-up jobs/SLA/notifications،Copilot/customer+Operations assistants/evaluations/activation. هذه واجبات باقية،وليست optional backlog أوPlaceholder مكتملة. AI Live Verification Pending External Credential/Approval؛لاlive inference منهذاالإعداد.
