# تقدم التنفيذ

## آخر نقطة تحقق: Search Sorting/Columns

- مجموعة Lead workflow/Follow-ups/Search/Saved Views محفوظة في commit محلي `e1e68ef`. مرحلة Sorting/Columns التالية اختُبرت وتُحفظ في commit محلي مرافق لهذه الوثيقة. لا Push أو Merge أو نشر.
- التنفيذ المثبت: migrations `011`–`013`، سجل نشاط وإسناد وإعادة إسناد مع version وAudit، ملاحظات داخلية، متابعات Human مع تاريخ ونسخة وحالات الإكمال/الإلغاء، بحث Leads بنطاق الدور وفلاتر المتابعة والحقول الديناميكية المرئية، ومشاهد محفوظة بنطاقات شخصية/فرع/مؤسسة وعمليات إنشاء/تعديل/حذف وواجهة تطبيق/إنشاء/حذف.
- التحقق: Docker Compose يعرض PostgreSQL 18 `healthy`؛ أعيد تشغيل migrations `001`–`013` على قاعدتي التطوير والاختبار؛ Backend/Web typecheck و`npm test` **18/18** و`npm run test:integration` **5/5** و`npm run web:build` ناجحة. الاختبار الجديد يفحص الصلاحيات، إخفاء الحقول، تعارض النسخ والأسماء، التكرار، وتقييد البحث بعد تغير مالك Lead. UI E2E لم يُشغّل.
- المرحلة المستقرة الجديدة: ترتيب `CREATED_ASC`/`CREATED_DESC` مع keyset pagination، وإرجاع موعد أقرب متابعة مفتوحة، واختيار أعمدة Lead في الواجهة وحفظ ترتيب الأعمدة والفلاتر وتطبيقها في Saved View. يرفض Backend قيمة Sort أو أعمدة غير مسموحة. اجتازت 18/18 unit و5/5 integration مع فحص نوع Backend/Web وWeb build؛ لا migration جديدة. UI E2E لم يُشغّل.
- حدود التنفيذ الحالية: لا نقل Lead بين الفروع، ولا Follow-up آلي بسياسة إرسال، ولا Bulk actions أو فلاتر Payment/Enrollment/Conversation قبل بناء وحداتها. Sorting الحالي لتاريخ الإنشاء صعوداً/هبوطاً. تبقى هذه المتطلبات جزئية في المصفوفة.
- الخطوة التالية الدقيقة: Bulk actions للـLeads ضمن نطاق الصلاحيات وبحدود حجم واضحة، مع تأكيد الواجهة وAudit ونتيجة لكل عنصر واختبارات فشل/تزامن. حدّث progress/coverage واحفظ commit بعد استقرار هذه المرحلة، ثم ابدأ Messaging end-to-end قبل AI.

## الحالة في 2026-10-03

المشروع **غير مكتمل وغير جاهز للإنتاج**. بدأ Repository بوثائق فقط على الفرع المحلي `codex/full-platform-build`. قُرئت `AGENTS.md` و`README.md` و`INITIAL-CODEX-PROMPT.md` والوثائق السبع كاملة. مراجع `05` و`06` موجودة مسبقاً في README وAGENTS؛ لم تتطلب تغييراً. لا يوجد تعارض Business يمنع التنفيذ.

## ما أُنجز

