import { useEffect, useState } from 'react';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Locale = 'ar'|'fr'|'en';
type Campaign = { id: string; branch_id: string; name: string; status: 'DRAFT'|'ACTIVE'|'INACTIVE'; version: number;
  source_kind: string; routing_method: string; messaging_config: { enabled?: boolean }; ai_config: { enabled?: boolean };
  conversion_config: { type?: string }; branch_active: boolean; sender_override_id: string | null };
type Agent = { agent_id: string; name: string; active: boolean; account_active: boolean; weight: number; capacity_override: number | null };
type Detail = { campaign: Campaign; agents: Agent[]; issues: string[] };
type User = { id: string; name: string };
const text = {
  ar: { back: 'العودة للحملات', title: 'إعداد الحملة', name: 'الاسم', source: 'مصدر الـLeads', routing: 'التوزيع', conversion: 'تعريف التحويل', none: 'غير محدد', payment: 'تأكيد الدفع', enrollment: 'تأكيد التسجيل', messaging: 'تفعيل مراسلة العميل', ai: 'تفعيل مساعد AI', save: 'حفظ الإعدادات', agents: 'الوكلاء المؤهلون', add: 'إضافة/تحديث الوكيل', remove: 'إزالة', weight: 'الوزن', capacity: 'حد السعة الخاص بالحملة (اختياري)', choose: 'اختر', search: 'ابحث عن وكيل', more: 'المزيد من الوكلاء', readiness: 'الجاهزية', ready: 'جاهزة للتفعيل', activate: 'تفعيل', deactivate: 'تعطيل', disabled: 'عطّل الحملة قبل تعديل إعداداتها.', dependency: 'تفعيل مصدر خارجي أو مراسلة أو AI يبقي الحملة غير جاهزة حتى اكتمال الربط والتحقق.', status: 'الحالة', version: 'نسخة الإعداد', senderOverride: 'تجاوز رقم الإرسال للحملة', inheritedSender: 'وراثة الرقم الافتراضي للفرع', senderPending: 'إعداد الرقم لا يعني جاهزية الإرسال.' },
  fr: { back: 'Retour aux campagnes', title: 'Configuration', name: 'Nom', source: 'Source des prospects', routing: 'Attribution', conversion: 'Définition de conversion', none: 'Non définie', payment: 'Paiement confirmé', enrollment: 'Inscription confirmée', messaging: 'Activer les messages', ai: 'Activer l’assistant IA', save: 'Enregistrer', agents: 'Agents admissibles', add: 'Ajouter/mettre à jour', remove: 'Retirer', weight: 'Poids', capacity: 'Capacité de campagne (facultatif)', choose: 'Choisir', search: 'Chercher un agent', more: 'Plus d’agents', readiness: 'Préparation', ready: 'Prête à activer', activate: 'Activer', deactivate: 'Désactiver', disabled: 'Désactivez la campagne avant de modifier ses paramètres.', dependency: 'Les sources externes, la messagerie et l’IA empêchent l’activation tant que leur configuration n’est pas vérifiée.', status: 'État', version: 'Version', senderOverride: 'Expéditeur propre à la campagne', inheritedSender: 'Hériter du numéro de l’agence', senderPending: 'Le choix du numéro ne valide pas encore l’envoi.' },
  en: { back: 'Back to campaigns', title: 'Campaign setup', name: 'Name', source: 'Lead source', routing: 'Routing', conversion: 'Conversion definition', none: 'Not defined', payment: 'Payment confirmed', enrollment: 'Enrollment confirmed', messaging: 'Enable customer messaging', ai: 'Enable AI assistant', save: 'Save settings', agents: 'Eligible agents', add: 'Add/update agent', remove: 'Remove', weight: 'Weight', capacity: 'Campaign capacity (optional)', choose: 'Choose', search: 'Search agents', more: 'More agents', readiness: 'Readiness', ready: 'Ready to activate', activate: 'Activate', deactivate: 'Deactivate', disabled: 'Deactivate the campaign before editing its settings.', dependency: 'External sources, messaging, and AI block activation until their setup is verified.', status: 'Status', version: 'Configuration version', senderOverride: 'Campaign sender override', inheritedSender: 'Use branch default sender', senderPending: 'Selecting a sender does not verify sending.' },
} as const;
const issueLabels: Record<string, Record<Locale, string>> = {
  BRANCH_INACTIVE: { ar: 'الفرع غير نشط', fr: 'Agence inactive', en: 'Branch inactive' },
  NO_ELIGIBLE_AGENTS_CONFIGURED: { ar: 'لا يوجد وكيل نشط مؤهل', fr: 'Aucun agent admissible actif', en: 'No active eligible agent' },
  PERFORMANCE_ROUTING_NOT_READY: { ar: 'توزيع الأداء يحتاج مقاييس بشرية وسياسة عينة وبديل', fr: 'Le routage par performance nécessite des mesures humaines et une politique de repli', en: 'Performance routing needs human metrics, sample and fallback policy' },
  SOURCE_BINDING_NOT_READY: { ar: 'ربط المصدر الخارجي لم يكتمل', fr: 'Source externe non reliée', en: 'External source binding is not ready' },
  MESSAGING_CONFIGURATION_NOT_READY: { ar: 'إعداد المراسلة والمرسل لم يكتمل', fr: 'Messagerie et expéditeur non prêts', en: 'Messaging and sender setup is not ready' },
  AI_CONFIGURATION_NOT_READY: { ar: 'مزود AI والمعرفة المنشورة غير جاهزين', fr: 'Fournisseur IA et connaissances publiées non prêts', en: 'AI provider and published knowledge are not ready' },
};

