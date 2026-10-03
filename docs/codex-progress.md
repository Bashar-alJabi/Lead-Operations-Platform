# تقدم التنفيذ

## آخر حالة مستقرة: Messaging outbound worker مع fake provider

أضيفت migration `022_messaging_worker.sql` لعقد lease لكل Sender وسجل محاولات الإرسال وحالة `UNKNOWN`. استُخرج فحص السياسة إلى `outbound-policy.ts` كي يعيد عامل الإرسال فحص Lead access وهوية Human الحالية والمتحكم وConsent/DNC والحملة والنافذة والـPinned Sender ونافذة Meta قبل Provider call. عامل `worker:messaging` يختار Jobs عبر `SKIP LOCKED` ويمنع عاملين من الإرسال من Sender واحد في الوقت نفسه، ويفك credential المشفرة في الذاكرة فقط. `metaWhatsAppSendAdapter` يبني طلب Text إلى Cloud API بمهلة محدودة ويتحقق من Provider Message ID دون تسجيل السر أو نص الرسالة. نجاح المزود ينتقل إلى `SENT`، ورفض `429` يعاد بحد محاولات وتأخير، والرفض المؤكد يصبح `FAILED`. Timeout/5xx/استجابة نجاح بلا ID أو انقطاع بعد `PREPARED` تصبح `UNKNOWN` وNeeds Attention بلا إعادة إرسال آلي قد تكرر الرسالة. يسجل Audit والـJob ومحاولة الإرسال السبب دون أسرار.

التحقق: PostgreSQL عبر Docker Compose؛ migrations `001`–`022` على قاعدتي التطوير والاختبار. 20/20 unit و6/6 مجموعات integration، Backend/Web typecheck وWeb build ناجحة. اختبارات fake provider تغطي قبول الإرسال، فك credential، `429` وإعادة الجدولة، منع التسليم بعد تغيير Consent، قفل Sender بين عاملين، النتيجة الملتبسة، واستعادة Job منقطع بعد `PREPARED`. اختبار وحدة يثبت شكل طلب Meta وتصنيف أخطائه. لم يُجر اتصال حي بمزوّد ولا UI E2E. اتصال الاكتشاف يبقى `WARNING/SEND_NOT_TESTED`؛ الاختبارات استخدمت `CONNECTED` اصطناعياً، لذا لا تدّعي هذه المرحلة جاهزية تشغيل الرسائل لدى مزوّد حقيقي.

قيد التنفيذ التالي: لا تغييرات ضمن مجموعة جديدة عند هذا checkpoint. الخطوة الدقيقة: إدارة Meta templates والتحقق من اعتمادها من داخل المنصة، ثم مسار test-send/تأكيد صحة Connection وSender من الواجهة دون تعديل قاعدة البيانات، ثم delivery callbacks وinbound webhook مع Signature/Idempotency/Needs Attention. أبق AI مؤجلًا إلى اكتمال Messaging.

## آخر حالة مستقرة: Outbound send intent

أضيفت migrations `019`–`021` لربط Message بالـConversation/Sender/Connection المثبتين، ومنع تعديل محتوى الرسالة وهويتها التاريخية أو حذفها، وربط مهمة الإرسال بالرسالة بمفاتيح أجنبية، وفهرسة نافذة آخر Inbound. عُدّل migration runner كي يفهم SQL functions ذات semicolons داخل dollar quotes، مع اختبار وحدة. خدمة `enqueueOutboundMessage` تقفل Lead ثم Contact ثم Conversation، وتتحقق من الصلاحيات والحملة/الفرع النشطين وحالة Lead والمتحكم وConsent/DNC والـSender المثبت وصحة الاتصال والنافذة، وتمنع Meta freeform خارج نافذة خدمة العميل ذات 24 ساعة. مسار Human فقط متاح الآن؛ يحفظ Message `QUEUED` و`background_job` وAudit في معاملة واحدة، ويعيد الطلب بالمفتاح نفسه دون تكرار أو يرفض إعادة استخدامه بمحتوى آخر. واجهة Lead تعرض سجل الرسائل بنطاق الصلاحية وpagination، وتُبقي idempotency key عند إعادة محاولة طلب لم يؤكد نجاحه. `QUEUED` لا تعني إرسالاً أو تسليماً.

