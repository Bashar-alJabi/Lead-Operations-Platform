import { useEffect, useState } from 'react';
import { TemplateSetup } from './TemplateSetup';
import { MessagingTestSend } from './MessagingTestSend';
import { MessagingWebhookSetup } from './MessagingWebhookSetup';
import { MessagingInboundReview } from './MessagingInboundReview';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Locale = 'ar'|'fr'|'en';
type Branch = { id: string; name: string };
type Connection = { id: string; branch_id: string | null; name: string; provider: string; status: string;
  version: number; config: { wabaId: string; graphVersion: string }; has_credential: boolean;
  last_success_at: string | null; last_failure_at: string | null; last_error_code: string | null };
type Sender = { id: string; external_sender_id: string; display_name: string; health: string; active: boolean;
  operator_enabled: boolean; version: number; bindings: { branchId: string; allowSharedFallback: boolean }[];
  provider_status: { qualityRating?: string | null } };
type AvailableSender = { id: string; display_name: string; connection_name: string; active: boolean;
  operator_enabled: boolean; connection_status: string };
type SendingWindow = { start: string; end: string } | null;
type BranchPolicy = { version: number; timezone: string; sendingWindow: SendingWindow };
const labels = {
  ar: { title: 'اتصالات الرسائل', explain: 'أنشئ Meta Business Portfolio وWhatsApp Business Account وتطبيق Meta، واحصل على WABA ID ورمز وصول System User وApp Secret. أدخلها هنا واختبر اكتشاف الأرقام. يجب لاحقًا إعداد Webhook واختبار الإرسال قبل تشغيل الرسائل.', add: 'إضافة اتصال', edit: 'تعديل الاتصال', name: 'اسم الاتصال', scope: 'النطاق', organization: 'المؤسسة', branch: 'الفرع', version: 'إصدار Graph API', waba: 'WABA ID', token: 'رمز الوصول', appSecret: 'App Secret', verifyToken: 'Webhook Verify Token', save: 'حفظ', test: 'اختبار واكتشاف الأرقام', disable: 'تعطيل', enable: 'إعادة التهيئة', senders: 'الأرقام المكتشفة', status: 'الحالة', noSenders: 'لا أرقام مكتشفة', noConnections: 'لا اتصالات', more: 'المزيد', warning: 'اكتشاف الأرقام نجح؛ الإرسال والـWebhook غير متحققين بعد.', existingSecret: 'اترك حقول السر فارغة للاحتفاظ بالبيانات المحفوظة؛ لا تُعرض بعد الحفظ.', bind: 'ربط', unbind: 'فك الربط', fallback: 'Fallback مشترك', senderEnable: 'تمكين الرقم', senderDisable: 'إيقاف الرقم', defaultSender: 'الرقم الافتراضي للفرع', noDefault: 'بلا رقم افتراضي', pending: 'الإرسال غير جاهز حتى ينجح فحصه.', sendingPolicy: 'نافذة إرسال الفرع', allDay: 'بلا تقييد زمني للفرع', starts: 'تبدأ', ends: 'تنتهي', timezone: 'المنطقة الزمنية', policyNote: 'نافذة تعبر منتصف الليل مسموحة. تُطبق قواعد المزود والموافقة عند تنفيذ الإرسال.' },
  fr: { title: 'Connexions de messagerie', explain: 'Créez un compte WhatsApp Business et une application Meta, puis obtenez le WABA ID, un jeton System User et le secret de l’application. Configurez-les ici. L’envoi et le webhook doivent être vérifiés séparément.', add: 'Ajouter', edit: 'Modifier', name: 'Nom', scope: 'Portée', organization: 'Organisation', branch: 'Agence', version: 'Version Graph API', waba: 'WABA ID', token: 'Jeton d’accès', appSecret: 'Secret de l’application', verifyToken: 'Jeton de vérification', save: 'Enregistrer', test: 'Tester et découvrir les numéros', disable: 'Désactiver', enable: 'Réactiver', senders: 'Numéros découverts', status: 'État', noSenders: 'Aucun numéro', noConnections: 'Aucune connexion', more: 'Plus', warning: 'Numéros découverts ; envoi et webhook non encore vérifiés.', existingSecret: 'Laissez les secrets vides pour conserver ceux enregistrés ; ils ne sont pas réaffichés.', bind: 'Lier', unbind: 'Délier', fallback: 'Secours partagé', senderEnable: 'Activer le numéro', senderDisable: 'Désactiver le numéro', defaultSender: 'Numéro par défaut de l’agence', noDefault: 'Aucun numéro par défaut', pending: 'Envoi indisponible tant que le test d’envoi manque.', sendingPolicy: 'Fenêtre d’envoi de l’agence', allDay: 'Aucune restriction horaire locale', starts: 'Début', ends: 'Fin', timezone: 'Fuseau horaire', policyNote: 'Une fenêtre traversant minuit est autorisée. Les règles du fournisseur et le consentement s’appliquent à l’envoi.' },
  en: { title: 'Messaging connections', explain: 'Create a Meta Business Portfolio, WhatsApp Business Account, and Meta app. Obtain the WABA ID, System User access token, and App Secret. Enter them here and discover senders. Webhook and outbound sending require separate verification.', add: 'Add connection', edit: 'Edit connection', name: 'Connection name', scope: 'Scope', organization: 'Organization', branch: 'Branch', version: 'Graph API version', waba: 'WABA ID', token: 'Access token', appSecret: 'App Secret', verifyToken: 'Webhook Verify Token', save: 'Save', test: 'Test and discover senders', disable: 'Disable', enable: 'Reconfigure', senders: 'Discovered senders', status: 'Status', noSenders: 'No senders discovered', noConnections: 'No connections', more: 'More', warning: 'Sender discovery succeeded; outbound sending and webhook are not yet verified.', existingSecret: 'Leave secrets blank to retain saved values; they are never displayed after saving.', bind: 'Bind', unbind: 'Unbind', fallback: 'Shared fallback', senderEnable: 'Enable sender', senderDisable: 'Disable sender', defaultSender: 'Branch default sender', noDefault: 'No default sender', pending: 'Sending remains unavailable until a send test succeeds.', sendingPolicy: 'Branch sending window', allDay: 'No local time restriction', starts: 'Starts', ends: 'Ends', timezone: 'Time zone', policyNote: 'A window may cross midnight. Provider rules and consent are enforced at send time.' },
} as const;

