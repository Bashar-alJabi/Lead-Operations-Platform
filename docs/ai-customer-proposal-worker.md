# عامل اقتراحات AI Conversation Agent

## العقد والحدود

Typed proposal values تتبع `normalizeQualificationAnswer`/`validateFieldValue` المشتركة، بما فيها CURRENCY object وحدودها وcanonical DATETIME/PHONE/EMAIL/TEXT، دون قبول object عشوائية أوcurrency غير المُعدّة للحقل. Native115 تطابق CURRENCY shape/current definition؛قواعد actual Field mutation منفصلة وتالية.

هذه مرحلة فعلية من authenticated inbound إلى durable queue ثم managed CONVERSATION Profile وHTTP inference وvalidated proposal وscoped Lead UI/history. ليست اكتمال AI Conversation Agent أو approved action execution. لا client enqueue endpoint أوHuman principal/session أوSimulation/Copilot result كسلطة autonomous. Native100 تبقى HUMAN-only؛Payment وEnrollment بلا تغيير،ولاCustomer send.

العقد provider-independent يميّز `ANSWER` باختيار Published evidence IDs،و`QUESTION` باختيار سؤال Campaign،و`QUALIFICATION` باقتراح قيمة typed وإرفاق اقتباس مطابق للرسالة الحالية،و`HANDOFF` بالسبب المعتمد. Backend يستخدم shared typed normalization ويمنع invented/foreign references وduplicate IDs وunknown keys وSQL/tools/financial claims. لاfree commercial text. القيمة ليست حقيقة محققة أوField write؛الاقتباس يثبت وجود evidence فقط،ولا يثبت صحة interpretation أودفع. Native guards تثبتsource/context/lease/result shape؛لا تثبت semantic correctness للنموذج أو حدوثHTTP بذاتها.

## المصدر والسياق

