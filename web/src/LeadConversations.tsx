import { useEffect, useRef, useState } from 'react';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Locale = 'ar'|'fr'|'en';
type Conversation = { id: string; sender_id: string; sender_name: string; participant_ref: string;
  controller_type: string; controller_name: string | null; state: string;
  needs_attention_reason: string | null; started_at: string };
type Consent = { status: 'GRANTED'|'REVOKED'|'UNKNOWN'; do_not_contact: boolean; evidence: string | null;
  source: string | null; updated_at: string | null; version: number; editable: boolean };
type Message = { id: string; direction: 'INBOUND'|'OUTBOUND'; author_type: string; body: string;
  message_kind: 'TEXT'|'TEMPLATE'; delivery_state: string; last_error_code: string | null; created_at: string };
type AvailableTemplate = { id: string; name: string; language: string; body: string };
const labels = {
  ar: { title: 'محادثات العميل', open: 'فتح محادثة WhatsApp', explain: 'فتح المحادثة يثبت رقم الإرسال ولا يرسل رسالة للعميل.',
    empty: 'لا توجد محادثات.', sender: 'الرقم المثبت', controller: 'المتحكم', state: 'الحالة', attention: 'تحتاج مراجعة', more: 'المزيد',
    consent: 'إذن التواصل عبر WhatsApp', dnc: 'عدم التواصل', source: 'مصدر الإذن', evidence: 'دليل/مرجع الإذن',
    save: 'حفظ الحالة', updated: 'آخر تحديث', shared: 'تعديل حالة Contact مشتركة متاح للمسؤول الأعلى فقط.',
    messages: 'الرسائل', showMessages: 'عرض الرسائل', send: 'وضع الرسالة في قائمة الإرسال', draft: 'نص الرسالة',
    queued: 'QUEUED تعني أن الرسالة محفوظة ولم يؤكد المزود إرسالها بعد.', noMessages: 'لا رسائل بعد.',
    customer: 'العميل', sendBlocked: 'يلزم متحكم بشري نشط ومحادثة بلا سبب مراجعة.',
    unknown: 'نتيجة الإرسال غير مؤكدة؛ راجع المزود قبل أي إعادة إرسال.',
    mode: 'نوع الرسالة', textMode: 'نص حر ضمن نافذة الرد', templateMode: 'قالب معتمد', template: 'القالب', noTemplates: 'لا قوالب معتمدة ومسموحة لهذه الحملة.', templateNote: 'يُفحص اعتماد القالب وسياسة الإرسال مرة أخرى قبل اتصال المزود.' },
  fr: { title: 'Conversations client', open: 'Ouvrir une conversation WhatsApp',
    explain: 'L’ouverture fixe le numéro d’envoi sans envoyer de message au client.', empty: 'Aucune conversation.',
    sender: 'Expéditeur fixé', controller: 'Contrôleur', state: 'État', attention: 'À examiner', more: 'Plus',
    consent: 'Consentement WhatsApp', dnc: 'Ne pas contacter', source: 'Source', evidence: 'Preuve/référence',
    save: 'Enregistrer', updated: 'Dernière mise à jour', shared: 'Seul le super administrateur peut modifier un contact partagé.',
    messages: 'Messages', showMessages: 'Voir les messages', send: 'Mettre en file d’envoi', draft: 'Texte du message',
    queued: 'QUEUED signifie que le message est enregistré ; l’envoi n’est pas confirmé.', noMessages: 'Aucun message.',
    customer: 'Client', sendBlocked: 'Un contrôleur humain actif et aucune alerte sont requis.',
    unknown: 'Résultat incertain ; vérifiez chez le fournisseur avant toute nouvelle tentative.',
    mode: 'Type de message', textMode: 'Texte libre dans la fenêtre de réponse', templateMode: 'Modèle approuvé', template: 'Modèle', noTemplates: 'Aucun modèle approuvé autorisé pour cette campagne.', templateNote: 'L’approbation et la politique sont revérifiées avant l’envoi.' },
  en: { title: 'Customer conversations', open: 'Open WhatsApp conversation',
    explain: 'Opening pins the sender and sends no customer message.', empty: 'No conversations.',
    sender: 'Pinned sender', controller: 'Controller', state: 'State', attention: 'Needs attention', more: 'More',
    consent: 'WhatsApp consent', dnc: 'Do not contact', source: 'Consent source', evidence: 'Evidence/reference',
    save: 'Save state', updated: 'Last updated', shared: 'Only the super admin can edit a shared contact.',
    messages: 'Messages', showMessages: 'View messages', send: 'Queue message', draft: 'Message text',
    queued: 'QUEUED means saved, not confirmed sent by the provider.', noMessages: 'No messages yet.',
    customer: 'Customer', sendBlocked: 'An active human controller and no attention flag are required.',
    unknown: 'Send outcome unknown; check with the provider before trying again.',
    mode: 'Message type', textMode: 'Freeform text in reply window', templateMode: 'Approved template', template: 'Template', noTemplates: 'No approved templates allowed for this campaign.', templateNote: 'Template approval and sending policy are checked again before contacting the provider.' },
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
  const selectedRef = useRef<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sendMode, setSendMode] = useState<'TEXT'|'TEMPLATE'>('TEXT');
  const [templates, setTemplates] = useState<AvailableTemplate[]>([]);
  const [templateAfter, setTemplateAfter] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState('');
  const [sendKey, setSendKey] = useState(() => crypto.randomUUID());
  const [submitted, setSubmitted] = useState(false);
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
    selectedRef.current = null; setSelectedId(null); setMessages([]); setMessageCursor(null);
    void load().catch((failure) => setError(String(failure)));
    void loadConsent().catch((failure) => setError(String(failure)));
  }, [leadId]);
  async function open() {
    setBusy(true); setError('');
    try { const result = await api<{ id: string }>(`/api/leads/${leadId}/conversations`, { method: 'POST' });
      await load(); await chooseConversation(result.id); }
    catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  async function loadMessages(id: string, next?: string) {
    const page = await api<{ items: Message[]; nextCursor: string | null }>(
      `/api/conversations/${id}/messages${next ? '?cursor=' + encodeURIComponent(next) : ''}`);
    if (selectedRef.current !== id) return;
    setMessages((current) => next ? [...current, ...page.items] : page.items);
    setMessageCursor(page.nextCursor);
  }
  async function chooseConversation(id: string) {
    selectedRef.current = id; setSelectedId(id); setMessages([]); setMessageCursor(null);
    setDraft(''); setSendMode('TEXT'); setTemplates([]); setTemplateAfter(null); setTemplateId('');
    setSendKey(crypto.randomUUID()); setSubmitted(false); setError('');
    await Promise.all([loadMessages(id), loadTemplates(id)]);
  }
  async function loadTemplates(id: string, next?: string) {
    const page = await api<{ items: AvailableTemplate[]; nextAfter: string | null }>(
      `/api/conversations/${id}/available-templates${next ? '?after=' + encodeURIComponent(next) : ''}`);
    if (selectedRef.current !== id) return;
    setTemplates((current) => next ? [...current, ...page.items] : page.items);
    setTemplateAfter(page.nextAfter);
  }
  async function sendMessage() {
    if (!selectedId || (sendMode === 'TEXT' ? !draft.trim() : !templateId)) return;
    setBusy(true); setError('');
    setSubmitted(true);
    try {
      await api(`/api/conversations/${selectedId}/messages`, { method: 'POST', body: JSON.stringify({
        ...(sendMode === 'TEXT' ? { body: draft } : { templateId }), idempotencyKey: sendKey,
      }) });
      setDraft(''); setTemplateId(''); setSendKey(crypto.randomUUID()); setSubmitted(false);
      await loadMessages(selectedId);
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  const selected = items.find((item) => item.id === selectedId);
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
    <div className="table-scroll"><table><thead><tr><th>{t.sender}</th><th>{t.controller}</th><th>{t.state}</th><th>{t.attention}</th><th></th></tr></thead>
      <tbody>{items.map((item) => <tr key={item.id}><td>{item.sender_name}</td>
        <td>{item.controller_type}{item.controller_name && ` · ${item.controller_name}`}</td>
        <td>{item.state}</td><td>{item.needs_attention_reason ?? '—'}</td><td><button className="link"
          onClick={() => void chooseConversation(item.id).catch((failure) => setError(String(failure)))}>{t.showMessages}</button></td></tr>)}</tbody></table></div>
    {cursor && <button className="secondary" onClick={() => void load(cursor).catch((failure) => setError(String(failure)))}>{t.more}</button>}
    {selectedId && <div className="panel"><h4>{t.messages}</h4>
      {!messages.length && <p>{t.noMessages}</p>}
      <ul>{messages.map((message) => <li key={message.id}>
        <strong>{message.direction === 'INBOUND' ? t.customer : message.author_type}</strong>
        {' · '}{message.message_kind}{' · '}{message.delivery_state}{message.last_error_code && ` · ${message.last_error_code}`}
        <p style={{ whiteSpace: 'pre-wrap' }}>{message.body}</p>
        {message.delivery_state === 'UNKNOWN' && <p role="alert">{t.unknown}</p>}
      </li>)}</ul>
      {messageCursor && <button className="secondary" disabled={busy}
        onClick={() => void loadMessages(selectedId, messageCursor).catch((failure) => setError(String(failure)))}>{t.more}</button>}
      <form className="workflow-form" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
        <label>{t.mode}<select value={sendMode} disabled={busy} onChange={(event) => {
          setSendMode(event.target.value as 'TEXT'|'TEMPLATE'); setSendKey(crypto.randomUUID()); setSubmitted(false);
        }}><option value="TEXT">{t.textMode}</option><option value="TEMPLATE">{t.templateMode}</option></select></label>
        {sendMode === 'TEXT' ? <label>{t.draft}<textarea required maxLength={20000} value={draft} disabled={busy}
          onChange={(event) => { setDraft(event.target.value);
            if (submitted) { setSendKey(crypto.randomUUID()); setSubmitted(false); } }} /></label>
          : <label>{t.template}<select required value={templateId} disabled={busy} onChange={(event) => {
            setTemplateId(event.target.value); setSendKey(crypto.randomUUID()); setSubmitted(false);
          }}><option value="">{t.template}</option>{templates.map((item) => <option key={item.id} value={item.id}>
            {item.name} · {item.language}</option>)}</select></label>}
        {sendMode === 'TEMPLATE' && <p>{templates.find((item) => item.id === templateId)?.body ?? t.noTemplates} {t.templateNote}</p>}
        {sendMode === 'TEMPLATE' && templateAfter && <button type="button" className="secondary" disabled={busy}
          onClick={() => selectedId && void loadTemplates(selectedId, templateAfter).catch((failure) => setError(String(failure)))}>{t.more}</button>}
        <button disabled={busy || (sendMode === 'TEXT' ? !draft.trim() : !templateId) || lifecycle !== 'OPEN' || selected?.state !== 'HUMAN_ACTIVE'
          || Boolean(selected.needs_attention_reason)}>{t.send}</button>
      </form><p>{t.queued} {t.sendBlocked}</p>
    </div>}
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
