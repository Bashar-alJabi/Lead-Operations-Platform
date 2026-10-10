import { useEffect, useRef, useState } from 'react';
type Entry = { id: string; sourceMessageId: string; state: string; errorCode: string | null; knowledgeVersion: number | null; createdAt: string; stale: boolean; attemptCount: number; providerInvoked: boolean; action: { id: string; tool: string; state: string; errorCode: string | null; createdAt: string } | null; proposal: { decision: string; handoffReason: string | null; answer: string | null } | null };
type Result = { items: Entry[]; nextCursor: string | null };
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
const labels = {
  en: { title: 'Customer AI execution history', read: 'Review AI executions', more: 'Older executions', empty: 'No authenticated customer AI executions.', note: 'Live AI data transfer is disabled. A stored proposal or blocked record authorizes no customer message, tool action or payment confirmation.', source: 'Source message', version: 'Published knowledge version', unavailable: 'Unavailable', stale: 'The current context has changed. The original trace is retained.', attempts: 'Attempts', proposed: 'Proposed next step', pending: 'No action or customer message has been executed.' },
  ar: { title: 'سجل تنفيذ AI للعملاء', read: 'مراجعة تنفيذ AI', more: 'تنفيذات أقدم', empty: 'لا توجد تنفيذات AI للعملاء ذات مصدر وارد موثّق.', note: 'نقل البيانات الحي إلى AI معطّل. الاقتراح المحفوظ أو السجل المحجوب لا يمنح إذنًا لإرسال رسالة أو تنفيذ إجراء أو تأكيد دفع.', source: 'الرسالة المصدر', version: 'إصدار المعرفة المنشورة', unavailable: 'غير متاح', stale: 'تغيّر السياق الحالي. أثر التنفيذ الأصلي محفوظ.', attempts: 'المحاولات', proposed: 'الخطوة التالية المقترحة', pending: 'لم يُنفّذ أي إجراء أو إرسال للعميل.' },
  fr: { title: 'Historique des exécutions IA client', read: 'Consulter les exécutions IA', more: 'Exécutions précédentes', empty: 'Aucune exécution IA client avec source authentifiée.', note: 'Le transfert de données IA en direct est désactivé. Une proposition ou une trace bloquée ne permet aucun message, action ou confirmation de paiement.', source: 'Message source', version: 'Version des connaissances publiées', unavailable: 'Indisponible', stale: 'Le contexte actuel a changé. La trace originale est conservée.', attempts: 'Tentatives', proposed: 'Étape suivante proposée', pending: 'Aucune action ni aucun message client exécuté.' },
};
export function ConversationAIHistory({ conversationId, locale, api }: { conversationId: string; locale: 'ar' | 'en' | 'fr'; api: Api }) {
  const applied = { ar: 'حُفظت إجابة Qualification بإجراء AI مصرح به. راجع القيم والتاريخ ضمن صلاحيات الحقول. لم تُرسل رسالة للعميل.', en: 'Qualification was saved by an authorized AI action. Review values and history within Field permissions. No customer message was sent.', fr: 'Qualification enregistrée par une action IA autorisée. Consultez les valeurs et l’historique selon les droits des champs. Aucun message client envoyé.' }[locale];
  const blocked = { ar: 'حُجب إجراء Qualification دون تغيير البيانات.', en: 'Qualification action was blocked without changing data.', fr: 'Action de qualification bloquée sans modifier les données.' }[locale];
  const t = labels[locale], [value, setValue] = useState<Result | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), sequence = useRef(0);
  useEffect(() => { sequence.current++; setValue(null); setError(''); setBusy(false); return () => { sequence.current++; }; }, [conversationId]);
  async function load(older = false) {
    const s = ++sequence.current, previous = older ? value : null;
    setBusy(true); setError(''); if (!older) setValue(null);
    try {
      const r = await api<Result>('/api/conversations/' + conversationId + '/ai-customer-executions' + (previous?.nextCursor ? '?cursor=' + encodeURIComponent(previous.nextCursor) : ''));
      if (sequence.current === s) setValue({ ...r, items: [...new Map([...(previous?.items ?? []), ...r.items].map(e => [e.id, e])).values()] });
    } catch (e) { if (sequence.current === s) { setValue(null); setError((e as Error).message); } }
    finally { if (sequence.current === s) setBusy(false); }
  }
  return <section className="panel" data-ai-customer-history><h4>{t.title}</h4><p>{t.note}</p><button disabled={busy} onClick={() => void load()}>{t.read}</button>
    {error && <p role="alert">{error}</p>}{value && !value.items.length && <p>{t.empty}</p>}
    {value?.items.map(e => <article key={e.id} data-ai-customer-execution><p><time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString(locale)}</time> · {e.state}</p>
      {e.errorCode && <p dir="ltr" style={{ overflowWrap: 'anywhere' }}>{e.errorCode}</p>}<p>{t.attempts}: {e.attemptCount}</p><p>{t.source}: <span dir="ltr" style={{ overflowWrap: 'anywhere' }}>{e.sourceMessageId}</span></p><p>{t.version}: {e.knowledgeVersion ?? t.unavailable}</p>
      {e.proposal && <div data-ai-customer-proposal><p>{t.proposed}: {e.proposal.decision}{e.proposal.handoffReason ? ' · ' + e.proposal.handoffReason : ''}</p>{e.proposal.answer && <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{e.proposal.answer}</p>}{!e.action && <p>{t.pending}</p>}</div>}
      {e.action && <div data-ai-customer-action><p>{e.action.state === 'APPLIED' ? applied : blocked}</p><p dir="ltr" style={{ overflowWrap: 'anywhere' }}>{e.action.tool} · {e.action.state} · {e.action.id}</p><time dateTime={e.action.createdAt}>{new Date(e.action.createdAt).toLocaleString(locale)}</time>{e.action.errorCode && <p>{e.action.errorCode}</p>}</div>}
      {e.stale && <p>{t.stale}</p>}</article>)}
    {value?.nextCursor && <button disabled={busy} onClick={() => void load(true)}>{t.more}</button>}
  </section>;
}
