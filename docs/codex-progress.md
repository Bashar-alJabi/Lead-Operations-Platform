# تقدم التنفيذ

## الحالة في 2026-10-02

المشروع **غير مكتمل وغير جاهز للإنتاج**. بدأ Repository بوثائق فقط على الفرع المحلي `codex/full-platform-build`. قُرئت `AGENTS.md` و`README.md` و`INITIAL-CODEX-PROMPT.md` والوثائق السبع كاملة. مراجع `05` و`06` موجودة مسبقاً في README وAGENTS؛ لم تتطلب تغييراً. لا يوجد تعارض Business يمنع التنفيذ.

## ما أُنجز

- `technical-architecture.md` و`implementation-plan.md` ومصفوفة `requirement-coverage.md`.
- مشروع TypeScript/Fastify، React/Vite، إعداد PostgreSQL عبر Compose، وmigrations `001_core.sql` حتى `004_identity_jobs.sql`.
- API أولية: secure first-admin bootstrap، login/logout/session، user create/list/disable، branch create/list، campaign create/agent binding/activation validation، manual Lead intake، Lead list/detail/lifecycle.
- Account lifecycle: تغيير كلمة المرور وإبطال الجلسات، دعوات إنشاء المستخدمين بدل تحديد المسؤول لكلمة مرورهم، إعادة الدعوة، Forgot/Reset برموز عشوائية hashed وأحادية الاستعمال ومحدودة المدة، إبطال الجلسات عند Reset، Audit. إعداد SMTP لحسابات المنظمة من الواجهة مع تشفير credential واختبار اتصال، وworker لإرسال الروابط المشفرة في outbox مع retries/lease/dead state وقائمة حالة تسليم وإعادة محاولة ضمن الصلاحيات.
- Schema لـContact/Lead/Source Submission/History/Fields/Follow-up/Jobs، وConnection/Sender/Consent/Conversation/Message/Inbound Event. وجود Schema لا يعني اكتمال هذه الميزات.
- Routing أولي: scope، capacity، working hours، Round Robin وWeighted؛ Performance يستخدم fallback موضحاً ولا يحسب Human metrics بعد.
- دوال منفصلة لحسم Sender والإرسال وInbound ambiguous، وتشفير credential بـAES-GCM. هذه الدوال لم تُربط كلها بمسارات الإنتاج بعد.
- واجهة الأجزاء الحالية بالعربية RTL والفرنسية/الإنجليزية، responsive، تشمل login/setup/forgot/reset/invitation والفروع والحملات والمستخدمين والـLeads. أضيفت صفحة تغيير كلمة المرور، إعداد بريد الحسابات، قائمة حالة التسليم، ربط Agent بالحملة، وتفعيل/تعطيل المستخدمين وفق الدور. لا يوجد UI E2E بعد.

## التحقق المنفذ

