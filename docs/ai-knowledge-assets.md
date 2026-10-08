# Campaign Knowledge assets

## السياق

ملفات Knowledge لها Campaign identity وapproval وhistory مستقلة عن Messaging attachments. تشارك storage/ClamAV primitives التقنية فقط؛ لا Connection/Sender أوbusiness context sharing. Manager يدير Campaign في فرعه وSuper Admin في Organization؛ Agent لا يرفع أويراجع أوينزل هذه الملفات. Runtime المستقبلية تقرأ manifest للـCurrent Published عبر approved tool ضمن Lead/Campaign scope، وليست endpoint الإدارة.

## الرفع والفحص

`POST /api/ai/campaigns/:id/knowledge/assets` يستقبل bytes عبر `application/octet-stream` وlabel/mime/upload UUID. Authorization قبل body، حد upload متزامنين لكل process وrate limit، وإعادة فحص current role/session/Branch بعد التخزين. UUID/SHA256 server naming لا يستخدم filename. تكرار نفس uploader/Campaign/key/hash/type/label يعيد الأصل؛ تغييره conflict. Content validation قبل private quarantine؛ لا download من QUEUED/RUNNING/FAILED/scan REJECTED.

الأنواع: TXT UTF-8 حتى 32KiB، PDF وPNG/JPEG مع magic detection. الحد التقني `KNOWLEDGE_ASSET_MAX_BYTES` افتراضيًا 10MiB، بين 1KiB و25MiB؛ binary validation يطبق media bound أيضًا. لا executable/ZIP/Office بناء على filename أوMIME. نص TXT يبقى untrusted data حتى بعد approval ولا يعطي system instructions أوtool permissions. Binary files مراجع يمكن تنزيلها ومراجعتها؛ لا OCR أوPDF text extraction أوحقائق مستنتجة. Content extraction لهذه الأنواع تحسين تقني لاحق؛ لا يمنع مراجعة وإرفاق ملفات معتمدة الآن، والواجهة توضح الفرق.

`worker:media` يشغّل `processOneKnowledgeAsset` بجانب inbound/template media. PostgreSQL SKIP LOCKED و120s lease/UUID وnative completion token/current uploader scope fences تمنع stale completion. Hash/size/type وClamAV clean/version تتحقق قبل REVIEW. Scanner/storage transient error → QUEUED بbounded exponential delay حتى خمس محاولات ثم FAILED. Malware/hash mismatch/current requester revocation → REJECTED مع safe error. Lease recovery تزيد attempts وتحفظ version/history؛ لا network داخل transaction. Terminal scan state immutable؛ الإصلاح بإعادة رفع asset جديدة، دون إعادة كتابة الدليل القديم.

## المراجعة والنشر

Clean scan تنتج REVIEW فقط. إدارة مخوّلة تقرأ extracted TXT كنص أوتنزل binary file ثم تقرر APPROVED/REJECTED مع reason/current session/version. القرار immutable؛ retry مطابق يعيد الأصل وقرار مختلف conflict. Native approval/history/Audit ذرية. Rejected management review تمنع download لاحقة وتحفظ التاريخ.

Draft يمكن أن تحتوي `assets` حتى 10 UUIDs فريدة، كلها same-Campaign scanned + explicitly approved. Native/API تمنع pending/rejected/foreign IDs في save/preview/publish. النسخ القديمة ذات خمسة مفاتيح محفوظة دون rewrite؛ 094 توسع validation للنسخ الجديدة فقط. Publication manifest immutable تشمل label/type/size/hash/scanner/time/extracted text/approval actor/time/reason. إزالة reference من Draft جديدة لا تغير النسخة المنشورة القديمة؛ response/version read تعرض manifest الأصلية. History lists metadata paginated.

Download تعيد current session/Campaign authorization بعد storage read وتتحقق من hash/size/backend. `attachment` وserver-generated safe filename وnosniff وCSP sandbox وprivate no-store؛ لا inline execution أوpublic storage URL. React تعرض النص غير الموثوق escaped، دون HTML. DB/blob storage يحتفظان بالأصول التاريخية معًا؛ لا arbitrary link fetch.

## التشغيل والحواجز

094–095 تفرض native upload/current access/identity/state/version/attempt/completion proof، current explicit approval، immutable history/manifest وsame-Campaign publication/Audit. Trusted scan worker جزء من service boundary؛ DB credentials infrastructure لا تعطى للمستخدم أوAI.

Private local/S3 storage القائمة تستخدم deployment credentials صريحة؛ لا personal AWS discovery أوbusiness AI credentials. فشل commit بنتيجة غير مؤكدة بعد upload لا يحذف object قد تكون referenced. Orphans تحتاج housekeeping مع DB inventory وbackup، دون حذف ملفات مرتبطة؛ no automatic destructive cleanup هنا. Setup التشغيلي للملفات والمراجعة والنشر في Campaign UI؛ storage/scanner إعداد infrastructure فقط.

هذه Knowledge prerequisite. Inference/qualification/effective configuration/approved tools/evaluations باقية؛ لا Live AI verification من فحص الملفات المحلي.
