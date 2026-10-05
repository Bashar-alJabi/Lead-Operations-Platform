import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { ContactWorkspace } from './ContactWorkspace.js';
import { LeadFields, LeadCreationFields } from './LeadFields.js';
import { FieldWorkspace } from './FieldWorkspace.js';
import { CampaignWorkspace } from './CampaignWorkspace.js';
import { FollowupQueue, LeadWorkflow } from './LeadWorkflow.js';
import { LeadSearch, defaultLeadColumns, type LeadColumn } from './LeadSearch.js';
import { MessagingSetup } from './MessagingSetup.js';
import { LeadConversations } from './LeadConversations.js';
import { MetaSourceSetup } from './MetaSourceSetup.js';
import { PaymentSetup } from './PaymentSetup.js';
import { LeadPaymentMethods } from './PaymentMethods.js';

type Role = 'SUPER_ADMIN' | 'MANAGER' | 'AGENT';
type User = { id: string; organizationId: string; branchId: string | null; role: Role; name: string; email: string };
type Branch = { id: string; name: string; timezone: string; active: boolean };
type Campaign = { id: string; branch_id: string; name: string; status: string; routing_method?: string; agents?: { agentId: string; name: string }[] };
type Lead = { id: string; branch_id: string; campaign_id: string; assigned_agent_id: string | null; lifecycle: string; source_kind: string;
  contact_id:string|null; contact_name: string|null; phone: string | null; email: string | null; needs_attention_reason: string | null;
  created_at: string; next_followup_at: string | null; version: number };
type ManagedUser = { id: string; branch_id: string | null; role: Role; name: string; email: string; active: boolean; credential_state: 'INVITED'|'READY' };
type EmailConnection = { configured: boolean; id?: string; name?: string; status?: string; hasCredential?: boolean; settings?: { host: string; port: number; secure: boolean; username: string; fromAddress: string } };
type DeliveryJob = { id: string; kind: string; status: string; attempts: number; max_attempts: number; last_error_code: string | null; email: string; name: string; created_at: string };
type Locale = 'ar' | 'fr' | 'en';
type Page = 'leads' | 'contacts' | 'contactReviews' | 'fields' | 'campaigns' | 'branches' | 'users' | 'profile' | 'identityEmail' | 'followups' | 'messagingSetup' | 'metaSources' | 'paymentSetup';
type AuthMode = 'login' | 'forgot' | 'reset' | 'invite';
const linkParameters = new URLSearchParams(window.location.hash.slice(1));
const initialLinkMode: AuthMode = linkParameters.has('invite') ? 'invite' : linkParameters.has('reset') ? 'reset' : 'login';
const initialLinkToken = linkParameters.get('invite') ?? linkParameters.get('reset');

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

const missingContact={ ar:'بيانات جهة الاتصال غير متوفرة',fr:'Contact indisponible',en:'Contact unavailable' } as const;
function contactLabel(lead:Pick<Lead,'contact_id'|'contact_name'>,locale:Locale):string {
  return lead.contact_name || (lead.contact_id ? labels[locale].contact : missingContact[locale]);
}

const managementLabels = {
  ar: { assignAgent: 'إضافة وكيل', disable: 'تعطيل', enable: 'تفعيل الحساب' },
  fr: { assignAgent: 'Ajouter un agent', disable: 'Désactiver', enable: 'Activer le compte' },
  en: { assignAgent: 'Add agent', disable: 'Disable', enable: 'Enable account' },
} as const;

const identityLabels = {
  ar: { identityEmail: 'بريد الحسابات', forgot: 'نسيت كلمة المرور', reset: 'استعادة كلمة المرور', invite: 'قبول الدعوة', sendReset: 'إرسال رابط الاستعادة', recoveryNotice: 'إذا كان الحساب مؤهلاً، سيصل رابط الاستعادة إلى بريده.', passwordSet: 'تم تعيين كلمة المرور. سجّل الدخول الآن.', backToLogin: 'العودة لتسجيل الدخول', inviteAgain: 'إعادة الدعوة', invited: 'بانتظار الدعوة', emailHost: 'خادم SMTP', emailPort: 'المنفذ', emailUsername: 'اسم مستخدم SMTP', emailPassword: 'كلمة مرور SMTP', fromAddress: 'عنوان المرسل', secureSmtp: 'TLS مباشر', testConnection: 'اختبار الاتصال', emailStatus: 'حالة الاتصال' },
  fr: { identityEmail: 'E-mail des comptes', forgot: 'Mot de passe oublié', reset: 'Réinitialiser le mot de passe', invite: 'Accepter l’invitation', sendReset: 'Envoyer le lien', recoveryNotice: 'Si le compte est admissible, un lien sera envoyé à son adresse.', passwordSet: 'Mot de passe défini. Connectez-vous.', backToLogin: 'Retour à la connexion', inviteAgain: 'Renvoyer l’invitation', invited: 'Invitation en attente', emailHost: 'Serveur SMTP', emailPort: 'Port', emailUsername: 'Utilisateur SMTP', emailPassword: 'Mot de passe SMTP', fromAddress: 'Adresse expéditrice', secureSmtp: 'TLS direct', testConnection: 'Tester la connexion', emailStatus: 'État de la connexion' },
  en: { identityEmail: 'Account email', forgot: 'Forgot password', reset: 'Reset password', invite: 'Accept invitation', sendReset: 'Send reset link', recoveryNotice: 'If the account is eligible, a reset link will be emailed.', passwordSet: 'Password set. Sign in now.', backToLogin: 'Back to sign in', inviteAgain: 'Resend invitation', invited: 'Invitation pending', emailHost: 'SMTP host', emailPort: 'Port', emailUsername: 'SMTP username', emailPassword: 'SMTP password', fromAddress: 'From address', secureSmtp: 'Direct TLS', testConnection: 'Test connection', emailStatus: 'Connection status' },
} as const;

