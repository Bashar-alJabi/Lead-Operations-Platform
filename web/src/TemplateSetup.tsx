import { useEffect, useState } from 'react';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Locale = 'ar'|'fr'|'en';
type Template = { id: string; name: string; language: string; status: string; category: string | null;
  active: boolean; last_synced_at: string | null; components: { type?: string; text?: string }[] };
type CreateRequest = { id: string; name: string; language: string; state: string; created_at: string };

const labels = {
  ar: { title: 'قوالب Meta', sync: 'مزامنة الاعتماد', create: 'إرسال قالب للمراجعة', name: 'اسم القالب', language: 'اللغة',
    category: 'الفئة', body: 'نص BODY', status: 'حالة الاعتماد', inactive: 'غائب عن آخر مزامنة', noItems: 'لا قوالب',
    more: 'المزيد', unresolved: 'طلبات إنشاء تحتاج مراجعة', resolve: 'تأكيد الغياب بعد المزامنة',
    confirm: 'تأكد من أن القالب غير موجود في Meta بعد مزامنة حديثة. قد يتأخر ظهوره لدى المزود؛ هل تريد إتاحة طلب إنشاء جديد؟',
    note: 'استخدم {{1}} ثم {{2}} للمتغيرات النصية المتسلسلة، وأدخل أمثلة المراجعة لكل منها. ينتظر القالب اعتماد Meta. عند نتيجة إنشاء ملتبسة، زامن القائمة وراجع الطلب قبل أي محاولة جديدة.' },
  fr: { title: 'Modèles Meta', sync: 'Synchroniser les approbations', create: 'Soumettre un modèle', name: 'Nom du modèle', language: 'Langue',
    category: 'Catégorie', body: 'Texte BODY', status: 'Approbation', inactive: 'Absent de la dernière synchronisation', noItems: 'Aucun modèle',
    more: 'Plus', unresolved: 'Créations à examiner', resolve: 'Confirmer l’absence après synchronisation',
    confirm: 'Vérifiez que le modèle est absent de Meta après une synchronisation récente. Sa visibilité peut être retardée. Autoriser une nouvelle demande ?',
    note: 'Utilisez {{1}} puis {{2}} pour les variables texte et fournissez un exemple pour chacune. Le modèle attend l’approbation de Meta. Après un résultat incertain, synchronisez puis examinez la demande.' },
  en: { title: 'Meta templates', sync: 'Sync approvals', create: 'Submit template', name: 'Template name', language: 'Language',
    category: 'Category', body: 'BODY text', status: 'Approval status', inactive: 'Missing from last sync', noItems: 'No templates',
    more: 'More', unresolved: 'Create requests needing review', resolve: 'Confirm absent after sync',
    confirm: 'Verify the template is absent from Meta after a recent sync. Provider visibility may be delayed. Allow a new create request?',
    note: 'Use sequential {{1}}, {{2}} text placeholders and provide an approval example for each. New templates await Meta approval. After an uncertain result, sync and review before another attempt.' },
} as const;

