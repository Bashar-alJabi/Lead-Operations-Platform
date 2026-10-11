# مستلم Handoff وتوفّره التشغيلي

## النطاق ومصدر القرار

هذه مرحلة مثبتة من Handoff، وليست اكتمال AI Conversation Agent أو SLA والتنبيهات. المصادر: 04 §§25–30/33، 02 §§26–35/49، 05 §21 وAGENTS §§8/9/15/18/27–30/38–39.

تتطلب الوثائق بقاء Lead مع Owner الحالية أو Unassigned عند غياب الموظف المؤهل، وتربط Conversation access بصلاحية قراءة Lead. لذلك `handoffTargetId` يحدد مستلمًا مفضّلًا للمراجعة، ولا يمنح Agent أخرى صلاحية ولا يغيّر Owner أو Controller تلقائيًا. إذا كان الهدف Agent غير Owner، تظهر `TARGET_REQUIRES_AUTHORIZED_ASSIGNMENT` وتحتاج Manager إلى إجراء Assignment المصرّح الموجود في المنصة. لا نضيف ACL استثناء أو AI assignment tool أو عشوائية لتجاوز هذه الحالة. Manager المحددة داخل Branch تملك أصلًا نطاق المراجعة، ويمكن أن تكون مستلمًا مع بقاء Owner الحالية.

## إدارة ساعات العمل

من صفحة **الفروع** أو **المستخدمين** افتح إعداد ساعات العمل. Super Admin تدير Branch وساعات AGENT/MANAGER؛ Manager تدير ساعات فرعها ووكلائه فقط، وفق حدود إدارة المستخدمين الحالية. لا توجد صلاحية إعداد للـAgent أو تعديل Manager أخرى بواسطة Manager.

- `GET/PUT /api/branches/:id/working-hours` و`/api/users/:id/working-hours` تستخدمان Branch timezone الحالية.
- `{}` تعني عدم وجود تقييد أسبوعي. عند تفعيل التقييد، اليوم الفارغ مغلق. الفترات محلية، البداية مشمولة والنهاية غير مشمولة؛ `24:00` نهاية صالحة. تُقسم الفترة العابرة لمنتصف الليل على يومين. يدعم اليوم ثماني فترات كحد تقني قابل للتطوير، ولا يُعد ذلك Capacity تجارية.
- Validation مشتركة وnative ترفض overlaps، ترتيبًا عكسيًا، توقيتًا غير صالح، شكلًا غير صحيحًا وفترات عابرة لمنتصف الليل. PostgreSQL وIntl routing متوافقان عند الحدود اليومية وDST المثبتة.
- `operational_hours_policy` لها current Branch/User scope، version/CAS، actor/session حقيقيتان وreason. Branch lock تسبق target/policy locks، وتُعاد مراجعة cookie/session بعد الانتظار. Native132 و134 تفرضان current Role/Scope/session، history admission ووقتًا مشتقًا من policy.
- Projection إلى `branch.business_hours` و`user_account.working_hours` تتم مع history وAudit في transaction واحدة. Raw updates المخالفة محجوبة. إخفاق Audit يُلغي إعداد الساعات والـprojection والتاريخ معًا. ساعات الموظف نفسها تدخل routing القائمة؛ ساعات Branch الجديدة تدخل Handoff availability.
- History محفوظة وimmutable، بـpagination bounded. UI ar/en/fr تعرض النصوص كبيانات غير موثوقة، وتمسح البيانات عند فشل القراءة. المحرّر لوحة مستقلة عن الجدول لتبقى controls قابلة للاستخدام على الهاتف.

## تحديد المستلم

`ai_handoff_reception` في133 دالة تشغيلية محلية، مستقلة عن Model/Profile/Provider. تقرأ current trusted APPLIED Handoff pointer وWAITING_FOR_HUMAN/NONE، وتتحقق من Org/Branch/Campaign/Lead scope الأصلي؛ artifact قديمة أو Lead انتقلت إلى سياق آخر لا تحصل على مستلم صالح.

الترتيب: Campaign target غير null → Branch target غير null → Owner الحالية. Null هنا وراثة وفق عقد operational configuration المحفوظ؛ لا مصدر configuration جديد.

يجب أن يكون المستلم نشطًا في Branch/Org الحالية. Agent تحتاج Campaign eligibility وملكية Lead، وManager تحتاج نطاق Branch. التوفّر هو تقاطع ساعات Branch والموظف في Branch timezone. عند عدم وجود تقييد تصبح الساعات مفتوحة. امتلاء Capacity لا يسحب Lead موجودة من مالكها؛ Capacity تبقى قيدًا على الإسناد الجديد في routing.

إذا لم يصلح الهدف أو كانت Lead Unassigned أو خارج الساعات، تعود Manager attention المطلوبة وسبب محدد. قائمة Manager الحالية تحتفظ بالطلب؛ لا يتم نقل Owner أو قبول Controller أو إنشاء رسالة أو AI reactivation. معلومات التوفّر تُحسب عند قراءة القائمة/الحزمة؛ ليست حجزًا للموظف أو إذنًا بالإرسال، ولا تدّعي تحديثًا لحظيًا مستمرًا.

Native trigger تحفظ `ai_handoff_reception_event` مرة واحدة مع fresh same-transaction Handoff receipt/history، وتشتق snapshot ووقت القرار وAudit. لا retrofit لقرارات قديمة ولا تعديل/حذف. UI/API تميز القرار التاريخي عند الطلب عن القرار التشغيلي الحالي بعد تعديل الساعات/الإعدادات/eligibility. تاريخ الطلب يظل موجودًا بعد Human acceptance، بينما current waiting reception تختفي. Scope وassignment denial لا يتغيران بسبب target.

## الاختبارات وحدود الاكتمال

Unit تختبر شكل الساعات والحدود. PostgreSQL تختبر current scope/session، eight-way CAS، parent-transfer/session-revocation أثناء الانتظار، immutable native history/projection denial وAudit rollback؛ وHandoff tests تختبر inheritance/override، current Owner عند Capacity صفر، target مختلفة/غير نشطة/غير مؤهلة، خارج Branch/User hours، Unassigned، حفظ Owner/controller/no send، current مقابل historical decision، وعدم اكتساب Agent وصولًا من target. Browser تختبر إعداد Branch/User من الواجهة، أثر User hours على routing، stale edits، history/no-XSS/failed-read clear/ar-en-fr/RTL وcurrent reception/explicit Human acceptance. نتائج البوابة الدقيقة في progress/coverage.

**التالي المطلوب:** Branch/Campaign SLA clock/timezone/working-hours policy والتذكير والتصعيد مع Notifications فعلية محكومة بالصلاحيات؛ ثم mandatory/system وQualification-completion triggers عبر current atomic proof. لا يجوز تخفيف original full context بسبب own Qualification write. Full Handoff catalog/runtime تبقى غير جاهزة، ثم تأتي Customer Messaging وInitial Contact/Returning/Follow-up وبقية AI والـmodules. Live transfer وProduction deployment معطلان؛ verification الحالية محلية ببيانات اصطناعية وHTTP mocks فقط.
