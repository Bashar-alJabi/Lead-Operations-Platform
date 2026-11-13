# إشعارات المحادثات التي تحتاج انتباهًا — Native167

## المصدر والسلوك

ينشأ `CONVERSATION_NEEDS_ATTENTION` من انتقال فعلي في `conversation.needs_attention_reason` أو من إنشاء Conversation تحمل السبب فعلًا. لا تعديل للـController أوSender أوMessage/Delivery state من الإشعار،ولا ACK أوresend من عرضه أوقراءته أوإعادة محاولة نشره. `UNKNOWN` تبقى UNKNOWN حتى مراجعة مسارها الأصلي؛نشر الإشعار ليس محاولة إرسال للعميل.

Native observer تحفظ occurrence immutable عند تغير السبب،وتحفظ انتقال الإزالة أيضًا. تعديل الحقول الأخرى أو إعادة كتابة نفس السبب لا ينشئ occurrence جديدة. إذا أزيل السبب ثم ظهر مجددًا فهو انتقال جديد له حدث مستقل. `ordinal` متزايد وفهرس `(conversation_id,ordinal DESC)` يحددان آخر انتقال حتى إذا تكرر نص السبب سابقًا. Historical notice تبقى تاريخية إذا تغير السبب أو أزيل أو أُغلقت المحادثة؛لا تُعامل عودة نفس النص كأن أقدم occurrence ما زالت الحالية.

لا backfill للأسباب الموجودة قبل migration أو synthetic historical event. الموجود سابقًا يبقى ظاهرًا من مسارات Conversation/Needs Attention الحالية،ولا يُخترع وقت لبدء المشكلة.

## الفصل بين capture والنشر

قد يملك Messaging worker قفل Conversation بينما تملك إعادة الإسناد قفل Lead وتنتظر Conversation. لذلك تحفظ capture المصدر والجدول فقط تحت قفل Conversation،دون parent Lead/Branch/Campaign FK locks أو Audit publication أوتعديل جديد للمحادثة. parent UUIDs في المصدر historical snapshots مشتقة من Conversation/Lead الحقيقيتين؛FK الحالية Conversation→Lead تثبت العلاقة. لا تُزال قيود من الجداول السابقة.

النشر لاحقًا عبر `processOneConversationAttentionNotification` وبترتيب Branch → Lead → Campaign → Conversation → Queue. تتحقق native publication guard من المصدر والـcurrent scope وfresh queue publication. FK/shape الحالية لحدث الإشعار تضاف فقط بعد تلك الأقفال. لا تزوير لمصدر خارجي أوContext عبرGUC. تغيير Scope يمنع نشر الحدث ويترك `STALE_SCOPE` terminal؛لا تخمين Lead أوbranch،ولا إحياء تلقائي بعدعودةScope قديمة. status/history API تحجب المصادر التي لم تعد ضمن نطاق المورد الحالي.

هذا الفصل ضروري لحفظ actual UNKNOWN outcome حتى إذا فشل Notification Audit،ولتجنب عكس ترتيب Lead/Conversation locks. فشل نشر الإشعار يرجع event/queue publication معًا،ويترك source ونتيجة المراسلة الأصلية محفوظتين. الفشل أثناء capture نفسها يبقى failure للمعاملة الأصلية؛الـworker الأصلي يتبع recovery/UNKNOWN policy القائمة،ولا يوجد bypass لسلامة المصدر.

## سلامة المحتوى والصلاحيات

يُحفظ SHA256 داخلي للمقارنة فقط،ولا يخزّن هذا المصدر نص reason الخام. قائمة رموز محدودة ومجموعات ثابتة للـPinned Sender/Template،وبديل `REVIEW_REQUIRED` لأي قيمة أخرى. لا نص Provider error أوcredential أومحتوى عميل في Notification أوpublication history/DTO. الواجهة تعرض ترجمة آمنة للتصنيف،والقوالب plain escaped text بمتغيري `{{campaign}}` و`{{owner}}` فقط.

