import { useEffect, useRef, useState } from 'react';
import { FieldInput, type FieldRow } from './LeadFields.js';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Question = { id: string; prompt: string; required: boolean; value: unknown; source: string | null; editable: boolean;
  answerVersion: number; fieldValueVersion: number | null; field: FieldRow | null };
type State = { definitionVersion: number; enabled: boolean; questions: Question[]; blockers: string[];
  result: { complete: boolean; missingQuestionIds: string[]; handoff: boolean } | null };
type History = { version: number; value: unknown; source: string; definitionVersion: number; createdAt: string };
const labels = {
  en: { yes: 'Yes', no: 'No', title: 'Lead qualification', reload: 'Reload collected answers', save: 'Save collected answer', history: 'Collected answer history', more: 'More collected history',
    disabled: 'Qualification is disabled for this campaign.', required: 'Required', source: 'Source', complete: 'Qualification complete', incomplete: 'Qualification incomplete',
    handoff: 'Campaign handoff criteria met', pending: 'Required answers missing', restricted: 'Result unavailable with the current field permissions or configuration.', version: 'Definition version',
    info: 'Completion follows current campaign rules. Saving an answer does not send a message or transfer conversation control.' },
  ar: { yes: 'نعم', no: 'لا', title: 'تأهيل Lead', reload: 'تحديث الإجابات المحفوظة', save: 'حفظ الإجابة المجمعة', history: 'تاريخ الإجابة المجمعة', more: 'المزيد من تاريخ الإجابات',
    disabled: 'التأهيل معطل لهذه الحملة.', required: 'مطلوب', source: 'المصدر', complete: 'التأهيل مكتمل', incomplete: 'التأهيل غير مكتمل',
    handoff: 'تحققت شروط التحويل إلى موظف في الحملة', pending: 'إجابات مطلوبة ناقصة', restricted: 'النتيجة غير متاحة حسب صلاحيات الحقول أو الإعدادات الحالية.', version: 'نسخة التعريف',
    info: 'تُحسب النتيجة وفق قواعد الحملة الحالية. حفظ الإجابة لا يرسل رسالة ولا ينقل التحكم بالمحادثة.' },
  fr: { yes: 'Oui', no: 'Non', title: 'Qualification du Lead', reload: 'Actualiser les réponses collectées', save: 'Enregistrer la réponse collectée', history: 'Historique de réponse collectée', more: 'Plus de réponses historiques',
    disabled: 'La qualification est désactivée pour cette campagne.', required: 'Obligatoire', source: 'Source', complete: 'Qualification terminée', incomplete: 'Qualification incomplète',
    handoff: 'Critères de transfert humain remplis', pending: 'Réponses obligatoires manquantes', restricted: 'Résultat indisponible avec les droits ou la configuration actuels.', version: 'Version de définition',
    info: 'Le résultat suit les règles actuelles de la campagne. Enregistrer une réponse n’envoie aucun message et ne transfère pas le contrôle.' },
} as const;
const format = (value: unknown) => value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);

export function LeadQualification({ leadId, locale, api, onChanged }: { leadId: string; locale: 'ar' | 'en' | 'fr'; api: Api; onChanged: () => void }) {
  const t = labels[locale], [state, setState] = useState<State | null>(null), [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [history, setHistory] = useState<{ id: string; prompt: string; items: History[]; next: number | null } | null>(null);
  const requests = useRef(new Map<string, { serialized: string; requestId: string }>());
  async function reload() {
    try {
      const data = await api<State>(`/api/leads/${leadId}/qualification`);
      setState(data); setDrafts(Object.fromEntries(data.questions.map(q => [q.id, q.value])));
    } catch (failure) { setState(null); setHistory(null); throw failure; }
  }
  useEffect(() => { void reload().catch(failure => setError(String(failure))); }, [leadId]);
  async function save(q: Question) {
    if (!state) return; setBusy(true); setError('');
    try {
      const raw = drafts[q.id] ?? null, value = q.field?.field_type === 'DATETIME' && typeof raw === 'string' ? new Date(raw).toISOString() : raw;
      const body = { definitionVersion: state.definitionVersion, answerVersion: q.answerVersion, fieldValueVersion: q.fieldValueVersion, value }, serialized = JSON.stringify(body);
      let attempt = requests.current.get(q.id);
      if (!attempt || attempt.serialized !== serialized) { attempt = { serialized, requestId: crypto.randomUUID() }; requests.current.set(q.id, attempt); }
      await api(`/api/leads/${leadId}/qualification/answers/${q.id}`, { method: 'PUT', body: JSON.stringify({ ...body, requestId: attempt.requestId }) });
      await reload(); requests.current.delete(q.id); setHistory(null); onChanged();
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  async function showHistory(q: { id: string; prompt: string }, before?: number) {
    setBusy(true); setError('');
    try {
      const data = await api<{ items: History[]; nextVersion: number | null }>(`/api/leads/${leadId}/qualification/answers/${q.id}/history${before ? '?before=' + before : ''}`);
      setHistory({ ...q, items: before && history?.id === q.id ? [...history.items, ...data.items] : data.items, next: data.nextVersion });
    } catch (failure) { setHistory(null); setError(String(failure)); } finally { setBusy(false); }
  }
  return <section className="lead-fields" data-lead-qualification><h3>{t.title}</h3>
    <button className="link" disabled={busy} onClick={() => { setBusy(true); setError(''); setHistory(null); void reload().catch(f => setError(String(f))).finally(() => setBusy(false)); }}>{t.reload}</button>
    {error && <div role="alert" className="error">{error}</div>}
    {state && <><small>{t.version}: {state.definitionVersion}</small>{!state.enabled && <p>{t.disabled}</p>}<>
      <p>{t.info}</p><div data-qualification-result>{state.result ? <><strong>{state.result.complete ? t.complete : t.incomplete}</strong>
        <p>{t.pending}: {state.result.missingQuestionIds.length}</p>{state.result.handoff && <p>{t.handoff}</p>}</> : <p>{t.restricted}</p>}</div>
      {state.questions.map(q => <div className="lead-field" data-qualification-question={q.id} key={q.id}>
        <label>{q.prompt}{q.required && <small>{t.required}</small>}{q.editable ? q.field
          ? <FieldInput field={q.field} value={drafts[q.id]} ariaLabel={q.prompt} booleanLabels={t} onChange={value => setDrafts(d => ({ ...d, [q.id]: value }))} />
          : <textarea aria-label={q.prompt} maxLength={4000} value={drafts[q.id] == null ? '' : String(drafts[q.id])} onChange={e => setDrafts(d => ({ ...d, [q.id]: e.target.value || null }))} />
          : <strong>{format(q.value)}</strong>}</label><small>{t.source}: {q.source ?? '—'}</small>
        <div className="actions">{q.editable && <button disabled={busy} onClick={() => void save(q)}>{t.save}</button>}
          <button className="link" disabled={busy} onClick={() => void showHistory(q)}>{t.history}</button></div>
      </div>)}
    </></>}
    {history && <div className="panel" data-qualification-history><h4>{t.history}: {history.prompt}</h4><ul className="timeline">{history.items.map(h => <li key={h.version}>
      <span>{format(h.value)}<small>{t.source}: {h.source} · {t.version}: {h.definitionVersion} · #{h.version}</small></span><time dir="auto">{new Date(h.createdAt).toLocaleString(locale)}</time>
    </li>)}</ul>{history.next && <button disabled={busy} onClick={() => void showHistory(history, history.next!)}>{t.more}</button>}</div>}
  </section>;
}
