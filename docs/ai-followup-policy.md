# سياسة AI Follow-up

## اعتماد محتوى المتابعة

تضيف migration 234 إعداد «رسالة متابعة AI» في الحملة. يختار المسؤول الحالي قالبًا معتمدًا ومربوطًا بالحملة ومتوافقًا مع لغتها ومعرفتها المنشورة. يمكن تحديد قيم القالب الثابتة ومعاينة النص. يحتفظ `ai_followup_message_policy` بالاعتماد الحالي، ويثبت `ai_followup_message_history` وAudit النسخة والسبب. يؤدي تبدّل نسخة الربط أو المعرفة أو القالب إلى فقد جاهزية الاعتماد السابق. يُستخدم الإعداد عند تشغيل المتابعة المجدولة بعد استكمال ربطها بالاستحقاق والسياسة المركزية والطابور.

## الاستحقاق الموثوق والتوقف

تلتقط migration 235 انتقال محاولة عامل الرسائل من `PREPARED` إلى `ACKNOWLEDGED` عندما يطابق إقرار المزود الرسالة المثبتة في المعاملة نفسها. يتحقق `ai_followup_schedule` من الحملة والتحكم والقالب والإصدارات، ويحسب الموعد من تاريخ الإرسال الفعلي والتأخير الأول. يثبت العامل الموعد المستحق ذرّيًا دون إنشاء رسالة جديدة. يُوقف رد العميل المؤهل أو تغيّر التحكم أو دورة Lead السجل المعلق ويحفظ Audit. يعيد العامل تقييم الإعداد الحالي عند الاستحقاق. يقرأ الموظف المخوّل السبب والموعد من تفاصيل Lead. تأتي صلاحية إرسال رسالة المتابعة وعدد المحاولات من مرحلة التشغيل التالية.

## إدراج محاولة المتابعة في طابور الرسائل

يضيف البناء 236 `ai_followup_send_action` لربط كل موعد بمحاولة واحدة. يحفظ PostgreSQL القالب المعتمد والرسالة والطابور في معاملة واحدة. يستعمل العامل عرض القالب المشترك مع Initial AI ويعيد تطبيق Central Messaging Policy عند الإدراج وعند التحضير عبر `sender_outbound_lease`. يظهر الحجب وإقرار المزوّد في تفاصيل Lead. تبقى بيانات الرسالة ضمن Transport الوهمي المصرح به للاختبار. يدعم هذا البناء محاولة واحدة ويحتفظ العمال الموجودون بتعافي مزوّد الرسائل وحالات `UNKNOWN`. يتبع التسلسل والإجراء النهائي في المرحلة التالية.

## تسلسل المحاولات والإجراء النهائي

يحسب البناء 237 التأخير التالي من تاريخ إقرار إرسال المتابعة السابقة. يبقى ترتيب المحاولة مرتبطًا بالنسخة الأصلية للسياسة، وتتوقف أهلية المتابعة عند تغيير النسخة أو الرد أو تغير التحكم. ينتج الإقرار الأخير سجل `ai_followup_final_action`. يطبقه عامل AI مستقلًا عن معاملة المزوّد بعد إعادة التحقق. ينهي `COMPLETE` دورة المتابعة ويحفظ حالة Lead. يحوّل `HANDOFF` المحادثة إلى انتظار موظف عندما تسمح الأداة الحالية، مع تاريخ التحكم وAudit. تظهر النتيجة في تفاصيل Lead. لا ينتج `UNKNOWN` محاولة لاحقة أو إجراءً نهائيًا.

## النطاق والمرجع

01 §67 و02 §49 و03 §47 و04 §§27–35 و05 §§15،19 تتطلب سياسة لكل حملة مع توقف عند التحويل أو تولّي الموظف أو الإغلاق، ومرور إرسال كل متابعة عبر Central Messaging Policy. تتحقق بوابات التشغيل من الشروط الحالية وتستخدم الطابور المشترك.

عند حجب المتابعة مؤقتًا بسبب نافذة الإرسال أو الحد الأدنى بين الرسائل، يحتفظ `background_job.run_after` بموعد التحقق التالي. يستخدم العامل توقيت الفرع لحساب فتح النافذة ويعيد تقييم السياسة عند استحقاق المهمة. إذا تغيّرت السياسة بعد الإدراج، تعود الرسالة نفسها إلى الطابور ويُحرّر lease دون استهلاك محاولة مزوّد. بقية أسباب الحجب تمنع التحضير وفق السياسة الحالية. تعرض تفاصيل Lead موعد التحقق وسببه. إرسال بيانات عملاء عبر AI إلى مزوّد حي معطّل، والتحقق الحي معلّق على الاعتماد والإعداد الخارجيين.

`ai_followup_policy` مصدر versioned مستقل للحملة، مع تعريف strict:

- `enabled`: تفعيل السياسة المسجلة؛ لا ينشئ مهامًا ولا يفعّل AI من تلقاء نفسه.
- `initialDelaySeconds`: تأخير initial response من anchor موثوقة تختارها خدمة runtime للفعل الأول المناسب.
- `delaysSeconds`: تأخير كل Follow-up من last eligible sent action في دورة المتابعة؛ order يحدد المحاولة. `maxAttempts` مشتقة من عدد التأخيرات، دون تعارض مع field آخر. لا تأخيرات Business hardcoded؛ UI تتطلب إدخال قيمة لكل إضافة.
- `stopOnReply`: اختيار التوقف عند رد العميل في الدورة الحالية.
- `finalAction`: `COMPLETE` تنهي AI follow-up cycle كحالة تشغيلية، أو`HANDOFF` تطلب التحويل وفق التطبيق المصرح به. لا تغييرPayment/Enrollment/Lead status field أوautomatic Lead closure.

عدد التأخيرات bounded تقنيًا بـ40؛ القيم positive PostgreSQL integer seconds وinitial delay تسمح بصفر. Enabled تحتاج محاولة واحدة على الأقل. Disabled يمكن أن تحتفظ بالتأخيرات/history أوتبقى بلاschedule. هذه حدود technical payload، وليستBusiness schedule مفترضة.

## توقف إلزامي والسياسة المركزية

Human Controller أوNONE،Conversation خارج AI_ACTIVE/AI_WAITING_FOR_LEAD،Lead CLOSED/ARCHIVED،handoff أوclosed Conversation توقف التوقيت قبلأيfinal action. إعداد الحملة لا يستطيع تعطيل هذه الحواجز؛ attempts لتضمين stopOnHumanTakeover=false أوunknown policy keys ترفض في JS/JSON Schema/native SQL. `stopOnReply=false` لا يتجاوزcurrent Controller/closed/handoff.

Timezone وsending window وfrequency/max attempts تؤخذ من Central Messaging config الحالية. Policy timing لا تستبدلها ولا تمنح send authorization؛`DUE` نتيجة زمنية فقط،و`sendAllowed=false` ثابتة فيPreview. Worker المستقبلية تحتاجcurrent Lead/Conversation/control/pinned Sender/scope/health/consent/provider/template/window/frequency/idempotency checks قبلكلdispatch. لاfallback Sender أوAI restart بعدhuman takeover أوSLA من هذه policy.

## Backend وDB وUI

Manager فيفرعه وSuper Admin فيOrganization تدير:

- `GET/PUT /api/ai/campaigns/:id/followup-policy`.
- `POST .../preview`: hypothetical inputs صريحة،current config version وDB clock،write-free؛تعرضinitial eligibility/next timing/stop/exhaustion/mandatory stops.
- `GET .../history?before=&limit=` و`GET .../versions/:version`: metadata paginated ونسخة أصلية scoped.

Current active session/role/Branch/Campaign تفحص عبرخدمةConfiguration المشتركة؛ Agent403 وforeign Campaign404. Branch disabled تمنعالحفظوتبقيhistory read للمراجعة. Optimistic version وCampaign lock ينظمانfirst insert وedits؛Stale version409 لاforce overwrite. Native101 تفرضshape/scope/session/version وimmutablehistory وatomicAudit؛أخطاءAudit ترجعcurrent definition/history معًا. لاhardcoded Connection أوdeployment setting لهذهالإدارة.

Campaign UI ar/en/fr تتيحenable/timing/order/removal/stop/final action/reason/history/reload وhypothetical timing preview. Effective AI preview تضيفcurrent policy/version/maxAttempts/mandatory stops إلىcanonicalhash؛campaign isolation محفوظة. Runtime blocker يبقىصريحًا ولا`assistantReady=true` أوallowedTool جديدة. UI تقفلالتحرير والحفظ والمعاينةأثناءالتحميل/الحفظ،وتحجبنتيجةload قديمة بعدCampaign switch/unmount؛لايمكنلGET أولية متأخرة أنتستبدلتعديلالمستخدم. Browser regression تؤجلGET عمدًا وتثبتالقفلثمالحفظالصحيح.

## التحقق والاستكمال

Implemented وPostgreSQL/Local Browser Verified:162unit/67full Integration/35full Edge Browser،focused PG/Browser1/1 وmigrations001–101 وBackend/Web build/typecheck. Full Browser كشفload race ثمأعيدبنجاحبعدإصلاحUI واختبارGET مؤجلة؛RTL390px فُحصت. Actual jobs/dispatch/sends/activation غيرمنفذة،ولاLive AI verification. Unit تختبرpure timing/current mandatory stops/exhaustion/schema. Integration تستعملDocker PostgreSQL للتحققمنcurrent access/native history/Audit/concurrency/pagination/isolation/DBclock وغيابMessage/job/Followup mutations منpreview. Browserتتحققمنsetup/save/preview/history/negative scopes/RTL/French.

الخطوةبعدهذهprerequisite: بقيةdisclosure/formality/handoff/closed-returning policies،ثمapproved AI/Form tools/source provenance وruntime/execution snapshots/actual jobs/sends/assistant simulations/evaluations. CoreHuman operations تبقىعاملة. لاinference أوLive AI Provider verification منهذهالإعدادات.