نفس Centre/indicator وself preferences/read CAS/history والصياغة Campaign→Branch→Global→Defaults لكل لغة. النوع متاح ضمن مجموعة Lead operational preferences وwording event selector؛لا صلاحية جديدة. current User/Session/Organization/Branch/Lead/Conversation access تنفذ في Backend وnative guards. Agent الحالي فقط يستطيع رؤية Lead وإشعاراتها؛Lead Owner يبقى مختلفًا عن Conversation Controller. Manager/Super Admin مخولان فقط لاستعادة publication متعطلة في نطاقهما الحالي،مع CAS وcurrent Session/Audit.

## التشغيل والاستعادة

تشغّل `npm run worker:notifications` النشر وFollow-up due بالتناوب،مع حد إجمالي25 عملية افتراضيًا في الدورة،وقيم `NOTIFICATION_WORKER_BATCH` بين1–100 و`NOTIFICATION_WORKER_POLL_MS` بين250–60000. قراءة candidates محدودة25 وفهرس ready queue و`statement_timestamp()`،ثم current validation. انتظار lock750ms وstatement5s داخل transaction فقط،ولاexternal I/O. source queues مستقلة ودائمة؛توقف العملية لا يفقدها.

النشر يعيد محاولات محلية محدودة مع1/2/4/8 ثوانٍ ثم `DEAD_LETTER` بعدخمس failures. تاريخ queue immutable لكلversion،ولا raw error فيه. من Lead → Customer conversations → View messages → «حالة إشعارات المحادثة» راجع المصادر والـstatus/failure count/history/pagination. بعد إصلاح سبب فشل DB استعمل إعادة محاولة حفظ الإشعار بصلاحية الإدارة؛لا SQL repair أوتعديل queue/time أوSender migration أوإعادة Message. الانتقال لإزالة السبب يظهر منفصلًا ولا يعني أن Delivery نجحت. أخطاء القراءة/الكتابة تمسح البيانات السابقة في المكوّن.

قبل rollout فعلي قِس CHECK/FK validation والـlocks على staging ونسّق API/UI/worker مع migration في نافذة مناسبة؛renderer القديم لا يعرف النوع الجديد. لم تُختبر قدرة إنتاجية أوrolling upgrade،ولا deployment مصرح حاليًا. Native167 مطبقة محليًا على development/test فقط،ولا migration مطبقة عُدّلت.

## الإثبات الحالي

Focused PG3/3 وBrowser1/1 (18.7s للرحلة) و178unit وBackend/Web build/typecheck ناجحة. actual API queue→Messaging worker UNKNOWN→durable source→eight concurrent publishers/read CAS/recovery requests،immutable/forgery/foreign/current ownership/session denials،source clearing/reappearance/redaction وpagination. failure fixture قبل actual send outcome أثبتت بقاء UNKNOWN وعدد provider calls=1 معفشلخمسمحاولاتالنشر،ثمcompiled notification worker تستعيدحدثًاواحدًا. actual concurrent assignment تملكLead وتنتظرConversation،بينماcapture تكملوتحررقفلها دونdeadlock؛الإشعارالأقدم يظهرللمالكالجديدكتاريخي.

Browser تثبتالفشل/history/استعادةManager،رفضAgent،تفضيلوصياغةمستقلين،readhistory،explicit original review منفصلة معبقاءUNKNOWN،وسحبالوصولوar/en/fr/RTL390px وno overflow/XSS/duplicate keys. الصورةالعربيةفُحصت. البوابةالنهائيةنجحت: **178unit و96/96full Docker PG** (243.4s) و**58/58full Edge Browser** (3.9m)،Backend/Web build/typecheck/diff check و001–167development/test. Native scope-change→STALE_SCOPE/no event/history denial مثبتةأيضًا. أولBrowserfull كشفتfixture substring collision؛عُزلاسمfixture الجديدةثمأُعيدتfull بنجاح دونتخفيفاختبارقديم.

هذهbaseline لإشعاراتConversation attention المرتبطة بـLead فعلية. unresolved/Lead attention وIntegration-System alerts والقنواتالمفعلة/mandatory policies وبقيةModules مازالتRequirements؛Notifications والمنصةغيرمكتملتين. كل البيانات اصطناعية وMessaging adapter test double لا ينفذnetworksend؛لاLive integration أوproduction credential أوMerge/deployment.
