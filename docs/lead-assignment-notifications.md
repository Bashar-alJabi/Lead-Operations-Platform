# إشعارات إنشاء Lead والإسناد

## النطاق وحالة التحقق

هذه مرحلة من Notifications المطلوبة في00 §38 و01 §§40–41 و02 §64 و03 §§71/99 و06 §19. توسع المركز الحالي بثلاثة أحداث In-App: `LEAD_CREATED` و`LEAD_ASSIGNED` و`LEAD_REASSIGNED`. لا تكمل جميع Notifications؛Follow-up/attention/Payment/Enrollment/System-Integration events والقنوات الخارجية وmandatory policies مازالت ضمن الفجوات.

تُسجل البوابة النهائية الفعلية فيprogress/coverage. لا تدخلProvider أوcredential أوإرسال خارجي في هذا الجزء،ولاCustomer Conversation أوAI action أوPayment/Enrollment mutation.

## مصادر موثوقة وأحداث دائمة

Native164 تسجل `LEAD_CREATED` من fresh `lead_intake_receipt` داخل نفس transaction إنشاءLead بعدRouting. المصدر واحد لجميع manual/Contact-review/Source intakes الموثقة؛لا اعتماد علىraw customer claim أواسمContact أوcustomer source timestamp. لاbackfill لسجلاتقديمة.

الإسناد الأول عندRouting يُنشر بعد حفظreceipt الموثوقة،إذاوُجدOwner بالفعل. تغييرالإسناد اللاحق يُنشر منfresh `assignment_history` معcurrent Lead write/owner/Branch متطابقة. الانتقال منNULL إلىAgent هوLEAD_ASSIGNED؛تغييرمالك سابق،بمافيهإلغاءالإسناد،هوLEAD_REASSIGNED. no-op assignment لا تنتجحدثًا.

تشتقnative guard scope والوقت وsource identity منالمصدرالمحفوظ،وتمنعdirect forged event وupdates/deletes. `source_id` لأحداثالإسناد UUID تقني حتمي منassignment history ID،معFK صريحةلذلكالسجل؛ليستtoken أوإثباتصلاحية. UNIQUE(event_type,source_id) تمنعالتكرار. مصادرHandoff/SLA تحتفظبـFK وfresh-proof guards الأصلية عبرgenerated handoff_source_id؛لا تخفيفلقواعدها.

الأحداث والـAudit تُحفظ ذرّيًا معالمصدر؛فشلAudit يلغيLead/receipt أوassignment نفسها. لاfan-out إلىكلuser ولاpolling لكلLead؛المركز يستخدمفهارس/keyset الموجودة،بـlimit حتى50،وصلاحياتaudience الحالية. هذهأحداثIn-App مرتبطةبمصادرdomain محددة،وليستgeneric Automation engine أوevent bus مكتملة.

## صلاحيات الوصول والحالة الشخصية

الحدث التشغيلي قدلايمتلكConversation؛هذا لا يلغيLead/Campaign scope. Manager يرىفرعه وSuper Admin مؤسسته،والـAgent يرىLead التييملكهاحاليًا فقط. إعادةالإسناد أوإلغاءالإسناد تمنعOwner السابقمنlist/read-state/history مباشرةً. لا اعتمادعلىالمالك التاريخي لإبقاءالوصول،ولاإظهارهويةالمالكالسابق أوContact values فيDTO.

`notification_access` وread/state/history APIs تعيدفحصcurrent real Session والـLead/Organization/Branch/Campaign. read/unread منفصلة لكلuser،معversion CAS وimmutable history وAudit؛لاينتقلread state إلىOwner جديد. preference شخصيةلكلevent وقناةIN_APP،تخفيالإشعارعنصاحبه دونحذفالحدثأوالتاريخأوكتمغيره.

## الإعداد والواجهة

نفسNotification wording editor تدعمالأحداثالثلاثة معscope Global للـSA وBranch/Campaign ضمنصلاحيةManager،والـAgent لايعدلadministrative wording. Active Campaign→Branch→Global→safe same-language default،وpreview/plain-text/tokens المقيدة/history/CAS هيالآلياتالقائمة. النص لا يغيّرقرارالأعمال أوصلاحياتالإرسال. placeholders تعرضcurrent campaign/owner،وليستادعاءًعنمالك تاريخي.

مركزالإشعارات يميز«حدث تشغيلي محفوظ» عنwaiting Handoff،ويعرضread/unread/history وفتحLead. التفضيلات الجديدة تتيحاختيارنوعالحدث وحفظه باستقلال عنHandoff/SLA. القيمescaped فيReact؛لاHTML منtemplate أوCampaign name. failed/stale reads تمسحالمحتوى السابق،والواجهةar/en/fr وRTL/mobile.

## الاختبارات

- `lead-notifications.test.ts`: actual API intake/Routing/assignment،native source/deduplication/immutability،4intakes و8CAS/assignment requests،current owner/Branch/Organization denial،no-op/unassignment،independent preferences/wording/history وAudit rollback؛لاConversation/job/send ناتجة.
- `source-intake.test.ts`: actual Source intake بلاContact تحفظالحدثين LEAD_CREATED/LEAD_ASSIGNED منreceipt الفعلية،دونfake Human.
- `lead-notifications.spec.ts`: actual API intake/assignment وCentre/read history/preferences/wording UI،noXSS وFrench/Arabic390px،ثمactual unassignment يزيلالوصول ويفرض404 للhistory/state؛failed preference read يمسحالتحكم.
- full regression تحميHandoff/SLA/AI/Messaging/Payments وnative history،معunit assertions لعدمخلطصياغةالأحداث.

## تشغيل migration على بيانات كبيرة

Native164 تضيف generated source FK وتتحقق منchecks/FKs علىالأحداثالمحفوظة. هذا قديمسكDDL lock ويفحص/يعيدكتابةجدولكبير؛قبلأيrollout حقيقيتُقاسالكلفةعلىstaging snapshot وتحددنافذةصيانةوتُختبرالاستعادةوفقrunbook. لا يُفترضzero-downtime أوcapacity غيرمقيسة،ولا تُعدّلmigration مطبقة. التحققالحاليعلىdevelopment/test فقط،ولاProduction deployment.

## التالي

إكمالFollow-up due والتغييراتالماليةوالتنبيهاتالتشغيلية ومصادرهاالموثوقة،ثمmanaged Email/Messaging notification channels وmandatory policy بحسبالمواصفات؛بعدذلكAutomation تستعملapproved application actions دونتجاوزcurrent permissions أوCentral Messaging Policy. لا توسعAI اختياريقبلالوحداتالعامة.
