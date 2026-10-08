# Bank Transfer: حدود الثقة والتشغيل

## القرار — 2026-10-08

وفق تعليمات المستخدم و02 §§59–63 و03 §§32–38 و06 §14، Bank Transfer طريقة مستقلة، لا hosted checkout أو Bank API مفترضة. تستخدم managed Payment Connection/Branch Method الحالية، وطلب تحويل immutable يحتفظ بالمستفيد والحساب والعملة والمبلغ والمرجع وإصدار الإعداد. Payment وEnrollment منفصلتان؛ لا إغلاق تلقائي للـLead.

مصادر التحقق منفصلة وصريحة:

- `AUTHORIZED_MANUAL`: Manager الحالي ضمن فرعه أو Super Admin، بجلسة سارية، يطابق حركة SETTLED من سجلات البنك التي راجعها بنفسه مع الحساب الأصلي والمبلغ والعملة والمرجع، ويسجل transaction ID ووقت التسوية وسبب الاعتماد وإقرارًا صريحًا. لا اعتماد من Agent أو AI أو تصريح العميل أو صورة إيصال. الواجهة توضح مسؤولية التحقق من البنك؛ مصدر التأكيد يبقى يدويًا في التاريخ.
- `TRUSTED_FEED`: connector معتمد من الإدارة يقرأ المصدر المصرفي الموثوق ويرسل عقد settlement موقّعًا. ليس API لبنك معين، ولا ادعاء أن أي بنك يدعمه. تفعيل المصدر يتطلب مراجعة استقلال المصدر عن العميل، ووصفه وموافقة الإدارة وsecret مخصصة مشفّرة. لا يقبل المفتاح من العميل أو Agent. HMAC-SHA256 يشمل timestamp وraw body، بنافذة خمس دقائق وevent ID ثابت. worker مستقلة تطابق immutable request ثم تطبق نفس القاعدة المالية. LIVE يحتاج connector مصرفيًا موثوقًا وموافقة خارجية؛ الاختبار المحلي feed اصطناعية فقط.

لا customer claim أو upload endpoint يستطيع إنشاء trusted proof. المستفيد لا يتغير داخل account identity؛ تغيير الحساب يحتاج Connection جديدة. التعطيل يحفظ التاريخ، ولا يلغي تأكيدًا تاريخيًا. الطلبات الجديدة تتطلب account/method/branch/lead الحالية وavailability وcurrent session. الاعتماد اليدوي يعيد فحص النطاق والجلسة والحساب؛ accepted signed evidence تحفظ أصلها بعد rotation/disable دون إعادة كتابة التاريخ.

## عقد feed

POST إلى callback المعروضة في إعداد الحساب. Header `x-bank-signature` هو `t=<Unix seconds>,v1=<64 hex>`، وHMAC على `<t>.<raw JSON UTF-8>`. JSON صارمة: `eventId`, `transactionId`, `mode`, `accountIdentifier`, `reference`, `amount`, `currency`, `settledAt`, `status: SETTLED`. لا قبول authorization/pending/receipt images. لا تسوية مستقبلية؛ سماح دقيقة واحدة لاختلاف الساعات. event ID مع payload مختلفة تعارض، ونفس bank transaction لا يؤكد طلبين. money تمثل decimal strings exact وفق precision العملة، لا float.

قبول التوقيع يحفظ الحدث وjob ذرية، ولا يعني Payment Confirmed. unmatched/incorrect evidence تصبح Needs Attention مع السبب، ولا يتم التخمين أو تغيير المبلغ. transient DB failures تُعاد بمحاولات محدودة وlease recovery؛ history محفوظة. UI توفر inbox/history وretry مدققة حين تسمح الميزانية.

## ترتيب التنفيذ والتحقق

Account/Method setup → request/reference → native manual/feed proof boundary → shared Payment/Enrollment → Lead/review UI → integration/concurrency/failure/Browser regression. migrations087–089 تحفظ one-of financial request/proof وimmutable history/current authorization وdeferred proof→Payment→Enrollment داخل transaction واحدة. لا ledger أوrefund management أوpartial-payment accounting جديدة.

## تشغيل الواجهة

Manager/Super Admin: Payment setup → إعداد التحويل البنكي → اسم/فرع/TEST أو LIVE/مستفيد/معرّف حساب شامل routing عند الحاجة/بنك/تعليمات/عملات/سبب. الـaccount identity وmode والعملات immutable؛ يمكن تعديل الاسم والتعليمات أوالتعطيل وإعادة التفعيل بنسخة وسبب، وتظل الطلبات القديمة على تعليماتها الأصلية. أنشئ Branch Payment Method تربط هذه Connection، وحدد Agent/Campaign availability. Bank لا تظهر في hosted link composer.

Lead → التحويل البنكي → طريقة/مبلغ/عملة صريحة → طلب بمرجع فريد وتعليمات قابلة للنسخ. يظل الطلب بانتظار reconciliation دون Payment مؤكدة. Manager يفتح الاعتماد اليدوي، يسجل مرجع الحركة ووقت التسوية والسبب ويقر بمراجعة سجل البنك المستقل. لا إغلاق Lead أوكشف signing key للـAgent.

المصدر الآلي اختياري: من تاريخ الحساب ومصدره، أدخل وصف المراجعة والمفتاح المخصص وأقر باستقلال المصدر. تعرض الواجهة callback وLive Verification Pending External Credential/Approval. مصدر جديد يدوّر المفتاح ويعطل القديمة دون حذفها؛ التعطيل الصريح محفوظ. Inbox تعرض state/error/attempt count مع history، وretry مدققة فقط لحالة Needs Attention أقل من خمس attempts، ولا تعدّل evidence خاطئة.

Currency precision من Intl ISO currency representation، exact integer minor units، لا float أوconversion. الحركات الجزئية أوعملة/حساب/مرجع غير مطابق لا تؤكد الطلب. Transaction ID نفسها لا تستخدم لطلب آخر؛ reference مختلفة لا تُخمّن. Accepted event تُعالج تاريخيًا وفق مصدرها الأصلي بعد rotation؛ المصدر المعطل لا يقبل أحداثًا جديدة.
