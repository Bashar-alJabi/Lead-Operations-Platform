# البريد التشغيلي

## النطاق والفصل

المراجع 00 §38 و01 §§40–41 و02 §64 و03 §§31/76–77/99 و06 §§19/21 تتطلب Email للإشعارات الداخلية عند تفعيله، مع إعداد من داخل المنصة وصلاحيات وPreferences وwording وقنوات مستقلة عن Customer Conversation. تنفذ Native196 دورة إدارة الاتصال اللازمة لذلك؛ وجود Connection لا يعني اكتمال الإشعارات أو إرسال بريد أو إثبات وصوله.

اتصالات `operational_email_connection` متعددة، على Organization أوBranch، ومستقلة عن `identity_email_connection` للدعوات واستعادة الحسابات. لا تستعير secret أوحالة اتصال بريد الحسابات. يدير Super Admin حسابات Organization؛ ويدير Manager حسابات فرعه فقط؛ ولا يرى Agent إعدادات الاتصال أو credentials. لا تصبح Organization connection متاحة للفروع ضمنيًا؛ تحدد Native197 أدناه ربط القناة الصريح.

البروتوكول الأول SMTP، ويمكن استعمال أكثر من حساب أو مزود SMTP. تفصل `OperationalEmailAdapters` عمليتي verify/send عن التطبيق وتعيد استخدام transport المشفرة الحالية. لا توجد provider calls داخل Business Domain أو اعتماد على حساب مطور. تحتاج إضافة protocol جديد إلى profile/adapter/validation واختبارات مناسبة، دون تغيير دلالات Notification.

## الإعداد من الواجهة

افتح «البريد التشغيلي». أنشئ حساب SMTP وcredential مخصصة لدى مزودك، ثم أدخل الاسم والنطاق وhost/port وusername وFrom address وكلمة المرور وسبب الإعداد. يحتفظ التطبيق بكلمة المرور مشفرة بـAES-GCM وAAD الخاصة بهوية Connection، ولا يعيدها في DTO/history/Audit أو الأخطاء. ترك password فارغة عند التعديل يحتفظ بها؛ وإدخال قيمة جديدة يدوّر credential. كل حفظ يزيد version ويعيد الحالة إلى NOT_CONFIGURED، ويلزم فحص مستقل. لا يفترض التطبيق أن domain أو From address موثقان.

