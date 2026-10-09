# Human Copilot: مصدر موثوق وملخص مشتق

## النطاق والفصل بين المساعدين

المراجع: 02 صلاحيات Agent وLead،03 §§66–67،04 §§6–8/39–40/85،05 Campaign isolation،06 §12 وAGENTS §§8/19–29. هذه العملية تساعد الموظف في قراءة محادثة يملك صلاحيتها. تنتج **extractive summary**: اختيار مقتطفات مهمة بواسطة Model، ثم بناء العرض من النصوص الأصلية المطابقة مع direction/author/delivery attribution. لا تقبل صياغة حرة أو claim تجارية جديدة، ولا تستنتج إثبات دفع من كلام العميل.

Copilot Summarization مستقلة عن **AI Conversation Agent**. لا ترسل رسالة ولا تغيّر Field أوLead أوPayment أوEnrollment ولا تنفّذ Handoff تلقائيًا. أدوات Customer Agent وQualification وFollow-up وHandoff والإرسال عبر Central Messaging Policy تُنفّذ لاحقًا بعقد approved execution مستقل؛قيود هذه العملية لا تصبح قيودًا عامة على قدرات AI Runtime. Suggest reply وfollow-up recommendations وOperations Assistant وبقية Copilot ليست مكتملة بهذه المرحلة.

## تعطيل الاستخدام الحي

المستخدم أجاز تنفيذ OpenAI Responses باستخدام بيانات اصطناعية وHTTP mocks فقط، ولم يفعّل إرسال بيانات عملاء حقيقية. Production/default API ترفض إنشاء inference بـ`AI_LIVE_DATA_TRANSFER_DISABLED`،وworker الافتراضية تحوّل المهام القديمة إلىBLOCKED قبل فك credential أوتكوين provider payload. local authorized source review وhistorical read لا يحتاجانprovider HTTP.

لاenv flag أوsetup toggle يفتح النقل الحي. `aiReadTestAdapters` وworker adapter injection متاحتان للاختبارات فقط بعد فحص `current_database()=lead_operations_test` و`NODE_ENV!=production`. اختباراتنا تستبدل HTTP إلى المزوّد بmocks؛لاحساب شخصي أوProduction key أوlive customer call. لا تستخدم test injection لتشغيل منتج حي. **HTTP Mock Verified / Live Verification Pending External Credential/Approval** بعد اجتياز البوابة. تفعيل حي لاحق يحتاج إعدادًا وموافقة وضوابط تقليل بيانات وتقييمًا موثقًا من داخل المنتج،لاDB override.

## Approved read boundary

`approvedConversationReadContext` تقفل وتعاد فحص Organization/Branch/current User-role-session وLead ownership وConversation. Agent يقرأ Leads المسندة إليه فقط؛Manager ضمنفرعه وSuper Admin ضمنمنظمته. URL إلىLead أوConversation أخرى →404. Active Branch وHUMAN/HUMAN_ACTIVE وSUMMARIZATION Profile متاحة بشروطcurrent Connection/catalog/shared grant مطلوبة لعملية جديدة. اختيارSUMMARIZATION Profile صريح لCopilot ولايتطلب تفعيلcustomer-facing AI.

Snapshot تشملcurrent Campaign configuration/Published Knowledge versions وLead/Conversation/controller/owner/pinned sender versions،معinvoker/session proof. Native source تستخرج أحدث20سجلًا نصيًا وحتى2000حرف لكل سجل بترتيب ثابت؛`truncated` تبيّن التحديد ولا تدّعي تلخيص التاريخ كاملًا. لاDynamic Field values أوinternal notes أوattachment bytes/OCR أوDraft أوForeign Campaign data.

Payload إلىModel يقتصر علىpurpose ثابتة،المقتطفات المسموحة واللغة. لاactor/session/Lead/Conversation IDs أوConnection/Profile configuration أوcredentials أوpayment records أوtrusted financial counts. يستبعد التطبيق مقتطفات تحمل أنماط credentials/cards/IBAN/passwords بما فيهاالأرقام العربية؛الاستبعاد كامل ولايعيد كتابة النص الأصلي. هذا safeguard محافظ للاختبارات **ليس ضمان live DLP**؛النقل الحي يبقى معطّلًا حتى الضوابط المطلوبة. النصوص غيرالموثوقة بيانات،لاSystem instructions. Model لا تحصل علىtools أوSQL أوProvider actions.