const deliveryLabels = {
  ar: { deliveries: 'حالة رسائل الحسابات', retryDelivery: 'إعادة المحاولة', attempts: 'المحاولات' },
  fr: { deliveries: 'Livraison des courriels de compte', retryDelivery: 'Réessayer', attempts: 'Tentatives' },
  en: { deliveries: 'Account email delivery', retryDelivery: 'Retry delivery', attempts: 'Attempts' },
} as const;

const contactLabels = {
  ar: { contacts: 'جهات الاتصال', contactReviews: 'مراجعة المطابقة', reviewSaved: 'حُفظت الحالة للمراجعة؛ لم تُنشأ فرصة حتى اختيار جهة الاتصال.' },
  fr: { contacts: 'Contacts', contactReviews: 'Correspondances à examiner', reviewSaved: 'Cas conservé pour examen ; aucun prospect créé avant le choix du contact.' },
  en: { contacts: 'Contacts', contactReviews: 'Match reviews', reviewSaved: 'Saved for review; no lead was created until a contact is selected.' },
} as const;
const fieldLabels = { ar: { fields: 'الحقول الديناميكية' }, fr: { fields: 'Champs dynamiques' }, en: { fields: 'Dynamic fields' } } as const;
const workflowLabels = { ar: { followups: 'المتابعات', messagingSetup: 'إعداد الرسائل',metaSources:'مصادر Meta',paymentSetup:'إعداد الدفع' },
  fr: { followups: 'Suivis', messagingSetup: 'Messagerie',metaSources:'Sources Meta',paymentSetup:'Configuration du paiement' },
  en: { followups: 'Follow-ups', messagingSetup: 'Messaging setup',metaSources:'Meta sources',paymentSetup:'Payment setup' } } as const;
type LabelKey = keyof typeof labels.en | keyof typeof profileLabels.en | keyof typeof managementLabels.en |
  keyof typeof identityLabels.en | keyof typeof deliveryLabels.en | keyof typeof contactLabels.en |
  keyof typeof fieldLabels.en | keyof typeof workflowLabels.en;

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (typeof options?.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  return body as T;
}