ينفذ «فحص اتصال البريد» connectivity/TLS/authentication فقط؛ لا يرسل test mail أو بيانات عملاء، ولا يثبت قبول From address أو وصول رسائل إلى المستلم. يستخدم Direct TLS أو STARTTLS الإلزامي مع certificate verification وtimeouts؛ ولا يوجد إعداد لتجاوز الشهادة أو إرسال plaintext. [عقد SMTP الرسمي](https://nodemailer.com/smtp). لا تصل raw provider errors أو password إلى الواجهة. تعني CONNECTED نجاح فحص المصادقة في وقته، وليست delivery proof.

يمكن تعطيل الاتصال مع حفظ settings/revisions/probes/Audit، حتى إذا كان Branch غير نشط. لا يستطيع الفرع غير النشط تشغيله أو تعديله للعمل. تتطلب إعادة تهيئة اتصال معطل save جديدة ثم test؛ ولا يمكن فرض CONNECTED أو حذف التاريخ. هوية Branch/Organization/provider ثابتة؛ أنشئ Connection مستقلة للحساب أو النطاق المختلف.

## قاعدة البيانات والتزامن

تضيف Native196 immutable revisions وdurable probes وفحص Session/Role/scope/version الحالية داخل DB، مع deferred configuration/credential receipts وatomic Audit. لا تتبنى binding البريد الخاص بالحسابات أو حسابات قديمة من SQL. يستخدم update/disable آلية CAS؛ وتنجح config وsecret revision وAudit أو تتراجع معًا.

يُقفل Connection ثم Branch ثم الحساب وSession الحاليان، مع إعادة الفحص بعد انتظار القفل وقبل الكتابة. تُحفظ probe بحالة RUNNING **قبل** الاتصال الخارجي، وتوجد واحدة جارية فقط لكل Connection. حدها الزمني التقني 60s؛ ويسجل انتهاء الحد SUPERSEDED/EMAIL_PROBE_EXPIRED. بعد الاستجابة يعاد فحص Session/scope/config/version وexpiry؛ ولا تعتمد نتيجة متأخرة بعد rotation/disable/logout أو تغير الصلاحيات. لا يحمل الخطأ العام EMAIL_VERIFICATION_FAILED أي raw response. إعادة الفحص إجراء صريح من المستخدم ولا ترسل رسالة.

قائمة API بصفحات 25، وconfiguration history وprobe history بصفحات 20 مع keyset pagination. تخفي Branch/Organization غير المصرح بهما. الواجهة ar/en/fr وتدعم RTL، وتفرغ credentials بعد الحفظ والتفاصيل عند فشل القراءة، وتعرض empty/loading/error/history وحالة التحقق الحي بوضوح.

## إعداد قناة الإشعارات — Native197

من «الإشعارات» يمكن للمستخدم ضبط Email لكل نوع حدث ولغة إرسال ar/en/fr، على عنوان حسابه الحالي فقط. التفعيل الشخصي **معطل افتراضيًا**، ولا يغير Preferences الخاصة بـIN_APP. لا يقبل API عنوان مستلم بديلًا أو userId، ولا يدير Manager تفضيلات موظف آخر. تُحفظ لغة Email لعمليات الخلفية؛ أما IN_APP فتستمر باستخدام لغة الواجهة الحالية. لا تُضاف mandatory policies تجارية غير موثقة.

يدير Super Admin قناة كل Branch، وManager قناة فرعه. يجب اختيار operational Connection صراحةً؛ لا fallback ضمني إلى identity email أو Organization account. لا يُفعّل الربط إلا لفرع نشط واتصال اجتاز فحص المصادقة وحالته CONNECTED، مع فحص Session/scope/version الحالية داخل API وDB. يمكن تعطيل قناة فرع غير نشط مع حفظ سجلها.

لا يختار Manager إلا اتصال فرعه. يستطيع Super Admin ربط حساب Organization بفرع محدد؛ ويرى Manager هوية هذا الربط وحالته دون settings/credentials للحساب. يستطيع Manager تعطيله، لكنه يحتاج Super Admin لإنشائه أو إعادة تفعيله. يمكنه بدلًا منه ربط حساب فرعه المصرح به. يظل تعطيل Connection أو تغير health عائقًا مستقلًا للإرسال؛ وجود binding مفعلة لا يثبت صلاحية الاتصال الحالية أو وصول رسالة.

تستعمل صياغات Email نفس خدمات النص الآمن والصلاحيات وhistory، بهوية Channel مستقلة: Campaign النشطة ← Branch ← Organization ← default آمن **لنفس Event/Language**. تعطيل صياغة يستخدم fallback، ولا يمحو السجل. النص plain text، والمتغيران الوحيدان `{{campaign}}` و`{{owner}}`؛ وعنوان Email لا يقبل CR/LF. تعرض الواجهة Preview بقيم اصطناعية وdefaults، وتدعم pagination وFR/AR/RTL ومسح التفاصيل بعد failed reads. لا تُعرض HTML أو بيانات دفع حساسة أو credentials.

Native197 تضيف CAS وimmutable binding/preference histories وatomic Audit وcurrent real Session/Role/Branch checks. تبقى عقود IN_APP وسجلها وقيمها الافتراضية كما هي. لا تمنح هذه migration أو APIs صلاحية SMTP send، ولا تنشئ outbox أو ترسل رسائل عند حفظ الإعدادات. [التقدم](codex-progress.md) هو المرجع للبوابة الشاملة وحالة checkpoint.

## الحالة وما يلي

حالة التنفيذ وأعداد الاختبارات الفعلية في [التقدم](codex-progress.md) و[التغطية](requirement-coverage.md). تستخدم اختبارات هذه المرحلة بيانات اصطناعية وSMTP adapter mock، دون حسابات شخصية أو credentials حقيقية. **Live Verification Pending External Credential/Approval**؛ لا يثبت نجاح mocks اتصالًا حيًا أو TLS مع مزود حقيقي.

التالي بعد حفظ إعدادات Native197: durable current-recipient outbox/worker/history/failure/recovery. يلزم منع إرسال backlog تاريخية لمجرد تفعيل القناة، وفحص صلاحيات المستلم وعنوان حسابه وPreferences/binding/Connection الحالية قبل الإرسال. لا تُرسل Lead لمستلم فقد الوصول، أو secrets أو بيانات دفع حساسة. لا يعتبر SMTP ACK إثبات قراءة أو تسليم نهائي، ولا يجوز blind retry إذا كانت النتيجة UNKNOWN. تبقى Notifications/Email جزئية حتى اجتياز وظائف الإرسال الفعلية واختباراتها؛ ولا يُضاف توسع اختياري في بروتوكولات البريد قبلها.
