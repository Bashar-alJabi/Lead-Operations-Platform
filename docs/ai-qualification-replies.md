# متابعة Qualification برسالة معتمدة — Native150–152

## النطاق والقرار

تنفيذ 04 §§17–20 وApproved Tools و05 Central Messaging Policy: بعد actual typed AI Qualification write، يمكن متابعة **أول سؤال معتمد غير مجاب بالترتيب** إذا كانت النتيجة التشغيلية غير مكتملة ولا تطلب Handoff. لا يعاد طلب قيمة مجابة؛ `false` و`0` إجابتان. لا يُخترع نص إكمال أوادعاء تجاري. إذا اكتملت Qualification أوطلبت السياسة Handoff فلا ينشأ SEND child، حتى إن غاب grant لأداة Handoff. مسار Handoff القائمة من Native142 مستقل وله الأولوية.

هذه مرحلة من AI Conversation Agent، ولا تمنح Copilot إرسالًا أوتعديلًا تلقائيًا. Runtime/full activation والنقل الحي باقيان معطلين حسب تصريح المستخدم. الاختبارات Synthetic PostgreSQL وHTTP mocks؛ لا Live Provider Verified.

## المصدر والسلطة

- `ai_qualification_send_source` immutable، مرتبطة بـoriginal fresh Send admission وactual APPLIED Qualification receipt. Native AFTER answer-history trigger تنشئها داخل transaction الإجابة،بعد وجود current Answer ونسختها وmapped Field/history إن وجدت. لا backfill أوإعادة استعمال receipt قديمة،ولا fabricated inbound أوتغيير decision الأصلية منQUALIFICATION.
- Context الجديدة تساوي **exact Native142 own-write delta**: نسخة إجابة السؤال المحفوظ وحدها،ونسخة قيمة Field المرتبطة إن وجدت. كل Scope/Owner/Controller/Knowledge/Profile/Configuration/grants/مصدر الرسالة وبقيةالحقول تبقى مطابقة. Current trusted outcome وnext approved question محفوظتان ويعاد التحقق منهما.
- `ai_customer_send_source_context` projection تاريخية فقط؛ `ai_customer_send_admission_context` الجديدة تعيد أقفال Branch→Campaign→Lead→Contact→Conversation/dependencies وتقارن canonical current context بالمصدر. دالة147 الأصلية محفوظة باسم `ai_inbound_send_admission_context` وتبقى صارمة؛ لا تصبح Qualification سلطة ANSWER/QUESTION قديمة.
- child source الجديدة فقط تنشئ durable SEND job وNative144 bounded local queue. Recovery القائمة تستعمل current locked factory؛ لا تضيف صلاحية أوتجدد source قديمة.

## الرسالة والتسليم

نفس Application Service وCentral Messaging Policy وimmutable Action/Message/Outbox من148–149. محتوى continuation هو current approved prompt معdisclosure الموروثة بالقواعد القائمة؛ لا نص موديل حر. فحص المحتوى الحساس قبل الكتابة باقٍ. Action تحفظ `qualification_action_id` وcontext المصدر الجديدة،وتسجل الرابط فيAudit وLead activity دون قيم أوأسرار.

Dispatch تسمح بتركيب **الإجابة الخاصة المثبتة ثم الرسالة الخاصة وحدها**. تقارن original authenticated inbound fingerprint بعد exact answer delta ثم تطبيع latestMessageId للرسالة المصدر؛ Tool policy وConsent/outcome/next question تعاد حاليًا. أي Owner/version/Field binding/value/Knowledge/config/controller/sender أوinbound أخرى تمنع الإرسال القديم. Atomic outbox/deferred proof وcurrent lease margin وUNKNOWN no-replay وlive-off قبلdecryption باقية. لا fake Human Principal أوجلسة موظف مصطنعة.

Native151 إصلاح إضافي بعد تطبيق150: composite row types تحفظ شكلNULL المعروف لمسارات غيرQualification. Native152 تفصل اسمchild source variable عنHandoff SQL alias؛فحصSQL أصليأثبت42702 قبلالإصلاح،وregressionتفحصcurrent-context لـSend وQualification-derived Handoff. لا تعديلmigration مطبقة أوbackfill للبيانات القديمة.

## الواجهة والصلاحيات

History ترجع Qualification وSend كإجرائين مستقلين،وتحفظ decision الأصلية. Message ID وdelivery state تخصSend وحدها؛ primary Qualification لا ترث تسليمSend أوerrorCode الخاصةبها عبرCOALESCE،بمافيذلكAPPLIED Qualification معBLOCKED Send. DTO تربط child بالـreceipt،ولا تعرضcontext أوanswerValue أوquestion schema المخفية. الواجهة ar/en/fr تفرق حفظالإجابة عنطابورالرسالة وعنالتسليم؛ actual customer-facing prompt تظهر فيmessage history كنصescaped وفقصلاحيةConversation. Failed read تمسحالإجراءاتالمعروضة.

## الاختبارات وحدود الاكتمال

`qualification-send-scenarios.ts` ضمنroot AI sends: actual mapped false answer وnext question،exact native context/no retroactive grant/immutable source/no receipt replay،eight workers،deferred extra-write denial،answer/history/child/job rollback،current Owner/tool/config/binding/sender/Human edits،actual parent-lock race،changed Field beforedispatch،hidden Field metadata،scoped DTO/Audit،Handoff priority وcompletion no invented send. Browser مستقلة تستخدمactual Responses/Meta adapters معHTTP mocks وsignedinbound،وتثبتtwo actions→QUEUED→SENT،consent-block معإبقاءالإجابة،Human takeover،unauthorizedAgent،failedread وlocales/RTL/noXSS.

نتائج البوابة النهائية تسجل فيprogress/coverage بعد التشغيل؛ وجودهذهالوثيقةلايثبتنجاحالبوابة. لا تُكمل هذهالمرحلة initial contact أوreturning/follow-up/transition messages أوfull AI/tool/readiness. التالي trusted Lead intake source وcurrent Owner/availability/initial-handoff rule،ثم بقيةAI والوحداتالرئيسية وفقالخطة.