التحقق: Docker PostgreSQL `healthy`، migrations `001`–`021` على قاعدتي التطوير والاختبار، 19/19 unit و6/6 مجموعات integration، Backend/Web typecheck وWeb build ناجحة. اختبارات PostgreSQL تفحص عزل Agent/Branch، Consent وDNC، اشتراط template عند غياب Inbound، نافذة الوقت، controller، sender invalid/Needs Attention، تعارض المفتاح والتزامن، عدم تكرار Message/Job، وثبات محتوى الرسالة؛ حالة الاتصال `CONNECTED` أُنشئت اصطناعياً في الاختبار فقط. لا UI E2E ولا إرسال مزوّد أو Webhook حي؛ Worker لم ينفذ بعد، لذا لا توجد رسالة مُرسلة فعلياً.

قيد التنفيذ التالي: لا تغييرات ضمن مجموعة جديدة عند هذا checkpoint. الخطوة الدقيقة: تنفيذ عامل الإرسال بمزود Meta adapter وfake adapter، مع lease وretry/backoff وdead-letter، وإعادة فحص Central Messaging Policy عند التنفيذ خصوصاً Consent/Controller/Sender/24h/template والنافذة، ثم delivery callbacks مستقلة مقاومة للأحداث المكررة وخارج الترتيب. أكمل إدارة القوالب من الواجهة ثم inbound webhook/Needs Attention؛ احفظ checkpoint لكل مرحلة مثبتة.

## آخر حالة مستقرة: إعداد Branch/Campaign sending policy

أضيفت migration `018_messaging_policy.sql` وAPI وواجهة لضبط نافذة إرسال Branch بحسب منطقتها الزمنية، ووراثة Campaign لهذه النافذة أو تجاوزها، مع حد اختياري للمحاولات والفاصل الأدنى بينهما. `null` في Branch يعني عدم فرض نافذة محلية، و`null` في Campaign يعني الوراثة. نافذة تعبر منتصف الليل مسموحة، وتُرفض البداية المطابقة للنهاية والقيم غير الصالحة. للفرع نسخة سياسة مستقلة عن نسخة اختيار Sender؛ سياسة Campaign تستخدم نسختها الحالية. كل تعديل يمر بصلاحيات Super Admin/Manager ضمن الفرع، ويُسجل في Audit؛ Agent لا يغيرها. يظهر Effective Window وIANA timezone في الواجهة. حد الأعداد الأعلى `2147483647` قيد تقني لحفظ أعداد صحيحة، وليس قاعدة تجارية أو حد مزوّد.

التحقق: PostgreSQL عبر Docker Compose بحالة `healthy`؛ migrations `001`–`018` على قاعدتي التطوير والاختبار. نجحت 6/6 مجموعات integration، وتشمل سياسة الرسائل عزل الفرع والدور، الوراثة والتجاوز، النافذة الليلية، رفض الوقت والأرقام غير الصالحة، تعارض النسخ والتعديل المتزامن وAudit. نجحت 18/18 unit، وفحص النوع للـBackend/Web وبناء الواجهة. لا يوجد UI E2E أو إرسال فعلي أو تحقق مزوّد حي؛ إعداد السياسة وحده لا يتيح إرسال رسالة.

قيد التنفيذ التالي: لا تغييرات غير محفوظة ضمن مجموعة جديدة عند هذا checkpoint. الخطوة الدقيقة: بناء خدمة outbound واحدة تستقبل كل Human/AI/Automation/Follow-up send، تفحص Lead access وConversation controller وContact consent/DNC وPinned Sender/connection ونطاقه وصحته والنافذة/الحدود والـtemplate/قدرات المزود، ثم تحفظ Message `QUEUED` وjob مع idempotency داخل معاملة واحدة. اختبر الرفض والتكرار والتزامن على PostgreSQL قبل إضافة worker/adapter ثم inbound webhook/review.

## آخر حالة مستقرة: Messaging consent/contactability