function App() {
  const [locale, setLocale] = useState<Locale>(() => (localStorage.getItem('lop-locale') as Locale) || 'ar');
  const t: Record<LabelKey, string> = { ...labels[locale], ...profileLabels[locale], ...managementLabels[locale],
    ...identityLabels[locale], ...deliveryLabels[locale], ...contactLabels[locale], ...fieldLabels[locale], ...workflowLabels[locale] };
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>(initialLinkMode);
  const [authToken] = useState(initialLinkToken);
  const [notice, setNotice] = useState('');
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [page, setPage] = useState<Page>('leads');
  const [selectedLead, setSelectedLead] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [nextCampaignCursor, setNextCampaignCursor] = useState<string | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [nextLeadCursor, setNextLeadCursor] = useState<string | null>(null);
  const [leadQuery, setLeadQuery] = useState('');
  const [leadColumns, setLeadColumns] = useState<LeadColumn[]>(defaultLeadColumns);
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);
  const [bulkAgentId, setBulkAgentId] = useState('');
  const [bulkReason, setBulkReason] = useState('');
  const [bulkResults, setBulkResults] = useState<{ id: string; status: string; error?: string }[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [nextUserCursor, setNextUserCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ lead: Lead; activities: { id: number; event_type: string; created_at: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState<Record<string, string>>({});
  const [leadFieldValues, setLeadFieldValues] = useState<Record<string, unknown>>({});
  const [showForm, setShowForm] = useState(false);
  const [selectedCampaign, setSelectedCampaign] = useState<string | null>(null);
  const [emailConnection, setEmailConnection] = useState<EmailConnection | null>(null);
  const [deliveryJobs, setDeliveryJobs] = useState<DeliveryJob[]>([]);
  const [nextDeliveryCursor, setNextDeliveryCursor] = useState<string | null>(null);
  const [workspaceRefresh, setWorkspaceRefresh] = useState(0);
  const [emailForm, setEmailForm] = useState<Record<string, string>>({ secure: 'true', port: '465' });

  useEffect(() => { if (initialLinkToken) window.history.replaceState(null, '', window.location.pathname + window.location.search); }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
    localStorage.setItem('lop-locale', locale);
  }, [locale]);

  useEffect(() => {
    const sessionRequest = initialLinkToken ? api('/api/auth/logout', { method: 'POST' }).then(() => null) : api<User>('/api/auth/me').catch(() => null);
    void Promise.all([api<{ initialized: boolean }>('/api/setup/status'), sessionRequest])
      .then(([setup, current]) => { setInitialized(setup.initialized); setUser(current); })
      .catch((failure) => { setInitialized(true); setError(String(failure)); });
  }, []);

  async function refresh() {
    if (!user) return;
    setBusy(true); setError('');
    try {
      const [branchResult, campaignResult, leadResult, userResult] = await Promise.all([
        api<{ items: Branch[] }>('/api/branches'), api<{ items: Campaign[]; nextCursor: string | null }>('/api/campaigns'),
        api<{ items: Lead[]; nextCursor: string | null }>(`/api/leads?${leadQuery ? leadQuery + '&' : ''}limit=50`),
        user.role === 'AGENT' ? Promise.resolve({ items: [] as ManagedUser[], nextCursor: null }) : api<{ items: ManagedUser[]; nextCursor: string | null }>('/api/users'),
      ]);
      setBranches(branchResult.items); setCampaigns(campaignResult.items); setNextCampaignCursor(campaignResult.nextCursor); setLeads(leadResult.items); setNextLeadCursor(leadResult.nextCursor); setUsers(userResult.items); setNextUserCursor(userResult.nextCursor); setSelectedLeadIds([]);
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, [user?.id]);
  useEffect(() => { setLeadFieldValues({}); }, [form.campaignId]);
  async function refreshDeliveryJobs() {
    const result = await api<{ items: DeliveryJob[]; nextCursor: string | null }>('/api/identity/deliveries');
    setDeliveryJobs(result.items); setNextDeliveryCursor(result.nextCursor);
  }
  useEffect(() => {
    if (page !== 'identityEmail' || !user || user.role === 'AGENT') return;
    void refreshDeliveryJobs().catch((failure) => setError(String(failure)));
    if (user.role !== 'SUPER_ADMIN') return;
    void api<EmailConnection>('/api/identity/email').then((connection) => {
      setEmailConnection(connection);
      if (connection.settings) setEmailForm({ ...connection.settings, port: String(connection.settings.port), secure: String(connection.settings.secure), name: connection.name ?? '', password: '' });
    }).catch((failure) => setError(String(failure)));
  }, [page, user?.id]);
  useEffect(() => {
    if (!selectedLead) { setDetail(null); return; }
    void api<typeof detail>(`/api/leads/${selectedLead}`).then(setDetail).catch((failure) => setError(String(failure)));
  }, [selectedLead]);

  async function submit(path: string, payload: unknown, after?: () => void) {
    setBusy(true); setError('');
    try { const result = await api<{ reviewId?: string }>(path, { method: 'POST', body: JSON.stringify(payload) });
      after?.(); setForm({}); setShowForm(false); await refresh();
      if (result.reviewId) { setNotice(t.reviewSaved); setPage('contactReviews'); setWorkspaceRefresh((value) => value + 1); }
    }
    catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }

  async function searchLeads(query: string) {
    const result = await api<{ items: Lead[]; nextCursor: string | null }>(`/api/leads?${query ? query + '&' : ''}limit=50`);
    setLeadQuery(query); setLeads(result.items); setNextLeadCursor(result.nextCursor); setSelectedLeadIds([]);
  }

  async function bulkAssign() {
    const items = leads.filter((lead) => selectedLeadIds.includes(lead.id)).map((lead) => ({ id: lead.id, version: lead.version }));
    if (!items.length || items.length > 50) return;
    const prompt = { ar: `تأكيد إعادة إسناد ${items.length} فرصة؟ ستُراجع صلاحية ونسخة كل فرصة على حدة.`,
      fr: `Confirmer la réattribution de ${items.length} prospects ?`,
      en: `Confirm reassignment of ${items.length} leads? Each lead is checked separately.` }[locale];
    if (!window.confirm(prompt)) return;
    setBusy(true); setError('');
    try {
      const result = await api<{ results: { id: string; status: string; error?: string }[] }>('/api/leads/bulk/assignment', {
        method: 'POST', body: JSON.stringify({ confirmed: true, items, agentId: bulkAgentId || null, reason: bulkReason }),
      });
      setBulkResults(result.results);
      await refresh();
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }

  async function submitAuthentication() {
    setBusy(true); setError(''); setNotice('');
    try {
      if (!initialized) {
        await api('/api/setup/bootstrap', { method: 'POST', body: JSON.stringify({ token: form.token, organizationName: form.organizationName, name: form.name, email: form.email, password: form.password }) });
        await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: form.email, password: form.password }) });
      } else if (authMode === 'forgot') {
        await api('/api/auth/forgot', { method: 'POST', body: JSON.stringify({ email: form.email }) });
        setNotice(t.recoveryNotice); return;
      } else if (authMode === 'reset' || authMode === 'invite') {
        await api(authMode === 'reset' ? '/api/auth/reset' : '/api/auth/invitations/accept', {
          method: 'POST', body: JSON.stringify({ token: authToken, password: form.password }),
        });
        setAuthMode('login'); setForm({}); setNotice(t.passwordSet); return;
      } else {
        await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: form.email, password: form.password }) });
      }
      const current = await api<User>('/api/auth/me');
      setUser(current); setInitialized(true); setForm({});
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }

  async function saveIdentityEmail() {
    setBusy(true); setError('');
    try {
      await api('/api/identity/email', { method: 'PUT', body: JSON.stringify({
        name: emailForm.name, host: emailForm.host, port: Number(emailForm.port), secure: emailForm.secure === 'true',
        username: emailForm.username, password: emailForm.password, fromAddress: emailForm.fromAddress,
      }) });
      setEmailConnection(await api<EmailConnection>('/api/identity/email'));
      setEmailForm((current) => ({ ...current, password: '' }));
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }

  async function testIdentityEmail() {
    setBusy(true); setError('');
    try { await api('/api/identity/email/test', { method: 'POST' }); setEmailConnection(await api<EmailConnection>('/api/identity/email')); }
    catch (failure) { setError(String(failure)); setEmailConnection(await api<EmailConnection>('/api/identity/email').catch(() => emailConnection)); }
    finally { setBusy(false); }
  }

  const field = (key: string, label: string, type = 'text', required = true) => <label key={key}>{label}<input type={type} required={required} value={form[key] ?? ''}
    onChange={(event) => setForm({ ...form, [key]: event.target.value })} /></label>;
  const emailField = (key: string, label: string, type = 'text') => <label key={key}>{label}<input type={type} required value={emailForm[key] ?? ''}
    onChange={(event) => setEmailForm({ ...emailForm, [key]: event.target.value })} /></label>;
  const select = (key: string, label: string, options: { value: string; text: string }[]) => <label key={key}>{label}<select required value={form[key] ?? ''}
    onChange={(event) => setForm({ ...form, [key]: event.target.value })}><option value="">{t.select}</option>{options.map((option) => <option key={option.value} value={option.value}>{option.text}</option>)}</select></label>;
  const branchOptions = branches.map((branch) => ({ value: branch.id, text: branch.name }));
  const campaignOptions = campaigns.filter((campaign) => campaign.status === 'ACTIVE' && (!form.branchId || campaign.branch_id === form.branchId)).map((campaign) => ({ value: campaign.id, text: campaign.name }));
  const language = <select aria-label="Language" value={locale} onChange={(event) => setLocale(event.target.value as Locale)}><option value="ar">العربية</option><option value="fr">Français</option><option value="en">English</option></select>;

  if (initialized === null) return <main className="center">{t.loading}</main>;
  if (!user) return <main className="auth-shell"><div className="auth-card"><div className="brand">{t.app}</div><div className="language">{language}</div>
    <h1>{!initialized ? t.setup : authMode === 'login' ? t.login : t[authMode]}</h1>{!initialized && <p>{t.initialSetup}</p>}
    {error && <div role="alert" className="error">{error}</div>}
    {notice && <div role="status" className="panel">{notice}</div>}
    <form onSubmit={(event) => { event.preventDefault(); void submitAuthentication(); }}>
      {!initialized && <>{field('token', t.token, 'password')}{field('organizationName', t.organization)}{field('name', t.name)}</>}
      {(!initialized || authMode === 'login' || authMode === 'forgot') && field('email', t.email, 'email')}
      {(!initialized || authMode !== 'forgot') && field('password', t.password, 'password')}
      <button disabled={busy}>{busy ? t.loading : !initialized ? t.create : authMode === 'forgot' ? t.sendReset : authMode === 'login' ? t.enter : t.save}</button>
    </form>{initialized && <button className="link" onClick={() => { setAuthMode(authMode === 'login' ? 'forgot' : 'login'); setError(''); setNotice(''); setForm({}); }}>{authMode === 'login' ? t.forgot : t.backToLogin}</button>}</div></main>;

  const isAdmin = user.role === 'SUPER_ADMIN';
  const canManage = user.role !== 'AGENT';
  const leadColumnLabels: Record<LeadColumn, string> = { contact: t.contact, campaign: t.campaign,
    branch: t.branch, lifecycle: t.lifecycle, owner: t.assign, source: t.source,
    created_at: { ar: 'تاريخ الإنشاء', fr: 'Créé le', en: 'Created' }[locale], followup: t.followups };
  const leadCell = (lead: Lead, column: LeadColumn) => {
    switch (column) {
      case 'contact': return <><strong>{contactLabel(lead,locale)}</strong><small>{lead.phone || lead.email}</small></>;
      case 'campaign': return campaigns.find((item) => item.id === lead.campaign_id)?.name || lead.campaign_id;
      case 'branch': return branches.find((item) => item.id === lead.branch_id)?.name || '—';
      case 'lifecycle': return <><span className="badge">{lead.lifecycle}</span>{lead.needs_attention_reason && <small className="attention">{t.attention}</small>}</>;
      case 'owner': return users.find((item) => item.id === lead.assigned_agent_id)?.name ||
        (lead.assigned_agent_id === user.id ? user.name : lead.assigned_agent_id) || '—';
      case 'source': return lead.source_kind;
      case 'created_at': return new Date(lead.created_at).toLocaleString(locale);
      case 'followup': return lead.next_followup_at ? new Date(lead.next_followup_at).toLocaleString(locale) : '—';
    }
  };
  return <div className="app-shell"><aside className="sidebar"><div className="brand">{t.app}</div><div className="user-block"><strong>{user.name}</strong><span>{user.role.replace('_', ' ')}</span></div>
    <nav>{(['leads','contacts','contactReviews','followups','campaigns','fields','branches','users','identityEmail','messagingSetup','metaSources','paymentSetup','profile'] as Page[]).filter((item) =>
      item === 'identityEmail' || item === 'contactReviews' || item === 'messagingSetup' || item === 'metaSources' || item === 'paymentSetup' ? canManage : canManage || item === 'leads' || item === 'contacts' || item === 'profile' || item === 'followups').map((item) =>
      <button key={item} className={page === item ? 'selected' : ''} onClick={() => { setPage(item); setSelectedLead(null); setSelectedCampaign(null); setShowForm(false); setForm({}); setNotice(''); }}>{t[item]}</button>)}</nav>
    <div className="sidebar-bottom">{language}<button onClick={() => { void api('/api/auth/logout', { method: 'POST' }).then(() => setUser(null)); }}>{t.logout}</button></div>
  </aside><main className="content"><header><div><small>Lead Operations</small><h1>{selectedLead ? t.details : t[page]}</h1></div><button className="secondary" onClick={() => void (page === 'identityEmail' ? refreshDeliveryJobs() : page === 'contacts' || page === 'contactReviews' || page === 'fields' ? setWorkspaceRefresh((value) => value + 1) : refresh())} disabled={busy}>{t.retry}</button></header>
    {error && <div role="alert" className="error">{error}</div>}
    {notice && <div role="status" className="panel">{notice}</div>}
    {busy && <div className="loading">{t.loading}</div>}
    {page === 'identityEmail' ? <section className="panel form-panel"><h2>{t.identityEmail}</h2>
      {isAdmin && <>
      <p>{t.emailStatus}: {emailConnection?.status ?? 'NOT_CONFIGURED'}</p>
      <p>{locale === 'ar' ? 'أنشئ حساب SMTP وبيانات اعتماده لدى مزود البريد، ثم أدخلها هنا واختبر الاتصال. لا تُعرض كلمة المرور بعد الحفظ.' : locale === 'fr' ? 'Créez les identifiants SMTP chez votre fournisseur, saisissez-les ici, puis testez la connexion. Le mot de passe ne sera plus affiché.' : 'Create SMTP credentials with your email provider, enter them here, then test the connection. The password is hidden after saving.'}</p>
      <form onSubmit={(event) => { event.preventDefault(); void saveIdentityEmail(); }}>
        {emailField('name', t.name)}{emailField('host', t.emailHost)}{emailField('port', t.emailPort, 'number')}
        {emailField('username', t.emailUsername)}{emailField('password', t.emailPassword, 'password')}{emailField('fromAddress', t.fromAddress, 'email')}
        <label><input type="checkbox" checked={emailForm.secure !== 'false'} onChange={(event) => setEmailForm({ ...emailForm, secure: String(event.target.checked) })} />{t.secureSmtp}</label>
        <button disabled={busy}>{t.save}</button></form>
      <button className="secondary" disabled={busy || !emailConnection?.configured} onClick={() => void testIdentityEmail()}>{t.testConnection}</button>
      </>}
      <h3>{t.deliveries}</h3><div className="table-scroll"><table><thead><tr><th>{t.name}</th><th>{t.email}</th><th>{t.status}</th><th>{t.attempts}</th><th>{t.actions}</th></tr></thead><tbody>
        {deliveryJobs.map((job) => <tr key={job.id}><td>{job.name}</td><td>{job.email}</td><td>{job.status}{job.last_error_code && <small>{job.last_error_code}</small>}</td><td>{job.attempts}/{job.max_attempts}</td><td>{job.status === 'DEAD' && <button className="link" disabled={busy} onClick={() => { setBusy(true); setError('');
          void api(`/api/identity/deliveries/${job.id}/retry`, { method: 'POST' }).then(() => refreshDeliveryJobs()).catch((failure) => setError(String(failure))).finally(() => setBusy(false)); }}>{t.retryDelivery}</button>}</td></tr>)}
      </tbody></table></div>{deliveryJobs.length === 0 && <p>{t.noData}</p>}
      {nextDeliveryCursor && <button className="secondary" disabled={busy} onClick={() => { setBusy(true);
        void api<{ items: DeliveryJob[]; nextCursor: string | null }>(`/api/identity/deliveries?cursor=${encodeURIComponent(nextDeliveryCursor)}`)
          .then((result) => { setDeliveryJobs((current) => [...current, ...result.items]); setNextDeliveryCursor(result.nextCursor); })
          .catch((failure) => setError(String(failure))).finally(() => setBusy(false)); }}>{locale === 'ar' ? 'تحميل المزيد' : locale === 'fr' ? 'Afficher plus' : 'Load more'}</button>}
    </section> : page === 'paymentSetup' && canManage ? <PaymentSetup locale={locale} role={user.role as 'SUPER_ADMIN'|'MANAGER'} branches={branches} api={api} />
      : page === 'metaSources' && canManage ? <MetaSourceSetup locale={locale} role={user.role as 'SUPER_ADMIN'|'MANAGER'} branches={branches} api={api} />
      : page === 'messagingSetup' && canManage ? <MessagingSetup locale={locale} role={user.role as 'SUPER_ADMIN'|'MANAGER'}
      branchId={user.branchId} branches={branches} api={api} />
      : page === 'contacts' || page === 'contactReviews' ? <ContactWorkspace key={`${page}-${workspaceRefresh}`} mode={page === 'contacts' ? 'contacts' : 'reviews'} locale={locale} canManage={canManage} api={api} onOpenLead={(id) => { setPage('leads'); setSelectedLead(id); setNotice(''); }} />
      : page === 'fields' ? <FieldWorkspace key={`fields-${workspaceRefresh}`} locale={locale} campaigns={campaigns} role={user.role} api={api} />
      : page === 'campaigns' && selectedCampaign ? <CampaignWorkspace id={selectedCampaign} locale={locale} api={api}
        onBack={() => setSelectedCampaign(null)} onChanged={refresh} />
      : page === 'followups' ? <FollowupQueue locale={locale} api={api} onOpenLead={(id) => { setPage('leads'); setSelectedLead(id); }} />
      : page === 'profile' ? <section className="panel form-panel"><h2>{t.profile}</h2><p>{t.passwordChanged}</p>
      <form onSubmit={(event) => { event.preventDefault(); setBusy(true); setError('');
        void api('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword: form.currentPassword, newPassword: form.newPassword }) })
          .then(() => { setUser(null); setForm({}); setPage('leads'); }).catch((failure) => setError(String(failure))).finally(() => setBusy(false)); }}>
        {field('currentPassword', t.currentPassword, 'password')}{field('newPassword', t.newPassword, 'password')}
        <button disabled={busy}>{t.save}</button></form></section> : selectedLead && detail ? <section className="panel"><button className="link" onClick={() => setSelectedLead(null)}>{t.back}</button><h2>{contactLabel(detail.lead,locale)}</h2>
      <div className="facts"><div><small>{t.phone}</small><strong>{detail.lead.phone || '—'}</strong></div><div><small>{t.email}</small><strong>{detail.lead.email || '—'}</strong></div>
      <div><small>{t.lifecycle}</small><strong>{detail.lead.lifecycle}</strong></div><div><small>{t.assign}</small><strong>{leadCell(detail.lead,'owner')}</strong></div></div>
      {canManage && <div className="actions">{(['OPEN','CLOSED','ARCHIVED'] as const).filter((state) => state !== detail.lead.lifecycle).map((state) =>
        <button key={state} className="secondary" onClick={() => { setBusy(true); api(`/api/leads/${selectedLead}/lifecycle`, { method: 'POST', body: JSON.stringify({ lifecycle: state }) })
          .then(() => api<typeof detail>(`/api/leads/${selectedLead}`)).then(setDetail).catch((failure) => setError(String(failure))).finally(() => setBusy(false)); }}>{state === 'OPEN' ? t.reopen : state === 'CLOSED' ? t.close : t.archive}</button>)}</div>}
      <LeadWorkflow lead={detail.lead} role={user.role} locale={locale} api={api}
        onChanged={async () => { const current = await api<typeof detail>(`/api/leads/${selectedLead}`); setDetail(current); }} />
      <LeadFields leadId={selectedLead} locale={locale} api={api} />
      <LeadPaymentMethods key={selectedLead} leadId={selectedLead} locale={locale} api={api} />
      <LeadConversations key={selectedLead} leadId={selectedLead} lifecycle={detail.lead.lifecycle}
        role={user.role} actorId={user.id} locale={locale} api={api} />
    </section> : <>
      {page === 'leads' && <LeadSearch locale={locale} branches={branches} campaigns={campaigns} users={users} currentUser={user}
        api={api} onSearch={searchLeads} columns={leadColumns} onColumns={setLeadColumns} />}
      {page === 'leads' && canManage && <section className="panel"><div className="actions">
        <strong>{locale === 'ar' ? `المحدد: ${selectedLeadIds.length} / 50` : locale === 'fr' ? `Sélection : ${selectedLeadIds.length} / 50` : `Selected: ${selectedLeadIds.length} / 50`}</strong>
        <button type="button" className="secondary" onClick={() => setSelectedLeadIds(leads.slice(0, 50).map((lead) => lead.id))}>{locale === 'ar' ? 'تحديد أول 50 ظاهرة' : locale === 'fr' ? 'Sélectionner les 50 premiers' : 'Select first 50 shown'}</button>
        <button type="button" className="secondary" onClick={() => setSelectedLeadIds([])}>{locale === 'ar' ? 'إزالة التحديد' : locale === 'fr' ? 'Effacer' : 'Clear selection'}</button>
      </div><div className="workflow-form">
        <label>{t.assign}<select value={bulkAgentId} onChange={(event) => setBulkAgentId(event.target.value)}>
          <option value="">{locale === 'ar' ? 'بلا إسناد' : locale === 'fr' ? 'Non attribué' : 'Unassigned'}</option>
          {users.filter((item) => item.role === 'AGENT' && item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label>{locale === 'ar' ? 'سبب الإسناد' : locale === 'fr' ? 'Motif' : 'Reason'}<input maxLength={500} value={bulkReason} onChange={(event) => setBulkReason(event.target.value)} /></label>
        <button type="button" disabled={busy || !selectedLeadIds.length} onClick={() => void bulkAssign()}>{locale === 'ar' ? 'إسناد المحدد' : locale === 'fr' ? 'Attribuer la sélection' : 'Assign selected'}</button>
      </div>{bulkResults.length > 0 && <div role="status"><h3>{locale === 'ar' ? 'نتيجة كل فرصة' : locale === 'fr' ? 'Résultat par prospect' : 'Result by lead'}</h3>
        <ul>{bulkResults.map((item) => <li key={item.id}>{item.id}: {item.status}{item.error ? ` (${item.error})` : ''}</li>)}</ul></div>}
      </section>}
      <div className="toolbar">{canManage && (page !== 'branches' || isAdmin) && <button onClick={() => { setShowForm(!showForm); setForm({}); }}>{page === 'leads' ? t.newLead : page === 'campaigns' ? t.newCampaign : page === 'branches' ? t.newBranch : t.newUser}</button>}</div>
      {showForm && <section className="panel form-panel"><h2>{page === 'leads' ? t.newLead : page === 'campaigns' ? t.newCampaign : page === 'branches' ? t.newBranch : t.newUser}</h2>
        <form onSubmit={(event) => { event.preventDefault(); if (page === 'branches') void submit('/api/branches', { name: form.name, timezone: form.timezone });
          if (page === 'campaigns') void submit('/api/campaigns', { name: form.name, branchId: form.branchId, routingMethod: form.routingMethod || 'MANUAL' });
           if (page === 'leads') void submit('/api/leads', { branchId: form.branchId, campaignId: form.campaignId, contact: { name: form.name, phone: form.phone || undefined, email: form.email || undefined },
             fields: Object.entries(leadFieldValues).filter(([, value]) => value !== null && value !== undefined && value !== '').map(([fieldId, value]) => ({ fieldId, value })) }, () => setLeadFieldValues({}));
          if (page === 'users') void submit('/api/users', { branchId: form.role === 'SUPER_ADMIN' ? undefined : form.branchId, role: form.role, name: form.name, email: form.email }); }}>
          {page === 'branches' && <>{field('name', t.name)}{field('timezone', t.timezone)}</>}
          {page === 'campaigns' && <>{field('name', t.name)}{select('branchId', t.branch, branchOptions)}{select('routingMethod', t.routing, ['MANUAL','ROUND_ROBIN','WEIGHTED','PERFORMANCE'].map((value) => ({ value, text: value })))}</>}
           {page === 'leads' && <>{select('branchId', t.branch, branchOptions)}{select('campaignId', t.campaign, campaignOptions)}{field('name', t.contact)}{field('phone', t.phone, 'tel', false)}{field('email', t.email, 'email', false)}
             {form.campaignId && <LeadCreationFields campaignId={form.campaignId} locale={locale} api={api} values={leadFieldValues} onChange={setLeadFieldValues} />}</>}
          {page === 'users' && <>{field('name', t.name)}{field('email', t.email, 'email')}{select('role', t.role, (isAdmin ? ['SUPER_ADMIN','MANAGER','AGENT'] : ['AGENT']).map((value) => ({ value, text: value })))}{form.role !== 'SUPER_ADMIN' && select('branchId', t.branch, branchOptions)}</>}
          <button disabled={busy}>{t.save}</button></form></section>}
      <section className="panel table-panel"><div className="table-scroll"><table><thead><tr>{page === 'leads' ? <>{canManage && <th>{locale === 'ar' ? 'تحديد' : locale === 'fr' ? 'Choisir' : 'Select'}</th>}{leadColumns.map((column) =>
        <th key={column}>{leadColumnLabels[column]}</th>)}<th>{t.actions}</th></> :
        page === 'campaigns' ? <><th>{t.name}</th><th>{t.branch}</th><th>{t.status}</th><th>{t.routing}</th><th>{t.actions}</th></> :
        page === 'branches' ? <><th>{t.name}</th><th>{t.timezone}</th><th>{t.status}</th></> :
        <><th>{t.name}</th><th>{t.email}</th><th>{t.role}</th><th>{t.branch}</th><th>{t.status}</th><th>{t.actions}</th></>}</tr></thead><tbody>
        {page === 'leads' && leads.map((lead) => <tr key={lead.id}>{canManage && <td><input type="checkbox" aria-label={`${t.contact}: ${contactLabel(lead,locale)}`}
          checked={selectedLeadIds.includes(lead.id)} disabled={selectedLeadIds.length >= 50 && !selectedLeadIds.includes(lead.id)}
          onChange={(event) => setSelectedLeadIds((current) => event.target.checked ? [...current, lead.id] : current.filter((id) => id !== lead.id))} /></td>}{leadColumns.map((column) =>
          <td key={column}>{leadCell(lead, column)}</td>)}<td><button className="link" onClick={() => setSelectedLead(lead.id)}>{t.details}</button></td></tr>)}
        {page === 'campaigns' && campaigns.map((campaign) => <tr key={campaign.id}><td><strong>{campaign.name}</strong></td><td>{branches.find((item) => item.id === campaign.branch_id)?.name || '—'}</td><td><span className="badge">{campaign.status}</span></td><td>{campaign.routing_method}<small>{campaign.agents?.map((agent) => agent.name).join(', ') || '—'}</small></td><td>{canManage && <button className="link" onClick={() => setSelectedCampaign(campaign.id)}>{t.details}</button>}</td></tr>)}
        {page === 'branches' && branches.map((branch) => <tr key={branch.id}><td><strong>{branch.name}</strong></td><td>{branch.timezone}</td><td>{branch.active ? t.active : t.inactive}</td></tr>)}
        {page === 'users' && users.map((item) => <tr key={item.id}><td><strong>{item.name}</strong></td><td>{item.email}</td><td>{item.role}</td><td>{branches.find((branch) => branch.id === item.branch_id)?.name || '—'}</td><td>{item.credential_state === 'INVITED' ? t.invited : item.active ? t.active : t.inactive}</td><td>{item.id !== user.id && (isAdmin || (item.role === 'AGENT' && item.branch_id === user.branchId)) && <div className="actions">
          {item.active && item.credential_state === 'INVITED' && <button className="link" disabled={busy} onClick={() => void submit(`/api/users/${item.id}/invitation`, {})}>{t.inviteAgain}</button>}
          <button className="link" disabled={busy} onClick={() => { setBusy(true); setError('');
            void api(`/api/users/${item.id}/status`, { method: 'PATCH', body: JSON.stringify({ active: !item.active }) })
              .then(() => refresh()).catch((failure) => setError(String(failure))).finally(() => setBusy(false)); }}>{item.active ? t.disable : t.enable}</button></div>}</td></tr>)}
        </tbody></table></div>{(page === 'leads' ? leads : page === 'campaigns' ? campaigns : page === 'branches' ? branches : users).length === 0 && <div className="empty">{t.noData}</div>}
        {page === 'leads' && nextLeadCursor && <div className="load-more"><button className="secondary" disabled={busy} onClick={() => { setBusy(true);
          api<{ items: Lead[]; nextCursor: string | null }>(`/api/leads?${leadQuery ? leadQuery + '&' : ''}limit=50&cursor=${encodeURIComponent(nextLeadCursor)}`)
            .then((result) => { setLeads((existing) => [...existing, ...result.items]); setNextLeadCursor(result.nextCursor); })
            .catch((failure) => setError(String(failure))).finally(() => setBusy(false)); }}>{locale === 'ar' ? 'تحميل المزيد' : locale === 'fr' ? 'Afficher plus' : 'Load more'}</button></div>}
        {page === 'campaigns' && nextCampaignCursor && <div className="load-more"><button className="secondary" disabled={busy} onClick={() => { setBusy(true);
          void api<{ items: Campaign[]; nextCursor: string | null }>(`/api/campaigns?cursor=${encodeURIComponent(nextCampaignCursor)}`)
            .then((result) => { setCampaigns((current) => [...current, ...result.items]); setNextCampaignCursor(result.nextCursor); })
            .catch((failure) => setError(String(failure))).finally(() => setBusy(false)); }}>{locale === 'ar' ? 'تحميل المزيد' : locale === 'fr' ? 'Afficher plus' : 'Load more'}</button></div>}
        {page === 'users' && nextUserCursor && <div className="load-more"><button className="secondary" disabled={busy} onClick={() => { setBusy(true);
          void api<{ items: ManagedUser[]; nextCursor: string | null }>(`/api/users?cursor=${encodeURIComponent(nextUserCursor)}`)
            .then((result) => { setUsers((current) => [...current, ...result.items]); setNextUserCursor(result.nextCursor); })
            .catch((failure) => setError(String(failure))).finally(() => setBusy(false)); }}>{locale === 'ar' ? 'تحميل المزيد' : locale === 'fr' ? 'Afficher plus' : 'Load more'}</button></div>}</section>
    </>}
  </main></div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
