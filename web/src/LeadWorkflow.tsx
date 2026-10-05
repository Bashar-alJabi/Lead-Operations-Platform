import { useEffect, useState } from 'react';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Locale = 'ar'|'fr'|'en';
type Role = 'SUPER_ADMIN'|'MANAGER'|'AGENT';
type Lead = { id: string; campaign_id: string; assigned_agent_id: string | null; version: number };
type Followup = { id: string; owner_user_id: string | null; due_at: string; status: string; priority: string; note: string | null; version: number };
type History = { id: number; event_type: string; detail: Record<string, unknown>; created_at: string };
type Assignment = { id: number; old_agent_id: string | null; old_agent_name: string | null;
  new_agent_id: string | null; new_agent_name: string | null; reason: string | null; created_at: string };
type Agent = { id: string; name: string };
type Page<T> = { items: T[]; nextCursor: string | number | null };
const labels = {
  ar: { assignment: 'الإسناد', current: 'الوكيل الحالي', reason: 'سبب الإسناد', unassigned: 'غير مسند', choose: 'اختر وكيلاً', search: 'بحث عن وكيل', moreAgents: 'المزيد من الوكلاء', reassign: 'تحديث الإسناد', assignmentHistory: 'سجل الإسناد', notes: 'ملاحظة داخلية', addNote: 'إضافة ملاحظة', followups: 'المتابعات', due: 'موعد المتابعة', priority: 'الأولوية', note: 'تفاصيل المهمة', create: 'إنشاء متابعة', edit: 'تحرير', save: 'حفظ', complete: 'إكمال', cancel: 'إلغاء', more: 'تحميل المزيد', activity: 'النشاط', overdue: 'متأخرة', upcoming: 'قادمة', completed: 'مكتملة', cancelled: 'ملغاة' },
  fr: { assignment: 'Attribution', current: 'Agent actuel', reason: 'Motif', unassigned: 'Non attribué', choose: 'Choisir un agent', search: 'Chercher un agent', moreAgents: 'Plus d’agents', reassign: 'Mettre à jour', assignmentHistory: 'Historique des attributions', notes: 'Note interne', addNote: 'Ajouter une note', followups: 'Suivis', due: 'Échéance', priority: 'Priorité', note: 'Détails', create: 'Créer un suivi', edit: 'Modifier', save: 'Enregistrer', complete: 'Terminer', cancel: 'Annuler', more: 'Afficher plus', activity: 'Activité', overdue: 'En retard', upcoming: 'À venir', completed: 'Terminé', cancelled: 'Annulé' },
  en: { assignment: 'Assignment', current: 'Current agent', reason: 'Reason', unassigned: 'Unassigned', choose: 'Choose agent', search: 'Search agents', moreAgents: 'More agents', reassign: 'Update assignment', assignmentHistory: 'Assignment history', notes: 'Internal note', addNote: 'Add note', followups: 'Follow-ups', due: 'Due at', priority: 'Priority', note: 'Task details', create: 'Create follow-up', edit: 'Edit', save: 'Save', complete: 'Complete', cancel: 'Cancel', more: 'Load more', activity: 'Activity', overdue: 'Overdue', upcoming: 'Upcoming', completed: 'Completed', cancelled: 'Cancelled' },
} as const;