## API وdurable execution

- `GET /api/conversations/:id/ai-summary-context`: approved local read؛providerInvoked=false وحقائقDB وexecution availability/blocker؛لاcredentials/configuration DTO.
- `POST /api/conversations/:id/ai-summaries`: `requestId` فقط؛202 جديد أو200 تكرار مطابق. unique Campaign/actor/request معkind/Conversation conflict fence وadvisory lock؛لاclient actor/source/tool/financial facts.
- `GET .../ai-summaries`: keyset history،10 افتراضيًا وحتى50.
- `GET .../ai-summaries/:summaryId`: نتيجة مشتقة،generatedAt وstale وoriginal knowledge/context trace وstate history،معcurrent access. التاريخ يبقى قابلًا للقراءة بعدإغلاقConversation أوتغييرProfile للمستخدم المخوّل الحالي،ولا يعطي صلاحيةInference جديدة.

104–106 توسّعdurable readonly queue بـCOPILOT_SUMMARY وLead/Conversation identity وnative source/current dependencies/result/lease/immutable history/Audit. أدوات customer-facing المستقبلية لا تستعمل readonly result validator لإثبات mutation. `processOneAICopilotSummary` تستخدمshared lease/retry mechanics،لكنauthorize تعيد بناءfull current snapshot وتقارنcanonical كاملة قبلHTTP وقبلcompletion. تغييرcurrent owner/session/controller/profile/grant/Published/config/source يحجب النتيجة؛لاtransaction مفتوحة أثناءHTTP.

Lease60s وtimeout20s وخمس محاولات بتأخير حتى300s؛auth/unsupported/refusal/incomplete/invalid output نهائية،rate/network/5xx قابلة لإعادة المحاولة بحد. Completion تحتاجlease الحالية غيرالمنتهية؛logical result وحيدة. عشرpending لكلactor/Campaign تشملreadonly kinds معًا. حدودimplementation قابلة للمراجعة بالقياس وليستBusiness capacity معلنة. Audit/history بذريان معrow؛Audit يحملAssistant action/User/Lead/Campaign/Conversation/Profile/KnowledgeVersion/context hash/result state/failure code،دوننصوص أوcredentials أوraw provider errors.

## العرض والحقائق

الملخص يحملوقت التوليد وstale عندتغيرsource الحالية. Source refresh وnew generation صريحان؛original summary لايُعدل بعدcompletion. UI ar/en/fr تقرأhistory وتpoll pending بحد،وتحفظidempotency key بعدunknown POST failure وتمنعlate selected-Conversation responses. current-access failure يزيلنتيجةالاختيارمنالعرض. React plain text لا ينفذHTML.

Confirmed Payment count وEnrollment count تأتي منnative DB،خارجModel payload/result. أقوال«دفعت» تبقىCustomer quotes. لايعاد تفسيرها إلىPayment،ولا تُنشئ Enrollment. حتىcopilot ANSWER أوHANDOFF لايأذنإرسالًا أوaction. Remaining original conversation history متاحة دوناستبدالها بملخص.

## بوابة الإثبات

Unit تثبتminimization والعقدالمستقل/strict structured no-tool/no-store HTTP mocks. Docker PostgreSQL تختبرscoped read،native source/identity/result/terminal/Audit rollback،eight-way duplicates/four-way workers،current owner/session/Profile/controller،midflight source change،bounded failure/retry،pagination،trusted claim separation وlive-off قبلcredential/HTTP. Browser تختبرactual managed Profile→authorized source→queue→production HTTP adapter mock→result/history/stale/failure وAgent foreign denial/XSS/French/RTL. النتائج النهائية وعددها فيprogress/coverage؛لاLive model semantic evaluation أواكتمالAI/المنصة بهذه المجموعة.
