import { useRef, useState } from 'react';
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Result = { items: { id: string; lead_id: string; contact_name: string; campaign_name: string; handoff_reason: string; created_at: string }[]; nextCursor: string | null };
const labels = {
  ar: { title: 'محادثات AI بانتظار موظف', read: 'مراجعة المحادثات المنتظرة', empty: 'لا توجد طلبات منتظرة ضمن صلاحياتك.', open: 'فتح Lead للمراجعة', more: 'طلبات أقدم' },
  en: { title: 'AI conversations awaiting a human', read: 'Review waiting conversations', empty: 'No waiting requests within your access.', open: 'Open Lead for review', more: 'Older requests' },
  fr: { title: 'Conversations IA en attente d’un humain', read: 'Consulter les conversations en attente', empty: 'Aucune demande en attente dans votre périmètre.', open: 'Ouvrir le Lead', more: 'Demandes précédentes' },
};
export function AIHumanHandoffQueue({ locale, api, onOpenLead }: { locale: 'ar' | 'en' | 'fr'; api: Api; onOpenLead: (id: string) => void }) {
  const t = labels[locale], [value, setValue] = useState<Result | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), sequence = useRef(0);
  async function load(older = false) {
    const s = ++sequence.current, previous = older ? value : null; setBusy(true); setError(''); if (!older) setValue(null);
    try {
      const r = await api<Result>('/api/ai/human-handoff-queue' + (previous?.nextCursor ? '?cursor=' + encodeURIComponent(previous.nextCursor) : ''));
      if (sequence.current === s) setValue({ ...r, items: [...new Map([...(previous?.items ?? []), ...r.items].map(e => [e.id, e])).values()] });
    } catch (e) { if (sequence.current === s) { setValue(null); setError((e as Error).message); } }
    finally { if (sequence.current === s) setBusy(false); }
  }
  return <section className="panel" data-ai-handoff-queue><h3>{t.title}</h3><button disabled={busy} onClick={() => void load()}>{t.read}</button>{error && <p role="alert">{error}</p>}
    {value && !value.items.length && <p>{t.empty}</p>}{value?.items.map(e => <article key={e.id}><p style={{ overflowWrap: 'anywhere' }}>{e.contact_name} · {e.campaign_name} · {e.handoff_reason}</p><time dateTime={e.created_at}>{new Date(e.created_at).toLocaleString(locale)}</time><button onClick={() => onOpenLead(e.lead_id)}>{t.open}</button></article>)}
    {value?.nextCursor && <button disabled={busy} onClick={() => void load(true)}>{t.more}</button>}
  </section>;
}
