import { useEffect, useState } from 'react';
import type { FieldOption } from './LeadFields.js';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Locale = 'ar'|'fr'|'en';
type Campaign = { id: string; branch_id: string; name: string };
type Definition = { id: string; key: string; label: string; description: string | null; field_type: string; value_mode: string;
  options: FieldOption[]; validation: Record<string, number | string>; calculation: { kind: string } | null; active: boolean; version: number;
  branch_id: string | null; campaign_id: string | null };
type Binding = { field_id: string; version: number; active: boolean; position: number; required_stage: string;
  visible_to_agent: boolean; editable_by_agent: boolean; visible_to_manager: boolean; editable_by_manager: boolean;
  show_in_table: boolean; show_in_details: boolean; filterable: boolean; usable_by_automation: boolean; usable_by_ai: boolean };
type BindingForm = { active: boolean; position: number; requiredStage: string; visibleToAgent: boolean; editableByAgent: boolean;
  visibleToManager: boolean; editableByManager: boolean; showInTable: boolean; showInDetails: boolean; filterable: boolean;
  usableByAutomation: boolean; usableByAi: boolean; version?: number };
const types = ['TEXT','LONG_TEXT','NUMBER','PHONE','EMAIL','DATE','TIME','DATETIME','SINGLE_SELECT','MULTI_SELECT','BOOLEAN',
  'STATUS','INTEREST','TAGS','CURRENCY','PERCENTAGE','DURATION','URL','CALCULATED'];
const calculations = ['LEAD_AGE_DAYS','FIRST_PLATFORM_CONTACT_AT','FIRST_AI_CONTACT_AT','FIRST_HUMAN_CONTACT_AT',
  'TIME_SINCE_LAST_CONTACT_SECONDS','AI_CONTACT_ATTEMPTS','HUMAN_CONTACT_ATTEMPTS','HUMAN_RESPONSE_SECONDS'];
const labels = {
  ar: { campaign: 'الحملة', choose: 'اختر', create: 'إنشاء حقل', key: 'المفتاح', label: 'العنوان', description: 'الوصف', type: 'النوع', mode: 'طريقة القيمة', scope: 'النطاق', options: 'الخيارات', optionValue: 'القيمة', optionLabel: 'العنوان', addOption: 'إضافة خيار', remove: 'إزالة', save: 'حفظ', definitions: 'الحقول المتاحة', binding: 'إعداد الحملة', edit: 'تعديل التعريف', more: 'تحميل المزيد', noData: 'لا توجد حقول.', active: 'نشط', position: 'الترتيب', required: 'مطلوب عند', agentVisible: 'مرئي للوكيل', agentEditable: 'قابل لتعديل الوكيل', managerVisible: 'مرئي للمدير', managerEditable: 'قابل لتعديل المدير', table: 'في الجدول', details: 'في التفاصيل', filter: 'قابل للتصفية', automation: 'متاح للأتمتة', ai: 'متاح للـAI', minLength: 'أقصر طول', maxLength: 'أطول طول', min: 'أصغر قيمة', max: 'أكبر قيمة', currency: 'رمز العملة', calculation: 'الحساب', configured: 'مرتبط بالحملة' },
  fr: { campaign: 'Campagne', choose: 'Choisir', create: 'Créer un champ', key: 'Clé', label: 'Libellé', description: 'Description', type: 'Type', mode: 'Mode de valeur', scope: 'Portée', options: 'Options', optionValue: 'Valeur', optionLabel: 'Libellé', addOption: 'Ajouter une option', remove: 'Supprimer', save: 'Enregistrer', definitions: 'Champs disponibles', binding: 'Configuration de campagne', edit: 'Modifier la définition', more: 'Afficher plus', noData: 'Aucun champ.', active: 'Actif', position: 'Ordre', required: 'Requis à', agentVisible: 'Visible par agent', agentEditable: 'Modifiable par agent', managerVisible: 'Visible par responsable', managerEditable: 'Modifiable par responsable', table: 'Dans le tableau', details: 'Dans les détails', filter: 'Filtrable', automation: 'Pour automatisation', ai: 'Pour IA', minLength: 'Longueur min.', maxLength: 'Longueur max.', min: 'Valeur min.', max: 'Valeur max.', currency: 'Devise', calculation: 'Calcul', configured: 'Lié à la campagne' },
  en: { campaign: 'Campaign', choose: 'Choose', create: 'Create field', key: 'Key', label: 'Label', description: 'Description', type: 'Type', mode: 'Value mode', scope: 'Scope', options: 'Options', optionValue: 'Value', optionLabel: 'Label', addOption: 'Add option', remove: 'Remove', save: 'Save', definitions: 'Available fields', binding: 'Campaign configuration', edit: 'Edit definition', more: 'Load more', noData: 'No fields.', active: 'Active', position: 'Order', required: 'Required at', agentVisible: 'Visible to agent', agentEditable: 'Agent editable', managerVisible: 'Visible to manager', managerEditable: 'Manager editable', table: 'In table', details: 'In details', filter: 'Filterable', automation: 'For automation', ai: 'For AI', minLength: 'Min length', maxLength: 'Max length', min: 'Minimum', max: 'Maximum', currency: 'Currency code', calculation: 'Calculation', configured: 'Bound to campaign' },
} as const;
const defaultBinding: BindingForm = { active: true, position: 0, requiredStage: 'NONE', visibleToAgent: true,
  editableByAgent: true, visibleToManager: true, editableByManager: true, showInTable: false, showInDetails: true,
  filterable: false, usableByAutomation: false, usableByAi: false };

