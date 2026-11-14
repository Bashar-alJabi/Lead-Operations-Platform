# Analytics التشغيلية — Native169

## مصدر الأرقام والنطاق

كل الأرقام من PostgreSQL وخدمات المنصة، دون LLM أوProvider API. القيم المحسوبة في العميل تقتصر على formatting والتواريخ ومدخلات الفلاتر؛لا يُجمع المال في JavaScript. `analytics_payment_fact` read projection فوق Payment والطلب المالي الأصلي فقط، وليست مصدر صلاحية أوطريقة لإنشاء تأكيد مالي. Native guards السابقة تبقى المرجع للتأكيد وEnrollment.

تبدأ overview وgroups وHuman authors وdrilldown من نفس `leadPredicate` المشترك مع قائمة Leads. يتحقق من Organization وBranch وAssigned Agent الحالي، وعلاقة Campaign بالنطاق الحالي. يتطلب كل request Session حقيقية وحسابًا ودورًا ونطاقًا حاليين؛تُعاد فحوص Session قبل الرد، مع Audit آمنة لا تسجل قيم الفلاتر أوبيانات العميل. لا يكفي إخفاء Dashboard في Frontend. كل Role يرى المسموح له فقط، ولا يمكن للـAgent استخدام Analytics للوصول إلى Lead أخرى.

الفلاتر الحالية: Date وBranch وCampaign وcurrent Assigned Agent وSource وLifecycle وFollow-up وConversation state/controller وrelevant stored Field equality. أُضيفت Payment/Enrollment/Attention وfinancial mode إلى shared list/filter contract وSaved Views أيضًا. شرط Conversation state/controller يطابق Conversation واحدة تحقق الشرطين؛بعد اختيار مجموعة Leads يحسب التقرير تاريخها المرتبط كله، لا الرسائل من تلك Conversation وحدها.

Field filter يمر عبر نوع Field وvalidation وactive/filterable binding وcurrent role visibility، ويعيد فحص visibility ضمن query نفسها. لا تُستخدم Field مخفية للتسريب عبر counts. إذا لم يعد للـAgent أيLead مخولة فيCampaign،ترجع collection/aggregate نتيجة فارغة200 قبلقراءةField metadata أوvalidation قيمتها؛تبقىmetadata resource محجوبة404. هذايحافظعلىعقدالبحثالقديمدونكشفوجودField أوtypes منرسائلvalidation. يدعم editor القيم typed بما فيها false/zero وmulti-select/tags/currency؛المطابقة equality للقيمة المهيكلة المخزنة. Calculated Field filters تبقى محجوبة صراحة حتى استكمال query support المناسبة لها؛لا arbitrary formulas أوSQL من المستخدم.

## معنى التاريخ والتوقيت

الأساس المعروض هو **CURRENT_LEAD_CREATED_COHORT**: الفترة ترشح `lead.created_at` بشمول الحدين، ثم تعرض الحالة الحالية والتاريخ المرتبط بهذه المجموعة. لا تتحول Date Filters بصمت إلى `payment.confirmed_at` أووقت Message. تظهر timezone مدخلات المتصفح، وتُرسل ISO timestamps صريحة. query وkeyset cursors يحافظان على دقة PostgreSQL microseconds باستخدام text cast، دون إعادة تحويل cursor إلى JavaScript Date.

هذه مجاميع تشغيلية للـLeads الواقعة حاليًا ضمن Scope المستخدم، وليست تقرير إسناد مالي تاريخي حسب Branch/Campaign وقت التحصيل، أوتقرير محاسبي، أوpoint-in-time snapshot. بيانات الطلب المالية الأصلية تبقى immutable. تغيير الملكية يسحب وصول الموظف السابق؛لا يمحو التاريخ أوينقل credit الرسائل إلى المالك الجديد.

## Payment وEnrollment والعملات والأوضاع

تعرض Payment states من `payment_record` فقط، وليس عدد requests أوcustomer claims أوsuccess pages. Revenue تجمع `amount::numeric` من الأصل immutable للـconfirmed records. Enrollment كيان مستقل، لا تُحسب إلا المرتبطة بـPayment مؤكدة وبنفس Lead. لا تضاعف Enrollment إيراد Payment.

`paymentMode` افتراضيًا **LIVE** للقراءة فقط، مع TEST وALL صريحتين في الواجهة. اختيار LIVE لا يفعّل أي Integration أوcredential. عند ALL تظل مجاميع Revenue مفصولة بحسب mode وcurrency؛لا جمع TEST مع LIVE، ولا جمع عملات مختلفة أوتخمين exchange rate. المالية تُرجع decimal strings دقيقة حتى إذا تجاوز المجموع JS safe integer. JSON counts strings أيضًا لتجنب فقدان الدقة مع النمو.

## Conversion

تُقرأ `campaign.conversion_config` الحالية ونسخة Campaign. النوعان الحاليان في Setup هما PAYMENT_CONFIRMED وENROLLMENT_CONFIRMED. لا تستنتج المنصة conversion من AI qualification أوStatus أوأي اسم تجاري. المجموعة التي بلا تعريف تُعرض كغير محددة، ولا تظهر نسبة افتراضية لها.

في إجمالي عدة Campaigns: numerator هو عدد Leads ذات milestone الموثوقة بحسب تعريف حملتها؛denominator هو Leads في Campaigns ذات تعريف صريح فقط. يظهر configured/unconfigured denominator في الواجهة. Campaign breakdown تعرض التعريف والنسخة المستخدمة لكل حملة. هذه قراءة للتعريف الحالي، وليست attribution تاريخية لنسخة إعداد سابقة. Field/Status milestones الأخرى لا تُعرض كمنفذة قبل دعم Setup/rules/tests الخاصة بها.

