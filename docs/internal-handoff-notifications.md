# الإشعارات الداخلية لـHuman Handoff

## النطاق والاعتماديات

المصادر: 00 §38،01 §§40–41،02 §64،03 §§71/99،04 §§28–29،AGENTS §§8/9/15/27–30/38–39. هذه مرحلة In-App فعلية لطلب Handoff، وليست اكتمال Notifications أوSLA أوAI. لا تغيّر Lead Owner أوConversation Controller، ولا ترسل للعميل أوEmail/WhatsApp، ولا تعتمد علىAI Provider أوبيانات دفع.

بعد `ai_handoff_reception_event` من APPLIED Handoff الفعلية تحفظ Native135 `notification_event` مع source unique وOrg/Branch/Campaign/Lead/Conversation ووقت المصدر المشتق. Native guard تتطلب fresh receipt/history من المعاملة نفسها والحالة الحالية؛ لا يمكن إعادة إنشاء إشعار من diagnostic proposal أوreceipt قديمة، ولا تعديل/حذف الحدث. إخفاق notification Audit يلغي Handoff/receipt/history/notification معًا؛ durable Handoff job تبقى قابلة للمحاولة. ليست queue الحالية وحدها دليل delivery، ولا يُعاد اختراع أحداث قبل إضافة هذا المسار.

## الجمهور وIn-App delivery

الجمهور هو Lead Owner الحالية وManagers فرعها، وSuper Admin للمؤسسة. إشعار Managers عند التعذّر ليس assignment أوإذن إرسال. لا تعطِ configured target من نوعAgent غير Owner وصولًا عبرالإشعار. Notifications تقيم current audience عند القراءة؛ ليست fan-out محملة بكل المستخدمين في المعاملة. تظهر الأحداث المقبولة سابقًا كتاريخ عند انتهاء waiting، دون حذفها عند Human acceptance.

`GET /api/notifications` لديها keyset pagination بـlimit≤50 وlanguage ar/en/fr وunreadOnly. تقرأ identifiers محدودة أولًا، ثم تمسك Branches→Leads→Campaigns→Conversations بـSHARE بالترتيب، وتعيد فحص cookie/session والدور والنطاق، وتعيد query للجمهور الحالي قبل عرض البيانات. انتقال parent بعد القراءة الأولية يمنع إخراج old-scope event؛reassignment تسحب المركز/history/actions من المالك السابق وتتيح المسؤولية للمالك الجديد دون تغيير الحدث. Manager أجنبية/Agent غيرمالكة لا تحصل علىحزمة أومحتوى عبرالرابط. لا contact/message/Qualification/knowledge/credential payload في Notification DTO؛الرابط يفتح Lead المحكومةبالصلاحيات الموجودة.

`GET /api/notifications/indicator` تستخدم EXISTS،بلا total count أوتفاصيل Lead. UI تفحصها عندتغييرالصفحة/القراءة/التفضيل وكل30s،وتمسح المؤشر عندفشل القراءة أوتغيير المستخدم. هذاinterval تقني وليسSLA أوتحديثًا لحظيًا. لاAudit متكررة لكلpoll للمؤشر؛قراءةالمركز مؤرّشةبعددالعناصر واللغة فقط.

## read/unread والتفضيلات

- `PUT /api/notifications/:id/state` تتطلب boolean أصلية وversion صحيحة وactual current cookie؛لا userId منالعميل. default unread/version0. `notification_state` لكلUser/Event تحفظ CAS/version/time/session،وتفحص native current Lead access/session. Advisory key لكلUser/Event يسلسل first insert والتزامن، ولا يمنح صلاحية.
- `GET /api/notifications/:id/history` محفوظةلكلUser ضمن current event access،bounded قبلversion؛لا sessionId فيDTO. Native history لا تقبل old proof أوtime منالعميل،ولا تعديل/حذف. إخفاقAudit يلغي state/history معًا.
- `GET/PUT /api/notification-preferences` شخصيةلـAI_HANDOFF_REQUESTED/IN_APP،default enabled/version0؛actual self-session،CAS،strict JSON types،history/Audit native. لا تعديلتفضيل مستخدمآخر. هذاالحدث ليسmandatory افتراضيًا؛لا نضيف قاعدةتجارية غيرموثقة. Critical mandatory policy لبقيةevents مازالت مطلوبةضمنNotifications النهائية.
- التعطيل يخفي events فيمركزالمستخدم والمؤشر،ويُبقي history/state وwaiting queue. إعادةالتفعيل تظهرالأحداث المحفوظةحسبcurrent access؛ليست deletion أوإعادةتوليدevents/Customer messages. متطلباتالقنوات الخارجية والأحداث الأخرى تبقىغيرمنفذة.

