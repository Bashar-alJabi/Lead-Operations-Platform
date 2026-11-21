# الأتمتة: القواعد المعتمدة والإجراءات الداخلية

## نطاق الشريحة الحالية

يدعم مسار `Trigger → Conditions → Action` إنشاء Follow-up للمالك الحالي المؤهل أو إرسال إشعار للمخولين بالفرصة. تأتي أحداث `LEAD_CREATED` و`LEAD_ASSIGNED` و`LEAD_REASSIGNED` من سجل التشغيل. تعتمد migration 207 كذلك حدثي `PAYMENT_CONFIRMED` و`ENROLLMENT_CONFIRMED` مستقلين، ولكل منهما سجل Notification Event مُشتق من مصدره الموثوق.

كل قاعدة ضمن Organization، مع Branch اختياري و Campaign اختياري داخل ذلك الفرع. Super Admin يدير المستويات الثلاثة، و Manager يدير فرعه وحملاته فقط. Agent لا يدير القواعد أو سجل معالجتها؛يرى المهمة/الإشعار الناتج فقط إذا بقي مخولًا بالفرصة. لا Roles جديدة.

تبقى بقية triggers الواردة في 01 §47، وشروط Dynamic Fields وConversation وAI والحقائق المالية والتواريخ، وإجراءات Change Field وAssign Lead وTags وStatus وHuman attention وapproved AI workflows مدرجة في [مراجعة الفجوات](platform-gap-review.md).

## الموافقة والنسخ

يحفظ `automation_rule` إعدادًا typed ونسخة CAS، و`automation_rule_version` تاريخًا immutable. تتطلب الكتابة Session حقيقية سارية وحسابًا نشطًا ودورًا ونطاقًا حاليين، وتُشتق أوقات الموافقة و`approval_xid` من PostgreSQL، مع Audit. النطاق وهوية القاعدة ثابتان؛التعطيل يحتفظ بالتاريخ. المحرر يبدأ غير مفعّل، والتفعيل قرار صريح عند الحفظ.

اعتماد قاعدة دائمة لا يعني استعارة Session المعتمد في الخلفية. انتهاء جلسة الحفظ أو Logout لا يلغي كل القواعد التي اعتمدها المستخدم؛كل إجراء يعيد فحص نشاط الحساب ودوره ونطاقه الحالي. تعطيل الحساب أو فقد النطاق يمنع الإجراء، وتعديل/تعطيل القاعدة يمنع التنفيذ المعلق من استعمال النسخة القديمة. يلزم اعتماد نسخة جديدة لإعدادات جديدة، ولا تُعاد الأحداث القديمة تلقائيًا.

## مصدر دائم ومطابقة محدودة

يلتقط Native observer المصدر الحقيقي داخل معاملته، دون backfill أو HTTP payload بديل. يحفظ IDs ونوع الحدث ووقت الالتقاط و`pg_snapshot` داخليًا؛لا بيانات اتصال العميل أو نصوص المحادثة. لكل مصدر queue دائمة و cursor مستقل، ولذلك لا يُفقد حدث تأخر commit الخاص به لأن worker تجاوز timestamp أو sequence له في scan سابق.

تختار المطابقة آخر نسخة للقاعدة كانت موافقتها committed وظاهرة في snapshot التقاط المصدر عبر `pg_visible_in_snapshot(approval_xid, visibility_snapshot)`. موافقة مستقبلية أو بدأت سابقًا ولم تُحفظ بعد لا تُطبق بأثر رجعي. أحدث نسخة ظاهرة يجب أن تكون مفعلة ويطابق Trigger ونطاقها المصدر. لا تعتمد النتيجة على وقت وصول worker. هذه metadata داخلية ولا تظهر في API/UI.

كل انتقال MATCH يعالج حتى 50 قاعدة بترتيب UUID ثابت، ثم يحفظ cursor مع executions في المعاملة نفسها. `UNIQUE(source_id, rule_id, rule_version)` يمنع التكرار. `FOR UPDATE SKIP LOCKED` يسمح بعدة workers؛لا fan-out لكل المستخدمين ولا تنفيذ إجراءات داخل معاملة إنشاء Lead.

## التنفيذ والصلاحية وقت الإجراء

يقفل الـworker بالترتيب Branch → Lead → Campaign → Users → Rule → Execution، ثم يعيد فحص النسخة والتفعيل و current scope ونشاط الفرع والحملة وصلاحية المعتمد والشروط الحالية. الشروط الحالية: lifecycle اختياري ووجود/غياب المالك. تغيير نطاق Lead ينتج `SCOPE_CHANGED` دون إجراء، ولا يكشف سجل المصدر عبر URL بعد خروجه عن نطاق المورد الحالي.

`CREATE_FOLLOW_UP` تتطلب Lead مفتوحة و Assigned Agent حاليًا نشطًا في نفس الفرع والمؤسسة. لا تُخترع وجهة بديلة عند عدم وجوده؛تُسجل `NO_ELIGIBLE_OWNER`. الموعد ثابت من وقت التقاط الحدث + التأخير المعتمد، لذلك قد يصبح مستحقًا إذا تأخر worker. `delay_minutes` حد تقني 0–525600، والنص حتى 4000 حرف، والـpriority typed. المهمة تحمل `kind=AUTOMATION` و FK unique إلى Execution و`created_by=NULL`، مع تاريخ وأثر و Audit لهوية القاعدة ونسختها؛لا تُنسب كعمل بشري.

