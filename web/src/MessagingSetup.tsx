import { useEffect, useState } from 'react';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Locale = 'ar'|'fr'|'en';
type Branch = { id: string; name: string };
type Connection = { id: string; branch_id: string | null; name: string; provider: string; status: string;
  version: number; config: { wabaId: string; graphVersion: string }; has_credential: boolean;
  last_success_at: string | null; last_failure_at: string | null; last_error_code: string | null };
type Sender = { id: string; external_sender_id: string; display_name: string; health: string; active: boolean;
  provider_status: { qualityRating?: string | null } };
const labels = {
  ar: { title: 'اتصالات الرسائل', explain: 'أنشئ Meta Business Portfolio وWhatsApp Business Account وتطبيق Meta، واحصل على WABA ID ورمز وصول System User وApp Secret. أدخلها هنا واختبر اكتشاف الأرقام. يجب لاحقًا إعداد Webhook واختبار الإرسال قبل تشغيل الرسائل.', add: 'إضافة اتصال', edit: 'تعديل الاتصال', name: 'اسم الاتصال', scope: 'النطاق', organization: 'المؤسسة', branch: 'الفرع', version: 'إصدار Graph API', waba: 'WABA ID', token: 'رمز الوصول', appSecret: 'App Secret', verifyToken: 'Webhook Verify Token', save: 'حفظ', test: 'اختبار واكتشاف الأرقام', disable: 'تعطيل', enable: 'إعادة التهيئة', senders: 'الأرقام المكتشفة', status: 'الحالة', noSenders: 'لا أرقام مكتشفة', noConnections: 'لا اتصالات', more: 'المزيد', warning: 'اكتشاف الأرقام نجح؛ الإرسال والـWebhook غير متحققين بعد.', existingSecret: 'اترك حقول السر فارغة للاحتفاظ بالبيانات المحفوظة؛ لا تُعرض بعد الحفظ.' },
  fr: { title: 'Connexions de messagerie', explain: 'Créez un compte WhatsApp Business et une application Meta, puis obtenez le WABA ID, un jeton System User et le secret de l’application. Configurez-les ici. L’envoi et le webhook doivent être vérifiés séparément.', add: 'Ajouter', edit: 'Modifier', name: 'Nom', scope: 'Portée', organization: 'Organisation', branch: 'Agence', version: 'Version Graph API', waba: 'WABA ID', token: 'Jeton d’accès', appSecret: 'Secret de l’application', verifyToken: 'Jeton de vérification', save: 'Enregistrer', test: 'Tester et découvrir les numéros', disable: 'Désactiver', enable: 'Réactiver', senders: 'Numéros découverts', status: 'État', noSenders: 'Aucun numéro', noConnections: 'Aucune connexion', more: 'Plus', warning: 'Numéros découverts ; envoi et webhook non encore vérifiés.', existingSecret: 'Laissez les secrets vides pour conserver ceux enregistrés ; ils ne sont pas réaffichés.' },
  en: { title: 'Messaging connections', explain: 'Create a Meta Business Portfolio, WhatsApp Business Account, and Meta app. Obtain the WABA ID, System User access token, and App Secret. Enter them here and discover senders. Webhook and outbound sending require separate verification.', add: 'Add connection', edit: 'Edit connection', name: 'Connection name', scope: 'Scope', organization: 'Organization', branch: 'Branch', version: 'Graph API version', waba: 'WABA ID', token: 'Access token', appSecret: 'App Secret', verifyToken: 'Webhook Verify Token', save: 'Save', test: 'Test and discover senders', disable: 'Disable', enable: 'Reconfigure', senders: 'Discovered senders', status: 'Status', noSenders: 'No senders discovered', noConnections: 'No connections', more: 'More', warning: 'Sender discovery succeeded; outbound sending and webhook are not yet verified.', existingSecret: 'Leave secrets blank to retain saved values; they are never displayed after saving.' },
} as const;

