# تكامل Alma

## Independent native confirmation/Payment boundary — checkpoint مثبتة 2026-10-08

بعد083،unsigned IPN تنشئdurable independent-read job منفصلةوتبقىUNVERIFIED؛worker التلقائية لمتُربطبعد. Claim/attempt/lease/history وproof boundaries native،ولاverified job/attempt بلاproof. Actual independent adapter snapshot تحتويschema1/source/captureMode AUTOMATIC/original merchant-intent-money-plan/processingStatus/refund-safe status؛authorized أوold state=paid أوcustomer claim لاPaid. Proof المقبولةترتبطبسجلone-write admission والمصدرالأصلي؛الوقتDBclock وAudit ذرية.

Shared Payment/Enrollment service تقبلtagged native proof reference،معmonotonic state/separate enrollment/Activities وexact SQL confirmed_at؛Alma لا تُحوّلإلىsigned event أوdomain ماليةموازية. اختباراتPostgreSQL تستدعيexplicit test read claim معactual HTTP read→Pending→captured Confirmed→Enrollment،وتثبتidentity/money/plan/refund/shape/lease-history guards،2-way confirmation concurrency،Audit rollback،historical disable/session revoke،timestamp precision/dedup/no downgrade. Full145/57/25/build/typecheck و001–083 ناجحة،Stripe/PayPal regression ثابتة.

**Mock/Sandbox Verified محليًا فقط**؛لاexternal Sandbox account أوLive Verification أوAlma financial Browser end-to-end. الأصل الماليةلم تُفعّل بالregistry،وautonomous read worker/UNKNOWN candidate resolution/read-only credential repair وLead API/UI باقية. التاليoriginal endpoint credential anchor ثمsafe authenticated Payment read/resolution/worker دونsecond create،قبلrepair/UI/end-to-end activation.

## Native durable issuance — checkpoint مثبتة 2026-10-08

Migration082 تحفظ immutable selected plan/merchant/exact EUR/notification context دونsigned webhook مصطنعة. Generic worker تدعمNEVER/maxAttempts1/retention=null؛بعدfresh preflight تحفظadmission native ذاتone intent/attempt معcurrent requester/session/assignment/Method/config/endpoint version،lease-token وshared Merchant lease وremainingHTTP budget بساعةDB،وAudit native ذريةقبلPOST. Missing/refused/failed admission تمنعwrite؛lost response أوworker interruption تنتقلNeeds Attention ولاsecond create. Late ACK بعدrecovery لا تعيدdispatch accepted. الأصلencrypted ومحفوظ،ولاfallback لحسابآخر.

145unit/57full PostgreSQL/25Edge regression/build/typecheck و001–082 ناجحة؛2unit وintegration جديدةactual Alma HTTP mocks تشملconcurrency/late revocation/native scope-policy-money-plan-budget-lease/session/immutable history/Audit rollback/lost ACK/interrupted worker/rotation/no Payment or Enrollment. **Mock/Sandbox Verified محليًا دونexternal Sandbox account**؛production registry وfinancial Lead UI/confirmation/Payment/Enrollment/repair لمتُفعّل. التاليindependent-read proof/job boundary منفصلةعنsigned receipt ثمcaptured→native Payment/Enrollment والUI/end-to-end gates؛Live Verification Pending External Credential/Approval.

## Post-preflight admission — عقد مثبتة 2026-10-08

`almaHostedAdapter.create` تتطلب `AlmaCreateAdmission` منApplication Service؛لاdefault permissive callback. بعدsuccessful fresh Merchant/eligibility،وقبلPOST المالية مباشرة،يجب أن تعيدcallback `true` فقط بعدcurrent authorization وdurable one-write admission. Missing callback تفشل قبلI/O،false تعنيaccess denied قبلwrite،وexception أوunexpected result تفشلclosed بfinite code دونprovider/application secrets. Preflight refusal لا تستدعيcallback ولاwrite.

Config/credentials/intent ومكوناmoney/plan تُنسخ وتُجمّد قبلawait،فلا يغيّر caller الخطة أوالمبلغ أوMerchant أوreturn targets أوkey أثناءpreflight. هذهحمايةcontract فعلية لازمةللworker،وليستcurrent DB admission أوruntimefinancial activation. callback الـunit test double معلّمةصراحة؛لاno-op callback فيproduction،ولاAlma entry فيCheckout/receipt registries حتىاكتمالnative durability/independent proof/Lead UI. No-replay وUNKNOWN وhistorical read semantics ثابتة. بوابة143unit/56PostgreSQL/25Edge وbuild/typecheck/migrations001–081 ناجحة؛ثلاثunit جديدة تثبت admission وmutation guards،وبقية integration/Browser regression للمسارات الموجودة. الحالة Unit/HTTP Mock Verified فقط؛لاclaim ماليةend-to-end أوLive Verification من هذه المرحلة.

