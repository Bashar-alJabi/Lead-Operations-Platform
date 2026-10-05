# خطة التنفيذ

المراحل أدناه ترتيب تقني للعمل، ولا تُسقط أي متطلب من النطاق النهائي. بعد كل مرحلة: migration، build/typecheck، اختبارات القواعد والصلاحيات والفشل، تشغيل فعلي، ثم تحديث Coverage Matrix.

1. **الأساس التشغيلي والأمني:** workspace، PostgreSQL migration runner، الإعداد، health، audit، bootstrap وsessions وreset، Roles وbranch isolation.
2. **البيانات التشغيلية:** Branches/Users، Contacts/Leads، lifecycle، source submissions، campaign activation، dynamic fields/history، search وpagination.
3. **التوزيع والتواصل:** routing بطرقها الأربع، concurrency/history، conversations/controller، sender resolution، central messaging policy، inbound review، outbox/jobs وmock provider.
4. **التكاملات:** Connection UI وإدارة الأسرار، Meta، generic source، messaging، payment، email، Google Sheets؛ adapters مع verification وretries وstatus واختبارات sandbox/mocks.
5. **إكمال تدفق البيانات والمال:** Meta intake ومصادر Leads، ثم Payments/Enrollment وCallbacks والتحقق من أحداثها قبل استخدام أرقامها في AI أو Analytics.
6. **الـAI ثم العمليات المتبقية:** profiles، المعرفة المنشورة ونسخها، effective config، tools، customer assistant وinternal assistant وcopilot، qualification/handoff/follow-up، evaluations؛ ثم notifications، automations، import/export، Google Sheets، analytics متعددة العملات، saved views/bulk، audit وoperability.
7. **الواجهة والقبول:** شاشات الأدوار كلها، Arabic RTL وFrench/English، responsive، حالات الخطأ، E2E، اختبارات الأداء، restore، runbook، Requirement Coverage Matrix نهائية.

لا يُعد أي بند مكتملًا لمجرد وجود Schema أو شاشة. الحالة والتقدم الفعليان في `codex-progress.md` و`requirement-coverage.md`.

## ترتيب العمل الحالي بعد Messaging وSource baseline

Human Messaging text/media/templates/controller/policy/outbox/inbound/recovery baseline ثابتةمحليًا. Source Connection/catalog/bindings/grants/mapping/webhook/subscription/retrieval/evaluation/optional Contact/intake/public readiness والحistorical sync ثابتةفيcheckpoints043–055. External Messaging source references وcurrent pin/scope/conflict review/history/UI مثبتةفيcheckpoint058. هذهليستMessaging/Meta/المنصة Complete أوLive Verified؛ Coverage توضحالاختبارات والقيود. provider-specific formats الإضافيةbacklog، وAI/Automation/Follow-up dispatch تنفذعنداكتماDependencies وحداتها.

Payment Connection Authentication checkpoint059 ثابتة: encrypted scoped lifecycle وread-only Stripe auth probe وcurrent session/config/latest result/history/UI. الاختبارات74unit/28integration/12Browser ناجحة؛ WARNING لا تعنيFinancial flow readiness. الخطوة التالية Branch Payment Methods ثم Links/trusted callbacks/Enrollment؛ لاStripe live أوcredential حقيقية.

1. Payments/Enrollment: Provider adapters وConnection lifecycle منUI معencrypted credentials/current role/scope/config fences، authentication test وreconnect/disable/health/history؛ ثمBranch Methods/availability، durable idempotent per-Lead Links وsafe customer URLs، signed callbacks/trusted confirmation/monotonic events→separate Enrollment/activities/history وrole UI. 01 §§42–45 و02 §§59–63 و03 §§32–38/69–70/81 و06 §14 هيحدودBusiness. لاCustomer claim/success-page confirmation، وinstallments/refunds/accounting/ledger خارجالنطاق.
2. AI profiles/approved Knowledge/effective configuration/isolated tools/customer+internal assistants/copilot/qualification/handoff/evaluations وdispatch dependencies القائمة.
3. Automation/Notifications/Analytics/Import/Export/Google Sheets/Email وبقيةالنطاق وبواباتAcceptance/load/restore/operability/UI.

كلمرحلةمستقرةذاتمعنىتثبتBackend/DB/ACL/rules/UI/tests المناسبة، ثمprogress/coverage وcommit/push إلىcodex/full-platform-build فقط، قبلالمجموعةالتالية. لاmain merge أوProduction deployment دونموافقة، ولاcredential شخصية/production فيالتطوير.
