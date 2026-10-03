import { useEffect, useState } from 'react';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Locale = 'ar'|'fr'|'en';
type Conversation = { id: string; sender_id: string; sender_name: string; participant_ref: string;
  controller_type: string; controller_name: string | null; state: string;
  needs_attention_reason: string | null; started_at: string };
type Consent = { status: 'GRANTED'|'REVOKED'|'UNKNOWN'; do_not_contact: boolean; evidence: string | null;
  source: string | null; updated_at: string | null; version: number; editable: boolean };
const labels = {
  ar: { title: 'محادثات العميل', open: 'فتح محادثة WhatsApp', explain: 'فتح المحادثة يثبت رقم الإرسال ولا يرسل رسالة للعميل.',
    empty: 'لا توجد محادثات.', sender: 'الرقم المثبت', controller: 'المتحكم', state: 'الحالة', attention: 'تحتاج مراجعة', more: 'المزيد',
    consent: 'إذن التواصل عبر WhatsApp', dnc: 'عدم التواصل', source: 'مصدر الإذن', evidence: 'دليل/مرجع الإذن',
    save: 'حفظ الحالة', updated: 'آخر تحديث', shared: 'تعديل حالة Contact مشتركة متاح للمسؤول الأعلى فقط.' },
  fr: { title: 'Conversations client', open: 'Ouvrir une conversation WhatsApp',
    explain: 'L’ouverture fixe le numéro d’envoi sans envoyer de message au client.', empty: 'Aucune conversation.',
    sender: 'Expéditeur fixé', controller: 'Contrôleur', state: 'État', attention: 'À examiner', more: 'Plus',
    consent: 'Consentement WhatsApp', dnc: 'Ne pas contacter', source: 'Source', evidence: 'Preuve/référence',
    save: 'Enregistrer', updated: 'Dernière mise à jour', shared: 'Seul le super administrateur peut modifier un contact partagé.' },
  en: { title: 'Customer conversations', open: 'Open WhatsApp conversation',
    explain: 'Opening pins the sender and sends no customer message.', empty: 'No conversations.',
    sender: 'Pinned sender', controller: 'Controller', state: 'State', attention: 'Needs attention', more: 'More',
    consent: 'WhatsApp consent', dnc: 'Do not contact', source: 'Consent source', evidence: 'Evidence/reference',
    save: 'Save state', updated: 'Last updated', shared: 'Only the super admin can edit a shared contact.' },
} as const;

export function LeadConversations({ leadId, lifecycle, locale, api }: { leadId: string; lifecycle: string;
  locale: Locale; api: Api }) {
  const t = labels[locale];
  const [items, setItems] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState<Consent | null>(null);
  const [status, setStatus] = useState<Consent['status']>('UNKNOWN');
  const [doNotContact, setDoNotContact] = useState(false);
  const [source, setSource] = useState('');
  const [evidence, setEvidence] = useState('');
  async function load(next?: string) {
    const page = await api<{ items: Conversation[]; nextCursor: string | null }>(
      `/api/leads/${leadId}/conversations${next ? '?cursor=' + encodeURIComponent(next) : ''}`);
    setItems((current) => next ? [...current, ...page.items] : page.items);
    setCursor(page.nextCursor);
  }
  async function loadConsent() {
    const current = await api<Consent>(`/api/leads/${leadId}/messaging-consent`);
    setConsent(current); setStatus(current.status); setDoNotContact(current.do_not_contact);
    setSource(current.source ?? ''); setEvidence(current.evidence ?? '');
  }
  useEffect(() => {
    setItems([]); setConsent(null); setCursor(null); setError('');
    void load().catch((failure) => setError(String(failure)));
    void loadConsent().catch((failure) => setError(String(failure)));
  }, [leadId]);
  async function open() {
    setBusy(true); setError('');
    try { await api(`/api/leads/${leadId}/conversations`, { method: 'POST' }); await load(); }
    catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  async function saveConsent() {
    if (!consent) return;
    setBusy(true); setError('');
    try {
      await api(`/api/leads/${leadId}/messaging-consent`, { method: 'PUT', body: JSON.stringify({
        version: consent.version, status, doNotContact, source, evidence: evidence || null,
      }) });
      await loadConsent();
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
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
    {consent && <div className="panel"><h4>{t.consent}</h4>
      <p>{consent.status} · {t.dnc}: {consent.do_not_contact ? '✓' : '—'} · {t.updated}: {consent.updated_at ?? '—'}</p>
      {consent.editable ? <form className="workflow-form" onSubmit={(event) => { event.preventDefault(); void saveConsent(); }}>
        <label>{t.consent}<select value={status} onChange={(event) => setStatus(event.target.value as Consent['status'])}>
          <option value="UNKNOWN">UNKNOWN</option><option value="GRANTED">GRANTED</option><option value="REVOKED">REVOKED</option></select></label>
        <label className="check-row"><input type="checkbox" checked={doNotContact}
          onChange={(event) => setDoNotContact(event.target.checked)} />{t.dnc}</label>
        <label>{t.source}<input required minLength={3} maxLength={100} value={source}
          onChange={(event) => setSource(event.target.value)} /></label>
        <label>{t.evidence}<input required={status === 'GRANTED'} maxLength={2000} value={evidence}
          onChange={(event) => setEvidence(event.target.value)} /></label>
        <button disabled={busy}>{t.save}</button>
      </form> : <p>{t.shared}</p>}
    </div>}
  </section>;
}
