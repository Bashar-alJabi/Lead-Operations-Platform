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

لعامل الرسائل شغّل `npm run worker:messaging` كعملية مستقلة بعد `npm run build` مع `DATABASE_URL` و`CREDENTIAL_ENCRYPTION_KEY` نفسيهما. يلتقط Jobs المعلقة ويعيد فحص السياسة قبل الاتصال بالمزوّد. `SENT` تعني قبول طلب الإرسال مع Provider Message ID ولا تثبت `DELIVERED`؛ `UNKNOWN` تعني أن نتيجة الطلب ملتبسة وتحتاج مراجعة ولا يعيد العامل إرسالها تلقائياً. إدارة Meta templates وإنشاء قالب نصي ثابت ومزامنة اعتماده وربطه بحملة، ثم إرساله عبر العامل، اجتازت الاختبارات بموفر وهمي. يجب اعتماد القالب من Meta وربطه بالحملة من الواجهة، ويعيد العامل فحص Approval وSnapshot قبل الإرسال. لاختبار اتصال من الواجهة: اكتشف الأرقام، أنشئ/زامن قالب BODY ثابتاً معتمداً، اختر Sender ورقم اختبار تتحكم به أو حصلت على موافقته، وأكد ذلك ثم أرسل اختباراً. تعرض الواجهة `SUCCEEDED/REJECTED/UNKNOWN` دون رقم المستلم الكامل؛ عند `UNKNOWN` افحص Meta قبل طلب جديد، إذ لا تحدث إعادة تلقائية. `CONNECTED` هنا يعني قبول مزود الاختبار للطلب من رقم محدد، مع بقاء `webhookVerified=false` وSender `DEGRADED`. اختبارات التطوير تستخدم fake provider وتوقيعات محلية وتثبت API/Worker paths فقط؛ لم تثبت Meta live أو التسليم الحقيقي؛ لا تعتبر المنصة جاهزة لتشغيل Messaging الحي اعتماداً على هذه الاختبارات وحدها.

في صفحة الاتصال انسخ Callback URL الظاهر إلى Meta App → Webhooks، وأدخل Verify Token الذي حُفظ عند إنشاء الاتصال، ثم اشترك في حقل `messages` لحساب WhatsApp Business Account. لا تعرض المنصة الرمز بعد حفظه؛ يمكن استبداله بتعديل الاتصال الذي يتطلب إعادة الاكتشاف والاختبار. نجاح GET handshake يظهر مستقلاً عن استقبال POST موقّع. عند وصول Status موقّعة تحفظ المنصة تاريخ `SENT/FAILED/DELIVERED/READ` وتمنع رجوع الحالة عند ترتيب وصول مختلف؛ Worker يعيد وصل callback وصل قبل حفظ Provider Message ID. افحص قائمة الأحداث التي تحتاج مراجعة عند Sender/Participant mismatch أو Message غير معروفة. Inbound messages تُحفظ أولاً كأحداث دائمة ثم يحل Worker النص منها إلى Conversation/Lead عند تطابق وحيد؛ تُعالج أنواع الوسائط المدعومة عبر Media worker مع فحص المحتوى، ويبقى الغموض للمراجعة، ولا تعتمد على الاختبار المحلي لتشغيل تكامل حي. التحقق الحالي من Webhook تم بتوقيع اختباري محلي، ولم يجر ربط Meta sandbox/live.

عند وصول inbound text موقعة يحاول عامل Messaging ربطها بمرجع الرد أو Conversation نشطة أو Lead وحيدة ذات Sender مضبوط؛ لا يرسل ردًا تلقائياً. تظهر الأحداث الملتبسة في **مراجعة الرسائل الواردة** على صفحة الاتصال للمسؤول الأعلى أو Manager اتصال فرعه، مع مرشحي Lead/Conversation المصرح بهم فقط. اختر الهدف بعد التحقق من العميل والحملة أو تجاهل الحدث مع سبب؛ يبقى السجل محفوظاً. إذا فتحت الرسالة محادثة بلا Agent فستنتظر متحكماً بشرياً؛ من صفحة Lead استخدم **تولّي المحادثة** مع سبب قبل محاولة الرد، وتبقى الموافقة ونافذة الإرسال والسياسة مطلوبة. المرفقات المدعومة تُلحق بالمحادثة مع metadata وحالة فحص؛ التحميل يتطلب READY. الأنواع غير المدعومة أو Payload الفاسدة تبقى للمراجعة. لم يجر UI E2E أو Meta sandbox/live؛ لا تعتبر هذا تحققاً من تكامل حي.

