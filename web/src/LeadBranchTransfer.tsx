import { useEffect, useState } from 'react';

type Locale = 'ar'|'en'|'fr';
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Branch = { id: string; name: string; active: boolean };
type Campaign = { id: string; name: string; status: string };
type Agent = { id: string; name: string };
type Transfer = { version: number; createdAt: string; reason: string; sourceBranch: string; sourceCampaign: string;
  destinationBranch: string; destinationCampaign: string };
type Page<T, Cursor = string> = { items: T[]; nextCursor: Cursor | null };

const labels = {
  ar: { title: 'نقل إلى فرع آخر', branch: 'الفرع الوجهة', campaign: 'الحملة الوجهة', agent: 'الوكيل الوجهة',
    none: 'دون إسناد', reason: 'سبب النقل', submit: 'نقل الفرصة', history: 'سجل النقل', pick: 'اختر',
    moreCampaigns: 'المزيد من الحملات', moreAgents: 'المزيد من الوكلاء', moreHistory: 'المزيد من سجل النقل',
    conflict: 'تغيّرت الفرصة. حدّث تفاصيلها قبل المحاولة مجددًا.', conversation: 'يتطلب نقل المحادثة المثبّتة مراجعة نطاقها ومرسلها.',
    payment: 'توجد معاملة دفع مرتبطة بالفرع الحالي.', review: 'أكمل المراجعة البشرية المفتوحة قبل النقل.' },
  en: { title: 'Transfer to another branch', branch: 'Destination branch', campaign: 'Destination campaign', agent: 'Destination agent',
    none: 'Unassigned', reason: 'Transfer reason', submit: 'Transfer lead', history: 'Transfer history', pick: 'Select',
    moreCampaigns: 'More campaigns', moreAgents: 'More agents', moreHistory: 'More transfer history',
    conflict: 'The lead changed. Refresh its details before retrying.', conversation: 'The pinned conversation requires a scope and sender review.',
    payment: 'A payment transaction belongs to the current branch.', review: 'Resolve the open human review before transferring.' },
  fr: { title: 'Transférer vers une autre agence', branch: 'Agence de destination', campaign: 'Campagne de destination', agent: 'Agent de destination',
    none: 'Non attribué', reason: 'Motif du transfert', submit: 'Transférer le prospect', history: 'Historique des transferts', pick: 'Sélectionner',
    moreCampaigns: 'Plus de campagnes', moreAgents: 'Plus d’agents', moreHistory: 'Plus de transferts',
    conflict: 'Le prospect a changé. Actualisez ses détails avant de réessayer.', conversation: 'La conversation associée exige une vérification de son périmètre et de son expéditeur.',
    payment: 'Une transaction de paiement est rattachée à l’agence actuelle.', review: 'Terminez la vérification humaine en cours avant le transfert.' },
};

export function LeadBranchTransfer({ lead, locale, api, onChanged }: {
  lead: { id: string; branch_id: string; version: number }; locale: Locale; api: Api; onChanged: () => Promise<void>;
}) {
  const t = labels[locale], path = `/api/leads/${lead.id}/branch-transfers`;
  const [branches, setBranches] = useState<Branch[]>([]);
  const [campaigns, setCampaigns] = useState<Page<Campaign>>({ items: [], nextCursor: null });
  const [agents, setAgents] = useState<Page<Agent>>({ items: [], nextCursor: null });
  const [history, setHistory] = useState<Page<Transfer, number>>({ items: [], nextCursor: null });
  const [branchId, setBranchId] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([api<{ items: Branch[] }>('/api/branches', { signal: controller.signal }),
      api<Page<Transfer, number>>(path, { signal: controller.signal })]).then(([available, past]) => {
      setBranches(available.items); setHistory(past);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [api, path, lead.version]);

  async function loadCampaigns(branch: string, cursor?: string) {
    setBusy(true); setError('');
    try {
      const page = await api<Page<Campaign>>(`/api/campaigns?branchId=${branch}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      setCampaigns(current => ({ items: [...(cursor ? current.items : []), ...page.items.filter(item => item.status === 'ACTIVE')],
        nextCursor: page.nextCursor }));
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }

  async function loadAgents(campaign: string, cursor?: string) {
    setBusy(true); setError('');
    try {
      const page = await api<Page<Agent>>(`/api/campaigns/${campaign}/eligible-agents${cursor ? `?after=${cursor}` : ''}`);
      setAgents(current => ({ items: [...(cursor ? current.items : []), ...page.items], nextCursor: page.nextCursor }));
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }

  async function submit() {
    setBusy(true); setError('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify({ version: lead.version, branchId, campaignId, agentId: agentId || null, reason }) });
      await onChanged();
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }

  const localizedError: Record<string, string> = { LEAD_VERSION_CONFLICT: t.conflict, LEAD_TRANSFER_CONVERSATION_REVIEW: t.conversation,
    LEAD_TRANSFER_PAYMENT_REVIEW: t.payment, LEAD_TRANSFER_HUMAN_REVIEW_PENDING: t.review };
  return <section className="panel" data-lead-branch-transfer><h3>{t.title}</h3>
    {error && <p role="alert" className="error">{localizedError[error] ?? error}</p>}
    <form className="workflow-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label>{t.branch}<select required value={branchId} disabled={busy} onChange={event => {
        const branch = event.target.value;
        setBranchId(branch); setCampaignId(''); setAgentId(''); setCampaigns({ items: [], nextCursor: null });
        setAgents({ items: [], nextCursor: null }); if (branch) void loadCampaigns(branch);
      }}><option value="">{t.pick}</option>{branches.filter(item => item.active && item.id !== lead.branch_id)
        .map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>{t.campaign}<select required value={campaignId} disabled={busy || !branchId} onChange={event => {
        const campaign = event.target.value;
        setCampaignId(campaign); setAgentId(''); setAgents({ items: [], nextCursor: null }); if (campaign) void loadAgents(campaign);
      }}><option value="">{t.pick}</option>{campaigns.items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>{t.agent}<select value={agentId} disabled={busy || !campaignId} onChange={event => setAgentId(event.target.value)}>
        <option value="">{t.none}</option>{agents.items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>{t.reason}<input required minLength={3} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <button disabled={busy || !campaignId || reason.trim().length < 3}>{t.submit}</button>
    </form>
    {campaigns.nextCursor && <button type="button" className="secondary" disabled={busy}
      onClick={() => void loadCampaigns(branchId, campaigns.nextCursor!)}>{t.moreCampaigns}</button>}
    {agents.nextCursor && <button type="button" className="secondary" disabled={busy}
      onClick={() => void loadAgents(campaignId, agents.nextCursor!)}>{t.moreAgents}</button>}
    {history.items.length > 0 && <><h4>{t.history}</h4><ul className="timeline">{history.items.map(item => <li key={item.version}>
      <span>{item.sourceBranch} · {item.sourceCampaign} → {item.destinationBranch} · {item.destinationCampaign}<small>{item.reason}</small></span>
      <time>{new Date(item.createdAt).toLocaleString(locale)}</time></li>)}</ul></>}
    {history.nextCursor && <button type="button" className="secondary" disabled={busy} onClick={() => {
      setBusy(true);
      void api<Page<Transfer, number>>(`${path}?before=${history.nextCursor}`).then(page => {
        setHistory(current => ({ items: [...current.items, ...page.items], nextCursor: page.nextCursor }));
      }).catch(failure => setError(failure.message)).finally(() => setBusy(false));
    }}>{t.moreHistory}</button>}
  </section>;
}
