# مصفوفة تغطية المتطلبات

الحالة هنا تعكس **تنفيذاً مثبتاً**، وليست وعداً. `جزئي` يعني أن المسار المطلوب للإنتاج غير مكتمل. لا توجد منطقة موسومة `Complete` حالياً. اختبارات الـAPI تعمل على PostgreSQL 18 داخل Docker؛ لا تثبت الميزات التي لم تُنفذ.

> نقطة تحقق 2026-10-03: اجتازت مجموعة Lead workflow/Follow-ups/Search/Saved Views migrations `001`–`013` على قاعدتي التطوير والاختبار، و18 اختبار وحدة و5 مجموعات integration على PostgreSQL 18 وفحص النوع والبناء للـBackend والواجهة. اجتازت مرحلتا ترتيب تاريخ الإنشاء/اختيار الأعمدة وBulk assignment المحدود بوابات الاختبار نفسها. الحالات أدناه تميّز التنفيذ المثبت عن بقية إجراءات Bulk والمتطلبات غير المبنية.

| المجال | المراجع | التنفيذ الحالي | الاختبارات | الحالة |
|---|---|---|---|---|
| Authentication | README، 00، 02، 06 | Bootstrap، login/logout، session hash، تغيير كلمة المرور، Invitation/Resend، Forgot/Reset، إبطال الجلسات وتعطيل الحساب، UI؛ رسائل الحساب عبر outbox وSMTP adapter | Argon2/token unit؛ API integration على PostgreSQL مع Email fake وسيناريوهات replay/expiry/race/failure/scope؛ UI E2E وSMTP sandbox/live غير متحققين | جزئي: Implemented وMock Verified؛ Live Verification Pending External Credential |
| Roles/Permissions | 02، 06 | Branch/Lead access في بعض API؛ Agent campaign list محصورة بحملات Leads المسموحة ودون إعدادات التوزيع؛ لم تُغط كل الوحدات | Branch unit؛ API cross-branch/agent/campaign access وOrigin ناجح | جزئي |
| Branches | 00، 01، 03 | Schema وcreate/list UI/API | API create/branch boundary ناجح | جزئي |
| Contacts | 00، 01، 02، 03 | Manual intake يطبّع phone/email ويحفظ الأصل؛ قائمة/بحث/تفاصيل/تعديل Contacts بالواجهة وAPI؛ history وversion؛ مراجعة ambiguous/cross-branch مع Source Submission وحسم صريح دون Lead مكررة؛ حدود الفروع والـAgent مفروضة في Backend | 2 unit normalization؛ PostgreSQL API يختبر المطابقة المتزامنة، الالتباس، الحسم المتزامن، صلاحيات Manager/Agent، المشاركة بين الفروع، تعديلاً متزامناً، pagination، audit ورفض القيم الفاسدة؛ UI E2E وexternal participant identifiers لم يتحققا بعد | جزئي: Implemented وPostgreSQL Verified لمسار Manual؛ بقية مصادر الهوية لاحقاً |
| Leads | 00، 01، 02، 03 | Manual intake وlifecycle وlist/detail؛ activity/assignment history، إعادة إسناد داخل الفرع مع version وتحديث Human controller ومتابعات المالك السابق، ملاحظات داخلية؛ الحالات ambiguous تحفظ Submission قبل إنشاء Lead. نقل الفروع ومسارات الوحدات التالية ناقصة | Cursor unit؛ PostgreSQL API يختبر الإسناد وتعارض النسخة وسجل التاريخ وفقد Agent السابق الوصول وملاحظات النطاق | جزئي: المسار الحالي Implemented وPostgreSQL Verified |
| Campaigns | 00، 01، 02، 03، 05، 06 | Create/Edit/Detail/Activation/Deactivation، نسخة إعداد وتدقيق، Agent weights/capacity/removal، Readiness مفصّلة، شاشة إعداد وAgent search؛ Manual وRound Robin/Weighted قابلة للتفعيل بعد التحقق. Source/Messaging/AI/Performance محجوبة بوضوح حتى اكتمال خدماتها؛ Conversion milestone محفوظ ولا يُستخدم في Analytics بعد. Setup Wizard وبقية إعدادات الوحدات المرتبطة ناقصة | PostgreSQL API يفحص scope، السباق على النسخة، رفض JSON غير صالح، جاهزية الاعتماديات، إزالة آخر Agent، حفظ Lead بعد التعطيل، audit وpagination؛ UI build/typecheck بلا E2E | جزئي: أساس الإعداد مثبت على PostgreSQL؛ تكامل الوحدات اللاحقة مطلوب |
| Dynamic Fields | 00، 01، 02، 03، 06 | تعريفات Global/Branch/Campaign، ربط وإعداد حملة، الأنواع الموثقة، خيارات/ترتيب/تعطيل، واجهة Field Builder وLead Details وإنشاء Lead، تحقق Backend من النوع والرؤية والتحرير، version/history، required عند الإنشاء والإغلاق، سجل Calculated queries موثوقة؛ فلتر Search للقيم المرئية | 2 unit وPostgreSQL integration للتعريف والربط والقيم والتاريخ وصلاحيات الفروع والـAgent، المحاولات المتزامنة، required stages، Source Submission عند review، وعدّ AI/Human منفصل؛ اختبار Search يرفض الحقل المخفي ويقبل المرئي؛ UI E2E وExport وSource mapping وEnrollment gate لم تتحقق بعد | جزئي: Implemented وPostgreSQL Verified للعمليات الحالية؛ تكامل المجموعات اللاحقة مطلوب |
| Meta/Sources | 00، 02، 03 | Source Submission schema فقط | لا يوجد | غير منفذ تشغيلياً |
| Routing | 00، 02، 06 | Round Robin/Weighted/Manual أولي وPerformance fallback، سعة وساعات | Unit 4؛ API concurrent intake/capacity/no eligible ناجح | جزئي |
| Messaging | 02، 03، 05، 06 | Schema، pure sender/policy/inbound rules؛ لا webhook/send worker أو UI | Unit 5؛ integration غير مختبر | جزئي |
| AI | 04، 05، 06 | حدود معمارية موثقة فقط | لا evaluations | غير منفذ تشغيلياً |
| Follow-ups | 00، 02، 06 | مهام Human بموعد وأولوية ومالك، إنشاء/تعديل/إعادة جدولة/إكمال/إلغاء، قوائم due وLead، version/history/Audit وواجهة؛ policy الآلية والإرسال والتنبيهات لم تُنفذ | PostgreSQL API يفحص CRUD والتاريخ والتعارض ونطاق Agent/Manager ونقل ملكية المهام عند إعادة الإسناد؛ UI E2E غير مشغّل | جزئي: Human workflow Implemented وPostgreSQL Verified |
| Notifications | 00، 02، 03 | لم ينفذ | لا يوجد | غير منفذ |
| Payments | 00، 02، 03 | لم ينفذ | لا يوجد | غير منفذ |
| Enrollment | 00، 01، 06 | لم ينفذ | لا يوجد | غير منفذ |
| Analytics | 00، 03، 06 | لم ينفذ | لا يوجد | غير منفذ |
| Automations | 00، 02، 06 | لم ينفذ | لا يوجد | غير منفذ |
| Search/Views/Bulk | 00، 02، 03، 06 | بحث Leads بالاسم/الهاتف/البريد/ID وفلاتر Branch/Campaign/Agent/Source/Lifecycle/date/follow-up/visible custom field مع pagination وترتيب تاريخ الإنشاء؛ Saved Views شخصية/فرع/مؤسسة ونسخة وAPI CRUD وواجهة تطبيق/إنشاء/حذف واختيار أعمدة العرض وحفظها؛ Bulk assignment حتى 50 Lead مع فحص مستقل لكل عنصر وتأكيد UI. بقية Bulk وفلاتر Payment/Enrollment/Conversation وSorting بمفاتيح إضافية ناقصة | PostgreSQL API يفحص عزل الفروع والـAgent والحقل المخفي/المرئي، صلاحيات Views والتعارض والقيم الفاسدة، وتقييد النتائج بعد إعادة الإسناد؛ ترتيب الأحدث/الأقدم مع cursor وصفحات متعددة، رفض Sort/Columns فاسدة وحفظ الأعمدة؛ Bulk يختبر الرفض دون تأكيد، تكرار IDs، منع Agent والفرع الآخر، وكيل غير مؤهل، نجاحًا جزئيًا وتعارض النسخة وطلبين متزامنين. UI E2E غير مشغّل | جزئي: Search وViews وBulk assignment الحالية Implemented وPostgreSQL Verified |
| Import/Export | 00، 03، 06 | لم ينفذ | لا يوجد | غير منفذ |
| Google Sheets | 00، 03، 06 | لم ينفذ | لا يوجد | غير منفذ |
| Email integration | 03، 06 | إعداد SMTP لحسابات المنظمة من الواجهة، تشفير credential، test connection، worker/retries/status؛ Email الإشعارات العامة غير منفذ | Identity Email fake integration ناجح؛ SMTP sandbox/live غير متحقق | جزئي |
| Integrations UI | 03، 05، 06 | Schema وsecret crypto فقط؛ Setup UI غير منفذة | AES-GCM unit | جزئي |
| Audit | 00، 02، 06 | Schema وأحداث الإدارة والهوية وContacts وLeads، وإعادة الإسناد والمتابعات وSaved Views؛ Audit UI/coverage أوسع ناقص | Identity وContact وLead workflow DB integration يفحصان أحداثاً مختارة؛ لا coverage شامل لكل وحدة | جزئي |
| Security | AGENTS، 02، 06 | Hash/session/Origin/roles/secret crypto وIdentity token/SMTP secret boundaries؛ الملفات وسائر المسارات ناقصة | Unit وIdentity negative API tests | جزئي |
| Languages/RTL | README، 03، 06 | واجهة الأجزاء الحالية بالعربية والفرنسية والإنجليزية | Web build فقط، لا visual QA | جزئي |
| Responsive UI | 03، 06 | CSS للشاشات الحالية | Web build فقط | جزئي |
| Scalability | AGENTS، 00، 06 | فهارس وkeyset للقوائم المنفذة وrouting lock وIdentity Email worker؛ backpressure العام غير منفذ | لا يوجد load test | جزئي |
| Observability | AGENTS، 06 | Health endpoints وlogs أولية | لا smoke فعلي | جزئي |
| Testing | AGENTS، 06 | 18 unit tests و5 API integration suites وbuild/typecheck | 18 unit و5 suites ناجحة على PostgreSQL؛ migrations 001-013 ناجحة بقاعدتي التطوير والاختبار؛ لا UI E2E/load | جزئي |
| Deployment/Runbook | AGENTS، 06 | Compose وملف env نموذجي ومعمارية | Docker PostgreSQL وAPI health تحققا محلياً؛ لم يجر تشغيل production | جزئي |
