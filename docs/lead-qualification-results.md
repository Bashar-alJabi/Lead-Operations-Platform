# إجابات ونتيجة Qualification على Lead

## المرجع والسلوك

01 §§65–66 و02 §48 و04 §§17–20 تسمح بربط سؤال بحقل المنصة، وباحتساب النتيجة من Structured Field Values بدل تكرار Current State. هذه المرحلة تنفذ جمع Human للإجابات وقراءة النتيجة من البيانات الفعلية. شروط الحملة الحالية تحدد الاكتمال والبيانات الناقصة ومطابقة شروط handoff؛ Required questions تبقى لازمة، وfalse و0 إجابات صحيحة.

- إجابة السؤال المرتبط بـField تقرأ من `lead_field_value` الحالية. الحفظ يستعمل `writeManualFieldValue` نفسها التي تستعملها واجهة Field، مع type/options/validation والصلاحيات وoptimistic version وField history. تحرير Field لاحقًا يغير النتيجة الحالية، ويحتفظ تاريخ Qualification بالإجابة التي جُمعت سابقًا.
- السؤال غير المرتبط يحتفظ بإجابة نصية bounded أوnull في `lead_qualification_answer`. الإجابة تبقى حالية عندما يكون question snapshot مطابقًا، بما في ذلك ترتيب جديد أوتعديل شروط أخرى أوتعطيل/إعادة تفعيل الحملة. تغيير سؤالها أوmapping لا يعيد تفسير الإجابة السابقة تلقائيًا؛ تبقى في التاريخ المصرح به ويحتاج السؤال المعدل إجابة جديدة. `collectedDefinitionVersion` تحفظ نسخة الجمع حتى عند استعمال الإجابة نفسها تحت تعريف أحدث.
- Source لهذه العملية `HUMAN`، مشتقة من الفعل المصادق عليه. مصدر Field الحالية يبقى المصدر الفعلي؛ `MANUAL` يعرض كـHUMAN. لا يُستنتج Form من SOURCE ولا يُقبل source/actor/tool من العميل. AI/Form actions الفعلية تحتاج approved provenance/tool/input boundary في مراحلها التالية؛ schema الحالية لا تسمح بانتحالها.
- النتيجة مشتقة عند القراءة من current Definition/Field/value versions؛ لا تُحفظ Preview كحقيقة ولا تتغير Lead lifecycle أوPayment أوEnrollment أوConversation Controller عند حفظ إجابة. تحقق handoff criteria يظهر كمعلومة إلى أن تنفذ طبقة انتقال Controller المعتمدة.

## API والصلاحيات

- `GET /api/leads/:id/qualification`: النسخة الحالية والأسئلة المسموح بها والقيم ومصادرها ونسخها والنتيجة/البيانات الناقصة والـblockers. لا تعديل أثناء القراءة.
- `PUT /api/leads/:id/qualification/answers/:questionId`: إجابة واحدة، مع `requestId`, `definitionVersion`, `answerVersion`, `fieldValueVersion`, `value`. صفر يعني absence للنسخة؛null مخصص للسؤال غير المرتبط. تغيير معنى السؤال/النسخة أوالقيمة المتزامنة يرفض بـ409.
- `GET .../answers/:questionId/history?before=&limit=`: تاريخ immutable مع pagination. يعاد فحص Lead assignment وSession وField visibility الحالية للتعريف الحالي والمقابل التاريخي.

Agent يحتاج ملكية Lead الحالية وفرعه الحالي. Manager ضمن الفرع، وSuper Admin ضمن Organization. Branch معطلة تمنع الكتابة وتعطي blocker للنتيجة. يُفحص current session/role/active/organization/Branch بعد الحصول على locks؛ لا تكفي صلاحية مأخوذة قبل transaction.

Question مرتبطة بـField مخفية لا تظهر، ولا يظهر mapping أوprompt أوvalue؛ النتيجة الكلية تصبح unavailable بدل تسريب حقيقة عبرcomplete أوmissingQuestionIds. التاريخ المرتبط بـField مخفية حاليًا لا يعرض للطالب. Current mapping/active/usable_by_ai/MANUAL/type validity جزء من الحساب. بيانات قديمة غير صالحة لا تعطي Complete؛ المستخدم المخوّل يستطيع تصحيحها بقيمة typed صالحة.

## سلامة البيانات

Migration100 تضيف request receipt وCurrent answer وimmutable answer history. Lead lock ينسق هذا الفعل مع تعديل Fields وإعادة assignment. request hash canonical يربط original strict payload بالـLead/actor/key؛ نفس الطلب يعود كـduplicate metadata دون كتابة جديدة حتى بعد تغير التعريف. اختلاف body لنفس المفتاح يرفض. إعادة محاولة مستخدم فقد Lead access ترفض قبل duplicate lookup.

Native guards تتحقق من current session/role/assignment/Branch/Definition/question/version، ومطابقة answer مع request وField value الحالية/source/actor/version، وتمنع تعديل receipt/history أوحذف answer history. Deferred constraint تمنع commit لreceipt بلا capture history المطابقة. Answer history وAudit وLead activity تنشأ في نفس transaction؛ فشل Audit يعيد أيضًا Field value وField history وreceipt. Audit يحتوي identifiers/versions/source ولا ينسخ محتوى الإجابة.

Typed Field business validation مشتركة داخل Application Service، أما Native Field proof فيثبت current authorized mapping والقيمة/المصدر/نسخة الكتابة؛ ليس ادعاء تكرار كل validators داخل SQL. مستقبل AI tools يجب أن يستعمل approved application action مع مصدر مثبت، لا SQL مباشرة.

الاستعلامات الحالية bounded بعدد أسئلة التعريف (40 كحد تقني موثق في config)، ولا تحمل إجابات الأسئلة التاريخية المحذوفة كلها. التاريخ server paginated/indexed. Request محدودة بـ128KiB حتى تستوعب LONG_TEXT typed عند حد المنصة20000 حرف مع UTF-8/JSON expansion؛unmapped text تبقى4000 حرف،وNUL/invalid Unicode ترفض قبل JSONB. React يعرض المحتوى كنص؛ لا HTML execution أوexternal fetch. UI ar/en/fr تعرض collected answers/source/completion/history/readonly/reload/conflict وتعتمد stable request key لإعادة المحاولة لنفس draft.

## حالة التحقق

Human baseline Implemented وPostgreSQL/Local Browser Verified بـ160unit/66full Docker PostgreSQL integration/34full Edge Browser E2E وfocused Browser1/1 و001–100 وBackend/Web build/typecheck. الاختبارات تثبت idempotency/concurrency/current scope/native immutable/deferred proof/Audit rollback وhidden-result/history وsame-question semantics و20k UTF-8/type/oversize/NUL/Unicode. Browser تثبت actual Human/Field/current result/history وpermissions/failure/disable/reenable/XSS/French/RTL390px؛الصورة النهائية فُحصت. لا inference أوLive AI verification أوautomatic handoff. AI وForm actual source actions وruntime/evaluations وبقية المنصة تبقى متطلبات مستقلة غير مكتملة.
