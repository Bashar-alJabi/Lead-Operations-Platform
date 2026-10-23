# ردود AI على مصدر وارد موثّق — Native148–149

**تحديث150–152:** متابعةQualification منactual fresh typed receipt أُضيفت بعقدمستقل في[ai-qualification-replies.md](ai-qualification-replies.md). مسارANSWER/QUESTION الأصلي أدناه باقٍ صارمًا؛ الحدودالتاريخيةعنغيابQualification continuation أدناهتخص148–149.

## النطاق

هذه baseline لـANSWER/QUESTION من current authenticated inbound،ضمن 04 و05 وAGENTS §§17–29. هي جزء من AI Conversation Agent؛ لا تمنح Human Copilot أي إرسال أوتعديل تلقائي. Live data transfer وfull Campaign activation تبقيان معطلتين حسب تصريح المستخدم. الاختبارات تستخدم synthetic PostgreSQL وHTTP mocks فقط؛ لا Live Provider Verified.

## الحلقة الفعلية

1. Signed webhook وinbound worker تحفظان الرسالة وتثبتان المصدر. Explicit current `sendConversationMessage` grant مع Native147 تسمح admission جديدة؛ لا backfill أوretroactive grant لمصدر قديم.
2. Customer proposal worker تستخدم current scoped Published Knowledge/approved questions وتنتج validated ANSWER أوQUESTION. AFTER trigger تنشئ `ai_customer_send_job` من **fresh completion** فقط،ثم SEND queue من Native144 الممتدة. PROPOSED وحدها ليست سلطة إرسال.
3. Local Application Service تقفل Queue→Job→Branch/Campaign/Lead/Contact/Conversation/dependencies،وتعيد current original context وCentral Messaging Policy قبل أي كتابة. Approved content مشتقة من reference IDs المنشورة أوالسؤال المعتمد غير المجاب؛ لا نص تجاري حر صادر عن الموديل. Conservative sensitive-content omission القائمة تعاد قبل الإدراج.
4. Immutable `ai_customer_send_action` وAI Message وbackground job وoutbound link وActivity/Audit وJob/Queue completion في transaction واحدة. APPLIED هنا تعني **إدراج النية**؛ حالة التسليم الفعلية مستقلة. BLOCKED لا تنشئ رسالة. فشل Audit أوdeferred native proof يلغي الآثار كلها،ثم bounded retry/dead-letter/recovery وفق Native144.
5. Messaging worker تعيد نفس Central Policy باستخدام `AI_ACTION` source authority؛ لا employee Principal أوOwner مصطنع. Sender lease وcooldown وbounded confirmed retries وUNKNOWN no-replay من Messaging القائمة مشتركة مع Human sends. Provider ACK سجل تاريخي،ولا يغير Human controller إذا وقع takeover أثناء I/O.

## سلامة المحتوى والرسالة

- Native content projection تربط ANSWER بالـreference IDs الأصلية وبترتيبها،وQUESTION بالسؤال الحالي المعتمد دونإعادة سؤال مجاب. المخرجات الأكبر من حدMessage ترفض دون truncation تغير المعنى.
- Disclosure تأتي من current Branch/Campaign behavior inheritance: EVERY دائمًا،وFIRST حتى وجود AI message مقبولة فعليًا SENT/DELIVERED/READ. QUEUED/FAILED/UNKNOWN لا تثبت أن العميل تلقى التعريف. لا موديل يختار نص التعريف أويتجاوزالإعداد.
- Native guard تشترط receipt جديدة في transaction نفسها،ومطابقة message ID وConversation/pinned Sender/Connection وAI author بلاUser،ونص المحتوى وidempotency key،وTEXT دونmetadata أوattachment/template أوprovider ID مصطنعة. Receipt وMessage/outbox links لا تستبدل أوتُحذف.
- Deferred proof تشترط actual fresh Message وmatching durable background job/outbound link،وحالية السياق بعد أثر الرسالة نفسها. أي محاولة حذفOutbox أوتغيير proof أوinvented body أوكتابة إضافية تغيّر السياق ترفض.

## Exact own-message delta

الرسالة المحلية تجعل `ai_customer_send_admission_context` الأصلية غير صالحة لأن آخر رسالة تغيرت. لا تخفف تلك الدالة. `ai_customer_send_dispatch_context` تثبت actual receipt/message،ولا تسمح بأي رسالة لاحقة غير own message. تستخرج original inbound fingerprint وتستبدل **latestMessageId وحدها** للمقارنة؛ كل scope/version/Owner/Controller/state/Knowledge/Profile/Connection/Field/config/source facts الأخرى تبقى مطابقة. Tool policy وConsent كاملتان تقارنان أيضًا،وهما keys إضافية على inbound fingerprint.

بعد ACK تُحدّث حالة AI التشغيلية إلى AI_WAITING_FOR_LEAD فقط إذا بقي current AI control وepisode version وآخررسالة ودونAttention. لا Version bump مصطنعة لكل رد تكسر misunderstanding episode،ولا override لـHuman takeover. New inbound أوcontext/grant/consent change تمنع dispatch القديم. Actual outcome التي وصلت منProvider تبقى محفوظة ولو تغيرت الصلاحية أثناء I/O.

