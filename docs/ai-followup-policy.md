# سياسة AI Follow-up

## النطاق والمرجع

01 §67 و02 §49 و03 §47 و04 §§27–35 و05 §15 تتطلب policy لكل Campaign، مع توقف عندhandoff/human/closed ومرور الإرسال عبرCentral Messaging Policy. هذه المرحلة prerequisite للإعداد وقرار التوقيت؛ actual jobs/dispatch وassistant activation غير منفذة فيها.

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
