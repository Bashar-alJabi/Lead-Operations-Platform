import { useEffect, useState } from 'react';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Sender = { id: string; display_name: string; active: boolean; operator_enabled: boolean };
type Template = { id: string; name: string; language: string; status: string; active: boolean;
  components: unknown };
type Attempt = { id: string; sender_id: string; template_id: string; recipient_last4: string;
  state: string; error_code: string | null; provider_message_id: string | null; created_at: string };
const labels = {
  ar: { title: 'اختبار الإرسال', note: 'استخدم رقم اختبار تتحكم به ومسموح بمراسلته. قبول المزود يثبت مسار الإرسال لهذا الرقم فقط؛ التسليم والـWebhook لم يُتحققا بعد.',
    sender: 'رقم الإرسال', template: 'قالب معتمد', recipient: 'رقم المستلم بصيغة + الدولية',
    confirm: 'أؤكد أنني أتحكم برقم الاختبار أو لدي موافقة صريحة لمراسلته.', send: 'أرسل اختباراً',
    history: 'محاولات الاختبار', none: 'لا توجد محاولات', more: 'المزيد', accepted: 'قبل المزود الطلب؛ التسليم غير مؤكد.',
    ambiguous: 'نتيجة غير معروفة. افحص Meta قبل أي إرسال جديد لتجنب التكرار.', rejected: 'رفض المزود الطلب.',
    noTemplate: 'أنشئ قالب BODY ثابتاً واعتمده وزامنه أولاً.', refresh: 'تحديث القوالب', },
  fr: { title: 'Envoi de test', note: 'Utilisez un numéro de test contrôlé et autorisé. L’acceptation vérifie seulement l’envoi depuis ce numéro ; livraison et webhook restent à vérifier.',
    sender: 'Expéditeur', template: 'Modèle approuvé', recipient: 'Numéro destinataire au format + international',
    confirm: 'Je contrôle le numéro de test ou j’ai son consentement explicite.', send: 'Envoyer le test',
    history: 'Tentatives', none: 'Aucune tentative', more: 'Plus', accepted: 'Demande acceptée par le fournisseur ; livraison non confirmée.',
    ambiguous: 'Résultat inconnu. Vérifiez Meta avant un autre envoi pour éviter un doublon.', rejected: 'Demande refusée par le fournisseur.',
    noTemplate: 'Créez, faites approuver et synchronisez un modèle BODY statique.', refresh: 'Actualiser les modèles', },
  en: { title: 'Test send', note: 'Use a controlled, consented test number. Provider acceptance verifies outbound from this sender only; delivery and webhook remain unverified.',
    sender: 'Sender', template: 'Approved template', recipient: 'Recipient in international + format',
    confirm: 'I control the test number or have explicit consent to message it.', send: 'Send test',
    history: 'Test attempts', none: 'No attempts', more: 'More', accepted: 'Provider accepted the request; delivery is unconfirmed.',
    ambiguous: 'Outcome unknown. Check Meta before another send to avoid a duplicate.', rejected: 'Provider rejected the request.',
    noTemplate: 'Create, approve, and sync a static BODY template first.', refresh: 'Refresh templates', },
} as const;

function usable(template: Template): boolean {
  const parts = template.components;
  return template.active && template.status === 'APPROVED' && Array.isArray(parts) && parts.length === 1
    && parts[0]?.type === 'BODY' && typeof parts[0]?.text === 'string'
    && Boolean(parts[0].text.trim()) && !/\{\{|\}\}/.test(parts[0].text);
}

