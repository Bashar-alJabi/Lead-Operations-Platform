# إشعارات استحقاق المتابعة داخل المنصة — Native165

## المصدر والسلوك

تستند `FOLLOW_UP_DUE` إلى مهمة `follow_up` فعلية بحالة `OPEN` وموعد بلغته ساعة PostgreSQL. لا يتحول الإشعار إلى رسالة للعميل أو إلى إكمال للمهمة. هذه المرحلة مستقلة عن AI follow-up وإرسال Email/Messaging، ولا تستعمل أي Provider أو credential.

تُحفظ `follow_up_notification_queue` داخل transaction إنشاء/تحديث المهمة. يوجد جدول تشغيل واحد لكل مهمة، وفهرس جزئي حسب `next_run_at,follow_up_id` لحالة `WAITING`. تستعمل قراءة المرشحين `statement_timestamp()` القابلة للاستخدام في index range؛ أما إثبات الاستحقاق النهائي فيستعمل `clock_timestamp()` تحت الأقفال. لا مسح لكل المستخدمين ولا fan-out ولا Node clock كإثبات استحقاق.

عند تطبيق165 تدخل المهام الحالية `OPEN` فقط إلى الجدول؛ لا تُنشأ أحداث لمهام مكتملة أو ملغاة قديمة، ولا يُعاد تأريخ الإشعار بتاريخ الموعد. قد ينتج إشعار لمهمة ما زالت مفتوحة ومتأخرة عند تشغيل worker، ووقته هو وقت الرصد الفعلي. تهيئة جداول المهام الموجودة وفحص قيود الإشعارات قد يتطلبان أقفالًا ومسحًا؛ قِس الوقت والحجم في staging وحدد نافذة migration مناسبة قبل نشر فعلي. لا migration مطبقة تُعدّل ولا volume تُحذف.

## المعالجة والسلامة

`processOneFollowUpNotification` تقرأ حتى25 مرشحًا، ثم تقفل Branch → Lead → Campaign → Follow-up → Queue وتعيد فحص الموعد والحالة الحالية. تستخدم `SKIP LOCKED` للمهمة والجدول، وحدود انتظار أقفال750ms وstatement5s داخل transaction فقط. لا external I/O داخلها. قد يؤخر انشغال parent دورة التشغيل حتى poll التالية؛ هذه ليست ضمانة زمن تسليم أو capacity إنتاجية.

`follow_up_due_observation` سجل immutable. Native guard تقرأ المهمة والـscope الحاليين، وتشتق موعد الرصد ونسخة المهمة ومالكها وموعدها الحقيقيين. لا يقبل العميل موعدًا مصطنعًا أو scope مزعومًا كإثبات. القيد `UNIQUE(follow_up_id,due_at)` يضمن تنبيهًا واحدًا لكل مهمة ولحظة موعد فعلية. ثم trigger تحفظ `notification_event` وAudit وتغيّر الجدول إلى `RECORDED` معًا. فشل أي جزء يلغي الرصد والإشعار والتغيير معًا.

- إكمال/إلغاء المهمة قبل الرصد يمنع الحدث ويغلق الجدول.
- إعادة الجدولة قبل الرصد تلغي أهلية الموعد القديم وتنتظر الموعد الحالي.
- تعديل note/priority/owner دون تغيير الموعد لا يعيد إرسال تنبيه سبق حفظه.
- موعد جديد يمكن أن ينتج حدثًا جديدًا عند استحقاقه. العودة إلى موعد سبق رصده تحتفظ بحدثه الأصلي ولا تعيده.
- بعد الرصد يبقى الحدث تاريخيًا. تعرض الواجهة الموعد المرصود والموعد والحالة الحاليين، وتفرّق بين «مستحق حاليًا» و«تنبيه سابق». `currentlyDue` مشتقة من DB، وليست تفسيرًا من AI.

## الصلاحيات والتفضيلات والصياغة

تُعاد current Organization/Branch/Campaign/Lead authorization وSession checks في Backend. Agent يجب أن يكون مالك Lead الحالي **ومالك المهمة الحالي معًا**؛ ملكية Lead وحدها لا تكفي لمهمة يملكها Manager. Manager يرى مهام فرعه، وSuper Admin يرى المؤسسة ضمن صلاحياته الحالية. إعادة إسناد/إلغاء إسناد Lead أو تغيير مالك المهمة يسحب الوصول السابق إلى feed وread state/history وnotification status؛ التاريخ محفوظ.

