# Repeated Misunderstanding في Conversation Agent

## المصدر والعقد

المصادر الوظيفية: 04 §28 و05 §21 وAGENTS §§15/19–29. هذا المسار يربط ملاحظات misunderstanding بمصادر واردة موثقة، ثم يحسب العدد ويطبق السياسة داخل التطبيق قبل نفس approved Human Handoff الحالية. Human Copilot وSimulation لا تمنحان هذا المصدر أوaction authority.

Provider-independent Customer Proposal تضيف reason `REPEATED_MISUNDERSTANDING` إلى `HANDOFF`. يلزم `sourceQuote` غير فارغة ≤500 characters مطابقة حرفيًا للرسالة الحالية ذات speaker=CUSTOMER، مع بقية القيم الفارغة المطلوبة. الأسباب الأخرى تحتفظ بعقد sourceQuote=null. لا count أوthreshold في schema المغلقة. هذا تصنيف AI قابل للتفسير، وليس إثباتًا أن محتوى العميل حقيقة تجارية أومالية.

تستخدم Responses adapter الحالية `text.format` مع strict JSON schema و`additionalProperties:false`. refusal أوincomplete/invalid output يبقى failure ولا يسجل observation أوينفذ أداة. المرجع الرسمي الذي روجع في2026-10-16: [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses). لم تتغير وجهة الاتصال أوحجم data contract أوLive gate؛ لا payload إضافية أوcredentials جديدة. التطوير والاختبارات تستخدم synthetic/HTTP mocks فقط.

## الملاحظات والعدد

Native145 تضيف `ai_misunderstanding_observation` immutable، بمصدر proposal/message فريدين. AFTER UPDATE الموثقة من RUNNING إلى PROPOSED تدرج observation داخل transaction inference-completion نفسها قبل enqueue Handoff. Native fresh xmin وfull current locked context وexact Org/Branch/Campaign/Lead/Conversation/message validation تمنع readonly/old source replay وscope forgery. الحقول المشتقة، بما فيها العدد والحد والقرار والساعة، لا يختارها النموذج أوcaller.

Native146 تضيق enqueue إلى source كانت AI_ACTIVE أوAI_WAITING_FOR_LEAD بلا attention عند admission. Diagnostic AI_HANDOFF_REQUIRED تبقى proposal فقط، ولا تتحول إلى observation أوتُفشل completion بشكل دائم. Insert guard في145 تبقى صارمة؛ لا تعديل لmigration مطبقة ولا backfill للتاريخ.

حلقة العد هي exact Conversation version مع Org/Branch/Campaign scope الأصلية. يبدأ كل controller/scope version جديد من أول observation مؤهلة؛ observations السابقة محفوظة وتبقى تاريخية. تغيير Lead/Campaign/Branch أوHuman takeover لا يحمل سلطة source قديمة إلى الحلقة الجديدة. Metadata inbound وحدها لا تزيد Conversation version. لا reset API أوcounter يدوي أوmodel-supplied cumulative count. تستخدم per-Conversation transaction advisory lock وindexed maximum، بلا تحميل كل history أوCOUNT شامل في كل خطوة.

السياسة ترث handoff object كاملة: Campaign override ثم Branch defaults، كما في Behavior Policy الحالية. تحفظ observation العدد والحد والقرار وإصدارات السياسة وقتها. `handoffRequired = threshold IS NULL OR count >= threshold` يطابق Behavior Preview الحالية: null لا يؤخر handoff لتصنيف repeated misunderstanding مثبت المصدر، ولا يُحوّل إلى رقم business مخترع. Count ليست proof لصحة classification، ولا تلغي أسباب Handoff الإلزامية الأخرى.

## Handoff والسلامة

قبل بلوغ الحد، لا تنشأ Handoff Job أوaction/notification/SLA، وتظل المحادثة النشطة تحت القواعد الحالية. بلوغ الشرط يدرج same durable Job فقط مع **original** Handoff tool admission. Guard الإدراج تتطلب actual fresh qualifying observation؛ لا يمكن فتح job لملاحظة قديمة أوأقل من الحد عبر SQL أوgrant لاحقة.

التنفيذ اللاحق يستخدم original/current full context وNative125–143 proofs دون تخفيف: Tool/Owner/controller/Knowledge/Profile/Field/consent/sender/policy/scope changes تحجب action. Native143 توقف latest current mandatory topic للمراجعة حين يلزم، دون APPLIED Handoff أوnotification مزيفة. Native144 تضبط retries/backoff/dead-letter والاسترداد. Actual APPLIED تفتح WAITING_FOR_HUMAN مع نفس reception/notification/SLA وexplicit Human acceptance؛ لا تغيير Owner أوCustomer send أوPayment/Enrollment.

Audit observation ذرية مع proposal completion وordinal وjob admission. فشلها يعيد كل هذه الآثار معًا؛ read-only inference قد تُعاد بعد lease expiry دون تكرار observation. لا نص SQL/error/quote أوsecrets في Audit metadata؛ IDs/versions/count/threshold فقط.

## UI والمراجعة

تظهر metadata في Conversation→Customer AI execution history ضمن current Lead/Field/Branch/Organization authorization الحالية. تعرض count وthreshold وConversation version **وقت الملاحظة**، وتفصلها عن actual tool receipt والحالة الحالية. لا quote أوcontext/Field value في DTO الجديدة. Scope transfer يخفي old-scope history حتى عن Super Admin؛ غير Owner لا يرى التفاصيل عبر API/URL.

العرض ar/en/fr وRTL كنص React، وhistory محدودة بpagination الحالية مع native timestamp text لحفظ microsecond ties. تغيير Conversation/revision أوفشل read يمسح المحتوى المحمل. تغيير اللغة يترجم نفس metadata التاريخية فورًا؛ لا يعتمد DTO على locale. إعداد الحد متاح من Branch AI behavior defaults وCampaign behavior policy الموجودة، دون source/deployment edits.

## التحقق وحدود الحالة

نجحت migrations001–146 development/test وBackend/Web build/typecheck و**177unit/82full Docker PostgreSQL** (185.2s) و**48full Edge Browser** (6.4m)، مع focused PG1/1 وBrowser3/3. Branch inheritance وCampaign override وnull-limit parity،ثمانية workers وduplicate inbound،exact source/SQL forgery/history/retroactive grant denial،scope transfer،policy changes،Audit rollback،Human takeover أثناء inference،وno customer/financial writes مثبتة. Browser تثبت 1→2→3→actual Handoff→Human acceptance وforeign denial/failed-read clear/plain text وar/en/fr/RTL؛ الصورة العربية النهائية فُحصت. صُحح locale cache regression وfixture HTTP timing ثم أعيدت البوابة دون إضعاف assertions. Vite808.58KB/gzip230.36KB warning ضمن backlog؛ لا migration مطبقة معدلة.

هذه مرحلة Repeated Misunderstanding محلية، وليست إعلان اكتمال full Handoff/AI أوCustomer sends أوبقية المنصة. Live transfer/full activation معطلتان؛ **Live Verification Pending External Credential/Approval** للتكاملات الخارجية.
