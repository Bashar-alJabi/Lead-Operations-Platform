# دليل التشغيل والتطوير

## Actual independent read worker — checkpoint084

Migrations001–084 و147unit/57PostgreSQL/25Edge regression ناجحة. Original credential anchor وread worker/UNKNOWN reconciliation مثبتةباستخدامactual HTTP mocks؛function تعملصراحةفيintegration،ولاproduction read tick أوAlma Checkout/Lead financial UI بعد. Read retry/poll budget5 وmerchant lease60s قيمtechnical قابلةللمراجعةبقياساتالبيئة،ليستbusiness capacity أوLive Verification.

UNKNOWN لاsecond create؛read تستعملoriginal TEST/LIVE context والkey snapshot حتىبعدcurrent connection rotation. OPEN أو503 قدتعيدreadonly retry ضمنbudget؛interruption تحفظattempt ويُرفضlate result. نفادbudget أورفضالهوية/المفتاح يحتاجNeeds Attention. لاreset budget/anchor أوتعديلhistory فيDB؛المرحلةالتاليةتوفرexplicit scoped readonly recovery منUI. Live Verification Pending External Credential/Approval،لاexternal Sandbox account أوproduction deployment.

## Independent financial proof boundary — checkpoint083

Migrations001–083 و145unit/57PostgreSQL/25Edge regression ناجحة. unsigned notifications تُحفظمعindependent read jobs،لكنAlma read worker/financial registry/UI لمتُفعّل بعد؛لاmanual DB claim أوPayment insertion كتشغيلمنتج. claim native فيintegration fixture فقط. IPN/status=authorized/return page/ACK ليستإثباتًا؛original exact-money captured read هيالسلطةقبلPayment/Enrollment.

Proof/history لا تُعدل،وPending/Confirmed وEnrollment تحافظعلىmonotonicity وAudit/Activities الذرية. UNKNOWN بلاreplay أوreset؛الخطوةالتاليةoriginal credential anchor وactual bounded read worker/Needs Attention/recovery وUI. Live Verification Pending External Credential/Approval،ولاexternal Sandbox account أوproduction credentials لهذهالبوابة.

## Alma durable issuance boundary — checkpoint 2026-10-08

طبّق migration082 معالبقيةعلىبيئةمحددة؛لاعدل081 أوintent/history بعدالتطبيق. One-write marker وnative Audit/current authorization بعدpreflight مثبتةباختباراتlocal mocks/PostgreSQL،لكنAlma ليستفيproduction financial registry أوLead issuance UI حتىاكتمالconfirmation/Enrollment/repair. لاتستخدمcredentials حقيقيةلهذهالبوابة.

UNKNOWN أوworker interruption تعنيNeeds Attention؛لاreset job/attempt/marker أوsecond create أوinvented idempotency key. Original-account independent read هوالخطوةالتاليةللتسوية،ولم يُربطماليًا بعد. رجوع العميل/authorized/ACK/IPN UNVERIFIED لاPayment proof. اختبارات145/57/25 و001–082 ثابتة؛Browser regression فقطلاAlmafinancialE2E،Live Verification Pending External Credential/Approval.

## إعداد واستقبال إشعارات Alma غير الموقّعة — checkpoint مثبتة 2026-10-08

بعد migration081 ومن Payment setup → Alma افحص Authentication، وأدخل سببًا ثم **تجهيز callback لـAlma**. العنوان server-generated من أصل التطبيق ويُرفق بطلب الدفع عند اكتمال issuance؛ لا يُطلب سر توقيع أوتعديل source/DB من الإدارة. HTTP المحلي ليس استقبالًا عامًا من Alma. نسخ URL وتفعيلها لا يثبت وصولًا حيًا أوالدفع، وAlma المالية لا تزال غير مفعّلة.

راجع **إشعارات غير متحققة** وتاريخ callback. `UNVERIFIED` تعني مرجعًا مستلمًا فقط، بلا Payment/Enrollment. لا تختبر بـProduction credentials أوcustomer claim. تعود duplicate لنفس المرجع دون سجل أصلي جديد. 429 تعني حد IP أوالضغط على Connection؛ صحّح السبب وأعد notification وفق حدود التشغيل، دون إنشاء دفع جديد. الحد الافتراضي600 مرجع جديد/ساعة/Connection ويمكن ضبط infrastructure `PAYMENT_NOTIFICATION_HOURLY_LIMIT` من1 إلى10000؛ لا تسجّل query strings أوsecrets.

Disable Connection لا توقف callback تاريخية؛ لإيقافها اختر **تعطيل callback لـAlma** مع السبب. **إعادة تفعيل callback لـAlma** تتطلب حسابها وإعدادها الأصليين الحاليين وversion صحيحة؛ بعد rotation جهّز endpoint جديدة، ولا تعِد كتابة التاريخ أوتجاوز الحماية عبر DB/CLI. **Live Verification Pending External Credential/Approval**؛ تحقق الاستقبال والمال الخارجيان يحتاجان حساب اختبار/موافقة منفصلة، والتفاصيل في [Alma integration](alma-integration.md).

## حدود Alma hosted protocol — 2026-10-08

Contract creation/independent read وno-replay kernel موجودة ومختبرةمحليًا بالعقد HTTP،لكنhosted issuance/IPN الماليينغيرمفعّلينفيruntime بعد. لاCLI/DB override لتسجيلAlma أوإصدارLinks؛الsetup Authentication/Offers/eligibility وحدهاهيالمساراتالحالية. UNKNOWN تعنيعدممعرفةنتيجةwrite ولا تبررsecond create/key؛success return وGETIPN pid لا تؤكدالدفع. التاليnative durable single write وauthorization recheckقبلPOST وindependent proof/repair/Lead UI؛Live Verification Pending External Credential/Approval. [Alma integration](alma-integration.md) تصفالحمايةوحالةكلprerequisite.

## فحص أهلية مبلغ وخطة Alma — 2026-10-08

شغّل migrations حتى080. من Payment setup → Alma افحص Authentication/Offers ثم أدخل مبلغ EUR بأرقام إنجليزية ونقطة عشرية واختر خطة allowed صراحة. زر **فحص أهلية خطة Alma** يقيّم المبلغ والخطة فقط؛راجع result money/plan/merchant/mode/history. لا اختيار افتراضي أوcustomer credit approval أورابط/Payment/Enrollment منالفحص. PAYMENT_AMOUNT_PRECISION_INVALID/AMOUNT_INVALID ترفض rounding/zero/int32 overflow قبل I/O؛false eligible تعني عدم أهلية الخطة للمبلغ دونتأكيدفشل دفع. provider/auth failure finite وتتطلبتصحيح الاتصال وإعادةفحص؛rotation/disable لا تحذفhistory. Actual eligibility HTTP mocked محليًا؛Live Verification Pending External Credential/Approval.

## فحص عروض Alma — 2026-10-08

شغّل migrations حتى079. من Payment setup → Alma احفظ الاتصال ثم **فحص عروض Alma**؛ العملية قراءة current Merchant وfee plans فقط. راجع allowed والخطط والتأجيل وحدود purchase amount بالسنتات، والهوية/config version وhistory. العروض ليست أهلية العميل النهائية؛ لا default plan مختلقة ولا currency capability مستنتجة منها. Failure/rotation تزيل current offers ويحتاج الاتصال فحصًا جديدًا؛ التاريخ باقٍ. `PAYMENT_FLOW_NOT_READY` تظل صحيحة حتى تفعيل financial baseline؛ لا DB/CLI override. الاختبارات المحلية126unit/54PostgreSQL/24Edge ناجحة؛ Live Verification Pending External Credential/Approval.

## إعداد Alma Authentication — 2026-10-08

شغّلmigrations حتى078 علىDocker PostgreSQL. منPayment setup اخترAlma وConnection scope المسموحة وTEST،واتبعتعليماتالمزود للحصول علىمفتاحSandbox مخصص؛الحفظ مشفّر وTest authentication قراءةMerchant فقط. راجعcurrent identity/version/history والfinite error،ودوّرالمفتاح/disable/reconnect منUI. `PAYMENT_FLOW_NOT_READY` مقصودةفيهذهprerequisite ولا تعنيPayment confirmed؛لاCheckout/IPN ماليةمفعّلةبعد. المصدر والتفاصيل في[Alma integration](alma-integration.md)،والتحققبHTTP mocks فقطوالLive pending.

## تشغيل PayPal المالي — 2026-10-08

راجع [PayPal financial flow](paypal-financial-flow.md) لإعداد credentials/Merchant ID/Webhook/Branch Method من UI، ثم إصدار Link وطلب capture وتتبع attempts/financial confirmation/separate Enrollment. `PAYMENT_APPROVAL_REQUIRED` تحجب capture حتى موافقة PayPal وطلب جديد بصلاحية حالية؛ UNKNOWN أوexhausted window لا تعني فشل الدفع ولا تبرر مفتاحًا جديدًا تلقائيًا. historical receipt recovery للقراءة فقط من Payment webhooks مع Provider/Merchant ID/mode ثابتة. شغّل migrations حتى077 وpayment worker الحالي؛ التطوير والاختبارات تعتمد Docker PostgreSQL لاembedded-postgres. التحقق الخارجي pending، والتفاصيل والأعداد الحالية في progress/coverage؛ النصوص السابقة تاريخية عند تعارضها مع هذا المسار.

## هوية PayPal receipt وorder أثناء التحقق

Capture ID فيالإيصال التاريخي ليستOrder ID المستخدمةلـhosted checkout. الأصل المشفر وresource ID لا يتغيران؛related order تستخدمlookup فقط. غيابها لا يعالج باختيارLead أوorder عشوائية أوcustom_id وحدها،ويبقىNeeds Attention عندتفعيلالتدفق. CHECKOUT.ORDER.APPROVED ليستإيصالcapture؛تحتاجdurable capture مستقلة ثمtrusted independent read قبلPayment/Enrollment.

Standalone decoder المختبرةلمتُسجل فيfinancial runtime بعد؛الحالةالفعليةللjobs الحاليةPAYMENT_RECEIPT_PROFILE_UNSUPPORTED كماسابقًا،ولاworker تتصلبOrders/capture لمجردnormalization. عندتفعيلDurable capture/native proof لاحقًا،PAYMENT_CAPTURE_FLOW_NOT_READY تعنيغيابمسارcapture الآمنولايمكنتجاوزهابتأكيديدوي أوsuccess-page claim. لاCLI/DB action تشغيلي لهذهالمرحلة؛Live Verification Pending External Credential/Approval،ولاPayPal financial end-to-end claim.

## إعداد المستفيد المتوقع في PayPal