export function MessagingSetup({ locale, role, branchId, branches, api }: {
  locale: Locale; role: 'SUPER_ADMIN'|'MANAGER'; branchId: string | null; branches: Branch[]; api: Api;
}) {
  const t = labels[locale];
  const [items, setItems] = useState<Connection[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Connection | null>(null);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [senderAfter, setSenderAfter] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', branchId: role === 'MANAGER' ? branchId ?? '' : '',
    wabaId: '', graphVersion: '', accessToken: '', appSecret: '', verifyToken: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [setupBranchId, setSetupBranchId] = useState(role === 'MANAGER' ? branchId ?? '' : branches[0]?.id ?? '');
  const [defaultVersion, setDefaultVersion] = useState(1);
  const [defaultSenderId, setDefaultSenderId] = useState('');
  const [available, setAvailable] = useState<AvailableSender[]>([]);
  const [availableAfter, setAvailableAfter] = useState<string | null>(null);
  const [branchPolicy, setBranchPolicy] = useState<BranchPolicy | null>(null);
  const [windowDraft, setWindowDraft] = useState<SendingWindow>(null);
  async function load(next?: string) {
    const page = await api<{ items: Connection[]; nextCursor: string | null }>(
      `/api/messaging/connections${next ? '?cursor=' + encodeURIComponent(next) : ''}`);
    setItems((current) => next ? [...current, ...page.items] : page.items);
    setCursor(page.nextCursor);
    if (selected && !next) setSelected(page.items.find((item) => item.id === selected.id) ?? null);
    return page;
  }
  useEffect(() => { void load().catch((failure) => setError(String(failure))); }, []);
  async function loadDefault(id: string, after?: string) {
    if (!id) return;
    const [current, page] = await Promise.all([
      api<{ sender_version: number; default_sender_id: string | null }>(`/api/messaging/branches/${id}/default-sender`),
      api<{ items: AvailableSender[]; nextAfter: string | null }>(
        `/api/messaging/branches/${id}/senders${after ? '?after=' + encodeURIComponent(after) : ''}`),
    ]);
    setDefaultVersion(current.sender_version); setDefaultSenderId(current.default_sender_id ?? '');
    setAvailable((old) => after ? [...old, ...page.items] : page.items);
    setAvailableAfter(page.nextAfter);
  }
  useEffect(() => { void loadDefault(setupBranchId).catch((failure) => setError(String(failure))); }, [setupBranchId]);
  useEffect(() => {
    let cancelled = false;
    setBranchPolicy(null); setWindowDraft(null);
    if (setupBranchId) void api<BranchPolicy>(`/api/messaging/branches/${setupBranchId}/policy`)
      .then((policy) => { if (!cancelled) { setBranchPolicy(policy); setWindowDraft(policy.sendingWindow); } })
      .catch((failure) => { if (!cancelled) setError(String(failure)); });
    return () => { cancelled = true; };
  }, [setupBranchId]);
  async function choose(connection: Connection) {
    setSelected(connection); setEditing(false); setError('');
    try {
      const page = await api<{ items: Sender[]; nextAfter: string | null }>(`/api/messaging/connections/${connection.id}/senders`);
      setSenders(page.items); setSenderAfter(page.nextAfter);
    }
    catch (failure) { setError(String(failure)); }
  }
  async function moreSenders() {
    if (!selected || !senderAfter) return;
    const page = await api<{ items: Sender[]; nextAfter: string | null }>(
      `/api/messaging/connections/${selected.id}/senders?after=${encodeURIComponent(senderAfter)}`);
    setSenders((current) => [...current, ...page.items]); setSenderAfter(page.nextAfter);
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
  async function senderAction(sender: Sender, operation: 'enable'|'disable'|'bind'|'unbind'|'fallback', targetBranchId?: string) {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      if (operation === 'enable' || operation === 'disable') {
        await api(`/api/messaging/senders/${sender.id}`, { method: 'PATCH', body: JSON.stringify({
          version: sender.version, operatorEnabled: operation === 'enable',
        }) });
      } else if (targetBranchId) {
        const binding = sender.bindings.find((item) => item.branchId === targetBranchId);
        await api(`/api/messaging/senders/${sender.id}/bindings/${targetBranchId}`, { method: 'PUT', body: JSON.stringify({
          version: sender.version, bound: operation !== 'unbind',
          allowSharedFallback: operation === 'fallback' ? !binding?.allowSharedFallback : Boolean(binding?.allowSharedFallback),
        }) });
      }
      await choose(selected); await load(); await loadDefault(setupBranchId);
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  async function saveDefault() {
    if (!setupBranchId) return;
    setBusy(true); setError('');
    try {
      await api(`/api/messaging/branches/${setupBranchId}/default-sender`, { method: 'PUT', body: JSON.stringify({
        version: defaultVersion, senderId: defaultSenderId || null,
      }) });
      await loadDefault(setupBranchId);
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  async function savePolicy() {
    if (!setupBranchId || !branchPolicy) return;
    setBusy(true); setError('');
    try {
      await api(`/api/messaging/branches/${setupBranchId}/policy`, { method: 'PUT', body: JSON.stringify({
        version: branchPolicy.version, sendingWindow: windowDraft,
      }) });
      const policy = await api<BranchPolicy>(`/api/messaging/branches/${setupBranchId}/policy`);
      setBranchPolicy(policy); setWindowDraft(policy.sendingWindow);
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
        {sender.provider_status.qualityRating && ` · ${sender.provider_status.qualityRating}`}
        {(role === 'SUPER_ADMIN' || selected.branch_id === branchId) && <button className="link" disabled={busy}
          onClick={() => void senderAction(sender, sender.operator_enabled ? 'disable' : 'enable')}>
          {sender.operator_enabled ? t.senderDisable : t.senderEnable}</button>}
        {role === 'SUPER_ADMIN' && selected.branch_id === null && <ul>{branches.map((branch) => {
          const binding = sender.bindings.find((item) => item.branchId === branch.id);
          return <li key={branch.id}>{branch.name} · {binding ? t.bind : t.unbind}
            <button className="link" disabled={busy} onClick={() => void senderAction(sender, binding ? 'unbind' : 'bind', branch.id)}>
              {binding ? t.unbind : t.bind}</button>
            {binding && <label className="check-row"><input type="checkbox" disabled={busy}
              checked={binding.allowSharedFallback} onChange={() => void senderAction(sender, 'fallback', branch.id)} />{t.fallback}</label>}
          </li>;
        })}</ul>}</li>)}</ul>{!senders.length && <p>{t.noSenders}</p>}
      {senderAfter && <button className="secondary" onClick={() => void moreSenders().catch((failure) => setError(String(failure)))}>{t.more}</button>}
      {(role === 'SUPER_ADMIN' || selected.branch_id === branchId) &&
        <TemplateSetup connectionId={selected.id} status={selected.status} canManage locale={locale} api={api} />}
      {(role === 'SUPER_ADMIN' || selected.branch_id === branchId) &&
        <MessagingTestSend connectionId={selected.id} status={selected.status} senders={senders}
          locale={locale} api={api} onChanged={async () => {
            const page = await load(); const current = page.items.find((item) => item.id === selected.id);
            if (current) await choose(current);
          }} />}
      {(role === 'SUPER_ADMIN' || selected.branch_id === branchId) &&
        <MessagingWebhookSetup connectionId={selected.id} locale={locale} api={api} />}
      {(role === 'SUPER_ADMIN' || selected.branch_id === branchId) &&
        <MessagingInboundReview connectionId={selected.id} locale={locale} api={api} />}
    </div>}
    {setupBranchId && <section className="panel"><h3>{t.defaultSender}</h3>
      {role === 'SUPER_ADMIN' && <label>{t.branch}<select value={setupBranchId} disabled={busy} onChange={(event) => setSetupBranchId(event.target.value)}>
        {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>}
      <label>{t.senders}<select value={defaultSenderId} onChange={(event) => setDefaultSenderId(event.target.value)}>
        <option value="">{t.noDefault}</option>{available.map((sender) => <option key={sender.id} value={sender.id}
          disabled={!sender.active || !sender.operator_enabled || sender.connection_status === 'DISABLED'}>
          {sender.display_name} · {sender.connection_name}</option>)}</select></label>
      {availableAfter && <button className="secondary" onClick={() => void loadDefault(setupBranchId, availableAfter).catch((failure) => setError(String(failure)))}>{t.more}</button>}
      <button disabled={busy} onClick={() => void saveDefault()}>{t.save}</button><p>{t.pending}</p>
    </section>}
    {setupBranchId && branchPolicy && <section className="panel"><h3>{t.sendingPolicy}</h3>
      <p>{t.timezone}: {branchPolicy.timezone}</p>
      <label className="check-row"><input type="checkbox" checked={windowDraft === null} disabled={busy}
        onChange={(event) => setWindowDraft(event.target.checked ? null : { start: '09:00', end: '18:00' })} />{t.allDay}</label>
      {windowDraft && <div className="actions">
        <label>{t.starts}<input type="time" required value={windowDraft.start} disabled={busy}
          onChange={(event) => setWindowDraft({ ...windowDraft, start: event.target.value })} /></label>
        <label>{t.ends}<input type="time" required value={windowDraft.end} disabled={busy}
          onChange={(event) => setWindowDraft({ ...windowDraft, end: event.target.value })} /></label>
      </div>}
      <button disabled={busy || Boolean(windowDraft && (!windowDraft.start || !windowDraft.end || windowDraft.start === windowDraft.end))}
        onClick={() => void savePolicy()}>{t.save}</button><p>{t.policyNote}</p>
    </section>}
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
