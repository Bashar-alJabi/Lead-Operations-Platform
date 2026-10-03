# دليل التشغيل والتطوير

## الحالة الحالية

التعليمات هنا لتشغيل **الأجزاء المنفذة حالياً** ومراجعتها. المنصة ليست مكتملة أو جاهزة للإنتاج؛ راجع `codex-progress.md` و`requirement-coverage.md` قبل أي نشر. تحققت migrations واختبارات API على PostgreSQL 18 المحلي عبر Docker Desktop.

## المتطلبات

- Node.js 24 أو أحدث، npm.
- PostgreSQL 18 عبر Docker Compose أو instance مُدار. للتطوير على Windows توجد حزمة `embedded-postgres` في devDependencies، ولا تُستخدم في الإنتاج.
- قيم مستقلة لكل بيئة لـ`DATABASE_URL` و`APP_ORIGIN` و`CREDENTIAL_ENCRYPTION_KEY` و`BOOTSTRAP_TOKEN` قبل التهيئة الأولى. لا تُخزن القيم في Git.

## تشغيل محلي

1. `npm ci`.
2. ولّد `POSTGRES_PASSWORD` عشوائية في `.env` المحلي المتجاهل من Git، ثم `docker compose up -d --wait postgres`. احفظ `DATABASE_URL` المطابق في `.local/database-url` المحلي المتجاهل من Git. لا تستخدم اعتماداً حقيقياً أو حساباً شخصياً. على جهاز التطوير الحالي، CLI موجود في `C:\Users\Bashar\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe` ويحتاج تشغيله من Codex إلى إذن خارج العزل؛ يمكن استدعاؤه بالمسار الكامل. لا تستخدم `embedded-postgres` خارج العزل.
3. اضبط `DATABASE_URL` في عملية الـAPI، ثم `npm run db:migrate`.
4. ولّد مفتاح تشفير credential من 32 بايت عشوائية، ورمز bootstrap عشوائياً مستقلاً. عين `CREDENTIAL_ENCRYPTION_KEY` و`BOOTSTRAP_TOKEN` في بيئة الـAPI، و`APP_ORIGIN=http://127.0.0.1:5173` للتطوير.
5. شغّل `npm run build` ثم `npm start` للـAPI، وفي نافذة ثانية `npm run web:dev` للواجهة.
6. افتح `http://127.0.0.1:5173` وأنشئ أول Super Admin برمز bootstrap. بعد النجاح يصبح مسار التهيئة غير صالح لأن وجود أول مستخدم يمنع تكراره. احذف رمز bootstrap من بيئة النشر بعد ذلك.
7. لتفعيل دعوات الموظفين واستعادة كلمة المرور: من صفحة **بريد الحسابات**، أدخل بيانات SMTP التي أُنشئت لدى مزود البريد واختبر الاتصال. لا يُعاد عرض كلمة المرور بعد حفظها. شغّل عملية `npm run worker:identity` مستقلة مع `DATABASE_URL` و`APP_ORIGIN` و`CREDENTIAL_ENCRYPTION_KEY` نفسها. يمكن للـSuper Admin وManager المصرح لهما رؤية حالة التسليم وإعادة محاولة Job فاشل صالح. `APP_ORIGIN` يجب أن يكون origin الواجهة الذي يستقبل رابط الدعوة/الاستعادة. لا تستخدم Credential شخصية أو Production للتطوير.
8. عند إدخال Lead يطابق أكثر من Contact أو يطابق Contact خارج فرع Manager، تُحفظ Submission وتظهر في **مراجعة المطابقة** دون إنشاء Lead. يختار المسؤول Contact المرشحة صراحة؛ الحالات التي تضم مرشحاً خارج نطاق الفرع تحتاج Super Admin. تأكد من ظهور Lead بعد الحسم في صفحة الفرص ومن بقاء Submission التاريخية؛ تكرار الحسم نفسه يعيد Lead نفسها.
9. من **الحقول الديناميكية** اختر Campaign ثم أنشئ Field بالنطاق المسموح واربطها بالحملة. اضبط `requiredStage` وظهور Agent/Manager والتحرير والترتيب. تظهر القيم المصرح بها في Lead Details ويمكن حفظها ومراجعة تاريخها. عند تعيين `LEAD_CREATION` يجب إدخال القيمة أثناء إنشاء Lead؛ وعند `CLOSE` يمنع الـAPI إغلاق Lead إن كانت ناقصة. `ENROLLMENT` ينتظر خدمة التسجيل قبل التحقق التشغيلي الكامل. تعديل خيارات مستخدمة تاريخياً يستلزم إبقاء المفتاح وتعطيله بدل حذفه.

