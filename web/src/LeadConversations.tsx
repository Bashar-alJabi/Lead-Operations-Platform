import { useEffect, useRef, useState } from 'react';
import { MessageAttachment, type Attachment } from './MessageAttachment';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Locale = 'ar'|'fr'|'en';
type Conversation = { id: string; sender_id: string; sender_name: string; participant_ref: string;
  sender_capabilities: { media?: string[] };
  controller_type: string; controller_name: string | null; state: string; version: number;
  needs_attention_reason: string | null; started_at: string };
type Consent = { status: 'GRANTED'|'REVOKED'|'UNKNOWN'; do_not_contact: boolean; evidence: string | null;
  source: string | null; updated_at: string | null; version: number; editable: boolean };
type Message = { id: string; direction: 'INBOUND'|'OUTBOUND'; author_type: string; body: string;
  message_kind: 'TEXT'|'TEMPLATE'|'ATTACHMENT'; attachment: Attachment | null;
  delivery_state: string; last_error_code: string | null; created_at: string };
type AvailableTemplate = { id: string; name: string; language: string; body: string; parameterCount: number };
type AttentionReview = { id: string; previous_reason: string; review_note: string;
  reviewer_name: string; created_at: string };
const labels = {
  ar: { title: 'محادثات العميل', open: 'فتح محادثة WhatsApp', explain: 'فتح المحادثة يثبت رقم الإرسال ولا يرسل رسالة للعميل.',
    empty: 'لا توجد محادثات.', sender: 'الرقم المثبت', controller: 'المتحكم', state: 'الحالة', attention: 'تحتاج مراجعة', more: 'المزيد',
    consent: 'إذن التواصل عبر WhatsApp', dnc: 'عدم التواصل', source: 'مصدر الإذن', evidence: 'دليل/مرجع الإذن',
    save: 'حفظ الحالة', updated: 'آخر تحديث', shared: 'تعديل حالة Contact مشتركة متاح للمسؤول الأعلى فقط.',
    messages: 'الرسائل', showMessages: 'عرض الرسائل', send: 'وضع الرسالة في قائمة الإرسال', draft: 'نص الرسالة',
    queued: 'QUEUED تعني أن الرسالة محفوظة ولم يؤكد المزود إرسالها بعد.', noMessages: 'لا رسائل بعد.',
    customer: 'العميل', sendBlocked: 'يلزم متحكم بشري نشط ومحادثة بلا سبب مراجعة.',
    unknown: 'نتيجة الإرسال غير مؤكدة؛ راجع المزود قبل أي إعادة إرسال.',
    mode: 'نوع الرسالة', textMode: 'نص حر ضمن نافذة الرد', templateMode: 'قالب معتمد', template: 'القالب', noTemplates: 'لا قوالب معتمدة ومسموحة لهذه الحملة.', templateNote: 'يُفحص اعتماد القالب وسياسة الإرسال مرة أخرى قبل اتصال المزود.', takeover: 'تولّي المحادثة', takeoverReason: 'سبب التولّي' },
  fr: { title: 'Conversations client', open: 'Ouvrir une conversation WhatsApp',
    explain: 'L’ouverture fixe le numéro d’envoi sans envoyer de message au client.', empty: 'Aucune conversation.',
    sender: 'Expéditeur fixé', controller: 'Contrôleur', state: 'État', attention: 'À examiner', more: 'Plus',
    consent: 'Consentement WhatsApp', dnc: 'Ne pas contacter', source: 'Source', evidence: 'Preuve/référence',
    save: 'Enregistrer', updated: 'Dernière mise à jour', shared: 'Seul le super administrateur peut modifier un contact partagé.',
    messages: 'Messages', showMessages: 'Voir les messages', send: 'Mettre en file d’envoi', draft: 'Texte du message',
    queued: 'QUEUED signifie que le message est enregistré ; l’envoi n’est pas confirmé.', noMessages: 'Aucun message.',
    customer: 'Client', sendBlocked: 'Un contrôleur humain actif et aucune alerte sont requis.',
    unknown: 'Résultat incertain ; vérifiez chez le fournisseur avant toute nouvelle tentative.',
    mode: 'Type de message', textMode: 'Texte libre dans la fenêtre de réponse', templateMode: 'Modèle approuvé', template: 'Modèle', noTemplates: 'Aucun modèle approuvé autorisé pour cette campagne.', templateNote: 'L’approbation et la politique sont revérifiées avant l’envoi.', takeover: 'Prendre la conversation', takeoverReason: 'Motif de prise en charge' },
  en: { title: 'Customer conversations', open: 'Open WhatsApp conversation',
    explain: 'Opening pins the sender and sends no customer message.', empty: 'No conversations.',
    sender: 'Pinned sender', controller: 'Controller', state: 'State', attention: 'Needs attention', more: 'More',
    consent: 'WhatsApp consent', dnc: 'Do not contact', source: 'Consent source', evidence: 'Evidence/reference',
    save: 'Save state', updated: 'Last updated', shared: 'Only the super admin can edit a shared contact.',
    messages: 'Messages', showMessages: 'View messages', send: 'Queue message', draft: 'Message text',
    queued: 'QUEUED means saved, not confirmed sent by the provider.', noMessages: 'No messages yet.',
    customer: 'Customer', sendBlocked: 'An active human controller and no attention flag are required.',
    unknown: 'Send outcome unknown; check with the provider before trying again.',
    mode: 'Message type', textMode: 'Freeform text in reply window', templateMode: 'Approved template', template: 'Template', noTemplates: 'No approved templates allowed for this campaign.', templateNote: 'Template approval and sending policy are checked again before contacting the provider.', takeover: 'Take over conversation', takeoverReason: 'Takeover reason' },
} as const;

