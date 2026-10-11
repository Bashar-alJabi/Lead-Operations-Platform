import { useEffect, useRef, useState } from 'react';
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Result = { items: { id: string; state: string; error_code: string | null; handoff_reason: string; created_at: string; knowledge_version: number; customer_question: string }[];
  nextCursor: string | null; current: { state: string; controller_type: string; campaign_name: string; source_kind: string };
  qualification: { questions: { id: string; prompt: string; value: unknown; source: string | null }[]; result: { missingQuestionIds: string[] } | null; blockers: string[] } };
const labels = {
  en: { title: 'AI human handoff requests', read: 'Review handoff requests', more: 'Older handoff requests', empty: 'No AI human handoff requests.', current: 'Current conversation', question: 'Customer question at request', qualification: 'Current qualification', version: 'Published knowledge version', note: 'Use the conversation history and qualification panels to review the evidence. Taking over explicitly accepts human control. Lead ownership remains separate.', restricted: 'Some qualification items are unavailable or restricted.' },
  ar: { title: 'طلبات تسليم AI إلى موظف', read: 'مراجعة طلبات التسليم', more: 'طلبات تسليم أقدم', empty: 'لا توجد طلبات تسليم AI إلى موظف.', current: 'المحادثة الحالية', question: 'سؤال العميل عند الطلب', qualification: 'Qualification الحالية', version: 'إصدار المعرفة المنشورة', note: 'راجع الأدلة في سجل المحادثة ولوحة Qualification. تولّي المحادثة يقبل التحكم البشري صراحةً. ملكية Lead مستقلة عن التحكم.', restricted: 'بعض عناصر Qualification غير متاحة أو محجوبة بالصلاحيات.' },
  fr: { title: 'Demandes de transfert IA à un humain', read: 'Consulter les transferts', more: 'Transferts précédents', empty: 'Aucune demande de transfert IA.', current: 'Conversation actuelle', question: 'Question client au moment de la demande', qualification: 'Qualification actuelle', version: 'Version publiée', note: 'Consultez l’historique et la qualification pour vérifier les preuves. Prendre la conversation accepte explicitement le contrôle humain. La propriété du Lead reste distincte.', restricted: 'Certains éléments de qualification sont indisponibles ou restreints.' },
};
export function ConversationAIHandoffs({ conversationId, locale, api }: { conversationId: string; locale: 'ar' | 'en' | 'fr'; api: Api }) {
  const t = labels[locale], [value, setValue] = useState<Result | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), sequence = useRef(0);
  useEffect(() => { sequence.current++; setValue(null); setError(''); setBusy(false); return () => { sequence.current++; }; }, [conversationId]);
  async function load(older = false) {
    const s = ++sequence.current, previous = older ? value : null; setBusy(true); setError(''); if (!older) setValue(null);
    try {
      const r = await api<Result>('/api/conversations/' + conversationId + '/ai-handoffs' + (previous?.nextCursor ? '?cursor=' + encodeURIComponent(previous.nextCursor) : ''));
      if (sequence.current === s) setValue({ ...r, items: [...new Map([...(previous?.items ?? []), ...r.items].map(e => [e.id, e])).values()] });
    } catch (e) { if (sequence.current === s) { setValue(null); setError((e as Error).message); } }
    finally { if (sequence.current === s) setBusy(false); }
  }
  return <section className="panel" data-ai-handoffs><h4>{t.title}</h4><p>{t.note}</p><button disabled={busy} onClick={() => void load()}>{t.read}</button>
    {error && <p role="alert">{error}</p>}{value && <><p>{t.current}: {value.current.state} · {value.current.controller_type}</p><p>{value.current.campaign_name} · {value.current.source_kind}</p>
      {!value.items.length && <p>{t.empty}</p>}{value.items.map(e => <article key={e.id} data-ai-handoff-request><p dir="ltr">{e.handoff_reason} · {e.state}</p><time dateTime={e.created_at}>{new Date(e.created_at).toLocaleString(locale)}</time>
        {e.error_code && <p dir="ltr" style={{ overflowWrap: 'anywhere' }}>{e.error_code}</p>}<p>{t.version}: {e.knowledge_version}</p><p>{t.question}: <span dir="auto" style={{ display: 'block', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{e.customer_question}</span></p></article>)}
      <h5>{t.qualification}</h5>{value.qualification.blockers.length > 0 && <p>{t.restricted}</p>}{value.qualification.questions.map(q => <p key={q.id} style={{ overflowWrap: 'anywhere' }}>{q.prompt}: {q.value === null ? '—' : typeof q.value === 'string' ? q.value : JSON.stringify(q.value)} · {q.source ?? '—'}</p>)}
      {value.nextCursor && <button disabled={busy} onClick={() => void load(true)}>{t.more}</button>}</>}
  </section>;
}
