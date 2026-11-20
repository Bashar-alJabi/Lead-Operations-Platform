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

## تجهيز جمهور الأحداث — Native198

ينشئ نشر Notification Event جديدة publication واحدة إذا كانت قناة فرعها مفعلة وقت النشر. لا backfill للأحداث السابقة، ولا مسحًا متكررًا للتاريخ. تحفظ publication وقت النشر من ساعة DB وإصداري binding وConnection؛ لا تستخدم timestamp من العميل أو session قديمة بوصفها صلاحية تشغيل. يحفظ التفضيل الشخصي enabled_since، وتبدأ هذه الساعة من جديد بعد التعطيل وإعادة التفعيل. تغيير اللغة وحده لا يعيد الساعة ولا يرسل التاريخ. الإعدادات القائمة عند ترقية198 تبدأ من وقت الترقية دون تغيير opt-in التجارية.

يعالج worker صفحات من25مرشحًا بحد أقصى، عبر keyset حسب userId وSKIP LOCKED وبحث محدود عن20publication جاهزة. يقتصر الجمهور على الحسابات الحالية النشطة داخل Organization/Branch، مع opt-in سابقة للنشر، ثم يعاد فحص notification_access الحالية، بما فيها Lead owner وFollow-up owner. يملك Super Admin مجال مؤسسته فقط؛ لا يمنح الاشتراك في Email وصولًا إلى Lead أخرى. استدعاء الخلفية لا يحتاج استمرار جلسة المستلم، لكنه يعيد فحص حسابه وصلاحياته الفعلية.

تشتق native triggers هوية publication وصلاحية المستلم ونسخة التفضيل واللغة. لكل event/recipient إيصال واحد غير قابل للتعديل، مربوط بصفحة immutable وبـdeferred proof. يشتق كل page cursor/count/state من الجمهور الفعلي، وتتحرك publication فقط بإيصال صفحة جديدة في transaction نفسها مع Audit؛ فشل أي جزء يلغي الصفحة وإيصالاتها معًا. يلغي تغير binding/Connection version أو تعطيل الربط/الفرع عملية التجهيز القديمة إلى SUPPRESSED دون fallback أو إعادة نشر. تغير health وحده لا يمنح صلاحية إرسال؛ سيعاد فحص الجاهزية في dispatch.

قائمة البريد في «الإشعارات» شخصية، بصفحات20، ولا تعرض عنوان مستلم آخر أو نص محادثة أو credentials. يعيد Backend فحص Session وLead access بعد أقفال القراءة، وتختفي العناصر بعد فقد الوصول. الواجهة ar/en/fr وتمسح التفاصيل عند فشل القراءة. حالة WAITING تعني التجهيز فقط؛ لا تعني قبول SMTP أو وصول البريد. لا تخزن198 subject/body أو عنوان البريد في outbox، ولا تمنح صلاحية SMTP send. تبقى هذه مرحلة قبل dispatch وليست Email baseline كاملة؛ الأعداد المثبتة وحالة التحقق في progress/coverage.

حالة التنفيذ وأعداد الاختبارات الفعلية في [التقدم](codex-progress.md) و[التغطية](requirement-coverage.md). تستخدم اختبارات هذه المرحلة بيانات اصطناعية وSMTP adapter mock، دون حسابات شخصية أو credentials حقيقية. **Live Verification Pending External Credential/Approval**؛ لا يثبت نجاح mocks اتصالًا حيًا أو TLS مع مزود حقيقي.

## التسليم والتعافي — migration 199