export function LeadConversations({ leadId, lifecycle, role, locale, api }: { leadId: string; lifecycle: string;
  role: 'SUPER_ADMIN'|'MANAGER'|'AGENT'; locale: Locale; api: Api }) {
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
  const [sendMode, setSendMode] = useState<'TEXT'|'TEMPLATE'|'ATTACHMENT'>('TEXT');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadKey, setUploadKey] = useState(() => crypto.randomUUID());
  const [uploadedAttachment, setUploadedAttachment] = useState<Attachment | null>(null);
  const [templates, setTemplates] = useState<AvailableTemplate[]>([]);
  const [templateAfter, setTemplateAfter] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState('');
  const [templateParameters, setTemplateParameters] = useState<string[]>([]);
  const [sendKey, setSendKey] = useState(() => crypto.randomUUID());
  const [submitted, setSubmitted] = useState(false);
  const [takeoverReason, setTakeoverReason] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [attentionReviews, setAttentionReviews] = useState<AttentionReview[]>([]);
  const [reviewBefore, setReviewBefore] = useState<string | null>(null);
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
    setUploadFile(null); setUploadedAttachment(null); setUploadKey(crypto.randomUUID());
    setAttentionReviews([]); setReviewBefore(null);
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
    setUploadFile(null); setUploadedAttachment(null); setUploadKey(crypto.randomUUID());
    setTemplateParameters([]);
    setAttentionReviews([]); setReviewBefore(null); setReviewNote(''); setReviewConfirmed(false);
    setSendKey(crypto.randomUUID()); setSubmitted(false); setError('');
    await Promise.all([loadMessages(id), loadTemplates(id),
      role === 'AGENT' ? Promise.resolve() : loadAttentionReviews(id)]);
  }
  async function loadAttentionReviews(id: string, before?: string) {
    const page = await api<{ items: AttentionReview[]; nextBefore: string | null }>(
      `/api/conversations/${id}/attention-reviews${before ? '?before=' + encodeURIComponent(before) : ''}`);
    if (selectedRef.current !== id) return;
    setAttentionReviews((current) => before ? [...current, ...page.items] : page.items);
    setReviewBefore(page.nextBefore);
  }
  async function loadTemplates(id: string, next?: string) {
    const page = await api<{ items: AvailableTemplate[]; nextAfter: string | null }>(
      `/api/conversations/${id}/available-templates${next ? '?after=' + encodeURIComponent(next) : ''}`);
    if (selectedRef.current !== id) return;
    setTemplates((current) => next ? [...current, ...page.items] : page.items);
    setTemplateAfter(page.nextAfter);
  }
  async function sendMessage() {
    if (!selectedId || (sendMode === 'TEXT' ? !draft.trim() : sendMode === 'ATTACHMENT' ? !uploadedAttachment
      : !templateId || templateParameters.some((value) => !value.trim()))) return;
    setBusy(true); setError('');
    setSubmitted(true);
    try {
      await api(`/api/conversations/${selectedId}/messages`, { method: 'POST', body: JSON.stringify({
        ...(sendMode === 'TEXT' ? { body: draft } : sendMode === 'ATTACHMENT'
          ? { attachmentId: uploadedAttachment!.id, body: draft } : { templateId,
          templateParameters }), idempotencyKey: sendKey,
      }) });
      setDraft(''); setTemplateId(''); setTemplateParameters([]); setSendKey(crypto.randomUUID()); setSubmitted(false);
      setUploadFile(null); setUploadedAttachment(null); setUploadKey(crypto.randomUUID());
      await loadMessages(selectedId);
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  async function uploadAttachment() {
    if (!selectedId || !uploadFile) return;
    const id = selectedId;
    setBusy(true); setError('');
    try {
      const mime = uploadFile.type;
      const kind = mime === 'application/pdf' ? 'document' : 'image';
      const query = new URLSearchParams({ kind, mime, key: uploadKey });
      const response = await fetch(`/api/conversations/${id}/attachments?${query}`, { method: 'POST',
        credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: uploadFile });
      const value = await response.json(); if (!response.ok) throw new Error(value.error ?? 'UPLOAD_FAILED');
      if (selectedRef.current === id) setUploadedAttachment(value as Attachment);
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  const selected = items.find((item) => item.id === selectedId);
  const reviewable = selected && ['SEND_OUTCOME_UNKNOWN','DELIVERY_FAILED','TEMPLATE_CHANGED']
    .includes(selected.needs_attention_reason ?? '') && role !== 'AGENT';
  async function acknowledgeAttention() {
    if (!selected || !reviewable || !reviewConfirmed || reviewNote.trim().length < 10) return;
    setBusy(true); setError('');
    try {
      await api(`/api/conversations/${selected.id}/attention/acknowledge`, { method: 'POST',
        body: JSON.stringify({ version: selected.version,
          expectedReason: selected.needs_attention_reason, reviewNote: reviewNote.trim(), reviewConfirmed: true }),
      });
      setReviewNote(''); setReviewConfirmed(false);
      await Promise.all([load(), loadAttentionReviews(selected.id)]);
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  async function takeover() {
    if (!selected || !takeoverReason.trim()) return;
    setBusy(true); setError('');
    try {
      await api(`/api/conversations/${selected.id}/takeover`, { method: 'POST', body: JSON.stringify({
        version: selected.version, reason: takeoverReason.trim(),
      }) });
      setTakeoverReason(''); await load();
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
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
    <div className="table-scroll"><table><thead><tr><th>{t.sender}</th><th>{t.controller}</th><th>{t.state}</th><th>{t.attention}</th><th></th></tr></thead>
      <tbody>{items.map((item) => <tr key={item.id}><td>{item.sender_name}</td>
        <td>{item.controller_type}{item.controller_name && ` · ${item.controller_name}`}</td>
        <td>{item.state}</td><td>{item.needs_attention_reason ?? '—'}</td><td><button className="link"
          onClick={() => void chooseConversation(item.id).catch((failure) => setError(String(failure)))}>{t.showMessages}</button></td></tr>)}</tbody></table></div>
    {cursor && <button className="secondary" onClick={() => void load(cursor).catch((failure) => setError(String(failure)))}>{t.more}</button>}
    {selectedId && <div className="panel"><h4>{t.messages}</h4>
      {reviewable && <div className="panel"><h5>{locale === 'ar' ? 'مراجعة سبب المنع' : locale === 'fr' ? 'Examen du blocage' : 'Review attention'}</h5>
        <p>{selected.needs_attention_reason} · {locale === 'ar' ? 'تحقق من حالة الرسالة لدى المزود قبل الإقرار. لا يعيد هذا الإجراء إرسالها ولا يغير سجل التسليم.' :
          locale === 'fr' ? 'Vérifiez le résultat chez le fournisseur. Cette action ne renvoie pas le message et ne change pas son historique.' :
            'Check the provider outcome first. This action neither resends the message nor changes its delivery record.'}</p>
        <label>{locale === 'ar' ? 'ملاحظة المراجعة' : locale === 'fr' ? 'Note de vérification' : 'Review note'}
          <textarea value={reviewNote} minLength={10} maxLength={2000} disabled={busy}
            onChange={(event) => setReviewNote(event.target.value)} /></label>
        <label className="check-row"><input type="checkbox" checked={reviewConfirmed} disabled={busy}
          onChange={(event) => setReviewConfirmed(event.target.checked)} />
          {locale === 'ar' ? 'راجعت النتيجة وأقر بإزالة سبب المنع' : locale === 'fr' ? 'J’ai vérifié le résultat' : 'I reviewed the outcome'}</label>
        <button disabled={busy || !reviewConfirmed || reviewNote.trim().length < 10}
          onClick={() => void acknowledgeAttention()}>{locale === 'ar' ? 'حفظ المراجعة' : locale === 'fr' ? 'Enregistrer' : 'Record review'}</button>
      </div>}
      {role !== 'AGENT' && attentionReviews.length > 0 && <div className="panel"><h5>{locale === 'ar' ? 'سجل المراجعات' : locale === 'fr' ? 'Historique des examens' : 'Review history'}</h5>
        <ul>{attentionReviews.map((review) => <li key={review.id}>{review.previous_reason} · {review.reviewer_name} · {new Date(review.created_at).toLocaleString(locale)}
          <p>{review.review_note}</p></li>)}</ul>
        {reviewBefore && <button className="secondary" disabled={busy}
          onClick={() => void loadAttentionReviews(selectedId, reviewBefore).catch((failure) => setError(String(failure)))}>{t.more}</button>}
      </div>}
      {selected?.state !== 'CLOSED' && <div className="actions"><label>{t.takeoverReason}
        <input value={takeoverReason} minLength={3} maxLength={500} onChange={(event) => setTakeoverReason(event.target.value)} />
      </label><button className="secondary" disabled={busy || takeoverReason.trim().length < 3}
        onClick={() => void takeover()}>{t.takeover}</button></div>}
      {!messages.length && <p>{t.noMessages}</p>}
      <ul>{messages.map((message) => <li key={message.id}>
        <strong>{message.direction === 'INBOUND' ? t.customer : message.author_type}</strong>
        {' · '}{message.message_kind}{' · '}{message.delivery_state}{message.last_error_code && ` · ${message.last_error_code}`}
        <p style={{ whiteSpace: 'pre-wrap' }}>{message.body}</p>
        {message.attachment && <MessageAttachment key={`${message.attachment.id}:${message.attachment.version}`}
          attachment={message.attachment} locale={locale} canRetry={role !== 'AGENT'} api={api} />}
        {message.delivery_state === 'UNKNOWN' && <p role="alert">{t.unknown}</p>}
      </li>)}</ul>
      {messageCursor && <button className="secondary" disabled={busy}
        onClick={() => void loadMessages(selectedId, messageCursor).catch((failure) => setError(String(failure)))}>{t.more}</button>}
      <form className="workflow-form" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
        <label>{t.mode}<select value={sendMode} disabled={busy} onChange={(event) => {
          setSendMode(event.target.value as 'TEXT'|'TEMPLATE'|'ATTACHMENT'); setDraft(''); setSendKey(crypto.randomUUID()); setSubmitted(false);
        }}><option value="TEXT">{t.textMode}</option><option value="TEMPLATE">{t.templateMode}</option>
          {selected?.sender_capabilities?.media?.length ? <option value="ATTACHMENT">{locale === 'ar' ? 'صورة أو PDF ضمن نافذة الرد' : locale === 'fr' ? 'Image ou PDF' : 'Image or PDF in reply window'}</option> : null}</select></label>
        {sendMode === 'TEXT' ? <label>{t.draft}<textarea required maxLength={20000} value={draft} disabled={busy}
          onChange={(event) => { setDraft(event.target.value);
            if (submitted) { setSendKey(crypto.randomUUID()); setSubmitted(false); } }} /></label>
          : sendMode === 'TEMPLATE' ? <label>{t.template}<select required value={templateId} disabled={busy} onChange={(event) => {
            setTemplateId(event.target.value);
            setTemplateParameters(Array(templates.find((item) => item.id === event.target.value)?.parameterCount ?? 0).fill(''));
            setSendKey(crypto.randomUUID()); setSubmitted(false);
          }}><option value="">{t.template}</option>{templates.map((item) => <option key={item.id} value={item.id}>
            {item.name} · {item.language}</option>)}</select></label>
          : <><label>{locale === 'ar' ? 'الملف (JPEG/PNG/PDF)' : locale === 'fr' ? 'Fichier (JPEG/PNG/PDF)' : 'File (JPEG/PNG/PDF)'}
            <input type="file" accept="image/jpeg,image/png,application/pdf" disabled={busy} onChange={(event) => {
              setUploadFile(event.target.files?.[0] ?? null); setUploadedAttachment(null); setUploadKey(crypto.randomUUID());
              setSendKey(crypto.randomUUID()); setSubmitted(false);
            }} /></label><button type="button" className="secondary" disabled={busy || !uploadFile || Boolean(uploadedAttachment)}
              onClick={() => void uploadAttachment()}>{locale === 'ar' ? 'رفع وفحص الملف' : locale === 'fr' ? 'Charger et analyser' : 'Upload and scan'}</button>
            {uploadedAttachment && <MessageAttachment key={uploadedAttachment.id} attachment={uploadedAttachment} locale={locale} api={api} />}
            <label>{locale === 'ar' ? 'تعليق اختياري' : locale === 'fr' ? 'Légende facultative' : 'Optional caption'}
              <textarea value={draft} maxLength={1024} disabled={busy} onChange={(event) => { setDraft(event.target.value);
                if (submitted) { setSendKey(crypto.randomUUID()); setSubmitted(false); } }} /></label></>}
        {sendMode === 'TEMPLATE' && <p>{templates.find((item) => item.id === templateId)?.body ?? t.noTemplates} {t.templateNote}</p>}
        {sendMode === 'TEMPLATE' && templateParameters.map((value, index) =>
          <label key={`${templateId}-${index}`}>{locale === 'ar' ? 'قيمة المتغير' : locale === 'fr' ? 'Valeur du paramètre' : 'Parameter'} {index + 1}
            <input required maxLength={512} value={value} disabled={busy} onChange={(event) => {
              setTemplateParameters((current) => current.map((item, position) => position === index ? event.target.value : item));
              if (submitted) { setSendKey(crypto.randomUUID()); setSubmitted(false); }
            }} /></label>)}
        {sendMode === 'TEMPLATE' && templateAfter && <button type="button" className="secondary" disabled={busy}
          onClick={() => selectedId && void loadTemplates(selectedId, templateAfter).catch((failure) => setError(String(failure)))}>{t.more}</button>}
        <button disabled={busy || (sendMode === 'TEXT' ? !draft.trim() : sendMode === 'ATTACHMENT' ? !uploadedAttachment
          : !templateId || templateParameters.some((value) => !value.trim())) || lifecycle !== 'OPEN' || selected?.state !== 'HUMAN_ACTIVE'
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
