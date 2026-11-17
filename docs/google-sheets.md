# تكامل Google Sheets

## النطاق والحالة

المطلوب في 00 §54 و03 §§39–40 و06 §18 هو Import وExport من داخل المنصة، مع بقاء DB هي Source of Truth. المزامنة الثنائية المستمرة ليست متطلبًا افتراضيًا، ولا تُضاف دون قواعد عمل صريحة.

checkpoint `9c3e395` أثبتت HTTP adapter. Native185 تضيف managed Connection/OAuth وAPI وواجهة ar/en/fr،واجتازت201Unit و145fullDockerPG(409.5s) و69fullEdgeBrowser(11.0m) و001–185development/test وBackend/Webbuild/typecheck. الحالة **HTTP/Consent Mock Verified**،ولا Picker أوSpreadsheet/worksheet/range approval أوImport/Export jobs بعد. هذه ليست Google Sheets module end-to-end،ولا تمنح تصريح تشغيل حي. **Live Verification Pending External Credential/Approval**.

## عقد البروتوكول

تدعم الطبقة بناء consent URL مع state وPKCE/S256 وoffline access،وتبادل code وتجديد token،وقراءة subject من userinfo مع تجاهل profile/email غير اللازمة. Native185 تنفذ استهلاك state وربطها بالحساب والجلسة والـConnection/version والتخزين المشفر كما يلي. لا يُستخدم Google login لإنشاء حسابات أوتغيير Roles في المنصة. [Google Web Server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)، [Discovery](https://accounts.google.com/.well-known/openid-configuration).

Scopes المطلوبة هي `openid` و`drive.file`، مع `include_granted_scopes=false`. اختيار `drive.file` يعني أن الملفات الموجودة تحتاج اختيارًا مقصودًا، مثل Google Picker؛ مجرد معرفة Spreadsheet ID لا يمنح file authorization. لا تُطلب Drive-wide scopes للبحث في كل ملفات الحساب. Scopes Google لا تعزل worksheet داخل Spreadsheet؛ لذلك يلزم current backend resource/range authorization مستقلة. [Sheets scopes](https://developers.google.com/workspace/sheets/api/scopes)، [Drive scopes وPicker](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

كل request إلى HTTPS host ثابتة، مع Bearer في header وredirects:error وdeadline10s وحدود UTF-8/JSON/stream bytes. لا provider URL من العميل ولا token في query. الأخطاء codes ثابتة دون raw provider content أوsecrets. كل method تنفذ request واحدة دون hidden retries. network/5xx/ACK غير صالحة لكتابة أوcode exchange تسجل `GOOGLE_RESULT_UNKNOWN`؛ يجب ألا تعيد Application رمزًا أحادي الاستعمال أوكتابةً مجهولة النتيجة آليًا. التجديد يحتفظ بالـrefresh token السابقة إن لم تعد Google واحدة جديدة؛ غياب scope يمكن قبوله فقط إذا قدمت Application scopes سبق التحقق منها، ولا يفترض grant مجهولة.

`metadata` تطلب properties فقط دون cell data، وتتحقق من Spreadsheet identity وsheet IDs/titles/grid properties وتبقي unsupported sheet types صريحة. A1 range تُولد من worksheet name وcoordinates محدودة، مع quoting للأسماء وapostrophes. `read` تستخدم ROWS/FORMATTED_VALUE، وتحفظ physical row numbers و`0` و`false` وleading zeros وsparse cells. القيم strings غير موثوقة؛ لا تُنفذ Formula أوHTML ولا يُخمّن locale. [spreadsheets.get](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get)، [values.get](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get).

`writeRaw` تستخدم range صريحة و`valueInputOption=RAW` فقط، وتحول null إلى string فارغة لمسح القيمة المقصودة. تُطابق Spreadsheet/range وأعداد updated rows/columns/cells قبل قبول ACK؛ partial أوmalformed ACK ليست نجاحًا. RAW تبقي formula-looking strings نصًا وفق عقد Google؛ الاختبارات HTTP mocks وليست live formula verification. [values.update](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update)، [RAW semantics](https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueInputOption).

Budgets الحالية تقنية: response8MiB قابلة للضبط حتى16MiB، deadline10s حتى30s، metadata2000sheet، read/write window حتى1000rows و64columns، 8192characters/cell، و8MiB encoded write body محسوبة قبل إنشاء JSON الكاملة. لا truncation. هذه حدود التطبيق وليست Google capacity guarantees. يلزم مواءمة window/serialization مع كامل Field types وقيمها قبل إعلان Export مكتملة؛ لا خفض صامت لقيم المنصة.

## managed Connection/OAuth — Native185

`GOOGLE/GOOGLE_SHEETS` تستعمل integration_connection وconnection_secret الحالية. Super Admin تدير نطاق المؤسسة أوالفروع،وManager نطاق فرعها فقط؛Agent محجوبة من API مباشرة. Connection identity تشمل Organization/Branch/provider/clientId ولا تتغير؛اسم الاتصال وSecret وreconnect/disable تخضع لنسخة CAS وreason وreal current Session/history/Audit. يلزم Connection جديدة لتطبيق OAuth آخر. Shared operational resource grants ستُنفذ مع اختيار الملفات؛وجود Organization Connection لا يمنح Manager حق إعدادها أوقراءة credentials.

يبدأ Google Cloud setup من UI مع تعليمات إنشاء مشروع المؤسسة وGoogle Auth Platform وAudience/Test users وData Access وOAuth Web Client وredirect URI دقيقة. لا developer account أوbusiness env edits. Client secret تستعمل AES-GCM الحالية،وPKCE/results مشفرة تحت AAD مختلفة لكلoperation. APIs/الواجهة/history/Audit لا تعيد client secrets أوrefresh/access tokens أوstate/verifier أوprofile/email. Client ID عامة وليست credential سرية. APP_ORIGIN من إعداد النشر الحالي تحدد callback وعودة ثابتتين؛HTTPS مطلوبة باستثناء development loopback الصريحة. cookie SameSite=Lax الحالية تكفي؛لا إضعاف لـAuthentication.

state عشوائية32bytes،وتُخزن SHA256 فقط؛verifier عشوائية48bytes معS256. WAITING لها10دقائق وRUNNING60ثانية بساعةDB،وهذهbudgets تقنية وليست provider guarantees. callback تحتاج نفس حساب المنصة و**نفس Session الأصلية** وRole/Branch الحالية. يتمقفلConnection ثمclaim RUNNING معAudit قبلأيHTTP،وتنتهيtransaction قبلcode exchange/userinfo. pending operation واحدة لكلConnection؛concurrent callback لا تعيدcode،والـterminal replay لا تستدعيProvider. state/requests query لا تُسجل،والردود no-store/referrer-policy:no-referrer.

CONNECTED تحتاج grant/scopes المطلوبة وrefresh token وsubject منuserinfo الموثوقة عبرTLS/current context،لاsuccess URL أوcustomer claim أوdecoded id_token. أول subject تُحفظ SHA256 ثابتة؛account mismatch لا يبدل الحساب،ويحتاج المستخدم Connection جديدة إن أراد حسابًا آخر. CHECK تجدد token ثمتعيدsubject verification؛refresh token الغائبة فيrefresh تُستبدل بالسابقة المرتبطةبنفسgrant المثبتة،وscope الغائبة تستعملprevious verified scopes فقط. لا customer/Lead data فيهذهالطلبات.

عندتغير Session/Role/Branch/connection version أوتعطيلالاتصال أثناءHTTP،تحفظالاستجابةمشفرّةكـSUPERSEDED ولا تُفعّل. Native guards تثبت current scope/real Session وtransitions وfresh configuration/credential revisions وimmutable identity/history،وAudit failure ترجعالآثارذريًا. الناتج بعدUNKNOWN أوفشلidentity/auth يحتاجموافقةجديدة؛لاcode replay تلقائية. إذاانهارتالعملية بعدإرسالcode وقبلحفظالنتيجة،تبقىRUNNING ثمتصبحUNKNOWN بعدانتهاء60ثانية عندبدءموافقةجديدة. هذهالمهلةاختُبرتفعليًادونتعطيلguards أوتعديلexpiration التاريخية.

الواجهةتعرضscopes/callback قابلًاللنسخ وencrypted create/rotation وauthorize/test/reconnect/disable وstatus/last success/failure وattempts/history بصفحات20(max100 فيAPI). failed/revoked reads تمسحالسياقالقديم. تعطيلالاتصال إيقافمحليمعاحتفاظبالتاريخ؛لايدعيrevoke لجهةGoogle. الاختبارات Google HTTP وconsent mocks ببياناتاصطناعية؛ليست Google Cloud consent أوtoken rotation حية. كلحالات Live verification مازالتpending.

## Managed Picker prerequisites — Native186

`google_picker_settings` تحفظproject number وAPI key مشفّرةبـAAD مستقلة`google-picker:<connectionId>`،بمعزلعنOAuth client secret حتىلاتتطلبkey rotation إعادةموافقةOAuth. write تحتاجversion الحاليةللإعدادات وconnectionVersion الحالية،وreal Session/Role/Organization/Branch؛DISABLED تمنعالكتابة. Client ID وscope وهويةحسابGoogle لاتتغيربهذهالإعدادات. configuration version وkey revision منفصلتان لتتبعمتىتغيّرkey فعلًا،وتركهافارغةيبقيciphertext الحالية. Native guards وimmutable metadata history وAudit تحفظالعمليةذريًا،دونقيمةkey فيGET/history/logs.

الحفظCONFIGURED_NOT_VERIFIED صريح؛لاProvider call أوGoogleOAuth operation أوfile/Lead/financial effect،ولاتكتسبCampaign/Branch resource access. الواجهة ar/en/fr تعرضprerequisites وwebsite patterns باتجاهLTR وkey retention/rotation وCAS failures/history/failed-read clearing. **201Unit و146fullPG(529.2s) و70fullBrowser(6.2m) و001–186development/test وBackend/Webbuild/typecheck** ناجحة. scope aria-label وRTL wildcard direction صُححتاوالصورةالأخيرةفُحصت. لاPicker SDK أوtickets/selection أوresource metadata/grants تنفيذيةبعد؛هذهNative187 التالية.

الواجهة تشرح مشروعOAuth نفسه،وتفعيلPicker API وتقييدkey إلىorigin المنصة و`https://docs.google.com/*`. لا يُستنتجproject number منClient ID. Picker تحتاجaccess token للملفاتالخاصة؛مرحلةselection ستستعملهذهفقطللعملية،دونClientSecret/refresh token. [Google Picker prerequisites](https://developers.google.com/workspace/drive/picker/guides/web-picker).

## الخطوة التالية المطلوبة — Native187

بعدحفظNative186: dedicated Picker page/tickets/selection وindependent metadata/current resources/explicit shared-use grants،ثمSpreadsheet/worksheet/range snapshot →Mapping/validation/preview/duplicate review →shared approved intake/results،ثمcurrent-scoped Export معdurable immutable payload/reconciliation. يلزمGoogle source provenance فعلية،ولاfake CSV upload/MetaConnection/Human Session أوpipeline Lead مستقلة. هذهالوظائفواختباراتهاIntegration/Browser مازالتمطلوبةقبلbaseline Google كاملة.