## إعداد واستقبال IPN غير الموقّعة — checkpoint مثبتة 2026-10-08

تُجهّز callback من Payment setup → Alma بعد Authentication للنسخة الحالية، مع سبب صريح. يحفظ Backend هوية Merchant والبيئة والنسخة ومرجع Authentication والعنوان الذي يولّده من أصل التطبيق؛ لا يقبل عنوانًا أوحسابًا يقدمه العميل. Manager يدير اتصال فرعه، وSuper Admin اتصالات مؤسسته، وAgent لا يقرأ هذا الإعداد أوتاريخه. إعادة الطلب لنفس النسخة تعيد endpoint نفسها دون إعادة تفعيل endpoint معطّلة. Disable/Reconnect تستعمل version وملاحظة، وتحفظ تاريخًا مستقلًا وAudit ذرية.

المسار `GET /api/webhooks/payments/alma/:endpointId?pid=payment_ID` يستقبل مرجعًا محدودًا فقط، ويرفض الحقول الإضافية أوادعاءات المال. `payment_untrusted_notification` منفصلة عن signed financial receipts؛ تحمل `UNVERIFIED` ثابتة ولا تحفظ raw payload أوPII. التكرار يُحسم حسب Connection/Mode/Resource؛ كل endpoint تحفظ delivery الخاصة بها دون تعديل الأصل. Connection lock قبل endpoint ينسّق الاستقبال مع lifecycle والتزامن عبر replicas. فشل Audit يعيد inbox/delivery معًا. لا اتصال مالي بالمزود أوإنشاء Payment/Enrollment من هذا المسار.

الحد التقني 60 طلبًا في الدقيقة لكل IP على المسار، و600 مرجع جديد في الساعة لكل Connection افتراضيًا، بساعة PostgreSQL وفحص ذري قبل الإدخال؛ `PAYMENT_NOTIFICATION_HOURLY_LIMIT` إعداد infrastructure من1 إلى10000 وليس قاعدة Business. التكرارات لا تستهلك مرجعًا جديدًا حتى عند الضغط. يرجع `PAYMENT_NOTIFICATION_BACKPRESSURE`/429 عند الحد؛ Alma تستطيع إعادة notification. يلزم قياس الحدود في البيئة المستهدفة، ولا يُدّعى sustained production load.

تعطيل Connection أوتدوير config/key لا يوقف endpoint تاريخية مفعّلة؛ قد تخص عملية دفع سابقة. تعطيل endpoint صراحة يوقف استقبالها بما فيه التكرار، وReconnect تتطلب أصل Merchant/Mode/Config نفسه حاليًا. التاريخ باقٍ، ولا سقوط تلقائي إلى حساب جديد. UI ar/en/fr تعرض callback قابلة للنسخ، حالة الإعداد الحالية والتاريخية، state/version/reason history، inbox غير المتحققة، وحدود HTTP المحلي وعدم تفعيل Alma المالية. لا Signing Secret أوtest endpoint مصطنعة لأن IPN ليست موقّعة.

Migration081 تفرض native current user/session/role/branch/config/verified authentication، immutable identity/history، safe callback، original inbox/delivery immutability وtrust=UNVERIFIED. البوابة140unit/56PostgreSQL/25Edge وbuild/typecheck/migrations001–081 ناجحة؛focused Alma2/2 أيضًا،والصورةالعربية390px فُحصت. **Implemented وMock/Sandbox Verified محليًا** لهذهprerequisite فقط؛لاAlma ماليةend-to-end أوexternal Sandbox account،و**Live Verification Pending External Credential/Approval**. التالي durable one-write وselected-plan issuance وindependent captured proof/native Payment/separate Enrollment/repair/Lead UI، وليس تحسينات IPN اختيارية.

## Hosted protocol وno-replay policy prerequisite — 2026-10-08

`almaHostedAdapter` تنفّذ actual current Merchant وfresh amount-specific eligibility ثم automatic hosted `POST /v1/payments`؛الخطة وEUR exact minor وintentId/return/cancel/IPN server targets صريحة. لا provider key أوidempotency retention مفترضة أو hidden retries. Link response تحفظsafe fixed TEST/LIVE Alma URL matching payment ID وexpiry=null؛لاPaid evidence منcreation ACK حتى لو processing_status=captured. Customer data/fees/old installment state لا تدخل normalized snapshot.

