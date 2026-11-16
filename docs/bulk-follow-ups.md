# المتابعات البشرية الجماعية

## العقد وحدود الشريحة

تنفيذ Create Follow-up المطلوب في 00 §51 و03 §96 يستخدم خدمة Human Follow-up نفسها التي يستخدمها الإنشاء الفردي. لا تُنشأ جلسة مستخدم للخلفية، ولا يُشغّل AI أو Messaging أو Payment/Enrollment. يظل إرسال المتابعات الآلية متطلبًا مستقلًا يمر عبر Central Messaging Policy.

يختار المستخدم حتى50 Lead، وموعدًا وأولوية وملاحظة اختيارية ومسؤولًا اختياريًا، ثم يرى عدد الفرص المؤهلة ويؤكد الإنشاء. الموعد المدخل حسب timezone المتصفح يتحول إلى instant واحدة لكل الفرص؛ تظهر المنطقة صراحة. يسمح العقد بالموعد الماضي كما في الإنشاء الفردي، فتتولى خدمة إشعارات الاستحقاق الموجودة معالجته. كل نتيجة مستقلة ولا يُلغى نجاح عنصر بسبب فشل عنصر آخر.

المسؤول الافتراضي للـAgent هو نفسه. للمدير يكون assigned Agent الحالية، وإلا المدير المنفذ. يمكن للمدير أوSuper Admin تحديد مستخدم نشط بدور Manager/Agent من فرع الفرصة. لا يُخترع مسؤول تلقائي للـSuper Admin عند فرصة غير مسندة؛ يلزمه اختيار مستخدم مؤهل. Agent لا يفوض المهمة إلى مستخدم آخر. خيارات الإدارة paged بحد25، مع حفظ اسم وقيمة الاختيار عند تغيير الصفحة؛ صلاحية الإنشاء تُفحص في Backend مهما عرضته القائمة.

## API والكتابة الموثوقة

- `POST /api/leads/bulk/followups/preview`: ids مميزة حتى50، ومسؤول صريح اختياري. استعلام bounded يعيد Lead version والمسؤول المحسوم لكل عنصر مؤهل. unknown/hidden/foreign أوالمسؤول غيرالمتاح تشترك في `LEAD_OR_OWNER_NOT_AVAILABLE` دون كشف الوجود أوبيانات المستخدم.
- `POST /api/leads/bulk/followups`: requestId UUID وconfirmed=true وdueAt وpriority/note وowner الاختيارية وitems تحوي Lead version والمسؤول من preview. يفحص Backend Organization/Role/Branch/Lead وreal Session والمسؤول الحالي قبل الكتابة أوreceipt replay. Lead version أوتغير المسؤول الافتراضي يمنعان إنشاء مهمة بناءً على preview قديمة.
- Single endpoint يبقى201 `{id}` ويستخدم `createHumanFollowUp` نفسها، مع إعادة فحص Session بعد Lead lock. الخدمة تحمي أهلية المسؤول بـrow SHARE lock وتكتب المهمة وCREATED history وLead Activity وAudit في transaction واحدة. يحفظ CREATED الموعد والأولوية والملاحظة الأصلية، والتعديلات اللاحقة تبقى أحداثًا مستقلة.

Native172 تضيف immutable Human batch وper-Lead receipt تربط المهمة ونسخة Lead والمسؤول وSession وCREATED history. native proof تشترط مهمة HUMAN/OPEN/version1 منشأة في transaction الحالية، ونطاقًا ومسؤولًا صالحين، وسجل إنشاء وordinary/bulk Audit وActivity حديثة متطابقة. receipt وenvelope وسجل الإنشاء المرتبط لا تُعدّل أوتُحذف. لا تجمد receipt المهمة نفسها: الإكمال والإلغاء والتحرير وإعادة الإسناد المعتادة تبقى مسموحة وفق صلاحياتها وتاريخها. إعادة الطلب تعيد رقم المهمة الأصلية ولا تحيي مهمة ألغيت أوأُكملت.

أُعيد استخدام native envelope guard العامة بإعادة تسمية function عبرOID؛ trigger الخاصة بـNative170 تظل مرتبطة بالدالة نفسها. لم تُعدّل migrations170–171 المطبقة. استُخرج canonical hash/current Session/Lead scope/time budget/failure classification إلى `bulk-actions.ts` دون تغيير hash القديمة للحقول أوآثارها.

## الاستعادة والحدود التشغيلية

المفتاح unique لكل actor داخل نوع العملية. hash تربط الموعد ومحتوى المهمة والمسؤول واختيار الفرص ونسخها؛ يُطبّع note/default priority كما في الإنشاء الفردي. تغيير intent تحت المفتاح نفسه يرد409. إعادة الطلب تحتاج صلاحية حالية؛receipt ليست إذن وصول. الفشل قبل حفظ عنصر يرجع مهمته وتاريخها وdue queue وAudit معًا، بينما تبقى receipts العناصر الملتزمة.

كل عنصر transaction قصيرة: statement timeout8s وlock timeout750ms. default request budget15s قابل للإعداد عبر `BULK_FOLLOW_UP_REQUEST_BUDGET_MS` ضمن100..30000ms. يُفحص budget بين العناصر؛لا يعني deadline صارمة تقطع transaction جارية. العناصر المتبقية تعرض `BULK_REQUEST_PAUSED`،والـlock/serialization/timeouts تعرض `BULK_ITEM_RETRYABLE`. الاستعادة بنفس المفتاح والجسم، لا بإنشاء UUID جديدة. unknown failure ترد500 آمنة؛receipts تسمح بإكمال بقية الطلب بعد إصلاح السبب.

الواجهة تحفظ الطلب الأصلي وزر retry عند lost ACK أوfailure/retryable،حتى تغيير لغة ar/en/fr. يتطلب refresh الصفحة أوتغيير التحديد مراجعة النتائج الحالية قبل إنشاء intent جديدة؛لا تدعي الواجهة استعادة request من جهاز آخر. تغيير بيانات العملية يلغي retry القديمة صراحة. فشل قراءة صلاحيات/المسؤولين يمسح الخيارات والنتائج السابقة. سجل المهمة paged25 في Lead UI،ويُمسح عند failed read. كل النصوص تُعرض كنص React دون HTML.

## الإثبات المطلوب

اختبارات unit تربط hash بالموعد والأولوية والمسؤول والنسخ وتثبت قواعد defaults. اختبارات Docker PostgreSQL تتناول8 concurrent retries،Lead/Branch/Organization/Agent/owner/session negatives،CAS،Audit rollback/resume،native forgery/immutability،إكمال/إلغاء/تحرير ثمretry،request budget،50 مهمة فعلية وإشعارات استحقاقها الحالية دون تكرار أوcustomer send.

Browser يختبر typed due/priority/note وtimezone ورفض confirmation،lost ACK بعد commit وretry بعد إكمال مهمة،current ownership loss/partial result،explicit Manager owner،paged metadata،سجل المهمة ومسح النتائج بعد failed reads،ar/en/fr وArabic390px وsafe hostile text. أعداد البوابة النهائية وحالتها في progress/coverage؛الاختبارات المحلية ليست sustained capacity guarantee. لا Provider خارجي لهذه الشريحة،وLive Providers/AI تبقى غيرمفعلة.