## wording/templates

`GET/PUT /api/notification-templates/:scope/:id/:language` و`/history` تدعم GLOBAL/BRANCH/CAMPAIGN وar/en/fr. GLOBAL هناOrganization default ضمنالمؤسسة نفسها،تديرهاSuper Admin فقط؛Manager تديرBranch/Campaign الخاصةبفرعها،ولاAdministrative template access للـAgent. resource scope والدوروالجلسةتُعادبعدالانتظار؛disabled Branch تمنعsetup write. Stored template منparent scope سابق لا تُقرأ/تُستخدم بعدtransfer،حتى فيصفحةSuper Admin متعددةالفروع. لا استثناءACL أوsilent rebind؛Campaign transfer lifecycle النهائيةتحتاجمعالجةconfig/history المتأثرةصراحة.

لكللغة: active Campaign→active Branch→active Organization→safe built-in default. لاfallback عابرللغات. القوالب inactive لا تمنعالسلسلةالتالية. نصعاديbound title160/body1000،فقط `{{campaign}}` و`{{owner}}`،وتُرفضunknown/unbalanced placeholders/control characters. Substitution غيرrecursive ولا replacement-string interpolation؛Customer/Operator names والmarkup يعرضانplain text. reason/version وactual actor/session مع immutable derived-time history/atomic Audit. In-App النصيعملبالصياغةالحاليةوتعرضDTO source/version؛event history ليسsnapshot لصياغةdelivery قديمة. هذايسمحإدارةwording دونتعديلالسيرفر،ولا يغيّرmessage historical integrity لأنNotification ليستCustomer message.

UI تعرضالمركز/status/فتحLead وpreferences،وتتيح للإدارةscope/resource/language/active/title/body/reason وsample Preview وsafe default/history. Campaign selector paginated؛لاhardcoded provider/resource IDs. Fetch fences وتغييرscope/locale يمسحان old form/history،وفشلread/save لا يبقي تفاصيل كانت مصرحًا بها. عناصرtextarea/select لهاaccessible names صريحة. ar/en/fr وRTL390px وmarkup safety ضمنBrowser gate.

## التحقق والخطوة التالية

Unit: strict types/placeholders/Unicode bounds/nonrecursive rendering/fallback وold Branch denial. PostgreSQL: المصدر الفعلي وduplicates/blocked-source absence،scope/ownership/current session،eight-way state/preference/template CAS،parent transfer أثناءlock wait،immutable history/old receipt/native forged session/Actor denial وAudit rollback علىevent/Handoff/state/preferences/templates. Browser: Handoff→actual event→unread indicator→read/unread→history→mute/reenable وindependent Manager audience،ثمwording Branch/Campaign/Global وCAS/failed-read clear/Preview/no-XSS/fr/ar/RTL. النتائج العددية النهائيةفيprogress/coverage،ولاLive provider verification فيهذهالمرحلة.

**التالي:** Branch/Campaign SLA clock/timezone/calendar/working-hours policy وdurable timers/current reevaluation→owner reminder/Manager escalation→نفسNotification boundary بتمييزsource ودليلidempotency. ثمmandatory/Qualification-completion Handoff triggers بـatomic current proof،ثمCustomer Messaging وبقيةAI/Automation/Notifications/Analytics/import/export/Sheets/Email. لاauto AI reactivation أوfinancial action. Live AI/full activation تبقيان معطلتين.