`retrievePayment` قراءة مستقلة current Merchant ثم GET exact Payment ID؛تراجعoriginal merchant/intent/exact gross money/plan/automatic capture/refund shape. Evidence `INDEPENDENT_ALMA_PAYMENT_READ` schema1 لا تعتبر authorized أوstate=paid القديمة تأكيدًا؛PAID فقطcaptured دونrefund. Partial/full refund تمنعinitial confirmation منهذهproof؛لا accounting/refund workflow جديدة. malformed identity/money/plan/URLs/manual/unknown status تفشلclosed،وerrors finite دونsecrets. Missing guarantees تستخدم UNKNOWN للwrite network/HTTP ambiguity،لا automatic replacement.

Generic dispatch policy أضيفت لها `writeReplay:'NEVER'` معmaxAttempts=1 وretentionMs=null،بدلretention مالية مختلقة. الأول يُسمح فقطمعempty contiguous evidence؛أيattempt أخرى تحجبwrite،وUNKNOWN/INTERRUPTED تحفظNeeds Attention،وACK تبقىpermanent acceptance لاPaid. Legacy Stripe/PayPal provider-key policies دونالحقل تبقىبنفس semantics وبميزانياتهاالمثبتة.

هذه standalone protocol/policy prerequisite،ليست runtime financial activation. Adapter نفسهاsingle invocation وليستprovider-idempotent؛يلزمdurable native one-write admission وcurrent authorization recheck بعدpreflight وقبلPOST،unsigned IPN trigger/independent proof native guards وLead plan/issuance/recovery UI وIntegration/Browser ماليةقبلتسجيلAlma فيregistries. Source GETIPN لا يملكsignature وتحتاجdedup/abuse limits وhistorical account-bound read-only reconciliation؛لاverification منcustomer pid/claim/return وحدها. نتائج البوابة وحدودها فيprogress/coverage.

بوابة137unit/55PostgreSQL/24Edge وbuild/typecheck/migrations001–080 ناجحة؛8unit جديدة للعقد HTTP وno-replay policy. Integration/Browser regression للمساراتالموجودة فقط؛ليستاAlma financial end-to-end. **Unit/HTTP Mock Verified لهذاprotocol؛Live Verification Pending External Credential/Approval**.

## Amount-specific eligibility prerequisite — 2026-10-08

`inspectEligibility` امتداد اختياري لـPaymentConnectionAdapter؛Alma تنفّذ current Merchant ثم `POST /v2/payments/eligibility` مع purchase_amount EUR cents/int32 وorigin=online وquery واحدة لخطة مختارة صراحة،دون provider default. العملية تقييم فقط ولا تنشئ Payment لدى المزود. الإجابة يجب أن تحتوي result واحدة بنفس installments/deferred tuple وeligible boolean؛money/account/mode من الطلب والهوية المستقلة،ولا raw reasons/fees/PII/payment schedules تُحفظ أو تُعرض. False eligible نتيجة تقييم ناجحة وليست Authentication failure أوPayment failed.

`ALMA_ELIGIBILITY_V2` schema1 تربط merchant/mode/exact normalized money/plan/eligible؛Migration080 تحفظ immutable eligibility_request وeligibility_snapshot،وتفرض native canonical EUR amount/minor/int32/precision/plan وmatching request/authenticated current identity. Session/role/Branch/version/latest/TTL fences وatomic Audit تبقى؛late rotation/disable تُسجلSUPERSEDED وlate access revoke تُسجلBLOCKED. لا caller eligibility claim أوcurrent result لمبلغ/خطة أخرى.

من Payment setup افحص العروض،ثم أدخل مبلغ EUR واختر خطة allowed صراحة واضغط فحص أهلية خطة Alma. النتيجة تعرض مبلغها وخطتها وmerchant/البيئة،ولا تُعاملcustomer credit approval أو link issuance أوPaid. current/historical results ar/en/fr قابلة للقراءة بالصلاحيات؛rotation/failure تُبطل الحالية وتحفظ التاريخ. يحتاج الإصدار المقبل أهلية جديدة لنفس immutable intent،ولا يعتمد على setup assessment قديمة. Financial registry لا تزال غيرمفعّلة لـAlma؛تفاصيل نتيجة البوابة في progress/coverage.

التحقق النهائي129unit/55PostgreSQL/24Edge وBackend/Web build/typecheck/migrations001–080 ناجح؛actual adapters معHTTP mocks وDocker PostgreSQL/Browser محليًا فقط. Native negatives و4-way latest publication/session expiry-revocation/config rotation/disable/Audit rollback وeligible/ineligible/precision/history/ACL/RTL مثبتة. **Implemented وMock/Sandbox Verified لهذهprerequisite؛Live Verification Pending External Credential/Approval**. ليستAlma ماليةend-to-end أوPayments Complete.