export function MessagingSetup({ locale, role, branchId, branches, api }: {
  locale: Locale; role: 'SUPER_ADMIN'|'MANAGER'; branchId: string | null; branches: Branch[]; api: Api;
}) {
  const t = labels[locale];
  const [items, setItems] = useState<Connection[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Connection | null>(null);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', branchId: role === 'MANAGER' ? branchId ?? '' : '',
    wabaId: '', graphVersion: '', accessToken: '', appSecret: '', verifyToken: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function load(next?: string) {
    const page = await api<{ items: Connection[]; nextCursor: string | null }>(
      `/api/messaging/connections${next ? '?cursor=' + encodeURIComponent(next) : ''}`);
    setItems((current) => next ? [...current, ...page.items] : page.items);
    setCursor(page.nextCursor);
    if (selected && !next) setSelected(page.items.find((item) => item.id === selected.id) ?? null);
    return page;
  }
  useEffect(() => { void load().catch((failure) => setError(String(failure))); }, []);
  async function choose(connection: Connection) {
    setSelected(connection); setEditing(false); setError('');
    try { setSenders((await api<{ items: Sender[] }>(`/api/messaging/connections/${connection.id}/senders`)).items); }
    catch (failure) { setError(String(failure)); }
  }
  const set = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  async function save() {
    setBusy(true); setError('');
    try {
      const credentialsFilled = [form.accessToken, form.appSecret, form.verifyToken].every(Boolean);
      const credentialsEmpty = [form.accessToken, form.appSecret, form.verifyToken].every((value) => !value);
      if (!credentialsFilled && !credentialsEmpty) throw new Error('All credential fields are required when replacing credentials');
      if (!selected && !credentialsFilled) throw new Error('Credentials are required');
      const payload = { name: form.name, config: { wabaId: form.wabaId, graphVersion: form.graphVersion },
        ...(selected ? { version: selected.version } : role === 'SUPER_ADMIN' && form.branchId ? { branchId: form.branchId } : {}),
        ...(credentialsFilled ? { credentials: { accessToken: form.accessToken, appSecret: form.appSecret,
          verifyToken: form.verifyToken } } : {}),
      };
      await api(selected ? `/api/messaging/connections/${selected.id}` : '/api/messaging/connections', {
        method: selected ? 'PUT' : 'POST', body: JSON.stringify(payload),
      });
      setForm((current) => ({ ...current, accessToken: '', appSecret: '', verifyToken: '' }));
      setEditing(false); await load();
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  async function action(connection: Connection, operation: 'test'|'disable'|'enable') {
    setBusy(true); setError('');
    try {
      await api(`/api/messaging/connections/${connection.id}/${operation === 'test' ? 'test' : 'status'}`, {
        method: operation === 'test' ? 'POST' : 'PATCH',
        ...(operation === 'test' ? {} : { body: JSON.stringify({ version: connection.version, disabled: operation === 'disable' }) }),
      });
      const page = await load();
      const current = page.items.find((item) => item.id === connection.id);
      if (selected?.id === connection.id && current) await choose(current);
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  return <section className="panel"><h2>{t.title}</h2><p>{t.explain} <a href="https://www.postman.com/meta/whatsapp-business-platform/request/e9ady51/get-phone-numbers" target="_blank" rel="noreferrer">Meta API reference</a></p>
    {error && <p role="alert" className="error">{error}</p>}
    <button className="secondary" onClick={() => { setSelected(null); setEditing(true); setForm({ name: '', branchId: role === 'MANAGER' ? branchId ?? '' : '', wabaId: '', graphVersion: '', accessToken: '', appSecret: '', verifyToken: '' }); }}>{t.add}</button>
    <div className="table-scroll"><table><thead><tr><th>{t.name}</th><th>{t.scope}</th><th>{t.status}</th><th></th></tr></thead><tbody>{items.map((item) =>
      <tr key={item.id}><td>{item.name}</td><td>{item.branch_id ? branches.find((branch) => branch.id === item.branch_id)?.name ?? item.branch_id : t.organization}</td>
        <td>{item.status}{item.last_error_code && <small>{item.last_error_code}</small>}</td><td><button className="link" onClick={() => void choose(item)}>{t.senders}</button></td></tr>)}</tbody></table></div>
    {!items.length && <p>{t.noConnections}</p>}{cursor && <button className="secondary" onClick={() => void load(cursor).catch((failure) => setError(String(failure)))}>{t.more}</button>}
    {selected && <div className="panel"><h3>{selected.name}</h3><p>{t.status}: {selected.status}</p>{selected.status === 'WARNING' && <p>{t.warning}</p>}
      {(role === 'SUPER_ADMIN' || selected.branch_id === branchId) && <div className="actions"><button disabled={busy || selected.status === 'DISABLED'} onClick={() => void action(selected, 'test')}>{t.test}</button>
        <button className="secondary" disabled={busy} onClick={() => void action(selected, selected.status === 'DISABLED' ? 'enable' : 'disable')}>{selected.status === 'DISABLED' ? t.enable : t.disable}</button>
        <button className="secondary" onClick={() => {
          setEditing(true); setForm({ name: selected.name, branchId: selected.branch_id ?? '', wabaId: selected.config.wabaId,
            graphVersion: selected.config.graphVersion, accessToken: '', appSecret: '', verifyToken: '' }); }}>{t.edit}</button></div>}
      <h4>{t.senders}</h4><ul>{senders.map((sender) => <li key={sender.id}>{sender.display_name} ({sender.external_sender_id}) — {sender.health}
        {sender.provider_status.qualityRating && ` · ${sender.provider_status.qualityRating}`}</li>)}</ul>{!senders.length && <p>{t.noSenders}</p>}
    </div>}
    {editing && <form className="workflow-form" onSubmit={(event) => { event.preventDefault(); void save(); }}><h3>{selected ? t.edit : t.add}</h3>
      <label>{t.name}<input required maxLength={100} value={form.name} onChange={(event) => set('name', event.target.value)} /></label>
      {role === 'SUPER_ADMIN' && !selected && <label>{t.scope}<select value={form.branchId} onChange={(event) => set('branchId', event.target.value)}>
        <option value="">{t.organization}</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>}
      <label>{t.waba}<input required pattern="[0-9]+" maxLength={30} value={form.wabaId} onChange={(event) => set('wabaId', event.target.value)} /></label>
      <label>{t.version}<input required placeholder="v25.0" pattern="v[0-9]{1,2}[.][0-9]{1,2}" value={form.graphVersion} onChange={(event) => set('graphVersion', event.target.value)} /></label>
      <label>{t.token}<input type="password" autoComplete="off" value={form.accessToken} onChange={(event) => set('accessToken', event.target.value)} /></label>
      <label>{t.appSecret}<input type="password" autoComplete="off" value={form.appSecret} onChange={(event) => set('appSecret', event.target.value)} /></label>
      <label>{t.verifyToken}<input type="password" autoComplete="off" value={form.verifyToken} onChange={(event) => set('verifyToken', event.target.value)} /></label>
      {selected && <p>{t.existingSecret}</p>}<button disabled={busy}>{t.save}</button>
    </form>}
  </section>;
}