أضيفت migration `017_messaging_consent.sql` وAPI وواجهة داخل Lead لحالة WhatsApp Consent وDo-not-contact مع source/evidence ووقت آخر تحديث. حالة `UNKNOWN` هي الأصل عند غياب السجل. منح `GRANTED` يتطلب evidence؛ كل تغيير يحفظ نسخة متزايدة في `messaging_consent_history` وAudit، والطلب المتكرر دون تغيير لا يولد تاريخًا جديدًا. Agent يقرأ حالة Lead المسموح بها ولا يعدلها؛ Manager يغير Contact محصورة في فرعه؛ Contact المشتركة بين الفروع يغيرها Super Admin فقط. Do-not-contact مستقل عن حالة opt-in حتى يمكن حفظ طلب المنع دون طمس التاريخ السابق. لا يحدث إرسال في هذا المسار.

التحقق: migrations `001`–`017` على قاعدتي التطوير والاختبار؛ 6/6 مجموعات integration على PostgreSQL تفحص evidence والنطاق والمشاركة بين الفروع والنسخة والتكرار وسباق طلبين والتاريخ، وBackend/Web typecheck/build ناجحة. يعاد `npm test` قبل commit. UI E2E غير مشغّل.

الخطوة التالية الدقيقة: إعداد Branch/Campaign sending window/timezone وfrequency/max-attempt والـtemplate/consent requirements في Backend والواجهة مع نسخ/Audit واختبارات سلبية؛ ثم خدمة outbound واحدة تتحقق من هذه القواعد والـcontroller والـsender وتكتب Message `QUEUED` وjob atomically مع idempotency. بعد checkpoint آخر، worker/provider send/delivery ثم inbound webhook/review.

## نقطة تحقق سابقة: Conversation opening وSender pinning

أضيفت migration `016_conversation_pin.sql` وقيد يمنع أكثر من Conversation نشطة للقناة نفسها على Lead واحدة. مسار فتح محادثة WhatsApp يقفل Lead، يفحص وصول المستخدم وحالة Lead ورقم Contact، ويعيد Conversation القائمة أو ينشئ واحدة بمرسل/اتصال مثبتين من خدمة الحسم. لا يغيّر Controller محادثة قائمة. عند فقد صلاحية الرقم المثبت أو تغير رقم Contact أو اختلاف Connection المحفوظ عن Sender، يُحفظ `needs_attention_reason` ويعاد `409` بلا نقل صامت أو إنشاء بديل. قائمة المحادثات وتفاصيلها تفحصان Lead access في SQL وتدعمان pagination؛ واجهة Lead تعرض المحادثات وتفتحها دون إرسال رسالة.

التحقق: migrations `001`–`016` على قاعدتي التطوير والاختبار، و6/6 مجموعات integration على PostgreSQL بما فيها طلبا فتح متزامنان ينتجان محادثة واحدة، منع Agent قبل الإسناد وبعد فقده، عزل الفروع، غياب الهاتف، وتثبيت Sender عند تعطيله مع وجود Override آخر، وعدم اتساق Connection/Sender. `npm test` 18/18 وBackend/Web typecheck وWeb build ناجحة. لا يختبر هذا الإرسال أو تسليم المزوّد.

الخطوة التالية الدقيقة: إضافة إعداد consent/contactability وCampaign Messaging Policy الموثّق في الواجهة والـBackend، ثم خدمة واحدة لكل outbound send تتحقق من controller وsender والـconsent/النافذة/التردد/template، وتحفظ رسالة `QUEUED` وjob في معاملة مع idempotency. بعد checkpoint، أضف worker/provider send/delivery callbacks والـinbound webhook/review. لا يُعلن Messaging مكتملًا.

## نقطة تحقق سابقة: DB sender resolution للرسائل الجديدة واختبار Pinned Sender

أضيفت خدمة `resolveConfiguredSender` التي تقرأ Branch default وCampaign override وOrganization shared fallback الصريح من PostgreSQL ثم تطبق قاعدة الحسم المركزية. لا تختار Sender عشوائياً، ولا تسقط إلى بديل عند وجود إعداد أعلى أولوية غير صالح. `effective-sender` API محصور في Super Admin/Manager ضمن Branch، وتعرض شاشة الحملة Sender الفعلي أو سبب الحظر. `WARNING/SEND_NOT_TESTED` تمنع إعلان Sender جاهزًا؛ اتصال `CONNECTED` وصحة Sender يختبران بحالة مصطنعة داخل PostgreSQL فقط، وليس بتحقق Live. اختبار Pinned Sender أثبت أن تعطيله يمنع الحسم حتى عند وجود Campaign Override صالح؛ إنشاء/تثبيت Conversation الفعلي لم يُنفذ بعد.

