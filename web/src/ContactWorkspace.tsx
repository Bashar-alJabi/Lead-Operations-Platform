import { useEffect, useState } from 'react';

type Locale = 'ar' | 'fr' | 'en';
type Contact = { id: string; name: string; phone: string | null; email: string | null; version: number; editable?: boolean; accessible_lead_count?: number };
type ContactDetail = { contact: Contact; leads: { id: string; campaign_id: string; lifecycle: string; created_at: string }[]; nextLeadCursor: string | null };
type Review = { id: string; contact: { name: string; phone?: string; email?: string }; candidates: Contact[]; restrictedCandidates: boolean; createdAt: string };
type PageResult<T> = { items: T[]; nextCursor: string | null };
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;

const strings = {
  ar: { search: 'بحث بالاسم أو الهاتف أو البريد', searchButton: 'بحث', name: 'الاسم', phone: 'الهاتف', email: 'البريد', leads: 'الفرص المسموحة', details: 'التفاصيل', save: 'حفظ التعديل', back: 'عودة', more: 'تحميل المزيد', noData: 'لا توجد سجلات.', candidates: 'جهات الاتصال المرشحة', resolve: 'اربط الفرصة بهذه الجهة', restricted: 'بعض المرشحين خارج صلاحيات فرعك؛ يحتاج القرار إلى Super Admin.', pending: 'المطابقة بحاجة إلى قرار صريح.', select: 'اختر', versionConflict: 'تغيرت البيانات. أعد فتح جهة الاتصال قبل تعديلها.' },
  fr: { search: 'Rechercher nom, téléphone ou e-mail', searchButton: 'Rechercher', name: 'Nom', phone: 'Téléphone', email: 'E-mail', leads: 'Prospects accessibles', details: 'Détails', save: 'Enregistrer', back: 'Retour', more: 'Afficher plus', noData: 'Aucun élément.', candidates: 'Contacts candidats', resolve: 'Associer ce contact', restricted: 'Certains candidats sont hors de votre agence ; un Super Admin doit décider.', pending: 'La correspondance nécessite une décision explicite.', select: 'Choisir', versionConflict: 'Les données ont changé. Rouvrez le contact.' },
  en: { search: 'Search name, phone, or email', searchButton: 'Search', name: 'Name', phone: 'Phone', email: 'Email', leads: 'Accessible leads', details: 'Details', save: 'Save changes', back: 'Back', more: 'Load more', noData: 'No records.', candidates: 'Candidate contacts', resolve: 'Link lead to this contact', restricted: 'Some candidates are outside your branch scope; a Super Admin must decide.', pending: 'Matching needs an explicit decision.', select: 'Select', versionConflict: 'The record changed. Reopen it before editing.' },
} as const;

