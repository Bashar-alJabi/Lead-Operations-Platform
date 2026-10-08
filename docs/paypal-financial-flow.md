# PayPal Orders وcapture والتأكيد المالي

## الإعداد

PayPal تستخدم Connection مستقلة وMerchant ID متوقعة وBranch Payment Method، مع Authentication وWebhook inspection وsigned delivery منفصلة. إعداد المستفيد ليس إثباتًا لهوية الحساب أوصلاحياته أوعملاته. ملف `PAYPAL_ORDERS_V2` يحدد تمثيل العملات فقط؛ رفض PayPal للحساب أوالعملة يظهر كفشل قابل للتتبع. لا تُفبرك country أوcharges capabilities من OAuth.

كل الإعداد يبدأ من Payment setup: Client ID/Secret للبيئة المقصودة، Merchant ID للحساب Business، Webhook ID والcallback/events المطابقة للتطبيق، ثم Test authentication وTest endpoint واستلام signed event. بعدها يضبط Manager أوSuper Admin طريقة Branch والعملات وAgent/Campaign availability. الاختبارات الحالية HTTP mocks وPostgreSQL وEdge محلية فقط.

## الإصدار وdurable capture

1. يحفظ immutable intent المبلغ/العملة/المستفيد/الConnection والطريقة وLead/Campaign/Agent الأصلية وcredential snapshot مشفّرة. كل replay يخضع لصلاحية Lead الحالية.
2. يصدر Worker order بواسطة `lop-order:<intent UUID>` بعد current authorization وnative fences وmerchant lease. يراجع resource identity وpayee وexact money وsafe approval URL. `expires_at=null` تعني غياب تاريخ من المزود؛ لا تعني ضمان صلاحية دائمة. Stripe ما زالت تفرض non-null expiry.
3. يطلب المستخدم المصرح له capture صراحة من Lead. هذا تنفيذ تقني لorder محفوظة، ولا يمنح Role أوصلاحية Mark paid جديدة. يُحفظ authorization مستقل للمستخدم/session/assignment الحالية، ثم job واحدة لكل intent و`lop-capture:<intent UUID>` ثابتة، وattempts append-only.
4. يقرأ Worker order ويشترط APPROVED والهوية والمبلغ والمستفيد قبل write. إذا وجدها COMPLETED، يسجل acknowledgement دون write جديدة. pre-approval denial تصبح BLOCKED؛ recovery صريحة بصلاحية حالية تحفظ first dispatch/policy/attempts/key، دون auto retry لهذا الرفض. تغيّر access/setup يحجب الكتابة.
5. UNKNOWN أوworker interruption يحتفظان بالشك والتاريخ. retries محدودة بخمس محاولات وmerchant lease ونافذة 6h ثابتة؛ لا تُصفّر أوتُمدّد تلقائيًا. OAuth+GET+POST لها dispatch budget 30s وlease 60s. المفاتيح المستقلة و6h تتبع [PayPal Orders capture contract](https://developer.paypal.com/sdk/orders/v2/orders-capture/)، ولا يُفترض تمديد Account Manager إلى72h.

قبول capture أوAPPROVED أوsuccess return أوادعاء العميل لا ينشئ Payment Confirmed أوEnrollment. حالة ACCEPTED تعرض انتظار التأكيد المالي، والتاريخ متاح ضمن Lead ACL. لا يسمح النظام بتكرار كتابة مجهولة خارج الميزانية.

## التأكيد المالي وحماية DB

استلام capture callback يُثبت authenticity فقط. original capture ID وrelated order lookup منفصلتان، وغياب order لا يُخمن منcustom_id. context تربط Connection/mode/prior server dispatch، ثم تقرأ order وcapture من مسارات ثابتة لدى المزود. يُراجع original intent وmerchant وorder/capture IDs وfinal capture وexact gross money/currency؛ القراءة المستقلة تتبع [PayPal captured payment details](https://developer.paypal.com/api/payments/v2/captures-get).

normalized evidence لا تحمل PII أوinstructions أوsecrets. migrations 074–077 تفرض provider/config/currency/expiry/policy وcapture authorization/attempt/ack identity، وnative confirmation تربط original capture receipt بالorder والمستفيد والمبلغ. approval receipt تتوقف بـ`PAYMENT_CAPTURE_REQUIRED`؛ retry لها لا تنفذ capture.

تُحفظ immutable confirmation وmonotonic Payment وEnrollment مستقلة فريدة وActivities وAudit فيtransaction واحدة. PENDING/DECLINED أوevent قديمة لا تمحو CONFIRMED؛ لا تُغلق Lead تلقائيًا. historical confirmation لا تتطلب بقاء requester session أوBranch/Connection نشطة بعد تنفيذ الدفع.

## recovery وحالة التحقق

عند فشل historical read، تعرض Payment webhooks history والمحاولات. الإدارة المصرح لها تستطيع اعتماد credential snapshot حالية مشفّرة بعد Authentication مع تطابق Provider/Merchant ID/mode. هذه recovery للقراءة فقط، ولا تستدعي capture أوتصفر ميزانيتها. scope/session/version وAudit وnative guards تنطبق على الاعتماد؛ window إضافية من خمس reads تحفظ المحاولات السابقة.

حالة التحقق والأعداد النهائية في `codex-progress.md` و`requirement-coverage.md`. **Live Verification Pending External Credential/Approval**؛ لا يوجد Live Provider Verified أوتحقق بحساب Sandbox خارجي. التالي Alma ثم Bank Transfer، دون توسعات PayPal اختيارية قبل تنفيذهما.
