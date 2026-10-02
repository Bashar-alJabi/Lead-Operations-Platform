# تقدم التنفيذ

## الحالة في 2026-10-02

المشروع **غير مكتمل وغير جاهز للإنتاج**. بدأ Repository بوثائق فقط على الفرع المحلي `codex/full-platform-build`. قُرئت `AGENTS.md` و`README.md` و`INITIAL-CODEX-PROMPT.md` والوثائق السبع كاملة. مراجع `05` و`06` موجودة مسبقاً في README وAGENTS؛ لم تتطلب تغييراً. لا يوجد تعارض Business يمنع التنفيذ.

## ما أُنجز

- `technical-architecture.md` و`implementation-plan.md` ومصفوفة `requirement-coverage.md`.
- مشروع TypeScript/Fastify، React/Vite، إعداد PostgreSQL عبر Compose، ومخططتا SQL `001_core.sql` و`002_messaging.sql`.
- API أولية: secure first-admin bootstrap، login/logout/session، user create/list/disable، branch create/list، campaign create/agent binding/activation validation، manual Lead intake، Lead list/detail/lifecycle.
- Schema لـContact/Lead/Source Submission/History/Fields/Follow-up/Jobs، وConnection/Sender/Consent/Conversation/Message/Inbound Event. وجود Schema لا يعني اكتمال هذه الميزات.
- Routing أولي: scope، capacity، working hours، Round Robin وWeighted؛ Performance يستخدم fallback موضحاً ولا يحسب Human metrics بعد.
- دوال منفصلة لحسم Sender والإرسال وInbound ambiguous، وتشفير credential بـAES-GCM. هذه الدوال لم تُربط كلها بمسارات الإنتاج بعد.
- واجهة الأجزاء الحالية بالعربية RTL والفرنسية/الإنجليزية، responsive، تشمل login/setup والفروع والحملات والمستخدمين والـLeads.

## التحقق المنفذ

- `npm test`: **14/14** اختبارات وحدة ناجحة.
- Backend `tsc` build/typecheck: ناجح.
- Frontend `tsc -p web/tsconfig.json`: ناجح.
- `npm run web:build`: ناجح.
- `npm install`: تم بنجاح، `npm audit` أظهر 0 vulnerabilities وقت التنفيذ.
- PostgreSQL migration، API integration، UI E2E، failure/load tests: **لم تُشغّل**، فلا تُعد متحققة.

## بيئة التطوير ومسألة PostgreSQL

Node.js 24.19.0 وnpm 11.17.0 وpnpm 11.25.0 متاحة. Docker/PostgreSQL/Python ليست في PATH، وWSL يرفض تعداد التوزيعات. ثُبتت حزمة `embedded-postgres` المحلية للتطوير فقط، لكن تشغيلها داخل العزل فشل بخطأ Windows `uv_os_get_passwd ENOMEM` حتى بعد تبديل `tsx` إلى JavaScript مبني؛ الخطأ داخل constructor للحزمة. طلب تشغيل PostgreSQL المحلي خارج العزل لم تُمنح له الموافقة. لا توجد Production credentials أو حسابات شخصية مستخدمة. ملفات `.local` و`.env` مستثناة من Git.

## ما بقي وأولوية المتابعة

جميع المناطق غير المكتملة موثقة في `requirement-coverage.md`. الأولوية: تشغيل PostgreSQL مصرح به، تطبيق migrations وإصلاح أخطاء runtime، ثم اختبارات API للـbootstrap والـpermissions وLead intake/routing. بعدها استكمال Account reset/invite، Dynamic Fields، Messaging end-to-end مع worker/provider adapters، Meta/Payments/AI وباقي الوحدات والواجهة والاختبارات. لا يُعلن أي تكامل `Live Provider Verified` دون بيانات اختبار خارجية مصرح بها.

## الخطوة التالية الدقيقة

عند إتاحة PostgreSQL محلي أو Docker: شغّل `npm run db:local` أو `docker compose up -d postgres` مع secret محلي، واضبط `DATABASE_URL` من `.local/database-url` إن استُخدم PostgreSQL المضمّن، ثم `npm run db:migrate`. ابدأ فوراً بإصلاح أي خطأ migration ثم أضف اختبارات API/database للـbootstrap وbranch isolation وmanual intake والتوزيع المتزامن. بعد ذلك تابع جدول `implementation-plan.md` دون اعتبار الـSchema أو واجهة جزئية إكمالاً للمنصة.
