# مصفوفة تغطية المتطلبات

الحالة هنا تعكس **تنفيذاً مثبتاً**، وليست وعداً. `جزئي` يعني أن المسار المطلوب للإنتاج غير مكتمل. لا توجد منطقة موسومة `Complete` حالياً. اختبارات الـAPI تعمل على PostgreSQL 18 داخل Docker؛ لا تثبت الميزات التي لم تُنفذ.

| المجال | المراجع | التنفيذ الحالي | الاختبارات | الحالة |
|---|---|---|---|---|
| Authentication | README، 00، 02، 06 | Bootstrap، login/logout، session hash، تغيير كلمة المرور، Invitation/Resend، Forgot/Reset، إبطال الجلسات وتعطيل الحساب، UI؛ رسائل الحساب عبر outbox وSMTP adapter | Argon2/token unit؛ API integration على PostgreSQL مع Email fake وسيناريوهات replay/expiry/race/failure/scope؛ UI E2E وSMTP sandbox/live غير متحققين | جزئي: Implemented وMock Verified؛ Live Verification Pending External Credential |
| Roles/Permissions | 02، 06 | Branch/Lead access في بعض API؛ Agent campaign list محصورة بحملات Leads المسموحة ودون إعدادات التوزيع؛ لم تُغط كل الوحدات | Branch unit؛ API cross-branch/agent/campaign access وOrigin ناجح | جزئي |
| Branches | 00، 01، 03 | Schema وcreate/list UI/API | API create/branch boundary ناجح | جزئي |
| Contacts | 00، 01، 02، 03 | Manual intake يطبّع phone/email ويحفظ الأصل؛ قائمة/بحث/تفاصيل/تعديل Contacts بالواجهة وAPI؛ history وversion؛ مراجعة ambiguous/cross-branch مع Source Submission وحسم صريح دون Lead مكررة؛ حدود الفروع والـAgent مفروضة في Backend | 2 unit normalization؛ PostgreSQL API يختبر المطابقة المتزامنة، الالتباس، الحسم المتزامن، صلاحيات Manager/Agent، المشاركة بين الفروع، تعديلاً متزامناً، pagination، audit ورفض القيم الفاسدة؛ UI E2E وexternal participant identifiers لم يتحققا بعد | جزئي: Implemented وPostgreSQL Verified لمسار Manual؛ بقية مصادر الهوية لاحقاً |
| Leads | 00، 01، 02 | Manual intake، lifecycle، activity، list/detail، keyset pagination وfilter بـContact؛ الحالات ambiguous تحفظ Submission قبل إنشاء Lead | Cursor unit؛ API intake/access/lifecycle/pagination/review idempotency ناجح | جزئي |
| Campaigns | 00، 02، 03 | Schema وcreate/agent binding/activation أساسي في API والواجهة؛ إعدادات كثيرة ناقصة | API agent binding/scope وactivation ناجح | جزئي |
| Dynamic Fields | 00، 01، 02، 03، 06 | تعريفات Global/Branch/Campaign، ربط وإعداد حملة، الأنواع الموثقة، خيارات/ترتيب/تعطيل، واجهة Field Builder وLead Details وإنشاء Lead، تحقق Backend من النوع والرؤية والتحرير، version/history، required عند الإنشاء والإغلاق، سجل Calculated queries موثوقة | 2 unit وPostgreSQL integration للتعريف والربط والقيم والتاريخ وصلاحيات الفروع والـAgent، المحاولات المتزامنة، required stages، Source Submission عند review، وعدّ AI/Human منفصل؛ UI E2E، فلاتر/Exports الحقول، Source mapping، وEnrollment gate لم تتحقق بعد | جزئي: Implemented وPostgreSQL Verified للعمليات الحالية؛ تكامل المجموعات اللاحقة مطلوب |
| Meta/Sources | 00، 02، 03 | Source Submission schema فقط | لا يوجد | غير منفذ تشغيلياً |
| Routing | 00، 02، 06 | Round Robin/Weighted/Manual أولي وPerformance fallback، سعة وساعات | Unit 4؛ API concurrent intake/capacity/no eligible ناجح | جزئي |
| Messaging | 02، 03، 05، 06 | Schema، pure sender/policy/inbound rules؛ لا webhook/send worker أو UI | Unit 5؛ integration غير مختبر | جزئي |
| AI | 04، 05، 06 | حدود معمارية موثقة فقط | لا evaluations | غير منفذ تشغيلياً |
| Follow-ups | 00، 02، 06 | Schema فقط | لا يوجد | غير منفذ تشغيلياً |
| Notifications | 00، 02، 03 | لم ينفذ | لا يوجد | غير منفذ |
| Payments | 00، 02، 03 | لم ينفذ | لا يوجد | غير منفذ |
| Enrollment | 00، 01، 06 | لم ينفذ | لا يوجد | غير منفذ |
| Analytics | 00، 03، 06 | لم ينفذ | لا يوجد | غير منفذ |
| Automations | 00، 02، 06 | لم ينفذ | لا يوجد | غير منفذ |
| Search/Views/Bulk | 00، 02، 03 | Lead filtering محدود فقط | لا يوجد | جزئي |
| Import/Export | 00، 03، 06 | لم ينفذ | لا يوجد | غير منفذ |
| Google Sheets | 00، 03، 06 | لم ينفذ | لا يوجد | غير منفذ |
| Email integration | 03، 06 | إعداد SMTP لحسابات المنظمة من الواجهة، تشفير credential، test connection، worker/retries/status؛ Email الإشعارات العامة غير منفذ | Identity Email fake integration ناجح؛ SMTP sandbox/live غير متحقق | جزئي |
| Integrations UI | 03، 05، 06 | Schema وsecret crypto فقط؛ Setup UI غير منفذة | AES-GCM unit | جزئي |
| Audit | 00، 02، 06 | Schema وأحداث الإدارة والدعوة والاستعادة وإعادة التسليم وإنشاء/تعديل Contact وحسم المطابقة وإنشاء Lead | Identity وContact DB integration يفحصان أحداثاً مختارة؛ Audit UI/coverage أوسع ناقص | جزئي |
| Security | AGENTS، 02، 06 | Hash/session/Origin/roles/secret crypto وIdentity token/SMTP secret boundaries؛ الملفات وسائر المسارات ناقصة | Unit وIdentity negative API tests | جزئي |
| Languages/RTL | README، 03، 06 | واجهة الأجزاء الحالية بالعربية والفرنسية والإنجليزية | Web build فقط، لا visual QA | جزئي |
| Responsive UI | 03، 06 | CSS للشاشات الحالية | Web build فقط | جزئي |
| Scalability | AGENTS، 00، 06 | فهارس وkeyset للقوائم المنفذة وrouting lock وIdentity Email worker؛ backpressure العام غير منفذ | لا يوجد load test | جزئي |
| Observability | AGENTS، 06 | Health endpoints وlogs أولية | لا smoke فعلي | جزئي |
| Testing | AGENTS، 06 | 18 unit tests و3 API integration suites وbuild/typecheck | 18 unit و3 suites ناجحة على PostgreSQL؛ migrations 001-009 ناجحة؛ لا UI E2E/load | جزئي |
| Deployment/Runbook | AGENTS، 06 | Compose وملف env نموذجي ومعمارية | Docker PostgreSQL وAPI health تحققا محلياً؛ لم يجر تشغيل production | جزئي |