التحقق: 6/6 مجموعات integration على PostgreSQL، تشمل نطاق الدور، عدم جاهزية الاتصال، Override وDefault وFallback، وفشل Pinned Sender بلا انتقال صامت. لا migration جديدة. اجتازت unit/typecheck/Web build. الخطوة التالية حينها كانت فتح Conversation وتثبيت Sender.

## نقطة تحقق سابقة: Sender bindings وBranch/Campaign sender configuration

أضيفت migration `015_sender_bindings.sql` وAPI وواجهة لإيقاف/تمكين Sender تشغيلياً بشكل مستقل عن اكتشافه، ربط Organization Sender بفروع محددة مع خيار shared fallback صريح، اختيار Branch default وCampaign override، وقوائم أرقام مصرح بها مع pagination. يحتفظ كل من Sender وBranch/Campaign بنسخة تمنع فقد التعديل المتزامن؛ يُمنع فك Binding تستخدمها إعدادات Branch/Campaign حتى تُزال صراحة. لا يستطيع Manager إدارة Organization Sender أو تغيير فرع آخر، ولا يستطيع Agent إدارة أي منها. تتضمن الواجهة إدارة الـBindings والافتراضي وOverride الحملة، مع بيان أن الاكتشاف وحده لا يثبت قابلية الإرسال. يُحفظ Audit لكل تعديل.

نقطة التحقق الجديدة: migrations `001`–`015` على قاعدتي التطوير والاختبار؛ اختبارات PostgreSQL في مجموعة Messaging تفحص صلاحيات الفروع والأدوار، binding وfallback، الاختيار الخاطئ، رفض فك رقم مستخدم، وتعادل طلبين متزامنين لنسخة Binding/Branch/Campaign. اجتازت 6/6 مجموعات integration؛ Backend/Web typecheck وWeb build ناجحة. `npm test` **18/18** من checkpoint السابق ويُعاد في بوابة هذا checkpoint. لا UI E2E ولا Provider live.

## نقطة تحقق سابقة: Messaging Connection setup واكتشاف Senders

أضيفت migration `014_messaging_setup.sql` وAPI وواجهة متعددة اللغات لإدارة اتصال Meta WhatsApp Cloud ضمن Organization أو Branch، مع تشفير credential وعدم إعادتها للواجهة، تدويرها، فحص نسخة الإعداد، تعطيل/إعادة تهيئة، واكتشاف الأرقام عبر Provider adapter. نتيجة اكتشاف الأرقام تبقى `WARNING` مع `SEND_NOT_TESTED`؛ لا تدّعي نجاح الإرسال أو Webhook. أرقام Organization المشتركة لا تظهر لManager إلا عند وجود binding لفرعه، ولا تظهر له أرقام أخرى في الاتصال نفسه. عملية إعادة الاكتشاف توقف الأرقام الغائبة، وتعديل الاتصال يوقف أرقامه إلى حين إعادة الاكتشاف. أحداث الإنشاء والتعديل والفحص والفشل والتعطيل محفوظة في Audit. لا يوجد Live Provider verification.

نقطة التحقق: migrations `001`–`014` اجتازت على قاعدتي التطوير والاختبار؛ `npm test` **18/18**، و`npm run test:integration` **6/6 suites** على PostgreSQL الحقيقي مع fake adapter، وBackend/Web typecheck وWeb build ناجحة. اختبارات API السلبية تفحص عزل Agent/Manager والفروع، عدم تسريب الأسرار، منع تعديل الاتصال المعطّل، تعارض النسخة والتعديل المتزامن، فشل المزود، وإخفاء الأرقام غير المربوطة. UI E2E والاختبار مع Meta sandbox/live لم يُجرَيا. ظهر خلل عام في تحويل `429` إلى `500` وأُصلح.

## نقطة تحقق سابقة: Bulk assignment محدود العدد

