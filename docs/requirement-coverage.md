# مصفوفة تغطية المتطلبات

الحالة هنا تعكس **تنفيذاً مثبتاً**، وليست وعداً. `جزئي` يعني أن المسار المطلوب للإنتاج غير مكتمل. لا توجد منطقة موسومة `Complete` حالياً. الاختبارات بوحدة مستقلة عن PostgreSQL لا تثبت API أو migration أو تكاملاً مباشراً.

| المجال | المراجع | التنفيذ الحالي | الاختبارات | الحالة |
|---|---|---|---|---|
| Authentication | README، 00، 02، 06 | Bootstrap، login/logout، session hash، تعطيل حساب؛ reset/invite غير منفذين | Argon2/token unit؛ API غير مختبر | جزئي |
| Roles/Permissions | 02، 06 | Branch/Lead access في بعض API؛ لم تُغط كل الوحدات | Branch unit؛ API attack غير مختبر | جزئي |
| Branches | 00، 01، 03 | Schema وcreate/list UI/API | لا يوجد integration test | جزئي |
| Contacts | 00، 01، 02 | Schema ومطابقة أولية عند manual intake | لا يوجد integration test؛ canonical phone ناقص | جزئي |
| Leads | 00، 01، 02 | Manual intake، lifecycle، activity، list/detail، keyset pagination | Cursor unit؛ API غير مختبر | جزئي |
| Campaigns | 00، 02، 03 | Schema وcreate/agent binding/activation أساسي؛ إعدادات كثيرة ناقصة | لا يوجد integration test | جزئي |
| Dynamic Fields | 00، 01، 02 | Schema فقط | لا يوجد | غير منفذ تشغيلياً |
| Meta/Sources | 00، 02، 03 | Source Submission schema فقط | لا يوجد | غير منفذ تشغيلياً |
| Routing | 00، 02، 06 | Round Robin/Weighted/Manual أولي وPerformance fallback، سعة وساعات | Unit 4؛ concurrency/API غير مختبر | جزئي |
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
| Email integration | 03، 06 | لم ينفذ | لا يوجد | غير منفذ |
| Integrations UI | 03، 05، 06 | Schema وsecret crypto فقط؛ Setup UI غير منفذة | AES-GCM unit | جزئي |
| Audit | 00، 02، 06 | Schema وبعض أحداث الإدارة | لا يوجد DB test | جزئي |
| Security | AGENTS، 02، 06 | Hash/session/Origin/roles/secret crypto أولية؛ ملفات وCSRF/reset وسائر المسارات ناقصة | Unit محدودة | جزئي |
| Languages/RTL | README، 03، 06 | واجهة الأجزاء الحالية بالعربية والفرنسية والإنجليزية | Web build فقط، لا visual QA | جزئي |
| Responsive UI | 03، 06 | CSS للشاشات الحالية | Web build فقط | جزئي |
| Scalability | AGENTS، 00، 06 | فهارس وkeyset وrouting lock وjob schema؛ worker/backpressure غير منفذين | لا يوجد load test | جزئي |
| Observability | AGENTS، 06 | Health endpoints وlogs أولية | لا smoke فعلي | جزئي |
| Testing | AGENTS، 06 | 14 unit tests وbuild/typecheck | 14 ناجحة؛ لا integration/E2E/migration/load | جزئي |
| Deployment/Runbook | AGENTS، 06 | Compose وملف env نموذجي ومعمارية | لم يجر تشغيل production | جزئي |
