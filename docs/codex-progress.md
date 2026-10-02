# تقدم التنفيذ

## الحالة في 2026-10-02

المشروع **غير مكتمل وغير جاهز للإنتاج**. بدأ Repository بوثائق فقط على الفرع المحلي `codex/full-platform-build`. قُرئت `AGENTS.md` و`README.md` و`INITIAL-CODEX-PROMPT.md` والوثائق السبع كاملة. مراجع `05` و`06` موجودة مسبقاً في README وAGENTS؛ لم تتطلب تغييراً. لا يوجد تعارض Business يمنع التنفيذ.

## ما أُنجز

- `technical-architecture.md` و`implementation-plan.md` ومصفوفة `requirement-coverage.md`.
- مشروع TypeScript/Fastify، React/Vite، إعداد PostgreSQL عبر Compose، ومخططتا SQL `001_core.sql` و`002_messaging.sql`.
- API أولية: secure first-admin bootstrap، login/logout/session، user create/list/disable، branch create/list، campaign create/agent binding/activation validation، manual Lead intake، Lead list/detail/lifecycle.
- تغيير كلمة المرور للمستخدم المسجل من API والواجهة مع إبطال كل جلساته وAudit؛ Forgot/Reset للمنسي وInvitation ما زالا غير منفذين.
- Schema لـContact/Lead/Source Submission/History/Fields/Follow-up/Jobs، وConnection/Sender/Consent/Conversation/Message/Inbound Event. وجود Schema لا يعني اكتمال هذه الميزات.
- Routing أولي: scope، capacity، working hours، Round Robin وWeighted؛ Performance يستخدم fallback موضحاً ولا يحسب Human metrics بعد.
- دوال منفصلة لحسم Sender والإرسال وInbound ambiguous، وتشفير credential بـAES-GCM. هذه الدوال لم تُربط كلها بمسارات الإنتاج بعد.
- واجهة الأجزاء الحالية بالعربية RTL والفرنسية/الإنجليزية، responsive، تشمل login/setup والفروع والحملات والمستخدمين والـLeads. أضيفت صفحة تغيير كلمة المرور، وربط Agent بالحملة، وتفعيل/تعطيل المستخدمين وفق الدور. لا يوجد UI E2E بعد.

## التحقق المنفذ

- `npm test`: **14/14** اختبارات وحدة ناجحة.
- PostgreSQL 18 الحقيقي يعمل عبر Docker Desktop/Compose محلياً. طبقت `001_core.sql` و`002_messaging.sql` بنجاح على قاعدتي التطوير والاختبار، وأعيد تشغيل migration بلا تغييرات إضافية.
- `npm run test:integration`: ناجح على قاعدة `lead_operations_test` مستقلة. يغطي سباق تهيئة أول Super Admin، منع إعادة التهيئة، login/logout وتعطيل الحساب، تغيير كلمة المرور وإبطال الجلسة وانتهاء صلاحيتها، Origin، عزل الفروع، وصول Agent إلى Lead الخاصة به، intake ومطابقة Contact المتزامنة، pagination/lifecycle، وRound Robin متزامناً مع capacity وno-eligible-agent.
- شغّل الـAPI فعلياً؛ `/health/live` و`/health/ready` أعادا `ok` عبر HTTP، وحالة setup من قاعدة التطوير `initialized=false`.
- Backend `tsc` build/typecheck: ناجح.
- Frontend `tsc -p web/tsconfig.json`: ناجح.
- `npm run web:build`: ناجح.
- `npm install`: تم بنجاح، `npm audit` أظهر 0 vulnerabilities وقت التنفيذ.
- UI E2E، provider sandbox/live، failure/load tests الواسعة: **لم تُشغّل**، فلا تُعد متحققة.

## بيئة التطوير ومسألة PostgreSQL

Node.js 24.19.0 وnpm 11.17.0 وpnpm 11.25.0 متاحة. Docker CLI ليس في `PATH` داخل Codex رغم وجود مساره `C:\Users\Bashar\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe`؛ القراءة والتشغيل داخل العزل رُفضا. المسار المعتاد `C:\Program Files\Docker\Docker\resources\bin\docker.exe` غير موجود. بإذن تشغيل محدد نجح CLI، وظهر Docker Desktop 4.93.0 وEngine 29.8.1 وCompose 5.5.1. سُحبت صورة `postgres:18` وشُغّلت حاوية المشروع Healthy. وُلدت كلمة مرور تطوير عشوائية في `.env` ورابطها في `.local/database-url`، وكلاهما متجاهل من Git. لم تُستخدم `embedded-postgres` خارج العزل، ولا أي Production credential أو حساب شخصي.

## ما بقي وأولوية المتابعة

جميع المناطق غير المكتملة موثقة في `requirement-coverage.md`. الأولوية التالية: استكمال Account reset/invite، Dynamic Fields، Messaging end-to-end مع worker/provider adapters، Meta/Payments/AI وباقي الوحدات والواجهة والاختبارات. اختبارات API الحالية لا تغطي كل failure paths أو الصلاحيات في الميزات غير المبنية. لا يُعلن أي تكامل `Live Provider Verified` دون بيانات اختبار خارجية مصرح بها.

## الخطوة التالية الدقيقة

تابع جدول `implementation-plan.md` من Account lifecycle وبقية العمليات. PostgreSQL التطويري جاهز حالياً عبر Docker Compose؛ راجع `runbook.md` لإعادة تشغيله واختبارات قاعدة الاختبار المنفصلة. لا تعتبر الـSchema أو الواجهة الجزئية إكمالاً للمنصة، وحدّث المصفوفة بعد كل مجموعة ميزات مع اختبارها.