- مجموعة Lead workflow/Follow-ups/Search/Saved Views محفوظة في `e1e68ef`، ومرحلة Sorting/Columns محفوظة في `24715f6`، وBulk assignment في `d8d40b3`. لم يحدث Merge أو نشر إنتاجي.
- التنفيذ المثبت: migrations `011`–`013`، سجل نشاط وإسناد وإعادة إسناد مع version وAudit، ملاحظات داخلية، متابعات Human مع تاريخ ونسخة وحالات الإكمال/الإلغاء، بحث Leads بنطاق الدور وفلاتر المتابعة والحقول الديناميكية المرئية، ومشاهد محفوظة بنطاقات شخصية/فرع/مؤسسة وعمليات إنشاء/تعديل/حذف وواجهة تطبيق/إنشاء/حذف.
- التحقق: Docker Compose يعرض PostgreSQL 18 `healthy`؛ أعيد تشغيل migrations `001`–`013` على قاعدتي التطوير والاختبار؛ Backend/Web typecheck و`npm test` **18/18** و`npm run test:integration` **5/5** و`npm run web:build` ناجحة. الاختبار الجديد يفحص الصلاحيات، إخفاء الحقول، تعارض النسخ والأسماء، التكرار، وتقييد البحث بعد تغير مالك Lead. UI E2E لم يُشغّل.
- المرحلة المستقرة الجديدة: ترتيب `CREATED_ASC`/`CREATED_DESC` مع keyset pagination، وإرجاع موعد أقرب متابعة مفتوحة، واختيار أعمدة Lead في الواجهة وحفظ ترتيب الأعمدة والفلاتر وتطبيقها في Saved View. يرفض Backend قيمة Sort أو أعمدة غير مسموحة. اجتازت 18/18 unit و5/5 integration مع فحص نوع Backend/Web وWeb build؛ لا migration جديدة. UI E2E لم يُشغّل.
- حدود التنفيذ الحالية: لا نقل Lead بين الفروع، ولا Follow-up آلي بسياسة إرسال، ولا إجراءات Bulk غير الإسناد المحدود أو فلاتر Payment/Enrollment/Conversation قبل بناء وحداتها. Sorting الحالي لتاريخ الإنشاء صعوداً/هبوطاً. تبقى هذه المتطلبات جزئية في المصفوفة.
- المرحلة المستقرة الجديدة: Bulk assignment حتى 50 Lead في الطلب، مع تأكيد واجهة واضح، وفحص صلاحية و`version` كل Lead على حدة، وإعادة استخدام خدمة الإسناد الفردي بما فيها نقل المتابعات وHuman controller وAudit. الاستجابة تعطي نجاح/عدم تغيير/فشل لكل عنصر. تكرار طلب بنسخة قديمة لا يكرر الإسناد. اجتازت اختبارات PostgreSQL للعزل والمدخلات المكررة والفشل الجزئي وطلبين متزامنين، إضافة إلى 18/18 unit و5/5 integration وBackend/Web typecheck/build وmigrations `001`–`013` بقاعدتين. UI E2E لم يُشغّل.
- الحدود: هذه عملية متزامنة محدودة العدد؛ تغيير الحقول/الحالة/Tags/إنشاء متابعة/Export كـBulk، ومهام Bulk الكبيرة ذات Progress دائم، لم تُنفذ. Search/Views/Bulk تظل جزئية.
- الخطوة التالية الدقيقة بعد commit هذا checkpoint: ابدأ Messaging end-to-end حسب ترتيب الأولوية: راجع Connection/Sender/Binding وسلامة الأسرار والصلاحيات، ثم ثبّت sender resolution/pinning وCentral Messaging Policy في خدمة API واحدة قبل queue/worker وwebhook. اربط UI واختبارات PostgreSQL/fake provider، وحدّث الوثيقتين واحفظ checkpoints لكل مرحلة مستقرة. عُد لإجراءات Bulk الأخرى مع وحدات Field/Tags/Export ذات الصلة قبل إعلان المنصة مكتملة.

## الحالة في 2026-10-03

المشروع **غير مكتمل وغير جاهز للإنتاج**. بدأ Repository بوثائق فقط على الفرع المحلي `codex/full-platform-build`. قُرئت `AGENTS.md` و`README.md` و`INITIAL-CODEX-PROMPT.md` والوثائق السبع كاملة. مراجع `05` و`06` موجودة مسبقاً في README وAGENTS؛ لم تتطلب تغييراً. لا يوجد تعارض Business يمنع التنفيذ.

