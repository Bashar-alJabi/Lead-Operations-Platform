import { useEffect, useState } from 'react';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Info = { callbackPath: string; handshakeVerified: boolean; signedCallbackVerified: boolean;
  needsAttention: number };
type Event = { id: string; event_kind: string; state: string; failure_code: string | null;
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
  async function load(next?: string) {
    const [current, page] = await Promise.all([
      api<Info>(`/api/messaging/connections/${connectionId}/webhook`),
      api<{ items: Event[]; nextBefore: string | null }>(
        `/api/messaging/connections/${connectionId}/events${next ? '?before=' + encodeURIComponent(next) : ''}`),
    ]);
    setInfo(current); setEvents((old) => next ? [...old, ...page.items] : page.items); setBefore(page.nextBefore);
  }
  useEffect(() => { setInfo(null); setEvents([]); setError('');
    void load().catch((failure) => setError(String(failure))); }, [connectionId]);
  return <section className="panel"><h4>{t.title}</h4><p>{t.guide}</p>
    {error && <p role="alert" className="error">{error}</p>}
    {info && <><label>Callback URL<input readOnly value={`${window.location.origin}${info.callbackPath}`} /></label>
      <p>{t.handshake}: {info.handshakeVerified ? t.yes : t.no} · {t.signed}: {info.signedCallbackVerified ? t.yes : t.no}
        · {t.attention}: {info.needsAttention}</p></>}
    <button className="secondary" onClick={() => void load().catch((failure) => setError(String(failure)))}>{t.refresh}</button>
    <h4>{t.events}</h4>{!events.length && <p>{t.empty}</p>}
    {events.length > 0 && <ul>{events.map((event) => <li key={event.id}>
      {new Date(event.received_at).toLocaleString(locale)} · {event.event_kind} · {event.state}
      {event.participant_last4 && ` · …${event.participant_last4}`}
      {event.failure_code && ` · ${event.failure_code}`}
    </li>)}</ul>}
    {before && <button className="secondary" onClick={() => void load(before).catch((failure) => setError(String(failure)))}>{t.more}</button>}
  </section>;
}
