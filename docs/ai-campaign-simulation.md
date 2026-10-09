# Campaign AI Simulation وread-only inference

## النطاق

**تحديث2026-10-09:** حسبتصريحالمستخدماللاحق،النقل الحي للـAI معطّل. Production/default POST ترفض بـ`AI_LIVE_DATA_TRANSFER_DISABLED` وworker تحجبالمهام القديمةقبلcredential/payload. تشغيلHTTP فيالاختبارات يتطلبexplicit injected adapters معisolated synthetic PostgreSQL وغيرproduction وHTTP mocks. لاenv toggle لتجاوزالقيد. بقيةworkflow أدناه تصفالتنفيذ القابلللاختبار؛Live Verification Pending External Credential/Approval معضوابطوموافقةالتفعيل. راجع[حدود Copilot والنقل](ai-human-copilot-summary.md).

المرجع: 03 إعداد AI،04 §§6–8/59–73،05 Campaign isolation،06 §12،وAGENTS §§8–9/19–29/38–40. هذه مرحلة تنفيذ فعلية لمسار **سؤال اختباري → queue → provider HTTP → validated evidence أوhandoff recommendation → UI/history**. تستخدم نفسeffective Campaign context التي تستعملها المعاينة. لا توجد Customer message أوLead/Field/Payment/Enrollment mutation أوAI activation في هذا المسار.

Simulation الحالية تختبر اختيار الأدلة المعتمدة وunknown/handoff boundary. الإجابة المعروضة تُبنى من نصوصPublished references المطابقة؛لا تُقبل صياغة تجارية حرة منModel حتى لو ادعت وجودcitation. النبرة/اللغة/السلوك محفوظة في السياق وتصل كبيانات إلى المزوّد،لكن العرض يحفظ لغة النص المعتمد ولا يدّعي اختبارgeneration/paraphrasing أوالدقة الدلالية لـLive model. Simulation التي تختبر actual approved tools/Qualification/customer lifecycle/actions تبقى غير مكتملة حتى تنفيذ هذه الخدمات. لا يُعتبرهذا اكتمالًا لـAI Lead Assistant أوOperations Assistant أوCopilot.

## السياق والحدود

`effectiveCampaignContext` تستخرج current Global guardrails وBranch defaults وCampaign overrides وProfile/Connection/catalog/grant versions وPublished Knowledge/immutable asset manifests وQualification/Field versions وbehavior/follow-up policies وhandoff target وMessaging resolution/policy. Snapshot تخصCampaign واحدة وتحتفظبالنسخ المستخدمة بعدالنشر الجديد. لا تُقرأDraft فيinference.

إرسال البيانات إلىadapter يقتصر علىسؤال الاختبار وPublished references وprohibited claims واللغة والنبرة والسلوك وQualification/follow-up definitions. لا user/session IDs أوcredentials أوLead/Conversation data أوProfiles لمهام أخرى. Model لايحصلعلىSQL أوHTTP tools أوإذنmutation. لا تُقرأمحتوياتweb links تلقائيًا؛النص والURL المعتمدان reference فقط. TXT assets تستخدمextractedText المنشورة والمعتمدة؛binary manifests بلاOCR أوحقائق مستخرجة متخيلة. Reference تحتويprohibited claim صريحة تُستبعد. المرجع هوsnapshot المنشورة،ولا يحتاج العامل storage credentials لقراءة المعرفة بعداعتمادها.

قبل تشغيل المزوّد وقبلالحفظ يعيدworker فحصcurrent actor/session/role/organization/Branch وProfile/current shared grant وversions/publication. يعيد بناءالسياق منDB ويقارن canonical كاملsnapshot والـconfiguration hash،دونالاعتمادعلىhash مقدمةبمفردها. التغيير أوالسحب يحوّل المهمة إلىBLOCKED. Simulation لا تحتاجSender جاهزة أوAI مفعلة؛الغرض اختبارالإعداد قبلactivation،لكنactivation تبقىمحجوبةبمتطلباتها الأخرى.

## API وDB

- `POST /api/ai/campaigns/:id/simulations`: authenticated Manager لفرعه أوSuper Admin لمنظمته،`requestId/expectedHash/question` فقط. يعيد202 للطلب الجديد و200 للتكرار المطابق. Hash قديمة أوkey بمحتوىمختلف →409؛Agent→403 وforeign scope→404.
- `GET .../simulations`: keyset pagination،10 افتراضيًا و50 كحدتقني.
- `GET .../simulations/:simulationId`: النتيجة،original versions/profile/hash وstate history معcurrent access. Shared grant المسحوبة لا تعيدcurrent model catalog access منالتاريخ؛تُحفظtrace الأصليةداخلDB وتُحجبmetadata غيرالمتاحةفيالاستجابة.

