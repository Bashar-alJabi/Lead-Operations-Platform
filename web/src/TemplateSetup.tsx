import { useEffect, useState } from 'react';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Locale = 'ar'|'fr'|'en';
type Template = { id: string; name: string; language: string; status: string; category: string | null;
  active: boolean; supported:boolean; preview:string|null; last_synced_at: string | null; components: unknown[] };
type CreateRequest = { id: string; name: string; language: string; state: string; created_at: string };

const labels = {
  ar: { title: 'قوالب Meta', sync: 'مزامنة الاعتماد', create: 'إرسال قالب للمراجعة', name: 'اسم القالب', language: 'اللغة',
    category: 'الفئة', body: 'نص BODY', status: 'حالة الاعتماد', inactive: 'غائب عن آخر مزامنة', noItems: 'لا قوالب',
    more: 'المزيد', unresolved: 'طلبات إنشاء تحتاج مراجعة', resolve: 'تأكيد الغياب بعد المزامنة',
    confirm: 'تأكد من أن القالب غير موجود في Meta بعد مزامنة حديثة. قد يتأخر ظهوره لدى المزود؛ هل تريد إتاحة طلب إنشاء جديد؟',
    note: 'استخدم {{1}} ثم {{2}} للمتغيرات النصية المتسلسلة، وأدخل أمثلة المراجعة لكل منها. ينتظر القالب اعتماد Meta. عند نتيجة إنشاء ملتبسة، زامن القائمة وراجع الطلب قبل أي محاولة جديدة.' },
  fr: { title: 'Modèles Meta', sync: 'Synchroniser les approbations', create: 'Soumettre un modèle', name: 'Nom du modèle', language: 'Langue',
    category: 'Catégorie', body: 'Texte BODY', status: 'Approbation', inactive: 'Absent de la dernière synchronisation', noItems: 'Aucun modèle',
    more: 'Plus', unresolved: 'Créations à examiner', resolve: 'Confirmer l’absence après synchronisation',
    confirm: 'Vérifiez que le modèle est absent de Meta après une synchronisation récente. Sa visibilité peut être retardée. Autoriser une nouvelle demande ?',
    note: 'Utilisez {{1}} puis {{2}} pour les variables texte et fournissez un exemple pour chacune. Le modèle attend l’approbation de Meta. Après un résultat incertain, synchronisez puis examinez la demande.' },
  en: { title: 'Meta templates', sync: 'Sync approvals', create: 'Submit template', name: 'Template name', language: 'Language',
    category: 'Category', body: 'BODY text', status: 'Approval status', inactive: 'Missing from last sync', noItems: 'No templates',
    more: 'More', unresolved: 'Create requests needing review', resolve: 'Confirm absent after sync',
    confirm: 'Verify the template is absent from Meta after a recent sync. Provider visibility may be delayed. Allow a new create request?',
    note: 'Use sequential {{1}}, {{2}} text placeholders and provide an approval example for each. New templates await Meta approval. After an uncertain result, sync and review before another attempt.' },
} as const;