في الإنتاج، اجعل الواجهة والـAPI وراء HTTPS وreverse proxy على origin واحد أو اضبط `APP_ORIGIN` على origin الواجهة الحقيقي. Cookie الجلسة `Secure` في `NODE_ENV=production`. يجب أن يوجه proxy مسار `/api` و`/health` إلى الـAPI، وأن يقدّم ملفات `dist-web` بعد `npm run web:build`.

## تشغيل مرفقات Messaging الواردة

### workers المطلوبة الآن

بعد migrations `001`–`037` والبناء، شغّل `npm run worker:messaging` للإرسال و`npm run worker:events` لمعالجة inbound وDelivery callbacks، و`npm run worker:media` للملفات. كل عملية لها `DATABASE_URL` ومفتاح التشفير المناسبان للبيئة نفسها. `worker:messaging` لم تعد تحل inbound/callbacks؛ غياب `worker:events` يبقي الأحداث محفوظة ومعلقة، ولا يضيعها أو يجعل قبول Webhook دليلاً على نجاح معالجتها. لا تُشغل worker بأسرار Production في بيئة الاختبار.

Worker الأحداث لا تتصل بمزود خارجي. `MESSAGING_EVENT_BATCH_SIZE` الافتراضي 50 (1–500)، و`MESSAGING_EVENT_POLL_MS` الافتراضي 2000 (100–60000)؛ هذه إعدادات deployment تقنية، وBusiness connections لا تزال من UI. تعرض صفحة Webhook أعداد pending/failed/Needs Attention وآخر معالجة وأقدم حدث معلق، ويمكن تصفية الحالة وقراءة سجل المحاولات. عند فشل DB/domain processing تحفظ backoff وخمس محاولات مع rollback لأي أثر جزئي. بعد FAILED أصلح السبب ثم أعد المعالجة من UI بملاحظة وversion؛ Manager اتصال فرعه أو Super Admin فقط. لا تعدل payload أو counters يدوياً، ولا تستخدم Event retry لإعادة إرسال Customer message.

اختبار integration شغّل worker الأحداث المترجمة كعملية Node مستقلة أثناء Provider send وهمية معلقة، وثبت استمرار inbound/Delivery؛ لا يثبت UI E2E أو Meta live. راجع `messaging-performance.md` لقياس burst قبل فصل HTTP ingestion وبعده.

شغّل `docker compose --profile media up -d clamav`، ثم تحقق من `docker compose ps` وصحة الخدمة. خدمة ClamAV لا تعرض ملفات الجهاز ولا تتلقى paths، ومنفذها مقيد بـlocalhost؛ تحتاج نحو 4 GiB RAM وفق إعداد Compose. يحدّث FreshClam signatures تلقائياً؛ adapter يرفض definitions أقدم من سبعة أيام. إعداد `infra/clamd.conf` يرفض الملفات المشفرة وتجاوز حدود الفحص. لا تستخدم scanner وهمياً في عملية التطبيق أو العامل الحقيقية.

اضبط متغيرات infrastructure في بيئة API وMedia worker: `CLAMAV_HOST` و`CLAMAV_PORT` و`MEDIA_MAX_BYTES` و`MEDIA_STORAGE_BACKEND`. Local للتطوير يخزن الملفات في `.local/media` خارج web root. بعد `npm run build`، شغّل `npm run worker:media` إلى جانب `worker:messaging` و`worker:events`؛ Media worker مستقل ولا يحتاج Business credential إضافية خارج إعداد Messaging في الواجهة. يمكن تشغيل `node dist/scripts/check-media-scanner.js` ببيئة ClamAV نفسها؛ يجب أن يقبل PDF اختبارياً ويرفض توقيع الاختبار الآمن لمضاد الفيروسات دون حفظه على disk. تحقق ذلك محلياً على ClamAV 1.5.4، ولا يثبت اتصال Meta/S3 حياً.

للإنتاج اختر صراحة `MEDIA_STORAGE_BACKEND=s3` وbucket خاصاً عبر `MEDIA_S3_BUCKET` و`AWS_REGION`، وcredentials deployment صريحة `MEDIA_S3_ACCESS_KEY_ID` و`MEDIA_S3_SECRET_ACCESS_KEY` و`MEDIA_S3_SESSION_TOKEN` اختيارية؛ لا يقرأ adapter ملفات `~/.aws` أو AWS profiles الشخصية، أو إعدادات endpoint لمخزن S3-compatible. لا تعط bucket public access؛ API وحده يحمل ويراجع ACL. Local ممكن فقط باختيار صريح ومسار خاص مشترك بين API والعمال، ويحتاج نسخاً احتياطية متسقة؛ لا يصلح disk مؤقت داخل replicas مستقلة. إعداد مخزن الملفات والـscanner هو infrastructure deployment، بينما credentials المزود وأرقام Messaging تدار من UI. تغيير backend أو bucket بدون نقل objects القديمة سيجعل قراءتها `MEDIA_STORAGE_UNAVAILABLE`؛ لا تغير metadata في قاعدة البيانات لتجاوز ذلك.

