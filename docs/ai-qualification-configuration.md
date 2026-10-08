# Qualification configuration prerequisite

## التحقق — 2026-10-09

مigrations001–098 على development/test،157unit و64full Docker PostgreSQL integration و32full Edge Browser E2E (3.6m)،focused Qualification1/1 وBackend/Webbuild/typecheck ناجحة. Screenshot العربية390px فُحصت. تشمل native/current scope/session/version/concurrency/history/Audit rollback وtyped rules/Field revocation/exact disable-only/no Preview writes، وUI ordering/mapping/preview/history/Agent denial/XSS/French/RTL. هذه configuration prerequisite محلية فقط؛ actual Lead qualification results وapproved tools/runtime/evaluations لم تنفذ، ولا Live AI verification. **Live Verification Pending External Credential/Approval**.

## القرار

تعريف التأهيل مستقل لكل Campaign. Manager في Branch وSuper Admin ضمن Organization يديران ordered questions وrequired/optional وoptional Platform Field mapping وexplicit completion/handoff criteria من Campaign UI. Agent لا يدير التعريف. Configuration version/history immutable snapshot متاحان للمراجعة؛ runtime المستقبلية تربط كل result/action بالتعريف المستخدم. هذه ليست AI activation أوLead result workflow بعد.

Question UUID ثابتة في الواجهة؛ إعادة الترتيب تغير ترتيب القائمة فقط. تغيير أوحذف سؤال لا يغير history القديمة. السؤال غير المرتبط يجمع نصًا في مسار النتائج اللاحق؛ mapping تشير إلى Field ID، دون duplication لأوصاف الحقول أوسرية قيم Lead. Field يجب أن تكون same Organization/Branch/Campaign scope، active definition/binding، MANUAL وusable_by_ai، وvisible_to_manager عندما يقوم Manager بالإعداد. لا mapping إلى SOURCE/SYSTEM/CALCULATED fields، ولا grant جديدة من mapping.

## المعايير

Completion تُحدد صراحة: ALL_REQUIRED أوCONDITIONS. Enabled definition تتطلب سؤالًا واحدًا على الأقل، وسؤالًا required على الأقل لـALL_REQUIRED أوcondition واحدة على الأقل للنوع الثاني. Disabled definition لا تُكمل التأهيل. هذه defaults/configuration technique وليست تخمينًا لمعنى Qualified من Model.

Conditions bounded typed data: ANSWERED أوEQUALS على question UUID مع ALL/ANY؛ لا arbitrary JavaScript/SQL/regex/expression execution. EQUALS تتحقق عبر platform Field validation الحالية، بما فيها select options/currency/type/bounds؛ سؤال غير mapped يقبل نصًا bounded. false و0 إجابات فعلية، ليست missing بفحص truthiness. Empty condition list لا تطابق بذاتها. Required question تمنع completion ما دام جوابها ناقصًا، حتى مع custom conditions؛ الإدارة يمكنها جعل السؤال optional صراحة. Optional question لا يمنع completion إلا إذا ربطت الإدارة rule به.

Handoff تشمل onCompletion وadditional conditions مستقلة. لا تلغي required global human-request/unknown-answer/security handoff؛ يتم دمجها في effective configuration/runtime التالية. Preview تُعيد complete/missing required IDs/handoff وcurrent mapping version traces من answers اختبارية normalized؛ لا Lead/Field/Message/Conversation writes ولا استدعاء Provider أوAI. Existing invalid/revoked mapping تمنع preview/edit/reenable مع safe failure؛ exact disable-only يحفظ نفس التعريف مع enabled=false دون الحاجة إلى إصلاح mapping أولًا، ويحتفظ بالتاريخ والصلاحيات الحالية.

## Integrity وUI

096–098 native current role/Organization/Branch/session وversion/current field scope/availability، strict bounded definition وimmutable history/Audit atomicity. API optimistic version ترفض concurrent stale edit؛ لا force overwrite. History metadata pagination وchosen-version read؛ available field picker بصفحات UUID محدودة. Current binding/definition permissions تعاد عند save/preview، وستعاد عند actual tool execution لاحقًا.

UI ar/en/fr تضيف الأسئلة وتربطها وتغير required/order، تبني شروطًا بقيم typed inputs نفسها المستخدمة لحقول Lead، وتعرض preview منفصلة والتاريخ السابق. النص untrusted escaped. Config enabled تعني إعداد التأهيل فقط؛ Campaign AI readiness لا تزال تمنع activation حتى اكتمال runtime/tools/guardrails/evaluations.

## الاعتماد التالي

بعد تثبيت هذه المجموعة: deterministic Global guardrails → Branch defaults → Campaign configuration، task Profile/Connection/shared-grant/current Knowledge وQualification/Field versions؛ ثم approved tools/qualification answer-result history مع AI/Human/Form source، runtime/jobs/lead assistant/copilot/internal assistant/evaluation scenarios. Actual field write يجب أن يبقى خلف approved tool وfield rules/Audit؛ Preview ليست بديلًا له ولا تعده منفذًا.
