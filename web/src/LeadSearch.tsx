import { useEffect, useState } from 'react';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Locale = 'ar'|'fr'|'en';
type Branch = { id: string; name: string };
type Campaign = { id: string; name: string; branch_id: string };
type User = { id: string; name: string; role: string; branch_id: string | null };
type Field = { id: string; label: string; field_type: string; options: { value: string; label: string; active: boolean }[] };
type SavedView = { id: string; owner_user_id: string; name: string; scope: string; filters: Record<string, string> };
const labels = {
  ar: { search: 'بحث بالاسم أو الهاتف أو البريد أو رقم الفرصة', branch: 'الفرع', campaign: 'الحملة', agent: 'الوكيل', lifecycle: 'حالة الفرصة', source: 'المصدر', from: 'من تاريخ', to: 'إلى تاريخ', followup: 'المتابعة', field: 'حقل الحملة', value: 'قيمة الحقل', all: 'الكل', noFollowup: 'بلا متابعة مفتوحة', overdue: 'متابعة متأخرة', upcoming: 'متابعة قادمة', apply: 'تطبيق الفلاتر', reset: 'إزالة الفلاتر', views: 'المشاهد المحفوظة', viewName: 'اسم المشهد', saveView: 'حفظ المشهد', removeView: 'حذف المشهد', scope: 'النطاق', personal: 'شخصي', sharedBranch: 'مشترك في الفرع', sharedOrg: 'مشترك في المؤسسة', more: 'المزيد' },
  fr: { search: 'Nom, téléphone, e-mail ou ID', branch: 'Agence', campaign: 'Campagne', agent: 'Agent', lifecycle: 'Cycle', source: 'Source', from: 'Depuis', to: 'Jusqu’à', followup: 'Suivi', field: 'Champ', value: 'Valeur', all: 'Tous', noFollowup: 'Sans suivi ouvert', overdue: 'Suivi en retard', upcoming: 'Suivi à venir', apply: 'Appliquer', reset: 'Effacer', views: 'Vues enregistrées', viewName: 'Nom de la vue', saveView: 'Enregistrer la vue', removeView: 'Supprimer', scope: 'Portée', personal: 'Personnel', sharedBranch: 'Agence partagée', sharedOrg: 'Organisation partagée', more: 'Plus' },
  en: { search: 'Name, phone, email or lead ID', branch: 'Branch', campaign: 'Campaign', agent: 'Agent', lifecycle: 'Lifecycle', source: 'Source', from: 'From', to: 'To', followup: 'Follow-up', field: 'Campaign field', value: 'Field value', all: 'All', noFollowup: 'No open follow-up', overdue: 'Overdue follow-up', upcoming: 'Upcoming follow-up', apply: 'Apply filters', reset: 'Clear filters', views: 'Saved views', viewName: 'View name', saveView: 'Save view', removeView: 'Delete view', scope: 'Scope', personal: 'Personal', sharedBranch: 'Shared with branch', sharedOrg: 'Shared with organization', more: 'More' },
} as const;
type FilterKey = 'q'|'branchId'|'campaignId'|'assignedAgentId'|'lifecycle'|'sourceKind'|'from'|'to'|'followup'|'fieldId'|'fieldValue';
type Filter = Record<FilterKey, string>;
const empty: Filter = { q: '', branchId: '', campaignId: '', assignedAgentId: '', lifecycle: '', sourceKind: '', from: '', to: '', followup: '', fieldId: '', fieldValue: '' };