الأنواع المدعومة حالياً للوارد هي JPEG/PNG وPDF وOGG/MP3/M4A وMP4 وWebP sticker. يظهر المرفق في المحادثة بحالة `QUEUED/RUNNING` مع تعليق العميل كنص؛ التحميل محجوب حتى `READY`. عند malware/type/hash/size rejection يبقى `REJECTED` بلا bypass. عند provider/scanner/storage failure تحدث حتى خمس محاولات وbackoff، ثم `FAILED`؛ بعد معالجة السبب يستطيع Super Admin أو Manager ضمن النطاق طلب دورة جديدة من UI بملاحظة وversion، دون تعديل Message أو حذف سجل المحاولات. Agent يحمل مرفقات Leads المملوكة له فقط. Media الملتبسة تبقى في مراجعة Connection، والربط الصريح ينقل الصلاحية إلى Lead؛ لا تُخمن الحملة. الإرسال الصادر متاح لـJPEG/PNG/PDF المفحوصة من Composer حسب Sender capability: اختر مرفقاً وارفعه للفحص ثم أرسل بتعليق اختياري. يخضع للـController وConsent/DNC والنافذة والسياسة؛ خارج نافذة Meta لا يرسل هذا المسار media freeform. Worker يرفع asset ثم يعيد فحص السياسة قبل customer dispatch؛ upload failure retryable، وUNKNOWN من send تحتاج مراجعة دون retry تلقائي. Audio/video/sticker وmedia templates الصادرة غير مدعومة حالياً.

تضمّن backup ملفات التخزين الخاصة مع PostgreSQL ونسخ object versions/lifecycle المناسبة. لا تحذف object مرتبطة بـ`READY` أو Message تاريخية؛ ملفات `.part-*` المحلية ليست قابلة للتحميل، وتُنظف بعد انقطاع كتابة عند التحقق من أنها غير نشطة وضمن Media root فقط. لم يجر اختبار restore للمرفقات أو S3 live، ويبقي Coverage ذلك واضحاً.

## استرداد فشل إرسال Message

في Lead Conversation اختر **تفاصيل الإرسال والمحاولات** بجوار outbound Message. تعرض الحالة ومعرف المزود وتوقيتاته وQueue error وعدد محاولات worker، وسجل dispatch وDelivery events والاسترداد مع pagination. فشل رفع media قبل customer dispatch قد يملك Queue attempt دون dispatch attempt؛ هذا ليس فقداً للتاريخ. الصفحات تعيد فحص Lead access؛ Agent السابق يفقدها بعد إعادة الإسناد.

عندما يظهر إجراء إعادة القائمة، أصلح سبب الخطأ ثم أدخل سبباً واضحاً وأكد إرسال المحتوى المحفوظ نفسه. يشترط المؤلف البشري الأصلي الذي بقي Controller وصلاحية Lead، وFAILED/DEAD مؤكدة قبل قبول المزود. الطلب يحفظ Audit وversion/history ويمنح خمس محاولات worker إضافية دون تصفير الأرقام، ثم يعيد فحص السياسة قبل الإرسال. إعادة الطلب بالنسخة القديمة تعرض conflict ولا ترسل نسخة أخرى. تغيير DNC/Controller/Template/Scope أو تعطيل Sender يمنع المسار ولا يختار رقماً بديلاً.

UNKNOWN أو PREPARED/accepted outcome لا تستخدم هذا الإجراء، وكذلك FAILED بعد قبول/Delivery callback. راجع المزود وNeeds Attention وفق الإجراء السابق؛ إزالة سبب المراجعة لا تسمح بإعادة Message مجهولة. لا تغيّر Message/Job states أو Provider ID يدوياً. إذا تولّى مستخدم آخر المحادثة، لا يغير author في سجل سابق؛ يبدأ Message جديدة بهويته الحالية من composer وفق السياسة. تحقق المسار بPostgreSQL وfakes، لا Meta live أو UI E2E.

## الاختبارات العامة والنسخ الاحتياطي

