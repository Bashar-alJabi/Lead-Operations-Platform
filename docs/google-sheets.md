# تكامل Google Sheets

## النطاق والحالة

المطلوب في 00 §54 و03 §§39–40 و06 §18 هو Import وExport من داخل المنصة، مع بقاء DB هي Source of Truth. المزامنة الثنائية المستمرة ليست متطلبًا افتراضيًا، ولا تُضاف دون قواعد عمل صريحة.

المنفذ حاليًا في `src/google/sheets.ts` و`test/google-sheets.test.ts` هو طبقة HTTP مستقلة تستخدم fetch قابلة للحقن وبيانات اصطناعية. الحالة **HTTP Mock Verified** فقط؛ لا Connection أوOAuth callback أوPicker أوjobs أوSetup UI مسجلة في التطبيق بعد. هذه ليست Google Sheets end-to-end، ولا تمنح صلاحية تشغيل حي. **Live Verification Pending External Credential/Approval**.

## عقد البروتوكول

تدعم الطبقة بناء consent URL مع state وPKCE/S256 وoffline access، وتبادل code وتجديد token، وقراءة subject من userinfo مع تجاهل profile/email غير اللازمة. استهلاك state وربطها بالحساب والجلسة والـConnection/version والتخزين المشفر مسؤولية طبقة Application التالية، ولم تنفذ بعد. لا يُستخدم Google login لإنشاء حسابات أوتغيير Roles في المنصة. [Google Web Server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)، [Discovery](https://accounts.google.com/.well-known/openid-configuration).

Scopes المطلوبة هي `openid` و`drive.file`، مع `include_granted_scopes=false`. اختيار `drive.file` يعني أن الملفات الموجودة تحتاج اختيارًا مقصودًا، مثل Google Picker؛ مجرد معرفة Spreadsheet ID لا يمنح file authorization. لا تُطلب Drive-wide scopes للبحث في كل ملفات الحساب. Scopes Google لا تعزل worksheet داخل Spreadsheet؛ لذلك يلزم current backend resource/range authorization مستقلة. [Sheets scopes](https://developers.google.com/workspace/sheets/api/scopes)، [Drive scopes وPicker](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

كل request إلى HTTPS host ثابتة، مع Bearer في header وredirects:error وdeadline10s وحدود UTF-8/JSON/stream bytes. لا provider URL من العميل ولا token في query. الأخطاء codes ثابتة دون raw provider content أوsecrets. كل method تنفذ request واحدة دون hidden retries. network/5xx/ACK غير صالحة لكتابة أوcode exchange تسجل `GOOGLE_RESULT_UNKNOWN`؛ يجب ألا تعيد Application رمزًا أحادي الاستعمال أوكتابةً مجهولة النتيجة آليًا. التجديد يحتفظ بالـrefresh token السابقة إن لم تعد Google واحدة جديدة؛ غياب scope يمكن قبوله فقط إذا قدمت Application scopes سبق التحقق منها، ولا يفترض grant مجهولة.

`metadata` تطلب properties فقط دون cell data، وتتحقق من Spreadsheet identity وsheet IDs/titles/grid properties وتبقي unsupported sheet types صريحة. A1 range تُولد من worksheet name وcoordinates محدودة، مع quoting للأسماء وapostrophes. `read` تستخدم ROWS/FORMATTED_VALUE، وتحفظ physical row numbers و`0` و`false` وleading zeros وsparse cells. القيم strings غير موثوقة؛ لا تُنفذ Formula أوHTML ولا يُخمّن locale. [spreadsheets.get](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get)، [values.get](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get).

`writeRaw` تستخدم range صريحة و`valueInputOption=RAW` فقط، وتحول null إلى string فارغة لمسح القيمة المقصودة. تُطابق Spreadsheet/range وأعداد updated rows/columns/cells قبل قبول ACK؛ partial أوmalformed ACK ليست نجاحًا. RAW تبقي formula-looking strings نصًا وفق عقد Google؛ الاختبارات HTTP mocks وليست live formula verification. [values.update](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update)، [RAW semantics](https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueInputOption).

Budgets الحالية تقنية: response8MiB قابلة للضبط حتى16MiB، deadline10s حتى30s، metadata2000sheet، read/write window حتى1000rows و64columns، 8192characters/cell، و8MiB encoded write body محسوبة قبل إنشاء JSON الكاملة. لا truncation. هذه حدود التطبيق وليست Google capacity guarantees. يلزم مواءمة window/serialization مع كامل Field types وقيمها قبل إعلان Export مكتملة؛ لا خفض صامت لقيم المنصة.

## الخطوة التالية المطلوبة

Native185 تبدأ managed Connection/OAuth lifecycle: encrypted client credentials وsealed PKCE verifier/tokens، current SA/Manager/Organization/Branch/Session، one-time state وversion/subject fences، durable exchange/refresh outcomes وhistory/Audit وtest/reconnect/disable/error UI. UNKNOWN لا يعيد code exchange؛ ينشئ المستخدم authorization جديدة عند الحاجة. لا client secrets أوstored refresh tokens في المتصفح.

يبدأ Google Cloud setup من UI مع تعليمات إنشاء App/consent وOAuth Web Client وredirect URI دقيقة وAPI prerequisites، ثم Picker/resource selection بحسب الصلاحيات. لا developer account أوbusiness env edits. يمكن بناء واختبار كل ذلك بـHTTP/browser mocks دون credentials حقيقية. لا تُعد Connection connected لمجرد callback أوcustomer claim؛ تحتاج subject/grant proof وcurrent context.

بعد استقرار الاتصال: explicit Spreadsheet/worksheet/range snapshot →Mapping/validation/preview/duplicate review →shared approved intake/results، ثم current-scoped Export مع durable immutable payload/reconciliation تحت Authorization الحالية. لا fake MetaConnection أوHuman Session أوpipeline Lead مستقلة لكل source. تبقى import/export/managed UI وIntegration/Browser tests مطلوبة قبل baseline Google كاملة.