تستعمل الأحداث نفس Notification Center وunread indicator وCAS read state/history والتفضيلات الشخصية. يوجد نوع مستقل `FOLLOW_UP_DUE` للتفضيل وwording؛ كتمه لا يحذف الأحداث ولا يوقف worker أو ينفذ مهمة. Safe defaults في ar/en/fr، وتسلسل الصياغة لكل لغة Campaign → Branch → Organization → Default. Manager يدير نطاقه وSuper Admin يدير Global، وAgent لا يعدّل القوالب الإدارية. المتغيران المسموحان `{{campaign}}` و`{{owner}}` فقط؛ owner في هذا النوع هو مالك المهمة الحالي، والمحتوى plain escaped text. لا notes/أرقام/محتوى محادثة في الحدث أو queue failure metadata.

## التشغيل والفشل والاستعادة

بعد migrations والبناء شغّل `npm run worker:notifications` ببيئة development الموثقة أو كعملية worker مُدارة في البنية المعتمدة. لا يبدأ Preview أو أي Provider. الإعدادان التقنيان `NOTIFICATION_WORKER_BATCH` افتراضي25 وحدوده1–100، و`NOTIFICATION_WORKER_POLL_MS` افتراضي2000 وحدوده250–60000. لا تعني هذه القيم حد Business أو قياس capacity. يبدأ worker دورة واحدة ثم polling، ويغلق DB عند signal بعد انتهاء الدورة.

كل فشل محلي بعد قفل العمل يُحفظ بعد rollback للخطوة داخل savepoint، مع backoff1/2/4/8 ثوانٍ قبل المحاولات التالية. بعد خمس محاولات تصبح `DEAD_LETTER` بلا إعادة تلقائية. تعطل DB الذي يمنع حفظ الفشل نفسه يظهر كـstructured cycle failure وتبقى المعاملة غير ملتزمة؛ لا يمكن الادعاء بحفظ محاولة أثناء عدم إتاحة DB. لا secrets أو نص الاستثناء في حالة الفشل المعروضة للمستخدم.

من Lead → المتابعات → «حالة إشعار المتابعة» راجع الحالة وعدد الفشل والموعد التالي والسجل المحدود مع pagination. تظهر للإدارة إعادة محاولة فقط بعد `DEAD_LETTER`؛ Backend وnative guard يتطلبان Manager/Super Admin حاليًا داخل النطاق وSession صالحة وversion CAS، مع Audit وهوية المنفذ. إعادة المحاولة تعيد رصد المهمة الحالية فقط، ولا تعيد تنبيهًا سبق حفظه أو تُكمل المهمة. بعد إصلاح عطل البنية، استعمل هذه الواجهة؛ لا SQL repair أو تعديل مواعيد مصطنع. عند فشل القراءة/الكتابة تُمسح بيانات الحالة السابقة من المكوّن.

## الإثبات وحالة الإنجاز

Focused PostgreSQL3/3 وBrowser2/2 ناجحة: API وUI الفعليتان، ثماني معالجات/قراءات CAS/محاولات recovery متزامنة، future/complete/cancel/reschedule وcurrent task+Lead ownership، قوالب/تفضيلات مستقلة، immutability/forgery denials، Audit rollback وخمس failures واستعادة وبدء compiled worker، وactual parent-lock wait ثم تغيير الموعد. Browser تتحقق من ar/en/fr وRTL390px وplain text/no XSS وfailed-read clearing. regression رابع يحفظ PostgreSQL microseconds عند تعديل المهمة دون موعد جديد. البوابة النهائية ناجحة: **178unit و92/92full Docker PostgreSQL integration** (218.0s) و**56/56full Edge Browser** (3.0m)،migrations001–165development/test وBackend/Web build/typecheck/diff check. الصورة العربية390px فُحصت. لا ادعاء capacity إنتاجية من هذه الأزمنة.

هذه baseline لإشعارات استحقاق المهام فقط. Notifications الكاملة والمنصة غير مكتملتين: Payment/Enrollment وattention/Integration-System events والقنوات المفعلة/mandatory policies ما زالت مطلوبة، ثم Automation/Analytics/Import-Export/Google Sheets/Email وبقية فجوات المنصة. لا ادعاء Live Verification أو Production-ready للمنصة كلها.