## Merchant offers prerequisite — 2026-10-08

من Payment setup → Alma استخدم **فحص عروض Alma** بعد حفظ Connection؛ القراءة الفعلية تستخدم current Merchant ثم `GET /v1/me/fee-plans?kind=general&only=all&deferred=true` بنفس المفتاح/البيئة الثابتة. لا customer/payment writes أو hidden retries. `PaymentConnectionAdapter.inspectOffers` اختيارية وعامة؛ Stripe-shaped country/options غير مدعومة لـAlma ولا تتظاهر الواجهة بدعمها.

Snapshot `ALMA_FEE_PLANS_V1` schema1 تحفظ accountRef/mode وplans: installments/deferred months/deferred days/allowed/minMinor/maxMinor فقط. max256 خطة وinteger bounds وcanonical exact money وordered unique tuples؛empty list صالحة دون fake availability. raw fees/PII/metadata لا تُحفظ، ولا تُستنتج country/currency capabilities أوdefault installment. حدود المبلغ معروضة بالسنتات ولا تعني أن العميل مؤهل نهائيًا.

Migration079 تضيف OFFERS purpose وimmutable offers_snapshot وتفرض native exact schema/current authenticated identity/mode/ordered tuples/current session/role/Branch/config version/latest/TTL. current offers مرتبطة بالنسخة والهوية؛ auth نجاح لنفس الحساب يحفظها، والفشل أوrotation يُبطلها مع حفظ history. publish والأثر وAudit ذرية؛لا offers منclaim أوforeign account/shape. UI ar/en/fr تعرض current/historical allowed/denied plans والتأجيل والحدود/status/failure/rotation.

بوابة126unit/54PostgreSQL/24Edge وBackend/Web build/typecheck ومigrations001–079 ناجحة. اختباران unit جديدان للعقد وactual HTTP adapter؛PostgreSQL/Browser توسعت للهوية/الفشل/rotation/ACL/shape/duplicate/history/Audit/RTL. **Implemented وMock/Sandbox Verified محليًا**؛لا external Sandbox account أوLive Verification. Hosted issuance/IPN/financial proof/Enrollment لم تُفعّل بعد.

## Authentication prerequisite — 2026-10-08

هذه المرحلة تضيفConnection وread-only Authentication/merchant identity فقط. لا تُفعّلhosted payment أوIPN أوfinancial confirmation؛نجاحها لا يثبتالدفع أوأهليةعرض. Stripe وPayPal المالية تستمران عبرregistries الحالية؛Alma لا تدخلCheckout/receipt registries قبلnative money guards وUI واختباراتend-to-end.

### إعداد التشغيل

Super Admin ينشئConnection للمؤسسة أولفرع؛Manager لفرعه فقط. Agent لا يقرأsetup/history/credentials. تبدأالعملية منPayment setup → Alma: إنشاء/تفعيلالحساب ثمDashboard → Paramètres → Configuration d’API للحصول علىمفتاحالبيئة. TEST تستعملSandbox؛إعداداتSandbox وLive مستقلة. لاcode/server/env/DB edits تشغيلية.

المفتاح AES-GCM مشفّر معConnection AAD،لا يعادعرضه فيDTO/history/Audit أوprovider errors. الحقل يُمسح بعدالحفظ أومحاولةالحفظالفاشلة وعنداختيارConnection/provider. Blank edit تعنياحتفاظًا مقصودًا؛replacement يزيدversion ويُبطلcurrent capabilities. المفتاحopaque printable ASCII بطولتقني20–4096 دونwhitespace/control؛لاStripe-like mode prefix مفترضة. البيئةبقبولAPI علىorigin الثابتة المختارة.

Test authentication ينفذGET واحدة إلى`/v1/me/extended-data` مع`Alma-Auth <API key>`،timeout8s/redirect error/bounded262KiB/fatal UTF-8،دونhidden retry أوcustomer/payment writes. TEST=`https://api.sandbox.getalma.eu`،LIVE=`https://api.getalma.eu`؛لاURL منالعميل.

### Identity وhistory والحدود

القراءةترجعفقط`{schemaVersion:1,profile:"ALMA_ME_V1",accountRef,mode}`. id ضمنtechnical safe identifier bounds دونprefix مخمّنة؛لاname/email/bank/fees/raw أوfake country/charges/capabilities. UI ar/en/fr تعرضcurrent identity/version/time،وتحفظhistorical identities بعدrotation/disable/reconnect.

