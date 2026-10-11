# Handoff summary وحزمة المراجعة

## النطاق والحدود

هذه مرحلة من Human Handoff الواردة في04 §§29/85 و05/AGENTS؛لا تعني اكتمالHandoff routing/SLA/triggers أوAI runtime. تطلب المحادثة تسليمًا فعليًا عبر125–128 قبلإنشاءالملخص. AI summary مشتقة من أدلة المحادثة،وليست مصدرًا للحقيقة أوإثباتPayment/Enrollment. Human acceptance مستقلة عنتوفرالملخص أوفشلProvider.

## Admission والسياق

Native129–131 تضيف`ai_handoff_summary` وimmutable transition history وindexes للـqueue/history وpending uniqueness لكلcurrent Handoff. بعدحفظAI-origin conversation_handoff تُقبلinitial summary تلقائيًا فقطإنوجدSUMMARIZATION Profile صالح وsnapshot ضمن1MiB. الأصلcurrent APPLIED action منالمعاملةنفسها وWAITING_FOR_HUMAN/NONE/current pointer؛لاfake employee/session ولاretrofit لطلبقديم. غيابProfile لايلغيsafe Handoff.

Refresh من`POST /api/conversations/:id/ai-handoff-summary` يتطلبrequestId وموظفًا/session حقيقيين وصلاحيةcurrent Lead. يعيدpending job عندالتكرار،وrequestId المحفوظة تربطactor/action؛بعدterminal يمكنطلبقراءةجديدة بصلاحيةفعلية دونتعديلالتاريخ. Agent محصورةبالملكية؛Manager بفرعها وSuper Admin بمنظمتها. قبولHuman يمحوصلاحيةautonomous summary الحالية؛يمكنبعده استخدامHuman Copilot المستقلة عندتوفرإعدادها.

السياقnative يجمعauthenticated original source/current scope/Owner/lifecycle/controller/versions/pinned Sender/health/Published Knowledge manifests/configuration/behavior/Qualification Field versions/approved Tools/consent status-version/current SUMMARIZATION Profile/catalog/grant،ومصدرالمحادثةالمحدود. لايحفظconsent evidence النصية داخلsnapshot الملخص. Parent locks تحميfirst config/Field/consent writes أيضًا. current full equality مطلوبة قبلI/O وبعده وعندCOMPLETED native proof. Refresh يضيففحصactive invoker/session/current access أثناءالتنفيذ؛autonomous initial trace actor/session=NULL.

## Worker وProvider

`processOneAIHandoffSummary` مستقلةعنCustomer proposal وHuman Copilot workers. تستخدمSKIP LOCKED،lease60s قابلةلإعدادتقني0.1–120s،أقصى5attempts وbounded exponential retry حتى300s. لاDB locks عبرHTTP؛expired result لايمكنهتجاوزreplacement lease. Context change→BLOCKED،invalid/unsupported/auth result→FAILED،retryable Provider error→QUEUED ثمFAILED عندنفادالحد. Audit وhistory وresult transition atomic؛فشلAudit يبقيRUNNING lease قابلةللاستعادة.

تستخدمprovider-independent`AIInferenceAdapter.summarize` وextractive evidence selector الموجودة؛اشتراكextractor لايعنياشتراكHuman authority أوBusiness context. Payload مقتصرعلىpurpose/language/safe attributed references،بحد20مقتطفًا وآخر2000character لكلنص؛selected output حتى8مراجعحقيقية دونfree-text invention أوtools/send/mutation. يتمحذفالمقتطفالحساس بالكامل،بمافيهأنماطالبطاقات/الأسراروالأرقامالعربية؛هذاdevelopment minimization وليسادعاءLive DLP مكتملة.

Live-off يُفحصقبلقراءةconnection_secret أوتكوينProvider payload. لاenvironment switch لتفعيله. Explicit adapter injection مقبولةفقطفي`lead_operations_test` وخارجProduction. Live Verification Pending External Credential/Approval؛التطويروBrowser يستخدمانبياناتاصطناعيةوHTTP mocks فقط.

## API وUI

`GET /api/conversations/:id/ai-handoffs` يضيفpackage ضمننفسcurrent session/Lead permission:

- آخر5summary traces: state/error/attempt/generated time/current stale/truncation/knowledge version/profile/result دونcontext/raw credentials.
- Latest saved Customer input الذيلايتبعهOUTBOUND بحالةSENT/DELIVERED/READ. QUEUED/FAILED لايثبتانردًا. هذاtransport-derived signal؛لايدعيإثباتجودةجوابسابق أوتحليلسؤاللغويًا.
- current Published references فقط؛approved assets معcurrent APPROVED/REVIEW،دونDraft أوقراءةweb links/filebytes بواسطةالملخص. هذهالمراجعمتاحةللمراجعةوليستادعاءبأنمعرفةالحملةتجيبعلىالسؤالالمجهول.
- Deterministic suggested next action: review/explicit Human acceptance أوcurrent-controller response؛لاModel financial action.
- current Qualification values/missing items عبرالمسارالمشتركوField masking؛restricted aggregates لايتسربمنهاcompletion/missing. Campaign/source/reason/request-time source باقيةمتميزةعنcurrent input.

Full conversation فيلوحةالرسائلذاتserver pagination الموجودة. UI ar/en/fr،plain-text rendering،freshness/error واضحة،وfailed read/refresh أوتغييرCV أوتحديثcontroller/version/message source يمسحold authorized data ويفنسin-flight response. History لايُعادوصفهكملخصcurrent عندتغيرالسياق. تولّيHuman صريح،ولايؤديread/refresh إلىsend أوOwner/controller/Payment/Enrollment mutation.

## التحقق والخطوة التالية

Focused PostgreSQL وBrowser أضيفتلهماadmission/current fences/real-session revocation/Published change/duplicates/concurrency/lease replacement/Audit rollback/retry/invalid output/sensitive omission/missing Profile/permissions/no-XSS/RTL/freshness/refresh بعدHuman denial. نتائجfull gate تسجلفيprogress/coverage بعدإنهائها. لاLive verification.

تحديث132–134: configured target/current reception/availability وoperational hours setup منفذة في [ai-handoff-reception-availability.md](ai-handoff-reception-availability.md). التالي المطلوب: Branch/Campaign SLA clock/timezone/working-hours وNotifications/reminders/escalation فعلية، ثم mandatory وQualification-completion triggers بـatomic current proof دون تخفيف السياق بعد own Qualification write. بعد اكتمال Handoff baseline تأتي customer sends عبر Central Messaging Policy وبقيةAI ثمAutomation/Notifications/Analytics وبقيةالوحدات. Tool catalog/full readiness تبقي Handoff غيرمكتملة حتى تنفيذ كل ذلك.
