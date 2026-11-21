import { useEffect, useRef, useState } from 'react';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Review = { id: string; note: string; createdAt: string };
const labels = {
  ar: {
    title: 'مراجعة بشرية طلبتها الأتمتة', note: 'ملاحظة إتمام المراجعة', resolve: 'إتمام المراجعة',
    resolved: 'اكتملت المراجعة.', error: 'تعذّر تحديث طلب المراجعة.', reload: 'تحديث طلب المراجعة',
  },
  en: {
    title: 'Automation requested human review', note: 'Review resolution note', resolve: 'Complete review',
    resolved: 'Review completed.', error: 'The review request could not be refreshed or resolved.', reload: 'Refresh review request',
  },
  fr: {
    title: 'Vérification humaine demandée par l’automatisation', note: 'Note de résolution', resolve: 'Terminer la vérification',
    resolved: 'Vérification terminée.', error: 'La demande de vérification n’a pas pu être actualisée ou résolue.',
    reload: 'Actualiser la demande de vérification',
  },
};

export function LeadAutomationReview({ leadId, locale, api, onResolved }: {
  leadId: string; locale: keyof typeof labels; api: Api; onResolved: () => void;
}) {
  const t = labels[locale], path = '/api/leads/' + leadId + '/automation-review';
  const [review, setReview] = useState<Review | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const call = useRef(0);

  async function readReview() {
    const id = ++call.current;
    setBusy(true);
    setReview(null);
    setError(false);
    try {
      const result = await api<{ review: Review | null }>(path);
      if (call.current === id) setReview(result.review);
    } catch {
      if (call.current === id) setError(true);
    } finally {
      if (call.current === id) setBusy(false);
    }
  }

  useEffect(() => {
    void readReview();
    return () => { call.current++; };
  }, [leadId]);

  async function resolve() {
    if (!review || busy) return;
    const id = ++call.current;
    setBusy(true);
    try {
      await api(path + '/resolve', { method: 'POST', body: JSON.stringify({ reviewId: review.id, note: note.trim() }) });
      if (call.current === id) {
        setReview(null);
        setNote('');
        setResolved(true);
        onResolved();
      }
    } catch {
      if (call.current === id) {
        setReview(null);
        setNote('');
        setError(true);
      }
    } finally {
      if (call.current === id) setBusy(false);
    }
  }

  if (!review && !resolved && !error) return null;
  return <section className="panel" data-automation-human-review>
    <h3>{t.title}</h3>
    {error && <><p role="alert">{t.error}</p><button type="button" disabled={busy} onClick={() => void readReview()}>{t.reload}</button></>}
    {resolved && <p role="status">{t.resolved}</p>}
    {review && <>
      <p><time dateTime={review.createdAt}>{new Date(review.createdAt).toLocaleString(locale)}</time></p>
      {review.note && <p style={{ overflowWrap: 'anywhere' }}>{review.note}</p>}
      <form onSubmit={event => { event.preventDefault(); void resolve(); }}>
        <label>{t.note}<textarea required minLength={3} maxLength={500} value={note} onChange={event => setNote(event.target.value)} /></label>
        <button disabled={busy || note.trim().length < 3}>{t.resolve}</button>
      </form>
    </>}
  </section>;
}
