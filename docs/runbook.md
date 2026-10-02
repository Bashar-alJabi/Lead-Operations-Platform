# دليل التشغيل والتطوير

## الحالة الحالية

التعليمات هنا لتشغيل **الأجزاء المنفذة حالياً** ومراجعتها. المنصة ليست مكتملة أو جاهزة للإنتاج؛ راجع `codex-progress.md` و`requirement-coverage.md` قبل أي نشر. لم تُختبر migrations على PostgreSQL في هذه الجلسة بسبب قيود بيئة الجهاز.

## المتطلبات

- Node.js 24 أو أحدث، npm.
- PostgreSQL 18 عبر Docker Compose أو instance مُدار. للتطوير على Windows توجد حزمة `embedded-postgres` في devDependencies، ولا تُستخدم في الإنتاج.
- قيم مستقلة لكل بيئة لـ`DATABASE_URL` و`APP_ORIGIN` و`CREDENTIAL_ENCRYPTION_KEY` و`BOOTSTRAP_TOKEN` قبل التهيئة الأولى. لا تُخزن القيم في Git.

## تشغيل محلي

1. `npm ci`.
2. إذا كان Docker متاحاً: حدد `POSTGRES_PASSWORD` في بيئة التشغيل ثم `docker compose up -d postgres`. أو `npm run db:local` لتشغيل PostgreSQL مضمّن ببيانات محلية في `.local`؛ يكتب رابط الاتصال في `.local/database-url`.
3. اضبط `DATABASE_URL` في عملية الـAPI، ثم `npm run db:migrate`.
4. ولّد مفتاح تشفير credential من 32 بايت عشوائية، ورمز bootstrap عشوائياً مستقلاً. عين `CREDENTIAL_ENCRYPTION_KEY` و`BOOTSTRAP_TOKEN` في بيئة الـAPI، و`APP_ORIGIN=http://127.0.0.1:5173` للتطوير.
5. شغّل `npm run build` ثم `npm start` للـAPI، وفي نافذة ثانية `npm run web:dev` للواجهة.
6. افتح `http://127.0.0.1:5173` وأنشئ أول Super Admin برمز bootstrap. بعد النجاح يصبح مسار التهيئة غير صالح لأن وجود أول مستخدم يمنع تكراره. احذف رمز bootstrap من بيئة النشر بعد ذلك.

في الإنتاج، اجعل الواجهة والـAPI وراء HTTPS وreverse proxy على origin واحد أو اضبط `APP_ORIGIN` على origin الواجهة الحقيقي. Cookie الجلسة `Secure` في `NODE_ENV=production`. يجب أن يوجه proxy مسار `/api` و`/health` إلى الـAPI، وأن يقدّم ملفات `dist-web` بعد `npm run web:build`.

## الاختبارات والنسخ الاحتياطي

`npm test` يشغّل اختبارات الوحدة الحالية. `npm run typecheck` و`npm run web:typecheck` و`npm run web:build` تفحص البناء. لا تُعتبر هذه بديلاً عن integration/E2E/load tests الواردة في `06`.

خطة الإنتاج هي نسخة PostgreSQL متسقة عبر `pg_dump`/managed snapshots مع نسخ ملفات object storage ذات الصلة، واحتفاظ محدد واختبار استعادة دوري في بيئة معزولة. يجب اختبار استعادة فعلية قبل اعتماد المنصة؛ لم يُجر هذا الاختبار بعد. migrations تُطبق قبل تفعيل نسخة التطبيق الجديدة، وبعد snapshot، ولا يُنفذ تعديل يدوي غير موثق لبيانات الإنتاج.

## الأسرار والتكاملات

`CREDENTIAL_ENCRYPTION_KEY` سر deployment مستقل عن Business-managed credentials؛ لا يُنشر ولا يُرسل للـAI. تغيير المفتاح يحتاج عملية تدوير تعيد تشفير الأسرار؛ لم تُنفذ واجهة التدوير بعد. لا تضف Credential حقيقية إلى التطوير الحالي. إعداد مزودي Meta وMessaging وPayment وEmail وAI من الواجهة لم يكتمل بعد، لذا لا تُستخدم Connections حقيقية أو تُعرض حالة نجاح مزيفة.
