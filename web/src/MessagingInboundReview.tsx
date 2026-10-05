import { useEffect, useState } from 'react';
import { MessageAttachment, type Attachment } from './MessageAttachment';
import { MessageSourceReference, type SourceReference } from './MessageSourceReference';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Row = { id: string; sender_id: string | null; failure_code: string | null;
  participant_last4: string; received_at: string };
type Detail = { event: { id: string; state: string; failureCode: string | null;
  participantLast4: string; messageType: string | null; body: string | null; attachment: Attachment | null; receivedAt: string;
  sourceReference:SourceReference|null;sourceReferenceInvalid:boolean };
  leads: { id: string; branchName: string; campaignName: string; contactName: string }[];
  conversations: { id: string; leadId: string; state: string;contactName:string|null;campaignName:string;branchName:string }[] };
const labels = {
  ar: { title: 'مراجعة الرسائل الواردة', guide: 'الرسالة التي لا يمكن ربطها يقيناً تبقى محفوظة هنا. اختر Lead أو Conversation صراحة بعد التحقق من العميل والحملة؛ لا يرسل هذا الإجراء رداً تلقائياً.',
    none: 'لا رسائل تحتاج مراجعة', more: 'المزيد', detail: 'تفاصيل', close: 'إغلاق',
    target: 'الربط مع', choose: 'اختر الهدف', conversation: 'محادثة', lead: 'Lead',contact:'جهة الاتصال',campaign:'الحملة',branch:'الفرع',
    resolve: 'حسم الربط', reason: 'سبب التجاهل', ignore: 'تجاهل مع حفظ الحدث', refresh: 'تحديث',
    unsupported: 'هذا النوع غير مدعوم للإلحاق التلقائي حالياً.', },
  fr: { title: 'Révision des messages entrants', guide: 'Les messages sans correspondance certaine restent ici. Choisissez explicitement un lead ou une conversation après vérification ; aucune réponse automatique n’est envoyée.',
    none: 'Aucun message à revoir', more: 'Plus', detail: 'Détails', close: 'Fermer',
    target: 'Associer à', choose: 'Choisir', conversation: 'Conversation', lead: 'Lead',contact:'Contact',campaign:'Campagne',branch:'Agence',
    resolve: 'Résoudre', reason: 'Motif d’ignorance', ignore: 'Ignorer en conservant l’événement', refresh: 'Actualiser',
    unsupported: 'Ce type ne peut pas encore être joint automatiquement.', },
  en: { title: 'Inbound review', guide: 'Messages without a certain match remain here. Explicitly choose a lead or conversation after checking the customer and campaign; this action sends no automatic reply.',
    none: 'No messages need review', more: 'More', detail: 'Details', close: 'Close',
    target: 'Attach to', choose: 'Choose a target', conversation: 'Conversation', lead: 'Lead',contact:'Contact',campaign:'Campaign',branch:'Branch',
    resolve: 'Resolve', reason: 'Reason to ignore', ignore: 'Ignore and retain event', refresh: 'Refresh',
    unsupported: 'This message type cannot yet be attached automatically.', },
} as const;