export function FieldWorkspace({ locale, campaigns, role, api }: { locale: Locale; campaigns: Campaign[]; role: string; api: Api }) {
  const t = labels[locale];
  const [campaignId, setCampaignId] = useState('');
  const campaign = campaigns.find((item) => item.id === campaignId);
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [create, setCreate] = useState({ scope: 'CAMPAIGN', key: '', label: '', description: '', fieldType: 'TEXT', valueMode: 'MANUAL', calculation: 'LEAD_AGE_DAYS' });
  const [options, setOptions] = useState<FieldOption[]>([]);
  const [validation, setValidation] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Definition | null>(null);
  const [bindingField, setBindingField] = useState<Definition | null>(null);
  const [bindingForm, setBindingForm] = useState<BindingForm>(defaultBinding);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function reload(next: string | null = null) {
    if (!campaignId) return;
    setBusy(true); setError('');
    try {
      const params = new URLSearchParams({ campaignId, limit: '100' });
      if (next) params.set('cursor', next);
      const definitionsResult = await api<{ items: Definition[]; nextCursor: string | null }>(`/api/fields?${params}`);
      const bindingsResult = await api<{ items: Binding[] }>(`/api/campaigns/${campaignId}/fields`);
      setDefinitions((current) => next ? [...current, ...definitionsResult.items] : definitionsResult.items);
      setCursor(definitionsResult.nextCursor);
      setBindings(bindingsResult.items);
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  useEffect(() => { setDefinitions([]); setBindings([]); setCursor(null); void reload(); }, [campaignId]);

  function validatedOptions(): FieldOption[] { return options.filter((option) => option.value.trim() && option.label.trim()); }
  function validatedConfig(type: string) {
    const result: Record<string, number | string> = {};
    for (const key of ['minLength','maxLength','min','max']) if (validation[key]) result[key] = Number(validation[key]);
    if (type === 'CURRENCY' && validation.currency) result.currency = validation.currency.toUpperCase();
    return result;
  }
  async function createField() {
    if (!campaign) return;
    setBusy(true); setError('');
    try {
      const type = create.fieldType;
      const valueMode = type === 'CALCULATED' ? 'CALCULATED' : create.valueMode;
      const scope = create.scope;
      await api('/api/fields', { method: 'POST', body: JSON.stringify({ scope,
        ...(scope === 'GLOBAL' ? {} : { branchId: campaign.branch_id }), ...(scope === 'CAMPAIGN' ? { campaignId } : {}),
        key: create.key, label: create.label, description: create.description, fieldType: type, valueMode,
        options: ['SINGLE_SELECT','MULTI_SELECT','STATUS','INTEREST','TAGS'].includes(type) ? validatedOptions() : [],
        validation: validatedConfig(type), calculation: type === 'CALCULATED' ? { kind: create.calculation } : null }) });
      setCreate({ ...create, key: '', label: '', description: '' }); setOptions([]); setValidation({}); await reload();
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  async function saveDefinition() {
    if (!editing) return;
    setBusy(true); setError('');
    try {
      await api(`/api/fields/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ version: editing.version, label: editing.label,
        description: editing.description, options: editing.options, validation: editing.validation, active: editing.active,
        fieldType: editing.field_type, valueMode: editing.field_type === 'CALCULATED' ? 'CALCULATED' : editing.value_mode,
        calculation: editing.field_type === 'CALCULATED' ? editing.calculation : null }) });
      setEditing(null); await reload();
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  function openBinding(field: Definition) {
    const row = bindings.find((item) => item.field_id === field.id);
    setBindingField(field);
    setBindingForm(row ? { version: row.version, active: row.active, position: row.position, requiredStage: row.required_stage,
      visibleToAgent: row.visible_to_agent, editableByAgent: row.editable_by_agent, visibleToManager: row.visible_to_manager,
      editableByManager: row.editable_by_manager, showInTable: row.show_in_table, showInDetails: row.show_in_details,
      filterable: row.filterable, usableByAutomation: row.usable_by_automation, usableByAi: row.usable_by_ai } :
      { ...defaultBinding, editableByAgent: field.value_mode === 'MANUAL', editableByManager: field.value_mode === 'MANUAL', position: bindings.length });
  }
  async function saveBinding() {
    if (!bindingField || !campaignId) return;
    setBusy(true); setError('');
    try {
      await api(`/api/campaigns/${campaignId}/fields/${bindingField.id}`, { method: 'PUT', body: JSON.stringify(bindingForm) });
      setBindingField(null); await reload();
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  const isSelect = ['SINGLE_SELECT','MULTI_SELECT','STATUS','INTEREST','TAGS'].includes(create.fieldType);
  const input = (key: string, label: string) => <label>{label}<input value={create[key as keyof typeof create]} onChange={(event) => setCreate({ ...create, [key]: event.target.value })} /></label>;
  const checkbox = (key: keyof BindingForm, label: string) => <label className="check-row"><input type="checkbox" checked={Boolean(bindingForm[key])}
    onChange={(event) => setBindingForm({ ...bindingForm, [key]: event.target.checked })} />{label}</label>;
  function setEditValidation(key: string, raw: string) {
    if (!editing) return;
    const next = { ...editing.validation };
    if (!raw) delete next[key];
    else next[key] = key === 'currency' ? raw.toUpperCase() : Number(raw);
    setEditing({ ...editing, validation: next });
  }
  return <section className="field-workspace">
    {error && <div role="alert" className="error">{error}</div>}
    <section className="panel"><label>{t.campaign}<select value={campaignId} onChange={(event) => setCampaignId(event.target.value)}>
      <option value="">{t.choose}</option>{campaigns.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></section>
    {campaign && <><section className="panel"><h2>{t.create}</h2><form className="field-form" onSubmit={(event) => { event.preventDefault(); void createField(); }}>
      <label>{t.scope}<select value={create.scope} onChange={(event) => setCreate({ ...create, scope: event.target.value })}>
        {role === 'SUPER_ADMIN' && <option value="GLOBAL">GLOBAL</option>}<option value="BRANCH">BRANCH</option><option value="CAMPAIGN">CAMPAIGN</option></select></label>
      {input('key', t.key)}{input('label', t.label)}{input('description', t.description)}
      <label>{t.type}<select value={create.fieldType} onChange={(event) => setCreate({ ...create, fieldType: event.target.value })}>
        {types.map((type) => <option key={type}>{type}</option>)}</select></label>
      {create.fieldType === 'CALCULATED' ? <label>{t.calculation}<select value={create.calculation} onChange={(event) => setCreate({ ...create, calculation: event.target.value })}>
        {calculations.map((kind) => <option key={kind}>{kind}</option>)}</select></label> :
        <label>{t.mode}<select value={create.valueMode} onChange={(event) => setCreate({ ...create, valueMode: event.target.value })}>
          {['MANUAL','SOURCE','SYSTEM'].map((mode) => <option key={mode}>{mode}</option>)}</select></label>}
      {create.fieldType === 'CURRENCY' && <label>{t.currency}<input maxLength={3} value={validation.currency ?? ''} onChange={(event) => setValidation({ ...validation, currency: event.target.value })} /></label>}
      {['minLength','maxLength','min','max'].map((key) => <label key={key}>{t[key as 'minLength'|'maxLength'|'min'|'max']}<input type="number" value={validation[key] ?? ''}
        onChange={(event) => setValidation({ ...validation, [key]: event.target.value })} /></label>)}
      {isSelect && <div className="field-options"><h3>{t.options}</h3>{options.map((option, index) => <div className="option-row" key={index}>
        <input aria-label={t.optionValue} placeholder={t.optionValue} value={option.value} onChange={(event) => setOptions(options.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} />
        <input aria-label={t.optionLabel} placeholder={t.optionLabel} value={option.label} onChange={(event) => setOptions(options.map((item, i) => i === index ? { ...item, label: event.target.value } : item))} />
        <label className="check-row"><input type="checkbox" checked={option.active} onChange={(event) => setOptions(options.map((item, i) => i === index ? { ...item, active: event.target.checked } : item))} />{t.active}</label>
        <button type="button" className="secondary" disabled={index === 0} onClick={() => { const next = [...options]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; setOptions(next); }}>↑</button>
        <button type="button" className="secondary" disabled={index === options.length - 1} onClick={() => { const next = [...options]; [next[index], next[index + 1]] = [next[index + 1]!, next[index]!]; setOptions(next); }}>↓</button>
        <button type="button" className="secondary" onClick={() => setOptions(options.filter((_, i) => i !== index))}>{t.remove}</button></div>)}
        <button type="button" className="secondary" onClick={() => setOptions([...options, { value: '', label: '', active: true }])}>{t.addOption}</button></div>}
      <button disabled={busy || !create.key || !create.label}>{t.create}</button>
    </form></section>
    <section className="panel"><h2>{t.definitions}</h2>{definitions.length === 0 && <p>{t.noData}</p>}
      <div className="table-scroll"><table><thead><tr><th>{t.key}</th><th>{t.label}</th><th>{t.type}</th><th>{t.scope}</th><th>{t.configured}</th><th>{t.active}</th><th>{t.edit}</th></tr></thead><tbody>
        {definitions.map((field) => <tr key={field.id}><td>{field.key}</td><td>{field.label}</td><td>{field.field_type}</td>
          <td>{field.campaign_id ? 'CAMPAIGN' : field.branch_id ? 'BRANCH' : 'GLOBAL'}</td><td>{bindings.some((item) => item.field_id === field.id && item.active) ? '✓' : '—'}</td>
          <td>{field.active ? '✓' : '—'}</td><td><div className="actions"><button className="link" onClick={() => openBinding(field)}>{t.binding}</button>
          {(role === 'SUPER_ADMIN' || field.branch_id) && <button className="link" onClick={() => setEditing({ ...field })}>{t.edit}</button>}</div></td></tr>)}</tbody></table></div>
      {cursor && <button className="secondary" disabled={busy} onClick={() => void reload(cursor)}>{t.more}</button>}
    </section>
    {editing && <section className="panel"><h2>{t.edit}: {editing.key}</h2><form className="field-form" onSubmit={(event) => { event.preventDefault(); void saveDefinition(); }}>
      <label>{t.label}<input value={editing.label} onChange={(event) => setEditing({ ...editing, label: event.target.value })} /></label>
      <label>{t.description}<input value={editing.description ?? ''} onChange={(event) => setEditing({ ...editing, description: event.target.value })} /></label>
      <label>{t.type}<select value={editing.field_type} onChange={(event) => setEditing({ ...editing, field_type: event.target.value,
        value_mode: event.target.value === 'CALCULATED' ? 'CALCULATED' : editing.value_mode === 'CALCULATED' ? 'MANUAL' : editing.value_mode,
        calculation: event.target.value === 'CALCULATED' ? { kind: 'LEAD_AGE_DAYS' } : null, options: [],
        validation: event.target.value === 'CURRENCY' ? editing.validation : Object.fromEntries(Object.entries(editing.validation).filter(([key]) => key !== 'currency')) })}>
        {types.map((type) => <option key={type}>{type}</option>)}</select></label>
      {editing.field_type === 'CALCULATED' ? <label>{t.calculation}<select value={editing.calculation?.kind ?? 'LEAD_AGE_DAYS'}
        onChange={(event) => setEditing({ ...editing, calculation: { kind: event.target.value } })}>{calculations.map((kind) => <option key={kind}>{kind}</option>)}</select></label>
        : <label>{t.mode}<select value={editing.value_mode} onChange={(event) => setEditing({ ...editing, value_mode: event.target.value })}>
          {['MANUAL','SOURCE','SYSTEM'].map((mode) => <option key={mode}>{mode}</option>)}</select></label>}
      <label className="check-row"><input type="checkbox" checked={editing.active} onChange={(event) => setEditing({ ...editing, active: event.target.checked })} />{t.active}</label>
      {editing.field_type === 'CURRENCY' && <label>{t.currency}<input maxLength={3} value={editing.validation.currency ?? ''} onChange={(event) => setEditValidation('currency', event.target.value)} /></label>}
      {['minLength','maxLength','min','max'].map((key) => <label key={key}>{t[key as 'minLength'|'maxLength'|'min'|'max']}<input type="number" value={editing.validation[key] ?? ''}
        onChange={(event) => setEditValidation(key, event.target.value)} /></label>)}
      {['SINGLE_SELECT','MULTI_SELECT','STATUS','INTEREST','TAGS'].includes(editing.field_type) && <div className="field-options"><h3>{t.options}</h3>
        {editing.options.map((option, index) => <div className="option-row" key={index}>
          <input aria-label={t.optionValue} value={option.value} onChange={(event) => setEditing({ ...editing, options: editing.options.map((item, i) => i === index ? { ...item, value: event.target.value } : item) })} />
          <input aria-label={t.optionLabel} value={option.label} onChange={(event) => setEditing({ ...editing, options: editing.options.map((item, i) => i === index ? { ...item, label: event.target.value } : item) })} />
          <label className="check-row"><input type="checkbox" checked={option.active} onChange={(event) => setEditing({ ...editing, options: editing.options.map((item, i) => i === index ? { ...item, active: event.target.checked } : item) })} />{t.active}</label>
          <button type="button" className="secondary" disabled={index === 0} onClick={() => { const next = [...editing.options]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; setEditing({ ...editing, options: next }); }}>↑</button>
          <button type="button" className="secondary" disabled={index === editing.options.length - 1} onClick={() => { const next = [...editing.options]; [next[index], next[index + 1]] = [next[index + 1]!, next[index]!]; setEditing({ ...editing, options: next }); }}>↓</button>
        </div>)}<button type="button" className="secondary" onClick={() => setEditing({ ...editing, options: [...editing.options, { value: '', label: '', active: true }] })}>{t.addOption}</button></div>}
      <button disabled={busy}>{t.save}</button></form></section>}
    {bindingField && <section className="panel"><h2>{t.binding}: {bindingField.label}</h2><form className="field-form" onSubmit={(event) => { event.preventDefault(); void saveBinding(); }}>
      <label>{t.position}<input type="number" min={0} value={bindingForm.position} onChange={(event) => setBindingForm({ ...bindingForm, position: Number(event.target.value) })} /></label>
      <label>{t.required}<select value={bindingForm.requiredStage} onChange={(event) => setBindingForm({ ...bindingForm, requiredStage: event.target.value })}>
        {['NONE','LEAD_CREATION','CLOSE','ENROLLMENT'].map((stage) => <option key={stage}>{stage}</option>)}</select></label>
      {checkbox('active', t.active)}{checkbox('visibleToAgent', t.agentVisible)}{checkbox('editableByAgent', t.agentEditable)}
      {checkbox('visibleToManager', t.managerVisible)}{checkbox('editableByManager', t.managerEditable)}
      {checkbox('showInTable', t.table)}{checkbox('showInDetails', t.details)}{checkbox('filterable', t.filter)}
      {checkbox('usableByAutomation', t.automation)}{checkbox('usableByAi', t.ai)}
      <button disabled={busy}>{t.save}</button></form></section>}
    </>}
  </section>;
}
