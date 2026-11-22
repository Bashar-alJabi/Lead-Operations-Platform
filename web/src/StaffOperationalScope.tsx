import { useEffect, useState } from 'react';

type Locale = 'ar'|'en'|'fr';
type Role = 'MANAGER'|'AGENT';
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Edit = { version: number; role: Role; branchId: string; reason: string };
type Change = { version: number; previousRole: Role; role: Role; previousBranch: string; branch: string; reason: string; createdAt: string };
type Scope = Omit<Edit,'reason'> & { items: Change[]; nextBefore: number | null };

const labels = {
  ar: { title:'الدور والفرع', role:'دور الموظف', branch:'فرع الموظف', reason:'سبب تغيير النطاق', save:'حفظ الدور والفرع',
    history:'سجل الدور والفرع', more:'المزيد من السجل', sessions:'ينهي الحفظ جلسات الموظف السابقة.',
    blocked:'أعد إسناد الفرص والمتابعات المفتوحة أو سلّم التحكم في المحادثات النشطة للمتابعة.', stale:'تغيّر نطاق الموظف. أعد فتح الإعدادات قبل الحفظ.' },
  en: { title:'Role and branch', role:'Staff role', branch:'Staff branch', reason:'Scope change reason', save:'Save role and branch',
    history:'Role and branch history', more:'More history', sessions:'Saving signs the staff member out of their previous sessions.',
    blocked:'Reassign the owned leads and open follow-ups or transfer active conversation control before continuing.', stale:'The staff scope changed. Reopen these settings before saving.' },
  fr: { title:'Rôle et agence', role:'Rôle du collaborateur', branch:'Agence du collaborateur', reason:'Motif du changement de périmètre', save:'Enregistrer le rôle et l’agence',
    history:'Historique du rôle et de l’agence', more:'Afficher plus', sessions:'L’enregistrement met fin aux sessions précédentes du collaborateur.',
    blocked:'Réattribuez les prospects et suivis ouverts ou transférez le contrôle des conversations actives avant de continuer.', stale:'Le périmètre a changé. Rouvrez ces paramètres avant d’enregistrer.' },
};

export const staffOperationalScopeLabel = (locale: Locale) => labels[locale].title;

export function StaffOperationalScope({ id, locale, api, branches, onChanged }: {
  id: string; locale: Locale; api: Api; branches: Array<{ id: string; name: string; active: boolean }>; onChanged: () => Promise<void>;
}) {
  const t = labels[locale], path = `/api/users/${id}/operational-scope`;
  const [scope,setScope] = useState<Scope|null>(null);
  const [edit,setEdit] = useState<Edit|null>(null);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);

  function accept(value: Scope) {
    setScope(value); setEdit({ version: value.version, role: value.role, branchId: value.branchId, reason:'' });
  }
  useEffect(() => {
    const controller = new AbortController();
    void api<Scope>(path,{signal:controller.signal}).then(value => { if (!controller.signal.aborted) accept(value); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  },[api,path]);

  async function save() {
    if (!edit) return;
    setBusy(true); setError('');
    try {
      await api(path,{method:'PUT',body:JSON.stringify(edit)});
      accept(await api<Scope>(path));
      await onChanged();
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }
  async function more(before: number) {
    setBusy(true); setError('');
    try {
      const page = await api<Scope>(`${path}?before=${before}`);
      setScope(current => current ? {...current, items:[...current.items,...page.items], nextBefore:page.nextBefore} : page);
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }

  const feedback = error==='STAFF_SCOPE_REASSIGN_WORK' ? t.blocked : error==='STAFF_SCOPE_VERSION_CONFLICT' ? t.stale : error;
  return <div data-staff-operational-scope><h2>{t.title}</h2>
    {feedback && <p role="alert" className="error">{feedback}</p>}
    {scope && edit && <>
      <p>{t.sessions}</p>
      <form className="workflow-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <label>{t.role}<select value={edit.role} disabled={busy} onChange={event => setEdit({...edit,role:event.target.value as Role})}>
          <option value="AGENT">Agent</option><option value="MANAGER">Manager</option></select></label>
        <label>{t.branch}<select value={edit.branchId} disabled={busy} onChange={event => setEdit({...edit,branchId:event.target.value})}>
          {branches.filter(branch => branch.active || branch.id===scope.branchId).map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
        <label>{t.reason}<input required minLength={3} maxLength={500} disabled={busy} value={edit.reason}
          onChange={event => setEdit({...edit,reason:event.target.value})} /></label>
        <button disabled={busy || edit.reason.trim().length<3 || (edit.role===scope.role && edit.branchId===scope.branchId)}>{t.save}</button>
      </form>
      <h3>{t.history}</h3><ul className="timeline">{scope.items.map(item => <li key={item.version}>
        <span>{item.previousBranch} · {item.previousRole} → {item.branch} · {item.role}<small>{item.reason}</small></span>
        <time>{new Date(item.createdAt).toLocaleString(locale)}</time></li>)}</ul>
      {scope.nextBefore && <button type="button" className="secondary" disabled={busy} onClick={() => void more(scope.nextBefore!)}>{t.more}</button>}
    </>}
  </div>;
}
