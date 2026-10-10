import { useEffect, useRef, useState } from 'react';
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Locale = 'ar' | 'en' | 'fr';
type Policy = { allowedTools: string[] | null };
type Catalog = { name: string; category: 'READ' | 'WRITE' | 'SEND'; customerRuntimeImplemented: boolean }[];
type Current = { version: number; definition: Policy; catalog: Catalog };
type History = { items: { version: number; reason: string; created_at: string }[]; nextVersion: number | null };
type Effective = { allowedTools: string[]; source: string; branchVersion: number; campaignVersion: number };
const words = {
  title: ['الأدوات المصرّح بها لمساعد المحادثة', 'Approved conversation AI tools', 'Outils IA de conversation approuvés'],
  branch: ['أدوات AI الافتراضية للفرع', 'Branch AI tool defaults', 'Outils IA par défaut de l’agence'], campaign: ['أدوات AI للحملة', 'Campaign AI tools', 'Outils IA de campagne'],
  note: ['حفظ الصلاحيات لا يفعّل AI أو يرسل رسالة. كل إجراء يتطلب فحصًا حاليًا للصلاحيات وسياق الحملة وقواعد العمل. لا يمكن السماح بـSQL أو تأكيد دفع أو تغيير صلاحيات النظام.', 'Saving approvals does not activate AI or send a message. Each action requires current authorization, campaign context and business rules. SQL, payment confirmation and security changes cannot be approved.', 'Enregistrer les autorisations n’active pas l’IA et n’envoie aucun message. Chaque action exige les autorisations actuelles, le contexte de campagne et les règles métier. SQL, confirmation de paiement et modifications de sécurité sont exclus.'],
  mode: ['مصدر قائمة الأدوات', 'Tool list source', 'Source de la liste d’outils'], inherit: ['وراثة الفرع / بدون أدوات عند غياب الإعداد', 'Inherit branch / no tools if unconfigured', 'Hériter de l’agence / aucun outil sans configuration'], unconfigured: ['بدون إعداد / لا أدوات', 'Unconfigured / no tools', 'Non configuré / aucun outil'], explicit: ['قائمة صريحة (فارغة تمنع كل الأدوات)', 'Explicit list (empty denies all tools)', 'Liste explicite (vide interdit tous les outils)'],
  reason: ['سبب تعديل صلاحيات الأدوات', 'Tool approval edit reason', 'Motif de modification des outils'], save: ['حفظ أدوات AI', 'Save AI tools', 'Enregistrer les outils IA'], reload: ['إعادة تحميل أدوات AI', 'Reload AI tools', 'Recharger les outils IA'], version: ['النسخة', 'Version', 'Version'],
  past: ['عرض أدوات AI السابقة', 'View past AI tools', 'Voir les outils IA précédents'], more: ['المزيد من تاريخ الأدوات', 'More tool approval history', 'Plus d’historique des outils'], effective: ['الأدوات الفعلية ومصدرها', 'Effective tools and source', 'Outils effectifs et source'], refresh: ['تحديث الأدوات الفعلية', 'Refresh effective tools', 'Actualiser les outils effectifs'], none: ['لا أدوات مصرح بها', 'No approved tools', 'Aucun outil approuvé'],
  getLeadContext: ['قراءة سياق Lead الحالية', 'Read current Lead context', 'Lire le contexte du Lead actuel'], getCampaignKnowledge: ['قراءة المعرفة المنشورة للحملة', 'Read published campaign knowledge', 'Lire les connaissances publiées de campagne'], updateQualificationField: ['تحديث حقول التأهيل المسموحة', 'Update approved qualification fields', 'Mettre à jour les champs de qualification autorisés'], requestHumanHandoff: ['طلب التحويل إلى موظف', 'Request human handoff', 'Demander un transfert humain'], sendConversationMessage: ['إرسال رسالة وفق سياسة المراسلة المركزية', 'Send through central messaging policy', 'Envoyer selon la politique centrale'], createFollowUp: ['إنشاء مهمة متابعة ضمن الصلاحيات', 'Create authorized follow-up task', 'Créer une tâche de suivi autorisée'],
} as const;
const translator = (locale: Locale) => (key: keyof typeof words) => words[key][locale === 'ar' ? 0 : locale === 'en' ? 1 : 2];
function Editor({ scope, id, locale, api, onChanged }: { scope: 'BRANCH' | 'CAMPAIGN'; id: string; locale: Locale; api: Api; onChanged: () => Promise<void> }) {
  const t = translator(locale), prefix = t(scope === 'BRANCH' ? 'branch' : 'campaign'), root = scope === 'BRANCH' ? '/api/ai/branches/' + id + '/tool-defaults' : '/api/ai/campaigns/' + id + '/tool-policy';
  const [policy, setPolicy] = useState<Policy>({ allowedTools: null }), [catalog, setCatalog] = useState<Catalog>([]), [version, setVersion] = useState(0), [reason, setReason] = useState(''), [busy, setBusy] = useState(true), [ready, setReady] = useState(false), [error, setError] = useState('');
  const [history, setHistory] = useState<History>({ items: [], nextVersion: null }), [past, setPast] = useState<{ version: number; definition: Policy; reason: string } | null>(null);
  const epoch = useRef(0), working = useRef(false), label = (key: keyof typeof words) => prefix + ' · ' + t(key);
  function clear() { setReady(false); setCatalog([]); setPolicy({ allowedTools: null }); setHistory({ items: [], nextVersion: null }); setPast(null); }
  async function load(n: number) {
    const [p, h] = await Promise.all([api<Current>(root), api<History>(root + '/history')]);
    if (n !== epoch.current) return;
    setPolicy(p.definition); setVersion(p.version); setCatalog(p.catalog); setHistory(h); setPast(null); setReady(true);
  }
  async function run(work: (n: number) => Promise<void>) {
    if (working.current) return; working.current = true; const n = epoch.current; setBusy(true); setError('');
    try { await work(n); } catch (e) { if (n === epoch.current) { clear(); setError(String(e)); } } finally { if (n === epoch.current) { working.current = false; setBusy(false); } }
  }
  useEffect(() => {
    const n = ++epoch.current; clear(); working.current = false; void run(async () => load(n));
    return () => { ++epoch.current; working.current = false; };
  }, [root, api]);
  return <section data-ai-tools-scope={scope}><h4>{prefix}</h4><small>{t('version')}: {version}</small>{error && <p role="alert" className="error">{error}</p>}
    <form onSubmit={e => { e.preventDefault(); void run(async n => { await api(root, { method: 'PUT', body: JSON.stringify({ version, definition: policy, reason }) }); if (n !== epoch.current) return; await load(n); if (n !== epoch.current) return; setReason(''); await onChanged(); }); }}>
      <fieldset className="knowledge-form" disabled={busy || !ready}>
        <label>{t('mode')}<select aria-label={label('mode')} value={policy.allowedTools === null ? 'INHERIT' : 'EXPLICIT'} onChange={e => setPolicy({ allowedTools: e.target.value === 'INHERIT' ? null : [] })}><option value="INHERIT">{t(scope === 'CAMPAIGN' ? 'inherit' : 'unconfigured')}</option><option value="EXPLICIT">{t('explicit')}</option></select></label>
        {policy.allowedTools !== null && catalog.map(tool => <label className="check-row" key={tool.name}><input type="checkbox" aria-label={prefix + ' · ' + tool.name} checked={policy.allowedTools!.includes(tool.name)} onChange={e => setPolicy({ allowedTools: e.target.checked ? [...policy.allowedTools!, tool.name].sort() : policy.allowedTools!.filter(name => name !== tool.name) })} />{t(tool.name as keyof typeof words)}</label>)}
        <label>{t('reason')}<input aria-label={label('reason')} required minLength={3} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label><button>{t('save')}</button>
      </fieldset>
    </form><button disabled={busy} onClick={() => void run(async n => { await load(n); if (n === epoch.current) await onChanged(); })}>{t('reload')}</button>
    <ul className="timeline">{history.items.map(h => <li key={h.version}><span>{h.reason}<button className="link" disabled={busy} onClick={() => void run(async n => { const p = await api<typeof past>(root + '/versions/' + h.version); if (n === epoch.current) setPast(p); })}>{t('past')} {h.version}</button></span><time>{new Date(h.created_at).toLocaleString(locale)}</time></li>)}</ul>
    {history.nextVersion && <button disabled={busy} onClick={() => void run(async n => { const p = await api<History>(root + '/history?before=' + history.nextVersion); if (n === epoch.current) setHistory(h => ({ items: [...new Map([...h.items, ...p.items].map(i => [i.version, i])).values()], nextVersion: p.nextVersion })); })}>{t('more')}</button>}
    {past && <div className="knowledge-content" data-ai-tools-version><h5>{t('version')}: {past.version}</h5><p>{past.reason}</p><p>{past.definition.allowedTools === null ? t('inherit') : past.definition.allowedTools.join(', ') || t('none')}</p></div>}
  </section>;
}
export function CampaignAITools({ campaignId, branchId, locale, api }: { campaignId: string; branchId: string; locale: Locale; api: Api }) {
  const t = translator(locale), [effective, setEffective] = useState<Effective | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(true), epoch = useRef(0);
  async function load() { const n = ++epoch.current; setBusy(true); setError(''); try { const p = await api<{ toolPolicy: Effective }>('/api/ai/campaigns/' + campaignId + '/effective-configuration'); if (n === epoch.current) setEffective(p.toolPolicy); } catch (e) { if (n === epoch.current) { setEffective(null); setError(String(e)); } } finally { if (n === epoch.current) setBusy(false); } }
  useEffect(() => { setEffective(null); void load(); return () => { ++epoch.current; }; }, [campaignId, api]);
  return <section className="panel" data-campaign-ai-tools><h3>{t('title')}</h3><p>{t('note')}</p>
    <Editor key={'branch-' + branchId} scope="BRANCH" id={branchId} locale={locale} api={api} onChanged={load} />
    <Editor key={'campaign-' + campaignId} scope="CAMPAIGN" id={campaignId} locale={locale} api={api} onChanged={load} />
    <button disabled={busy} onClick={() => void load()}>{t('refresh')}</button>{error && <p role="alert" className="error">{error}</p>}
    {effective && <div data-ai-tools-effective><h4>{t('effective')}</h4><p>{effective.source} · {effective.branchVersion}/{effective.campaignVersion}</p><p>{effective.allowedTools.join(', ') || t('none')}</p></div>}
  </section>;
}
