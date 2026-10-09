import { useEffect, useRef, useState } from 'react';
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Policy = { enabled: boolean; initialDelaySeconds: number; delaysSeconds: number[]; stopOnReply: boolean; finalAction: 'COMPLETE' | 'HANDOFF' };
const empty = (): Policy => ({ enabled: false, initialDelaySeconds: 0, delaysSeconds: [], stopOnReply: true, finalAction: 'COMPLETE' });
const labels = {
  en: { title: 'AI follow-up policy', enable: 'Enable AI follow-up policy', initial: 'Initial AI response delay in seconds', add: 'Add follow-up delay', delay: 'Follow-up delay in seconds', remove: 'Remove follow-up delay',
    reply: 'Stop AI follow-up on customer reply', final: 'Final no-response action', complete: 'Complete AI follow-up', handoff: 'Request human handoff', reason: 'AI follow-up policy reason', save: 'Save AI follow-up policy', reload: 'Reload AI follow-up policy',
    version: 'Version', max: 'Maximum follow-up attempts', anchor: 'Simulation anchor time', sent: 'Simulated sent follow-up count', answered: 'Simulate customer reply', controller: 'Simulated controller', lifecycle: 'Simulated Lead lifecycle', state: 'Simulated conversation state', preview: 'Preview AI follow-up timing', past: 'View past AI follow-up policy', more: 'More AI follow-up history',
    notice: 'Policy settings and timing preview do not activate AI or send a message. Sending hours, timezone and frequency limits use Central Messaging Policy. Human takeover, handoff and closed conversations or Leads always stop automatic follow-up.' },
  ar: { title: 'سياسة متابعة AI', enable: 'تفعيل سياسة متابعة AI', initial: 'تأخير استجابة AI الأولى بالثواني', add: 'إضافة تأخير متابعة', delay: 'تأخير المتابعة بالثواني', remove: 'إزالة تأخير المتابعة',
    reply: 'إيقاف متابعة AI عند رد العميل', final: 'إجراء انتهاء المحاولات دون رد', complete: 'إكمال متابعة AI', handoff: 'طلب التحويل إلى موظف', reason: 'سبب تعديل سياسة متابعة AI', save: 'حفظ سياسة متابعة AI', reload: 'تحديث سياسة متابعة AI',
    version: 'النسخة', max: 'الحد الأقصى لمحاولات المتابعة', anchor: 'وقت مرجعي للمحاكاة', sent: 'عدد متابعات مرسلة للمحاكاة', answered: 'محاكاة رد العميل', controller: 'التحكم المفترض', lifecycle: 'حالة Lead المفترضة', state: 'حالة المحادثة المفترضة', preview: 'معاينة توقيت متابعة AI', past: 'عرض نسخة سابقة لسياسة متابعة AI', more: 'المزيد من تاريخ متابعة AI',
    notice: 'الإعداد ومعاينة التوقيت لا يفعلان AI ولا يرسلان رسالة. أوقات الإرسال والمنطقة الزمنية وحدود التكرار تخضع لسياسة Messaging المركزية. تولي الموظف والتحويل وإغلاق المحادثة أو Lead توقف المتابعة الآلية دائمًا.' },
  fr: { title: 'Politique de relance IA', enable: 'Activer la politique de relance IA', initial: 'Délai initial IA en secondes', add: 'Ajouter un délai de relance', delay: 'Délai de relance en secondes', remove: 'Supprimer le délai de relance',
    reply: 'Arrêter la relance IA après une réponse client', final: 'Action finale sans réponse', complete: 'Terminer la relance IA', handoff: 'Demander un transfert humain', reason: 'Motif de politique de relance IA', save: 'Enregistrer la politique de relance IA', reload: 'Actualiser la politique de relance IA',
    version: 'Version', max: 'Nombre maximal de relances', anchor: 'Heure de référence simulée', sent: 'Nombre de relances simulées', answered: 'Simuler une réponse client', controller: 'Contrôle simulé', lifecycle: 'État simulé du Lead', state: 'État simulé de conversation', preview: 'Prévisualiser le délai de relance IA', past: 'Voir une version de politique de relance IA', more: 'Plus d’historique de relance IA',
    notice: 'Configurer et prévisualiser le délai n’active pas l’IA et n’envoie aucun message. La politique Messaging centrale régit les horaires, le fuseau et la fréquence. La prise de contrôle humaine, le transfert et la fermeture arrêtent toujours la relance automatique.' },
} as const;
export function CampaignAIFollowupPolicy({ campaignId, locale, api }: { campaignId: string; locale: 'ar' | 'en' | 'fr'; api: Api }) {
  const t = labels[locale], root = '/api/ai/campaigns/' + campaignId + '/followup-policy';
  const [policy, setPolicy] = useState<Policy>(empty), [version, setVersion] = useState(0), [reason, setReason] = useState('');
  const [busy, setBusy] = useState(true), [ready, setReady] = useState(false), [error, setError] = useState(''), [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const loadSequence = useRef(0), locked = busy || !ready;
  const [history, setHistory] = useState<{ items: { version: number; reason: string; created_at: string }[]; nextVersion: number | null }>({ items: [], nextVersion: null });
  const [past, setPast] = useState<{ version: number; definition: Policy } | null>(null);
  const [anchor, setAnchor] = useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  const [attempts, setAttempts] = useState(0), [reply, setReply] = useState(false), [controller, setController] = useState('AI'), [lifecycle, setLifecycle] = useState('OPEN'), [state, setState] = useState('AI_WAITING_FOR_LEAD');
  async function reload() {
    const sequence = ++loadSequence.current;
    const [data, items] = await Promise.all([api<{ version: number; definition: Policy }>(root), api<typeof history>(root + '/history')]);
    if (sequence !== loadSequence.current) return;
    setVersion(data.version); setPolicy(data.definition); setHistory(items); setPreview(null); setPast(null); setReady(true);
  }
  useEffect(() => {
    let active = true; setBusy(true); setReady(false); setError('');
    void reload().catch(f => { if (active) setError(String(f)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; ++loadSequence.current; };
  }, [campaignId]);
  async function action(work: () => Promise<void>) { setBusy(true); setError(''); try { await work(); } catch (f) { setError(String(f)); } finally { setBusy(false); } }
  return <section className="lead-fields knowledge-form" data-campaign-ai-followup><h3>{t.title}</h3><p>{t.notice}</p><small>{t.version}: {version} · {t.max}: {policy.delaysSeconds.length}</small>
    <button className="link" disabled={busy} onClick={() => void action(reload)}>{t.reload}</button>{error && <div role="alert" className="error">{error}</div>}
    <form className="knowledge-form" onSubmit={e => { e.preventDefault(); void action(async () => { await api(root, { method: 'PUT', body: JSON.stringify({ version, definition: policy, reason }) }); await reload(); setReason(''); }); }}>
      <fieldset className="knowledge-form" disabled={locked}>
      <label className="check-row"><input aria-label={t.enable} type="checkbox" checked={policy.enabled} onChange={e => setPolicy(p => ({ ...p, enabled: e.target.checked }))} />{t.enable}</label>
      <label>{t.initial}<input aria-label={t.initial} type="number" required min={0} max={2147483647} step={1} value={policy.initialDelaySeconds} onChange={e => setPolicy(p => ({ ...p, initialDelaySeconds: Number(e.target.value) }))} /></label>
      {policy.delaysSeconds.map((delay, index) => <div className="option-row" key={index}><label>{t.delay} {index + 1}<input aria-label={t.delay + ' ' + (index + 1)} type="number" required min={1} max={2147483647} step={1} value={delay || ''}
        onChange={e => setPolicy(p => ({ ...p, delaysSeconds: p.delaysSeconds.map((v, i) => i === index ? Number(e.target.value) : v) }))} /></label>
        <button type="button" className="link" disabled={busy} aria-label={t.remove + ' ' + (index + 1)} onClick={() => setPolicy(p => ({ ...p, delaysSeconds: p.delaysSeconds.filter((_, i) => i !== index) }))}>{t.remove}</button></div>)}
      <button type="button" className="secondary" disabled={busy || policy.delaysSeconds.length >= 40} onClick={() => setPolicy(p => ({ ...p, delaysSeconds: [...p.delaysSeconds, 0] }))}>{t.add}</button>
      <label className="check-row"><input aria-label={t.reply} type="checkbox" checked={policy.stopOnReply} onChange={e => setPolicy(p => ({ ...p, stopOnReply: e.target.checked }))} />{t.reply}</label>
      <label>{t.final}<select aria-label={t.final} value={policy.finalAction} onChange={e => setPolicy(p => ({ ...p, finalAction: e.target.value as Policy['finalAction'] }))}><option value="COMPLETE">{t.complete}</option><option value="HANDOFF">{t.handoff}</option></select></label>
      <label>{t.reason}<input aria-label={t.reason} required minLength={3} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label><button disabled={busy}>{t.save}</button>
      </fieldset>
    </form>
    <fieldset className="workflow-form" disabled={locked}><label>{t.anchor}<input aria-label={t.anchor} type="datetime-local" value={anchor} onChange={e => setAnchor(e.target.value)} /></label>
      <label>{t.sent}<input aria-label={t.sent} type="number" min={0} max={2147483647} step={1} value={attempts} onChange={e => setAttempts(Number(e.target.value))} /></label>
      <label>{t.controller}<select aria-label={t.controller} value={controller} onChange={e => setController(e.target.value)}>{['AI', 'HUMAN', 'NONE'].map(v => <option key={v}>{v}</option>)}</select></label>
      <label>{t.lifecycle}<select aria-label={t.lifecycle} value={lifecycle} onChange={e => setLifecycle(e.target.value)}>{['OPEN', 'CLOSED', 'ARCHIVED'].map(v => <option key={v}>{v}</option>)}</select></label>
      <label>{t.state}<select aria-label={t.state} value={state} onChange={e => setState(e.target.value)}>{['AI_ACTIVE', 'AI_WAITING_FOR_LEAD', 'AI_HANDOFF_REQUIRED', 'WAITING_FOR_HUMAN', 'HUMAN_ACTIVE', 'CLOSED'].map(v => <option key={v}>{v}</option>)}</select></label>
      <label className="check-row"><input aria-label={t.answered} type="checkbox" checked={reply} onChange={e => setReply(e.target.checked)} />{t.answered}</label>
      <button disabled={busy} onClick={() => void action(async () => { setPreview(await api(root + '/preview', { method: 'POST', body: JSON.stringify({ version, definition: policy, anchorAt: new Date(anchor).toISOString(), attemptsSent: attempts, hasInboundReply: reply, controllerType: controller, leadLifecycle: lifecycle, conversationState: state }) })); })}>{t.preview}</button>
    </fieldset>{preview && <pre className="knowledge-content" data-ai-followup-preview>{JSON.stringify(preview, null, 2)}</pre>}
    <ul className="timeline">{history.items.map(h => <li key={h.version}><span>{h.reason}<button className="link" disabled={busy} onClick={() => void action(async () => { setPast(await api(root + '/versions/' + h.version)); })}>{t.past} {h.version}</button></span><time dir="auto">{new Date(h.created_at).toLocaleString(locale)}</time></li>)}</ul>
    {history.nextVersion && <button disabled={busy} onClick={() => void action(async () => { const more = await api<typeof history>(root + '/history?before=' + history.nextVersion); setHistory(h => ({ items: [...h.items, ...more.items], nextVersion: more.nextVersion })); })}>{t.more}</button>}
    {past && <pre className="knowledge-content" data-ai-followup-version>{JSON.stringify(past, null, 2)}</pre>}
  </section>;
}
