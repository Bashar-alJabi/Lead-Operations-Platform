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