export function TemplateSetup({ connectionId, status, canManage, locale, api }: {
  connectionId: string; status: string; canManage: boolean; locale: Locale; api: Api;
}) {
  const t = labels[locale];
  const [templates, setTemplates] = useState<Template[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [requests, setRequests] = useState<CreateRequest[]>([]);
  const [requestAfter, setRequestAfter] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', language: 'en_US', category: 'UTILITY', body: '',header:'',footer:'' });
  const [examples, setExamples] = useState<string[]>([]);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load(next?: string) {
    const page = await api<{ items: Template[]; nextAfter: string | null }>(
      `/api/messaging/connections/${connectionId}/templates${next ? '?after=' + encodeURIComponent(next) : ''}`);
    setTemplates((current) => next ? [...current, ...page.items] : page.items);
    setAfter(page.nextAfter);
  }
  async function loadRequests(next?: string) {
    const page = await api<{ items: CreateRequest[]; nextAfter: string | null }>(
      `/api/messaging/connections/${connectionId}/templates/requests${next ? '?after=' + encodeURIComponent(next) : ''}`);
    setRequests((current) => next ? [...current, ...page.items] : page.items);
    setRequestAfter(page.nextAfter);
  }
  useEffect(() => { setTemplates([]); setAfter(null); setRequests([]); setRequestAfter(null);
    setKey(crypto.randomUUID()); setError('');
    void Promise.all([load(), loadRequests()]).catch((failure) => setError(String(failure))); }, [connectionId]);
  async function sync() {
    setBusy(true); setError('');
    try { await api(`/api/messaging/connections/${connectionId}/templates/sync`, { method: 'POST' });
      await Promise.all([load(), loadRequests()]); }
    catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  async function create() {
    setBusy(true); setError('');
    try {
      const { header,footer,...base }=form;
      await api(`/api/messaging/connections/${connectionId}/templates`, { method: 'POST',
        body: JSON.stringify({ ...base,...(header ? { header } : {}),...(footer ? { footer } : {}),
          ...(examples.length ? { examples } : {}), idempotencyKey: key }) });
      setForm({ name: '', language: form.language, category: 'UTILITY', body: '',header:'',footer:'' });
      setExamples([]);
      setKey(crypto.randomUUID()); await Promise.all([load(), loadRequests()]);
    } catch (failure) { setError(String(failure)); await loadRequests().catch(() => {}); }
    finally { setBusy(false); }
  }
  async function resolve(request: CreateRequest) {
    if (!window.confirm(t.confirm)) return;
    setBusy(true); setError('');
    try { await api(`/api/messaging/connections/${connectionId}/templates/requests/${request.id}/resolve`, {
      method: 'POST', body: JSON.stringify({ confirmAbsent: true }),
    }); await loadRequests(); setKey(crypto.randomUUID()); }
    catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  const parameterNumbers = [...form.body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
  const parameterCount = parameterNumbers.length ? Math.min(10, Math.max(...parameterNumbers)) : 0;
  return <section className="panel"><h4>{t.title}</h4><p>{t.note}</p>
    {error && <p role="alert" className="error">{error}</p>}
    {canManage && <button className="secondary" disabled={busy || status === 'DISABLED'} onClick={() => void sync()}>{t.sync}</button>}
    <div className="table-scroll"><table><thead><tr><th>{t.name}</th><th>{t.language}</th><th>{t.category}</th><th>{t.status}</th><th>{t.body}</th></tr></thead>
      <tbody>{templates.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.language}</td><td>{item.category ?? '—'}</td>
        <td>{item.status}{!item.active && <small>{t.inactive}</small>}</td>
        <td>{item.components.filter((part)=>['HEADER','BODY','FOOTER'].includes(part.type?.toUpperCase() ?? ''))
          .map((part,index)=><p key={index}>{part.type}: {part.text ?? '—'}</p>)}</td></tr>)}</tbody></table></div>
    {!templates.length && <p>{t.noItems}</p>}{after && <button className="secondary" onClick={() => void load(after).catch((failure) => setError(String(failure)))}>{t.more}</button>}
    {requests.length > 0 && <section><h5>{t.unresolved}</h5><ul>{requests.map((request) =>
      <li key={request.id}>{request.name} · {request.language} · {request.state}
        {canManage && <button className="link" disabled={busy} onClick={() => void resolve(request)}>{t.resolve}</button>}</li>)}</ul>
      {requestAfter && <button className="secondary" onClick={() => void loadRequests(requestAfter).catch((failure) => setError(String(failure)))}>{t.more}</button>}
    </section>}
    {canManage && <form className="workflow-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <label>{locale==='ar' ? 'عنوان TEXT ثابت (اختياري)' : locale==='fr' ? 'En-tête TEXT fixe (facultatif)' : 'Static TEXT header (optional)'}
        <input maxLength={60} value={form.header} onChange={(event)=> { setForm({ ...form,header:event.target.value });setKey(crypto.randomUUID()); }} /></label>
      <label>{locale==='ar' ? 'تذييل ثابت (اختياري)' : locale==='fr' ? 'Pied de page fixe (facultatif)' : 'Static footer (optional)'}
        <input maxLength={60} value={form.footer} onChange={(event)=> { setForm({ ...form,footer:event.target.value });setKey(crypto.randomUUID()); }} /></label>
      <label>{t.name}<input required pattern="[a-z0-9_]+" maxLength={512} value={form.name}
        onChange={(event) => { setForm({ ...form, name: event.target.value });setKey(crypto.randomUUID()); }} /></label>
      <label>{t.language}<input required pattern="[a-z]{2,3}(_[A-Z]{2})?" value={form.language}
        onChange={(event) => { setForm({ ...form, language: event.target.value });setKey(crypto.randomUUID()); }} /></label>
      <label>{t.category}<select value={form.category} onChange={(event) => { setForm({ ...form, category: event.target.value });setKey(crypto.randomUUID()); }}>
        <option value="UTILITY">UTILITY</option><option value="MARKETING">MARKETING</option></select></label>
      <label>{t.body}<textarea required minLength={1} maxLength={1024} value={form.body}
        onChange={(event) => {
          const body = event.target.value;
          const numbers = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
          const count = numbers.length ? Math.min(10, Math.max(...numbers)) : 0;
          setForm({ ...form, body }); setExamples((current) => Array.from({ length: count }, (_, index) => current[index] ?? ''));
          setKey(crypto.randomUUID());
        }} /></label>
      {Array.from({ length: parameterCount }, (_, index) => <label key={index}>
        {locale === 'ar' ? 'مثال المتغير' : locale === 'fr' ? 'Exemple du paramètre' : 'Parameter example'} {index + 1}
        <input required maxLength={512} value={examples[index] ?? ''} onChange={(event) => {
          setExamples((current) => current.map((value, position) => position === index ? event.target.value : value));
          setKey(crypto.randomUUID());
        }} /></label>)}
      <button disabled={busy || status === 'DISABLED'}>{t.create}</button>
    </form>}
  </section>;
}