من Payment setup → PayPal أدخل **PayPal Merchant ID المتوقع** للحساب Business المقصود؛ فيTEST استخدمSandbox Business المرتبطةبالتطبيق. [تعليماتPayPal](https://www.paypal.com/us/cshelp/article/how-do-i-find-my-secure-merchant-id-on-my-paypal-account-help538) تعرضAccount Settings → Business information. المعرف13 محرفًا ضمنpattern الرسمية؛ ليسClient ID أوApp ID أوemail. يمكنتركهفارغًا عندإعدادAuthentication فقط،ولايتحولذلكإلىجاهزيةإصدارروابط.

احفظثمراجع **تاريخ إعداد مستفيد PayPal**؛records تعرضالقيمةأوعدموجودها ونسخةالإعداد/البيئة/دورالفاعل،دونالأسرار. Manager يديرفرعهفقط،Super Admin يتعاملصراحةمعOrganization shared،Agent ممنوعة. تغييرالقيمةأوالبيئةيسقطالفحوصالحالية،والسرالمحفوظيُحتفظبهإنلمتدوّره. clear لا تحذفالتاريخ. هذهexpectation ذاتAudit،وليستهويةمفحوصةأوإثباتPaid/capture/currency capability.

`CONNECTION_VERSION_CONFLICT` عندحفظdraft قديمةتحتاجإعادةفتحالاتصالومراجعةالإعدادالحاليثمsave مقصودة؛Refresh وحدها لا تتجاوزversion الأصليةللform. DISABLED تمنعedit/fحصًا جديدًاوتسمحقراءةالتاريخ؛Reconnect يحتفظبالمستفيدويحتاجفحصًا جديدًا. لاتغيرDB أوتستعملCLI لتجاوزconflict أوتفعيلfinancialProcessingReady؛ PayPal الماليباقٍقيدالتنفيذ وحالةLive Verification Pending External Credential/Approval.

## حالة PayPal Orders/capture قبل تفعيل المسار المالي

عقد Orders create/read وcapture وindependent capture proof موجود ومختبر بـHTTP mocks. لم يُفعّل إصدار روابط PayPal أوcapture worker أوPayment/Enrollment لهذهProvider بعد؛ لا تحاول تشغيله يدويًا بـCLI أوتعديلDB. setup الحالية تظلAuthentication وsigned Webhook receipt فقط، وfinancialProcessingReady=false. APPROVED تعني موافقة العميل وليستدفعًا، وPENDING ليستPaid؛success/cancel لا تؤكدالمال.

المرحلة التالية تضيفexpected merchant منواجهةالإدارة ثمdurable order/capture وnative proof/UI. لاexpiry مصطنعة أوcurrency/account readiness مختلقة. عندتفعيلها ستكونorder/capture keys مستقلتين وثابتتين، وUNKNOWN يحتاجrecovery ضمنretention الموثقة، دونkey بديلة أوhidden retry. لا حسابخارجيأوSandbox credentials حقيقيةاستُعملت فيالتحقق؛ Live Verification Pending External Credential/Approval. راجعprogress/coverage للحالةالمثبتة والاختبارات، ولا تعتبروجودadapter standalone إكمالProvider.

## إعداد PayPal Webhooks

افتح Connection PayPal منPayment setup، ثمأدخلreason وجهّزcallback. داخلPayPal Developer Dashboard → Apps & Credentials افتحREST App نفسها فيبيئةSandbox أوLive المقصودة،ثمWebhooks → Add Webhook. انسخpublic HTTPS callback والأحداثالأربعةالمعروضة؛احفظWebhook ID فيالمنصة. لاSigning Secret ولاcertificate يرفعهاالمستخدم. callback المحليةHTTP لا تستقبلProvider عامة؛ النشر يحتاجHTTPS443. [دليلPayPal](https://developer.paypal.com/api/rest/webhooks/rest/).

Test payment endpoint يقرأإعدادApp ويقارنURL والevents؛ ليستsigned-delivery proof. أرسلactual sandbox event منApp نفسها ثمRefresh للتحقق منوصولموقع. generic Simulator تستخدمWEBHOOK_ID وتُرفضلهذهApp-bound endpoint؛ لا تعتبرهاfinancial proof. current configuration/endpoint verified/signed delivery verified مستقلة،ولاWebhook Ready وحدهاfinancialProcessingReady. فيهذهالمرحلةالماليةPayPal غيرمفعلة؛ الإيصالاتمحفوظةوتظهرNeeds Attention/PAYMENT_RECEIPT_PROFILE_UNSUPPORTED دونPayment/Enrollment. لا تعالجهابإدخالمبلغأوالتأكيداليدوي؛ يلزمfinancial adapter/order/capture verification قبلإصدارالروابط.

PAYMENT_WEBHOOK_SIGNATURE_INVALID ترفضأصلًا غيرموقعأومتغيرًا أوWebhook ID/بيئة/certificate URL/time/certificate غيرصالحة؛ لاraw error/secret فيlogs. PAYMENT_CERTIFICATE_UNAVAILABLE/BUSY تعيد503 حتىيعيدالمزوّدالمحاولة،ولاتحفظunsigned receipt. لاRetry خلفيخفيذلك. تتطلبrotation Callback جديدة؛ احتفظبالقديمةإلىتسويةpendingmoney. Connection rotation/disable لا يحذفالإيصالاتولايفرضcurrent requester علىhistorical money؛ disable Endpoint نفسهايوقفاستقبالها. UI/history/events paginated وManager فرعهفقط/Agentdenied. حالتناMock/PostgreSQL/Local Browser Verified بعدالاختباراتالمثبتةفيprogress،وLive Verification Pending External Credential/Approval.

## إعداد PayPal Authentication

منIntegrations/Payments اختراتصالًا جديدًا وProvider=PayPal ثمTEST أوLIVE المقصودة. أنشئREST App لحسابBusiness منPayPal Developer Dashboard → Apps & Credentials فيالبيئةنفسها،وأدخلClient ID وClient Secret معًا. للتطويراستخدمSandbox مخصصة؛ الاختباراتفيالمشروعsynthetic HTTP mocks/local PostgreSQL/Edge ولا تتصلبحسابPayPal حقيقي. [تعليماتPayPal الرسمية](https://developer.paypal.com/api/rest/authentication/).

احفظالاتصالثمTest authentication. VERIFIED وWARNING تثبتانقبولالتطبيقcredentials فقط؛ ليستحسابالمستفيدأوcheckout/capture/Callback/Payment confirmation. لاStripe options/Endpoint form لهذهالمرحلة،ولاPayPal financial readiness. token/oauth scope لا تصلإلىالشاشةأوAudit. للrotation افتحالاتصالوادخلpair كاملة؛ اتركالحقلينفارغينللاحتفاظبالمحفوظة،ولاmix معStripe key. لايعادعرضالمحفوظة؛ تغيرconfig/credentials يسقطverification وتحتاجإعادةtest. Disable يمنعفحصًا جديدًا ويحفظالتاريخ؛Reconnect يعيدNOT_CONFIGURED وتتطلبtest مقصودة. Manager يديرفرعهفقط،Super Admin جميعالنطاقات،Agent لايقرأsetup/credentials/history.

AUTH_EXPIRED/PAYMENT_PROVIDER_AUTH_FAILED تحتاجمراجعةApp/environment/pair وصلاحياتهافيالمزوّد؛ RATE_LIMITED/UNAVAILABLE تحتاجإعادةفحصمقصودةبعدزوالالسبب. SUPERSEDED تعنيوصولنتيجةقديمةبعدedit/rotation/disable أوprobe أحدث؛ BLOCKED تتضمنسحبالجلسة/الصلاحيةأوتعطيلالفرع. التاريخيبقىمخفيالأسراروpaginated،ولاlatest success تستبدلnewer failure. لاCustomer claim أوsuccess page تؤكدPayment أوEnrollment. الحالةLive Verification Pending External Credential/Approval؛ PayPal ليستend-to-end مكتملةبعد.

## أخطاء normalization للإيصالات

`PAYMENT_RECEIPT_PROFILE_UNSUPPORTED` تعني غياب adapter runtime لهذا Provider؛ لا تعالجها بنقل الإيصال أوتغيير الحساب أوإضافة بيانات يدويًا. `PAYMENT_RECEIPT_CONTENT_INVALID` تعني تعذر قراءة الأصل المشفر أو عدم تطابق decoder/identity/schema؛ تحقق من deployment encryption key والنسخة والتاريخ عبر فريق التشغيل، مع حفظ الأصل واتباع backup/restore المعتمدة عند فساد البيانات. هذه مشكلة بنية/تكامل، وليست سببًا لاعتبار الدفع فاشلًا أوConfirmed. Credential repair للقراءة لا تصلح فساد الأصل نفسه.

الأحداث الموثوقة غير المدعومة تعرضIGNORED دونfinancial retrieval. الأحداث المدعومة تحتاج server-created dispatch وaccount/mode/resource/intent/exact-money proof كما سابقًا. Audit التحقق تحفظreceiptProfile/receiptSchemaVersion لتتبع النسخة المستخدمة دونraw claims/secret. لا Provider إضافية متاحة بسبب وجودContract أوunit fake وحدها؛ القائمة الحاليةStripe v1 فقط، وLive verification باقية.

## مشاركة رابط الدفع من المحادثة

من Lead details حدّث **طلبات روابط الدفع** ثم اختر **تجهيز رسالة برابط الدفع** لرابط صادر وصالح. يظهر اختيار الرابط في **محادثات العميل**؛ التجهيز لا ينشئ Message أو يرسلها. اختر Conversation المطلوبة أو افتحها من زرها الحالي، وتأكد من Human controller والإذن وحالة عدم التواصل. الإدراج يحتاج فعلًا صريحًا ويقرأ الرابط الحالي مرة أخرى؛ إذا أُكد الدفع أو انتهت/اكتملت Session قبل الإدراج يظهر عدم إتاحة الرابط ويبقى النص السابق.

للنص الحر استخدم **إدراج رابط الدفع في النص**؛ يضاف URL إلى draft الموجودة. خارج نافذة الرد استخدم القالب المعتمد المسموح للحملة: **استخدام رابط الدفع لهذا المتغير** يضع URL في BODY parameter المحددة، أو **إدراج رابط الدفع في زر URL** إذا كان prefix القالب متوافقًا. عدم توافق destination يعطي `PAYMENT_TEMPLATE_URL_INCOMPATIBLE`؛ اختر قالبًا مناسبًا ولا تغيّر target تلقائيًا. تجاوز الحد الحالي للمتغير يرفض الإدراج؛ استخدم نصًا ضمن النافذة أو قالب زر متوافقًا بدل تقصير الرابط أو تغييره عشوائيًا.

راجع الرسالة ثم **وضع الرسالة في قائمة الإرسال**. QUEUED ليست SENT؛ تابع **عرض الرسائل** وdelivery/attempt history وerror/recovery الحالية. DNC/التحكم/القالب/الصلاحيات/النافذة/صحة Sender تحرس Queue وWorker، وreplay بنفس المفتاح لا ينشئ رسالة ثانية. الإرسال والنسخ وفتح الرابط لا تؤكد الدفع؛ تأكيد المزود الموثوق وحده ينشئ Payment/Enrollment. لا Messaging credentials أوpayment secrets للـAgent، ولاprovider CLI أوتعديل DB مطلوب للمشاركة.

## استرداد التحقق من إيصال بمفتاح تاريخي ملغى —068–069

إذا ظهرت `NEEDS_ATTENTION/PAYMENT_PROVIDER_AUTH_FAILED`، صحّح صلاحية القراءة لدى المزود، أو دوّر المفتاح من **إعداد الدفع** ثم افحص خيارات Connection الحالية. يجب أن يبقى provider/account/mode مطابقًا للحساب الذي أصدر الطلب. لا تنقل الإيصال إلى حساب مختلف ولا تنشئ Link بديلة لإخفاء نتيجة غير مؤكدة. بيانات الاتصال لا تظهر كاملة بعد الحفظ ولا تُعدل في DB أو server files.

من **Webhooks الدفع** أدخل سببًا، واختر **استخدام بيانات الاتصال الحالية المفحوصة لهذا الإيصال** ثم **إعادة التحقق من الإيصال**. Super Admin أو Manager المخولة للاتصال فقط تستطيع الموافقة؛ Agent أو Manager فرع آخر ممنوعة. Backend تعيد فحص الجلسة والنطاق ونسخة الاتصال وخيارات الحساب وعدّاد المحاولات. فشل version/account/options يستلزم تحديث الصفحة وتصحيح الربط، ولا يُتجاوز بمحو التاريخ.

الاسترداد يحفظ credential snapshot مشفرة مستقلة للقراءة فقط. الطلب الأصلي وبيانات إنشاء الدفع وحدود POST وidempotency لا تتغير. إذا استُنفدت خمس قراءات، هذا الاختيار يجيز خمس قراءات إضافية؛ لا تصفير للعداد أو التاريخ ولا تمديد تلقائي. بدون هذا الإقرار لا تُفتح نافذة مستنفدة. بعد worker، حدّث الأحداث وافتح **محاولات تأكيد الإيصال**؛ تظهر البيانات البديلة المعتمدة وعلامات النجاح والفشل، مع pagination. `PROCESSED` تعني التحقق من الإيصال؛ راجع Lead لمعرفة Payment وEnrollment، ولا تعتبر مجرد retry أو signed callback تأكيدًا للدفع.

اختبارات هذه المرحلة تستخدم مفاتيح اصطناعية وprovider mocks مع PostgreSQL وBrowser محليتين فقط. لا Live Provider Verified أو production credential؛ لا إجراء CLI/DB recovery تشغيلي مطلوب.

## تشغيل وإدارة Worker المالية —064–067

بعد migrations والبناء، شغّل `npm run worker:payments` كservice منفصلة مع deployment `DATABASE_URL` و`CREDENTIAL_ENCRYPTION_KEY` نفسها المستخدمة فيAPI. Development/test تعتمد Docker PostgreSQL وmocks فقط؛ لا تستخدم CLI بمفتاحprovider حقيقي لتهيئةProduct. زيادة replicas ممكنة وSKIP LOCKED/merchant lease تمنعparallel writes للحساب نفسه؛ راقب DB pool لكلreplica. Worker تعالج حتى10 receipt/dispatch pairs ثم تنتظر2s، وتغلق graceful معSIGTERM. خطأSQL/worker لايحذفJobs أوhistory؛ lease60s تعيد recovery معINTERRUPTED والمحاولةنفسها لايعاداستعمالها.

منConnection UI جهّزAuthentication وAccount options وWebhook/current signed verification. Restricted Key تحتاجCheckout Sessions create/read وAccount read وpermissions التابعةللإنشاء inline لدىالمزود، إضافةBalance/Country Specs/Webhook Endpoints read للفحوص الموجودة؛ Provider رفضالصلاحية يظهرfailure ولايجعلالدفعConfirmed. UIتحفظcredentials مشفرة. Shared Connection يربطهاRoot بالMethod صراحة؛Agent تستخدمحسبLead/Method availability دونوصولللsetup/secret. Current Method readiness مشتقةمنcurrent options/Endpoint، ولاتعتمدعلىauth-probe cached financial flags.

حفظطلبLead يُنشئ QUEUED وPAYMENT_LINK_REQUESTED مرةواحدة. حدّثطلباتالدفع لمتابعةRUNNING/RETRY/ACCEPTED/FAILED/BLOCKED/NEEDS_ATTENTION وسجلالمحاولات. ACCEPTED تضيفPAYMENT_LINK_CREATED ورابطsafe HTTPS مشفرمخزن؛ copy/open متاحللمخولعلىLead الحاليةفقط. رابطمنتهي أوPayment Confirmed/Expired/Failed لاتعرضURL. النسخليسإرسالًا؛ إذاشاركتعبرMessaging يجبالمسارالمركزي للقواعدالموجودة، لاprovider send جانبية. فتحرابطأوصفحةsuccess/cancel أوclaimلايؤكدPayment أوEnrollment.

منWebhook history تابعQUEUED/RUNNING/RETRY/PROCESSED/IGNORED/NEEDS_ATTENTION وerrorcode ومحاولاتverification دونraw customer data. PROCESSED لايعنيPaid: راجعLead payment status. Receiptموقّعةتحتاجمطابقةserver dispatch وGETموثوقللحساب/الجلسة/mode/amount/currency؛unmatched setup testevent قدتظهرNEEDS_ATTENTION بدونPayment. عندفشلالفحصصححالسببثمأدخلreason وأعدالتحقق منUI؛ النافذة التلقائية خمس محاولات، والتمديد الصريح للقراءة فقط موضح في068–069 أعلاه. duplicate callback لا تجدد الميزانية ولا تنشئ Payment أخرى. Agent ممنوعةمنConnection recovery. Connection rotation/disable أوانتهاءجلسةrequester لايوقفhistorical confirmation بمفتاحintentالمحفوظ؛احتفظبالEndpoint القديمة حتىتسويةمدفوعاتها.

UNKNOWN/INTERRUPTED تعني قبولًا قد يكون حدث؛ لا تنشئ key بديلة أوتعدّلDB لإزالةambiguity. Worker تحافظ على params/key/first-dispatch/retention وتتوقف قبل انتهاء24h Stripe window مع ميزانيةI/O كاملة. Receipt موثوقة قبلACK يمكنها إثبات الدفع؛ recovery عند وجودها لا تعيدPOST. Native guards تحفظ attempt/receipt/confirmation/Enrollment history. عند trusted PAID تُحفظ Confirmed Payment وEnrollment منفصلة وActivities/Audit atomic، بدون إغلاقLead تلقائي. استرداد read-only credential موضح في القسم068–069، ومشاركة الرابط منUI موضحة في القسم الأول أعلاه؛ multi-provider ما زال ضمن baseline التالية، ولاLive verification.

الأقسام063وHosted Checkout التاليةتوثيقالمراحل السابقةقبلتوصيلworker؛سلوكQUEUEDوالpipeline أعلاههيالحالية. لاتشغّلintegration/Browserمعًالأنهمايفرغانقاعدةtestالمعزولة.

## حفظ طلب رابط دفع — مرحلة063

من Lead details تظهر **طلبات روابط الدفع**. اختر Method جاهزة وأدخل amount بأرقام إنجليزية ونقطة عشرية وcurrency مسموحة؛ لا rounding أوscientific notation أوفواصل آلاف. readiness للحفظ تتطلب Method/Campaign/Agent availability الحالية، active Branch،authentication/options من Connection version الحالية وcharges enabled، وEndpoint configured/provider verified مع signed delivery. Super Admin يربط shared Connection بMethod صراحةً؛ Manager/Agent تستخدمها ضمن Lead scope دون رؤية الحساب أوcredentials. إذا تغيرت Method بعد عرضها، حدّث الخيارات بدل إعادة استخدام version قديمة.

**حفظ طلب** يسجل `PAYMENT_LINK_REQUESTED` مرة واحدة مع مبلغ canonical وMethod name؛ ليس `PAYMENT_LINK_CREATED`. يظهر تاريخ `PREPARED` وغياب Customer URL. لا ترسل الطلب كأنه Link ولا تعتبره Paid/Enrolled، ولا تعدل صفوف DB لإصدار رابط. لا worker مالية مفعلة في هذه checkpoint؛ durable dispatch وtrusted confirmation/Enrollment التالية يجب أن تستقر قبل الإرسال المالي. Provider rotation/disable تحفظ intent الأصلية وencrypted credential/account/mode snapshot، وLead reassignment تغير الوصول للتاريخ حسب current Lead access. technical return targets تأتي من APP_ORIGIN؛ success/cancel page لا تؤكد الدفع.

الفحص الحالي يستخدم Docker PostgreSQL وخيارات/signatures اصطناعية وProvider mocks؛ لا external account أوLive Stripe أوproduction credentials. قواعد التطوير والاختبار منفصلتان، ولا تُشغّل integration وBrowser suites معًا لأنهما تفَرغان قاعدة الاختبار المعزولة.

## Hosted Checkout profile الحالية

money validation وStripe create/retrieve adapter متاحة تقنيًا ومختبرة بمزود HTTP وهمي، لكنها غير موصولة بعد بـLead Link API/worker/UI أوPayment confirmation. لا تستخدمها من CLI بcredential حقيقية لتفعيل سلوك مالي؛ التشغيل المعتمد يأتي من application service والواجهة في المرحلة التالية. لا زر إنشاء صوري أوجاهزية true بسبب وجود adapter وحدها.

عند اكتمال UI التالية: Restricted Key تحتاج Account read وCheckout Session create/read والصلاحيات المطلوبة لإنشاء price/product inline حسب مزودها. charges_enabled=false تمنع إنشاء جديد ولا تمنع retrieval تاريخية. UNKNOWN بعدPOST تعني احتمال قبول المزود؛ لا تغيّر intent/idempotency key أوتعاملها كرفض ثمتنشئ duplicate. Worker يجب أن تحفظ first dispatch و24h safety deadline وتجري reconciliation من Session/Event موثوقة بعد الانقطاع. 400/401/403 رفض للمحاولة الحالية لا يمحو UNKNOWN تاريخية؛ 429/concurrent409 قابلة لمحاولة محدودة بنفس params/key ضمن retention، وparameter conflict تحتاج مراجعة. UI/recovery job لهذه المرحلة التالية غير منفذة بعد.

المبالغ decimal strings لا floats، والعملة/precision حسب provider profile لاpayout أوCLDR وحدها. Stripe ISK/UGX integer-major×100، zero-decimal كما توثق المزود، وHUF/TWD two-decimal charges. actual account offers وmin/max/rail limits تحتاج runtime gates ولا تستنتج من صحة currency code وحدها. لا Live Checkout verification، ولا Production/personal credentials أوprovider URLs معدلة يدويًا.

## إعداد Payment Webhook ومراجعة الاستلام

بعد migrations001–062، من **إعداد الدفع** اختر Connection المسموحة ثم **Webhooks الدفع**. Manager تدير فرعها، Super Admin المؤسسة والفروع، Agent ممنوعة. أدخل سببًا ثم **تجهيز callback للدفع** وانسخ العنوان نفسه. في [Stripe Developers Dashboard](https://docs.stripe.com/development/dashboard/webhooks): Webhooks → Create an event destination → Account، بيئة Sandbox/LIVE المطابقة، ثم العنوان والأحداث الأربعة المعروضة → Add endpoint. هذه profile تستعمل v1 we_ ولا تقبل v2 ed_ أوConnect/thin. إذا كانت الواجهة Workbench اختر Developers Dashboard من Developers preferences لدى Stripe، كما توثق صفحة المزود؛ لا CLI أوتعديل server. انسخ we_ Endpoint ID وwhsec_ Signing Secret إلى الشاشة ثم احفظ. لا حسابًا شخصيًا أوProduction key في التطوير، ولا source/env/DB edits تشغيلية. APP_ORIGIN العام وHTTPS متطلبات deployment؛ HTTP المحلي لا يستقبل Stripe العامة.

Restricted key تحتاج Webhook Endpoints read لاختبار الوجهة، مع صلاحيات Authentication/options حسب الفحص. **اختبار Endpoint الدفع** يتحقق من ID/URL/mode/enabled/events لدى حساب المفتاح، ولا يثبت Secret. أرسل Test event من Workbench ثم **تحديث Webhooks الدفع** لإثبات وصول موقّع بصورة مستقلة. السر مشفّر ولا يعرض ثانية. endpointVerified وsignedDeliveryVerified منفصلان، والمعالجة المالية غير جاهزة هنا. RECEIVED_NOT_PROCESSED ليست Paid ولا تنشئ Enrollment، ولا Customer claim أوsuccess page تؤكد الدفع.

AUTH_FAILED: راجع المفتاح وصلاحيات read؛ MODE_MISMATCH: طابق البيئة؛ ENDPOINT_MISMATCH: راجع ID وURL الدقيقة؛ EVENTS_MISSING: حدّث أحداث الوجهة؛ ENDPOINT_DISABLED: فعّلها لدى المزود ثم اختبر. RATE_LIMITED/UNAVAILABLE قابلة لفحص جديد بعد التعافي. FAILED لا تمحو history؛ SUPERSEDED/BLOCKED/INTERRUPTED لا تعني نجاحًا. حدّث الإعداد والجلسة والصلاحية ثم اختبر من UI دون تعديل DB.

Receiver ترفض signature/payload/mode/Connect scope الفاسدة دون حفظها. Retry موقّعة حديثًا لنفس الهوية والمحتوى لا تكرر Event؛ content conflict409 يحتاج تحقيقًا لدى المزود ولا يعالج بمحو الأصل. Provider timestamp القديمة لا تمنع signature حديثة. Body64KiB وrate300/min/IP؛ overload429/DB500 تبقي retry للمزود، ولا2xx قبل الحفظ الذري. UI تعرض ID/type/mode/timestamps فقط، دون raw customer/amount أوfinancial status claim. Processor المالية تأتي مع Links التالية، دون worker وهمية أوأوامر DB يدوية.

لتدوير Secret جهّز Endpoint جديدة وافحصها واحتفظ بالقديمة للمدفوعات المعلقة. Connection/Branch disable يحجب عملًا جديدًا ويبقي callbacks الأصلية؛ receipt قديمة لا تعيد current readiness. **تعطيل Webhook الدفع** نهائي يوقف هذه Endpoint ولا يمحو history؛ نفذه بعد reconciliation وعطّل وجهة Workbench أيضًا. Events immutable ومشفّرة؛ backups تحتاج مفتاح encryption مستقلًا وآمنًا. كل التحقق mocks/PostgreSQL/Local Browser؛ Live Stripe Pending External Setup. لا ترفع أسرارًا أوfixture أوlogs/صور .local.

## فحص خيارات مزود الدفع

اختر Connection من **إعداد الدفع** ثم **فحص خيارات الدفع**. يلزم server key الموافق TEST/LIVE بصلاحية قراءة Balance وAccount وCountry Specs؛ اقرأ [API keys](https://docs.stripe.com/keys) و[Account API](https://docs.stripe.com/api/accounts/retrieve). الفحص read-only؛ لا ينشئ Checkout أوWebhook ولا يؤكد Payment. تعرض الواجهة بلد الحساب/default currency/country currencies-methods وcharges/card status ووقت الفحص. Country options ليست ضمانًا لتفعيل كل rail للحساب أوصلاحية Checkout write؛ WARNING/PAYMENT_FLOW_NOT_READY باقية حتى اكتمال financial flow.

Unknown/malformed/mismatched/oversized response تعطي PAYMENT_PROVIDER_RESPONSE_INVALID، و403 AUTH_EXPIRED تحتاج صلاحية المفتاح، و429/UNAVAILABLE تحتاج انتظار المزود ثم فحصًا جديدًا. لا raw error أوbank/business info في الواجهة. Rotation أوreconfigure تلغي current options حتى فحص نسخة الإعداد الجديدة؛ Authentication الناجحة بعد OPTIONS تحتفظ بالنتيجة ووقتها فقط إذا كانت من نفس version. History تعرض OPTIONS/VERIFIED snapshot القديمة حتى بعد failure/disable دون جعلها current. Active Method غير المطابقة للعملات المطروحة ترفض PAYMENT_CURRENCY_NOT_OFFERED؛ صحح currencies أوعطّلها بسبب موثق.

لا Stack/CLI/DB edits مطلوبة لفحص Business connection. Credentials/images/logs/fixtures المحلية تبقى خارج Git؛ صورة Arabic في.local/e2e/payment-provider-options-ar.png فُحصت، والتشغيل Mock/PostgreSQL/Browser فقط. Webhook setup وPayment Links/Enrollment ما زالت غير متاحة؛ لا success page أوcustomer claim تؤكد الدفع.

## طرق الدفع للفروع

من **إعداد الدفع → طرق الدفع للفروع** اختر الفرع وConnection، وأدخل اسمًا وعملات مثل USD, EUR، وإتاحة ALL أوSELECTED Agents/Campaigns من الفرع. فعّل الطريقة صراحة وحدد السبب ثم احفظ. Super Admin فقط تربط اتصال المؤسسة بطريقة فرع؛ Manager تستطيع إدارة الطريقة المخولة لفرعها، ولا تدير أسرار الاتصال المشترك. خيارات Connection/Agent/Campaign وMethods paginated، ولا يقبل Backend IDs من فرع آخر. حالة active لا تؤكد قدرة الدفع: PAYMENT_AUTHENTICATION_REQUIRED تحتاج فحص الاتصال، وPAYMENT_FLOW_NOT_READY تعني أن Links/trusted webhook غير مكتملة بعد.

Version conflict تحتاج تحديث الطرق وفتح التفاصيل ومراجعة أحدث نسخة قبل إعادة المحاولة. عند تعطيل Connection أوBranch يمكن تعطيل Method الحالية مع حفظ تاريخها؛ لا يعاد تفعيل طريقة blocked بصمت. افتح Method لرؤية النسخ والأسباب والعملات والاسم التاريخي. Agent ترى **طرق الدفع المتاحة** داخل Lead المصرح بها فقط، دون Connection config/secret/history؛ إعادة الإسناد تنقل الوصول، وتغيير availability ينعكس بعد التحديث. Currency code المعروفة ليست ضمان دعم Provider؛ لا تستخدم هذه الشاشة لتأكيد Payment أوإنشاء Enrollment أوCustomer link. هذه المرحلة local PostgreSQL/mock/Browser Verified وليستLive Stripe.

## Payment Connection Authentication

من **إعداد الدفع** أنشئ اتصال Stripe باسم واضح وTEST/LIVE المطابقة لمفتاحه؛ Super Admin تختار المؤسسة أوالفرع، وManager تعمل بفرعها. أنشئ الحساب/Sandbox والمفتاح من [Stripe API keys](https://docs.stripe.com/keys)، ثم أدخل restricted server key بصلاحية قراءة Balance لفحص Authentication الحالي. استخدم test key مخصصة في التطوير؛ لا حسابات شخصية أوProduction credential. لا تتطلب العملية تعديل source أوenv أوDB. المفتاح يحفظ مشفرًا ولا يعرض ثانية؛ في التعديل اترك الحقل فارغًا للاحتفاظ به أوأدخل replacement لتدويره.

**اختبار Authentication** يحفظ attempt ونتيجة آمنة. VERIFIED مع WARNING/PAYMENT_FLOW_NOT_READY تعني نجاحAuthentication فقط؛ لا Payment Links أوtrusted webhook أوEnrollment في هذه checkpoint. لا تعتبر Customer claim أوsuccess page دفعًا. AUTH_EXPIRED تحتاج تصحيح صلاحية المفتاح ثم إعادة الاختبار؛ RATE_LIMITED/UNAVAILABLE تحتاج انتظار المزود ثم اختبارًا جديدًا. RESPONSE_INVALID/MODE_MISMATCH تحتاج إعداد البيئة الصحيحة. لا raw provider errors أوأرصدة في UI/history.

Disable وReconnect تتطلبان السبب ونسخة الإعداد الحالية، وتحفظان التاريخ. Reconfigure/rotate/reconnect ترجع NOT_CONFIGURED حتى الاختبار التالي. SUPERSEDED تعني تغييرconfig/disable أوفحص أحدث أثناء الطلب؛ BLOCKED تعني تغيرجلسة/دور/نطاق أوتعطيلفرع. INTERRUPTED تعني انتهاء TTL بعد interruption، وتسترد باختبار جديد من UI؛ لا تعديل DB. عند version conflict حدّث القائمة وراجع الإعداد قبل المحاولة. الصور/logs/fixture credentials في.local لا ترفع إلىGit. Browser ar/en/fr وRTL390px محلية وfakes، وليستLive Stripe.

## مراجعة مراجع المصدر فيMessaging

شغّل worker:events المعتادة بعد migrations001–058. signed webhook تحفظ raw/referral دون provider GET إضافية؛ worker تربط Ad context المثبتة أوتحفظ Needs Attention. لا تحتاج Production credentials لإعادة الاختبارات المحلية. إعداد Source Ad binding الصريحة يتم من Campaign Sources القائمة، وإعداد Sender/Connection من Messaging setup؛ لا تعديل كود أوDB تشغيلي يدويًا.

من Messaging setup اختر Connection ثم Inbound review. تعرض الرسالة المحفوظة وreference ID/type/captions الآمنة، مع أهداف حالية مسموحة. SOURCE_REFERENCE_UNRESOLVED تعني أن Ad/Post لم تثبت Campaign/Thread؛ تحقق من العميل والحملة ثم حدد Lead أوConversation صراحة. MULTIPLE_ACTIVE_CONVERSATIONS/LEADS تبقى غامضة ولا تُخمن. SOURCE_REFERENCE_TARGET_CONFLICT أوINBOUND_CONTEXT_TARGET_CONFLICT تتطلب التحقق من سياق المزود؛ تغيير هدف يدوي لا يتجاوز الدليل. PINNED_SENDER_MISMATCH لا يسقط إلى رقم بديل. المرجع الفاسد يمنع الربط؛ يمكن تجاهل Event بسبب موثق مع حفظ الأصل. لا يرسل Resolve/Ignore أي Customer message.

بعد الحسم يظهر reference snapshot في تاريخ المحادثة للمستخدم المصرح حاليًا؛ reassignment تنقل الوصول دون حذف التاريخ، ونقل Lead خارج Branch Connection يمنع inbound attach الجديدة حتى توجد resolution صحيحة. Source connection المعطلة لا تمحو السياق المثبت في Source Submission؛ current Sender/Connection scope وpinning تبقى نافذة. الصور المحلية الجديدة في `.local/e2e/messaging-source-reference-ar.png` و`messaging-source-review-ar.png`، ولا ترفع fixture/cookies/screenshots/traces إلى Git.

## تشغيل Historical Meta sync

من **مصادر Meta** اختر Connection ثم Page وForm من Catalog الحالية. Super Admin تدير Organization source، وManager مصدر فرعها؛ منح Form مشتركة للحملة لا يجيز قراءة سجلها الكامل. أدخل البداية والنهاية بصيغة UTC (تشمل البداية وتستثني النهاية)، ثم «إنشاء معاينة تاريخية». انتظر Preview Ready واستخدم «تحديث المزامنات التاريخية» لرؤية الصفحات والسجلات المقروءة والمطابقة والمعروفة. المعاينة لا تنشئ Lead ولا تعرض بيانات العميل. النتائج تقتصر على السجل المتاح لدى Meta؛ العدد النهائي غير معروف حتى اكتمال المعاينة.

اكتب سببًا ثم «تأكيد الاستيراد التاريخي» بعد مراجعة النطاق والملخص. خدمة worker:sources تشغل preview/import/evaluation/intake بمواعيد مستقلة. Imported تعني Source Submission محفوظة؛ راقب عدد Leads المنشأة والحالات التي تحتاج مراجعة، ثم افتح «مراجعة المصدر» للحالات غير المحسومة. تبقى Campaign ACTIVE وMapping الحالية وrequired fields ومطابقة Contact قواعد نافذة. لا ترسل هذه المهمة رسائل للعميل. DUPLICATE_SUBMISSION تحفظ الأصل؛ DUPLICATE_RECEIPT تنتظر retrieval الواردة؛ CONTEXT_CONFLICT تحفظ تعارض الهوية دون استبدال الأصل، ويجب مراجعة Connection والمصدر الصحيحين.

Timeout و429 تؤديان إلى backoff ومحاولات محدودة، مع رمز فشل آمن. «إعادة محاولة» تتطلب reason/version وتستأنف Failed/Blocked ضمن الإصدارات والصلاحيات الأصلية. إذا تغيرت resources/config، أكمل reconnect/discovery ثم ألغِ المهمة القديمة وأنشئ معاينة جديدة. إذا تعطّل حساب requester، أنشئ معاينة بالحساب المصرح حاليًا. Cancel توقف العمل القادم وتُسقط نتائج Provider المتأخرة؛ تبقى الدفعات المحفوظة والسجلات التي لم تستورد محفوظة للمراجعة. SUCCEEDED تعني اكتمال حفظ الاستيراد، وليس ضمان إنشاء كل Lead.

حدود Infrastructure: SOURCE_HISTORICAL_MAX_PAGES=10000 افتراضيًا (1..100000)، وSOURCE_RETRIEVAL_MAX_FAILURES=5 وlease=30s وbackoff=30..1800s؛ حتى20 item لكل import transaction، و100 record/512KiB/8s لكل Provider page. PAGE_LIMIT تحفظ cursor/items وتعرض الفشل؛ راجع قياسات السعة وحد runtime قبل retry. لا تعدّل DB أوcursor يدويًا. expired lease تحفظ Attempt SUPERSEDED وتعيد حجز الصفحة بأمان. المحاولات والنتائج مرئية من UI، وlogs الآمنة تستخدم component source-historical-worker/source-historical-import. تشمل استراتيجية backup قاعدة البيانات والمعاينات وSource PII. تحقق Live Meta وretention وApp Review ما زال يتطلب إعدادًا خارجيًا مقصودًا.

## جاهزية Source Campaign وتفعيلها

من Campaigns افتح الحملة ثم راجع «الجاهزية». لكل active binding: Connection/موارد متاحة ومنحة Form الحالية، Mapping PUBLISHED صالحة تشمل required LEAD_CREATION، App ID وcredentials محفوظة، Verify and Save للـCallback واشتراك Page مثبت للإصدارات الحالية. Manager تعمل ضمن فرعها والموارد المخولة؛ Organization connection setup أوPage subscription تحتاج Super Admin. لا تحتاج name/phone/email ثابتة إن لم تحددها Mapping أوالقواعد. عطّل binding غير المقصودة صراحة مع reason/version؛ لا يتجاهل الفحص binding مفعلة ناقصة لأن ربطاً آخر صالح.

بعد تغيير config/credentials أوPage catalog أعد discovery/subscription test كما تشير الأكواد؛ بعد تغيير Fields/required/options انشر Mapping محدثة. Draft لا تحل محل Published. إذا Messaging/AI enabled تعرض Dependencies حتى اكتمال setup/dispatch لوحدتيهما؛ لا تُفعّل بصمت. Activate يعيد current requester/config checks، وconcurrent requests تحفظ Audit وversion واحدة. CONNECTED تعني نجاح الاتصال بالمزود؛ انتظر readiness الصحيحة ثم ACTIVE وPROCESSED لإثبات نتائج الإنشاء. التشغيل المحلي هنا فakes/signatures اصطناعية/PostgreSQL، ولا يثبت Meta App Review أوProduction webhook delivery.


## تشغيل Source intake ومراجعة المطابقة

بعد migrations001–054 وbuild شغّل worker:sources. VALIDATED تنتظر transaction الإنشاء؛ PROCESSED تعرض Lead UUID في Source review وتاريخ التنفيذ والسبب والMapping المستعملة. ابحث عن UUID في Leads لفتح تفاصيلها حسب الصلاحية. SOURCE_CAMPAIGN_INACTIVE تحتاج تفعيل الحملة بعد جاهزية setup؛ SOURCE_CAMPAIGN_FLOW_NOT_READY تعني أن Messaging/AI المفعلة تحتاج dispatch dependencies التالية. فعّل Campaign من شاشة Campaigns بعد أن تعرض الجاهزية دون أخطاء؛ Activation تعيد الفحص في Backend. Browser readiness تختبر public Activation ثم actual intake؛ اختبارات data path السابقة تحتفظ بـACTIVE domain fixtures الصريحة.

CONTACT_AMBIGUOUS: افتح «مراجعة مطابقة Contact»، راجع incoming Contact والمرشحين المتاحين، اختر الشخص واكتب سبباً ثم اعتمد المطابقة لإنشاء Lead. بيانات العميل نص غير موثوق، ولا HTML. Manager تحتاج Super Admin عند scope restriction؛ لا تختار Contact خارج المرشحين ولا تعرض IDs/أسماء المقيدين. تغير Mapping/identities أوversion يتطلب تحديث المطابقة وإعادة مراجعتها. PROCESSED لا يمكن إعادة معالجتها أوتبديل Lead link لها. التصحيح التشغيلي من Contact/Lead fields حسب الصلاحية ويحفظ الأصل والتاريخ؛ لا تعديل DB يدوي للاسترداد.

## إعداد Source Webhook وPage subscription

1. من Meta Sources أنشئ أو عدّل Connection وأدخل App ID وGraph version وcredentials الخاصة بالمؤسسة. App ID مطلوبة لـsubscription/test، وليست secret. استبدال config/credentials يبطل Catalog الحالي وverification status؛ أعد اكتشاف Pages/Forms. الأسرار لا تعاد بعد الحفظ.
2. اختر Page المكتشفة، ثم من Meta App Dashboard → Webhooks → Page أدخل Source Callback URL التي تعرضها المنصة وVerify Token نفسها المحفوظة عند setup؛ Verify and Save ثم حقل leadgen. يلزم public HTTPS وApp Review وصلاحيات Pages/Lead Ads/Leads Access وإسناد الموارد لدى Meta؛ credentials التطوير الاصطناعية لا تحققها. لا تعديل source code/env/DB لإعداد business connection.
3. Subscribe Page to leadgen تنفذ subscription API ثم verification GET، وTest Page subscription تفحص الحالة فقط. existing fields لنفس التطبيق محفوظة؛ App/Page token mismatch يمنع أي mutation. فشل الصلاحيات/token يظهر بكود آمن وسجل محاولة؛ أصلح إعدادات المزود أو credentials ثم اختبر من الواجهة.
4. Refresh Webhook status تقرأ handshake الحقيقي وvalid signed event وآخر Incoming وnotifications pending؛ لا تولد verification أو Leads وهمية. استخدم Meta Lead Ads Testing للمورد المخول لإرسال حدث اختبار. POST تحفظ الأحداث الموقعة فقط، وForm numeric الجديدة تحفظ دون تخمين، replay لا يزيد العدد أو يغير الأصل. نتيجة subscription قديمة بعد Catalog/config changes تظهر قديمة حتى إعادة الاختبار.
5. local disable يمنع handshake/callbacks ويحفظ التاريخ؛ لا يحذف subscription لدى Meta. بعد إعادة الإعداد أعد discovery ثم subscription test. فشل محلي بعد mutation خارجية لا يعني إلغاءها لدى المزود؛ test/resubscribe يفحص الحالة قبل POST جديد. RUNNING بعد crash تنتهي بعد lease120s عند طلب جديد، ثم تسجل FAILED قبل محاولة جديدة، دون تحرير DB يدوي.
6. retrieval تحفظ Submission الأصلية، ثم evaluation وintake schedules تنشئ Lead عند صلاحية الإعدادات وCampaign ACTIVE. نجاح verification/subscription/retrieval وحده ليس إثباتاً لإنشاء Lead؛ راقب PROCESSED. Activation تفحص current setup لكل active binding؛ source Connection intakeReady مشتقة من وجود target جاهزة في Campaign مفعلة، وليست إثبات Live Meta. DTO/history لا تعيد raw أوPage/App secrets؛ Organization setup للمسؤول الأعلى فقط. لا production credentials للاختبارات المحلية.

## Source retrieval worker وfailure recovery

بعد build/migrations، شغّل `npm run worker:sources` كخدمة بنية مستقلة بـDATABASE_URL وCREDENTIAL_ENCRYPTION_KEY نفسهما؛ هذا deployment/runtime setup، أما tokens/resources/recovery كلها من UI. worker تستعمل Page credential الخاصة بالمصدر فقط. يمكن ضبط الحدود التقنية المذكورة في `.env.example`؛ defaults20/batch وpoll2s و5 automatic failures/cycle وlease30s، وHTTP8s. لا تعد هذه الأرقام Campaign capacity أو provider business rules.

من Source Webhook setup راجع Pending/Running/Retrieved/Failed/Blocked وآخر event، ثم Source retrieval attempts للإشعار المطلوب. FAILED تحتاج إصلاح المزود أوpayload issue، وBLOCKED قد تتطلب credential/config/catalog repair: عدّل credentials عند الحاجة، أعد discovery واختبار اشتراك Page، ثم أدخل سبب retry. Recovery ترفض نسخة قديمة وتحتفظ بالتاريخ والعدد الكلي للمحاولات؛ تفتح cycle آلية جديدة محدودة، ولا SUCCEEDED retry أوraw overwrite. تغيّر config/catalog أثناء GET يجعل النتيجة SUPERSEDED ويحتاج retry بعد إصلاح readiness؛ `AUTH_EXPIRED` تمنع الجلب إلى حين repair. expired RUNNING lease تتعافى آلياً عند tick جديدة، وليس بتعديل DB.

Submission raw محفوظة مع notification +provider lead +external context وsource timestamp الأصلية، دون تسطيح Multi-values أوmetadata. retrieval وevaluation لا تنشئان Lead؛ intake تعيد current published setup وتنفذ المطابقة/الحقول/routing أوNeeds Attention. لا تستخدم manual Contact review لتجاوز Source rules. اختبارات worker adapter fakes على Docker فقط، وليست Live Meta.

## الحالة الحالية

### Lead بدون بيانات Contact

تدعم Core Lead الآن غياب Contact عندما لا تتوفر بيانات الشخص؛ تظهر حالة واضحة في القائمة والتفاصيل، ويمكن متابعة Field values/notes/assignment/follow-ups حسب صلاحية Lead. لا يُنشأ Contact فارغ أواسم وهمي. إذن التواصل readonly مع CONTACT_REQUIRED، وإنشاء WhatsApp conversation يحتاج Contact phone؛ historical thread لا تسمح بالإرسال دون Contact الحالية. Source intake/Contact matching/link review ما زالت قيد التنفيذ، وهذه checkpoint لا توفر إنشاء Lead من Meta بعد؛ لا تستخدم Manual Contact Review لتجاوزها أواصلاحها بتعديل DB.

### مراجعة المصدر وإعادة تقييم Mapping

من Meta Sources → الاتصال أوCampaign → Sources افتح **مراجعة بيانات المصدر**. PENDING تنتظر `worker:sources`، وNEEDS_ATTENTION تعرض كود فشل آمن: Form غير مكتشفة تحتاج discovery، وbinding غير مطابقة تحتاج مراجعة identifiers وشروط الربط، وMapping غير منشورة/قديمة تحتاج publish وفق Catalog وFields الحالية. خطأ قيم/required/scalar ambiguity لا يُحل بتغيير Raw Source؛ أصلح Mapping المسموح بها ثم أدخل سببًا لإعادة المعالجة. لا يمكنك اختيار Campaign عشوائية لتجاوز قواعد السياق.

إعادة المعالجة تضع PENDING وتحفظ history، والworker تفحص الأصل والإعدادات الحالية دون GET جديدة. VALIDATED تحويل فقط وتنتظر intake؛ PROCESSED نجاح Contact/Lead/fields/routing. Organization Submission غير المحلولة للـSuper Admin فقط؛ Manager تحتاج Campaign فرعها والمنحة الحالية. سحب المنحة يمنع review/history/reprocess، وإعادتها لا تعيد binding تلقائياً. بعد repair/republication أدخل سبباً وأعد الفحص. DB exception أثناء intake تبقي VALIDATED وتعيد الدورة المحاولة؛ لا تعديل يدوي للبيانات للاسترداد. Status/history لا تعيد raw أوcustomer values؛ Contact review المخولة وحدها تعرض mapped Contact وvisible candidates.

التعليمات هنا لتشغيل **الأجزاء المنفذة حالياً** ومراجعتها. المنصة ليست مكتملة أو جاهزة للإنتاج؛ راجع `codex-progress.md` و`requirement-coverage.md` قبل أي نشر. تحققت migrations واختبارات API على PostgreSQL 18 المحلي عبر Docker Desktop.

## المتطلبات

- Node.js 24 أو أحدث، npm.
- FFmpeg installation موثوقة توفر `ffprobe` في API وoutbound worker وCI؛ تضبط `MEDIA_PROBE_BINARY` إلى binary أو مسارها المطلق. التطوير الحالي وجد FFmpeg9.0.1/ffprobe المثبتتين ولم يحتج installation أو Administrator. لا تستخدم مسار جهاز المطور في deployment؛ ثبّت dependency داخل environment/image المناسبة.
- PostgreSQL 18 عبر Docker Compose أو instance مُدار. التطوير والاختبارات الحالية تستعمل Docker Compose فقط؛ لا تستخدم `embedded-postgres` خارج العزل.
- قيم مستقلة لكل بيئة لـ`DATABASE_URL` و`APP_ORIGIN` و`CREDENTIAL_ENCRYPTION_KEY` و`BOOTSTRAP_TOKEN` قبل التهيئة الأولى. لا تُخزن القيم في Git.

## تشغيل محلي

1. `npm ci`.
2. ولّد `POSTGRES_PASSWORD` عشوائية في `.env` المحلي المتجاهل من Git، ثم `docker compose up -d --wait postgres`. احفظ `DATABASE_URL` المطابق في `.local/database-url` المحلي المتجاهل من Git. لا تستخدم اعتماداً حقيقياً أو حساباً شخصياً. على جهاز التطوير الحالي، CLI موجود في `C:\Users\Bashar\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe` ويحتاج تشغيله من Codex إلى إذن خارج العزل؛ يمكن استدعاؤه بالمسار الكامل. لا تستخدم `embedded-postgres` خارج العزل.
3. اضبط `DATABASE_URL` في عملية الـAPI، ثم `npm run db:migrate`.
4. ولّد مفتاح تشفير credential من 32 بايت عشوائية، ورمز bootstrap عشوائياً مستقلاً. عين `CREDENTIAL_ENCRYPTION_KEY` و`BOOTSTRAP_TOKEN` في بيئة الـAPI، و`APP_ORIGIN=http://127.0.0.1:5173` للتطوير.
5. شغّل `npm run build` ثم `npm start` للـAPI، وفي نافذة ثانية `npm run web:dev` للواجهة.
6. افتح `http://127.0.0.1:5173` وأنشئ أول Super Admin برمز bootstrap. بعد النجاح يصبح مسار التهيئة غير صالح لأن وجود أول مستخدم يمنع تكراره. احذف رمز bootstrap من بيئة النشر بعد ذلك.
7. لتفعيل دعوات الموظفين واستعادة كلمة المرور: من صفحة **بريد الحسابات**، أدخل بيانات SMTP التي أُنشئت لدى مزود البريد واختبر الاتصال. لا يُعاد عرض كلمة المرور بعد حفظها. شغّل عملية `npm run worker:identity` مستقلة مع `DATABASE_URL` و`APP_ORIGIN` و`CREDENTIAL_ENCRYPTION_KEY` نفسها. يمكن للـSuper Admin وManager المصرح لهما رؤية حالة التسليم وإعادة محاولة Job فاشل صالح. `APP_ORIGIN` يجب أن يكون origin الواجهة الذي يستقبل رابط الدعوة/الاستعادة. لا تستخدم Credential شخصية أو Production للتطوير.
8. عند إدخال Lead يطابق أكثر من Contact أو يطابق Contact خارج فرع Manager، تُحفظ Submission وتظهر في **مراجعة المطابقة** دون إنشاء Lead. يختار المسؤول Contact المرشحة صراحة؛ الحالات التي تضم مرشحاً خارج نطاق الفرع تحتاج Super Admin. تأكد من ظهور Lead بعد الحسم في صفحة الفرص ومن بقاء Submission التاريخية؛ تكرار الحسم نفسه يعيد Lead نفسها.
9. من **الحقول الديناميكية** اختر Campaign ثم أنشئ Field بالنطاق المسموح واربطها بالحملة. اضبط `requiredStage` وظهور Agent/Manager والتحرير والترتيب. تظهر القيم المصرح بها في Lead Details ويمكن حفظها ومراجعة تاريخها. عند تعيين `LEAD_CREATION` يجب إدخال القيمة أثناء إنشاء Lead؛ وعند `CLOSE` يمنع الـAPI إغلاق Lead إن كانت ناقصة. `ENROLLMENT` ينتظر خدمة التسجيل قبل التحقق التشغيلي الكامل. تعديل خيارات مستخدمة تاريخياً يستلزم إبقاء المفتاح وتعطيله بدل حذفه.

لعامل الرسائل شغّل `npm run worker:messaging` كعملية مستقلة بعد `npm run build` مع `DATABASE_URL` و`CREDENTIAL_ENCRYPTION_KEY` نفسيهما. يلتقط Jobs المعلقة ويعيد فحص السياسة قبل الاتصال بالمزوّد. `SENT` تعني قبول طلب الإرسال مع Provider Message ID ولا تثبت `DELIVERED`؛ `UNKNOWN` تعني أن نتيجة الطلب ملتبسة وتحتاج مراجعة ولا يعيد العامل إرسالها تلقائياً. إدارة Meta templates وإنشاء قالب نصي ثابت ومزامنة اعتماده وربطه بحملة، ثم إرساله عبر العامل، اجتازت الاختبارات بموفر وهمي. يجب اعتماد القالب من Meta وربطه بالحملة من الواجهة، ويعيد العامل فحص Approval وSnapshot قبل الإرسال. لاختبار اتصال من الواجهة: اكتشف الأرقام، أنشئ/زامن قالباً نصياً ثابتاً معتمداً (BODY مع HEADER TEXT/FOOTER اختياريين)، اختر Sender ورقم اختبار تتحكم به أو حصلت على موافقته، وأكد ذلك ثم أرسل اختباراً. تعرض الواجهة `SUCCEEDED/REJECTED/UNKNOWN` دون رقم المستلم الكامل؛ عند `UNKNOWN` افحص Meta قبل طلب جديد، إذ لا تحدث إعادة تلقائية. `CONNECTED` هنا يعني قبول مزود الاختبار للطلب من رقم محدد، مع بقاء `webhookVerified=false` وSender `DEGRADED`. اختبارات التطوير تستخدم fake provider وتوقيعات محلية وتثبت API/Worker paths فقط؛ لم تثبت Meta live أو التسليم الحقيقي؛ لا تعتبر المنصة جاهزة لتشغيل Messaging الحي اعتماداً على هذه الاختبارات وحدها.

في صفحة الاتصال انسخ Callback URL الظاهر إلى Meta App → Webhooks، وأدخل Verify Token الذي حُفظ عند إنشاء الاتصال، ثم اشترك في حقل `messages` لحساب WhatsApp Business Account. لا تعرض المنصة الرمز بعد حفظه؛ يمكن استبداله بتعديل الاتصال الذي يتطلب إعادة الاكتشاف والاختبار. نجاح GET handshake يظهر مستقلاً عن استقبال POST موقّع. عند وصول Status موقّعة تحفظ المنصة تاريخ `SENT/FAILED/DELIVERED/READ` وتمنع رجوع الحالة عند ترتيب وصول مختلف؛ Worker يعيد وصل callback وصل قبل حفظ Provider Message ID. افحص قائمة الأحداث التي تحتاج مراجعة عند Sender/Participant mismatch أو Message غير معروفة. Inbound messages تُحفظ أولاً كأحداث دائمة ثم يحل Worker النص منها إلى Conversation/Lead عند تطابق وحيد؛ تُعالج أنواع الوسائط المدعومة عبر Media worker مع فحص المحتوى، ويبقى الغموض للمراجعة، ولا تعتمد على الاختبار المحلي لتشغيل تكامل حي. التحقق الحالي من Webhook تم بتوقيع اختباري محلي، ولم يجر ربط Meta sandbox/live.

عند وصول inbound text موقعة يحاول عامل Messaging ربطها بمرجع الرد أو Conversation نشطة أو Lead وحيدة ذات Sender مضبوط؛ لا يرسل ردًا تلقائياً. تظهر الأحداث الملتبسة في **مراجعة الرسائل الواردة** على صفحة الاتصال للمسؤول الأعلى أو Manager اتصال فرعه، مع مرشحي Lead/Conversation المصرح بهم فقط. اختر الهدف بعد التحقق من العميل والحملة أو تجاهل الحدث مع سبب؛ يبقى السجل محفوظاً. إذا فتحت الرسالة محادثة بلا Agent فستنتظر متحكماً بشرياً؛ من صفحة Lead استخدم **تولّي المحادثة** مع سبب قبل محاولة الرد، وتبقى الموافقة ونافذة الإرسال والسياسة مطلوبة. المرفقات المدعومة تُلحق بالمحادثة مع metadata وحالة فحص؛ التحميل يتطلب READY. الأنواع غير المدعومة أو Payload الفاسدة تبقى للمراجعة. لم يجر UI E2E أو Meta sandbox/live؛ لا تعتبر هذا تحققاً من تكامل حي.

في الإنتاج، اجعل الواجهة والـAPI وراء HTTPS وreverse proxy على origin واحد أو اضبط `APP_ORIGIN` على origin الواجهة الحقيقي. Cookie الجلسة `Secure` في `NODE_ENV=production`. يجب أن يوجه proxy مسار `/api` و`/health` إلى الـAPI، وأن يقدّم ملفات `dist-web` بعد `npm run web:build`.

## إعداد Meta كمصدر Leads

### Field Mapping وPreview

من binding الحملة اختر **Field Mapping** ثم **اقتراح الربط** لمراجعة الاقتراحات أو **إضافة ربط حقل** للاختيار اليدوي. تختار Source key الفعلية وContact name/phone/email أو حقل Lead مرتبط ومصرح به. حقل SOURCE readonly يظل قابلاً للربط حسب visibility؛ SYSTEM/CALCULATED/حقول فرع آخر ليست destinations. السؤال بلا key وحيدة يبقى غير قابل للمطابقة، ولا تستبدله بlabel/index. يمكن أن تختار source نفسها لعدة destinations مختلفة، لكن لا destination مكررة في Mapping واحدة.

اختر conversion المناسبة؛ الأرقام decimal، Boolean true/false، multi-values قيمة لكل سطر، والعملة من إعداد الحقل. خيارات المصدر المختلفة عن platform values تستعمل **إضافة تحويل خيار** مع source value وplatform option الصريحة. لا تُستبدل required أو datatype checks بالـMapping. أدخل سبباً واحفظ Draft أو Publish؛ missing required LEAD_CREATION mapping تمنع Publish، ولا تُفرض Contact fields ثابتة. حقول CLOSE/ENROLLMENT لا تجعل mapping إنشاء Lead إجبارية عند تلك المرحلة.

استخدم قيم اختبار مخصصة في preview؛ لا credential أو customer production data في التطوير. preview تفحص القيم الحالية وتعرض typed contact/field outputs والأخطاء، ولا تنشئ Lead أو تعدل Source/Operational records. Draft لا تستبدل آخر PUBLISHED؛ التاريخ محفوظ. تغيير Catalog/Connection/Field configuration يستلزم review ثم publish جديدة؛ resync مطابقة لا تبطل mapping دون سبب. عند conflict أعد تحميل Mapping قبل التعديل. نشر نسخة لا يعيد معالجة submissions أو Leads سابقة تلقائياً؛ reprocess الصريحة غير متاحة إلى حين تنفيذ intake. يبقى SOURCE_INTAKE_NOT_CONFIGURED وحجب تفعيل الحملة رغم Mapping منشورة وصحيحة.

من **مصادر Meta** اختر إضافة مصدر، وأدخل اسم الاتصال وإصدار Graph API الذي يستعمله تطبيق المؤسسة، وUser access token مصرحاً له بـPages المطلوبة وPage tokens، وApp Secret ورمز Verify خاصاً للتطبيق. Super Admin تختار نطاق المؤسسة أو الفرع؛ Manager ضمن فرعها فقط. لا تستعمل حساب مطور شخصياً أو credential production في التطوير؛ أتمم متطلبات Meta App/Review/Pages/Lead Ads وLeads Access لدى المزود حسب روابط الإرشاد الرسمية داخل الواجهة. هذه connection مستقلة عن Messaging/WABA، ولا يحتاج الإعداد تعديل server/environment أو hardcoded Page ID.

استخدم **اختبار واكتشاف Pages** ثم اختر Page صراحة و**اكتشاف Forms**، ثم Form لقراءة الأسئلة/options. Page tokens تحفظ مشفرة ولا تعرض في الخيارات أو download أو API أو Audit. metadata نصوص غير موثوقة تعرض escaped، ولا تفتح روابطها أو تنفذ HTML. نجاح catalog يظهر WARNING وINTAKE_NOT_CONFIGURED؛ لا يعني Subscription أو Lead delivery. bindings ومعايير المصدر متاحة حسب التعليمات أدناه؛ Mapping setup/preview متاحة أعلاه؛ Webhook/Lead retrieval/intake وhistorical sync غير متاحة بعد، ولا تفعّل source Campaign اعتماداً على discovery أو binding وحدها.

لـOrganization connection: Super Admin تختار Form ثم **مشاركة Form مع الفروع**، وتحدد Branch وسبب المنحة وتحفظها. المنحة لهذه Form فقط؛ Manager تجد المصدر وPage/Form الممنوحة داخل إعداد Campaign، دون root/Page token أو تعديل الاتصال المشترك أو discovery. إلغاء المنحة يعطل bindings التابعة للفرع ذرياً ويحفظ تاريخها؛ إعادة المنحة لا تعيد تفعيلها. Branch connection تستعمل حصراً داخل فرعها، ولا تحتاج shared grant.

من إعداد Campaign ذات source META، اختر **ربط Form جديدة** ثم Connection/Page/Form. يمكن إضافة عدة Forms/References. حدد External Campaign/Ad Set/Ad IDs الموثوقة عندما تحتاج الفصل بين استعمالات Form؛ لا تدخل اسم Campaign بدل ID. كل شرط محدد يجب أن يطابق الحدث، والشرط الفارغ يقبل أي قيمة. احفظ بسبب واضح، واختر تفعيل اختيار المصدر عندما يصبح السياق مناسباً. رفض `SOURCE_BINDING_CONTEXT_CONFLICT` يعني وجود binding نشطة يمكن أن تطابق الحدث نفسه؛ ضيّق المعايير أو عطّل الربط السابق من الحملة المصرح بها بعد المراجعة. لا تكشف رسالة التعارض هوية حملة فرع آخر، ولا تختَر binding عشوائية. غياب selector لازم في حدث مستقبلي يبقى unresolved للمراجعة، ولا يلغيه الترتيب أو specificity.

تعديل الربط يحفظ version/history؛ عند conflict حدّث القائمة وأعد المراجعة. Connection/Form/Campaign identity محفوظة: تغيير المصدر يحتاج binding جديدة، ولا يمحو القديمة. يمكن تعطيل binding بعد بطلان المورد/المنحة، ويبقى التاريخ. تغيير Connection configuration يجعل النسخة القديمة غير متاحة؛ أعد discovery ثم عدّل/فعّل binding صراحة بالنسخة الحالية. Mapping غير المنشورة أو stale تمنع readiness؛ `SOURCE_INTAKE_NOT_CONFIGURED` تمنع استقبال Leads وتفعيل Campaign المصدر حتى مع Mapping صالحة؛ هذه checkpoint لا تنشئ Lead أو Message.

عند SOURCE_PROVIDER_AUTH_FAILED أصلح صلاحية التطبيق/Pages أو استبدل الثلاثة credentials من Edit source، ثم أعد اكتشاف Pages وForms. اترك حقول الأسرار جميعاً فارغة للاحتفاظ بها؛ لا يمكن قراءتها بعد الحفظ. فشل provider/response/pagination أو تجاوز الحد التقني لا يستبدل Catalog جزئياً؛ اقرأ Sync history/error ثم أعد العملية بعد معالجة السبب. ما زالت HTTP401/403 مميزة كauth failures، وبقية رفض المزود يظهر safe code؛ لا تعرض raw response/token. توجد محاولة RUNNING واحدة لكل Connection مع lease120s، وexpired lease تعالجها discovery التالية تلقائياً مع history دون حذف.

Disable يحافظ على الاتصال والموارد والتاريخ ويبطل availability، وReconfigure تعيد NOT_CONFIGURED؛ يلزم اكتشاف Pages/Forms من جديد. Edit يحافظ على النطاق ويزيد version، وأي provider result بدأت بإعداد قديم لا تصبح صالحة. الحدود التقنية الحالية10 صفحات×100 مورد،512KiB لكل استجابة و90s للعملية؛ SOURCE_CATALOG_TOO_LARGE ليست حذفاً أو نجاحاً جزئياً. القوائم paginated ولا تحمل جميع موارد المنظمة إلى الواجهة دفعة واحدة.

التحقق الحالي Mock/PostgreSQL/Local Browser فقط، وليس Meta live أوOAuth/App Review verification. `worker:sources` تشغل retrieval/evaluation/intake schedules مستقلة؛ Campaign resolution/current publication/Contact review والتحقق من ACTIVE تسبق Lead creation. Messaging/AI enabled تحتاج flow dependencies الموثقة قبل التشغيل، وhistorical sync تستكمل بعد checkpoint readiness.

## تشغيل مرفقات Messaging الواردة

### تشغيل القوالب النصية المركبة

لرابط مختلف لكل إرسال، اجعل هدف URL HTTPS تنتهي بمتغير `{{1}}` واحدة مثل `https://example.test/orders/{{1}}` وأدخل **مثال لاحقة URL** منفصلاً عن أمثلة HEADER/BODY. لا تستخدم رابطاً كاملاً كلاحقة، ولا whitespace/control/backslash أو percent encoding فاسدة. بعد اعتماد المزود والمزامنة والسماح للحملة، يظهر **قيمة لاحقة URL** في composer مع preview للرابط النهائي. Agent تختار قيمة الإرسال نفسها؛ مثال الاعتماد لا يملأها تلقائياً. عند نجاح queue تُمسح draft ويظل الهدف المرسل في History من snapshot الأصلية. تغير prefix أو موضع الزر قبل الإرسال/recovery يمنع dispatch؛ لا يعيد التطبيق اختيار index أو target أخرى. Test send التشغيلي يختار قوالب بلا متغيرات HEADER/BODY/URL؛ لا تحذف المتغير لتجاوز هذا الشرط. تحقق المسار بunit/integration/Browser fakes وPostgreSQL Docker؛ لا Meta live.

أضف optional static buttons من نموذج القالب: URL لرابط HTTPS كامل بلا username/password، وPHONE_NUMBER بصيغة + الدولية. profile الحالية تسمح بواحدة من كل نوع، label حتى25 حرفاً وURL حتى2000؛ بعد الاعتماد والمزامنة والربط تظهر الأهداف في Conversation preview والسجل. التغيير في Catalog بعد Queue يمنع dispatch/recovery، والتغيير بعد SENT لا يعيد كتابة الهدف التاريخي. الروابط لا تُفتح أو تُجلب تلقائياً أثناء العرض؛ Browser tests تتحقق من href ولا تتصل بموقع أو رقم حقيقي. URL variable واحدة نهائية مدعومة كما أعلاه؛ Quick Reply متاحة بنمط مستقل كما أدناه؛ media template headers مدعومة كما أدناه، والتحقق Live Meta معلّق.

من إعداد Connection أنشئ BODY مع HEADER TEXT ثابت أو متغير واحد وFOOTER اختياريين (حتى60 حرفاً لكل منهما). BODY تقبل placeholders متسلسلة وأمثلتها. HEADER تقبل {{1}} مرة واحدة مع HEADER parameter example مستقلة؛ عند الإرسال أدخل HEADER parameter value منفصلة عن قيم BODY. النص النهائي للعنوان حتى60 حرفاً؛ FOOTER ثابتة بلا variables. ينتظر القالب اعتماد المزود، ثم استخدم Sync approvals واربطه من Campaign templates. Agent تختاره في Conversation المسموحة وتدخل قيم BODY؛ سجل الرسالة يحتفظ بكل الأجزاء، والعامل يمنع dispatch إذا تغيرت النسخة المعتمدة بعد Queue. لا يعد قبول create أو sync تحققاً من التسليم.

اختبار الاتصال يسمح بالقوالب المدعومة الثابتة فقط؛ BODY متغيرة لا تظهر ضمن خياراته حتى لو كانت معتمدة. اختر قالباً ثابتاً بعد Refresh templates ورقم اختبار مصرحاً، وأكد الموافقة. Manager تدير اتصال فرعها، واتصال Organization تديره Super Admin. القوالب ذات HEADER أو URL variable لا تظهر في اختبار الاتصال حتى لو كانت BODY ثابتة؛ static URL/PHONE_NUMBER buttons مدعومة؛ Quick Reply تستبعد من اختبار الاتصال لاحتياجها Conversation context؛ media headers تستبعد أيضاً لغياب Customer attachment context في test-send؛ استخدم Conversation للإرسال. Browser تستخدم provider fake ولا تثبت اعتماد Meta أو تسليمه الحقيقي.

### تشغيل Quick Reply

من نموذج القالب اختر نمط Quick Reply وأدخل حتى3 labels ثابتة، حتى25 حرفاً لكل label؛ لا تخلط CTA ولا تضف variables. بعد approval/sync وربط Campaign، اختر القالب من Conversation. preview يعرض labels كنص ولا ينفذ الزر؛ العميل يضغط الأزرار في تطبيقه بعد الإرسال. الخادم يولد payload خاصة لكل Message/زر ولا يحتاج إدخالها من المستخدم. recovery المؤهلة تعيد الرسالة نفسها وtokens نفسها، ولا تعيد إنشاء reply context.

الرد الوارد الموقّع يظهر كنص مع رابط إلى Message الأصلية ورقم الزر ضمن Conversation المصرح بها. لا يغير Contact consent أو DNC أو Lead workflow/Controller ولا ينفذ Automation تلقائياً. إذا سبق الرد حفظ ACK تظهر reference pending في Review؛ بعد ACK يستطيع المسؤول المصرح حلها إلى Conversation المصدر فقط. المرجع المزور/المجهول أو label/context/participant المخالفة أو Conversation مغلقة تبقى Needs Attention، ولا تتجاوز قواعد المطابقة باختيار Lead أخرى. يمكن مراجعة النص وتجاهل الحدث بسبب وفق الصلاحيات الحالية. Agent لا يحصل على raw tokens أو أحداث اتصال خارج نطاقه. لا Quick Reply recovery/review Browser أو Meta live؛ integration تغطي هذه الحالات بcallbacks موقعة اختبارياً.

### عينات اعتماد media templates

من Connection اختر **عينات اعتماد القوالب**، والنوع Image/Video/PDF والملف. الواجهة تعرض MIME/size profile من الخادم؛ الفحص الفعلي يعتمد على bytes وscan وcodec للفيديو، وليس اسم الملف. Upload تنشئ QUEUED مفحوصة في private storage ثم تعالجها `worker:media`. هذه عينة إدارية لا تُرسل للعميل ولا تعني approval لقالب. access token يجب أن يكون تابعاً لتطبيق Meta مخول للرفع؛ sample adapter تستعمل app alias فلا تحتاج تعديل server أو App ID hardcoded. الإدارة تحافظ على متطلبات حساب/app/token لدى Meta من setup الموجودة.

استخدم **تحديث العينات** ثم **محاولات رفع العينة** لمعرفة الحالة والخطأ الآمن؛ بعد FAILED أصلح provider/credential/storage/scanner failure وأدخل سبباً ثم **إعادة رفع العينة للمزود**. لا retry أثناء RUNNING/READY، ولا تتجاوز scan malware؛ بعد تغيير Connection تصبح READY قديمة غير صالحة، فارفع ملفاً بعينة جديدة. Provider reference تبقى مشفرة ولا تعرضها الواجهة. **تحميل العينة المفحوصة** تنزيل خاص بعد authorization/hash/size، وليس inline PDF/HTML؛ malware المكتشفة لاحقاً تحجبه. Manager لاتصال فرعها، وOrganization shared للمسؤول الأعلى، وAgent لا تصل إلى عينات الإدارة. Browser تحقق VIDEO/failure/retry/download وArabic mobile فقط، وintegration تتحقق PNG/PDF/video profile/failures؛ لم يُتحقق Meta live. media template create/send متاحة بالمسار التالي؛ العينة الإدارية لا تستخدم كملف عميل.

### إنشاء وإرسال Media Template

بعد READY لعينة الاعتماد، اختر HEADER Image/Video/Document من نموذج Meta templates، ثم حدّث العينات واختر عينة مطابقة صراحة. أدخل BODY وأمثلتها وFOOTER/buttons المسموحة، ثم Submit template. PENDING ليست قابلة للإرسال؛ بعد اعتماد Meta استخدم Sync approvals ثم السماح من Campaign templates. لا تدخل provider handle أو URL للملف، ولا تعدل records/credentials عبر CLI. أي تغيير Connection يجعل reference القديمة غير صالحة ويلزم عينة جديدة.

في Lead Conversation المصرح بها، اختر TEMPLATE المعتمدة وأدخل BODY values، ثم ارفع Customer template header file من النوع المطلوب للفحص. ملف العميل مستقل عن sample، ويخضع لbytes/type/size/scan/codec/private storage وController/Lead ACL؛ لا تستخدم مثال الاعتماد كملف إرسال. Download في preview لا يرسل Message، وrefresh يحفظ draft؛ Queue message تنشئ النية مرة واحدة وتُمسح المسودة بعد النجاح. خارج freeform window يمكن استعمال template معتمدة عبر نفس السياسة؛ لا تتجاوز consent/DNC أو نافذة المؤسسة/الحملة.

العامل يرفع ملف العميل للمزود ثم يعيد فحص القواعد قبل Customer template dispatch. HEADER kind/content approval change تمنع الإرسال وتظهر TEMPLATE_CHANGED؛ بعد معالجة السبب ومراجعة Needs Attention المطلوبة يمكن للمؤلف الحالي المؤهل إعادة المحتوى الأصلي من Send details and attempts. UNKNOWN/accepted outcomes لا تملك resend recovery. السجل يحفظ body وملف HEADER الأصلي ولا يتغير عند تغيير Catalog أو assignment؛ التنزيل يتبع صلاحية Lead الحالية. Browser تحقق VIDEO rejection/recovery/download/Arabic mobile، وintegration تحقق IMAGE/VIDEO/DOCUMENT بfakes؛ لا Meta live أو IMAGE/DOCUMENT template Browser.

### workers المطلوبة الآن

بعد migrations `001`–`044` والبناء، شغّل `npm run worker:messaging` للإرسال و`npm run worker:events` لمعالجة inbound وDelivery callbacks، و`npm run worker:media` للملفات وعينات اعتماد القوالب. كل عملية لها `DATABASE_URL` ومفتاح التشفير المناسبان للبيئة نفسها. `worker:messaging` لم تعد تحل inbound/callbacks؛ غياب `worker:events` يبقي الأحداث محفوظة ومعلقة، ولا يضيعها أو يجعل قبول Webhook دليلاً على نجاح معالجتها. لا تُشغل worker بأسرار Production في بيئة الاختبار.

Worker الأحداث لا تتصل بمزود خارجي. `MESSAGING_EVENT_BATCH_SIZE` الافتراضي 50 (1–500)، و`MESSAGING_EVENT_POLL_MS` الافتراضي 2000 (100–60000)؛ هذه إعدادات deployment تقنية، وBusiness connections لا تزال من UI. تعرض صفحة Webhook أعداد pending/failed/Needs Attention وآخر معالجة وأقدم حدث معلق، ويمكن تصفية الحالة وقراءة سجل المحاولات. عند فشل DB/domain processing تحفظ backoff وخمس محاولات مع rollback لأي أثر جزئي. بعد FAILED أصلح السبب ثم أعد المعالجة من UI بملاحظة وversion؛ Manager اتصال فرعه أو Super Admin فقط. لا تعدل payload أو counters يدوياً، ولا تستخدم Event retry لإعادة إرسال Customer message.

اختبار integration شغّل worker الأحداث المترجمة كعملية Node مستقلة أثناء Provider send وهمية معلقة، وثبت استمرار inbound/Delivery؛ لا يثبت UI E2E أو Meta live. راجع `messaging-performance.md` لقياس burst قبل فصل HTTP ingestion وبعده.

شغّل `docker compose --profile media up -d clamav`، ثم تحقق من `docker compose ps` وصحة الخدمة. خدمة ClamAV لا تعرض ملفات الجهاز ولا تتلقى paths، ومنفذها مقيد بـlocalhost؛ تحتاج نحو 4 GiB RAM وفق إعداد Compose. يحدّث FreshClam signatures تلقائياً؛ adapter يرفض definitions أقدم من سبعة أيام. إعداد `infra/clamd.conf` يرفض الملفات المشفرة وتجاوز حدود الفحص. لا تستخدم scanner وهمياً في عملية التطبيق أو العامل الحقيقية.

اضبط متغيرات infrastructure في بيئة API وMedia worker: `CLAMAV_HOST` و`CLAMAV_PORT` و`MEDIA_MAX_BYTES` و`MEDIA_STORAGE_BACKEND`. Local للتطوير يخزن الملفات في `.local/media` خارج web root. بعد `npm run build`، شغّل `npm run worker:media` إلى جانب `worker:messaging` و`worker:events`؛ Media worker مستقل ولا يحتاج Business credential إضافية خارج إعداد Messaging في الواجهة. يمكن تشغيل `node dist/scripts/check-media-scanner.js` ببيئة ClamAV نفسها؛ يجب أن يقبل PDF اختبارياً ويرفض توقيع الاختبار الآمن لمضاد الفيروسات دون حفظه على disk. تحقق ذلك محلياً على ClamAV 1.5.4، ولا يثبت اتصال Meta/S3 حياً.

للإنتاج اختر صراحة `MEDIA_STORAGE_BACKEND=s3` وbucket خاصاً عبر `MEDIA_S3_BUCKET` و`AWS_REGION`، وcredentials deployment صريحة `MEDIA_S3_ACCESS_KEY_ID` و`MEDIA_S3_SECRET_ACCESS_KEY` و`MEDIA_S3_SESSION_TOKEN` اختيارية؛ لا يقرأ adapter ملفات `~/.aws` أو AWS profiles الشخصية، أو إعدادات endpoint لمخزن S3-compatible. لا تعط bucket public access؛ API وحده يحمل ويراجع ACL. Local ممكن فقط باختيار صريح ومسار خاص مشترك بين API والعمال، ويحتاج نسخاً احتياطية متسقة؛ لا يصلح disk مؤقت داخل replicas مستقلة. إعداد مخزن الملفات والـscanner هو infrastructure deployment، بينما credentials المزود وأرقام Messaging تدار من UI. تغيير backend أو bucket بدون نقل objects القديمة سيجعل قراءتها `MEDIA_STORAGE_UNAVAILABLE`؛ لا تغير metadata في قاعدة البيانات لتجاوز ذلك.

الأنواع المدعومة حالياً للوارد هي JPEG/PNG وPDF وOGG/MP3/M4A وMP4 وWebP sticker. يظهر المرفق في المحادثة بحالة `QUEUED/RUNNING` مع تعليق العميل كنص؛ التحميل محجوب حتى `READY`. عند malware/type/hash/size rejection يبقى `REJECTED` بلا bypass. عند provider/scanner/storage failure تحدث حتى خمس محاولات وbackoff، ثم `FAILED`؛ بعد معالجة السبب يستطيع Super Admin أو Manager ضمن النطاق طلب دورة جديدة من UI بملاحظة وversion، دون تعديل Message أو حذف سجل المحاولات. Agent يحمل مرفقات Leads المملوكة له فقط. Media الملتبسة تبقى في مراجعة Connection، والربط الصريح ينقل الصلاحية إلى Lead؛ لا تُخمن الحملة.

الإرسال الصادر من Composer يدعم JPEG/PNG/PDF وOGG/Opus وMP3 وM4A/AAC وMP4/H.264 مع AAC واحد أو بلا صوت، وWebP512×512 ثابتة/متحركة. اختر النوع المسموح لدى Sender ثم الملف وارفعه للفحص؛ image/document/video تدعم caption اختيارية، وaudio/sticker بلا caption وتعرض الواجهة إرسال أي نص برسالة مستقلة. تعرض الواجهة سقف infrastructure/provider، وهو5 MiB للصورة،16 MiB للصوت/الفيديو،100/500 KiB للملصق الثابت/المتحرك، وPDF حتى الحد الأدنى من100 MiB وحد infrastructure الافتراضي25 MiB. لا تقبل uploads غير المفحوصة أو codecs غير مدعومة؛ غياب ffprobe يظهر MEDIA_PROBE_UNAVAILABLE بـ503 ولا يحفظ READY. العامل يحفظ failure retryable دون provider call عند غياب probe؛ عالج installation ثم أعد المحاولة من history عند بلوغ DEAD، بلا تعديل DB يدوي.

الإرسال يخضع للـController وConsent/DNC والنافذة والسياسة؛ خارج نافذة Meta لا يرسل هذا المسار media freeform. Worker يرفع asset ثم يعيد فحص السياسة قبل customer dispatch؛ upload failure retryable، وUNKNOWN من send تحتاج مراجعة دون retry تلقائي. Office/AAC/AMR/3GP formats غير مدعومة حالياً؛ media template headers تستخدم مسار TEMPLATE المستقل أدناه، ولا تدعي capability دعمها. تحديث حدود المزود يتم ضمن adapter profile موثقة بعد مراجعة المصدر، ولا يغير حدود Business للحملة. refresh للمحادثة الحالية يحفظ draft؛ أزرار التحميل والفحص لا ترسل النموذج.

تضمّن backup ملفات التخزين الخاصة مع PostgreSQL ونسخ object versions/lifecycle المناسبة. لا تحذف object مرتبطة بـ`READY` أو Message تاريخية؛ ملفات `.part-*` المحلية ليست قابلة للتحميل، وتُنظف بعد انقطاع كتابة عند التحقق من أنها غير نشطة وضمن Media root فقط. لم يجر اختبار restore للمرفقات أو S3 live، ويبقي Coverage ذلك واضحاً.

## استرداد فشل إرسال Message

في Lead Conversation اختر **تفاصيل الإرسال والمحاولات** بجوار outbound Message. تعرض الحالة ومعرف المزود وتوقيتاته وQueue error وعدد محاولات worker، وسجل dispatch وDelivery events والاسترداد مع pagination. فشل رفع media قبل customer dispatch قد يملك Queue attempt دون dispatch attempt؛ هذا ليس فقداً للتاريخ. الصفحات تعيد فحص Lead access؛ Agent السابق يفقدها بعد إعادة الإسناد.

عندما يظهر إجراء إعادة القائمة، أصلح سبب الخطأ ثم أدخل سبباً واضحاً وأكد إرسال المحتوى المحفوظ نفسه. يشترط المؤلف البشري الأصلي الذي بقي Controller وصلاحية Lead، وFAILED/DEAD مؤكدة قبل قبول المزود. الطلب يحفظ Audit وversion/history ويمنح خمس محاولات worker إضافية دون تصفير الأرقام، ثم يعيد فحص السياسة قبل الإرسال. إعادة الطلب بالنسخة القديمة تعرض conflict ولا ترسل نسخة أخرى. تغيير DNC/Controller/Template/Scope أو تعطيل Sender يمنع المسار ولا يختار رقماً بديلاً.

UNKNOWN أو PREPARED/accepted outcome لا تستخدم هذا الإجراء، وكذلك FAILED بعد قبول/Delivery callback. راجع المزود وNeeds Attention وفق الإجراء السابق؛ إزالة سبب المراجعة لا تسمح بإعادة Message مجهولة. لا تغيّر Message/Job states أو Provider ID يدوياً. إذا تولّى مستخدم آخر المحادثة، لا يغير author في سجل سابق؛ يبدأ Message جديدة بهويته الحالية من composer وفق السياسة. تحقق المسار بPostgreSQL وfakes، وبBrowser لمساري Human TEXT وVIDEO template؛ لا Meta live أو standalone attachment recovery Browser.

## الاختبارات العامة والنسخ الاحتياطي

`npm test` يشغّل اختبارات الوحدة الحالية. `npm run typecheck` و`npm run web:typecheck` و`npm run web:build` تفحص البناء. لا تُعتبر هذه بديلاً عن integration/E2E/load tests الواردة في `06`.
`npm run test:integration` يستخدم Email adapter وهمياً، ولا يتصل بمزود بريد حقيقي. يتطلب تحقق SMTP sandbox/live حساباً أو Credential مخصصة ومصرحاً بها؛ حالياً الحالة `Live Verification Pending External Credential/Approval`. لا تشغّل worker ضد اتصال Production أثناء الاختبارات.

لاختبارات API: أنشئ قاعدة منفصلة `lead_operations_test` داخل حاوية المشروع (`docker compose exec -T postgres createdb -U lead_operations lead_operations_test` مرة واحدة). اضبط `DATABASE_URL` على هذه القاعدة وطبّق `npm run db:migrate`، ثم اضبط `TEST_DATABASE_URL` على الرابط نفسه وشغّل `npm run test:integration`. الاختبار يرفض أي اسم قاعدة غير `lead_operations_test` ويفرّغ بياناتها قبل كل تشغيل؛ لا توجهه إلى قاعدة التطوير أو الإنتاج. لا تعرض روابط الاتصال أو كلمات المرور في السجل. قاعدة التطوير نفسها تبقى منفصلة.

خطة الإنتاج هي نسخة PostgreSQL متسقة عبر `pg_dump`/managed snapshots مع نسخ ملفات object storage ذات الصلة، واحتفاظ محدد واختبار استعادة دوري في بيئة معزولة. يجب اختبار استعادة فعلية قبل اعتماد المنصة؛ لم يُجر هذا الاختبار بعد. migrations تُطبق قبل تفعيل نسخة التطبيق الجديدة، وبعد snapshot، ولا يُنفذ تعديل يدوي غير موثق لبيانات الإنتاج.

## الأسرار والتكاملات

### Browser E2E محلية

بعد migrations على `lead_operations_test` اضبط `TEST_DATABASE_URL` المحلية و`E2E_RESET_TEST_DATABASE=1` صراحة ثم شغّل `npm run test:e2e`. هذا يفرغ قاعدة الاختبار ويُنشئ fixtures؛ لا تشغله بالتوازي مع integration tests أو benchmark، ولا في production. تحتاج port4100 فارغة؛ harness ترفض reuse لخدمة موجودة. للاختبار على Windows استخدم `E2E_BROWSER_CHANNEL=msedge` (تحقق محلياً) أو `chrome` المثبتة، بcontext جديدة مؤقتة بلا حساب شخصي. في CI اترك channel غير مضبوطة وثبّت Browser الخاصة بـPlaywright عبر `npx playwright install chromium` في بيئة الاختبار المناسبة. لا تُحفظ cookies أو credential حقيقية أو profile مستخدم في الاختبارات. رحلات media template وMeta Source وSource bindings تعيدان استعمال storage state لجلسات Manager/Agent اصطناعية سابقة في الذاكرة فقط؛ quota login الإنتاجية10/15min تبقى مفعلة.

المسار الحالي يثبت Human text/recovery/control/history/ACL وDNC/UNKNOWN وXSS وArabic mobile/RTL وFrench/English، وaudio/video/animated sticker upload/send/download وcodec rejection وحفظ draft وعدم إرسال preview download؛ تشمل أيضاً إنشاء/اعتماد/ربط/إرسال قالب HEADER/BODY/FOOTER من الواجهة واختبار اتصال بقالب ثابت وLogout؛ CTA وdynamic URL suffix preview/history وQuick Reply create/bind/send/signed inbound/replay/history/link مع escaped labels وArabic390px؛ 9 Browser tests ناجحة، بما فيها approval sample VIDEO/failure/retry/download وVIDEO template منفصلة مع rejection/recovery/SENT/history/download/Arabic390px. تشمل أيضاً Meta Source create/discovery/questions/failure/rediscovery/disable/reconfigure/history/secrets/Agent denial/Arabic390px. تشمل أيضاً Super Admin shared Form grant وManager binding/edit/conflict/history/revoke-restore/explicit reactivate وAgent403/RTL390px، وMapping suggestions/typed preview/error-valid/normalization/Draft-Publish-Draft retains published/RTL390px. لا standalone media/text template recovery أو Messaging Connection setup أو كامل platform E2E. لقطات `.local/e2e/conversation-ar.png` و`mobile-fr.png` و`template-url-ar.png` و`quick-reply-ar.png` و`template-sample-ar.png` و`media-template-ar.png` و`meta-source-ar.png` و`source-binding-ar.png` و`source-access-ar.png` و`source-mapping-ar.png`، وtrace/screenshot failures داخل `.local/e2e/results`، وfixture ذات password/token اختبارية عشوائية داخل `.local/e2e/fixture.json`؛ جميعها ignored ولا ترفعها إلى Git. harness تغلق API وDB والـBrowser بعد الاختبار، ولا تتطلب إيقاف Docker؛ استخدم entrypoint الإنتاج المعتادة للتطبيق، وليس `test-e2e/server`.

للتحقق المحلي من Messaging burst استخدم `npm run benchmark:messaging -- --reset-test-database` بعد ضبط `TEST_DATABASE_URL` المحلية وتطبيق migrations؛ يفرغ بيانات `lead_operations_test` ويرفض development/remote database. لا تشغله بالتوازي مع integration tests؛ التقرير في `.local/performance/messaging-latest.json`. إعدادات workload والقياسات والحدود موثقة في `messaging-performance.md`؛ المزود وهمي ولا تثبت النتائج Meta live أو سعة إنتاجية.

`CREDENTIAL_ENCRYPTION_KEY` سر deployment مستقل عن Business-managed credentials؛ لا يُنشر ولا يُرسل للـAI. تغيير المفتاح يحتاج عملية تدوير تعيد تشفير الأسرار؛ لم تُنفذ واجهة التدوير بعد. لا تضف Credential حقيقية إلى التطوير الحالي. إعداد مزودي Meta وMessaging وPayment وEmail وAI من الواجهة لم يكتمل بعد، لذا لا تُستخدم Connections حقيقية أو تُعرض حالة نجاح مزيفة.
