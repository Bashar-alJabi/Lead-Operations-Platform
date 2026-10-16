# تشغيل واستعادة وظائف AI المحلية

## النطاق والاعتماد

المصادر: 04 §§6–8/53–55، و06 متطلبات AI/Failure Handling، وAGENTS §§8/15–16/19–29/32/38–39. تضيف Native144 تشغيلًا محدود المحاولات لوظيفتي Qualification وHuman Handoff الموجودتين. تبقى approved tools وoriginal admissions وfull current context proof وحدود Human controller وPayment/Enrollment وCustomer messaging نافذة.

كانت generic catch في `src/ai-worker.ts` تعيد الوظيفة الفاشلة نفسها وقد تؤخر بقية AI steps. الآن تُعزل كل خطوة محلية، وتُحفظ حالة فشلها، وتُستبعد من اختيار العامل أثناء backoff وبعد dead-letter.

## البيانات والسلطة

- `ai_local_action_queue` مستقلة عن Domain receipts، مع unique `(proposal_id,kind)` وQueue UUID مستقلة. Scope مشتقة من proposal الأصلية. Admission تتطلب actual existing QUEUED Job بلا receipt؛ readonly/diagnostic proposal لا تمنحها.
- Job INSERT تنشئ Queue ADMIT ذريًا، وJob DONE تتطلب native fresh receipt وتنتج Queue COMPLETED في transaction الإجراء نفسها. Qualification وchild Handoff يمكن أن تشتركا في proposal مع Queue IDs مختلفتين.
- Worker تختار indexed due row عبر `FOR UPDATE SKIP LOCKED`، ثم Queue→Job→Branch→Campaign→Lead→Contact→Conversation/dependency locks. الخدمات وnative BEFORE INSERT guard تتبع Queue-first أيضًا. Native guard تمنع تجاوز backoff/dead-letter حتى عبر direct SQL. Trusted writers تتبع ترتيب الأقفال؛ deadlock victim لا يمنح سلطة أوpartial writes.
- Local SQL action داخل savepoint بلا Provider I/O. `SET CONSTRAINTS ALL IMMEDIATE` تفرض deferred atomic Domain proofs قبل نجاح الخطوة. فشل أية كتابة/Proof/Audit يعيد action/Field/answer/controller/history/notifications/SLA/Job DONE/Queue COMPLETE معًا، ثم يسجل العامل technical FAILURE خارج savepoint. Direct Domain Service تظل transactional وتعيد الخطأ لمستدعيها؛ اختبارات ذريتها الأصلية محفوظة.
- خمس failures متتالية فقط، مع تأخير 2/4/8/16 seconds ثم DEAD_LETTER عند الخامسة. Native guard تشتق counter/dates/state وstatic `AI_LOCAL_ACTION_FAILED`. DTO وhistory وlogs لا تحمل raw exception/SQL/credentials. الوقت يحدد eligibility وليس deadline لتشغيل العامل. Completed/dead-letter rows خارج due index.
- `ai_local_action_queue_history` immutable بفحص fresh row/version/snapshot، وتسجل admission والفشل واستعادة المستخدم والنهاية. Dead-letter وHuman recovery تحفظان Audit. فشل Recovery Audit يعيد counter/history/version معًا.
- `ai_local_action_now()` في production هي `clock_timestamp()` فقط؛ لا API أوenvironment override للساعة. Fixtures الاختبارية تغيرها داخل DB اختبار معزولة وتعيدها، وهي خارج product runtime.

## Human recovery وScope الحالية

الاستعادة عملية تقنية لمستخدم Super Admin داخل منظمته أوManager داخل فرعه، مع current real session وسبب 3–500 characters وCAS version. Agent المصرح له يرى فشل Lead الخاصة به وتاريخها، ولا ينفذ administrative retry. لا Roles جديدة أوemployee principal مصطنعة.