`npm test` يشغّل اختبارات الوحدة الحالية. `npm run typecheck` و`npm run web:typecheck` و`npm run web:build` تفحص البناء. لا تُعتبر هذه بديلاً عن integration/E2E/load tests الواردة في `06`.
`npm run test:integration` يستخدم Email adapter وهمياً، ولا يتصل بمزود بريد حقيقي. يتطلب تحقق SMTP sandbox/live حساباً أو Credential مخصصة ومصرحاً بها؛ حالياً الحالة `Live Verification Pending External Credential/Approval`. لا تشغّل worker ضد اتصال Production أثناء الاختبارات.

لاختبارات API: أنشئ قاعدة منفصلة `lead_operations_test` داخل حاوية المشروع (`docker compose exec -T postgres createdb -U lead_operations lead_operations_test` مرة واحدة). اضبط `DATABASE_URL` على هذه القاعدة وطبّق `npm run db:migrate`، ثم اضبط `TEST_DATABASE_URL` على الرابط نفسه وشغّل `npm run test:integration`. الاختبار يرفض أي اسم قاعدة غير `lead_operations_test` ويفرّغ بياناتها قبل كل تشغيل؛ لا توجهه إلى قاعدة التطوير أو الإنتاج. لا تعرض روابط الاتصال أو كلمات المرور في السجل. قاعدة التطوير نفسها تبقى منفصلة.

خطة الإنتاج هي نسخة PostgreSQL متسقة عبر `pg_dump`/managed snapshots مع نسخ ملفات object storage ذات الصلة، واحتفاظ محدد واختبار استعادة دوري في بيئة معزولة. يجب اختبار استعادة فعلية قبل اعتماد المنصة؛ لم يُجر هذا الاختبار بعد. migrations تُطبق قبل تفعيل نسخة التطبيق الجديدة، وبعد snapshot، ولا يُنفذ تعديل يدوي غير موثق لبيانات الإنتاج.

## الأسرار والتكاملات

### Browser E2E محلية

بعد migrations على `lead_operations_test` اضبط `TEST_DATABASE_URL` المحلية و`E2E_RESET_TEST_DATABASE=1` صراحة ثم شغّل `npm run test:e2e`. هذا يفرغ قاعدة الاختبار ويُنشئ fixtures؛ لا تشغله بالتوازي مع integration tests أو benchmark، ولا في production. تحتاج port4100 فارغة؛ harness ترفض reuse لخدمة موجودة. للاختبار على Windows استخدم `E2E_BROWSER_CHANNEL=msedge` (تحقق محلياً) أو `chrome` المثبتة، بcontext جديدة مؤقتة بلا حساب شخصي. في CI اترك channel غير مضبوطة وثبّت Browser الخاصة بـPlaywright عبر `npx playwright install chromium` في بيئة الاختبار المناسبة. لا تُحفظ cookies أو credential حقيقية أو profile مستخدم في الاختبارات.

المسار الحالي يثبت Human text/recovery/control/history/ACL وDNC/UNKNOWN وXSS وArabic mobile/RTL وFrench/English فقط. لقطات `.local/e2e/conversation-ar.png` و`mobile-fr.png`، وtrace/screenshot failures داخل `.local/e2e/results`، وfixture ذات password/token اختبارية عشوائية داخل `.local/e2e/fixture.json`؛ جميعها ignored ولا ترفعها إلى Git. harness تغلق API وDB والـBrowser بعد الاختبار، ولا تتطلب إيقاف Docker؛ استخدم entrypoint الإنتاج المعتادة للتطبيق، وليس `test-e2e/server`.

للتحقق المحلي من Messaging burst استخدم `npm run benchmark:messaging -- --reset-test-database` بعد ضبط `TEST_DATABASE_URL` المحلية وتطبيق migrations؛ يفرغ بيانات `lead_operations_test` ويرفض development/remote database. لا تشغله بالتوازي مع integration tests؛ التقرير في `.local/performance/messaging-latest.json`. إعدادات workload والقياسات والحدود موثقة في `messaging-performance.md`؛ المزود وهمي ولا تثبت النتائج Meta live أو سعة إنتاجية.

`CREDENTIAL_ENCRYPTION_KEY` سر deployment مستقل عن Business-managed credentials؛ لا يُنشر ولا يُرسل للـAI. تغيير المفتاح يحتاج عملية تدوير تعيد تشفير الأسرار؛ لم تُنفذ واجهة التدوير بعد. لا تضف Credential حقيقية إلى التطوير الحالي. إعداد مزودي Meta وMessaging وPayment وEmail وAI من الواجهة لم يكتمل بعد، لذا لا تُستخدم Connections حقيقية أو تُعرض حالة نجاح مزيفة.
