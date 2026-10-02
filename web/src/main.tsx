import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Role = 'SUPER_ADMIN' | 'MANAGER' | 'AGENT';
type User = { id: string; organizationId: string; branchId: string | null; role: Role; name: string; email: string };
type Branch = { id: string; name: string; timezone: string; active: boolean };
type Campaign = { id: string; branch_id: string; name: string; status: string; routing_method?: string; agents?: { agentId: string; name: string }[] };
type Lead = { id: string; branch_id: string; campaign_id: string; assigned_agent_id: string | null; lifecycle: string; contact_name: string; phone: string | null; email: string | null; needs_attention_reason: string | null; created_at: string };
type ManagedUser = { id: string; branch_id: string | null; role: Role; name: string; email: string; active: boolean };
type Locale = 'ar' | 'fr' | 'en';
type Page = 'leads' | 'campaigns' | 'branches' | 'users' | 'profile';

const labels = {
  ar: { app: 'إدارة العملاء والعمليات', login: 'تسجيل الدخول', setup: 'إعداد المسؤول الأول', email: 'البريد الإلكتروني', password: 'كلمة المرور', token: 'رمز التهيئة', organization: 'اسم المؤسسة', name: 'الاسم', enter: 'دخول', save: 'حفظ', create: 'إنشاء', logout: 'خروج', leads: 'الفرص', campaigns: 'الحملات', branches: 'الفروع', users: 'المستخدمون', noData: 'لا توجد سجلات بعد.', loading: 'جاري التحميل…', branch: 'الفرع', campaign: 'الحملة', contact: 'جهة الاتصال', phone: 'الهاتف', timezone: 'المنطقة الزمنية', role: 'الدور', status: 'الحالة', routing: 'التوزيع', details: 'التفاصيل', active: 'نشط', inactive: 'غير نشط', source: 'المصدر', newLead: 'فرصة جديدة', newCampaign: 'حملة جديدة', newBranch: 'فرع جديد', newUser: 'مستخدم جديد', lifecycle: 'حالة الفرصة', assign: 'المسؤول', actions: 'إجراءات', close: 'إغلاق', reopen: 'إعادة فتح', archive: 'أرشفة', activity: 'النشاط', back: 'عودة', initialSetup: 'أدخل رمز التهيئة الذي أنشأه مسؤول النشر.', accessDenied: 'غير مصرح لك بهذه العملية.', error: 'تعذّر إكمال الطلب.', retry: 'إعادة المحاولة', sourceManual: 'يدوي', activate: 'تفعيل', select: 'اختر', attention: 'بحاجة إلى متابعة' },
  fr: { app: 'Opérations commerciales', login: 'Connexion', setup: 'Premier administrateur', email: 'Adresse e-mail', password: 'Mot de passe', token: 'Jeton initial', organization: 'Organisation', name: 'Nom', enter: 'Se connecter', save: 'Enregistrer', create: 'Créer', logout: 'Déconnexion', leads: 'Prospects', campaigns: 'Campagnes', branches: 'Agences', users: 'Utilisateurs', noData: 'Aucun élément pour le moment.', loading: 'Chargement…', branch: 'Agence', campaign: 'Campagne', contact: 'Contact', phone: 'Téléphone', timezone: 'Fuseau horaire', role: 'Rôle', status: 'État', routing: 'Attribution', details: 'Détails', active: 'Actif', inactive: 'Inactif', source: 'Source', newLead: 'Nouveau prospect', newCampaign: 'Nouvelle campagne', newBranch: 'Nouvelle agence', newUser: 'Nouvel utilisateur', lifecycle: 'Cycle', assign: 'Responsable', actions: 'Actions', close: 'Fermer', reopen: 'Rouvrir', archive: 'Archiver', activity: 'Activité', back: 'Retour', initialSetup: 'Saisissez le jeton créé par le responsable du déploiement.', accessDenied: 'Action non autorisée.', error: 'La demande a échoué.', retry: 'Réessayer', sourceManual: 'Manuel', activate: 'Activer', select: 'Choisir', attention: 'À examiner' },
  en: { app: 'Lead operations', login: 'Sign in', setup: 'First administrator', email: 'Email', password: 'Password', token: 'Setup token', organization: 'Organization', name: 'Name', enter: 'Sign in', save: 'Save', create: 'Create', logout: 'Sign out', leads: 'Leads', campaigns: 'Campaigns', branches: 'Branches', users: 'Users', noData: 'No records yet.', loading: 'Loading…', branch: 'Branch', campaign: 'Campaign', contact: 'Contact', phone: 'Phone', timezone: 'Time zone', role: 'Role', status: 'Status', routing: 'Routing', details: 'Details', active: 'Active', inactive: 'Inactive', source: 'Source', newLead: 'New lead', newCampaign: 'New campaign', newBranch: 'New branch', newUser: 'New user', lifecycle: 'Lead lifecycle', assign: 'Owner', actions: 'Actions', close: 'Close', reopen: 'Reopen', archive: 'Archive', activity: 'Activity', back: 'Back', initialSetup: 'Enter the one-time token from the deployment administrator.', accessDenied: 'You do not have access.', error: 'The request failed.', retry: 'Retry', sourceManual: 'Manual', activate: 'Activate', select: 'Select', attention: 'Needs attention' },
} as const;