New-event admission تتطلب inserting transaction غير ملتزمة ومرئية للمستدعي، مع دعم SAVEPOINT/subtransaction وxid epoch في114؛لا تعتمد على مقارنة top-level xid بـxmin وحدها. MVCC visibility تمنع قراءة سجل transaction أخرى غير ملتزمة، وcommitted journal تُرفض، ولا backfill/replay. القاعدة مستندة إلى [PostgreSQL transaction functions](https://www.postgresql.org/docs/18/functions-info.html#FUNCTIONS-TXID-SNAPSHOT) و[Subtransactions](https://www.postgresql.org/docs/18/subxacts.html) ومثبتة عبر actual inbound processor savepoint.

`messaging_inbound_authentication` القائمة تسجل attestation من raw-body HMAC verified handler. `ai_customer_proposal_context` تتطلب current authenticated resolved inbound/message/body/Organization/Branch/Campaign/Lead/Conversation/pinned Sender/Profile/catalog/grant وlatest source message،Active Branch/Campaign وAI enabled وLead OPEN وcurrent AI Controller وصحةالمعرفة المنشورة وField AI usability. Context تحفظversions/hashes وبounded آخر20 TEXT messages،2000characters لكلرسالة،ومعرفةمنشورة وأسئلة/configuration خاصةبالحملة؛لاHuman invoker/session أوDraft أوpayment records أوcredentials. Approved tools تبقىفارغة فيهذهالمرحلة.

المسار الحالي يحفظ immutable `BLOCKED` diagnostic journal كالسابق،ويضيف work منفصلة **للحدثالجديد المؤهل فقط**. لاworker يعيد تشغيل journal قديمة. UI تعرضproposal إنوجدت للحدث،وإلاoriginal blocked trace،معhistory الأصلية باقية فيDB. Conversation تبقىNeeds Attention/`AI_PROCESSING_NOT_READY` حتىتنفيذactual actions/runtime. السماحبالاقتراح التشخيصي عندماAI Controller و`AI_HANDOFF_REQUIRED` لهذاالسبب فقط **ليس** إذنًا Tool/send أوإعادةتفعيل Human/closed conversation.

## التزامن والفشل

إذا تجاوزت نسخة السياق 1MiB، تُحفظ رسالة الوارد وjournal وevent PROCESSED، وتظهر `AI_CUSTOMER_CONTEXT_TOO_LARGE` كـConversation Attention معAudit دونenqueue/HTTP. Pending backpressure تظهر `AI_QUEUE_BACKPRESSURE` كذلك. Authorized Human Takeover تعالج هذين السببين وتزيلهما، مع بقاء unrelated sender/provider attention دونbypass. الحد technical قابل للمراجعة معretrieval/runtime لاحقة؛لا يُحوّل valid inbound إلىprocessing failure ولا يحذف معرفتها أورسائلها.

`ai_customer_proposal_locked_context` تستخدمparent-first Branch→Campaign→Lead→Conversation ثمpinned Sender/Connection/current config/Profile/grant/Field/assets locks. قبلHTTP وبعده يجبأن تطابقfull canonical snapshot. لاtransaction أوlocks أثناءHTTP؛Human takeover وcore operations يمكنهاالاستمرار. New inbound أوreassignment أوpublication/config/Field/Branch/Profile/pin/consent change تمنعcompletion القديم. Current result proof مستقل عنhistorical stale flag فيUI؛ولايمكن استعمالPROPOSED artifact كـaction permission دونإثباتحالي جديد.

`SKIP LOCKED`،lease60seconds (test/technical bounded0.1–120)،5attempts،retry backoff حتى300seconds،expired lease recovery وcompleted token fence تمنعlate response منالفوز. Queue technical pending limit10 لكلConversation؛burst تحفظInbound/blocked journal وتدققbackpressure دونفقدرسالة. Inference retry ممكنة لأنهذهالعملية بلاBusiness/provider side effects؛هذا لايجيزreplay لأيTool أوsend لاحق. Native state/history/immutable context/terminal guards وatomic Audit تسجلassistant technical identity دونactor employee أوmessage/knowledge bodies أوsecrets.

## تقليل البيانات والنقل الحي

Default worker يغلق التنفيذ قبلcredential access أوprovider payload/HTTP بـ`AI_LIVE_DATA_TRANSFER_DISABLED`. لاenvironment أوsetup toggle يسمحlive inference فيهذهالمرحلة. Explicit registry injection متاحةفقط فيnon-production isolated `lead_operations_test` وsynthetic HTTP mocks،وفق موافقةالمستخدم. Model DTO تحتويbounded attributable excerpts وapproved references/typed questions/language/tone فقط،ولاOrganization/Branch/Lead identifiers أوField storage IDs أوfinancial facts/secrets. Whole-excerpt omission تمنعأنماطcredential/card/IBAN المعروفة؛إذاالرسالة الحاليةحُجبت يُسجّل`AI_SENSITIVE_INPUT_OMITTED` دونHTTP. هذه technical safeguard وليستLive DLP guarantee.

Responses adapter تستخدمmanaged model و`store:false` وstrict JSON schema و`tools:[]` و20s timeout و1MiB response limit وsafe failure codes. هذاstructured proposal contract؛approved tool executor المنفصل سيطبقcurrent authorization/business rules قبلأيaction. إرشادات [Structured Outputs الرسمية](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses) روجعت2026-10-10. اختيارevidence والتوصيةلايختزلانقدراتCustomer Agent المستقبلية إلىCopilot summary.

## الواجهة والإثبات

GEThistory تستخدمcurrent exact employee session/Lead ownership/scope وcurrent parent identity وkeysetpagination. DTO تعرضstate/attempts/provider invocation/knowledge version/staleness وanswer منapproved refs أوrecommendation فقط. لاqualification candidate value/question/schema قدتكشفField مخفية عنالموظف. Rendering plain React text وar/en/fr وcurrent-view fence/clear-on-auth-error.

الحالة **Implemented وMock/Sandbox Verified** للـproposal stage: migrations001–115 development/test،170unit/73full Docker PostgreSQL integration/42full Edge Browser وfocused PG/Browser1/1 وBackend/Web build/typecheck/diff check ناجحة علىآخرالكود. تشملcurrent context/source/controller/pin/profile/Field/publication/lease/permissions،duplicate concurrency وbounded retries وtyped CURRENCY/normalization وAudit rollback وoversize/backpressure-Human recovery؛RTL390px فُحصت. **Live Verification Pending External Credential/Approval** والنقلالحي معطّل؛لاLive semantic verification أوactual action completion. التالي approved tools policy/configuration ثمAI Qualification وHandoff current action proofs/native guards/history/UI/evaluations،ثمCentral Messaging Policy sends/initial contact/returning/follow-up/SLA وبقيةCopilot/Operations،ثمAutomation/Notifications/Analytics وبقيةالنطاق.