## ما أُنجز

- `technical-architecture.md` و`implementation-plan.md` ومصفوفة `requirement-coverage.md`.
- مشروع TypeScript/Fastify، React/Vite، إعداد PostgreSQL عبر Compose، وmigrations `001_core.sql` حتى `015_sender_bindings.sql`.
- API أولية: secure first-admin bootstrap، login/logout/session، user create/list/disable، branch create/list، campaign create/agent binding/activation validation، manual Lead intake، Lead list/detail/lifecycle.
- Account lifecycle: تغيير كلمة المرور وإبطال الجلسات، دعوات إنشاء المستخدمين بدل تحديد المسؤول لكلمة مرورهم، إعادة الدعوة، Forgot/Reset برموز عشوائية hashed وأحادية الاستعمال ومحدودة المدة، إبطال الجلسات عند Reset، Audit. إعداد SMTP لحسابات المنظمة من الواجهة مع تشفير credential واختبار اتصال، وworker لإرسال الروابط المشفرة في outbox مع retries/lease/dead state وقائمة حالة تسليم وإعادة محاولة ضمن الصلاحيات.
- مجموعة Contacts لمسار Manual: تطبيع صارم لهاتف E.164 والبريد مع حفظ الإدخال الأصلي، مطابقة متزامنة بأقفال مرتبة، وإبقاء Leads منفصلة. حالات الالتباس أو التطابق مع Contact خارج فرع Manager تحفظ `source_submission` في `NEEDS_ATTENTION`؛ واجهة مراجعة وحسم صريح وآمن عند التكرار، مع منع Manager من رؤية أو حسم مرشحين خارج نطاقه. قائمة/بحث/تفاصيل/تعديل Contacts في الواجهة والـAPI، و`version` لمنع فقد التعديل المتزامن، وتاريخ تغييرات وAudit. Contact مشتركة بين فروع تُقرأ ضمن Leads المصرح بها ويعدلها Super Admin فقط.
- مجموعة Dynamic Fields الأساسية: تعريفات Global/Branch/Campaign و19 نوعاً موثقاً مع Calculated، خيارات وترتيبها وتعطيلها، إعدادات العرض والصلاحيات لكل Campaign، واجهة Field Builder وLead Details وإنشاء Lead. Backend يتحقق من الأنواع وخياراتها وEditable/Visible وRequired عند إنشاء Lead وإغلاقها، ويحفظ value history ونسخ التعديل، بما في ذلك القيم المحفوظة داخل حالة Contact review. الحقول المحسوبة تُقرأ من Queries تشغيلية موثوقة ولا تخلط محاولات AI/Human. تكامل Filter/Export/Source mapping وEnrollment gate مرتبط بالمجموعات اللاحقة ولم يُعلن مكتملاً.
- مجموعة Campaign configuration الأساسية: Create/Edit/Detail/Readiness/Activate/Deactivate، قفل ونسخة إعداد لمنع فقد التعديلات المتزامنة، Agent weights/capacity والبحث والإزالة، Audit، واجهة الإعداد والجاهزية بـ3 لغات. `MANUAL` و`ROUND_ROBIN` و`WEIGHTED` قابلة للتفعيل عند نجاح الشروط؛ Source الخارجي وMessaging وAI وPerformance routing تظهر كغير جاهزة حتى اكتمال الخدمات اللازمة. تعريف Conversion اختياري للدفع/التسجيل المؤكد؛ لا تعرض المنصة معدل تحويل غير معرّف. تعطيل الحملة يمنع Manual intake الجديدة مع بقاء Lead السابقة. Setup Wizard الكامل وربط بقية الوحدات ما زال ناقصاً.
- مجموعة Lead workflow الحالية: activity وassignment history مع pagination؛ إعادة إسناد داخل الفرع بقفل وversion ونقل متابعات المالك القديم وHuman conversation controller؛ ملاحظات داخلية؛ متابعات Human مع موعد وأولوية وتعديل/إكمال/إلغاء وتاريخ/Audit؛ بحث Leads بالاسم والهاتف والبريد وID وفلاتر Branch/Campaign/Agent/Source/Lifecycle/date/follow-up/visible custom field وترتيب تاريخ الإنشاء؛ Saved Views مع scope وversion وواجهة اختيار الأعمدة وحفظها. نقل الفروع، Follow-up automation، Bulk، وفلاتر الوحدات المستقبلية باقية.
- Schema لـContact/Lead/Source Submission/History/Fields/Follow-up/Jobs، وConnection/Sender/Consent/Conversation/Message/Inbound Event. وجود Schema لا يعني اكتمال الميزات الأخرى.
- Routing أولي: scope، capacity، working hours، Round Robin وWeighted؛ Performance يستخدم fallback موضحاً ولا يحسب Human metrics بعد.
- دوال منفصلة لحسم Sender والإرسال وInbound ambiguous، وتشفير credential بـAES-GCM. هذه الدوال لم تُربط كلها بمسارات الإنتاج بعد.
- واجهة الأجزاء الحالية بالعربية RTL والفرنسية/الإنجليزية، responsive، تشمل login/setup/forgot/reset/invitation والفروع والحملات والمستخدمين والـLeads وContacts ومراجعة المطابقة. أضيفت صفحة تغيير كلمة المرور، إعداد بريد الحسابات، قائمة حالة التسليم، ربط Agent بالحملة، وتفعيل/تعطيل المستخدمين وفق الدور. لا يوجد UI E2E بعد.