const profileLabels = {
  ar: { profile: 'حسابي', currentPassword: 'كلمة المرور الحالية', newPassword: 'كلمة المرور الجديدة', passwordChanged: 'ستُنهى جميع جلساتك بعد تغيير كلمة المرور.' },
  fr: { profile: 'Mon compte', currentPassword: 'Mot de passe actuel', newPassword: 'Nouveau mot de passe', passwordChanged: 'Toutes vos sessions seront fermées après le changement.' },
  en: { profile: 'My account', currentPassword: 'Current password', newPassword: 'New password', passwordChanged: 'All your sessions will end after changing your password.' },
} as const;

const managementLabels = {
  ar: { assignAgent: 'إضافة وكيل', disable: 'تعطيل', enable: 'تفعيل الحساب' },
  fr: { assignAgent: 'Ajouter un agent', disable: 'Désactiver', enable: 'Activer le compte' },
  en: { assignAgent: 'Add agent', disable: 'Disable', enable: 'Enable account' },
} as const;

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...options?.headers }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  return body as T;
}

function App() {
  const [locale, setLocale] = useState<Locale>(() => (localStorage.getItem('lop-locale') as Locale) || 'ar');
  const t = { ...labels[locale], ...profileLabels[locale], ...managementLabels[locale] };
  const [user, setUser] = useState<User | null>(null);
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [page, setPage] = useState<Page>('leads');
  const [selectedLead, setSelectedLead] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [nextLeadCursor, setNextLeadCursor] = useState<string | null>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [detail, setDetail] = useState<{ lead: Lead; activities: { id: number; event_type: string; created_at: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState<Record<string, string>>({});
  const [showForm, setShowForm] = useState(false);
  const [campaignAgentChoice, setCampaignAgentChoice] = useState<Record<string, string>>({});

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
    localStorage.setItem('lop-locale', locale);
  }, [locale]);

  useEffect(() => {
    void Promise.all([api<{ initialized: boolean }>('/api/setup/status'), api<User>('/api/auth/me').catch(() => null)])
      .then(([setup, current]) => { setInitialized(setup.initialized); setUser(current); })
      .catch((failure) => { setInitialized(true); setError(String(failure)); });
  }, []);

  async function refresh() {
    if (!user) return;
    setBusy(true); setError('');
    try {
      const [branchResult, campaignResult, leadResult, userResult] = await Promise.all([
        api<{ items: Branch[] }>('/api/branches'), api<{ items: Campaign[] }>('/api/campaigns'),
        api<{ items: Lead[]; nextCursor: string | null }>('/api/leads?limit=50'),
        user.role === 'AGENT' ? Promise.resolve({ items: [] as ManagedUser[] }) : api<{ items: ManagedUser[] }>('/api/users'),
      ]);
      setBranches(branchResult.items); setCampaigns(campaignResult.items); setLeads(leadResult.items); setNextLeadCursor(leadResult.nextCursor); setUsers(userResult.items);
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, [user?.id]);
  useEffect(() => {
    if (!selectedLead) { setDetail(null); return; }
    void api<typeof detail>(`/api/leads/${selectedLead}`).then(setDetail).catch((failure) => setError(String(failure)));
  }, [selectedLead]);

  async function submit(path: string, payload: unknown, after?: () => void) {
    setBusy(true); setError('');
    try { await api(path, { method: 'POST', body: JSON.stringify(payload) }); after?.(); setForm({}); setShowForm(false); await refresh(); }
    catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }

  const field = (key: string, label: string, type = 'text', required = true) => <label key={key}>{label}<input type={type} required={required} value={form[key] ?? ''}
    onChange={(event) => setForm({ ...form, [key]: event.target.value })} /></label>;
  const select = (key: string, label: string, options: { value: string; text: string }[]) => <label key={key}>{label}<select required value={form[key] ?? ''}
    onChange={(event) => setForm({ ...form, [key]: event.target.value })}><option value="">{t.select}</option>{options.map((option) => <option key={option.value} value={option.value}>{option.text}</option>)}</select></label>;
  const branchOptions = branches.map((branch) => ({ value: branch.id, text: branch.name }));
  const campaignOptions = campaigns.filter((campaign) => campaign.status === 'ACTIVE' && (!form.branchId || campaign.branch_id === form.branchId)).map((campaign) => ({ value: campaign.id, text: campaign.name }));
  const language = <select aria-label="Language" value={locale} onChange={(event) => setLocale(event.target.value as Locale)}><option value="ar">العربية</option><option value="fr">Français</option><option value="en">English</option></select>;

  if (initialized === null) return <main className="center">{t.loading}</main>;
  if (!user) return <main className="auth-shell"><div className="auth-card"><div className="brand">{t.app}</div><div className="language">{language}</div>
    <h1>{initialized ? t.login : t.setup}</h1>{!initialized && <p>{t.initialSetup}</p>}
    {error && <div role="alert" className="error">{error}</div>}
    <form onSubmit={(event) => { event.preventDefault(); setBusy(true); setError(''); const path = initialized ? '/api/auth/login' : '/api/setup/bootstrap';
      api(path, { method: 'POST', body: JSON.stringify(initialized ? { email: form.email, password: form.password } :
        { token: form.token, organizationName: form.organizationName, name: form.name, email: form.email, password: form.password }) })
        .then(() => initialized ? undefined : api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: form.email, password: form.password }) }))
        .then(() => api<User>('/api/auth/me')).then((current) => { setUser(current); setInitialized(true); setForm({}); })
        .catch((failure) => setError(String(failure))).finally(() => setBusy(false)); }}>
      {!initialized && <>{field('token', t.token, 'password')}{field('organizationName', t.organization)}{field('name', t.name)}</>}
      {field('email', t.email, 'email')}{field('password', t.password, 'password')}
      <button disabled={busy}>{busy ? t.loading : initialized ? t.enter : t.create}</button>
    </form></div></main>;

  const isAdmin = user.role === 'SUPER_ADMIN';
  const canManage = user.role !== 'AGENT';
  return <div className="app-shell"><aside className="sidebar"><div className="brand">{t.app}</div><div className="user-block"><strong>{user.name}</strong><span>{user.role.replace('_', ' ')}</span></div>
    <nav>{(['leads','campaigns','branches','users','profile'] as Page[]).filter((item) => canManage || item === 'leads' || item === 'profile').map((item) =>
      <button key={item} className={page === item ? 'selected' : ''} onClick={() => { setPage(item); setSelectedLead(null); setShowForm(false); setForm({}); }}>{t[item]}</button>)}</nav>
    <div className="sidebar-bottom">{language}<button onClick={() => { void api('/api/auth/logout', { method: 'POST' }).then(() => setUser(null)); }}>{t.logout}</button></div>
  </aside><main className="content"><header><div><small>Lead Operations</small><h1>{selectedLead ? t.details : t[page]}</h1></div><button className="secondary" onClick={() => void refresh()} disabled={busy}>{t.retry}</button></header>
    {error && <div role="alert" className="error">{error}</div>}
    {busy && <div className="loading">{t.loading}</div>}
    {page === 'profile' ? <section className="panel form-panel"><h2>{t.profile}</h2><p>{t.passwordChanged}</p>
      <form onSubmit={(event) => { event.preventDefault(); setBusy(true); setError('');
        void api('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword: form.currentPassword, newPassword: form.newPassword }) })
          .then(() => { setUser(null); setForm({}); setPage('leads'); }).catch((failure) => setError(String(failure))).finally(() => setBusy(false)); }}>
        {field('currentPassword', t.currentPassword, 'password')}{field('newPassword', t.newPassword, 'password')}
        <button disabled={busy}>{t.save}</button></form></section> : selectedLead && detail ? <section className="panel"><button className="link" onClick={() => setSelectedLead(null)}>{t.back}</button><h2>{detail.lead.contact_name}</h2>
      <div className="facts"><div><small>{t.phone}</small><strong>{detail.lead.phone || '—'}</strong></div><div><small>{t.email}</small><strong>{detail.lead.email || '—'}</strong></div>
      <div><small>{t.lifecycle}</small><strong>{detail.lead.lifecycle}</strong></div><div><small>{t.assign}</small><strong>{users.find((item) => item.id === detail.lead.assigned_agent_id)?.name || '—'}</strong></div></div>
      {canManage && <div className="actions">{(['OPEN','CLOSED','ARCHIVED'] as const).filter((state) => state !== detail.lead.lifecycle).map((state) =>
        <button key={state} className="secondary" onClick={() => { setBusy(true); api(`/api/leads/${selectedLead}/lifecycle`, { method: 'POST', body: JSON.stringify({ lifecycle: state }) })
          .then(() => api<typeof detail>(`/api/leads/${selectedLead}`)).then(setDetail).catch((failure) => setError(String(failure))).finally(() => setBusy(false)); }}>{state === 'OPEN' ? t.reopen : state === 'CLOSED' ? t.close : t.archive}</button>)}</div>}
      <h3>{t.activity}</h3><ul className="timeline">{detail.activities.map((item) => <li key={item.id}><span>{item.event_type}</span><time>{new Date(item.created_at).toLocaleString(locale)}</time></li>)}</ul>
    </section> : <>
      <div className="toolbar">{canManage && (page !== 'branches' || isAdmin) && <button onClick={() => { setShowForm(!showForm); setForm({}); }}>{page === 'leads' ? t.newLead : page === 'campaigns' ? t.newCampaign : page === 'branches' ? t.newBranch : t.newUser}</button>}</div>
      {showForm && <section className="panel form-panel"><h2>{page === 'leads' ? t.newLead : page === 'campaigns' ? t.newCampaign : page === 'branches' ? t.newBranch : t.newUser}</h2>
        <form onSubmit={(event) => { event.preventDefault(); if (page === 'branches') void submit('/api/branches', { name: form.name, timezone: form.timezone });
          if (page === 'campaigns') void submit('/api/campaigns', { name: form.name, branchId: form.branchId, routingMethod: form.routingMethod || 'MANUAL' });
          if (page === 'leads') void submit('/api/leads', { branchId: form.branchId, campaignId: form.campaignId, contact: { name: form.name, phone: form.phone || undefined, email: form.email || undefined } });
          if (page === 'users') void submit('/api/users', { branchId: form.role === 'SUPER_ADMIN' ? undefined : form.branchId, role: form.role, name: form.name, email: form.email, password: form.password }); }}>
          {page === 'branches' && <>{field('name', t.name)}{field('timezone', t.timezone)}</>}
          {page === 'campaigns' && <>{field('name', t.name)}{select('branchId', t.branch, branchOptions)}{select('routingMethod', t.routing, ['MANUAL','ROUND_ROBIN','WEIGHTED','PERFORMANCE'].map((value) => ({ value, text: value })))}</>}
          {page === 'leads' && <>{select('branchId', t.branch, branchOptions)}{select('campaignId', t.campaign, campaignOptions)}{field('name', t.contact)}{field('phone', t.phone, 'tel', false)}{field('email', t.email, 'email', false)}</>}
          {page === 'users' && <>{field('name', t.name)}{field('email', t.email, 'email')}{field('password', t.password, 'password')}{select('role', t.role, (isAdmin ? ['SUPER_ADMIN','MANAGER','AGENT'] : ['AGENT']).map((value) => ({ value, text: value })))}{form.role !== 'SUPER_ADMIN' && select('branchId', t.branch, branchOptions)}</>}
          <button disabled={busy}>{t.save}</button></form></section>}
      <section className="panel table-panel"><div className="table-scroll"><table><thead><tr>{page === 'leads' ? <><th>{t.contact}</th><th>{t.campaign}</th><th>{t.branch}</th><th>{t.lifecycle}</th><th>{t.assign}</th><th>{t.actions}</th></> :
        page === 'campaigns' ? <><th>{t.name}</th><th>{t.branch}</th><th>{t.status}</th><th>{t.routing}</th><th>{t.actions}</th></> :
        page === 'branches' ? <><th>{t.name}</th><th>{t.timezone}</th><th>{t.status}</th></> :
        <><th>{t.name}</th><th>{t.email}</th><th>{t.role}</th><th>{t.branch}</th><th>{t.status}</th><th>{t.actions}</th></>}</tr></thead><tbody>
        {page === 'leads' && leads.map((lead) => <tr key={lead.id}><td><strong>{lead.contact_name}</strong><small>{lead.phone || lead.email}</small></td><td>{campaigns.find((item) => item.id === lead.campaign_id)?.name || lead.campaign_id}</td><td>{branches.find((item) => item.id === lead.branch_id)?.name || '—'}</td><td><span className="badge">{lead.lifecycle}</span>{lead.needs_attention_reason && <small className="attention">{t.attention}</small>}</td><td>{users.find((item) => item.id === lead.assigned_agent_id)?.name || '—'}</td><td><button className="link" onClick={() => setSelectedLead(lead.id)}>{t.details}</button></td></tr>)}
        {page === 'campaigns' && campaigns.map((campaign) => <tr key={campaign.id}><td><strong>{campaign.name}</strong></td><td>{branches.find((item) => item.id === campaign.branch_id)?.name || '—'}</td><td><span className="badge">{campaign.status}</span></td><td>{campaign.routing_method}<small>{campaign.agents?.map((agent) => agent.name).join(', ') || '—'}</small></td><td>{canManage && <div className="actions">
          {campaign.status !== 'ACTIVE' && <button className="link" onClick={() => void submit(`/api/campaigns/${campaign.id}/activate`, {})}>{t.activate}</button>}
          <select aria-label={t.assignAgent} value={campaignAgentChoice[campaign.id] ?? ''} onChange={(event) => setCampaignAgentChoice({ ...campaignAgentChoice, [campaign.id]: event.target.value })}>
            <option value="">{t.select}</option>{users.filter((item) => item.role === 'AGENT' && item.active && item.branch_id === campaign.branch_id && !campaign.agents?.some((agent) => agent.agentId === item.id))
              .map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select><button className="link" disabled={!campaignAgentChoice[campaign.id] || busy} onClick={() => { setBusy(true); setError('');
            void api(`/api/campaigns/${campaign.id}/agents`, { method: 'PUT', body: JSON.stringify({ agentId: campaignAgentChoice[campaign.id] }) })
              .then(() => { setCampaignAgentChoice({ ...campaignAgentChoice, [campaign.id]: '' }); return refresh(); })
              .catch((failure) => setError(String(failure))).finally(() => setBusy(false)); }}>{t.assignAgent}</button>
        </div>}</td></tr>)}
        {page === 'branches' && branches.map((branch) => <tr key={branch.id}><td><strong>{branch.name}</strong></td><td>{branch.timezone}</td><td>{branch.active ? t.active : t.inactive}</td></tr>)}
        {page === 'users' && users.map((item) => <tr key={item.id}><td><strong>{item.name}</strong></td><td>{item.email}</td><td>{item.role}</td><td>{branches.find((branch) => branch.id === item.branch_id)?.name || '—'}</td><td>{item.active ? t.active : t.inactive}</td><td>{item.id !== user.id && (isAdmin || (item.role === 'AGENT' && item.branch_id === user.branchId)) &&
          <button className="link" disabled={busy} onClick={() => { setBusy(true); setError('');
            void api(`/api/users/${item.id}/status`, { method: 'PATCH', body: JSON.stringify({ active: !item.active }) })
              .then(() => refresh()).catch((failure) => setError(String(failure))).finally(() => setBusy(false)); }}>{item.active ? t.disable : t.enable}</button>}</td></tr>)}
        </tbody></table></div>{(page === 'leads' ? leads : page === 'campaigns' ? campaigns : page === 'branches' ? branches : users).length === 0 && <div className="empty">{t.noData}</div>}
        {page === 'leads' && nextLeadCursor && <div className="load-more"><button className="secondary" disabled={busy} onClick={() => { setBusy(true);
          api<{ items: Lead[]; nextCursor: string | null }>(`/api/leads?limit=50&cursor=${encodeURIComponent(nextLeadCursor)}`)
            .then((result) => { setLeads((existing) => [...existing, ...result.items]); setNextLeadCursor(result.nextCursor); })
            .catch((failure) => setError(String(failure))).finally(() => setBusy(false)); }}>{locale === 'ar' ? 'تحميل المزيد' : locale === 'fr' ? 'Afficher plus' : 'Load more'}</button></div>}</section>
    </>}
  </main></div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
