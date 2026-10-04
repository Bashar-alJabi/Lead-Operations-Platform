import { useEffect, useRef, useState } from 'react';
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Detail = { deliveryState: string; errorCode: string | null; providerMessageId: string | null;
  sentAt: string | null; providerUpdatedAt: string | null; recoveryVersion: number;
  canRequestRecovery: boolean; recoveryBlock: string | null;
  queue: { state: string; attempts: number; maxAttempts: number; availableAt: string;
    lockedUntil: string | null; errorCode: string | null } | null };
type Attempt = { id: string; attempt_number: number; state: string; provider_message_id: string | null;
  error_code: string | null; started_at: string; finished_at: string | null };
type DeliveryEvent = { id: string; status: string; provider_timestamp: string; received_at: string };
type Recovery = { id: string; recovery_version: number; previous_error_code: string | null;
  attempts_before: number; requester_name: string; reason: string; created_at: string };
type Page<T> = { items: T[]; nextBefore: string | null };
const labels = {
  ar: { open: 'تفاصيل الإرسال والمحاولات', refresh: 'تحديث', queue: 'قائمة الإرسال', next: 'متاح للعامل من',
    attempts: 'محاولات الإرسال إلى العميل', events: 'أحداث التسليم', recoveries: 'سجل الاسترداد',
    empty: 'لا سجلات بعد.', more: 'المزيد', reason: 'سبب إعادة المحاولة بعد إصلاح الخطأ', retry: 'إعادة وضع الرسالة في قائمة الإرسال',
    confirm: 'أصلحت سبب الفشل وأريد إرسال المحتوى المحفوظ نفسه',
    policy: 'الأهلية المعروضة أولية؛ تُفحص سياسة الإرسال الحالية عند الطلب وقبل الإرسال الفعلي.',
    scope: 'لا تُعاد رسالة مقبولة لدى المزود أو مجهولة النتيجة. يجب أن يبقى مؤلفها الأصلي متحكم المحادثة.',
    count: 'محاولات العامل / حد المحاولات', dispatch: 'السجل التالي لمحاولات إرسال العميل فقط؛ فشل الفحص أو رفع الملف قبل الإرسال يظهر في خطأ قائمة الإرسال.' },
  fr: { open: 'Détails de l’envoi', refresh: 'Actualiser', queue: 'File d’envoi', next: 'Disponible à partir de',
    attempts: 'Tentatives d’envoi au client', events: 'Événements de livraison', recoveries: 'Historique des reprises',
    empty: 'Aucun enregistrement.', more: 'Plus', reason: 'Motif après correction du problème', retry: 'Remettre le message en file',
    confirm: 'J’ai corrigé le problème et souhaite envoyer le même contenu enregistré',
    policy: 'L’éligibilité est préliminaire ; la politique actuelle est vérifiée à la demande et avant l’envoi.',
    scope: 'Un message accepté ou incertain ne peut être renvoyé. Son auteur doit toujours contrôler la conversation.',
    count: 'Tentatives du worker / limite', dispatch: 'Seuls les envois au client figurent ci-dessous. Les échecs avant l’envoi sont indiqués par l’erreur de file.' },
  en: { open: 'Send details and attempts', refresh: 'Refresh', queue: 'Send queue', next: 'Available to worker from',
    attempts: 'Customer dispatch attempts', events: 'Delivery events', recoveries: 'Recovery history',
    empty: 'No records yet.', more: 'More', reason: 'Reason after fixing the failure', retry: 'Requeue the saved message',
    confirm: 'I fixed the failure and want to send the same saved content',
    policy: 'Eligibility is preliminary; current sending policy is checked on request and before dispatch.',
    scope: 'Accepted or uncertain sends cannot be requeued. The original author must still control the conversation.',
    count: 'Worker attempts / limit', dispatch: 'The history below covers customer dispatch only. Failures before dispatch appear in the queue error.' },
} as const;
export function MessageDelivery({ conversationId, messageId, locale, api, refresh }: {
  conversationId: string; messageId: string; locale: 'ar'|'fr'|'en'; api: Api; refresh: () => Promise<void>;
}) {
  const t = labels[locale]; const generation = useRef(0);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [attempts, setAttempts] = useState<Page<Attempt>>({ items: [], nextBefore: null });
  const [events, setEvents] = useState<Page<DeliveryEvent>>({ items: [], nextBefore: null });
  const [recoveries, setRecoveries] = useState<Page<Recovery>>({ items: [], nextBefore: null });
  const [reason, setReason] = useState(''); const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => () => { generation.current++; }, []);
  const path = `/api/conversations/${conversationId}/messages/${messageId}`;
  async function load() {
    const request = ++generation.current; setBusy(true); setError('');
    try {
      const [d, a, e, r] = await Promise.all([api<Detail>(path + '/delivery'), api<Page<Attempt>>(path + '/attempts'),
        api<Page<DeliveryEvent>>(path + '/delivery-events'), api<Page<Recovery>>(path + '/recoveries')]);
      if (request !== generation.current) return;
      setDetail(d); setAttempts(a); setEvents(e); setRecoveries(r);
    } catch (failure) { if (request === generation.current) setError(String(failure)); }
    finally { if (request === generation.current) setBusy(false); }
  }
  async function more(kind: 'attempts'|'delivery-events'|'recoveries', before: string) {
    const request = ++generation.current; setBusy(true); setError('');
    try {
      const query = `${path}/${kind}?before=${encodeURIComponent(before)}`;
      if (kind === 'attempts') {
        const page = await api<Page<Attempt>>(query);
        if (request === generation.current) setAttempts((old) => ({ ...page, items: [...old.items, ...page.items] }));
      } else if (kind === 'delivery-events') {
        const page = await api<Page<DeliveryEvent>>(query);
        if (request === generation.current) setEvents((old) => ({ ...page, items: [...old.items, ...page.items] }));
      } else {
        const page = await api<Page<Recovery>>(query);
        if (request === generation.current) setRecoveries((old) => ({ ...page, items: [...old.items, ...page.items] }));
      }
    } catch (failure) { if (request === generation.current) setError(String(failure)); }
    finally { if (request === generation.current) setBusy(false); }
  }
  async function retry() {
    if (!detail || !confirmed) return;
    const request = ++generation.current; setBusy(true); setError('');
    try {
      await api(path + '/retry', { method: 'POST', body: JSON.stringify({ version: detail.recoveryVersion, reason }) });
      if (request !== generation.current) return;
      setReason(''); setConfirmed(false); await load(); await refresh();
    } catch (failure) { if (request === generation.current) setError(String(failure)); }
    finally { if (request === generation.current) setBusy(false); }
  }
  return <div className={detail ? 'panel' : undefined}>
    <button type="button" className="secondary" disabled={busy} onClick={() => void load()}>{detail ? t.refresh : t.open}</button>
    {error && <p role="alert" className="error">{error}</p>}
    {detail && <>
      <p>{detail.deliveryState} · {detail.errorCode ?? '—'} · {detail.providerMessageId ?? '—'}</p>
      {detail.sentAt && <p>{locale === 'ar' ? 'قبول الإرسال' : locale === 'fr' ? 'Envoi accepté' : 'Send accepted'}:
        {' '}{new Date(detail.sentAt).toLocaleString(locale)}</p>}
      {detail.providerUpdatedAt && <p>{locale === 'ar' ? 'آخر تحديث للمزود' : locale === 'fr' ? 'Mise à jour fournisseur' : 'Provider update'}:
        {' '}{new Date(detail.providerUpdatedAt).toLocaleString(locale)}</p>}
      {detail.queue && <p>{t.queue}: {detail.queue.state} · {detail.queue.errorCode ?? '—'}<br />
        {t.count}: {detail.queue.attempts} / {detail.queue.maxAttempts}<br />
        {t.next}: {new Date(detail.queue.availableAt).toLocaleString(locale)}</p>}
      <h5>{t.attempts}</h5><p>{t.dispatch}</p>
      {attempts.items.length ? <ul>{attempts.items.map((a) => <li key={a.id}>
        {a.attempt_number} · {a.state} · {a.error_code ?? '—'} · {new Date(a.started_at).toLocaleString(locale)}
        {a.finished_at && ` → ${new Date(a.finished_at).toLocaleString(locale)}`} {a.provider_message_id ?? ''}
      </li>)}</ul> : <p>{t.empty}</p>}
      {attempts.nextBefore && <button type="button" disabled={busy} onClick={() => void more('attempts', attempts.nextBefore!)}>{t.more}</button>}
      <h5>{t.events}</h5>
      {events.items.length ? <ul>{events.items.map((e) => <li key={e.id}>{e.status} · {new Date(e.provider_timestamp).toLocaleString(locale)}
        {' → '}{new Date(e.received_at).toLocaleString(locale)}</li>)}</ul> : <p>{t.empty}</p>}
      {events.nextBefore && <button type="button" disabled={busy} onClick={() => void more('delivery-events', events.nextBefore!)}>{t.more}</button>}
      <h5>{t.recoveries}</h5>
      {recoveries.items.length ? <ul>{recoveries.items.map((r) => <li key={r.id}>{r.recovery_version} · {r.requester_name}
        {' · '}{r.previous_error_code ?? '—'} · {new Date(r.created_at).toLocaleString(locale)}<p>{r.reason}</p></li>)}</ul> : <p>{t.empty}</p>}
      {recoveries.nextBefore && <button type="button" disabled={busy} onClick={() => void more('recoveries', recoveries.nextBefore!)}>{t.more}</button>}
      <p>{t.scope} {t.policy}</p>
      {detail.canRequestRecovery ? <form onSubmit={(e) => { e.preventDefault(); void retry(); }}>
        <label>{t.reason}<input required minLength={10} maxLength={500} value={reason} disabled={busy}
          onChange={(e) => setReason(e.target.value)} /></label>
        <label className="check-row"><input type="checkbox" required checked={confirmed} disabled={busy}
          onChange={(e) => setConfirmed(e.target.checked)} />{t.confirm}</label>
        <button disabled={busy || !confirmed || reason.trim().length < 10}>{t.retry}</button>
      </form> : <p>{detail.recoveryBlock}</p>}
    </>}
  </div>;
}
