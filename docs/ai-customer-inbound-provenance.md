# مصدر Customer AI inbound وسجل التنفيذ المحجوب

## الحد الوظيفي

هذه المرحلة prerequisite لتشغيل AI Lead Assistant وفق 04 §§6–8/19/32/51–55 و05 Campaign isolation. المسار الفعلي هو authenticated webhook → durable integration event → resolved inbound worker → Message محفوظة → native provenance → terminal BLOCKED → scoped Lead/Conversation UI. لا inference أو tool execution أو Customer send أو Qualification/Payment/Enrollment mutation. ليست اكتمال customer AI runtime أو Handoff.

تختلف سلطة AI Lead Assistant المستقبلية عن Human Copilot: مصدرها Campaign/Lead/Conversation وController وحدث وارد موثّق وأدوات معتمدة. لا انتحال User أو ربط التنفيذ الذاتي بصلاحية جلسة ناشر الإعداد. أما الموظف الذي يقرأ التاريخ فيحتاج جلسة حالية وصلاحية Lead الحالية.

## توثيق المصدر

`messaging_inbound_authentication` تسجل فقط أحداث INBOUND_MESSAGE الجديدة المقبولة بعد raw-body HMAC verification في Meta webhook الحالي. تحفظ algorithm وSHA-256 للطلب والـevent payload ووقت التحقق؛ لا App secret أو signature أو token. Middleware هو حد التحقق المشفّر، وليس Trigger يتحقق من HMAC بنفسه؛ حساب التطبيق الذي يملك Database writes جزء موثوق من البنية. SQL guard يمنع تغيير/حذف الإيصال ويربطه بنوع الحدث والمزوّد.

الـduplicate لا يعيد كتابة المصدر، ولا يمنح legacy event بلا receipt ثقة بأثر رجعي. لا backfill تخميني. Provider adapters التالية تضيف authenticity contract الخاص بها؛ لا يفترض دعم HMAC Meta لمزوّد آخر.

`ai_customer_inbound_context(eventId)` تبني statement snapshot أصلية من بيانات PostgreSQL الحالية: event PROCESSED والرسالة المرتبطة به وProvider message ID وparticipant وConnection وpinned Sender وscope identities. `108` تفرض أيضًا مطابقة نص Message مع محتوى الحدث المقبول، فلا يكفي source_event_id أو source=AI من caller. Ambiguous/unresolved/unsigned sources لا تكتسب execution proof.

## تقليل البيانات وتغيّر السياق

الـsnapshot تحفظ معرّفات وversions وSHA-256 لـbody/configuration/Published Knowledge/immutable asset manifests وQualification definitions/options/validation، وcurrent Field-value/answer versions وConversation Profile/catalog/shared grant/connection health. لا تنسخ نص العميل أو Knowledge أو credentials أو بيانات الدفع، ولا تقرأ Draft أو Campaign أخرى.

Native fingerprint مبنية على canonical PostgreSQL jsonb، ومستقلة عن JavaScript simulation hash. تاريخ BLOCKED immutable؛ تغير Published version/Profile/grant/controller/owner/Field binding/Lead parent يجعل `stale` ظاهرة دون إعادة كتابة السياق القديم. هذه دلالة مراجعة تاريخية، **ليست قفل تفويض لتنفيذ Tool**. يجب على actual action executor التالي إعادة التفويض تحت locks وCAS الحالية وقبل/بعد I/O؛لا يجوز استعمال equality diagnostic وحدها لإجازة mutation.

كل event/Message تملك execution واحدة بـunique constraints وidempotent application service. Capture وAudit وMessage attachment وcontroller failure state ضمن transaction معالجة الوارد؛Audit failure يعيدها atomically، والحدث المقبول يبقى في durable recovery path القائم. Human-controlled traffic يتجاوز تركيب AI context غير اللازمة.

## المنع الحالي والواجهة

`ai_customer_inbound_execution` تسمح فقط بـBLOCKED و`AI_LIVE_DATA_TRANSFER_DISABLED`، دون mutable result/lease أو tools. لا يوجد public enqueue/mutation endpoint أو زر activation جديد. Approved tools فارغة وliveTransferEnabled=false. هذه السجلات لا تصلح لتأكيد دفع أو جمع Qualification، ولا يمرّ عبرها أي Model request أو credential decryption.

`GET /api/conversations/:id/ai-customer-executions` تعيد keyset pagination محدودة، ومعرّفات المصدر ووقت التنفيذ وKnowledge version وsafe error/hash/stale. لا raw context/configuration/Profile credentials أو customer text. Current User/session/Organization/Branch/assigned Lead access مطبقة داخل transaction، وLead-parent fence تمنع عرض artifact قديمة بعد إعادة ربط Conversation. Closed/Human/disabled Branch لا تمحو التاريخ المصرّح بقراءته. كل قراءة ناجحة لها Audit دون content.

واجهة ar/en/fr تدعم explicit refresh وpagination وempty/error/stale، وتمسح النتائج عند تبديل المحادثة أو فشل التفويض، مع async sequence fence. العرض React text فقط.

## الخطوة التالية

Typed Human Qualification application writer استُخرجت بعد620604c مع current exact Human proof/locks وnative100 HUMAN-only،وبوابة168unit/72PostgreSQL/41Edge؛التفاصيل في[lead-qualification-results.md](lead-qualification-results.md). التالي durable customer worker بlease/result وseparate current execution/action proofs وapproved tool executor،مرتبطًا بنفس المصدر وcurrent AI controller/configuration/Published Knowledge/Profile/grant/Field versions. بعد ذلك actual AI Qualification وHuman Handoff والـLead UI والتقييمات،ثم sends عبر Central Messaging Policy وinitial contact/returning/follow-up/SLA. لا تحوّل BLOCKED artifact إلى action proof ولا تستعمل Human-session/readonly Copilot result لتفويض Customer AI.

Live customer-data inference معطّلة حسب موافقة المستخدم. لا تفعيل حي دون الإعدادات والموافقات والضوابط اللازمة؛حالة AI العامة `Live Verification Pending External Credential/Approval`.

## التحقق

البوابة ناجحة: migrations001–109 development/test،168/168 unit،72/72 full Docker PostgreSQL integration،41/41 full Edge Browser E2E،focused PG1/1 وBrowser1/1 وBackend/Web build/typecheck وdiff check. Native signature/source/content/scope/tool-list forgery وconcurrent idempotency وcurrent history/scope/version/parent fences وAudit rollback وno financial/customer writes مثبتة. SQL record alias أصلح في109 دون تغيير applied checksums. أول full Browser كشف fixture-name collision مع selector قديمة؛أصلحت بيانات fixture الجديدة وأعيدت focused/full Browser بنجاح. فُحصت الصورة العربية390px. سيناريوهات المرحلة تستخدم synthetic HMAC/HTTP ingress وPostgreSQL Docker وEdge المحلي،ولا تختبر Model semantics أو Live provider.