## التحقق المنفذ

- `npm test`: **18/18** اختبارات وحدة ناجحة، منها اختبارا تطبيع Contacts واختبارا Field validation.
- PostgreSQL 18 الحقيقي يعمل عبر Docker Desktop/Compose محلياً، وتأكدت مجدداً من حالة الحاوية `healthy`. طبقت وأعدت تشغيل migrations `001` حتى `013` بنجاح على قاعدتي التطوير والاختبار.
- `npm run test:integration`: ناجح على قاعدة `lead_operations_test` مستقلة. يغطي سباق تهيئة أول Super Admin، منع إعادة التهيئة، login/logout وتعطيل الحساب، تغيير كلمة المرور وإبطال الجلسة وانتهاء صلاحيتها، Origin، عزل الفروع، وصول Agent إلى Lead الخاصة به، منع كشف Campaign غير مرتبطة بـLeads المسموحة، intake ومطابقة Contact المتزامنة، pagination/lifecycle، وRound Robin متزامناً مع capacity وno-eligible-agent.
- اختبار Identity على PostgreSQL مع Email adapter وهمي يغطي إعداد/اختبار الاتصال، تشفير السر، نطاق Manager/Agent، الدعوة والقبول وإعادة الدعوة، Forgot/Reset المتزامن، منع تكرار الرمز، فشل الإرسال وإعادة المحاولة والـDead/expired/disabled jobs، وقائمة التسليم دون كشف token/secret.
- وسع اختبار API على PostgreSQL لتغطية تطبيع الهاتف والبريد ورفض المدخلات غير الصالحة، إعادة استخدام Contact، حفظ Source Submission الأصلية، مراجعة الالتباس والحسم المتزامن، انعدام Lead مكررة، بحث Contacts وpagination، وصول Agent وManager، حماية بيانات المرشحين بين الفروع، منع تعديل Contact مشتركة، وتعارض التعديل المتزامن.
- `npm run test:integration`: **5/5 suites ناجحة**؛ تغطي مجموعات Dynamic Fields وCampaign الاختبارات المذكورة، وتختبر مجموعة Lead workflow على PostgreSQL النشاط والإسناد والتعارض والمتابعات ونطاق الدور، والبحث مع حقل مخفي/مرئي، وSaved Views بصلاحياتها وتعارض اسم/نسخة وحذفها واستمرار تقييد Lead بعد إعادة الإسناد. لم تُشغّل UI E2E أو مزود رسائل حي.
- بعد اختبار سلبّي، عُدّل Fastify/Ajv كي يرفض خصائص JSON الزائدة بدلاً من حذفها بصمت؛ أصبح مسار إنشاء المستخدم يرفض كلمة مرور يرسلها المسؤول. قوائم المستخدمين ومهام البريد تدعم keyset pagination.
- شغّل الـAPI فعلياً؛ `/health/live` و`/health/ready` أعادا `ok` عبر HTTP، وحالة setup من قاعدة التطوير `initialized=false`.
- شغّلت عملية `identity-worker` المحلية على قاعدة التطوير لمدة قصيرة وتأكدت أنها تبدأ وتستمر دون خطأ؛ مسار الإرسال نفسه تحقق بـfake adapter داخل integration tests فقط.
- Backend `tsc` build/typecheck: ناجح.
- Frontend `tsc -p web/tsconfig.json`: ناجح.
- `npm run web:build`: ناجح.
- `npm install`: تم بنجاح، `npm audit` أظهر 0 vulnerabilities وقت التنفيذ.
- بعد إضافة `nodemailer`، نجح `npm audit --omit=dev --audit-level=high` وأظهر 0 vulnerabilities وقت الفحص.
- UI E2E، SMTP sandbox/live، وبقية provider sandbox/live، failure/load tests الواسعة: **لم تُشغّل**، فلا تُعد متحققة. لا توجد بيانات اعتماد بريد حقيقية؛ SMTP adapter موجود لكن لم يُتحقق منه مع مزود مباشر.

