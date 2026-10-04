import { useState } from 'react';
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
export type ProcessingEvent = { id: string; state: string; failure_code: string | null; processing_attempts: number;
  processing_failures: number; processing_version: number; processing_available_at: string; processing_last_error: string | null };
type Attempt = { id: string; attempt_number: number; outcome: string; error_code: string | null; finished_at: string };
const text = {
  ar: { attempts: 'محاولات المعالجة', history: 'سجل المعالجة', reason: 'سبب إعادة المعالجة بعد إصلاح الخطأ',
    retry: 'إعادة معالجة الحدث', next: 'المحاولة التالية', more: 'المزيد', empty: 'لا محاولات بعد',
    safe: 'إعادة المعالجة تخص الحدث المحفوظ؛ لا ترسل رسالة جديدة للعميل.' },
  fr: { attempts: 'Tentatives de traitement', history: 'Historique', reason: 'Motif après correction du problème',
    retry: 'Retraiter l’événement', next: 'Prochaine tentative', more: 'Plus', empty: 'Aucune tentative',
    safe: 'Retraite l’événement enregistré sans envoyer un nouveau message au client.' },
  en: { attempts: 'Processing attempts', history: 'Processing history', reason: 'Reason after fixing the failure',
    retry: 'Reprocess event', next: 'Next attempt', more: 'More', empty: 'No attempts yet',
    safe: 'Reprocesses the saved event without sending a new customer message.' },
} as const;
export function MessagingEventProcessing({ connectionId, event, locale, api, refresh }: {
  connectionId: string; event: ProcessingEvent; locale: 'ar'|'fr'|'en'; api: Api; refresh: () => Promise<void>;
}) {
  const t = text[locale]; const [attempts, setAttempts] = useState<Attempt[] | null>(null);
  const [before, setBefore] = useState<string | null>(null); const [reason, setReason] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const path = `/api/messaging/connections/${connectionId}/events/${event.id}`;
  async function history(next?: string) {
    setBusy(true); setError('');
    try {
      const page = await api<{ items: Attempt[]; nextBefore: string | null }>(`${path}/attempts${next ? '?before=' + encodeURIComponent(next) : ''}`);
      setAttempts((old) => next ? [...(old ?? []), ...page.items] : page.items); setBefore(page.nextBefore);
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  async function retry() {
    setBusy(true); setError('');
    try { await api(`${path}/retry`, { method: 'POST', body: JSON.stringify({ version: event.processing_version, reason }) });
      setReason(''); await refresh();
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  return <div>
    <span>{t.attempts}: {event.processing_attempts} · {event.processing_last_error ?? ''}</span>
    {event.processing_last_error && event.state !== 'FAILED' && <p>{t.next}: {new Date(event.processing_available_at).toLocaleString(locale)}</p>}
    <button type="button" className="secondary" disabled={busy} onClick={() => void history()}>{t.history}</button>
    {attempts && (attempts.length ? <ul>{attempts.map((attempt) => <li key={attempt.id}>
      {attempt.attempt_number} · {attempt.outcome} · {attempt.error_code ?? ''} · {new Date(attempt.finished_at).toLocaleString(locale)}
    </li>)}</ul> : <p>{t.empty}</p>)}
    {before && <button type="button" className="secondary" disabled={busy} onClick={() => void history(before)}>{t.more}</button>}
    {event.state === 'FAILED' && event.failure_code === 'EVENT_PROCESSING_FAILED' && <form onSubmit={(e) => { e.preventDefault(); void retry(); }}>
      <p>{t.safe}</p><label>{t.reason}<input required minLength={10} maxLength={500} disabled={busy} value={reason}
        onChange={(e) => setReason(e.target.value)} /></label><button disabled={busy || reason.trim().length < 10}>{t.retry}</button>
    </form>}
    {error && <p role="alert" className="error">{error}</p>}
  </div>;
}