export function MessagingInboundReview({ connectionId, locale, api }: {
  connectionId: string; locale: 'ar'|'fr'|'en'; api: Api;
}) {
  const t = labels[locale];
  const [items, setItems] = useState<Row[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [targetKind,targetId]=target.split(':');
  const selectedTarget=targetKind==='lead' ? detail?.leads.find((lead)=>lead.id===targetId)
    : detail?.conversations.find((cv)=>cv.id===targetId);
  async function load(next?: string) {
    const page = await api<{ items: Row[]; nextBefore: string | null }>(
      `/api/messaging/connections/${connectionId}/inbound-review${next ? '?before=' + encodeURIComponent(next) : ''}`);
    setItems((old) => next ? [...old, ...page.items] : page.items); setBefore(page.nextBefore);
  }
  async function open(id: string) {
    const value = await api<Detail>(`/api/messaging/connections/${connectionId}/inbound-review/${id}`);
    setDetail(value); setTarget(''); setReason(''); setError('');
  }
  useEffect(() => { setItems([]); setDetail(null); setBefore(null); setError('');
    void load().catch((failure) => setError(String(failure))); }, [connectionId]);
  async function resolve() {
    if (!detail || !target) return;
    setBusy(true); setError('');
    try {
      const [kind, id] = target.split(':');
      await api(`/api/messaging/connections/${connectionId}/inbound-review/${detail.event.id}/resolve`, {
        method: 'POST', body: JSON.stringify(kind === 'conversation' ? { conversationId: id } : { leadId: id }),
      });
      setDetail(null); await load();
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }
  async function ignore() {
    if (!detail || !reason.trim()) return;
    setBusy(true); setError('');
    try {
      await api(`/api/messaging/connections/${connectionId}/inbound-review/${detail.event.id}/ignore`, {
        method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
      });
      setDetail(null); await load();
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  return <section className="panel inbound-review"><h4>{t.title}</h4><p>{t.guide}</p>
    {error && <p role="alert" className="error">{error}</p>}
    <button className="secondary" onClick={() => void load().catch((failure) => setError(String(failure)))}>{t.refresh}</button>
    {!items.length && <p>{t.none}</p>}
    {items.length > 0 && <ul>{items.map((item) => <li key={item.id}>
      {new Date(item.received_at).toLocaleString(locale)} · …{item.participant_last4}
      {item.failure_code && ` · ${item.failure_code}`}
      <button className="link" onClick={() => void open(item.id).catch((failure) => setError(String(failure)))}>{t.detail}</button>
    </li>)}</ul>}
    {before && <button className="secondary" onClick={() => void load(before).catch((failure) => setError(String(failure)))}>{t.more}</button>}
    {detail && <div className="panel"><h4>{t.detail} · …{detail.event.participantLast4}</h4>
      <p>{detail.event.failureCode} · {detail.event.messageType}</p>
      {detail.event.body && <p className="message-body">{detail.event.body}</p>}
      <MessageSourceReference reference={detail.event.sourceReference} invalid={detail.event.sourceReferenceInvalid} locale={locale} />
      {detail.event.attachment && <MessageAttachment key={`${detail.event.attachment.id}:${detail.event.attachment.version}`}
        attachment={detail.event.attachment} locale={locale} canRetry api={api} />}
      {!detail.event.body && !detail.event.attachment && <p>{t.unsupported}</p>}
      <label>{t.target}<select aria-label={t.target} value={target} onChange={(event) => setTarget(event.target.value)}>
        <option value="">{t.choose}</option>
        {detail.conversations.map((cv) => <option key={cv.id} value={`conversation:${cv.id}`}>
          {t.conversation} · {cv.contactName} · {cv.campaignName} · {cv.id} · {cv.state}</option>)}
        {detail.leads.map((lead) => <option key={lead.id} value={`lead:${lead.id}`}>
          {t.lead} · {lead.contactName} · {lead.campaignName} · {lead.branchName}</option>)}
      </select></label>
      {selectedTarget && <dl className="inbound-target-summary">
        <div><dt>{t.contact}</dt><dd>{selectedTarget.contactName || '—'}</dd></div>
        <div><dt>{t.campaign}</dt><dd>{selectedTarget.campaignName}</dd></div>
        <div><dt>{t.branch}</dt><dd>{selectedTarget.branchName}</dd></div>
        <div><dt>{targetKind==='lead' ? t.lead : t.conversation}</dt><dd><bdi>{targetId}</bdi></dd></div>
      </dl>}
      <div className="actions"><button disabled={busy || !target || detail.event.sourceReferenceInvalid || (!detail.event.body && !detail.event.attachment)} onClick={() => void resolve()}>{t.resolve}</button>
        <button className="secondary" onClick={() => setDetail(null)}>{t.close}</button></div>
      <label>{t.reason}<input value={reason} minLength={3} maxLength={500}
        onChange={(event) => setReason(event.target.value)} /></label>
      <button className="secondary" disabled={busy || reason.trim().length < 3}
        onClick={() => void ignore()}>{t.ignore}</button>
    </div>}
  </section>;
}