## التواصل والأداء البشري

المقاييس مستقلة:

- Lead received: `lead.created_at`.
- First platform contact: أقدم OUTBOUND ذات `sent_at`، من أي author type.
- First AI/Human contact: أقدم OUTBOUND مقبولة من النوع المعني؛تبقى هذه حقائق تاريخية للـLead ولا تعني attribution إلى مالكه الحالي.
- First customer response: أقدم INBOUND بعد أول platform outbound؛الاستفسار inbound قبل تواصل المنصة ليس ردًا عليه.
- AI/Human attempts: عدد Message records المرسلة ذات `sent_at`، وليس raw HTTP retries أوqueued/UNKNOWN بلا وقت إرسال موثوق.
- AI/Human response: أول رد من النوع المعني بعد أول inbound على مستوى Lead. المتوسط من العينات المتاحة فقط، مع sample count؛عند غياب العينة تكون القيمة null، وليست صفرًا. هذا ليس Conversation SLA ولا متوسط كل الردود.

Human attempts/response وauthor performance تستخدم `author_user_id` الحقيقي. Agent يرى attribution لنفسه فقط ضمن Leads المسموح بها حاليًا. عند اختيار Agent في تقرير الإدارة يُرشح current lead ownership ويُقيد Human attribution لذلك الكاتب؛AI metrics تبقى منفصلة. جدول Human authors يجمع الرسائل حسب كاتبها الفعلي، ولا ينسب رسائل موظف سابق أوسرعة AI إلى المالك الحالي. لا تُفعّل هذه الشريحة Performance routing قبل sample/scoring policy واختباراتها.

أعداد AI/Human-collected answers تعني وجود إجابات ظاهرة بحسب المصدر وField permissions فقط. لا تدعي qualification completion أوconversion. Aggregate completion/source attribution الدقيقة وفق policy المنشورة وصلاحيات الأسئلة تبقى متطلبًا مستقلًا يحتاج أدلة، ولا يُستبدل بمجرد وجود answer.

## Backend/UI والتشغيل

واجهات GET التالية تشترك في query/filter contract:

- `/api/analytics/overview`: scalar/grouped server-side facts وas-of ومعلومات cohort/mode.
- `/api/analytics/groups`: Branch/Campaign/Source مع keyset pagination والتعريف المناسب.
- `/api/analytics/agents`: Human message authors وعينات استجابتهم؛لاAI credit.
- `/api/analytics/leads`: metric-specific Lead drilldown بصفحات حتى50، مع first-contact timestamps وروابط تفاصيل Lead الحالية.

لا تُحمّل آلاف Lead/Message rows في العميل. القراءة داخل CTEs/aggregates في قاعدة البيانات، مع فهارس cohort/message/conversation/follow-up وstatement timeout8s وlock timeout750ms. date filters تساعد على تضييق datasets الكبيرة. الصفحات bounds وليست Capacity guarantee. لا caching يتجاوز ACL أوrollup يختلق حالة حالية. التقارير متعددة الطلبات حية، وليست snapshot مشتركة عابرة للطلبات.

من Analytics اختر الفلاتر ثم Load؛تظهر الأرقام وتعريفاتها ومجاميع العملة والمجموعات وأداء Human authors. اضغط metric لفتح Lead drilldown، أوFilter this group لتطبيق نطاق المجموعة، ثم افتح Lead عبر نفس backend authorization. أي read فاشلة تمسح التقرير القديم، والواجهة تدعم loading/empty/error وar/en/fr وRTL. Saved Views والبحث يعيدان استخدام نفس typed filters.

Native169 views/indexes فقط؛لا backfill أوتغيير مالي أوAI/customer send. قبل rollout يلزم قياس validation/index creation/locks على staging ووضع خطة migration المناسبة لحجم البيانات، وتنسيق API/UI مع وجود projection. لاproduction deployment مصرح حاليًا.

## التحقق والتغطية الحالية

البوابة النهائية المحلية ناجحة: migrations001–169 على development/test وBackend/Web build/typecheck و180/180 unit و104/104 full Docker PostgreSQL integration (338.5s) و60/60 full Edge Browser E2E (8.2m). focused regression7PG و2Browser ناجحة أيضًا. الاختبارات تشمل actual trusted Bank approval/duplicate confirmation وmulti-currency/TEST-LIVE/decimal sums فوق JS safe range،وactual proven AI send بلا Human credit،وملكية ورسائل مؤلفين مختلفين وField visibility،وmicrosecond pagination،وrevoked Session/Audit rollback،و5000 Lead مع response bounds. لا تمثل هذه القياسات sustained production capacity guarantee.

Browser تثبت actual Leads/Bank/Enrollment وdrilldown وscope revocation وfailed-read clearing وar/en/fr وArabic390px/Revenue cards بلا overflow/XSS/duplicate keys. صفحات25 اختيارًا تختبر بـHTTP mock معزولة عن catalog المشتركة؛تحتفظ UI بالاختيار وتعود لأول صفحة ثم API catalog الحقيقية. لم تُخفف اختبارات startup catalog أوPayment Methods أوtemplates القديمة لإرضاء البيانات الجديدة.

بقية aggregate qualification completion/source attribution وField/Status conversion milestones وsustained production-like load وcross-module acceptance ما زالت ضمن مراجعة الفجوات. هذه الشريحة Implemented وMock/PostgreSQL/Local Browser Verified فقط. وجود هذه الشاشة لا يعني أن Analytics أوالمنصة Complete أوLive Provider Verified؛كل Live integrations تبقى Pending External Credential/Approval والاستخدام الحي معطل.