نتيجةالنجاحWARNING مع`authenticationVerified=true` و`authenticationVersion` المطابقة و`paymentLinksReady=false`/`webhookReady=false`. ليستBusiness-verified beneficiary أوPayment/Enrollment. Auth failure تعرضfinite code وتزيلcurrent capabilities؛CRM متاحة. Country options غير مدعومة وIPN غيرالمفعّلة محجوبةBackend؛Merchant offers متاحة بالمسار أعلاه ولا تجعل workflow مالية جاهزة.

### Current authorization وnative integrity

Claim تحفظcurrent user/session/role/Branch/Connection version؛I/O خارجSQL transaction. publish تراجعsession/role/Branch/latest probe/version/config/TTL وConnection/Branch status بساعةDB. Late completion تكونSUPERSEDED أوBLOCKED ولا تنشرidentity قديمة.

Migration078 تضيف`authentication_snapshot` و`actor_session_id` إلىprobe history دونbackfill مختلق. native guards تفرضAlma exact config وactor/session الحالية،AUTH VERIFIED فقطوprofile/mode/keys/id الصحيحة. session immutable،latest/TTL/current scopes،لاclaim snapshot أوforeign profile. probe/current capabilities/Audit transaction واحدة؛Audit failure تعيدها معًا. RUNNING المتروكة تُعرضINTERRUPTED بعدTTL ويمكنبدءprobe جديدة؛session reference لا تُعرضفيDTO.

### Verification status

adapter الفعلية تستخدمHTTP mocks فيunit/PostgreSQL/Browser؛لاAlma Sandbox account أوLive key مستخدمة. الأعدادونتيجةالبوابةفيprogress/coverage. هذهprerequisite ليستAlma financial end-to-end أوPayments Complete. **Live Verification Pending External Credential/Approval**.

## التالي: financial baseline

Authentication/Offers/V2 eligibility وstandalone hosted/read/no-replay protocol موجودة؛التالي durable/native financial activation وselected-plan Lead UI دون installments Business defaults مختلقة،immutable merchant/money/intent/plan وتحقق current authorization عندactual write. Reference V2 توثق EUR cents/int32 كـAPI money profile،لاcustomer underwriting. UNKNOWN تحتاجoriginal-account independent reconciliation عبرPayment ID موثوقة الربط،لا second create؛لاprovider retention مفترضة.

IPN الرسميةGET `pid` غيرموقّعة؛notification غيرموثوقة تحتاجcorrelation/abuse bounds/dedup ثمindependent authenticated GETPayment وmerchant/exact money/currency/intent. `processing_status` مرجعالحالةبدلstate القديمة،و`authorized` لا تُساوىcaptured. Native confirmation/monotonic Payment/separate Enrollment/history/repair/scoped UI وnegative integration/Browser E2E قبلfinancial activation. Bank Transfer بعدهذهbaseline معtrusted reconciliation لاcustomer claim.

## المصادر الرسمية

- [Authentication](https://docs.almapay.com/reference/authentification)،[environments](https://docs.almapay.com/reference/v10): الإعداد/headers/origins.
- [Official SDK Merchants](https://github.com/alma/alma-php-client/blob/main/src/Endpoints/Merchants.php)،[Merchant](https://github.com/alma/alma-php-client/blob/main/src/Entities/Merchant.php)،[Base identity](https://github.com/alma/alma-php-client/blob/main/src/Entities/Base.php): current merchant endpoint/identity.
- [Official SDK FeePlan](https://github.com/alma/alma-php-client/blob/main/src/Entities/FeePlan.php): general offers وallowed/count/deferred/purchase bounds.
- [V2 eligibility](https://docs.almapay.com/reference/verifier-eligibilite-achat): amount-specific EUR eligibility،queries وترتيب الإجابة؛inspection مثبتة،وليستcustomer/payment verification.
- [Technical guide](https://docs.almapay.com/docs/custom-integration-technical-guide)،[Payment](https://docs.almapay.com/reference/payment): IPN/independent lookup/processing states؛مراجعةللمرحلةالتاليّةوليستverification ماليةمنفذة.
- [Create Payment](https://docs.almapay.com/reference/creer-un-payment)،[Retrieve Payment](https://docs.almapay.com/reference/recuperer-un-payment)،[Official SDK usage](https://github.com/alma/alma-php-client)،[Payment entity](https://github.com/alma/alma-php-client/blob/main/src/Entities/Payment.php): actual hosted request/independent retrieval؛لاضمانidempotency مفترض منالمصادرالمقروءة. SDK old state examples لا تلغيcurrent processing_status.
