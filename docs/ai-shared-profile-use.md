# Explicit shared AI profile use

## القرار

وفق 03 §52 و04 §75 و05 §§12–17، مشاركة Provider/Profile/Runtime لا تمنح مشاركة Campaign business context أوcredentials. Super Admin تتيح Organization AI connection صراحة لكل Branch؛ إتاحة Connection تعرض profiles التابعة لها كاختيارات تشغيلية لهذا الفرع. No implicit fallback. Manager يمكنه قراءة usable metadata ضمن فرعه فقط؛ لا models/credential/config/probe/history management للاتصال المشترك. Agent لا يدير setup أوgrants.

Grant مستقلة ذات version/current Connection version/actor/session/reason، native scope/history/Audit في 093. Identity لا تُنقل، وrevoke تحفظ التاريخ. Credential rotation/disable لا تمحو entitlement history؛ current catalog/Connection/Profile/Branch health تعاد قراءتها، ولا catalog availability من cache قديمة. Revoke تمنع metadata use التالية. `/api/ai/usable-profiles` تعيد safe IDs/names/model/task/token budget وprofile/Connection/grant versions بصفحات bounded؛ لا secret أوsession IDs أوCampaign knowledge. Future effective configuration/execution يجب أن تعيد فحص entitlement/current versions قبل التنفيذ وتحفظ trace.

## التشغيل والتحقق

Super Admin تختار shared connection في AI setup وتفتح history/details ثم تختار Branch وactive/reason، وتحفظ grant أوrevoke. History/version conflict/connection version conflict واضحة؛ لا force overwrite. Branch usable profile view تعرض availability دون edit/shared credentials. تعطيل Branch/Connection/Profile يجعل catalog غير متاحة؛ revoke تزيل shared profile من usable result. Revocation تظل ممكنة للفرع المعطل.

153 unit/62 full Docker PostgreSQL integration/30 full Edge Browser E2E، focused shared-use 1/1، migrations 001–093 وBackend/Web build/typecheck ناجحة. Integration تثبت four-way edit/current admin/session/organization/immutability/Audit rollback/pagination/revoke/restore/current Connection وinactive Branch. Browser تستخدم actual OpenAI catalog adapter مع HTTP mocks وتثبت Admin grant → Manager metadata → unavailable connection → revoke/history وsecret omission/Manager denial/XSS/French/RTL 390px. Focused integration catalog injected synthetic adapter؛ لا inference أوexternal account/Live Provider Verified. prerequisite **Implemented وPostgreSQL/Local Browser Verified**، وAI **Live Verification Pending External Credential/Approval**.

Scanned Knowledge assets وqualification/effective config/approved tools/runtime/assistants/evaluations ثم Automation/Notifications/Analytics وبقية النطاق خطوات مطلوبة تالية؛ AI module جزئية.