Native149 تحرس PREPARED لـAI: current native Action context وMessage QUEUED وmatching current Job/attempt/Sender lease تحت Job key-share fence. يلزم هامش تقني15s أمام HTTP timeout10s الحالية؛ليس حدًا تجاريًا أوProvider rate constant. انتظارparent locks لا يمنحclaim قديمةحقبدءI/O. فقدانالهامشينهيالمحاولةبسببمرئيودونprovider call؛تغييرAdapter timeout مستقبلاًيتطلبمراجعةهذاالهامشوالـleaseمعًا. الاختباريمسكBranch بقفلحقيقي،ينتظرRUNNING،يقصّرالـleaseثميفكالقفلويراقبصفرI/O وصفرPREPARED.

## التوقف والتعافي

Blocked local send يسجل السبب وsource/history،ويوقف current same-scope/latest-source AI للمراجعة دونfake Handoff أوOwner mutation. Failed dispatch يوقف AI الحالي عند آخررسالته فقط. Explicit Human takeover المصرح بها تستطيع استلام `AI_CUSTOMER_SEND_BLOCKED`؛ لا تمسح SEND_OUTCOME_UNKNOWN. UNKNOWN تحتفظ بالرسالة والـattempt ولا تعيدProvider write،وinbound جديدة لا تمسح سببالمراجعة. إعادةdiagnostic classification محصورةفيAI_PROCESSING_NOT_READY/AI_CUSTOMER_CONTEXT_TOO_LARGE/AI_QUEUE_BACKPRESSURE،ولا تمنحadmission أوAI resumption. Human recovery القائمة لا تمنح AI message سلطة جديدة.

SEND jobs تستخدم partial due index وSKIP LOCKED وshort savepoint وfive failures/backoff/dead-letter. Current-session scoped Manager/SA recovery مع reason/CAS/history/Audit تعيد التنفيذ المحلي فقط،مع إعادة original/current authorization؛ لا تعيدرسالة UNKNOWN أوتمنح أداة أوتفعّلLive. Agent read-only. لا أقفال DB عبرprovider HTTP.

## بوابة النقل الحي

Default Messaging worker ترفض AI dispatch بـ`AI_LIVE_DATA_TRANSFER_DISABLED` قبل decryption/provider I/O،حتى مع receipt صحيحة. Explicit test adapter و`syntheticAI:true` مقبولتان فقط في isolated `lead_operations_test` وخارجproduction،ولا تقبل default production adapter كاختبار صامت. لا env toggle أوUI زرLive أُضيف. Customer inference default gate القائمة باقية. Credentials جميعها اصطناعية في الاختبارات.

## الواجهة والإثبات

Lead→Conversation تعرض AI author والتسليم عبر Messaging history الموجودة،وCustomer AI execution history تربط action/message ID بـQUEUED/SENT/FAILED/UNKNOWN دون اعتبارAPPLIED تسليمًا. SEND action jobs/recovery/history من الواجهة القائمة،مع ar/en/fr/RTL وescaped text وclearing بعدfailed access. DTO لا تكشف context أوcredentials أوhidden qualification values.

`test-integration/ai-customer-send.test.ts` تختبر native forged-content/missing-outbox/own-extra-write/forged PREPARED denials،actual parent-lock/lease race،atomic Audit rollback،8workers/idempotency،ANSWER/QUESTION/disclosure،current policy عندenqueue/dispatch،new inbound/consent/Human takeover،ACK in flight،known rejection retry/UNKNOWN no-replay،live-off قبلdecryption وproduction test denial،scoped history وrecovery دونfinancial mutation. Browser flow تستخدم actual Responses/Meta adapters مع HTTP mocks وsigned inbound،وSEND five failures→dead-letter→Manager recovery→one queued reply→SENT،وAgent denial/current access/locales/no-XSS. النتائج النهائية المؤكدة في progress/coverage.

## الحدود والخطوة التالية

هذه baseline replies لمصدر inbound؛ لا تكمل continuation بعدحفظQualification ولاinitial contact أوreturning closed Lead/Conversation أوproactive follow-up أوtransition messages. Full `sendConversationMessage` tool/catalog/readiness وAI/Handoff/platform ليست Complete. التالي closed-loop Qualification: current own-write child source منactual typed Qualification receipt وexact delta pattern القائمةفيNative142،معoriginal Send grant الحالية وoutcome/Handoff priority؛لاfabricated inbound أوتغييرdecision الأصلية. ثم durable initial-contact source admission مرتبطة trusted Lead intake/current Campaign config والـOwner/availability والحandoff initial rule،ثم returning/follow-up/approved transition عبرpolicy/outbox boundary نفسها،وبقية Copilot/Operations/Form/evaluations،ثمAutomation/Notifications/Analytics/import/export/Sheets/Email وبقيةالمتطلبات.