export function ContactWorkspace({ mode, locale, canManage, api, onOpenLead }: {
  mode: 'contacts' | 'reviews'; locale: Locale; canManage: boolean; api: Api; onOpenLead: (id: string) => void;
}) {
  const t = strings[locale];
  const [items, setItems] = useState<Contact[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<ContactDetail | null>(null);
  const [form, setForm] = useState({ name: '', phone: '', email: '' });
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load(next: string | null = null) {
    setBusy(true); setError('');
    try {
      const params = new URLSearchParams({ limit: '30' });
      if (next) params.set('cursor', next);
      if (mode === 'contacts' && query.trim().length >= 2) params.set('q', query.trim());
      if (mode === 'contacts') {
        const result = await api<PageResult<Contact>>(`/api/contacts?${params}`);
        setItems((current) => next ? [...current, ...result.items] : result.items);
        setCursor(result.nextCursor);
      } else {
        const result = await api<PageResult<Review>>(`/api/contact-reviews?${params}`);
        setReviews((current) => next ? [...current, ...result.items] : result.items);
        setCursor(result.nextCursor);
      }
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [mode, query]);

  async function openContact(id: string) {
    setBusy(true); setError('');
    try {
      const result = await api<ContactDetail>(`/api/contacts/${id}`);
      setDetail(result);
      setForm({ name: result.contact.name, phone: result.contact.phone ?? '', email: result.contact.email ?? '' });
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }

  async function saveContact() {
    if (!detail) return;
    setBusy(true); setError('');
    try {
      await api(`/api/contacts/${detail.contact.id}`, { method: 'PATCH', body: JSON.stringify({ ...form, version: detail.contact.version }) });
      await openContact(detail.contact.id);
      await load();
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }

  async function loadMoreLeads() {
    if (!detail?.nextLeadCursor) return;
    setBusy(true); setError('');
    try {
      const result = await api<PageResult<ContactDetail['leads'][number]>>(`/api/leads?contactId=${detail.contact.id}&limit=50&cursor=${encodeURIComponent(detail.nextLeadCursor)}`);
      setDetail({ ...detail, leads: [...detail.leads, ...result.items], nextLeadCursor: result.nextCursor });
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }

  async function resolveReview(reviewId: string) {
    const contactId = choices[reviewId];
    if (!contactId) return;
    setBusy(true); setError('');
    try {
      const result = await api<{ id: string }>(`/api/contact-reviews/${reviewId}/resolve`, { method: 'POST', body: JSON.stringify({ contactId }) });
      await load();
      onOpenLead(result.id);
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }

  return <section className="panel contact-workspace">
    {error && <div role="alert" className="error">{error}</div>}
    {mode === 'contacts' ? <>
      {detail ? <><button className="link" onClick={() => setDetail(null)}>{t.back}</button><h2>{detail.contact.name || detail.contact.phone || detail.contact.email || detail.contact.id}</h2>
        <div className="facts"><div><small>{t.phone}</small><strong>{detail.contact.phone || '—'}</strong></div><div><small>{t.email}</small><strong>{detail.contact.email || '—'}</strong></div></div>
        {canManage && detail.contact.editable && <form className="contact-form" onSubmit={(event) => { event.preventDefault(); void saveContact(); }}>
          <label>{t.name}<input maxLength={200} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label>{t.phone}<input type="tel" maxLength={50} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
          <label>{t.email}<input type="email" maxLength={320} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
          <button disabled={busy || !form.name.trim() && !form.phone.trim() && !form.email.trim()}>{t.save}</button></form>}
        <h3>{t.leads}</h3><ul>{detail.leads.map((lead) => <li key={lead.id}><button className="link" onClick={() => onOpenLead(lead.id)}>{lead.id}</button> · {lead.lifecycle}</li>)}</ul>
        {detail.nextLeadCursor && <button className="secondary" disabled={busy} onClick={() => void loadMoreLeads()}>{t.more}</button>}
      </> : <><form className="toolbar" onSubmit={(event) => { event.preventDefault(); setQuery(search); }}>
        <input aria-label={t.search} placeholder={t.search} value={search} onChange={(event) => setSearch(event.target.value)} />
        <button disabled={busy}>{t.searchButton}</button></form>
        <div className="table-scroll"><table><thead><tr><th>{t.name}</th><th>{t.phone}</th><th>{t.email}</th><th>{t.leads}</th><th>{t.details}</th></tr></thead><tbody>
          {items.map((item) => <tr key={item.id}><td>{item.name || '—'}</td><td>{item.phone || '—'}</td><td>{item.email || '—'}</td><td>{item.accessible_lead_count}</td>
            <td><button className="link" onClick={() => void openContact(item.id)}>{t.details}</button></td></tr>)}
        </tbody></table></div>{items.length === 0 && <p>{t.noData}</p>}</>}
    </> : <>{reviews.length === 0 && <p>{t.noData}</p>}{reviews.map((review) => <div className="panel" key={review.id}>
      <h3>{review.contact.name}</h3><p>{review.contact.phone || '—'} · {review.contact.email || '—'}</p><p>{t.pending}</p>
      <label>{t.candidates}<select value={choices[review.id] ?? ''} onChange={(event) => setChoices({ ...choices, [review.id]: event.target.value })}>
        <option value="">{t.select}</option>{review.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.phone || candidate.email}</option>)}
      </select></label>{review.restrictedCandidates && <p className="attention">{t.restricted}</p>}
      <button disabled={busy || !choices[review.id] || review.restrictedCandidates} onClick={() => void resolveReview(review.id)}>{t.resolve}</button>
    </div>)}</>}
    {cursor && !detail && <button className="secondary" disabled={busy} onClick={() => void load(cursor)}>{t.more}</button>}
  </section>;
}
