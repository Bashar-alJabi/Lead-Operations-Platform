# مصدر إنشاء Lead قبل Initial Contact — Native153

**تحديث Native154–157:** أُضيفت fresh initial admission تلقائية منreceipt الجديدة للحملة التيكانت AI مفعلة عندإنشائها، معcurrent configuration/grants وscoped history UI وbounded contention failure دونفقدانLead. [العقد المستقل](ai-initial-admission.md). النص أدناه يوثّقحدودNative153 الأصلية؛ initial job/content/template/action/send/activation لا تزالاعتمادياتلاحقة، ولاreceipt قديمة تُعادإحياؤها.

## القرار والنطاق

04 §11 يتطلب Initial Contact بعد إنشاء Lead ومحاولة Routing. لا يصح استخدام Customer inbound مصطنعة لتشغيله، ولا اعتبار UPDATE لسجل قديم عملية إنشاء جديدة. Native153 تضيف إثبات مصدر مستقلًا عن AI proposals وHuman Copilot. هذه prerequisite للمصدر؛ ليست تنفيذ Initial Contact أوإذنًا لـAI بالإرسال.

`lead.xmin` تتغير عند UPDATE، لذلك لا تكفي لإثبات الإنشاء. `lead_intake_birth` تنشأ تلقائيًا من Lead INSERT trigger، وتحفظ scope الأصلي وContact ID وsource kind وDB-clock timestamp. Native guard ترفض الكتابة المباشرة والتعديل والحذف؛ يلزم nested INSERT trigger وصف Lead مكتوب فينفسtransaction. الـschema owner وDDL موثوقان ضمن نموذج تشغيل قاعدة البيانات؛ لا يعتمد الإثبات على GUC يضبطها العميل. لا تاريخ قديم يُعاد توليده.

## إثبات ما بعدRouting

`lead_intake_receipt` immutable واحدة لكلLead/submission/routing history. تنشأ داخلtransaction الإدخال نفسها، بعد typed Field writes وContact resolution وRouting وsource processing عندوجودها. Native guard تشترط birth جديدة فعلًا وRouting history جديدة مطابقة للمالك/الفرع وطريقة الحملة، ومصدرPROCESSED مرتبطًا بنفسLead/scope، وBranch/Campaign نشطتين.

- `HUMAN_MANUAL`: MANUAL submission وcurrent real active User/Session، بدورSuper Admin أوManager للفرع. Actor/Session تؤخذان منالطلب الموثق داخلApplication Service، ولا تقبلان منDTO المستخدم. إعادة فحص الجلسة بعدparent lock تمنع طلبًا انتظر حتىبعدإلغائها.
- `SOURCE`: actual Meta intake الحالية، مرتبطة بـsource_processing PROCESSED ونسخةhistory جديدة تحمل نفسLead. لا تستبدل ذلك بـHuman Principal أوجلسة مصطنعة. المعالجة الأصلية تحافظ علىConnection/binding/mapping/history؛ مجردcustomer claim أوسجلSource غيرمعالج لا يكفي. مزودSource جديد يحتاج مسار معالجة موثوقًا مناسبًا؛ لا يقبل تلقائيًا بعلامةPROCESSED منالعميل.

Native context تحفظ scope/Lead version/lifecycle/Contact ID/Owner/attention وCampaign/Branch facts وsource processing version وRouting outcome. لا raw payload أوContact values أوcredentials أوSession token. Deferred proof تقارن السياق الفعلي عندcommit وتعيد current Human permission؛ فشلAudit أوتغيير إضافي لا يطابقsnapshot يلغيLead وContact وFields والمصدر وbirth/receipt/history كلها معtransaction.

ربط المسارات الفعلية:

1. Manual `/api/leads` بعدContact normalization/typed Fields وRouting.
2. Manual Contact review resolution بعداختيارContact المسموح، معbirth جديدة رغمقدمreview submission. Retry يعيدLead الموجودة دونreceipt جديدة.
3. `intakeSource` بعدRouting وحفظactual PROCESSED result/history؛ الفشل/ambiguity لا ينشئreceipt.

Contact review تقفلBranch ثم تقرأactive Campaign وrouting method تحتCampaign lock قبلأيإنشاء؛inactive Branch/Campaign تعيد409 ودونتغييرreview أوإنشاءLead/receipt. يمنعذلكاستعمالrouting config قديمة بعدانتظارparent lock أوإرجاعفشلnative متأخر للمستخدم.

Audit وLead activity تسجل `LEAD_INTAKE_RECORDED` معreceipt/submission/routing IDs فقط. timestamps تخص وقتتوثيق الإدخال، ولا تستبدل original external source timestamp. No Contact وNo eligible Agent تبقيان مدعومتين؛snapshot تحفظالنتيجةالفعلية دونتعيينمصطنع.

## القراءة والواجهة

`GET /api/leads/:id/intake-origin` تستعمل current real Session وOrganization/Branch/current assigned Agent access، وتعيد التحقق منLead تحتالقفل بعدانتظارالفرع. Current owner يستطيع قراءة الأصل التاريخي بعدreassignment؛ المالك السابق يُمنع. DTO تعرضنوعالمصدر ووقتتوثيقه وطريقة/نتيجةRouting وOwner وقتالإنشاء، دونcontext أوSession/actor/Contact data.

الواجهة ar/en/fr/RTL تعرضالأصل التاريخي والمالكالأصلي بشكل منفصل عنالمالكالحالي، وتمسحالمعروض عندfailed/stale access. `origin:null` تعنيعدموجودreceipt موثوقة، سواءلبياناتقديمة أوfixtures؛ لا fallback إلىattributes حالية أوbackfill مخفي. المحتوى يعرض escaped text.

## حدود السلطة والاعتماد التالي

Birth أوreceipt لا تمنحانSend grant ولاAI action authority. لا initial AI admission أوjob أوConversation أوMessage أوPayment/Enrollment تُنشأ فيهذهالمرحلة. Source readiness gate وfull Campaign activation وdefault live transfer/send off باقية.

المرحلةالتالية يجب أن تنشئ initial AI admission **منreceipt جديدة داخلنفسtransaction** معoriginal current Published/effective config وSend grant وOwner/availability/initialContactWithoutAgent/fallback وdeterministic sender. لا polling لreceipts قديمة وإحياؤها بعدتغييرconfiguration/grant. ثمdurable queue وapproved content/template/provider policy وatomic dispatch/UI/tests. الوثيقةلاتدّعي اكتمالInitial Contact.

## الإثبات

Integration root `lead-intake-origin.test.ts` تختبر actual manual creation وContact review/retry،eight concurrent creations،real Session/role/scope denials،immutable birth/receipt وold UPDATE/no-replay،false SOURCE proof،deferred own-extra-write وAudit rollback،historical owner/current access،session revocation أثناءactual parent-lock wait،وغيابAI/messages/financial jobs. Source intake suite تثبتactual SOURCE/null actor وprocessing version حتىدونContact؛Browser actual Source flow تفحصDTO الجديدة. Browser مستقلة تثبتhistorical owner/locales/RTL/noXSS وclearing بعدactual reassignment denial. نتائجالبوابةالكاملة فيprogress/coverage.
