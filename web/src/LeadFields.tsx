import { useEffect, useState } from 'react';

export type FieldOption = { value: string; label: string; active: boolean };
export type FieldRow = { id: string; field_id?: string; key: string; label: string; field_type: string; value_mode: string;
  options: FieldOption[]; validation: { currency?: string }; value?: unknown; value_version?: number | null; editable?: boolean;
  required_stage?: string; show_in_details?: boolean; active?: boolean; binding_active?: boolean; definition_active?: boolean;
  editable_by_manager?: boolean };
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Locale = 'ar'|'fr'|'en';
type HistoryItem = { id: number; old_value: unknown; new_value: unknown; source: string; created_at: string };

const labels = {
  ar: { title: 'حقول الحملة', save: 'حفظ القيمة', history: 'التاريخ', noData: 'لا توجد حقول لهذه الحملة.', empty: 'بدون قيمة', source: 'المصدر', old: 'القيمة السابقة', next: 'القيمة الجديدة', required: 'مطلوب عند', readOnly: 'للقراءة فقط' },
  fr: { title: 'Champs de campagne', save: 'Enregistrer', history: 'Historique', noData: 'Aucun champ pour cette campagne.', empty: 'Sans valeur', source: 'Source', old: 'Ancienne valeur', next: 'Nouvelle valeur', required: 'Requis à', readOnly: 'Lecture seule' },
  en: { title: 'Campaign fields', save: 'Save value', history: 'History', noData: 'No fields for this campaign.', empty: 'No value', source: 'Source', old: 'Previous value', next: 'New value', required: 'Required at', readOnly: 'Read only' },
} as const;

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function FieldInput({ field, value, onChange,ariaLabel,booleanLabels }: { field: FieldRow; value: unknown; onChange: (value: unknown) => void;ariaLabel?:string;booleanLabels?:{ yes:string;no:string } }) {
  const type = field.field_type;
  if (type === 'CALCULATED') return <strong>{formatValue(value)}</strong>;
  if (['SINGLE_SELECT','STATUS','INTEREST','BOOLEAN'].includes(type)) return <select aria-label={ariaLabel} value={value === null || value === undefined ? '' : String(value)} onChange={(event) => onChange(event.target.value === '' ? null : type === 'BOOLEAN' ? event.target.value === 'true' : event.target.value)}>
    <option value="">—</option>{type === 'BOOLEAN' ? <><option value="true">{booleanLabels?.yes ?? 'Yes'}</option><option value="false">{booleanLabels?.no ?? 'No'}</option></>
      : field.options.filter((option) => option.active || option.value === value).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  if (type === 'MULTI_SELECT') return <select aria-label={ariaLabel} multiple value={Array.isArray(value) ? value.map(String) : []} onChange={(event) => onChange(Array.from(event.target.selectedOptions, (option) => option.value))}>
    {field.options.filter((option) => option.active || Array.isArray(value) && value.includes(option.value)).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  if (type === 'TAGS') return <input aria-label={ariaLabel} value={Array.isArray(value) ? value.join(', ') : ''} onChange={(event) => onChange(event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean))} />;
  if (type === 'CURRENCY') return <div className="currency-field"><input aria-label={ariaLabel} type="number" step="any" value={value && typeof value === 'object' && 'amount' in value ? String(value.amount) : ''}
    onChange={(event) => onChange(event.target.value === '' ? null : { amount: Number(event.target.value), currency: field.validation.currency })} /><span>{field.validation.currency}</span></div>;
  if (type === 'LONG_TEXT') return <textarea aria-label={ariaLabel} value={value === null || value === undefined ? '' : String(value)} onChange={(event) => onChange(event.target.value || null)} />;
  const htmlType = ['NUMBER','PERCENTAGE','DURATION'].includes(type) ? 'number' : type === 'PHONE' ? 'tel' : type === 'EMAIL' ? 'email' :
    type === 'DATE' ? 'date' : type === 'TIME' ? 'time' : type === 'DATETIME' ? 'datetime-local' : type === 'URL' ? 'url' : 'text';
  const display = type === 'DATETIME' && typeof value === 'string'
    ? Number.isNaN(new Date(value).getTime()) ? value : new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    : value === null || value === undefined ? '' : String(value);
  return <input aria-label={ariaLabel} type={htmlType} step={htmlType === 'number' ? 'any' : undefined} value={display} onChange={(event) => {
    const raw = event.target.value;
    onChange(raw === '' ? null : htmlType === 'number' ? Number(raw) : raw);
  }} />;
}

export function LeadFields({ leadId, locale, api }: { leadId: string; locale: Locale; api: Api }) {
  const t = labels[locale];
  const [fields, setFields] = useState<FieldRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [history, setHistory] = useState<{ fieldId: string; items: HistoryItem[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function reload() {
    const result = await api<{ items: FieldRow[] }>(`/api/leads/${leadId}/fields`);
    setFields(result.items);
    setDrafts(Object.fromEntries(result.items.map((field) => [field.id, field.value ?? null])));
  }
  useEffect(() => { void reload().catch((failure) => setError(String(failure))); }, [leadId]);
  async function save(field: FieldRow) {
    setBusy(true); setError('');
    try {
      const raw = drafts[field.id] ?? null;
      const value = field.field_type === 'DATETIME' && typeof raw === 'string' ? new Date(raw).toISOString() : raw;
      await api(`/api/leads/${leadId}/fields/${field.id}`, { method: 'PUT', body: JSON.stringify({ value,
        ...(field.value_version ? { version: field.value_version } : {}) }) });
      await reload();
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  async function showHistory(field: FieldRow) {
    setBusy(true); setError('');
    try {
      const result = await api<{ items: HistoryItem[] }>(
        `/api/leads/${leadId}/fields/${field.id}/history`);
      setHistory({ fieldId: field.id, items: result.items });
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  return <section className="lead-fields"><h3>{t.title}</h3>{error && <div role="alert" className="error">{error}</div>}
    {fields.filter((field) => field.show_in_details).length === 0 && <p>{t.noData}</p>}
    {fields.filter((field) => field.show_in_details).map((field) => <div className="lead-field" key={field.id}>
      <label>{field.label}{field.required_stage !== 'NONE' && <small>{t.required}: {field.required_stage}</small>}
        {field.editable ? <FieldInput field={field} value={drafts[field.id]} onChange={(value) => setDrafts((current) => ({ ...current, [field.id]: value }))} />
          : <strong>{formatValue(field.value)}</strong>}</label>
      <div className="actions">{field.editable && <button disabled={busy} onClick={() => void save(field)}>{t.save}</button>}
        <button className="link" disabled={busy} onClick={() => void showHistory(field)}>{t.history}</button></div>
    </div>)}
    {history && <div className="panel"><h4>{t.history}: {fields.find((field) => field.id === history.fieldId)?.label}</h4>
      <ul className="timeline">{history.items.map((item) => <li key={item.id}><span>{t.old}: {formatValue(item.old_value)} → {t.next}: {formatValue(item.new_value)}<small>{t.source}: {item.source}</small></span>
        <time>{new Date(item.created_at).toLocaleString(locale)}</time></li>)}</ul></div>}
  </section>;
}

export function LeadCreationFields({ campaignId, locale, api, values, onChange }: { campaignId: string; locale: Locale; api: Api;
  values: Record<string, unknown>; onChange: (values: Record<string, unknown>) => void }) {
  const [fields, setFields] = useState<FieldRow[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!campaignId) { setFields([]); return; }
    void api<{ items: FieldRow[] }>(`/api/campaigns/${campaignId}/fields`).then((result) => setFields(result.items.filter((field) =>
      field.active && field.definition_active && field.value_mode === 'MANUAL' && field.editable_by_manager))).catch((failure) => setError(String(failure)));
  }, [campaignId]);
  return <div className="creation-fields">{error && <div role="alert" className="error">{error}</div>}
    {fields.map((field) => <label key={field.field_id}>{field.label}{field.required_stage === 'LEAD_CREATION' ? ' *' : ''}
      <FieldInput field={field} value={values[field.field_id!]} onChange={(value) => onChange({ ...values,
        [field.field_id!]: field.field_type === 'DATETIME' && typeof value === 'string' && !Number.isNaN(new Date(value).getTime())
          ? new Date(value).toISOString() : value })} />
    </label>)}
    {fields.length > 0 && <small>{labels[locale].title}</small>}
  </div>;
}
