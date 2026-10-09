# أداة قراءة Published Campaign Knowledge للموظف

## النطاق

المراجع: 02 Agent/Lead scope،03 §§66–67،04 §§6–8/39–40،05 Campaign isolation وAGENTS §§8/19–22/26–29. أداة **getCampaignKnowledge** تتيح للموظف قراءة معرفة حملة Lead الحالية وتحميل ملفاتها المنشورة المعتمدة. المصدر Published فقط؛لا Draft أوحملة أخرى أوSetup credentials/configuration. العملية للقراءة ولا تستدعي Model أوترسل للعميل أوتعدل Field/Payment/Enrollment. تبقى معلومات الحملة متاحة دون AI provider/Profile عندتعطل المزوّد؛هذه قراءة Business information ولا تفعّل Copilot inference.

## الصلاحية والمصدر

`approvedHumanCampaignKnowledge` تعيد فحص Organization/Branch/current User-role-session/Lead ownership/Conversation. تتطلب Active Branch وHUMAN/HUMAN_ACTIVE لهذه Human Copilot action. Agent ضمن Leads المسندة إليه،Manager ضمنفرعه،وSuper Admin ضمنمنظمته. Backend يمنع القراءة بعدتغيّرالصلاحية حتىمعURL معروف. لايكتسب Agent صلاحية setup أوpublish أوasset review.

المصدر أحدث `ai_knowledge_publication` وimmutable `ai_knowledge_publication_asset` manifests لحملة Lead فقط. Native092/094/095 تفرض scanning وapproval وimmutable publication؛تُستعمل guards القائمة دون Schema جديدة. تُعرض version/date/canonical hash وSections/FAQs/allowed-prohibited claims/approved HTTPS links وasset metadata/extracted TXT. النص plain text؛لاautomatic link fetch أوOCR أوinline execution. الحدود القائمة64KiB structured content و10files/40FAQs/30links تمنع قراءة قوائم غيرمحدودة.

## API والتحميل

- `GET /api/conversations/:id/ai-campaign-knowledge`: publication الحالية وmetadata محدودة للملفات،providerInvoked=false/readOnly=true/sendAllowed=false/mutationsAllowed=false.
- `GET .../ai-campaign-knowledge/assets/:assetId/download?version=N`: الملف يجبأنيكونداخلlatest publication نفسها،وcurrent REVIEW/APPROVED وmime/size/hash مطابقةللمصدرimmutable. Unknown/foreign/unpublished asset→404،تغيّرpublication→409،storage integrity failure→503.

DTO تحجب storage key/backend/scanner credentials وapprover identity/reason. Private storage القائمة تقرأ بحدbytes وتتحقق منlength/SHA256. بعدstorage I/O،يعادفحص ownership/session/controller/Branch/publication/approval قبلإرجاع الملف. الردattachment باسمUUID وContent-Type موثوقة وnosniff وsandbox CSP وprivate no-store،دونclient filename. Midflight reassignment أوnew publication تمنع إرجاعbytes.

UI ar/en/fr تتطلب إجراءقراءة صريحًا وتمنعlate selected-Conversation responses. Blob download يبدأ بعدHTTP success فقط؛409/403/404/503 تظهر للموظف وتزيل المعرفة المختارة ليعيدالقراءة منcurrent source. Object URL مؤقتةوتُلغى. React تعرضHTML كنص. روابط HTTPS تستعملnoopener/noreferrer/no-referrer ولا تُزار إلا بنقرةصريحة منالموظف.

Audit لكلapproved read/download يحمل User/Lead/Campaign/Conversation وKnowledge version/hash وasset ID،دونمحتوى المعرفة أوcredentials. يُكتب داخلcurrent-authorized transaction؛فشلAudit يمنع إرجاعالمحتوى،ولا تُعرضraw storage errors.

## حالة الاختبار وحدودها

Focused Docker PostgreSQL تختبر foreign Lead/Branch/Organization،Published vsDraft/otherCampaign/approved-unpublished files،storage corruption،ownership/publication change أثناءI/O،revoked session/disabled Branch/closed Conversation،Audit rollback وimmutable versions،ودونmodel call أوcustomer writes. Browser تختبر managed upload→durable scan→approval→publication→Agent scoped read/download/error refresh،معDraft denial وforeign Agent وXSS/French/RTL. أعدادالبوابة النهائية فيprogress/coverage.

هذه أداةقراءة منفذة. Suggest reply/Rewrite/next-question/draft follow-up/intent وAI Operations/Conversation Agent وAI/Form mutation source proofs وruntime/handoff/follow-up/SLA/evaluations/activation باقية. Live inference معطّلة وفقالموافقة السابقة. القراءة محلية ولا تحتاج External AI provider verification؛لاادعاءLive AI Verification.
