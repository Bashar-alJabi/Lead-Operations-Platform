import { useEffect, useRef, useState } from 'react';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Filters = { branchId: string; actorId: string; targetId: string; action: string; from: string; through: string };
type AuditEvent = {
  id: string; createdAt: string; action: string; targetType: string; targetId: string | null;
  branchName: string | null; actorId: string | null; actorName: string | null; systemActor: boolean;
  lifecycleChange: { from: string; to: string } | null;
};
type AuditPage = { items: AuditEvent[]; nextBefore: string | null };
const initialFilters: Filters = { branchId: '', actorId: '', targetId: '', action: '', from: '', through: '' };
const emptyPage: AuditPage = { items: [], nextBefore: null };
const uuidInput = '[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}';
const labels = {
  ar: {
    branchId: 'الفرع', all: 'جميع الفروع', actorId: 'معرّف المستخدم', targetId: 'معرّف السجل', action: 'رمز الإجراء',
    from: 'من تاريخ (UTC)', through: 'حتى تاريخ شامل (UTC)', search: 'بحث في سجل التدقيق', more: 'أحداث أقدم',
    loading: 'جارٍ جلب أحداث التدقيق…', error: 'تعذّر جلب أحداث التدقيق.', empty: 'لا توجد أحداث تطابق البحث.',
    time: 'الوقت', scope: 'النطاق', actor: 'الفاعل', target: 'السجل', system: 'النظام', user: 'مستخدم', organization: 'المؤسسة',
  },
  en: {
    branchId: 'Branch', all: 'All branches', actorId: 'Actor ID', targetId: 'Record ID', action: 'Action code',
    from: 'From date (UTC)', through: 'Through date (UTC)', search: 'Search audit log', more: 'Older audit events',
    loading: 'Loading audit events…', error: 'Audit events could not be loaded.', empty: 'No audit events match the search.',
    time: 'Time', scope: 'Scope', actor: 'Actor', target: 'Record', system: 'System', user: 'User', organization: 'Organization',
  },
  fr: {
    branchId: 'Agence', all: 'Toutes les agences', actorId: 'Identifiant de l’auteur', targetId: 'Identifiant de la ressource', action: 'Code d’action',
    from: 'À partir du (UTC)', through: 'Jusqu’au inclus (UTC)', search: 'Rechercher dans le journal', more: 'Événements précédents',
    loading: 'Chargement des événements…', error: 'Impossible de charger les événements d’audit.', empty: 'Aucun événement ne correspond à la recherche.',
    time: 'Date', scope: 'Périmètre', actor: 'Auteur', target: 'Ressource', system: 'Système', user: 'Utilisateur', organization: 'Organisation',
  },
};

export function AuditWorkspace({ api, locale, organizationAccess, branches }: {
  api: Api; locale: keyof typeof labels; organizationAccess: boolean; branches: { id: string; name: string }[];
}) {
  const t = labels[locale];
  const [draft, setDraft] = useState<Filters>(initialFilters);
  const [applied, setApplied] = useState<Filters>(initialFilters);
  const [page, setPage] = useState<AuditPage>(emptyPage);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  const call = useRef(0);

  async function read(filters: Filters, cursor?: string) {
    const id = ++call.current;
    setBusy(true);
    setError(false);
    if (!cursor) {
      setApplied(filters);
      setPage(emptyPage);
    }
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value.trim()) query.set(key, value.trim());
    if (cursor) query.set('before', cursor);
    try {
      const response = await api<AuditPage>('/api/audit-events?' + query);
      if (id === call.current) setPage(current => ({
        items: cursor ? [...current.items, ...response.items] : response.items, nextBefore: response.nextBefore,
      }));
    } catch {
      if (id === call.current) {
        setPage(emptyPage);
        setError(true);
      }
    } finally {
      if (id === call.current) setBusy(false);
    }
  }

  useEffect(() => {
    void read(initialFilters);
    return () => { call.current++; };
  }, []);

  function input(key: Exclude<keyof Filters,'branchId'>, options: { type?: string; pattern?: string; min?: string; max?: string }) {
    return <label>{t[key]}<input {...options} value={draft[key]} onChange={event =>
      setDraft(current => ({ ...current, [key]: key === 'action' ? event.target.value.toUpperCase() : event.target.value }))} /></label>;
  }
  return <section className="panel" data-audit-workspace aria-busy={busy}>
    <form className="actions" onSubmit={event => { event.preventDefault(); void read(draft); }}>
      {organizationAccess && <label>{t.branchId}<select value={draft.branchId} onChange={event =>
        setDraft(current => ({ ...current, branchId: event.target.value }))}>
        <option value="">{t.all}</option>{branches.map(branch => <option value={branch.id} key={branch.id}>{branch.name}</option>)}
      </select></label>}
      {input('action', { pattern: '[A-Z][A-Z0-9_]{0,79}' })}
      {input('actorId', { pattern: uuidInput })}
      {input('targetId', { pattern: uuidInput })}
      {input('from', { type: 'date', max: draft.through || undefined })}
      {input('through', { type: 'date', min: draft.from || undefined })}
      <button disabled={busy}>{t.search}</button>
    </form>
    {busy && <p role="status">{t.loading}</p>}
    {error && <p role="alert">{t.error}</p>}
    {!error && !busy && !page.items.length && <p>{t.empty}</p>}
    {page.items.length > 0 && <div className="table-scroll"><table>
      <thead><tr><th>{t.time}</th><th>{t.scope}</th><th>{t.actor}</th><th>{t.action}</th><th>{t.target}</th></tr></thead>
      <tbody>{page.items.map(item => <tr key={item.id} data-audit-event={item.id}>
        <td><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString(locale)}</time></td>
        <td>{item.branchName ?? t.organization}</td>
        <td>{item.actorName ?? (item.systemActor ? t.system : t.user)}
          {item.actorId && <small><bdi>{item.actorId}</bdi></small>}</td>
        <td><bdi>{item.action}</bdi>
          {item.lifecycleChange && <small><bdi>{item.lifecycleChange.from} → {item.lifecycleChange.to}</bdi></small>}</td>
        <td><bdi>{item.targetType}</bdi>{item.targetId && <small><bdi>{item.targetId}</bdi></small>}</td>
      </tr>)}</tbody>
    </table></div>}
    {page.nextBefore && <button type="button" disabled={busy} onClick={() => void read(applied, page.nextBefore!)}>{t.more}</button>}
  </section>;
}
