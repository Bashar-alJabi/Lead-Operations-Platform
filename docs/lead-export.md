# تصدير Leads إلى CSV

## العقد والاعتماديات

تنفذ الشريحة 00 §53 و02 §§68–71 و03 §98 و06 §18. تستخدم نفس `prepareLeadFilter` و`leadPredicate` المستخدمتين في قائمة Leads وAnalytics، وتشمل البحث والفلاتر المالية والمحادثات والمتابعة والحقل المرئي. عند تطبيق Saved View تُنسخ فلاترها وأعمدتها إلى intent مستقلة؛المشهد ليس مصدر صلاحية. الاختيار المحدد حتى50 Lead يتقاطع مع الفلاتر والصلاحيات،ولا يُفترض أن معرفًا أرسله العميل يمنحه حق قراءته.

الواجهة تعرض preview حتى1000 نتيجة مع إشارة عند وجود المزيد،ثم confirmation صريحة. الأعمدة الافتراضية هي أعمدة الجدول الحالية؛يمكن اختيار الأعمدة الأساسية وحقول Campaign النشطة المرئية،بما فيها read-only وCalculated. اختيار حقل للتصدير يعتمد على read visibility،وليس edit permission. تحتاج الحقول إلى فلتر Campaign محددة،والاختيارات paged25 مع حفظ المحدد بينها. صلاحية فلترة حقل يظهر فيFilter UI فقط تبقى صالحة عند تصدير أعمدة أخرى؛ليست إذنًا لتصدير قيمة الحقل إن لم يكن معروضًا أوكان محجوبًا. metadata والتنفيذ يشتركان فيpermission predicate واحدة.

لا تُصدر Credentials أوConnection settings أوPayment secrets أوKnowledge drafts؛مسار البيانات whitelist صريحة.

## المعالجة الخلفية والملف الخاص

`POST /api/lead-exports` يسجل موافقة Human حقيقية وSession وRole/Branch/Organization وhash للمعايير والأعمدة والمعرفات. requestId فريدة لكل actor؛إعادة نفس الطلب تعيد job الأصلية بعد فحص الوصول الحالي،وتغيير intent بالمفتاح نفسه يرد409. طلبات التصدير شخصية؛معرفة UUID أوامتلاك Role أوسع لا يتيح تنزيل طلب مستخدم آخر. يمكن لكل مستخدم إنشاء طلبه ضمن نطاقه الحالي.

الـworker يلتقط membership على دفعات100 معرف باستخدام keyset دقيق بالـLead created_at وUUID،قبل cutoff من ساعة DB عند إنشاء الطلب. تُقيّم الفلاتر أثناء المعالجة،وليست membership snapshot محاسبية عند وقت الضغط على الزر. لا تُلتقط Leads أُنشئت بعد cutoff. كل صفحة transaction مستقلة بـ8s statement و750ms lock timeout و`SKIP LOCKED` بين workers. لا external I/O ولاSession بشرية مصطنعة؛انتهاء Session الموافقة لا يلغي job المعتمدة،لكن تعطيل الحساب أوتغير Role/Branch يمنع المعالجة،والتنزيل يحتاج Session فعلية حالية دائمًا.

الـartifact الدائمة هي manifest خاصة داخل PostgreSQL،ولا تتضمن قيم CSV. عند التنزيل تُولد CSV من القيم الحالية وتُرسل بـstream وbackpressure. تُراجع صلاحية كل membership قبل بدء التنزيل؛تغير نطاق أي عنصر يمنع الملف كله. تُعاد مراجعة Session وRole/Branch والـLead ونسخ الحقول الحالية لكل صفحة بيانات،ولا يُستبدل العنصر المحجوب بعنصر آخر. تغيير إعدادات الحقل أثناء القراءة يوقف Stream. البيانات التي سُلمت حين كانت مخولة لا يمكن سحبها من جهاز المستخدم. لا public object URL أوملف ثابت قديم يمكن أن يتجاوز revocation.

القيم الأساسية تُقرأ باستعلام bounded،وتُحسب Calculated Fields بقراءة batch مشتركة مع Lead details،دون network N+1 أوتقدير LLM. القيم المالية/المركبة المخزنة في Dynamic Fields تستخدم JSON text الأصلية لتجنب تقريب أرقامها عبرJavaScript. timestamps/cursors تحافظ على microseconds. رؤوس الأعمدة الأساسية ثابتة بالإنجليزية،وحقول Campaign تستعمل label وkey؛المحتوى UTF-8 معBOM وRFC4180 quotes/CRLF.

## الحماية والسجل والاستعادة