export function MessagingTestSend({ connectionId, status, senders, locale, api, onChanged }: {
  connectionId: string; status: string; senders: Sender[]; locale: 'ar'|'fr'|'en'; api: Api;
  onChanged: () => Promise<void>;
}) {
  const t = labels[locale];
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateAfter, setTemplateAfter] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [attemptBefore, setAttemptBefore] = useState<string | null>(null);
  const [senderId, setSenderId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [recipient, setRecipient] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  async function loadTemplates(after?: string) {
    const page = await api<{ items: Template[]; nextAfter: string | null }>(
      `/api/messaging/connections/${connectionId}/templates${after ? '?after=' + encodeURIComponent(after) : ''}`);
    setTemplates((old) => after ? [...old, ...page.items] : page.items); setTemplateAfter(page.nextAfter);
  }
  async function loadAttempts(before?: string) {
    const page = await api<{ items: Attempt[]; nextBefore: string | null }>(
      `/api/messaging/connections/${connectionId}/test-sends${before ? '?before=' + encodeURIComponent(before) : ''}`);
    setAttempts((old) => before ? [...old, ...page.items] : page.items); setAttemptBefore(page.nextBefore);
  }
  useEffect(() => {
    setTemplates([]); setAttempts([]); setSenderId(''); setTemplateId(''); setRecipient('');
    setConfirmed(false); setKey(crypto.randomUUID()); setError(''); setResult('');
    void Promise.all([loadTemplates(), loadAttempts()]).catch((failure) => setError(String(failure)));
  }, [connectionId]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setResult('');
    try {
      const response = await api<{ state: string; errorCode: string | null }>(
        `/api/messaging/connections/${connectionId}/test-send`, { method: 'POST', body: JSON.stringify({
          senderId, templateId, recipient, recipientConfirmed: confirmed, idempotencyKey: key,
        }) });
      setResult(response.state === 'SUCCEEDED' ? t.accepted : response.state === 'UNKNOWN' ? t.ambiguous : t.rejected);
      if (response.state !== 'UNKNOWN') { setKey(crypto.randomUUID()); setConfirmed(false); }
      await Promise.all([loadAttempts(), onChanged()]);
    } catch (failure) { setError(String(failure)); await loadAttempts().catch(() => undefined); }
    finally { setBusy(false); }
  }
  const validTemplates = templates.filter(usable);
  return <section className="panel"><h4>{t.title}</h4><p>{t.note}</p>
    {error && <p role="alert" className="error">{error}</p>}{result && <p role="status">{result}</p>}
    <form className="workflow-form" onSubmit={(event) => void submit(event)}>
      <label>{t.sender}<select required value={senderId} onChange={(event) => { setSenderId(event.target.value); setKey(crypto.randomUUID()); }}>
        <option value="">—</option>{senders.filter((sender) => sender.active && sender.operator_enabled).map((sender) =>
          <option key={sender.id} value={sender.id}>{sender.display_name}</option>)}</select></label>
      <label>{t.template}<select required value={templateId} onChange={(event) => { setTemplateId(event.target.value); setKey(crypto.randomUUID()); }}>
        <option value="">—</option>{validTemplates.map((template) =>
          <option key={template.id} value={template.id}>{template.name} · {template.language}</option>)}</select></label>
      {!validTemplates.length && <p>{t.noTemplate}</p>}
      <button type="button" className="secondary" onClick={() => void loadTemplates().catch((failure) => setError(String(failure)))}>{t.refresh}</button>
      {templateAfter && <button type="button" className="secondary" onClick={() => void loadTemplates(templateAfter).catch((failure) => setError(String(failure)))}>{t.more}</button>}
      <label>{t.recipient}<input required type="tel" pattern="[+][1-9][0-9]{7,14}" value={recipient}
        onChange={(event) => { setRecipient(event.target.value); setKey(crypto.randomUUID()); }} placeholder="+15551234567" /></label>
      <label className="check-row"><input type="checkbox" checked={confirmed}
        onChange={(event) => setConfirmed(event.target.checked)} />{t.confirm}</label>
      <button disabled={busy || !confirmed || !senderId || !templateId || !['WARNING','CONNECTED'].includes(status)}>{t.send}</button>
    </form>
    <h4>{t.history}</h4>{!attempts.length && <p>{t.none}</p>}
    {attempts.length > 0 && <ul>{attempts.map((attempt) => <li key={attempt.id}>
      {new Date(attempt.created_at).toLocaleString(locale)} · …{attempt.recipient_last4} · {attempt.state}
      {attempt.error_code && ` · ${attempt.error_code}`}
    </li>)}</ul>}
    {attemptBefore && <button className="secondary" onClick={() => void loadAttempts(attemptBefore).catch((failure) => setError(String(failure)))}>{t.more}</button>}
  </section>;
}