- `technical-architecture.md` و`implementation-plan.md` ومصفوفة `requirement-coverage.md`.
- مشروع TypeScript/Fastify، React/Vite، إعداد PostgreSQL عبر Compose، وmigrations `001_core.sql` حتى `013_saved_lead_views.sql`.
- API أولية: secure first-admin bootstrap، login/logout/session، user create/list/disable، branch create/list، campaign create/agent binding/activation validation، manual Lead intake، Lead list/detail/lifecycle.
- Account lifecycle: تغيير كلمة المرور وإبطال الجلسات، دعوات إنشاء المستخدمين بدل تحديد المسؤول لكلمة مرورهم، إعادة الدعوة، Forgot/Reset برموز عشوائية hashed وأحادية الاستعمال ومحدودة المدة، إبطال الجلسات عند Reset، Audit. إعداد SMTP لحسابات المنظمة من الواجهة مع تشفير credential واختبار اتصال، وworker لإرسال الروابط المشفرة في outbox مع retries/lease/dead state وقائمة حالة تسليم وإعادة محاولة ضمن الصلاحيات.
- مجموعة Contacts لمسار Manual: تطبيع صارم لهاتف E.164 والبريد مع حفظ الإدخال الأصلي، مطابقة متزامنة بأقفال مرتبة، وإبقاء Leads منفصلة. حالات الالتباس أو التطابق مع Contact خارج فرع Manager تحفظ `source_submission` في `NEEDS_ATTENTION`؛ واجهة مراجعة وحسم صريح وآمن عند التكرار، مع منع Manager من رؤية أو حسم مرشحين خارج نطاقه. قائمة/بحث/تفاصيل/تعديل Contacts في الواجهة والـAPI، و`version` لمنع فقد التعديل المتزامن، وتاريخ تغييرات وAudit. Contact مشتركة بين فروع تُقرأ ضمن Leads المصرح بها ويعدلها Super Admin فقط.
- مجموعة Dynamic Fields الأساسية: تعريفات Global/Branch/Campaign و19 نوعاً موثقاً مع Calculated، خيارات وترتيبها وتعطيلها، إعدادات العرض والصلاحيات لكل Campaign، واجهة Field Builder وLead Details وإنشاء Lead. Backend يتحقق من الأنواع وخياراتها وEditable/Visible وRequired عند إنشاء Lead وإغلاقها، ويحفظ value history ونسخ التعديل، بما في ذلك القيم المحفوظة داخل حالة Contact review. الحقول المحسوبة تُقرأ من Queries تشغيلية موثوقة ولا تخلط محاولات AI/Human. تكامل Filter/Export/Source mapping وEnrollment gate مرتبط بالمجموعات اللاحقة ولم يُعلن مكتملاً.
- مجموعة Campaign configuration الأساسية: Create/Edit/Detail/Readiness/Activate/Deactivate، قفل ونسخة إعداد لمنع فقد التعديلات المتزامنة، Agent weights/capacity والبحث والإزالة، Audit، واجهة الإعداد والجاهزية بـ3 لغات. `MANUAL` و`ROUND_ROBIN` و`WEIGHTED` قابلة للتفعيل عند نجاح الشروط؛ Source الخارجي وMessaging وAI وPerformance routing تظهر كغير جاهزة حتى اكتمال الخدمات اللازمة. تعريف Conversion اختياري للدفع/التسجيل المؤكد؛ لا تعرض المنصة معدل تحويل غير معرّف. تعطيل الحملة يمنع Manual intake الجديدة مع بقاء Lead السابقة. Setup Wizard الكامل وربط بقية الوحدات ما زال ناقصاً.
- مجموعة Lead workflow الحالية: activity وassignment history مع pagination؛ إعادة إسناد داخل الفرع بقفل وversion ونقل متابعات المالك القديم وHuman conversation controller؛ ملاحظات داخلية؛ متابعات Human مع موعد وأولوية وتعديل/إكمال/إلغاء وتاريخ/Audit؛ بحث Leads بالاسم والهاتف والبريد وID وفلاتر Branch/Campaign/Agent/Source/Lifecycle/date/follow-up/visible custom field وترتيب تاريخ الإنشاء؛ Saved Views مع scope وversion وواجهة اختيار الأعمدة وحفظها. نقل الفروع، Follow-up automation، Bulk، وفلاتر الوحدات المستقبلية باقية.
- Schema لـContact/Lead/Source Submission/History/Fields/Follow-up/Jobs، وConnection/Sender/Consent/Conversation/Message/Inbound Event. وجود Schema لا يعني اكتمال الميزات الأخرى.
- Routing أولي: scope، capacity، working hours، Round Robin وWeighted؛ Performance يستخدم fallback موضحاً ولا يحسب Human metrics بعد.
- دوال منفصلة لحسم Sender والإرسال وInbound ambiguous، وتشفير credential بـAES-GCM. هذه الدوال لم تُربط كلها بمسارات الإنتاج بعد.
- واجهة الأجزاء الحالية بالعربية RTL والفرنسية/الإنجليزية، responsive، تشمل login/setup/forgot/reset/invitation والفروع والحملات والمستخدمين والـLeads وContacts ومراجعة المطابقة. أضيفت صفحة تغيير كلمة المرور، إعداد بريد الحسابات، قائمة حالة التسليم، ربط Agent بالحملة، وتفعيل/تعطيل المستخدمين وفق الدور. لا يوجد UI E2E بعد.

## التحقق المنفذ

