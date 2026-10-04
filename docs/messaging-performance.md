# تحقق Messaging burst والتزامن

## الهدف والحدود

تحقق محلي بتاريخ 2026-10-04 من signed Webhooks وSend Intent والعمال عند التكرار والتزامن، وليس شهادة سعة إنتاجية أو تحقق Meta حي. Node 24.19.0 على Windows، 20 logical CPUs و31.7 GiB host RAM، PostgreSQL 18 داخل Docker Desktop. نسخ API وworkers تعمل داخل Node process واحدة لكن لكل منها pool مستقلة بحجم 3، وطلبات الويب تمر عبر sockets HTTP حقيقية على loopback. Provider fake فقط بتأخير تقني 5 ms؛ network/provider latency الحقيقيان وعمليات media والـUI غير مقاسة هنا.

## السيناريو المثبت

اتصالان مستقلان، لكل منهما عدة Senders وحملات وContacts/Leads/Conversations. Signed inbound batches حتى 50 رسالة، ثم إرسال Human text عبر API؛ كل Webhook/Send Intent يعاد ثلاث مرات بالتزامن. Workers تحل inbound وتلتقط queue عبر pools مستقلة. Fake provider يرد مرة واحدة `429` على الاتصال الأول؛ الثاني يستمر. الاختبار يعاين بقاء Jobs الموقوفة ثم يقدم ساعات cooldown الاختبارية فقط لاستئنافها دون انتظار دقيقة. هذا تعديل fixtures في قاعدة الاختبار، وليس Workflow تعافٍ إنتاجياً.

Callback موقعة لكل Sender تسبق كتابة Provider Message ID وتصل أثناء عمل workers الأخرى؛ يعيد العامل تسويتها بعد ACK. تصل batches `READ/DELIVERED/SENT` مكررة ومتزامنة بترتيب قد يختلف عن زمن المزود. Assertions تتحقق من Message واحدة لكل هوية inbound/intent، وكل Jobs ناجحة والـleases محررة، وHistory فريدة لكل حدث، والحالة النهائية READ، ولا نداء عميل مكرر، وper-Sender concurrency = 1 مع التوازي بين Senders. API/Provider failures تجعل التشغيل يفشل ولا تدخل ضمن نتائج نجاح صامتة.

أول تشغيل كشف PostgreSQL `40P01`: Webhooks تمسك Connection بـ`FOR SHARE` ثم تحاول تحديثها في نهاية المعاملة، فتتعارض ترقية الأقفال مع الطلب المكرر الذي ينتظر قيد الحدث الفريد. الإصلاح يمسك `FOR NO KEY UPDATE` في بداية حفظ Webhook، ويجعل حفظ نتائج Worker وتسوية callbacks يمسكان Connection قبل Job/Message/Sender. لا Provider I/O داخل هذه المعاملات. القفل يحافظ على فحص نسخة credential ويظل متوافقاً مع FK key-share؛ [مرجع PostgreSQL 18 للأقفال](https://www.postgresql.org/docs/18/explicit-locking.html).

## القياسات المسجلة

| المقياس | 08:41 UTC: افتراضي | 08:42 UTC: موسع |
|---|---:|---:|
| Contacts / inbound / outbound | 200 / 200 / 200 | 800 / 800 / 800 |
| API replicas / workers / Senders | 2 / 4 / 4 | 4 / 8 / 8 |
| HTTP concurrency | 12 | 24 |
| Delivery history events | 600 | 2400 |
| Provider calls، تشمل 429 مؤكدًا | 201 | 801 |
| اتصال سليم: SENT أثناء cooldown | 100 | 400 |
| اتصال موقوف: QUEUED أثناء cooldown | 99 | 399 |
| أقصى calls متزامنة لكل Sender / كلياً | 1 / 2 | 1 / 4 |
| Inbound Webhook HTTP p95، يشمل replay | 452.61 ms | 1272.47 ms |
| Inbound resolution: معدل مرحلة المعالجة | 503.77 message/s | 787.74 message/s |
| Enqueue API p95، يشمل replay | 33.44 ms | 44.97 ms |
| Dispatch + cooldown recovery: معدل المرحلة | 72.03 message/s | 89.83 message/s |
| Delivery Webhook HTTP p95، يشمل replay | 1356.30 ms | 3185.74 ms |

القيم قياس تشغيل واحد لكل workload بعد التصحيح، وليست SLA أو حدود Business أو معدل Provider. معدلات المراحل تقسم عدد Messages الفريدة على زمن المرحلة المحلية؛ p95 يقيس زمن طلب HTTP batch أو intent بما فيه الانتظار وduplicate protection. لا يمكن جمع هذه المعدلات كسعة للنظام، ولا يثبت هذا sustained load أو Dataset كبيراً أو horizontal scaling بين أجهزة مستقلة.

نتيجة هندسية: callbacks تنفذ عدداً من SQL operations لكل Status داخل Webhook وتمسك Connection أثناء المعالجة؛ يزداد HTTP latency مع burst على الاتصال نفسه. الخطوة التالية فصل durable ingestion عن callback processing في worker مستقلة عن outbound I/O، مع إعادة اختبار idempotency/order/recovery وقياس هذا المسار. بعد ذلك تكتمل واجهة attempt/recovery والـobservability ونواقص Messaging قبل بدء Meta intake.

## إعادة التشغيل

تتطلب migrations على `lead_operations_test` المحلية. **الأداة تفرغ بيانات هذه القاعدة فقط**؛ لا تشغلها بالتوازي مع integration suite. ترفض قاعدة التطوير، host غير loopback أو غياب تأكيد reset قبل فتح اتصال. تقرير القياس بلا credentials أو PII يحفظ في `.local/performance/messaging-latest.json` المتجاهل من Git.

```powershell
$env:TEST_DATABASE_URL = (Get-Content .local/database-url -Raw).Trim() -replace '/lead_operations$', '/lead_operations_test'
npm run benchmark:messaging -- --reset-test-database
```

للـworkload الموسع، عيّن `LOAD_CONTACTS_PER_SENDER=100` و`LOAD_SENDERS=8` و`LOAD_WORKERS=8` و`LOAD_API_REPLICAS=4` و`LOAD_HTTP_CONCURRENCY=24` في بيئة العملية نفسها. الخيارات الأخرى `LOAD_DUPLICATE_COPIES` و`LOAD_PROVIDER_DELAY_MS`. الأداة تحد bounds تقنية للعدد/التزامن، وتظل route abuse limits مطبقة؛ workload يتجاوزها قد يفشل بـ429 من API، ولا ترفع الأداة limits الخاصة بالـWebhook. لا تستخدم credential حقيقية أو worker Production.

Regression أصغر (48 inbound/outbound، نسختان لكل طلب) ضمن `npm run test:integration`؛ اختبار unit يثبت guard الخاصة بالقاعدة والخيارات غير المحدودة. Assertions الخاصة بالسلامة هي gate، بينما لا توجد عتبة SLA مصطنعة لزمن الجهاز المحلي.
