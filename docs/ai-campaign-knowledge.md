# Campaign Knowledge — المرحلة المنظمة

## القرار

معرفة Campaign مستقلة عن Provider/Profile وعن Branch defaults. Draft وPublished كيانان منفصلان؛ كل حفظ Draft ينتج revision، وكل Publish ينتج publication immutable مرتبطة بالـDraft الحالية وبمستخدم مخوّل وجلسة حالية وسبب اعتماد. Current Published هي أعلى publication version لنفس Campaign؛ لا version pinning ضمن هذه المرحلة. Runtime المستقبلية يجب أن تسجل النسخة المستخدمة دون إعادة كتابة التاريخ بعد نشر نسخة جديدة.

Native 092 تفرض version sequence/current role-organization-Branch-session وcontent shape/history/publication snapshot، مع Audit ذرية. API تضيف optimistic version وrequest UUID: retries لنفس الطلب تعيد publication الأصلية حتى بعد تعديلات لاحقة؛ same key مع version/reason مختلفة يُرفض، ولا يُعاد نشر Draft نفسها بطلب جديد. Preview لا تحفظ أوتنشر، وGET لا ينشئ بيانات. القوائم paginated حسب version وmetadata فقط؛ content لنسخة مختارة بقراءة مستقلة bounded.

## المحتوى والواجهة

تسعة structured text sections: description/product/prices/locations/schedules/availability/requirements/registration/policies، وFAQs وallowed/prohibited claims وapproved HTTPS links. Text لا يعطي system instructions أوtool permissions. Strict schema ترفض unknown properties؛ limits تقنية قابلة للمراجعة: 8000 حرف لكل قسم، 40 FAQ، 80 claim لكل نوع، 30 link، bounded content حتى 64KiB مع conservative application size. Control bytes وinvalid Unicode/unsafe URL credentials/protocols تُرفض. النص يُrender عبر React كنص، دون HTML؛ links تفتح مع `noopener noreferrer`.

الروابط مراجع معتمدة فقط؛ لا external fetch أوادعاء أن المحتوى الخارجي تم ingested/verified. Approved scanned files/assets وqualification وإعداد runtime/effective configuration مراحل مطلوبة لاحقة، وليست مستبدلة بنص أوplaceholder. Publish وحده لا يفعّل Campaign AI؛ readiness guard الحالية باقية.

## التحقق والحدود

153 unit/61 full Docker PostgreSQL integration/29 full Edge Browser E2E وfocused Knowledge 1/1، migrations 001–092 وBackend/Web build/typecheck. Native scope/session/version/immutable publication وAudit rollback، four-way draft edits/eight-way idempotent publish، isolation بين Campaigns، Draft لا تغيّر Published وhistory/version pagination مثبتة. UI ar/en/fr وXSS/Agent denial/RTL 390px فُحصت.

**Structured phase Implemented وPostgreSQL/Local Browser Verified**؛ Knowledge وAI module جزئيتان. لا inference أوAI evaluations أوprovider live call من هذه المرحلة. AI Live Verification Pending External Credential/Approval. التالي explicit shared-use profile entitlement قبل effective configuration، ثم scanned Knowledge assets وqualification/runtime/tools/assistants/evaluations.

## تحديث الملفات المعتمدة — 2026-10-09

المرحلة التالية الموثقة سابقًا نُفذت: scanned assets وexplicit approval وDraft refs/immutable manifests في 094–095،155unit/63integration/31Browser/build/typecheck. راجع ai-knowledge-assets.md للأنواع والأمن والحدود. Qualification/effective config/runtime/evaluations باقية؛لا inference أوactivation من Publish. ما سبق وصف تاريخي للمرحلة المنظمة الأولى.