export function CampaignWorkspace({ id, locale, api, onBack, onChanged }: {
  id: string; locale: Locale; api: Api; onBack: () => void; onChanged: () => Promise<void>;
}) {
  const t = text[locale];
  const [detail, setDetail] = useState<Detail | null>(null);
  const [form, setForm] = useState({ name: '', sourceKind: 'MANUAL', routingMethod: 'MANUAL', messagingEnabled: false, aiEnabled: false, conversion: '' });
  const [agentId, setAgentId] = useState('');
  const [weight, setWeight] = useState(1);
  const [capacity, setCapacity] = useState('');
  const [agentSearch, setAgentSearch] = useState('');
  const [eligible, setEligible] = useState<User[]>([]);
  const [eligibleCursor, setEligibleCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [senderOverrideId, setSenderOverrideId] = useState('');
  const [senderOptions, setSenderOptions] = useState<{ id: string; display_name: string; connection_name: string;
    active: boolean; operator_enabled: boolean; connection_status: string }[]>([]);
  const [senderAfter, setSenderAfter] = useState<string | null>(null);
  async function load() {
    const result = await api<Detail>(`/api/campaigns/${id}`);
    setDetail(result);
    const c = result.campaign;
    setForm({ name: c.name, sourceKind: c.source_kind, routingMethod: c.routing_method,
      messagingEnabled: Boolean(c.messaging_config.enabled), aiEnabled: Boolean(c.ai_config.enabled), conversion: c.conversion_config.type ?? '' });
    setSenderOverrideId(c.sender_override_id ?? '');
  }
  useEffect(() => { void load().catch((failure) => setError(String(failure))); }, [id]);
  async function loadSenders(branchId: string, after?: string) {
    const result = await api<{ items: typeof senderOptions; nextAfter: string | null }>(
      `/api/messaging/branches/${branchId}/senders${after ? '?after=' + encodeURIComponent(after) : ''}`);
    setSenderOptions((current) => after ? [...current, ...result.items] : result.items);
    setSenderAfter(result.nextAfter);
  }
  useEffect(() => { if (detail?.campaign.branch_id) void loadSenders(detail.campaign.branch_id)
    .catch((failure) => setError(String(failure))); }, [detail?.campaign.branch_id]);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => { void api<{ items: User[]; nextCursor: string | null }>(
      `/api/campaigns/${id}/eligible-agents?q=${encodeURIComponent(agentSearch)}`)
      .then((result) => { if (!cancelled) { setEligible(result.items); setEligibleCursor(result.nextCursor); } })
      .catch((failure) => { if (!cancelled) setError(String(failure)); }); }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [id, agentSearch]);
  async function mutate(path: string, method: 'POST'|'PUT'|'PATCH'|'DELETE', body?: object) {
    setBusy(true); setError('');
    try {
      await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      await load(); await onChanged();
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  if (!detail) return <section className="panel"><button className="link" onClick={onBack}>{t.back}</button>{error && <p role="alert" className="error">{error}</p>}</section>;
  const campaign = detail.campaign;
  const editable = campaign.status !== 'ACTIVE';
  return <div className="campaign-workspace"><button className="link" onClick={onBack}>{t.back}</button><h2>{t.title}: {campaign.name}</h2>
    {error && <p role="alert" className="error">{error}</p>}
    <section className="panel"><p>{t.status}: <strong>{campaign.status}</strong> · {t.version}: {campaign.version}</p>
      <form className="campaign-form" onSubmit={(event) => { event.preventDefault(); void mutate(`/api/campaigns/${id}`, 'PATCH', {
        version: campaign.version, name: form.name, sourceKind: form.sourceKind, routingMethod: form.routingMethod,
        messagingEnabled: form.messagingEnabled, aiEnabled: form.aiEnabled,
        conversion: form.conversion ? { type: form.conversion } : null,
      }); }}>
        <label>{t.name}<input required maxLength={200} disabled={!editable || busy} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>{t.source}<select disabled={!editable || busy} value={form.sourceKind} onChange={(e) => setForm({ ...form, sourceKind: e.target.value })}>
          {[...new Set([form.sourceKind, 'MANUAL','META','GENERIC_SOURCE'])].map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>{t.routing}<select disabled={!editable || busy} value={form.routingMethod} onChange={(e) => setForm({ ...form, routingMethod: e.target.value })}>
          {['MANUAL','ROUND_ROBIN','WEIGHTED','PERFORMANCE'].map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>{t.conversion}<select disabled={!editable || busy} value={form.conversion} onChange={(e) => setForm({ ...form, conversion: e.target.value })}>
          <option value="">{t.none}</option><option value="PAYMENT_CONFIRMED">{t.payment}</option><option value="ENROLLMENT_CONFIRMED">{t.enrollment}</option></select></label>
        <label className="check-row"><input type="checkbox" disabled={!editable || busy} checked={form.messagingEnabled} onChange={(e) => setForm({ ...form, messagingEnabled: e.target.checked })} />{t.messaging}</label>
        <label className="check-row"><input type="checkbox" disabled={!editable || busy} checked={form.aiEnabled} onChange={(e) => setForm({ ...form, aiEnabled: e.target.checked })} />{t.ai}</label>
        <button disabled={!editable || busy}>{t.save}</button>
      </form><p>{editable ? t.dependency : t.disabled}</p>
    </section>
    <section className="panel"><h3>{t.senderOverride}</h3>
      <label>{t.senderOverride}<select disabled={!editable || busy} value={senderOverrideId}
        onChange={(event) => setSenderOverrideId(event.target.value)}><option value="">{t.inheritedSender}</option>
        {senderOptions.map((sender) => <option key={sender.id} value={sender.id}
          disabled={!sender.active || !sender.operator_enabled || sender.connection_status === 'DISABLED'}>
          {sender.display_name} · {sender.connection_name}</option>)}</select></label>
      {senderAfter && <button className="secondary" onClick={() => void loadSenders(campaign.branch_id, senderAfter).catch((failure) => setError(String(failure)))}>{t.more}</button>}
      <button disabled={!editable || busy} onClick={() => void mutate(`/api/messaging/campaigns/${id}/sender-override`,
        'PUT', { version: campaign.version, senderId: senderOverrideId || null })}>{t.save}</button><p>{t.senderPending}</p>
    </section>
    <section className="panel"><h3>{t.agents}</h3>
      <div className="table-scroll"><table><thead><tr><th>{t.name}</th><th>{t.weight}</th><th>{t.capacity}</th><th>{t.status}</th><th></th></tr></thead><tbody>
        {detail.agents.map((agent) => <tr key={agent.agent_id}><td>{agent.name}</td><td>{agent.weight}</td><td>{agent.capacity_override ?? '—'}</td>
          <td>{agent.active && agent.account_active ? 'ACTIVE' : 'INACTIVE'}</td><td><button className="link" disabled={!agent.active || busy}
            onClick={() => void mutate(`/api/campaigns/${id}/agents/${agent.agent_id}`, 'DELETE')}>{t.remove}</button></td></tr>)}</tbody></table></div>
      <form className="campaign-form" onSubmit={(event) => { event.preventDefault(); void mutate(`/api/campaigns/${id}/agents`, 'PUT',
        { agentId, weight, capacityOverride: capacity === '' ? null : Number(capacity) }); }}>
        <label>{t.search}<input value={agentSearch} onChange={(e) => { setAgentSearch(e.target.value); setAgentId(''); }} /></label>
        <label>{t.agents}<select required value={agentId} onChange={(e) => setAgentId(e.target.value)}><option value="">{t.choose}</option>
          {eligible.map((user) =>
            <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
        <label>{t.weight}<input type="number" min={1} max={1000} value={weight} onChange={(e) => setWeight(Number(e.target.value))} /></label>
        <label>{t.capacity}<input type="number" min={0} value={capacity} onChange={(e) => setCapacity(e.target.value)} /></label>
        <button disabled={!agentId || busy}>{t.add}</button>
      </form>
      {eligibleCursor && <button className="secondary" disabled={busy} onClick={() => {
        void api<{ items: User[]; nextCursor: string | null }>(
          `/api/campaigns/${id}/eligible-agents?q=${encodeURIComponent(agentSearch)}&after=${encodeURIComponent(eligibleCursor)}`)
          .then((result) => { setEligible((current) => [...current, ...result.items]); setEligibleCursor(result.nextCursor); })
          .catch((failure) => setError(String(failure)));
      }}>{t.more}</button>}
    </section>
    <section className="panel"><h3>{t.readiness}</h3>
      {detail.issues.length ? <ul>{detail.issues.map((issue) => <li key={issue}>{issueLabels[issue]?.[locale] ?? issue}</li>)}</ul> : <p>{t.ready}</p>}
      <div className="actions">{campaign.status !== 'ACTIVE' && <button disabled={busy || detail.issues.length > 0}
        onClick={() => void mutate(`/api/campaigns/${id}/activate`, 'POST')}>{t.activate}</button>}
        {campaign.status === 'ACTIVE' && <button className="secondary" disabled={busy}
          onClick={() => void mutate(`/api/campaigns/${id}/deactivate`, 'POST')}>{t.deactivate}</button>}</div>
    </section>
  </div>;
}