Native173 تحمي envelope ومعاييرها،وموافقة مرتبطة بـfresh Audit وSession. كل membership تحمل page version ويجب أن تطابق Lead الحالية وcutoff والنطاق،وتكتمل مع history وprogress/Audit في transaction نفسها عبر deferred proof. Native174 تصححNULL semantics فيدالةLead scope: تعيدfalse صريحةعندunassignment أوعدمتحققالنطاق،حتىلا يتجاوزNOT EXISTS الفحصالمسبق. إثبات403 قبلCSV ورفضnative membership غيرالمخولة قائم،دونتعديل173 المطبقة.

فهرس page_version يجعل إثبات زيادة العدد مقصورًا على الصفحة الجديدة؛لا يُعاد عد manifest كاملة عند كل صفحة. التاريخ وmembership لا يعاد تحريرهما؛الإلغاء وTTL فقط يزيلان membership مع إبقاء metadata/history/Audit.

تعاد failures بحد5 مع delays1/2/4/8s قبلDead Letter،والخطأ المعروض generic. فشل الصفحة يرجع membership وcursor وcount وhistory لتلك الصفحة،ولا يمحو الصفحات الملتزمة. recovery تحتاج current real Session وCAS وfresh Human Audit؛تكمل من cursor نفسها. لا يؤدي retry أوworker crash إلى مضاعفة membership. إلغاء الطلب لا يعدّل Leads أوFields أوConversations أوPayments/Enrollment.

التنزيل الخاص: `GET /api/lead-exports/:id/download`. يطبق `no-store` وattachment filename مولدة منUUID و`nosniff`. لا يوجد upload في هذا المسار؛الملف نص يولده التطبيق ولا يحتوي macros. تعالج `csvCell` الاقتباسات والفواصل والأسطر،وتضيفTAB داخل الخلية المقتبسة عند بادئات formula/control الخطرة،بما فيها whitespace وbidi وNFKC variants والـapostrophe السابقة للصيغة. هذا اختيار للتعامل مع CSV في برامج الجداول؛البادئة جزء من البيانات عند قراءتها برمجيًا،وليست encoding مضمونة لكل إعادة معالجة أوكل spreadsheet. سبب الاختيار وحدوده موضحان في [OWASP CSV Injection](https://community.owasp.org/attacks/CSV_Injection). لا تُزال الحماية ثم يُدّعى بقاء الملف محميًا.

GET الطلب وhistory يراجعان الصلاحيات الحالية؛التاريخ paged25. قائمة الطلبات لا تعيد counts أوقيم الحقول غيرالمراجعة. failed reads تمسح التفاصيل القديمة في الواجهة. يمكن حذف membership من قائمة طلبات المستخدم حتى إن فقد صلاحية قراءة محتواها،مع بقاء current account/context وSession؛هذا لا يمنحه حق قراءة البيانات. التغيير في Role/Branch يتطلب intent جديدة أوعودة سياق الموافقة الأصلي.

## حدود تقنية قابلة للقياس

- `EXPORT_MAX_ROWS`: افتراضي100000،ضمن100..1000000. تجاوز الحد يوقف job دون تقديم ملف جزئي؛يمكن recovery بعد إعداد capacity مناسب. ليست قيمة Business أوضمان throughput.
- `EXPORT_DOWNLOAD_PAGE_SIZE`: افتراضي25،ضمن1..100،لحصر ذاكرة القراءة. capture ثابتة100 معرف. الأعمدة الأساسية حتى12 وحقول Campaign حتى24،وmetadata/history paged25. تعديل هذه الحدود يحتاج مراجعة الذاكرة وAPI/native constraints واختبارات الحجم.
- `EXPORT_RETENTION_SECONDS`: افتراضي86400،ضمن1..604800. تمنع API التنزيل بعد الانتهاء حتى قبل دورة التنظيف؛worker تحولها EXPIRED وتزيل membership. التاريخ ومعايير الطلب الخاصة ليست ملف CSV وتبقى ضمن سياسة Audit/retention العامة للمنصة.
- `EXPORT_WORKER_BATCH`: افتراضي10،1..100؛`EXPORT_WORKER_POLL_MS`: افتراضي2000،250..60000. worker منفصلة وقابلة للتوسع؛لا transaction طوال الملف ولاتحميل dataset كلها إلىذاكرة التطبيق.

الواجهة ar/en/fr وRTL،وتفصل creation retry بعدlost ACK عنprocessing recovery بعدDead Letter. حالة التنفيذ الفعلية وأعداد unit/PostgreSQL/Browser فيprogress وcoverage. اختبارات محلية أكبر ليست sustained load guarantee؛الـload/restore/acceptance الشاملة للمنصة مازالت متطلبات مستقلة. لا اتصال خارجي أوتفعيل Integration حية لهذه الشريحة.
