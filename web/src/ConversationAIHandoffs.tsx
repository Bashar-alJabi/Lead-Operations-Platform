import { useEffect, useRef, useState } from 'react';
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Result = { items: { id: string; state: string; error_code: string | null; handoff_reason: string; created_at: string; knowledge_version: number; customer_question: string }[];
  nextCursor: string | null; current: { state: string; controller_type: string; campaign_name: string; source_kind: string };
  qualification: { questions: { id: string; prompt: string; value: unknown; source: string | null }[]; result: { missingQuestionIds: string[] } | null; blockers: string[] };
  package: { summaries: { id: string; state: string; error_code: string | null; stale: boolean; truncated: boolean; completed_at: string | null; knowledge_version: number;
    result: { decision: string; answer: string } | null }[]; awaitingCustomerMessage: { id: string; body: string; message_kind: string; created_at: string } | null;
    publication: { version: number; references: { id: string; text: string }[] } | null; refreshAvailable: boolean; suggestedNextAction: string } };
const labels = {
  en: { title: 'AI human handoff requests', read: 'Review handoff requests', more: 'Older handoff requests', empty: 'No AI human handoff requests.', current: 'Current conversation', question: 'Customer question at request', qualification: 'Current qualification', version: 'Published knowledge version', note: 'Use the conversation history and qualification panels to review the evidence. Taking over explicitly accepts human control. Lead ownership remains separate.', restricted: 'Some qualification items are unavailable or restricted.' },
  ar: { title: 'طلبات تسليم AI إلى موظف', read: 'مراجعة طلبات التسليم', more: 'طلبات تسليم أقدم', empty: 'لا توجد طلبات تسليم AI إلى موظف.', current: 'المحادثة الحالية', question: 'سؤال العميل عند الطلب', qualification: 'Qualification الحالية', version: 'إصدار المعرفة المنشورة', note: 'راجع الأدلة في سجل المحادثة ولوحة Qualification. تولّي المحادثة يقبل التحكم البشري صراحةً. ملكية Lead مستقلة عن التحكم.', restricted: 'بعض عناصر Qualification غير متاحة أو محجوبة بالصلاحيات.' },
  fr: { title: 'Demandes de transfert IA à un humain', read: 'Consulter les transferts', more: 'Transferts précédents', empty: 'Aucune demande de transfert IA.', current: 'Conversation actuelle', question: 'Question client au moment de la demande', qualification: 'Qualification actuelle', version: 'Version publiée', note: 'Consultez l’historique et la qualification pour vérifier les preuves. Prendre la conversation accepte explicitement le contrôle humain. La propriété du Lead reste distincte.', restricted: 'Certains éléments de qualification sont indisponibles ou restreints.' },
};
const packageLabels = {
  en: { title: 'Handoff review package', summary: 'AI evidence summary (latest five)', refresh: 'Refresh handoff summary', stale: 'Historical summary: current context has changed', truncated: 'Summary source is limited to the latest 20 excerpts; review full message history.', noSummary: 'No summary available. Human acceptance remains available independently.', attribution: 'Selected conversation excerpts retain speaker and delivery attribution. Customer payment claims are unverified.', awaiting: 'Latest customer message awaiting a sent reply', awaitingNote: 'Based on saved message and delivery history; this does not establish whether an earlier reply answered the question.', none: 'No customer message awaiting a sent reply.', missing: 'Missing qualification items', refs: 'Current published knowledge references', next: 'Suggested next action', accept: 'Review the evidence and explicitly accept Human control.', respond: 'Review the evidence and respond only as the current Human controller.', review: 'Review current conversation control.', live: 'Live customer-data transfer is disabled.' },
  ar: { title: 'حزمة مراجعة التسليم', summary: 'ملخص أدلة AI (آخر خمسة)', refresh: 'تحديث ملخص التسليم', stale: 'ملخص تاريخي: تغيّر السياق الحالي', truncated: 'مصدر الملخص محدود بآخر20 مقتطفًا؛راجع سجل الرسائل الكامل.', noSummary: 'لا يوجد ملخص متاح. قبول التحكم البشري متاح بصورة مستقلة.', attribution: 'المقتطفات المختارة تحتفظ بنسبة الكلام للمتحدث وحالة التسليم. ادعاءات العميل بالدفع غير مؤكدة.', awaiting: 'آخر رسالة عميل تنتظر ردًا مرسلًا', awaitingNote: 'من سجل الرسائل والتسليم المحفوظ؛لا يثبت ذلك إن كان رد سابق قد أجاب السؤال.', none: 'لا توجد رسالة عميل تنتظر ردًا مرسلًا.', missing: 'عناصر Qualification الناقصة', refs: 'مراجع المعرفة المنشورة الحالية', next: 'الإجراء التالي المقترح', accept: 'راجع الأدلة ثم اقبل التحكم البشري صراحةً.', respond: 'راجع الأدلة ورد فقط بصفتك المتحكم البشري الحالي.', review: 'راجع التحكم الحالي بالمحادثة.', live: 'إرسال بيانات العملاء الحي معطّل.' },
  fr: { title: 'Dossier de transfert', summary: 'Résumé des preuves IA (cinq derniers)', refresh: 'Actualiser le résumé de transfert', stale: 'Résumé historique : contexte actuel modifié', truncated: 'Source limitée aux 20 derniers extraits ; consultez tout l’historique.', noSummary: 'Aucun résumé disponible. L’acceptation humaine reste disponible indépendamment.', attribution: 'Les extraits conservent leur auteur et état de livraison. Les déclarations de paiement du client ne sont pas vérifiées.', awaiting: 'Dernier message client en attente d’une réponse envoyée', awaitingNote: 'Selon l’historique des messages et livraisons ; cela ne prouve pas qu’une réponse antérieure répondait à la question.', none: 'Aucun message client en attente d’une réponse envoyée.', missing: 'Éléments de qualification manquants', refs: 'Références publiées actuelles', next: 'Prochaine action suggérée', accept: 'Consultez les preuves puis acceptez explicitement le contrôle humain.', respond: 'Consultez les preuves et répondez uniquement en tant que contrôleur humain actuel.', review: 'Consultez le contrôle actuel.', live: 'Le transfert réel de données client est désactivé.' },
};
export function ConversationAIHandoffs({ conversationId, locale, api, revision }: { conversationId: string; locale: 'ar' | 'en' | 'fr'; api: Api; revision: string }) {
  const t = labels[locale], p = packageLabels[locale], [value, setValue] = useState<Result | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), sequence = useRef(0);
  useEffect(() => { sequence.current++; setValue(null); setError(''); setBusy(false); return () => { sequence.current++; }; }, [conversationId, revision]);
  async function load(older = false) {
    const s = ++sequence.current, previous = older ? value : null; setBusy(true); setError(''); if (!older) setValue(null);
    try {
      const r = await api<Result>('/api/conversations/' + conversationId + '/ai-handoffs' + (previous?.nextCursor ? '?cursor=' + encodeURIComponent(previous.nextCursor) : ''));
      if (sequence.current === s) setValue({ ...r, items: [...new Map([...(previous?.items ?? []), ...r.items].map(e => [e.id, e])).values()] });
    } catch (e) { if (sequence.current === s) { setValue(null); setError((e as Error).message); } }
    finally { if (sequence.current === s) setBusy(false); }
  }
  async function refresh() {
    const s = ++sequence.current; setBusy(true); setError(''); setValue(null);
    try {
      await api('/api/conversations/' + conversationId + '/ai-handoff-summary', { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID() }) });
      const r = await api<Result>('/api/conversations/' + conversationId + '/ai-handoffs');
      if (sequence.current === s) setValue(r);
    } catch (e) { if (sequence.current === s) { setValue(null); setError((e as Error).message); } }
    finally { if (sequence.current === s) setBusy(false); }
  }
  return <section className="panel" data-ai-handoffs><h4>{t.title}</h4><p>{t.note}</p><button disabled={busy} onClick={() => void load()}>{t.read}</button>
    {error && <p role="alert">{error}</p>}{value && <><p>{t.current}: {value.current.state} · {value.current.controller_type}</p><p>{value.current.campaign_name} · {value.current.source_kind}</p>
      {!value.items.length && <p>{t.empty}</p>}{value.items.map(e => <article key={e.id} data-ai-handoff-request><p dir="ltr">{e.handoff_reason} · {e.state}</p><time dateTime={e.created_at}>{new Date(e.created_at).toLocaleString(locale)}</time>
        {e.error_code && <p dir="ltr" style={{ overflowWrap: 'anywhere' }}>{e.error_code}</p>}<p>{t.version}: {e.knowledge_version}</p><p>{t.question}: <span dir="auto" style={{ display: 'block', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{e.customer_question}</span></p></article>)}
      <div data-ai-handoff-package><h5>{p.title}</h5><p>{p.live}</p><p>{p.next}: {value.package.suggestedNextAction === 'REVIEW_AND_ACCEPT_HUMAN_CONTROL' ? p.accept : value.package.suggestedNextAction === 'REVIEW_AND_RESPOND_AS_CURRENT_CONTROLLER' ? p.respond : p.review}</p>
        <h5>{p.awaiting}</h5><p>{p.awaitingNote}</p>{value.package.awaitingCustomerMessage ? <p dir="auto" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value.package.awaitingCustomerMessage.body || value.package.awaitingCustomerMessage.message_kind}</p> : <p>{p.none}</p>}
        <h5>{p.summary}</h5><p>{p.attribution}</p>{!value.package.summaries.length && <p>{p.noSummary}</p>}
        {value.package.summaries.map(s => <article key={s.id} data-ai-handoff-summary><p dir="ltr" style={{ overflowWrap: 'anywhere' }}>{s.state} {s.error_code}</p>{s.completed_at && <time dateTime={s.completed_at}>{new Date(s.completed_at).toLocaleString(locale)}</time>}
          <p>{t.version}: {s.knowledge_version}</p>{s.stale && <p>{p.stale}</p>}{s.truncated && <p>{p.truncated}</p>}
          {s.result?.decision === 'ANSWER' ? <p dir="auto" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{s.result.answer}</p> : s.result && <p>{p.noSummary}</p>}</article>)}
        {value.package.refreshAvailable && <button disabled={busy} onClick={() => void refresh()}>{p.refresh}</button>}
        {value.package.publication && <details><summary>{p.refs} · {value.package.publication.version}</summary>{value.package.publication.references.map(r => <p key={r.id} dir="auto" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{r.text}</p>)}</details>}
      </div>
      <h5>{t.qualification}</h5>{value.qualification.blockers.length > 0 && <p>{t.restricted}</p>}{value.qualification.questions.map(q => <p key={q.id} style={{ overflowWrap: 'anywhere' }}>{q.prompt}: {q.value === null ? '—' : typeof q.value === 'string' ? q.value : JSON.stringify(q.value)} · {q.source ?? '—'}</p>)}
      {value.qualification.result && <div><h5>{p.missing}</h5>{value.qualification.result.missingQuestionIds.map(id => <p key={id}>{value.qualification.questions.find(q => q.id === id)?.prompt}</p>)}</div>}
      {value.nextCursor && <button disabled={busy} onClick={() => void load(true)}>{t.more}</button>}</>}
  </section>;
}
