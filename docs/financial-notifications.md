# إشعارات Payment وEnrollment داخل المنصة — Native166

## حدود مصدر الحقيقة

`PAYMENT_CONFIRMED` و`ENROLLMENT_CONFIRMED` حدثان داخليان منفصلان. لا يثبت Notification وجود دفع؛هو أثر من trusted financial transition المحفوظة أصلًا. لا مصدر لهما من success/return page أو customer claim أو رفع إيصال أو checkout/capture ACK أو Alma IPN غير الموقعة. لا Provider جديد أو credential أو financial API write في هذه المرحلة.

تبقى `guard_payment_record` و`guard_bank_payment` و`guard_enrollment` وtrusted confirmation/read/reconciliation guards الحالية هي سلطة الدفع. تُنشئ AFTER triggers الحدث الأول فقط عند دخول Payment فعليًا حالة `CONFIRMED`،والثاني عند INSERT فعلية إلى Enrollment مرتبطة بدفع مؤكد. تحديث PENDING→CONFIRMED مدعوم؛PENDING/FAILED/EXPIRED لا تنشئ إشعار تأكيد. لا أحداث رجعية لسجلات قبل migration،ولا fan-out لكل مستخدم أو queue غير لازمة لـIn-App.

## Native proof والذرية

الحدث له FK إلى Payment/Enrollment و`UNIQUE(event_type,source_id)`. Native guard تتطلب nested fresh operation وsame-transaction row proof،وتشتق المصدر والوقت والنطاق والـLead من السجل الحقيقي. Event/source fields لا تأتي من العميل،والحدث immutable. حراسة المصادر السابقة وHandoff/SLA/Lead/Follow-up وFK/shape isolation محفوظة؛لا يسمح استعمال financial ID كمصدر لنوع آخر.

تُحفظ أحداث Payment وEnrollment وAudit داخل المعاملة المالية نفسها. فشل Audit في إشعار Enrollment يرجع أيضًا Payment وإشعارها وtrusted Bank confirmation وEnrollment؛لا نجاح مالي جزئي معلن من هذا المسار. worker التاريخية تستمر بقواعد retries/leases/UNKNOWN الحالية،ولا تعيد financial POST بسبب تعطل إشعار. في manual reconciliation يُعرض الخطأ الآمن ويستعمل المستخدم المصرح له المسار نفسه بعد إصلاح السبب. لا SQL replay أو event INSERT يدوي.

Scope مصدرها organization/branch من immutable hosted intent أو Bank request. hosted campaign من intent،وBank campaign من Lead المرتبطة وقت التأكيد لأن Bank request الحالية لا تختزن campaign snapshot. القراءة تتطلب تطابق نطاق الحدث مع Lead/Campaign الحاليين؛تغيير ملكية Lead داخل الفرع لا يحذف التاريخ،والـAgent السابق يفقده. قبول transfer بين Branches وfinancial historical visibility يبقى ضمن متطلب Lead transfer/cross-module acceptance غير المنفذ،ولا تُخترع صلاحية لقراءة فرع سابق أو يُحجب تأكيد مالي بسبب تعطيل requester/rotation فقط.

قبل rollout فعلي قِس فحص CHECK/FK وأقفال الجدول على حجم staging،ونسّق ترقية API/UI/financial workers مع migration في نافذة صيانة؛نسخة قديمة من renderer قد لا تعرف أنواع الأحداث الجديدة. لا تدّعِ توافق rolling deployment بلا اختبار،ولا تعمل downgrade بحذف الأحداث أوtrusted records. migrations001–166 محلية فقط حاليًا؛لا Production deployment مصرح بها.

## Backend والواجهة

نفس Notification Center وindicator وread/unread CAS وhistory الحالية،والتفضيلات الشخصية لكل نوع مستقلة. Manager يرى الفرع وSuper Admin المؤسسة وفق current role/scope/Session،وAgent يرى Lead المملوكة له حاليًا. لا تتطلب هذه الأحداث Conversation وهمية. API تعيد internal `paymentId` و`enrollmentId`،والثاني null في إشعار Payment حتى لا يختلط السجلان. لا account identifiers أو payment refs أومبالغ أوcredentials في payload الإشعار.

الإدارة تختار النوع في wording editor الحالي؛Campaign→Branch→Global→safe defaults لكل لغة ar/en/fr،والـAgent يدير تفضيلاته فقط. Personal financial preference group تعيد استخدام نفس عقد القراءة/الحفظ وversion/failure clearing للمجموعة التشغيلية؛لا business permission جديدة. النص plain escaped text والمتغيران `{{campaign}}` و`{{owner}}` فقط. Defaults تشير لمراجعة المصدر والمبلغ وسجل التسجيل من Lead،ولا تصف التحويل اليدوي بأنه تأكيد آلي من Bank API.

## الإثبات الحالي وحدوده

Focused integration **22/22** ناجحة: actual financial domain workflows للمسارات الأربعة: Stripe مع adapter test double،وPayPal/Alma actual adapters مع HTTP mocks،وBank manual/signed feed/reconciliation اصطناعية محلية. بعد duplicate/out-of-order/failure/UNKNOWN/rotation/disabled requester cases،يفحص الاختبار إشعارًا واحدًا لكل confirmed Payment ولكل Enrollment،ولا إشعار مدفوع لحالة غير مؤكدة. سيناريو Native166 الجديد يثبت eight concurrent approvals/read CAS،Audit rollback حتى بعد إدخال إشعار Payment،current owner/foreign Branch/Organization/session denial،independent preference/wording/history وnative forgery/immutability denial.

Browser المركزة1/1 والبوابة النهائية ناجحة: **178unit و93/93full Docker PostgreSQL integration** (248.5s) و**57/57full Edge Browser** (7.8m)،migrations001–166development/test وBackend/Web build/typecheck/diff check. صورةar390px فُحصت دونoverflow/XSS/duplicate keys. الأزمنة ليستcapacity guarantee. **Notifications والمنصة غير مكتملتين**؛attention وIntegration-System events والقنوات المفعلة وmandatory policies ثم Automation/Analytics/Import-Export/Sheets/Email وبقية المتطلبات ما زالت مطلوبة. Providers تبقى **Mock/Sandbox Verified** محليًا و**Live Verification Pending External Credential/Approval**،ولا Sandbox account خارجي أوLive verification مُدعاة. لا Merge إلىmain أوProduction deployment.
