# متطلبات مزودي الدفع وأولوية التنفيذ

## توضيح النطاق — 2026-10-07

المواصفات الأصلية تطلب **دعم** تعدد Payment Providers/Connections وprovider-independent architecture:

- `docs/03-integrations-ui-requirements.md` §32: دعم عدة Providers/Connections، و§33: الإعداد من داخل المنصة.
- `AGENTS.md` §12: إمكانية دعم أكثر من Payment provider/account دون ربط Core بمزوّد واحد.
- `docs/00-comprehensive-functional-concept.md` §3.7: تعدد الحسابات والاتصالات والمزودين عند الحاجة.
- `docs/01-domain-model.md` §51: Stripe وOther payment provider أمثلة وليست قائمة قبول محددة.
- `README.md` §13 و`docs/06-final-completeness-and-acceptance.md` §14: التدفق المالي الموثوق وإدارة حالات الفشل.

هذه النصوص لا تحدد عدد adapters يجب تنفيذها end-to-end ولا تفرض Mollie أو اسمًا ثانيًا بعينه. لا يكفي وجود abstraction لإعلان اكتمال المنتج، ولا يجوز تحويل اختيار هندسي لمزوّد إضافي إلى Requirement مفترضة.

تعليمات المستخدم في 2026-10-07 تحدد القائمة الملزمة التالية وترتيب dependencies:

1. **Stripe:** المحافظة على التدفق الحالي واختبارات regression؛ إكمال الفجوات العامة اللازمة دون تحسينات Stripe اختيارية تؤخر بقية النطاق.
2. **PayPal:** إعداد Connection/credentials ومعلومات callback، خيارات الحساب، إنشاء Checkout، الأفعال المالية اللازمة للمزوّد، independent trusted confirmation، history/UI/recovery واختبارات سلبية كاملة.
3. **Alma:** adapter مستقلة وإعداد الواجهة وcallback والتحقق من merchant/payment/exact money حسب عقد API الموثوق، دون خلطها بStripe أوPayPal.
4. **Bank Transfer:** طريقة دفع مستقلة؛ طلب/مرجع التحويل ليس Payment Confirmed. تحتاج trusted verification/reconciliation لعملية بنكية حقيقية أوtest double معتمد، مع exact amount/currency/beneficiary/reference وdedup/history/Audit وصلاحيات الإدارة ضمن النطاق. قول العميل أوإيصال يرفعه وحده لا يؤكد المال ولا ينشئ Enrollment.

Mollie ليست Requirement حالية. الكود الخاص بها لم يُفعّل ولم تُطبق migration مسودته؛ حُفظت خمسة ملفات أصلية مع SHA-256 داخل `.local/recovered-mollie/2026-10-07/`، وهي ignored وغير مطلوبة للتشغيل أوالاستكمال. فُصلت منه حماية DB العامة لهوية Payment Connection إلى migration070 مستقلة؛ لا تفعيل لأي Provider فيها.

## القواعد المشتركة

- Provider-independent Connection/checkout/receipt contracts تبقى؛ financial Domain لا يستخدم provider-specific raw payload لتقرير Paid.
- Current authorization وBranch/Lead/Method isolation، encrypted credentials، immutable original merchant/config/request/attempt evidence وbounded retries لا تتغير.
- success page وcustomer claim وauthorization غير مكتملة ليست trusted confirmation. Callback تحتاج authenticity/replay/idempotency والتحقق من الهوية والمال حسب المزود.
- Operations التي تحتاج capture أوreconciliation تنفذ كأفعال واضحة قابلة للتتبع مع durable idempotency؛ لا تُضاف كhidden retry داخل adapter.
- Payment وEnrollment كيانان منفصلان؛ Enrollment من trusted confirmation transaction فقط، ولا automatic Lead closure.
- إدماج Alma لا يعني بناء Installment schedules/Payment Plans أوAccounting/Ledger داخل المنصة؛ نطاقها يبقى تكامل Provider checkout وtrusted merchant confirmation. قواعد أقساط المزود لا تُخمن ولا يُعتبر اختيار العميل خطةً دليل دفع.
- لا توصف Provider بأنها مكتملة دون Backend/DB/Authorization/Business rules/UI وIntegration tests وBrowser E2E ناجحة.
- كل مزود يُصنف على حدة: Implemented،Mock/Sandbox Verified،Live Provider Verified،أوLive Verification Pending External Credential/Approval. غياب live credentials لا يبرر ترك adapter أوsetup أوtests غير منفذة.

## الحالة المثبتة عند تغيير الأولوية

| المسار | الحالة |
|---|---|
| Stripe core issuance/receipt/confirmation/Enrollment/repair/share | Mock/PostgreSQL/Local Browser Verified؛ 99unit/40integration/19Browser في50820cf؛ ليست Payments module Complete أوLive Verified |
| PayPal | Connection Authentication/UI/encrypted lifecycle مثبتة: Mock/PostgreSQL/Local Browser Verified ضمن103unit/41integration/20Browser؛ لاoptions/payee proof/Checkout/capture/callback/financial confirmation بعد؛ Live Verification Pending External Credential/Approval؛ ليستProvider Complete |
| Alma | مطلوب؛ غير منفذ |
| Bank Transfer | مطلوب؛ غير منفذ كطريقة مستقلة معtrusted reconciliation |
| Mollie | خارج القائمة الحالية؛ مسودة محفوظة محليًا وغير مفعلة، بلاVerification claim |

التقدم الحالي والاختبارات الجديدة في `codex-progress.md` و`requirement-coverage.md`، وتحديد الأولوية هذا لا يُسقط أي متطلب آخر فيProduct docs.