Queue lock أولًا، ثم Branch lock، ثم إعادة فحص Cookie/session وcurrent Lead/Campaign/Conversation scope. Native recovery تعيد نفس full action context الحالية؛ تغير Owner/controller/policy/Knowledge/Profile/consent/Field/pin/source أوscope يمنع استعادة مصدر قديم. إعادة المحاولة تعيد جدولة نفس العمل فقط؛ لا تنشئ admission جديدة أوتعيد AI تلقائيًا أوترسل رسالة. Terminal COMPLETED لا تُعاد. Job التي تصبح stale قبل المحاولة التلقائية تنتهي BLOCKED وفق Domain guards الحالية؛ mandatory safety stop الأصلية تظل نافذة.

API:

- `GET /api/conversations/:id/ai-action-jobs`: pending/failed افتراضيًا، و`includeCompleted` صريح، وkeyset pagination≤50. Queue UUID وnative timestamp text تحفظ microsecond ties حتى للنوعين في proposal واحدة.
- `GET /api/conversations/:id/ai-action-jobs/:jobId/history`: bounded version pagination، metadata/reason فقط، دون session ID أوcontext/Field values.
- `POST /api/conversations/:id/ai-action-jobs/:jobId/retry`: current Role/session/scope/reason/version/full context. Backend/native denial مستقلة عن إخفاء الزر.

UI داخل Conversation AI history، تدعم ar/en/fr وRTL، وتوضح failure count/state/next eligible attempt وhistory، مع سبب مستقل لكل Queue وexplicit retry. تغيير Conversation/revision/locale أوفشل read/recovery يمسح البيانات والتاريخ المحملين؛ النصوص تُعرض plain React text. Current scope transfer يخفي old-scope queue/history حتى عن Super Admin.

## Startup والتشغيل

لا business setup جديد أوdeployment credentials جديدة. `worker:ai` الحالية تنفذ startup traversal واحدة لكل kind على indexed QUEUED Jobs، بدفعات 25 وkeyset cursor. لا bulk migration replay أوscan لكل التاريخ في كل tick. Concurrent sweeps تستخدم unique source، وتتجاوز Job اكتملت أثناء القراءة. Existing terminal receipts لا تمنح pending admission. Jobs الجديدة تدخل من native trigger فورًا.

Technical defaults: tick≤5 cycles، poll2000ms، legacy batch25، worker local lock timeout2s وstatement timeout10s، failures≤5. هذه إعدادات تشغيل تقنية، وليست business capacity أوضمان throughput؛ تُقاس مع الحمل وتُعدل بتغيير تقني آمن عند الحاجة. Transaction lock وrollback/restart تكفي للخطوة المحلية القصيرة. Structured startup/failure logs تحمل kind/Queue UUID/count/state فقط.

يجب أن تستطيع metadata/Audit transaction الالتزام كي يثبت failure count. إذا كانت DB/Audit نفسها غير متاحة، يفشل العامل fail-closed ويحرر الأقفال ولا يدعي حفظ failure/dead-letter. Core Lead server مستقلة عن AI worker. فشل وظيفة مسجل لا يمنع تجربة due source أخرى أوfamily أخرى في الدورة نفسها.

## التحقق وحدود الاكتمال

الاختبارات synthetic/HTTP mocks فقط؛ Live transfer/full activation معطلتان. نجحت migrations001–144 development/test وBackend/Web build/typecheck و**176unit/82full Docker PostgreSQL** (206.5s) و**48full Edge Browser** (6.0m)، مع focused PG3/3 وBrowser2/2. Native/current authority وfive failures/backoff/eight workers وindependent-source progress وpartial Domain/Audit rollback وcurrent session after lock وRole/foreign denial وstale context/no replay وhistory/microsecond pagination وlegacy concurrency وCLI startup/shutdown مثبتة. Browser تثبت recovery→actual single action وfailed-read clearing وplain text/no-XSS وar/en/fr/RTL؛ صور ar/390px للنوعين فُحصت. Vite806.82KB/gzip229.90KB warning ضمن backlog.

هذه operability baseline محلية، ولا تعني اكتمال Repeated Misunderstanding أوCustomer sends أوAI/Automation/Analytics وبقية المنصة. التكاملات الخارجية **Live Verification Pending External Credential/Approval**.