`SEND_IN_APP_NOTIFICATION` تسجل `AUTOMATION_NOTICE` مستقلة بمرجع Execution، ولا تنتحل Lead Created أو Handoff أوتأكيد دفع. تعرض اسم القاعدة والنص المعتمد من النسخة التاريخية للمخولين بالفرصة فقط، كنص escaped، مع نفس current Lead ACL و self preference و wording/read history. النص مخصص للإشعار الداخلي ولا ينبغي أن يحتوي أسرارًا.

الحد التطبيقي المعتمد هو `processOneAutomationExecution` ثم انتقال native `EXECUTE` وإجراء `apply_automation_action` ذي النوعين المحددين. لا يمتلك config لغة تنفيذ أووصول DB/Provider عامًا. Native guards تتحقق من المصدر والنسخة والموافقة الحالية وتشتق Task/Notification الحقيقية؛لا يمكن إنشاء أثر AUTOMATION من receipt قديمة أو Scope مختلف. الإجراء والتاريخ و Audit ونجاح التنفيذ تُحفظ معًا، وفشل أي منها يرجعها كلها قبل تسجيل failure. لا توجد حالة RUNNING معلقة بين معاملتين لهذا العمل المحلي فقط.

## التكرار والحلقات والاستعادة

السبب محفوظ عبر Source → Rule version → Execution → Task/Notification. تقتصر مصادر هذه المرحلة على أحداث Lead المؤهلة وتأكيد Payment وتأكيد Enrollment. تقع آثارها في جداول المتابعة والإشعار فقط، لذلك لا تعيد تشغيل القاعدة. تستلزم إضافة مصادر Follow-up أو إجراءات تعديل Lead توسيع تتبع الأسباب وقواعد منع الحلقات.

طابورتا matching/execution لهما تاريخ immutable لكل version. المحاولات الفاشلة تنتظر 1/2/4/8 ثوانٍ ثم `DEAD_LETTER` بعد خمس failures. لا raw DB/provider exception في DTO/history. Manager/Super Admin حالي ضمن النطاق يستطيع retry بعد إصلاح السبب، ب Session حقيقية و CAS و Audit؛المكتمل/المتخطى لا يقبل retry. الاستعادة لا ترسل للعميل ولا تعيد أثرًا محفوظًا. الشروط التي لم تتحقق تُسجل SKIPPED مع سبب، لا حلقة retries بلا حدود.

## التشغيل من المنصة والبنية التحتية

بعد migrations والبناء تشغّل البنية التحتية `npm run worker:automation`. القيم `AUTOMATION_WORKER_BATCH` افتراضيًا 25 وحدها 1–100، و`AUTOMATION_WORKER_POLL_MS` افتراضيًا 2000 وحدها 250–60000. تتناوب الدورة بين المطابقة والتنفيذ ضمن حد إجمالي، والقراءة حتى 25 candidate لكل processor، مع lock timeout 750ms و statement timeout 5s. هذه حدود تشغيل تقنية قابلة للقياس، وليست Capacity guarantee.

من الأتمتة داخل المنصة: أنشئ القاعدة، اختر النطاق/Trigger/Conditions/Action، راجع النص والتوقيت، ثم اعتمد مع سبب. يمكن تعديلها وتعطيلها ومراجعة نسخها. قسم المعالجة يعرض sources أو executions بصفحات، والنتيجة والـfailure count/history، وزر استعادة المعالجة المتعثرة فقط. افتح Lead لرؤية الأثر الحقيقي. لا يحتاج مستخدم التشغيل إلى SQL أو CLI أوتعديل server files لإعداد القاعدة أوالاستعادة.

## حالة التحقق

Native168 مطبقة على development/test فقط،دون backfill أوتغيير بيانات الأعمال الحالية،ولم تُعدّل migration مطبقة. **178/178 unit و 100/100 full Docker PostgreSQL integration** (347.1s) و**59/59 full Edge Browser E2E** (8.7m) ناجحة،مع Backend/Web build/typecheck/diff check. Focused PG4/4 (39.5s) و Browser1/1 (18.0s) ناجحتان أيضًا. فُحصت الصورةالعربية 390px بصريًا؛الرحلة تثبتالـar/en/fr و no overflow/XSS/duplicate keys و failed-read clearing.

تشملالأدلة actual setup/intake/assignment/matching/actions،8workers/CAS/recoveries،51-rule batch boundaries،future/uncommitted approval exclusion،changed rule/current scope/owner/approver denials،native forgery/immutable provenance/history،five failures/atomic rollback و compiled worker recovery. صُححت select accessible labels و test-only SQL failure fixture واسمجدولخاطئفي assertion،ثم اجتازتالبوابةكاملةدونتخفيفالاختبارات. unit TCP mocks أُعيدتخارج sandbox لتمكين loopback فقط.

هذهالشريحة **Implemented و PostgreSQL/Local Browser Verified**،وليست Automation أو Platform Complete. لا Provider خارجي أو Live integration أو Production deployment لهذاالمسار؛بقية Providers/AI تبقى Live Verification Pending External Credential/Approval. Vite857.33KB/gzip243.98KB warning و capacity/load/rolling upgrade/restore و acceptance الأوسع باقية؛الأزمنةالمحليةليستضمانأداء.