export function TemplateSetup({ connectionId, status, canManage, locale, api }: {
  connectionId: string; status: string; canManage: boolean; locale: Locale; api: Api;
}) {
  const t = labels[locale];
  const [templates, setTemplates] = useState<Template[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [requests, setRequests] = useState<CreateRequest[]>([]);
  const [requestAfter, setRequestAfter] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', language: 'en_US', category: 'UTILITY', body: '',header:'',footer:'',headerExample:'' });
  const [urlExample,setUrlExample]=useState('');
  const [buttonMode,setButtonMode]=useState<'CTA'|'QUICK_REPLY'>('CTA');
  const [quickLabels,setQuickLabels]=useState(['','','']);
  const [examples, setExamples] = useState<string[]>([]);
  const [buttons,setButtons]=useState<{ type:'NONE'|'URL'|'PHONE_NUMBER';text:string;target:string }[]>(
    [{ type:'NONE',text:'',target:'' },{ type:'NONE',text:'',target:'' }]);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load(next?: string) {
    const page = await api<{ items: Template[]; nextAfter: string | null }>(
      `/api/messaging/connections/${connectionId}/templates${next ? '?after=' + encodeURIComponent(next) : ''}`);
    setTemplates((current) => next ? [...current, ...page.items] : page.items);
    setAfter(page.nextAfter);
  }
  async function loadRequests(next?: string) {
    const page = await api<{ items: CreateRequest[]; nextAfter: string | null }>(
      `/api/messaging/connections/${connectionId}/templates/requests${next ? '?after=' + encodeURIComponent(next) : ''}`);
    setRequests((current) => next ? [...current, ...page.items] : page.items);
    setRequestAfter(page.nextAfter);
  }
  useEffect(() => { setTemplates([]); setAfter(null); setRequests([]); setRequestAfter(null);
    setKey(crypto.randomUUID()); setError('');
    void Promise.all([load(), loadRequests()]).catch((failure) => setError(String(failure))); }, [connectionId]);
  async function sync() {
    setBusy(true); setError('');
    try { await api(`/api/messaging/connections/${connectionId}/templates/sync`, { method: 'POST' });
      await Promise.all([load(), loadRequests()]); }
    catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  async function create() {
    setBusy(true); setError('');
    try {
      const { header,footer,headerExample,...base }=form;
      const cta=buttonMode==='QUICK_REPLY' ? quickLabels.filter((text)=>text.trim()).map((text)=>({ type:'QUICK_REPLY',text }))
        : buttons.filter((button)=>button.type!=='NONE').map((button)=>button.type==='URL'
        ? { type:'URL',text:button.text,url:button.target } : { type:'PHONE_NUMBER',text:button.text,phone_number:button.target });
      await api(`/api/messaging/connections/${connectionId}/templates`, { method: 'POST',
        body: JSON.stringify({ ...base,...(header ? { header } : {}),...(footer ? { footer } : {}),
          ...(headerExample ? { headerExample } : {}),...(examples.length ? { examples } : {}),
          ...(cta.length ? { buttons:cta } : {}),...(buttonMode==='CTA' && urlExample ? { urlExample } : {}),idempotencyKey: key }) });
      setForm({ name: '', language: form.language, category: 'UTILITY', body: '',header:'',footer:'',headerExample:'' });
      setExamples([]);
      setUrlExample('');
      setButtonMode('CTA');setQuickLabels(['','','']);
      setButtons([{ type:'NONE',text:'',target:'' },{ type:'NONE',text:'',target:'' }]);
      setKey(crypto.randomUUID()); await Promise.all([load(), loadRequests()]);
    } catch (failure) { setError(String(failure)); await loadRequests().catch(() => {}); }
    finally { setBusy(false); }
  }
  async function resolve(request: CreateRequest) {
    if (!window.confirm(t.confirm)) return;
    setBusy(true); setError('');
    try { await api(`/api/messaging/connections/${connectionId}/templates/requests/${request.id}/resolve`, {
      method: 'POST', body: JSON.stringify({ confirmAbsent: true }),
    }); await loadRequests(); setKey(crypto.randomUUID()); }
    catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  const parameterNumbers = [...form.body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
  const parameterCount = parameterNumbers.length ? Math.min(10, Math.max(...parameterNumbers)) : 0;
  return <section className="panel"><h4>{t.title}</h4><p>{t.note}</p>
    {error && <p role="alert" className="error">{error}</p>}
    {canManage && <button className="secondary" disabled={busy || status === 'DISABLED'} onClick={() => void sync()}>{t.sync}</button>}
    <div className="table-scroll"><table><thead><tr><th>{t.name}</th><th>{t.language}</th><th>{t.category}</th><th>{t.status}</th><th>{t.body}</th></tr></thead>
      <tbody>{templates.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.language}</td><td>{item.category ?? '—'}</td>
        <td>{item.status}{!item.active && <small>{t.inactive}</small>}{!item.supported && <small>
          {locale==='ar' ? 'صيغة غير مدعومة' : locale==='fr' ? 'Format non pris en charge' : 'Unsupported format'}</small>}</td>
        <td>{item.supported && typeof item.preview==='string' ? <p style={{ whiteSpace:'pre-wrap' }}>{item.preview}</p> : item.components.flatMap((raw)=> {
          if (!raw || typeof raw!=='object') return [];
          const part=raw as { type?:unknown;text?:unknown };
          return typeof part.type==='string' && ['HEADER','BODY','FOOTER'].includes(part.type.toUpperCase())
            ? [{ type:part.type,text:typeof part.text==='string' ? part.text : '—' }] : [];
        }).map((part,index)=><p key={index}>{part.type}: {part.text}</p>)}</td></tr>)}</tbody></table></div>
    {!templates.length && <p>{t.noItems}</p>}{after && <button className="secondary" onClick={() => void load(after).catch((failure) => setError(String(failure)))}>{t.more}</button>}
    {requests.length > 0 && <section><h5>{t.unresolved}</h5><ul>{requests.map((request) =>
      <li key={request.id}>{request.name} · {request.language} · {request.state}
        {canManage && <button className="link" disabled={busy} onClick={() => void resolve(request)}>{t.resolve}</button>}</li>)}</ul>
      {requestAfter && <button className="secondary" onClick={() => void loadRequests(requestAfter).catch((failure) => setError(String(failure)))}>{t.more}</button>}
    </section>}
    {canManage && <form className="workflow-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <label>{locale==='ar' ? 'عنوان TEXT (اختياري)' : locale==='fr' ? 'En-tête TEXT (facultatif)' : 'TEXT header (optional)'}
        <input maxLength={60} value={form.header} onChange={(event)=> {
          const header=event.target.value;setForm({ ...form,header,headerExample:header.includes('{{1}}') ? form.headerExample : '' });setKey(crypto.randomUUID());
        }} /></label>
      <p>{locale==='ar' ? 'HEADER تدعم {{1}} مرة واحدة فقط مع مثال اعتماد مستقل؛ FOOTER ثابتة.'
        : locale==='fr' ? 'HEADER accepte {{1}} une seule fois, avec son propre exemple ; FOOTER reste fixe.'
          : 'HEADER allows {{1}} once with a separate approval example; FOOTER is static.'}</p>
      {form.header.includes('{{1}}') && <label>{locale==='ar' ? 'مثال متغير HEADER' : locale==='fr' ? 'Exemple du paramètre HEADER' : 'HEADER parameter example'}
        <input required maxLength={60} value={form.headerExample} onChange={(event)=> {
          setForm({ ...form,headerExample:event.target.value });setKey(crypto.randomUUID());
        }} /></label>}
      <label>{locale==='ar' ? 'تذييل ثابت (اختياري)' : locale==='fr' ? 'Pied de page fixe (facultatif)' : 'Static footer (optional)'}
        <input maxLength={60} value={form.footer} onChange={(event)=> { setForm({ ...form,footer:event.target.value });setKey(crypto.randomUUID()); }} /></label>
      <label>{t.name}<input required pattern="[a-z0-9_]+" maxLength={512} value={form.name}
        onChange={(event) => { setForm({ ...form, name: event.target.value });setKey(crypto.randomUUID()); }} /></label>
      <label>{t.language}<input required pattern="[a-z]{2,3}(_[A-Z]{2})?" value={form.language}
        onChange={(event) => { setForm({ ...form, language: event.target.value });setKey(crypto.randomUUID()); }} /></label>
      <label>{t.category}<select value={form.category} onChange={(event) => { setForm({ ...form, category: event.target.value });setKey(crypto.randomUUID()); }}>
        <option value="UTILITY">UTILITY</option><option value="MARKETING">MARKETING</option></select></label>
      <label>{t.body}<textarea required minLength={1} maxLength={1024} value={form.body}
        onChange={(event) => {
          const body = event.target.value;
          const numbers = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
          const count = numbers.length ? Math.min(10, Math.max(...numbers)) : 0;
          setForm({ ...form, body }); setExamples((current) => Array.from({ length: count }, (_, index) => current[index] ?? ''));
          setKey(crypto.randomUUID());
        }} /></label>
      {Array.from({ length: parameterCount }, (_, index) => <label key={index}>
        {locale === 'ar' ? 'مثال المتغير' : locale === 'fr' ? 'Exemple du paramètre' : 'Parameter example'} {index + 1}
        <input required maxLength={512} value={examples[index] ?? ''} onChange={(event) => {
          setExamples((current) => current.map((value, position) => position === index ? event.target.value : value));
          setKey(crypto.randomUUID());
        }} /></label>)}
      <label>{locale==='ar' ? 'نمط أزرار القالب' : locale==='fr' ? 'Mode des boutons du modèle' : 'Template button mode'}
        <select aria-label={locale==='ar' ? 'نمط أزرار القالب' : locale==='fr' ? 'Mode des boutons du modèle' : 'Template button mode'} value={buttonMode}
          onChange={(event)=> { setButtonMode(event.target.value as 'CTA'|'QUICK_REPLY');setKey(crypto.randomUUID()); }}>
          <option value="CTA">CTA</option><option value="QUICK_REPLY">Quick Reply</option></select></label>
      {buttonMode==='QUICK_REPLY' ? <>{quickLabels.map((value,index)=><label key={index}>
        {locale==='ar' ? 'نص الرد السريع' : locale==='fr' ? 'Libellé de réponse rapide' : 'Quick reply label'} {index+1}
        <input required={index===0} maxLength={25} value={value} onChange={(event)=> {
          setQuickLabels((current)=>current.map((item,position)=>position===index ? event.target.value : item));setKey(crypto.randomUUID());
        }} /></label>)}<p>{locale==='ar' ? 'حتى3 ردود ثابتة؛ لا تخلطها مع CTA. تُربط إجابة العميل برسالتها وزرها دون تنفيذ Action تلقائية.'
          : locale==='fr' ? 'Jusqu’à 3 réponses fixes, sans CTA. La réponse est liée au message et au bouton, sans action automatique.'
            : 'Up to 3 static replies, separate from CTA. Customer replies link to their message and button without automatic actions.'}</p></> : <>
      <p>{locale==='ar' ? 'أزرار اختيارية: رابط HTTPS واحد ورقم اتصال واحد. URL تدعم {{1}} مرة واحدة في النهاية؛ أدخل مثال اللاحقة مستقلاً عن HEADER/BODY.'
        : locale==='fr' ? 'Boutons facultatifs : un lien HTTPS et un numéro. URL accepte {{1}} une seule fois à la fin ; son exemple est indépendant de HEADER/BODY.'
          : 'Optional buttons: one HTTPS link and one phone number. URL allows {{1}} once at the end, with a suffix example separate from HEADER/BODY.'}</p>
      {buttons.map((button,index)=> <fieldset key={index}><legend>{locale==='ar' ? 'الزر' : locale==='fr' ? 'Bouton' : 'Button'} {index+1}</legend>
        <label>{locale==='ar' ? 'نوع الزر' : locale==='fr' ? 'Type du bouton' : 'Button type'} {index+1}
          <select aria-label={(locale==='ar' ? 'نوع الزر' : locale==='fr' ? 'Type du bouton' : 'Button type')+' '+(index+1)} value={button.type}
            onChange={(event)=> { setButtons((current)=>current.map((value,position)=>position===index
              ? { type:event.target.value as 'NONE'|'URL'|'PHONE_NUMBER',text:'',target:'' } : value));
              if (button.type==='URL' || event.target.value==='URL') setUrlExample('');setKey(crypto.randomUUID()); }}>
            <option value="NONE">—</option>{(['URL','PHONE_NUMBER'] as const).map((type)=><option key={type} value={type}
              disabled={buttons.some((value,position)=>position!==index && value.type===type)}>{type}</option>)}</select></label>
        {button.type!=='NONE' && <><label>{locale==='ar' ? 'نص الزر' : locale==='fr' ? 'Texte du bouton' : 'Button text'} {index+1}
          <input required maxLength={25} value={button.text} onChange={(event)=> {
            setButtons((current)=>current.map((value,position)=>position===index ? { ...value,text:event.target.value } : value));setKey(crypto.randomUUID());
          }} /></label><label>{locale==='ar' ? 'هدف الزر' : locale==='fr' ? 'Cible du bouton' : 'Button target'} {index+1}
          <input required type={button.type==='URL' ? 'url' : 'tel'} maxLength={button.type==='URL' ? 2000 : 16}
            pattern={button.type==='PHONE_NUMBER' ? '[+][1-9][0-9]{7,14}' : undefined} value={button.target} onChange={(event)=> {
              setButtons((current)=>current.map((value,position)=>position===index ? { ...value,target:event.target.value } : value));setKey(crypto.randomUUID());
              if (button.type==='URL' && !event.target.value.includes('{{1}}')) setUrlExample('');
            }} /></label></>}
      </fieldset>)}
      {buttons.some((button)=>button.type==='URL' && button.target.includes('{{1}}')) && <label>
        {locale==='ar' ? 'مثال لاحقة URL' : locale==='fr' ? 'Exemple du suffixe URL' : 'URL suffix example'}
        <input required maxLength={2000} value={urlExample} onChange={(event)=> { setUrlExample(event.target.value);setKey(crypto.randomUUID()); }} /></label>}</>}
      <button disabled={busy || status === 'DISABLED'}>{t.create}</button>
    </form>}
  </section>;
}