export function LeadSearch({ locale, branches, campaigns, users, currentUser, api, onSearch }: {
  locale: Locale; branches: Branch[]; campaigns: Campaign[]; users: User[];
  currentUser: { id: string; role: string; branchId: string | null }; api: Api;
  onSearch: (query: string) => Promise<void>;
}) {
  const t = labels[locale];
  const [form, setForm] = useState<Filter>(empty);
  const [fields, setFields] = useState<Field[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewCursor, setViewCursor] = useState<string | null>(null);
  const [viewName, setViewName] = useState('');
  const [viewScope, setViewScope] = useState<'PERSONAL'|'BRANCH'|'ORGANIZATION'>('PERSONAL');
  async function loadViews(cursor?: string) {
    const result = await api<{ items: SavedView[]; nextCursor: string | null }>(
      `/api/lead-views${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`);
    setViews((current) => cursor ? [...current, ...result.items] : result.items);
    setViewCursor(result.nextCursor);
  }
  useEffect(() => { void loadViews().catch((failure) => setError(String(failure))); }, [currentUser.id]);
  useEffect(() => {
    if (!form.campaignId) { setFields([]); return; }
    let cancelled = false;
    void api<{ items: Field[] }>(`/api/campaigns/${form.campaignId}/filter-fields`)
      .then((result) => { if (!cancelled) setFields(result.items); })
      .catch((failure) => { if (!cancelled) setError(String(failure)); });
    return () => { cancelled = true; };
  }, [form.campaignId]);
  const field = fields.find((item) => item.id === form.fieldId);
  const set = (key: FilterKey, value: string) => setForm((current) => ({ ...current, [key]: value,
    ...(key === 'campaignId' ? { fieldId: '', fieldValue: '' } : {}),
    ...(key === 'fieldId' ? { fieldValue: '' } : {}),
  }));
  const select = (key: FilterKey, title: string, values: { value: string; label: string }[]) =>
    <label>{title}<select value={form[key]} onChange={(event) => set(key, event.target.value)}>
      <option value="">{t.all}</option>{values.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>;
  function buildQuery(next: Filter) {
      const query = new URLSearchParams();
      for (const key of ['q','branchId','campaignId','assignedAgentId','lifecycle','sourceKind','followup'] as FilterKey[])
        if (next[key].trim()) query.set(key, next[key].trim());
      if (next.from) query.set('from', new Date(next.from).toISOString());
      if (next.to) query.set('to', new Date(next.to).toISOString());
      if (next.fieldId && next.fieldValue !== '') {
        query.set('fieldId', next.fieldId);
        const current = fields.find((item) => item.id === next.fieldId);
        const value = current?.field_type === 'NUMBER' || current?.field_type === 'PERCENTAGE' || current?.field_type === 'DURATION'
          ? Number(next.fieldValue) : current?.field_type === 'BOOLEAN' ? next.fieldValue === 'true' : next.fieldValue;
        query.set('fieldValue', JSON.stringify(value));
      }
      return query;
  }
  async function submit(next: Filter) {
    setBusy(true); setError('');
    try { await onSearch(buildQuery(next).toString()); }
    catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  async function saveView() {
    setBusy(true); setError('');
    try {
      const filters = Object.fromEntries(buildQuery(form).entries());
      await api('/api/lead-views', { method: 'POST', body: JSON.stringify({ name: viewName,
        scope: viewScope, ...(viewScope === 'BRANCH' && currentUser.role === 'SUPER_ADMIN' ? { branchId: form.branchId } : {}),
        filters, columns: [] }) });
      setViewName(''); await loadViews();
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  async function applyView(view: SavedView) {
    setBusy(true); setError('');
    try {
      const query = new URLSearchParams(view.filters);
      setForm({ ...empty, ...view.filters,
        fieldValue: view.filters.fieldValue ? String(JSON.parse(view.filters.fieldValue)) : '',
        from: view.filters.from ? new Date(view.filters.from).toISOString().slice(0, 16) : '',
        to: view.filters.to ? new Date(view.filters.to).toISOString().slice(0, 16) : '',
      });
      await onSearch(query.toString());
    }
    catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  return <section className="panel"><form className="lead-search-form" onSubmit={(event) => { event.preventDefault(); void submit(form); }}>
    <label>{t.search}<input value={form.q} maxLength={200} onChange={(event) => set('q', event.target.value)} /></label>
    {select('branchId', t.branch, branches.map((item) => ({ value: item.id, label: item.name })))}
    {select('campaignId', t.campaign, campaigns.filter((item) => !form.branchId || item.branch_id === form.branchId)
      .map((item) => ({ value: item.id, label: item.name })))}
    {select('assignedAgentId', t.agent, users.filter((item) => item.role === 'AGENT' && (!form.branchId || item.branch_id === form.branchId))
      .map((item) => ({ value: item.id, label: item.name })))}
    {select('lifecycle', t.lifecycle, ['OPEN','CLOSED','ARCHIVED'].map((value) => ({ value, label: value })))}
    {select('sourceKind', t.source, ['MANUAL','META','GENERIC_SOURCE'].map((value) => ({ value, label: value })))}
    {select('followup', t.followup, [{ value: 'NONE', label: t.noFollowup }, { value: 'OVERDUE', label: t.overdue },
      { value: 'UPCOMING', label: t.upcoming }])}
    <label>{t.from}<input type="datetime-local" value={form.from} onChange={(event) => set('from', event.target.value)} /></label>
    <label>{t.to}<input type="datetime-local" value={form.to} onChange={(event) => set('to', event.target.value)} /></label>
    {form.campaignId && select('fieldId', t.field, fields.map((item) => ({ value: item.id, label: item.label })))}
    {field && <label>{t.value}{field.options?.length ? <select value={form.fieldValue} onChange={(event) => set('fieldValue', event.target.value)}>
      <option value="">{t.all}</option>{field.options.filter((item) => item.active).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
      : field.field_type === 'BOOLEAN' ? <select value={form.fieldValue} onChange={(event) => set('fieldValue', event.target.value)}>
        <option value="">{t.all}</option><option value="true">true</option><option value="false">false</option></select>
      : <input value={form.fieldValue} onChange={(event) => set('fieldValue', event.target.value)} />}</label>}
    <button disabled={busy}>{t.apply}</button><button className="secondary" type="button" disabled={busy}
      onClick={() => { setForm(empty); void submit(empty); }}>{t.reset}</button>
  </form><div className="saved-view-controls"><h3>{t.views}</h3><div className="actions">
    {views.map((view) => <span key={view.id} className="saved-view-item"><button className="secondary" type="button" disabled={busy}
      onClick={() => void applyView(view)}>{view.name}</button>{view.owner_user_id === currentUser.id && <button className="link"
      disabled={busy} onClick={() => { setBusy(true); void api(`/api/lead-views/${view.id}`, { method: 'DELETE' })
        .then(() => loadViews()).catch((failure) => setError(String(failure))).finally(() => setBusy(false)); }}>{t.removeView}</button>}</span>)}
    {viewCursor && <button className="secondary" onClick={() => void loadViews(viewCursor).catch((failure) => setError(String(failure)))}>{t.more}</button>}
  </div><form className="lead-search-form" onSubmit={(event) => { event.preventDefault(); void saveView(); }}>
    <label>{t.viewName}<input required maxLength={100} value={viewName} onChange={(event) => setViewName(event.target.value)} /></label>
    <label>{t.scope}<select value={viewScope} onChange={(event) => setViewScope(event.target.value as typeof viewScope)}>
      <option value="PERSONAL">{t.personal}</option>{currentUser.role !== 'AGENT' && <option value="BRANCH">{t.sharedBranch}</option>}
      {currentUser.role === 'SUPER_ADMIN' && <option value="ORGANIZATION">{t.sharedOrg}</option>}</select></label>
    <button disabled={busy}>{t.saveView}</button>
  </form></div>{error && <p role="alert" className="error">{error}</p>}</section>;
}