لعامل الرسائل شغّل `npm run worker:messaging` كعملية مستقلة بعد `npm run build` مع `DATABASE_URL` و`CREDENTIAL_ENCRYPTION_KEY` نفسيهما. يلتقط Jobs المعلقة ويعيد فحص السياسة قبل الاتصال بالمزوّد. `SENT` تعني قبول طلب الإرسال مع Provider Message ID ولا تثبت `DELIVERED`؛ `UNKNOWN` تعني أن نتيجة الطلب ملتبسة وتحتاج مراجعة ولا يعيد العامل إرسالها تلقائياً. إدارة Meta templates وإنشاء قالب نصي ثابت ومزامنة اعتماده وربطه بحملة، ثم إرساله عبر العامل، اجتازت الاختبارات بموفر وهمي. يجب اعتماد القالب من Meta وربطه بالحملة من الواجهة، ويعيد العامل فحص Approval وSnapshot قبل الإرسال. لاختبار اتصال من الواجهة: اكتشف الأرقام، أنشئ/زامن قالب BODY ثابتاً معتمداً، اختر Sender ورقم اختبار تتحكم به أو حصلت على موافقته، وأكد ذلك ثم أرسل اختباراً. تعرض الواجهة `SUCCEEDED/REJECTED/UNKNOWN` دون رقم المستلم الكامل؛ عند `UNKNOWN` افحص Meta قبل طلب جديد، إذ لا تحدث إعادة تلقائية. `CONNECTED` هنا يعني قبول مزود الاختبار للطلب من رقم محدد، مع بقاء `webhookVerified=false` وSender `DEGRADED`. اختبارات التطوير تستخدم fake provider ولم تثبت Meta live أو التسليم/Callbacks/Webhook؛ لا تعتبر المنصة جاهزة لتشغيل Messaging الحي اعتماداً على هذه الاختبارات وحدها.

في الإنتاج، اجعل الواجهة والـAPI وراء HTTPS وreverse proxy على origin واحد أو اضبط `APP_ORIGIN` على origin الواجهة الحقيقي. Cookie الجلسة `Secure` في `NODE_ENV=production`. يجب أن يوجه proxy مسار `/api` و`/health` إلى الـAPI، وأن يقدّم ملفات `dist-web` بعد `npm run web:build`.

## الاختبارات والنسخ الاحتياطي

`npm test` يشغّل اختبارات الوحدة الحالية. `npm run typecheck` و`npm run web:typecheck` و`npm run web:build` تفحص البناء. لا تُعتبر هذه بديلاً عن integration/E2E/load tests الواردة في `06`.
`npm run test:integration` يستخدم Email adapter وهمياً، ولا يتصل بمزود بريد حقيقي. يتطلب تحقق SMTP sandbox/live حساباً أو Credential مخصصة ومصرحاً بها؛ حالياً الحالة `Live Verification Pending External Credential/Approval`. لا تشغّل worker ضد اتصال Production أثناء الاختبارات.

لاختبارات API: أنشئ قاعدة منفصلة `lead_operations_test` داخل حاوية المشروع (`docker compose exec -T postgres createdb -U lead_operations lead_operations_test` مرة واحدة). اضبط `DATABASE_URL` على هذه القاعدة وطبّق `npm run db:migrate`، ثم اضبط `TEST_DATABASE_URL` على الرابط نفسه وشغّل `npm run test:integration`. الاختبار يرفض أي اسم قاعدة غير `lead_operations_test` ويفرّغ بياناتها قبل كل تشغيل؛ لا توجهه إلى قاعدة التطوير أو الإنتاج. لا تعرض روابط الاتصال أو كلمات المرور في السجل. قاعدة التطوير نفسها تبقى منفصلة.

خطة الإنتاج هي نسخة PostgreSQL متسقة عبر `pg_dump`/managed snapshots مع نسخ ملفات object storage ذات الصلة، واحتفاظ محدد واختبار استعادة دوري في بيئة معزولة. يجب اختبار استعادة فعلية قبل اعتماد المنصة؛ لم يُجر هذا الاختبار بعد. migrations تُطبق قبل تفعيل نسخة التطبيق الجديدة، وبعد snapshot، ولا يُنفذ تعديل يدوي غير موثق لبيانات الإنتاج.

## الأسرار والتكاملات

`CREDENTIAL_ENCRYPTION_KEY` سر deployment مستقل عن Business-managed credentials؛ لا يُنشر ولا يُرسل للـAI. تغيير المفتاح يحتاج عملية تدوير تعيد تشفير الأسرار؛ لم تُنفذ واجهة التدوير بعد. لا تضف Credential حقيقية إلى التطوير الحالي. إعداد مزودي Meta وMessaging وPayment وEmail وAI من الواجهة لم يكتمل بعد، لذا لا تُستخدم Connections حقيقية أو تُعرض حالة نجاح مزيفة.