- `npm test`: **18/18** اختبارات وحدة ناجحة، منها اختبارا تطبيع Contacts واختبارا Field validation.
- PostgreSQL 18 الحقيقي يعمل عبر Docker Desktop/Compose محلياً، وتأكدت مجدداً من حالة الحاوية `healthy`. طبقت وأعدت تشغيل migrations `001` حتى `013` بنجاح على قاعدتي التطوير والاختبار.
- `npm run test:integration`: ناجح على قاعدة `lead_operations_test` مستقلة. يغطي سباق تهيئة أول Super Admin، منع إعادة التهيئة، login/logout وتعطيل الحساب، تغيير كلمة المرور وإبطال الجلسة وانتهاء صلاحيتها، Origin، عزل الفروع، وصول Agent إلى Lead الخاصة به، منع كشف Campaign غير مرتبطة بـLeads المسموحة، intake ومطابقة Contact المتزامنة، pagination/lifecycle، وRound Robin متزامناً مع capacity وno-eligible-agent.
- اختبار Identity على PostgreSQL مع Email adapter وهمي يغطي إعداد/اختبار الاتصال، تشفير السر، نطاق Manager/Agent، الدعوة والقبول وإعادة الدعوة، Forgot/Reset المتزامن، منع تكرار الرمز، فشل الإرسال وإعادة المحاولة والـDead/expired/disabled jobs، وقائمة التسليم دون كشف token/secret.
- وسع اختبار API على PostgreSQL لتغطية تطبيع الهاتف والبريد ورفض المدخلات غير الصالحة، إعادة استخدام Contact، حفظ Source Submission الأصلية، مراجعة الالتباس والحسم المتزامن، انعدام Lead مكررة، بحث Contacts وpagination، وصول Agent وManager، حماية بيانات المرشحين بين الفروع، منع تعديل Contact مشتركة، وتعارض التعديل المتزامن.
- `npm run test:integration`: **5/5 suites ناجحة**؛ تغطي مجموعات Dynamic Fields وCampaign الاختبارات المذكورة، وتختبر مجموعة Lead workflow على PostgreSQL النشاط والإسناد والتعارض والمتابعات ونطاق الدور، والبحث مع حقل مخفي/مرئي، وSaved Views بصلاحياتها وتعارض اسم/نسخة وحذفها واستمرار تقييد Lead بعد إعادة الإسناد. لم تُشغّل UI E2E أو مزود رسائل حي.
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

جميع المناطق غير المكتملة موثقة في `requirement-coverage.md`. Account lifecycle بُني واختُبر بمزود بريد وهمي، لكن UI E2E وSMTP sandbox/live ما زالا مطلوبين للتحقق الشامل؛ Email العام للإشعارات لم يُبن. Contacts أُنجزت لمسار Manual مع اختبارات PostgreSQL؛ ربط external participant identifiers ينتظر مسارات Messaging/Source الفعلية. Dynamic Fields الأساسية تعمل مع Manual Leads؛ فلتر الحقل المرئي في Search مثبت، بينما Export وSource mapping وEnrollment gate ستُربط عند بناء تلك الوحدات. Campaign configuration الأساسية تعمل لمسارات Manual والتوزيع الجاهز، لكن Source/Messaging/AI/Performance وSetup Wizard الشامل تعتمد على وحدات لم تكتمل. Lead workflow/Follow-ups/Search/Saved Views الأساسية مع ترتيب تاريخ الإنشاء واختيار الأعمدة اجتازت اختبارات PostgreSQL، لكن Bulk وفلاتر الوحدات اللاحقة لا تزال ناقصة. الأولوية التالية وفق dependencies: Bulk، ثم Messaging end-to-end قبل AI. اختبارات API الحالية لا تغطي كل failure paths أو الصلاحيات في الميزات غير المبنية. لا يُعلن أي تكامل `Live Provider Verified` دون بيانات اختبار خارجية مصرح بها.

## الخطوة التالية الدقيقة

ابدأ Bulk actions محددة الحجم والتدقيق ضمن صلاحيات Lead الحالية، وافصل نتيجة كل عنصر حتى لا يضيع نجاح البعض عند فشل عنصر واحد؛ اختبر السباق والصلاحيات والفشل على PostgreSQL، وحدّث الوثيقتين واحفظ checkpoint محلياً. بعدها انتقل إلى Messaging end-to-end قبل AI. PostgreSQL التطويري جاهز عبر Docker Compose؛ راجع `runbook.md`. لا تعتبر الـSchema أو الواجهة الجزئية إكمالاً للمنصة.
