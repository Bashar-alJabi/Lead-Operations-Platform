# تكامل Alma

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

Merchant offers وcurrent V2 specific-query eligibility مثبتتان؛التالي hosted creation protocol/selected-plan Lead UI دون installments Business defaults مختلقة،ثمimmutable merchant/money/intent/options وdurable write policy. Reference V2 توثق purchase amount كـEUR cents/int32؛هذا API money profile وليس إثبات capability لكل حساب أوcustomer underwriting. لاidempotency retention أوUNKNOWN retry مفترضةحتىيتحققعقدالمزوّد؛reconciliation تحفظhistory ولا تنشئPayment ثانيةتخمينًا.

IPN الرسميةGET `pid` غيرموقّعة؛notification غيرموثوقة تحتاجcorrelation/abuse bounds/dedup ثمindependent authenticated GETPayment وmerchant/exact money/currency/intent. `processing_status` مرجعالحالةبدلstate القديمة،و`authorized` لا تُساوىcaptured. Native confirmation/monotonic Payment/separate Enrollment/history/repair/scoped UI وnegative integration/Browser E2E قبلfinancial activation. Bank Transfer بعدهذهbaseline معtrusted reconciliation لاcustomer claim.

## المصادر الرسمية

- [Authentication](https://docs.almapay.com/reference/authentification)،[environments](https://docs.almapay.com/reference/v10): الإعداد/headers/origins.
- [Official SDK Merchants](https://github.com/alma/alma-php-client/blob/main/src/Endpoints/Merchants.php)،[Merchant](https://github.com/alma/alma-php-client/blob/main/src/Entities/Merchant.php)،[Base identity](https://github.com/alma/alma-php-client/blob/main/src/Entities/Base.php): current merchant endpoint/identity.
- [Official SDK FeePlan](https://github.com/alma/alma-php-client/blob/main/src/Entities/FeePlan.php): general offers وallowed/count/deferred/purchase bounds.
- [V2 eligibility](https://docs.almapay.com/reference/verifier-eligibilite-achat): amount-specific EUR eligibility،queries وترتيب الإجابة؛inspection مثبتة،وليستcustomer/payment verification.
- [Technical guide](https://docs.almapay.com/docs/custom-integration-technical-guide)،[Payment](https://docs.almapay.com/reference/payment): IPN/independent lookup/processing states؛مراجعةللمرحلةالتاليّةوليستverification ماليةمنفذة.