export function LeadWorkflow({ lead, role, locale, api, onChanged }: {
  lead: Lead; role: Role; locale: Locale; api: Api; onChanged: () => Promise<void>;
}) {
  const t = labels[locale];
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [followupCursor, setFollowupCursor] = useState<string | null>(null);
  const [activity, setActivity] = useState<History[]>([]);
  const [activityCursor, setActivityCursor] = useState<number | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [assignmentCursor, setAssignmentCursor] = useState<number | null>(null);
  const [agentQuery, setAgentQuery] = useState('');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentCursor, setAgentCursor] = useState<string | null>(null);
  const [newAgentId, setNewAgentId] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [taskNote, setTaskNote] = useState('');
  const [priority, setPriority] = useState('NORMAL');
  const [editDueAt, setEditDueAt] = useState('');
  const [editTaskNote, setEditTaskNote] = useState('');
  const [editPriority, setEditPriority] = useState('NORMAL');
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() {
    const [tasks, events, history] = await Promise.all([
      api<Page<Followup>>(`/api/leads/${lead.id}/followups`),
      api<Page<History>>(`/api/leads/${lead.id}/activity`),
      api<Page<Assignment>>(`/api/leads/${lead.id}/assignments`),
    ]);
    setFollowups(tasks.items); setFollowupCursor(tasks.nextCursor as string | null);
    setActivity(events.items); setActivityCursor(events.nextCursor as number | null);
    setAssignments(history.items); setAssignmentCursor(history.nextCursor as number | null);
  }
  useEffect(() => { void load().catch((failure) => setError(String(failure))); }, [lead.id]);
  useEffect(() => {
    if (role === 'AGENT') return;
    let cancelled = false;
    const timer = window.setTimeout(() => { void api<Page<Agent>>(`/api/campaigns/${lead.campaign_id}/eligible-agents?q=${encodeURIComponent(agentQuery)}`)
      .then((page) => { if (!cancelled) { setAgents(page.items); setAgentCursor(page.nextCursor as string | null); } })
      .catch((failure) => { if (!cancelled) setError(String(failure)); }); }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [lead.id, lead.campaign_id, role, agentQuery]);
  async function mutate(path: string, method: 'POST'|'PATCH', payload: object): Promise<boolean> {
    setBusy(true); setError('');
    try { await api(path, { method, body: JSON.stringify(payload) }); await onChanged(); await load(); return true; }
    catch (failure) { setError(String(failure)); return false; } finally { setBusy(false); }
  }
  const time = (value: string) => new Date(value).toLocaleString(locale);
  const localInput = (value: string) => {
    const date = new Date(value); const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  };
  return <div className="lead-workflow">
    {error && <p role="alert" className="error">{error}</p>}
    {role !== 'AGENT' && <section className="panel"><h3>{t.assignment}</h3>
      <p>{t.current}: {agents.find((agent) => agent.id === lead.assigned_agent_id)?.name ?? lead.assigned_agent_id ?? t.unassigned}</p>
      <form className="workflow-form" onSubmit={(event) => { event.preventDefault(); void mutate(`/api/leads/${lead.id}/assignment`, 'POST',
        { version: lead.version, agentId: newAgentId || null, reason }); }}>
        <label>{t.search}<input value={agentQuery} onChange={(event) => setAgentQuery(event.target.value)} /></label>
        <label>{t.assignment}<select value={newAgentId} onChange={(event) => setNewAgentId(event.target.value)}>
          <option value="">{t.unassigned}</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        <label>{t.reason}<input maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        <button disabled={busy}>{t.reassign}</button>
      </form>
      {agentCursor && <button className="secondary" onClick={() => { void api<Page<Agent>>(
        `/api/campaigns/${lead.campaign_id}/eligible-agents?q=${encodeURIComponent(agentQuery)}&after=${agentCursor}`)
        .then((page) => { setAgents((current) => [...current, ...page.items]); setAgentCursor(page.nextCursor as string | null); })
        .catch((failure) => setError(String(failure))); }}>{t.moreAgents}</button>}
    </section>}
    <section className="panel"><h3>{t.assignmentHistory}</h3><ul className="timeline">{assignments.map((item) => <li key={item.id}>
      <span>{item.old_agent_name ?? t.unassigned} → {item.new_agent_name ?? t.unassigned}{item.reason && <small>{item.reason}</small>}</span><time>{time(item.created_at)}</time>
    </li>)}</ul>{assignmentCursor && <button className="secondary" onClick={() => { void api<Page<Assignment>>(
      `/api/leads/${lead.id}/assignments?before=${assignmentCursor}`)
      .then((page) => { setAssignments((current) => [...current, ...page.items]); setAssignmentCursor(page.nextCursor as number | null); })
      .catch((failure) => setError(String(failure))); }}>{t.more}</button>}</section>
    <section className="panel"><h3>{t.notes}</h3><form className="workflow-form" onSubmit={(event) => { event.preventDefault(); void mutate(`/api/leads/${lead.id}/notes`, 'POST', { text: note }).then((ok) => { if (ok) setNote(''); }); }}>
      <label>{t.notes}<textarea required maxLength={4000} value={note} onChange={(event) => setNote(event.target.value)} /></label><button disabled={busy}>{t.addNote}</button>
    </form></section>
    <section className="panel"><h3>{t.followups}</h3>
      <form className="workflow-form" onSubmit={(event) => { event.preventDefault(); void mutate(`/api/leads/${lead.id}/followups`, 'POST',
        { dueAt: new Date(dueAt).toISOString(), note: taskNote, priority }).then((ok) => { if (ok) { setDueAt(''); setTaskNote(''); } }); }}>
        <label>{t.due}<input type="datetime-local" required value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
        <label>{t.priority}<select value={priority} onChange={(event) => setPriority(event.target.value)}><option>LOW</option><option>NORMAL</option><option>HIGH</option></select></label>
        <label>{t.note}<input maxLength={4000} value={taskNote} onChange={(event) => setTaskNote(event.target.value)} /></label>
        <button disabled={busy}>{t.create}</button>
      </form>
      <div className="table-scroll"><table><thead><tr><th>{t.due}</th><th>{t.priority}</th><th>{t.note}</th><th></th></tr></thead><tbody>
        {followups.map((item) => <tr key={item.id}><td>{time(item.due_at)}<small>{item.status === 'OPEN' ?
          new Date(item.due_at) < new Date() ? t.overdue : t.upcoming : item.status === 'COMPLETED' ? t.completed : t.cancelled}</small></td>
          <td>{item.priority}</td><td>{item.note ?? '—'}</td><td>{item.status === 'OPEN' && <div className="actions">
            <button className="link" disabled={busy} onClick={() => { setEditing(editing === item.id ? null : item.id); setEditDueAt(localInput(item.due_at)); setEditTaskNote(item.note ?? ''); setEditPriority(item.priority); }}>{t.edit}</button>
            <button className="link" disabled={busy} onClick={() => void mutate(`/api/followups/${item.id}`, 'PATCH', { version: item.version, status: 'COMPLETED' })}>{t.complete}</button>
            {role !== 'AGENT' && <button className="link" disabled={busy} onClick={() => void mutate(`/api/followups/${item.id}`, 'PATCH', { version: item.version, status: 'CANCELLED' })}>{t.cancel}</button>}
          </div>}{editing === item.id && <form className="workflow-form" onSubmit={(event) => { event.preventDefault(); void mutate(`/api/followups/${item.id}`, 'PATCH',
            { version: item.version, dueAt: new Date(editDueAt).toISOString(), note: editTaskNote, priority: editPriority }).then((ok) => { if (ok) setEditing(null); }); }}>
            <label>{t.due}<input type="datetime-local" required value={editDueAt} onChange={(event) => setEditDueAt(event.target.value)} /></label>
            <label>{t.priority}<select value={editPriority} onChange={(event) => setEditPriority(event.target.value)}><option>LOW</option><option>NORMAL</option><option>HIGH</option></select></label>
            <label>{t.note}<input value={editTaskNote} maxLength={4000} onChange={(event) => setEditTaskNote(event.target.value)} /></label>
            <button disabled={busy}>{t.save}</button></form>}</td></tr>)}</tbody></table></div>
      {followupCursor && <button className="secondary" onClick={() => { void api<Page<Followup>>(
        `/api/leads/${lead.id}/followups?cursor=${encodeURIComponent(followupCursor)}`)
        .then((page) => { setFollowups((current) => [...current, ...page.items]); setFollowupCursor(page.nextCursor as string | null); })
        .catch((failure) => setError(String(failure))); }}>{t.more}</button>}
    </section>
    <section className="panel"><h3>{t.activity}</h3><ul className="timeline">{activity.map((item) => <li key={item.id}>
      <span>{item.event_type}{item.event_type === 'NOTE_ADDED' && <small>{String(item.detail.text ?? '')}</small>}</span><time>{time(item.created_at)}</time>
    </li>)}</ul>{activityCursor && <button className="secondary" onClick={() => { void api<Page<History>>(
      `/api/leads/${lead.id}/activity?before=${activityCursor}`)
      .then((page) => { setActivity((current) => [...current, ...page.items]); setActivityCursor(page.nextCursor as number | null); })
      .catch((failure) => setError(String(failure))); }}>{t.more}</button>}</section>
  </div>;
}

export function FollowupQueue({ locale, api, onOpenLead }: { locale: Locale; api: Api; onOpenLead: (id: string) => void }) {
  const t = labels[locale];
  const [items, setItems] = useState<Array<Followup & { lead_id: string; contact_name: string|null }>>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  async function load(next?: string) {
    const page = await api<Page<Followup & { lead_id: string; contact_name: string|null }>>(
      `/api/followups${next ? '?cursor=' + encodeURIComponent(next) : ''}`);
    setItems((current) => next ? [...current, ...page.items] : page.items);
    setCursor(page.nextCursor as string | null);
  }
  useEffect(() => { void load().catch((failure) => setError(String(failure))); }, []);
  return <section className="panel"><h2>{t.followups}</h2>{error && <p role="alert" className="error">{error}</p>}
    <div className="table-scroll"><table><thead><tr><th>{t.current}</th><th>{t.due}</th><th>{t.priority}</th><th></th></tr></thead><tbody>
      {items.map((item) => <tr key={item.id}><td>{item.contact_name || `Lead ${item.lead_id}`}</td><td>{new Date(item.due_at).toLocaleString(locale)}
        <small>{new Date(item.due_at) < new Date() ? t.overdue : t.upcoming}</small></td><td>{item.priority}</td>
        <td><button className="link" onClick={() => onOpenLead(item.lead_id)}>{t.edit}</button></td></tr>)}</tbody></table></div>
    {cursor && <button className="secondary" onClick={() => { void load(cursor).catch((failure) => setError(String(failure))); }}>{t.more}</button>}
  </section>;
}
