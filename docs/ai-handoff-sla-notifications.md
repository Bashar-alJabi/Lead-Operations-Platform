# تنبيه SLA وتصعيد المتابعة البشرية داخل المنصة

## النطاق — 2026-10-15

المصدر: `04` §§28–29/33،`00` §38،`01` §§40–41،`02` §64،`03` §§71/99 وAGENTS §§8/15/18/27–30/38–39. Native141 تكمل ربط [المؤقت الفعلي](ai-handoff-sla-runtime.md) بمركز الإشعارات. Timer/Breach وحدها لم تكن delivery؛ الآن fresh expiry→event→current authorized audience→UI/preferences/read history/wording مسار فعلي محلي.

هذه SLA In-App baseline، وليست اكتمال Handoff triggers أوAI أوNotifications لكل الأحداث والقنوات أوالمنصة. لا Email/WhatsApp delivery أوCustomer send،ولاOwner/controller أوPayment/Enrollment mutation. Live transfer/full activation معطلتان؛مصدرAI وProvider tests بياناتاصطناعية وHTTP mocks فقط.

## المصدر والذرية

بعد fresh immutable `ai_handoff_sla_breach` تحفظ `AI_HANDOFF_SLA_EXCEEDED` event فريدة بـ(event_type,source_id)، في transaction انتهاءTimer نفسها. Native guard تتطلب fresh timer EXPIRED وbreach منالمعاملةنفسها معtimerVersion مطابق وactual APPLIED request/current waiting source. Dates/scope/Lead/Campaign/Conversation مشتقة؛لاcustomer/Model claim أوrequest timestamp كدليل.

Snapshot breach تحفظ current `ownerAtObservation` لأغراضالتتبع؛الجمهور عندdelivery يظلcurrent Lead access وليسOwner التاريخية أوconfigured nonowner target. Source event واحدة ولاreplay منold breach/diagnostic/old APPLIED receipt. لاbackfill صامت لتنبيهاتbreaches المنتهيةقبلNative141. Legacy current waiting receipt المستوعبة فيTimer جديدة يمكن أنتنتهي بمصدرجديد موثوق،ولا تعيدAI action.

فشل Notification Audit يلغي Timer progress/expiry وbreach/event/history والأحداثالمترابطة كلها؛queue تقنية تسجلfailure ويعاد المحاولة ضمنالحدودالموجودة. Deferred final proof تحميcurrent scope/controller/active state/clock داخلالمعاملة. Terminal/idempotency تمنعتنبيهًا ثانيًا للطلبنفسه،ولا ambiguity خاصةبـProvider لأنالمسارDB محلي.

## Owner reminder وManager escalation

الإشعارالجديد مستقل عنinitial Handoff event،ولهunread state مستقلةلكلموظف. يظهر current Assigned Owner الفعّالةإنوجدت،ولـBranch Managers وOrganization Super Admin ضمنCurrent Lead scope. عندUnassigned يبقىManager/attention مسارالمتابعة،ولاrandom assignment أوACL للـconfigured target. إعادةالإسناد تنقلأهليةالقراءةدونتغييرالحدث؛Parent transfer تمنعقراءةحدثالنطاقالقديم حتىلـSuper Admin.

الـwaiting queue والحزمةباقيتان للمراجعة. بعدHuman acceptance لايزيدtimer/AI control،والإشعارالمقبوليبقىكتاريخ معwaiting=false. Source type لايمنحصلاحيةSend أوTool أوجلبQualifications/knowledge/attachments منرابطلايملكهالمستخدم.

## تفضيلات وصياغة مستقلة

`/api/notification-preferences` و`/api/notification-templates/:scope/:id/:language` تبقيانinitial Handoff compatibility. SLA تستخدم `/api/notification-preferences/AI_HANDOFF_SLA_EXCEEDED` و`/api/notification-templates/AI_HANDOFF_SLA_EXCEEDED/:scope/:id/:language` معhistory route. نفسcurrent session/role/scope/native CAS/Audit/validation؛Agent تملكpersonal preference فقط،وManager Branch/Campaign wording،وSAOrganization defaults.

كلevent لهاGlobal→Branch→Campaign same-language active fallback وسafe defaults وPreview وhistory،ولااختلاطمعProvider Message Templates. Tokens `{{campaign}}` و`{{owner}}` فقط،plain text/nonrecursive rendering. تغييرنوعالحدث فيالمحرر يمسحالإعدادوالتاريخالقديمين. SLA preference لا تغيرinitial preference،ولاstate أوقائمةالانتظار. Muting يخفيeligible feed/indicator دونحذفevent/history؛unmute يعيدالتاريخالمصرحبهحاليًا.

Native141 تضيفevent_type إلىمفتاح`notification_user_history` وتشتقها منfresh actual state/preference row؛version1 لحدثينلا تتصادم ولا تختارguard نسخةحدثآخر. التاريخالسابقمحفوظ كinitial event؛لا overwrite أوحذف. Mandatory global notification policies وبقيةevent/channel settings مازالتضمنالنطاقغيرالمكتمل؛لمتُخترعmandatory rule جديدةلهذاالحدث.

## Pagination والاختبارات

Centre وindicator وself read/unread/history تستعملCurrent audience الموجودة. Template fetch واحدةمحدودةللأنواع/الموارد فيpage،دونN+1. Cursor timestamp تعودnative text وتُمرَّر`text::timestamptz`،دونJavaScript Date serialization؛يحفظذلكmicroseconds والتعادل معid،ولايسقطEvent ثانيةلهانفسالتوقيتالدقيق.

Focused PG/Browser تثبتactual fresh alert،Manager/Owner وUnassigned/nonowner/foreign denial،Notification Audit rollback،unique source/old breach replay denial،eight-way state/preference CAS،independent Manager/Owner state،version1 history namespaces،separate event wording/defaults/Preview/localization،mute/unmute،failure reload،exact-microsecond keyset pages وعدمCustomer/financial actions. المصدرSynthetic فقط؛نتائجfull gate وحفظcheckpoint فيprogress/coverage.

## الاعتماد التالي

بعدحفظbaseline المحلية: mandatory وQualification-completion Handoff triggers معtyped current approved child/action proof،دونتخفيفoriginal full context بعدown Qualification write. ثمCustomer sends/Central Messaging Policy وinitial contact/returning/follow-up وبقيةAI/Copilot/Operations/Form/evaluations،ثمAutomation/Notifications/Analytics/import/export/Sheets/Email والنطاقالمتبقي.
