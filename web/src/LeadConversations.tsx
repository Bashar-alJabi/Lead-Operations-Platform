import { useEffect, useState } from 'react';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Locale = 'ar'|'fr'|'en';
type Conversation = { id: string; sender_id: string; sender_name: string; participant_ref: string;
  controller_type: string; controller_name: string | null; state: string;
  needs_attention_reason: string | null; started_at: string };
const labels = {
  ar: { title: 'محادثات العميل', open: 'فتح محادثة WhatsApp', explain: 'فتح المحادثة يثبت رقم الإرسال ولا يرسل رسالة للعميل.',
    empty: 'لا توجد محادثات.', sender: 'الرقم المثبت', controller: 'المتحكم', state: 'الحالة', attention: 'تحتاج مراجعة', more: 'المزيد' },
  fr: { title: 'Conversations client', open: 'Ouvrir une conversation WhatsApp',
    explain: 'L’ouverture fixe le numéro d’envoi sans envoyer de message au client.', empty: 'Aucune conversation.',
    sender: 'Expéditeur fixé', controller: 'Contrôleur', state: 'État', attention: 'À examiner', more: 'Plus' },
  en: { title: 'Customer conversations', open: 'Open WhatsApp conversation',
    explain: 'Opening pins the sender and sends no customer message.', empty: 'No conversations.',
    sender: 'Pinned sender', controller: 'Controller', state: 'State', attention: 'Needs attention', more: 'More' },
} as const;

export function LeadConversations({ leadId, lifecycle, locale, api }: { leadId: string; lifecycle: string;
  locale: Locale; api: Api }) {
  const t = labels[locale];
  const [items, setItems] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function load(next?: string) {
    const page = await api<{ items: Conversation[]; nextCursor: string | null }>(
      `/api/leads/${leadId}/conversations${next ? '?cursor=' + encodeURIComponent(next) : ''}`);
    setItems((current) => next ? [...current, ...page.items] : page.items);
    setCursor(page.nextCursor);
  }
  useEffect(() => { void load().catch((failure) => setError(String(failure))); }, [leadId]);
  async function open() {
    setBusy(true); setError('');
    try { await api(`/api/leads/${leadId}/conversations`, { method: 'POST' }); await load(); }
    catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  return <section className="panel"><h3>{t.title}</h3><p>{t.explain}</p>
    {error && <p role="alert" className="error">{error}</p>}
    <button disabled={busy || lifecycle !== 'OPEN'} onClick={() => void open()}>{t.open}</button>
    {!items.length && <p>{t.empty}</p>}
    <div className="table-scroll"><table><thead><tr><th>{t.sender}</th><th>{t.controller}</th><th>{t.state}</th><th>{t.attention}</th></tr></thead>
      <tbody>{items.map((item) => <tr key={item.id}><td>{item.sender_name}</td>
        <td>{item.controller_type}{item.controller_name && ` · ${item.controller_name}`}</td>
        <td>{item.state}</td><td>{item.needs_attention_reason ?? '—'}</td></tr>)}</tbody></table></div>
    {cursor && <button className="secondary" onClick={() => void load(cursor).catch((failure) => setError(String(failure)))}>{t.more}</button>}
  </section>;
}
