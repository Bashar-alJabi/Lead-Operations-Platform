import { useEffect, useRef, useState } from 'react';
import { MessagingEventProcessing, type ProcessingEvent } from './MessagingEventProcessing';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Info = { callbackPath: string; handshakeVerified: boolean; signedCallbackVerified: boolean;
  needsAttention: number; pending: number; failed: number; oldestPendingAt: string | null; lastProcessedAt: string | null };
type Event = ProcessingEvent & { event_kind: string;
  participant_last4: string; received_at: string };
const labels = {
  ar: { title: 'Webhook للرسائل', guide: 'في إعداد Meta App → Webhooks، استخدم Callback URL أدناه ورمز Verify Token الذي حفظته عند إنشاء الاتصال، ثم اشترك في حقل messages لـWhatsApp Business Account. لا تُعرض قيمة الرمز بعد حفظها؛ يمكن استبدالها من تعديل الاتصال. يجب وصول حدث موقّع قبل اعتبار الاستقبال متحققاً.',
    handshake: 'تحقق عنوان Callback', signed: 'حدث موقّع مستلم', yes: 'نعم', no: 'لم يتحقق',
    events: 'أحداث الرسائل', attention: 'تحتاج مراجعة', refresh: 'تحديث', more: 'المزيد', empty: 'لا أحداث بعد', },
  fr: { title: 'Webhook de messagerie', guide: 'Dans Meta App → Webhooks, utilisez cette URL et le Verify Token enregistré lors de la création de la connexion, puis abonnez le compte WhatsApp Business au champ messages. Le jeton n’est pas réaffiché ; modifiez la connexion pour le remplacer. Un événement signé doit arriver pour vérifier la réception.',
    handshake: 'URL vérifiée', signed: 'Événement signé reçu', yes: 'Oui', no: 'Non vérifié',
    events: 'Événements', attention: 'À examiner', refresh: 'Actualiser', more: 'Plus', empty: 'Aucun événement', },
  en: { title: 'Messaging webhook', guide: 'In Meta App → Webhooks, use this callback URL and the Verify Token saved when creating the connection, then subscribe the WhatsApp Business Account to the messages field. The token is never redisplayed; edit the connection to replace it. A signed event must arrive before inbound verification is confirmed.',
    handshake: 'Callback URL verified', signed: 'Signed event received', yes: 'Yes', no: 'Not verified',
    events: 'Message events', attention: 'Needs attention', refresh: 'Refresh', more: 'More', empty: 'No events yet', },
} as const;

export function MessagingWebhookSetup({ connectionId, locale, api }: {
  connectionId: string; locale: 'ar'|'fr'|'en'; api: Api;
}) {
  const t = labels[locale];
  const [info, setInfo] = useState<Info | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState(''); const loadVersion = useRef(0);
  async function load(next?: string, currentFilter = filter) {
    const version = ++loadVersion.current;
    const query = new URLSearchParams(); if (next) query.set('before',next); if (currentFilter) query.set('state',currentFilter);
    const [current, page] = await Promise.all([
      api<Info>(`/api/messaging/connections/${connectionId}/webhook`),
      api<{ items: Event[]; nextBefore: string | null }>(
        `/api/messaging/connections/${connectionId}/events?${query}`),
    ]);
    if (version !== loadVersion.current) return;
    setInfo(current); setEvents((old) => next ? [...old, ...page.items] : page.items); setBefore(page.nextBefore);
  }
  useEffect(() => { setInfo(null); setEvents([]); setError(''); setFilter('');
    void load(undefined,'').catch((failure) => setError(String(failure)));
    return () => { loadVersion.current++; }; }, [connectionId]);
  return <section className="panel"><h4>{t.title}</h4><p>{t.guide}</p>
    {error && <p role="alert" className="error">{error}</p>}
    {info && <><label>Callback URL<input readOnly value={`${window.location.origin}${info.callbackPath}`} /></label>
      <p>{t.handshake}: {info.handshakeVerified ? t.yes : t.no} · {t.signed}: {info.signedCallbackVerified ? t.yes : t.no}
        · {t.attention}: {info.needsAttention}</p>
      <p>{locale === 'ar' ? 'في انتظار المعالجة / فشل المعالجة' : locale === 'fr' ? 'En attente / Échecs' : 'Pending / Failed'}: {info.pending} / {info.failed}
        {info.oldestPendingAt && ` · ${locale === 'ar' ? 'أقدم حدث معلق' : locale === 'fr' ? 'Plus ancien' : 'Oldest pending'}: ${new Date(info.oldestPendingAt).toLocaleString(locale)}`}
        {info.lastProcessedAt && ` · ${locale === 'ar' ? 'آخر معالجة' : locale === 'fr' ? 'Dernier traitement' : 'Last processed'}: ${new Date(info.lastProcessedAt).toLocaleString(locale)}`}</p></>}
    <button className="secondary" onClick={() => void load().catch((failure) => setError(String(failure)))}>{t.refresh}</button>
    <label>{locale === 'ar' ? 'حالة الحدث' : locale === 'fr' ? 'État de l’événement' : 'Event state'}<select value={filter}
      onChange={(event) => { const value = event.target.value; setFilter(value); setEvents([]); setBefore(null);
        void load(undefined,value).catch((failure)=>setError(String(failure))); }}>
      <option value="">{locale === 'ar' ? 'كل الأحداث' : locale === 'fr' ? 'Tous' : 'All events'}</option>
      <option value="PENDING">{locale === 'ar' ? 'في انتظار المعالجة' : locale === 'fr' ? 'En attente' : 'Pending processing'}</option>
      <option value="FAILED">{locale === 'ar' ? 'فشل المعالجة' : locale === 'fr' ? 'Échec' : 'Processing failed'}</option>
      <option value="NEEDS_ATTENTION">{t.attention}</option>
    </select></label>
    <h4>{t.events}</h4>{!events.length && <p>{t.empty}</p>}
    {events.length > 0 && <ul>{events.map((event) => <li key={event.id}>
      {new Date(event.received_at).toLocaleString(locale)} · {event.event_kind} · {event.state}
      {event.participant_last4 && ` · …${event.participant_last4}`}
      {event.failure_code && ` · ${event.failure_code}`}
      <MessagingEventProcessing key={`${event.id}:${event.processing_version}`} connectionId={connectionId}
        event={event} locale={locale} api={api} refresh={load} />
    </li>)}</ul>}
    {before && <button className="secondary" onClick={() => void load(before).catch((failure) => setError(String(failure)))}>{t.more}</button>}
  </section>;
}