## بيئة التطوير ومسألة PostgreSQL

Node.js 24.19.0 وnpm 11.17.0 وpnpm 11.25.0 متاحة. Docker CLI ليس في `PATH` داخل Codex رغم وجود مساره `C:\Users\Bashar\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe`؛ القراءة والتشغيل داخل العزل رُفضا. المسار المعتاد `C:\Program Files\Docker\Docker\resources\bin\docker.exe` غير موجود. بإذن تشغيل محدد نجح CLI، وظهر Docker Desktop 4.93.0 وEngine 29.8.1 وCompose 5.5.1. سُحبت صورة `postgres:18` وشُغّلت حاوية المشروع Healthy. وُلدت كلمة مرور تطوير عشوائية في `.env` ورابطها في `.local/database-url`، وكلاهما متجاهل من Git. لم تُستخدم `embedded-postgres` خارج العزل، ولا أي Production credential أو حساب شخصي.

## ما بقي وأولوية المتابعة

جميع المناطق غير المكتملة موثقة في `requirement-coverage.md`. Account lifecycle بُني واختُبر بمزود بريد وهمي، لكن UI E2E وSMTP sandbox/live ما زالا مطلوبين للتحقق الشامل؛ Email العام للإشعارات لم يُبن. Contacts أُنجزت لمسار Manual مع اختبارات PostgreSQL؛ ربط external participant identifiers ينتظر مسارات Messaging/Source الفعلية. Dynamic Fields الأساسية تعمل مع Manual Leads؛ فلتر الحقل المرئي في Search مثبت، بينما Export وSource mapping وEnrollment gate ستُربط عند بناء تلك الوحدات. Campaign configuration الأساسية تعمل لمسارات Manual والتوزيع الجاهز، لكن Source/Messaging/AI/Performance وSetup Wizard الشامل تعتمد على وحدات لم تكتمل. Lead workflow/Follow-ups/Search/Saved Views الأساسية مع ترتيب تاريخ الإنشاء واختيار الأعمدة وBulk assignment المحدود اجتازت اختبارات PostgreSQL؛ بقية Bulk وفلاتر الوحدات اللاحقة لا تزال ناقصة. الأولوية التالية وفق dependencies: Messaging end-to-end قبل AI؛ بقية Bulk تُستكمل مع اعتمادياتها. اختبارات API الحالية لا تغطي كل failure paths أو الصلاحيات في الميزات غير المبنية. لا يُعلن أي تكامل `Live Provider Verified` دون بيانات اختبار خارجية مصرح بها.

## الخطوة التالية الدقيقة

ابدأ Messaging بتوصيلات قابلة للإدارة من الواجهة، senders وbindings ونطاقاتها، ثم sender resolution/pinning وCentral Messaging Policy الموحدة، ثم outbound queue/worker وinbound webhook/review وprovider adapters. اختبر كل مرحلة مع PostgreSQL وfake providers وحالات الصلاحيات والتكرار والفشل، وحدّث الوثيقتين واحفظ commit محلياً بعد كل checkpoint مستقر. PostgreSQL التطويري جاهز عبر Docker Compose؛ راجع `runbook.md`. لا تعتبر الـSchema أو الواجهة الجزئية إكمالاً للمنصة.
