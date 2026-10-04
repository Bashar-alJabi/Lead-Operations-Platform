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

## ترتيب العمل الحالي بعد Messaging baseline

Media Templates محفوظة في `83c0022`. Human Messaging baseline للصيغ الحالية متحققة بـmocks/PostgreSQL/Browser؛ ليست Messaging Complete ولا Live Verified. AI/Automation/Follow-up dispatch تنفذ مع وحداتها بعد Dependencies، وexternal source references تعتمد Source bindings. لا توسع provider-specific formats قبل Meta/Payments/AI لمجرد أن المزود يدعمها.

1. Meta Connection lifecycle وPage/Form catalog/questions/secret boundaries/sync fencing/UI: مثبتة في checkpoint الحالية.
2. Campaign/Form bindings متعددة وexternal Campaign/Ad Set/Ad selectors وconflict validation/shared Form access/version/history: مثبتة في checkpoint الحالية. التالية Source field→Contact/Lead dynamic field mapping وautosuggest/manual/type/required preview/version/history/readiness، مع grant enforcement وCalculated target rejection.
3. Signed durable Webhook intake وprovider retrieval worker وSubmission/idempotency/contact normalization/Lead routing/Needs Attention/reprocess؛ source/operational data منفصلتان، ولا تخمين للحملة أو contact الغامضة.
4. Historical Meta sync بpreview/progress/results/deduplication، وربط external Messaging references حيث تدعمها المصادر.
5. Payments/Enrollment ثم AI ثم Automation/Notifications/Analytics/Import/Export/Sheets/Email وبقية بوابات القبول، كما يحدد النطاق الكامل.

كل مرحلة مستقرة ذات معنى تشمل Backend/DB/ACL/rules/UI/tests المطلوبة ثم تحديث progress/coverage وcommit/push إلى branch الحالية فقط؛ لا تؤخر التوثيق لنهاية Module كبيرة.