ينشئ النظام مهمة تسليم واحدة لكل outbox receipt. يستعيد العامل عنوان الحساب الفعلي والتفضيل واللغة والربط وإصدار الاتصال والصياغة السارية عند تجهيز الإرسال. تُختار الصياغة من Campaign ثم Branch ثم Organization ثم النص الافتراضي للحدث واللغة. يستخدم SMTP عنوانًا مفردًا ونصًا عاديًا من القالب المعتمد. تقتصر متغيرات النص على اسم الحملة والمالك. يسجل العامل الإصدارات فحسب ويحتفظ بالعنوان والنص وبيانات الاعتماد في الذاكرة طوال المحاولة. [عقد SMTP envelope](https://nodemailer.com/smtp/envelope)

تُحفظ محاولة واحدة مع lease قبل I/O. يفحص العامل من جديد عنوان الحساب وإصدار التفضيل والصياغة وصلاحية Lead والاتصال قبل استدعاء المزود. تستعمل المعاملات أقفالًا قصيرة وتحررها قبل الشبكة. يتعامل التحقق مع أي تعديل اكتمل قبل آخر فحص بوصفه تغيّرًا في سياق الإرسال. تحدد حالة ACCEPTED قبول خادم SMTP، ويشير UNKNOWN إلى محاولة لم يتوفر لها إقرار صالح ضمن المهلة. تبقى النتيجة المجهولة محفوظة، وتعرض الواجهة الرجوع إلى المزود للتحقق منها. يمكن متابعة كل انتقال من السجل الشخصي، وفق صلاحية Lead الحالية.

يتراجع تجهيز الصفحة بالكامل عند الفشل، ويسجل العامل عدادًا دائمًا وتأخيرًا متزايدًا. تتوقف الصفحة بعد المحاولة الخامسة ويستطيع Super Admin أو Manager المخوّل في الفرع طلب إعادة تجهيزها من واجهة الإشعارات. تطبق مهام البريد حدودًا مماثلة على فشل التحضير قبل وجود SMTP attempt. يستعيد المستلم المخوّل عمله غير المرسل من قائمته بعد إصلاح السبب. لكل تعافٍ Session حالية ونسخة متوقعة وسجل Audit، وتستعمل المحاولات دائمًا السياق الحالي.

قدرة التشغيل الحي مغلقة افتراضيًا. الاختبارات تستخدم بيانات اصطناعية وSMTP mock. حالة المزود **Live Verification Pending External Credential/Approval**. [التقدم والبوابات](codex-progress.md)

## الرسائل الواردة وأعطال التشغيل — migration 201

تصدر `INBOUND_REVIEW_REQUIRED` عند وصول رسالة موقّعة إلى نتيجة مراجعة بعد المعالجة الأولية. يغلق حلها أو تجاهلها الحاجة للمراجعة، ويبقى الحدث في السجل. تصدر `INTEGRATION_ALERT` عند دخول الاتصال حالة ERROR أو WARNING أو DISCONNECTED أو AUTH_EXPIRED. تحدد آخر نقلة موثوقة ما إذا كان التنبيه قائمًا. يصدر `SYSTEM_ALERT` لهذا الإصدار من الانتقال الفعلي لطابور تنبيه Lead إلى DEAD_LETTER، ويعود إلى السجل عند استئناف ذلك العمل. تلتقط migration الحالات الراهنة الموجودة وقت الترقية من المصادر الموثوقة نفسها.

ينشر العامل الأحداث من طابور محدود. يحفظ المصدر مرة واحدة لكل وقوع، ويوقف النشر بعد خمس حالات فشل، مع استئناف مقيد بالجلسة والنطاق ونسخة العمل وAudit. يمكن الوصول من التنبيه إلى مراجعة الرسالة الأصلية أو مساحة نوع الاتصال أو قائمة إخفاقات تجهيز تنبيهات Lead. تعرض البطاقة نوع الحالة واسم الاتصال المسموح. يُقرأ نص الرسالة فقط باستدعاء مسار مراجعة الرسائل المخوّل.

يرى Super Admin تنبيهات منظمته ويرى Manager تنبيهات فرعه. تطبق القنوات صلاحية المصدر الحالية. تستخدم صياغة هذه الأحداث النص العادي على مستوى Branch أو Organization واللغة المحددة، وتخلو من متغيرات Lead أو Campaign. تعمل قناة Email لهذه الأحداث في الفرع عند تفعيل الربط والاشتراك. تعرض قناة In-App التنبيه على مستوى المنظمة لاتصال بلا فرع.