Migration103 تضيف `ai_campaign_simulation` و`ai_simulation_history`،unique perCampaign/actor/request وcurrent native scope/profile/Published proof وimmutable context،source references مولّدة منPublished content داخلDB،result validator يمنعإضافةنصخارجالأدلة،native state/version/lease/result guards وatomic Audit/history. Audit لايسجلالسؤال أوالمعرفة أوraw model/provider response أوcredentials. Context hash فيDB تحسبمنJSONB serialization؛configuration hash منcanonical application snapshot. اختلافهما متوقع؛الأولىسلامةالسجل والثانيةمقارنةeffective configuration.

## Durable worker

`processOneAISimulation` و`npm run worker:ai` يستخدمان `FOR UPDATE SKIP LOCKED`. الحالاتQUEUED/RUNNING/COMPLETED/FAILED/BLOCKED. Default lease60s،provider timeout20s،خمسمحاولاتكحدتقني وexponential delay حتى300s. لاtransaction مفتوحة أثناءHTTP. Completion تحتاجنفسlease وغيرمنتهية؛ردWorker القديم يُهمل بعدreclaim. Auth/model/refusal/incomplete/invalid failures نهائية؛rate/network/5xx قابلةلـbounded retries. Restart لايفقدالطلبات. هذه inference للقراءة فقط؛recovery قدتعيدHTTP إذا ضاعتالنتيجة،لكنلاduplicate logical result أوBusiness action. لايمتدهذاالعقدإلىPayment/provider writes أوCustomer sends.

Backpressure: عشرمهامpending لكلactor/Campaign،معadvisory serialization لتزامنsubmit؛body32768B/question4000chars وsnapshot≤1MiB وprovider response≤1MiB و≤8selected references. هذهحدودimplementation لحمايةالموارد،وليستأرقامBusiness capacity. يلزمcapacity/load review ضمنfinal platform acceptance؛لاادعاءقياسProduction throughput.

## Provider contract والخصوصية

Registry مستقلةعنDomain؛`OPENAI` تستعملHTTP Responses إلىendpoint ثابت،managed credential/model/maxOutputTokens،strict `text.format` JSON schema و`tools:[]` و`store:false`،دونredirect أوmodel fallback. تُفحصstatus/output/message/refusal/incomplete/JSON قبلproposal validator. Provider response/error bodies لا تُعرضأوتُسجل. `store:false` ليستادعاءZero Data Retention؛راجعسياستكوعقدالمزوّدعندالربط. العقدتحققمن[Structured Outputs الرسمية](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses) و[Responses storage الرسمي](https://developers.openai.com/api/docs/guides/migrate-to-responses).

لايفترضcatalog أنكلModel تدعمstructured inference. Unsupported Model تظهرAI_MODEL_UNSUPPORTED ويختارالمخولProfile مناسبةمنالواجهة. لايستخدمSDK implicit retries أوحسابشخصي. Live Verification Pending External Credential/Approval؛المتاحمحليًاHTTP Mock Verified. نجاحmock لايثبتأنLive model تختارالدليل الصحيح أوتلتزمhandoff فيكلصيغة،ويجبإجراءlive evaluations المصرحبهالاحقًا.

## التشغيل والاختبار

منCampaign setup: جهّزAI Connection واختبرcatalog،اخترConversation Profile/language،انشرKnowledge،ثمأدخلSample question فيSimulation. راقبQUEUED→COMPLETED والreferences أوHANDOFF recommendation. راجعالفشلمنالسجل،صحّحConnection/Profile/Published data،واخترتحديثالسياق ثممحاكاةجديدة. Original history لايتغير. يحتاجdeployment تشغيلAI worker كخدمةinfrastructure؛الإدارةالتشغيليةلاتعدّلالكودأوDB أوenv.

اختباراتunit وDocker integration وEdge Browser تغطيstrict invalid output/tool/reference/question/Unicode،actual provider HTTP contract دونcredentials فيprompt،current scope/session/grant،eight-way duplicates/four-way workers،Published vsDraft/newversion/history،provider failure/bounded retries/stale lease/midflight change،native immutable/proof/Audit rollback/backpressure/noBusiness writes،Arabic/French/RTL/XSS/delayed initialload. Unknown/injection scenarios محليةبـHTTP mocks؛ليستLive semantic evaluation. باقي mandatory Human takeover/actual tools/Sender policy/customer lifecycle scenarios تنفذمعcustomer runtime.
