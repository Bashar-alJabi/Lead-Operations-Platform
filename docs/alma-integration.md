# تكامل Alma

## Authentication prerequisite — 2026-10-08

هذه المرحلة تضيفConnection وread-only Authentication/merchant identity فقط. لا تُفعّلhosted payment أوIPN أوfinancial confirmation؛نجاحها لا يثبتالدفع أوأهليةعرض. Stripe وPayPal المالية تستمران عبرregistries الحالية؛Alma لا تدخلCheckout/receipt registries قبلnative money guards وUI واختباراتend-to-end.

### إعداد التشغيل

Super Admin ينشئConnection للمؤسسة أولفرع؛Manager لفرعه فقط. Agent لا يقرأsetup/history/credentials. تبدأالعملية منPayment setup → Alma: إنشاء/تفعيلالحساب ثمDashboard → Paramètres → Configuration d’API للحصول علىمفتاحالبيئة. TEST تستعملSandbox؛إعداداتSandbox وLive مستقلة. لاcode/server/env/DB edits تشغيلية.

المفتاح AES-GCM مشفّر معConnection AAD،لا يعادعرضه فيDTO/history/Audit أوprovider errors. الحقل يُمسح بعدالحفظ أومحاولةالحفظالفاشلة وعنداختيارConnection/provider. Blank edit تعنياحتفاظًا مقصودًا؛replacement يزيدversion ويُبطلcurrent capabilities. المفتاحopaque printable ASCII بطولتقني20–4096 دونwhitespace/control؛لاStripe-like mode prefix مفترضة. البيئةبقبولAPI علىorigin الثابتة المختارة.

Test authentication ينفذGET واحدة إلى`/v1/me/extended-data` مع`Alma-Auth <API key>`،timeout8s/redirect error/bounded262KiB/fatal UTF-8،دونhidden retry أوcustomer/payment writes. TEST=`https://api.sandbox.getalma.eu`،LIVE=`https://api.getalma.eu`؛لاURL منالعميل.

### Identity وhistory والحدود

القراءةترجعفقط`{schemaVersion:1,profile:"ALMA_ME_V1",accountRef,mode}`. id ضمنtechnical safe identifier bounds دونprefix مخمّنة؛لاname/email/bank/fees/raw أوfake country/charges/capabilities. UI ar/en/fr تعرضcurrent identity/version/time،وتحفظhistorical identities بعدrotation/disable/reconnect.

نتيجةالنجاحWARNING مع`authenticationVerified=true` و`authenticationVersion` المطابقة و`paymentLinksReady=false`/`webhookReady=false`. ليستBusiness-verified beneficiary أوPayment/Enrollment. Auth failure تعرضfinite code وتزيلcurrent capabilities؛CRM متاحة. الخياراتوIPN غيرالمفعّلة محجوبةBackend؛لاworkflow جاهزةزائفة فيUI.

### Current authorization وnative integrity

Claim تحفظcurrent user/session/role/Branch/Connection version؛I/O خارجSQL transaction. publish تراجعsession/role/Branch/latest probe/version/config/TTL وConnection/Branch status بساعةDB. Late completion تكونSUPERSEDED أوBLOCKED ولا تنشرidentity قديمة.

Migration078 تضيف`authentication_snapshot` و`actor_session_id` إلىprobe history دونbackfill مختلق. native guards تفرضAlma exact config وactor/session الحالية،AUTH VERIFIED فقطوprofile/mode/keys/id الصحيحة. session immutable،latest/TTL/current scopes،لاclaim snapshot أوforeign profile. probe/current capabilities/Audit transaction واحدة؛Audit failure تعيدها معًا. RUNNING المتروكة تُعرضINTERRUPTED بعدTTL ويمكنبدءprobe جديدة؛session reference لا تُعرضفيDTO.

### Verification status

adapter الفعلية تستخدمHTTP mocks فيunit/PostgreSQL/Browser؛لاAlma Sandbox account أوLive key مستخدمة. الأعدادونتيجةالبوابةفيprogress/coverage. هذهprerequisite ليستAlma financial end-to-end أوPayments Complete. **Live Verification Pending External Credential/Approval**.

## التالي: financial baseline

merchant offers/eligibility وhosted creation configuration منUI دونinstallments Business defaults مختلقة،ثمimmutable merchant/money/intent/options وdurable write policy. لاidempotency retention أوUNKNOWN retry مفترضةحتىيتحققعقدالمزوّد؛reconciliation تحفظhistory ولا تنشئPayment ثانيةتخمينًا.

IPN الرسميةGET `pid` غيرموقّعة؛notification غيرموثوقة تحتاجcorrelation/abuse bounds/dedup ثمindependent authenticated GETPayment وmerchant/exact money/currency/intent. `processing_status` مرجعالحالةبدلstate القديمة،و`authorized` لا تُساوىcaptured. Native confirmation/monotonic Payment/separate Enrollment/history/repair/scoped UI وnegative integration/Browser E2E قبلfinancial activation. Bank Transfer بعدهذهbaseline معtrusted reconciliation لاcustomer claim.

## المصادر الرسمية

- [Authentication](https://docs.almapay.com/reference/authentification)،[environments](https://docs.almapay.com/reference/v10): الإعداد/headers/origins.
- [Official SDK Merchants](https://github.com/alma/alma-php-client/blob/main/src/Endpoints/Merchants.php)،[Merchant](https://github.com/alma/alma-php-client/blob/main/src/Entities/Merchant.php)،[Base identity](https://github.com/alma/alma-php-client/blob/main/src/Entities/Base.php): current merchant endpoint/identity.
- [Technical guide](https://docs.almapay.com/docs/custom-integration-technical-guide)،[Payment](https://docs.almapay.com/reference/payment): IPN/independent lookup/processing states؛مراجعةللمرحلةالتاليّةوليستverification ماليةمنفذة.