- `npm test`: **14/14** اختبارات وحدة ناجحة.
- PostgreSQL 18 الحقيقي يعمل عبر Docker Desktop/Compose محلياً. طبقت migrations `001` حتى `004` بنجاح على قاعدتي التطوير والاختبار، وأعيد تشغيل migration بلا تغييرات إضافية.
- `npm run test:integration`: ناجح على قاعدة `lead_operations_test` مستقلة. يغطي سباق تهيئة أول Super Admin، منع إعادة التهيئة، login/logout وتعطيل الحساب، تغيير كلمة المرور وإبطال الجلسة وانتهاء صلاحيتها، Origin، عزل الفروع، وصول Agent إلى Lead الخاصة به، منع كشف Campaign غير مرتبطة بـLeads المسموحة، intake ومطابقة Contact المتزامنة، pagination/lifecycle، وRound Robin متزامناً مع capacity وno-eligible-agent.
- `npm run test:integration`: **2/2 suites ناجحة**؛ أضيف اختبار Identity على PostgreSQL مع Email adapter وهمي يغطي إعداد/اختبار الاتصال، تشفير السر، نطاق Manager/Agent، الدعوة والقبول وإعادة الدعوة، Forgot/Reset المتزامن، منع تكرار الرمز، فشل الإرسال وإعادة المحاولة والـDead/expired/disabled jobs، وقائمة التسليم دون كشف token/secret.
- بعد اختبار سلبّي، عُدّل Fastify/Ajv كي يرفض خصائص JSON الزائدة بدلاً من حذفها بصمت؛ أصبح مسار إنشاء المستخدم يرفض كلمة مرور يرسلها المسؤول. قوائم المستخدمين ومهام البريد تدعم keyset pagination.
- شغّل الـAPI فعلياً؛ `/health/live` و`/health/ready` أعادا `ok` عبر HTTP، وحالة setup من قاعدة التطوير `initialized=false`.
- شغّلت عملية `identity-worker` المحلية على قاعدة التطوير لمدة قصيرة وتأكدت أنها تبدأ وتستمر دون خطأ؛ مسار الإرسال نفسه تحقق بـfake adapter داخل integration tests فقط.
- Backend `tsc` build/typecheck: ناجح.
- Frontend `tsc -p web/tsconfig.json`: ناجح.
- `npm run web:build`: ناجح.
- `npm install`: تم بنجاح، `npm audit` أظهر 0 vulnerabilities وقت التنفيذ.
- بعد إضافة `nodemailer`، نجح `npm audit --omit=dev --audit-level=high` وأظهر 0 vulnerabilities وقت الفحص.
- UI E2E، SMTP sandbox/live، وبقية provider sandbox/live، failure/load tests الواسعة: **لم تُشغّل**، فلا تُعد متحققة. لا توجد بيانات اعتماد بريد حقيقية؛ SMTP adapter موجود لكن لم يُتحقق منه مع مزود مباشر.

## بيئة التطوير ومسألة PostgreSQL

Node.js 24.19.0 وnpm 11.17.0 وpnpm 11.25.0 متاحة. Docker CLI ليس في `PATH` داخل Codex رغم وجود مساره `C:\Users\Bashar\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe`؛ القراءة والتشغيل داخل العزل رُفضا. المسار المعتاد `C:\Program Files\Docker\Docker\resources\bin\docker.exe` غير موجود. بإذن تشغيل محدد نجح CLI، وظهر Docker Desktop 4.93.0 وEngine 29.8.1 وCompose 5.5.1. سُحبت صورة `postgres:18` وشُغّلت حاوية المشروع Healthy. وُلدت كلمة مرور تطوير عشوائية في `.env` ورابطها في `.local/database-url`، وكلاهما متجاهل من Git. لم تُستخدم `embedded-postgres` خارج العزل، ولا أي Production credential أو حساب شخصي.

## ما بقي وأولوية المتابعة

جميع المناطق غير المكتملة موثقة في `requirement-coverage.md`. Account lifecycle بُني واختُبر بمزود بريد وهمي، لكن UI E2E وSMTP sandbox/live ما زالا مطلوبين للتحقق الشامل؛ Email العام للإشعارات لم يُبن. الأولوية التالية وفق dependencies: Contacts normalization، Dynamic Fields، Campaign configuration، Lead history/follow-up/search؛ ثم Messaging end-to-end قبل AI، ثم بقية الوحدات بالترتيب المحدد. اختبارات API الحالية لا تغطي كل failure paths أو الصلاحيات في الميزات غير المبنية. لا يُعلن أي تكامل `Live Provider Verified` دون بيانات اختبار خارجية مصرح بها.

## الخطوة التالية الدقيقة

ابدأ Core CRM foundations من تطبيع Contact ومراجعة قواعد الدمج والهوية، ثم Dynamic Fields مع Backend permissions/history والواجهة والاختبارات. شغّل `npm run worker:identity` مع API في بيئة التطوير عند تجربة Email sandbox؛ يحتاج `DATABASE_URL` و`APP_ORIGIN` و`CREDENTIAL_ENCRYPTION_KEY`. PostgreSQL التطويري جاهز عبر Docker Compose؛ راجع `runbook.md`. لا تعتبر الـSchema أو الواجهة الجزئية إكمالاً للمنصة، وحدّث المصفوفة بعد كل مجموعة ميزات مع اختبارها.
