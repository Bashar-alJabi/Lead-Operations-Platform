import { useEffect, useRef, useState } from 'react';
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Job = { id: string; proposalId: string; kind: string; version: number; state: string; failureCount: number; errorCode: string | null; nextRunAt: string | null; updatedAt: string; canRetry: boolean };
type Jobs = { items: Job[]; nextCursor: string | null };
type History = { items: { version: number; operation: string; state: string; failure_count: number; error_code: string | null; reason: string | null; created_at: string }[]; nextVersion: number | null };
const words = {
  en: { title: 'Local AI action jobs', read: 'Review AI action jobs', more: 'Older action jobs', empty: 'No local AI action jobs.', completed: 'Include completed action jobs', failures: 'Failed attempts', next: 'Next eligible attempt', history: 'Action job history', older: 'Older job changes', reason: 'Action job retry reason', retry: 'Retry AI action job', note: 'Retry preserves the original source and rechecks current permissions and context. It grants no tool and does not reactivate AI. Any resulting message must pass current messaging policy.', WAITING: 'Scheduled', DEAD_LETTER: 'Automatic retries stopped', COMPLETED: 'Local processing finished' },
  ar: { title: 'وظائف إجراءات AI المحلية', read: 'مراجعة وظائف إجراءات AI', more: 'وظائف إجراءات أقدم', empty: 'لا توجد وظائف إجراءات AI محلية.', completed: 'إظهار وظائف الإجراءات المنتهية', failures: 'المحاولات الفاشلة', next: 'المحاولة المؤهلة التالية', history: 'سجل وظيفة الإجراء', older: 'تغييرات أقدم للوظيفة', reason: 'سبب إعادة محاولة وظيفة الإجراء', retry: 'إعادة محاولة وظيفة إجراء AI', note: 'المحاولة تحافظ على المصدر الأصلي وتعيد فحص الصلاحيات والسياق الحاليين. لا تمنح أداة أو تفعّل AI. أي رسالة ناتجة تحتاج سياسة الإرسال الحالية.', WAITING: 'مجدولة', DEAD_LETTER: 'توقفت المحاولات التلقائية', COMPLETED: 'انتهت المعالجة المحلية' },
  fr: { title: 'Tâches locales des actions IA', read: 'Consulter les tâches des actions IA', more: 'Tâches précédentes', empty: 'Aucune tâche locale des actions IA.', completed: 'Inclure les tâches terminées', failures: 'Tentatives échouées', next: 'Prochaine tentative éligible', history: 'Historique de la tâche', older: 'Modifications précédentes', reason: 'Motif de relance de la tâche', retry: 'Relancer la tâche IA', note: 'La relance conserve la source et vérifie les droits et le contexte actuels. Elle ne réactive pas l’IA et n’accorde aucun outil. Tout message résultant exige la politique actuelle.', WAITING: 'Planifiée', DEAD_LETTER: 'Relances automatiques arrêtées', COMPLETED: 'Traitement local terminé' },
};
export function AIActionJobs({ id, locale, revision, api }: { id: string; locale: 'ar' | 'en' | 'fr'; revision: string; api: Api }) {
  const t = words[locale], root = '/api/conversations/' + id + '/ai-action-jobs', epoch = useRef(0);
  const [value, setValue] = useState<Jobs | null>(null), [history, setHistory] = useState<(History & { jobId: string }) | null>(null), [reasons, setReasons] = useState<Record<string, string>>({}), [includeCompleted, setIncludeCompleted] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { ++epoch.current; setValue(null); setHistory(null); setError(''); setReasons({}); setBusy(false); return () => { ++epoch.current; }; }, [id, locale, revision]);
  const path = (cursor?: string | null) => root + '?includeCompleted=' + includeCompleted + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
  const clear = () => { setValue(null); setHistory(null); setReasons({}); };
  async function read(older = false) {
    const n = ++epoch.current, previous = older ? value : null; setBusy(true); setError(''); if (!older) clear();
    try { const r = await api<Jobs>(path(previous?.nextCursor)); if (n === epoch.current) setValue({ ...r, items: [...new Map([...(previous?.items ?? []), ...r.items].map(j => [j.id, j])).values()] }); }
    catch (e) { if (n === epoch.current) { clear(); setError(String(e)); } } finally { if (n === epoch.current) setBusy(false); }
  }
  async function readHistory(job: Job, older = false) {
    const n = ++epoch.current, previous = older && history?.jobId === job.id ? history : null; setBusy(true); setError(''); setHistory(null);
    try { const h = await api<History>(root + '/' + job.id + '/history' + (previous?.nextVersion ? '?before=' + previous.nextVersion : '')); if (n === epoch.current) setHistory({ ...h, jobId: job.id, items: [...(previous?.items ?? []), ...h.items] }); }
    catch (e) { if (n === epoch.current) { clear(); setError(String(e)); } } finally { if (n === epoch.current) setBusy(false); }
  }
  async function retry(job: Job) {
    const n = ++epoch.current; setBusy(true); setError('');
    try { await api(root + '/' + job.id + '/retry', { method: 'POST', body: JSON.stringify({ version: job.version, reason: reasons[job.id] ?? '' }) }); const r = await api<Jobs>(path()); if (n === epoch.current) { clear(); setValue(r); } }
    catch (e) { if (n === epoch.current) { clear(); setError(String(e)); } } finally { if (n === epoch.current) setBusy(false); }
  }
  const state = (s: string) => t[s as 'WAITING' | 'DEAD_LETTER' | 'COMPLETED'] ?? s;
  return <section className="panel" data-ai-action-jobs><h4>{t.title}</h4><p>{t.note}</p>
    <label><input type="checkbox" style={{ width: 'auto' }} checked={includeCompleted} disabled={busy} onChange={e => { ++epoch.current; setIncludeCompleted(e.target.checked); clear(); setError(''); }} />{t.completed}</label>
    <button disabled={busy} onClick={() => void read()}>{t.read}</button>{error && <p role="alert">{error}</p>}{value && !value.items.length && <p>{t.empty}</p>}
    {value?.items.map(j => <article key={j.id} data-ai-action-job={j.id}><p>{j.kind} · {state(j.state)}</p><p>{t.failures}: {j.failureCount}</p>{j.errorCode && <p dir="ltr">{j.errorCode}</p>}
      <time dateTime={j.updatedAt}>{new Date(j.updatedAt).toLocaleString(locale)}</time>{j.nextRunAt && <p>{t.next}: {new Date(j.nextRunAt).toLocaleString(locale)}</p>}
      <button disabled={busy} onClick={() => void readHistory(j)}>{t.history}</button>{j.canRetry && <><label>{t.reason}<input aria-label={t.reason} value={reasons[j.id] ?? ''} maxLength={500} disabled={busy} onChange={e => setReasons(previous => ({ ...previous, [j.id]: e.target.value }))} /></label><button disabled={busy || (reasons[j.id] ?? '').trim().length < 3} onClick={() => void retry(j)}>{t.retry}</button></>}
      {history?.jobId === j.id && <div data-ai-action-job-history>{history.items.map(h => <article key={h.version}><p>{h.version} · {h.operation} · {state(h.state)} · {t.failures}: {h.failure_count}</p><time>{new Date(h.created_at).toLocaleString(locale)}</time>{h.reason && <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{h.reason}</p>}</article>)}{history.nextVersion && <button disabled={busy} onClick={() => void readHistory(j, true)}>{t.older}</button>}</div>}
    </article>)}{value?.nextCursor && <button disabled={busy} onClick={() => void read(true)}>{t.more}</button>}
  </section>;
}
