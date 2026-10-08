# AI Provider/Profile foundations

## القرار — 2026-10-08

بعد Bank Transfer `9ae90de` تبدأ AI بإعداد provider/profile قبل المعرفة المنشورة وeffective configuration وtools/runtime. لا تفعيل assistant أوCampaign AI من وجود credential أوschema فقط. Registry مستقلة للـproviders؛ أول adapter HTTP هي OpenAI، بلا model افتراضية أوdependency على حساب المطور. Task profile مستقلة عن Campaign knowledge وpermissions.

من [OpenAI Models API الرسمية](https://developers.openai.com/api/reference/resources/models/methods/list): GET `https://api.openai.com/v1/models` مع Bearer credential يعيد catalog المتاحة للحساب. هذا اختبار authentication/catalog فقط؛ لا يثبت inference/Responses/tool support أوLLM safety أوCampaign readiness. Model/task اختيار إداري من catalog الحالية، ويمكن استخدام model نفسها لـConversation/Summarization/Classification/Analysis. لا نفترض current model أوpricing أوcapacity.

Credential مشفّرة عبر Connection AAD؛ لا Agent/API DTO/model payload/log تحصل عليها. Host/path ثابتتان، no redirects، timeout 8s وbounded 1MiB response/2000 model IDs؛ لا arbitrary URL أوSSRF. Typed errors آمنة فقط، دون provider raw payload/secret. Native current version/session/scope و20s probe lease تمنع late success بعد rotation/disable/revoke؛ history/probes/profile versions/Audit محفوظة. Network خارج transaction. تعطيل Connection/Profiles يحفظ التاريخ. 091 تفصل AI identity trigger عن PAYMENT origin guard القائمة دون السماح بتغيير أي هوية.

## الإعداد والتحقق

Manager يدير Branch الخاصة به؛ Super Admin يدير Organization/Branches. Agent لا يدير Connections/Profiles. إنشاء credential مخصصة للمؤسسة والمشروع يتم لدى المزود، ثم تُدخل في AI setup وتُختبر من الواجهة. تعرض الواجهة catalog search/pagination وmodel selection لكل task، status/history، rotation/reconnect/disable وprofile history. لا تختار model تلقائيًا، ولا تعتبر نجاح catalog جاهزية Campaign. تعطيل الفرع أوتغيير Connection configuration يجعل catalog/profile availability غير صالحة حتى تحقق حالي جديد.

## الحالة المثبتة

151 unit و60 full Docker PostgreSQL integration و28 Edge Browser E2E، focused setup 1/1، migrations 001–091 وBackend/Web build/typecheck ناجحة. Tests تستخدم actual adapter مع HTTP mocks فقط. UI ar/en/fr وRTL 390px فُحصت؛ credentials/metadata الخاصة لا تُعرض، وuntrusted names/reasons تُrender كنص.

**Implemented وMock/Sandbox Verified محليًا لهذه prerequisite فقط؛ Live Verification Pending External Credential/Approval.** لا external account أوinference call أوProduction credential استُخدمت. Inference وknowledge وeffective config وapproved tools وworkers وassistants وAI evaluations هي خطوات التنفيذ التالية؛ لا ادعاء اكتمال AI.
