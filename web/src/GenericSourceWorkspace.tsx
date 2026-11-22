import { useEffect, useState } from 'react';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Branch = { id: string; name: string; active: boolean };
type Connection = {
  id: string; name: string; version: number; branchId: string; branchActive: boolean;
  status: 'NOT_CONFIGURED'|'CONNECTED'|'DISABLED'; lastTestAt: string | null; callbackPath: string;
};
type TestReceipt = { testId: string; connectionVersion: number; receivedAt: string; current: boolean };
type Page<T> = { items: T[]; nextCursor: string | null };
type Credential = { id: string; version: number; callbackPath: string; signingSecret?: string };
type SchemaSetup = {
  version: number; canSave: boolean;
  schema: { version: number; connectionVersion: number; current: boolean; questions: { key: string }[] } | null;
};
const root = '/api/sources/generic/connections';
const empty: {items:never[];nextCursor:null}={items:[],nextCursor:null};
const words = {
  ar: { title:'اتصالات Webhook', branch:'الفرع', name:'اسم الاتصال', reason:'سبب التغيير', create:'إنشاء اتصال Webhook',
    refresh:'تحديث الاتصالات', none:'لا توجد اتصالات متاحة.', more:'اتصالات أقدم', open:'فتح الاتصال', choose:'اختر الفرع',
    testEndpoint:'رابط اختبار التوقيع', secret:'سر التوقيع', once:'احفظ السر الآن. يُعرض عند الإصدار فقط.', hide:'إخفاء السر',
    test:'إرسال اختبار موقّع', verified:'تم التحقق من التوقيع', pending:'بانتظار حدث موقّع', disabled:'معطّل',
    rotate:'إصدار سر جديد وإعادة التحقق', disable:'تعطيل الاتصال', history:'سجل أحداث الاختبار', older:'اختبارات أقدم',
    current:'النسخة الحالية', prior:'نسخة سابقة', emptyHistory:'لا توجد أحداث اختبار.', version:'النسخة',
    error:'تعذّر تنفيذ الطلب. حدّث الاتصال وتحقق من الصلاحية والإعداد.', scope:'اختبار الرابط يتحقق من توقيع حدث اصطناعي.',
    protocol:'توقيع طلب الاختبار', signature:'أرسل JSON بطريقة POST. طابع الوقت بالثواني منذ Unix. وقّع النص أدناه بمفتاح HMAC-SHA256 الناتج عن فك ترميز السر من hex. أرسل ناتج التوقيع بصيغة hex صغيرة.',
    schemaTitle:'حقول Webhook', keys:'مفاتيح الحقول', keysRule:'اكتب مفتاحًا في كل سطر بحروف إنجليزية صغيرة وأرقام وشرطة سفلية. يجب أن يبدأ المفتاح بحرف.',
    saveSchema:'حفظ مخطط الحقول', schemaNeeded:'تحقق من توقيع الإصدار الحالي قبل حفظ الحقول.', schemaOld:'احفظ المخطط مع الإصدار الحالي، ثم انشر التعيين من إعدادات الحملة.',
  },
  en: { title:'Webhook connections', branch:'Branch', name:'Connection name', reason:'Change reason', create:'Create webhook connection',
    refresh:'Refresh connections', none:'No connections in this scope.', more:'Older connections', open:'Open connection', choose:'Choose a branch',
    testEndpoint:'Signature test URL', secret:'Signing secret', once:'Save the secret now. It is shown when issued.', hide:'Hide signing secret',
    test:'Send signed test', verified:'Signature verified', pending:'Waiting for a signed test', disabled:'Disabled',
    rotate:'Issue a new secret and reverify', disable:'Disable connection', history:'Test event history', older:'Older tests',
    current:'Current version', prior:'Previous version', emptyHistory:'No test events.', version:'Version',
    error:'The request failed. Refresh the connection and verify access and setup.', scope:'The test URL verifies the signature of a synthetic event.',
    protocol:'Signing a test request', signature:'Send a JSON POST. Use Unix time in seconds. Sign the text below with HMAC-SHA256 using the hex-decoded secret as the key. Send the signature as lowercase hex.',
    schemaTitle:'Webhook fields', keys:'Field keys', keysRule:'Enter one key per line. Start each key with a lowercase letter and use lowercase letters, numbers and underscores.',
    saveSchema:'Save field schema', schemaNeeded:'Verify a signature with the current secret before saving fields.', schemaOld:'Save the schema for the current version, then publish the mapping in Campaign setup.',
  },
  fr: { title:'Connexions webhook', branch:'Agence', name:'Nom de la connexion', reason:'Motif du changement', create:'Créer une connexion webhook',
    refresh:'Actualiser les connexions', none:'Aucune connexion dans ce périmètre.', more:'Connexions précédentes', open:'Ouvrir la connexion', choose:'Choisir une agence',
    testEndpoint:'URL de vérification de signature', secret:'Secret de signature', once:'Enregistrez le secret maintenant. Il est affiché à sa création.', hide:'Masquer le secret',
    test:'Envoyer un test signé', verified:'Signature vérifiée', pending:'En attente d’un test signé', disabled:'Désactivée',
    rotate:'Émettre un nouveau secret et vérifier', disable:'Désactiver la connexion', history:'Historique des tests', older:'Tests précédents',
    current:'Version actuelle', prior:'Version précédente', emptyHistory:'Aucun événement de test.', version:'Version',
    error:'La requête a échoué. Actualisez la connexion et vérifiez l’accès et la configuration.',
    scope:'L’URL de test vérifie la signature d’un événement synthétique.',
    protocol:'Signer une requête de test', signature:'Envoyez un POST JSON. Utilisez le temps Unix en secondes. Signez le texte ci-dessous avec HMAC-SHA256 en utilisant le secret décodé depuis l’hexadécimal. Envoyez la signature en hexadécimal minuscule.',
    schemaTitle:'Champs du webhook', keys:'Clés des champs', keysRule:'Saisissez une clé par ligne. Commencez par une lettre minuscule et utilisez des minuscules, des chiffres et des traits de soulignement.',
    saveSchema:'Enregistrer le schéma', schemaNeeded:'Vérifiez une signature du secret actuel avant d’enregistrer les champs.', schemaOld:'Enregistrez le schéma pour la version actuelle, puis publiez le mapping dans la campagne.',
  },
};

async function signedSample(id: string, secret: string) {
  const timestamp = Math.floor(Date.now()/1000).toString(), body = JSON.stringify({testId:crypto.randomUUID()});
  const encoder = new TextEncoder();
  const bytes = Uint8Array.from(secret.match(/../g) ?? [],pair=>parseInt(pair,16));
  const key = await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const message = encoder.encode(`lead-operations.generic-source:test:v1\n${id}\n${timestamp}\n${body}`);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC',key,message));
  return {
    method:'POST',body,headers:{'x-source-timestamp':timestamp,
      'x-source-signature':'v1='+Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('')},
  };
}

export function GenericSourceWorkspace({api,locale,branches}: {api:Api;locale:keyof typeof words;branches:Branch[]}) {
  const t=words[locale];
  const [list,setList]=useState<Page<Connection>>(empty);
  const [history,setHistory]=useState<Page<TestReceipt>>(empty);
  const [selected,setSelected]=useState<Connection|null>(null);
  const [issued,setIssued]=useState<Credential|null>(null);
  const [schema,setSchema]=useState<SchemaSetup|null>(null);
  const [schemaKeys,setSchemaKeys]=useState('');
  const [schemaReason,setSchemaReason]=useState('');
  const [branchId,setBranchId]=useState('');
  const [name,setName]=useState('');
  const [creationReason,setCreationReason]=useState('');
  const [changeReason,setChangeReason]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState(false);
  const [testPassed,setTestPassed]=useState(false);
  const status=(state:Connection['status'])=>state==='CONNECTED'?t.verified:state==='DISABLED'?t.disabled:t.pending;

  async function run(work:()=>Promise<void>) {
    setBusy(true);setError(false);
    try {await work();}
    catch (failure) {
      setError(true);
      if (failure instanceof Error && /AUTH_REQUIRED|ACCESS_REVOKED|FORBIDDEN|GENERIC_SOURCE_NOT_FOUND/.test(failure.message)) {
        setList(empty);setSelected(null);setHistory(empty);setIssued(null);setSchema(null);setTestPassed(false);
      }
    } finally {setBusy(false);}
  }
  async function readConnections(cursor?:string) {
    const next=await api<Page<Connection>>(root+(cursor?'?cursor='+encodeURIComponent(cursor):''));
    setList(previous=>cursor?{items:[...previous.items,...next.items],nextCursor:next.nextCursor}:next);
  }
  async function readTests(id:string,cursor?:string) {
    const next=await api<Page<TestReceipt>>(root+'/'+id+'/tests'+(cursor?'?cursor='+encodeURIComponent(cursor):''));
    setHistory(previous=>cursor?{items:[...previous.items,...next.items],nextCursor:next.nextCursor}:next);
    return next.items[0];
  }
  async function readSchema(id:string) {
    const next=await api<SchemaSetup>(root+'/'+id+'/schema');
    setSchema(next);setSchemaKeys(next.schema?.questions.map(question=>question.key).join('\n')??'');
    setSchemaReason('');
  }
  function replaceConnection(connection:Connection) {
    setSelected(connection);
    setList(previous=>({ ...previous,items:previous.items.map(item=>item.id===connection.id?connection:item) }));
  }
  useEffect(()=>{void run(()=>readConnections());},[]);

  async function create() {
    setIssued(null);setTestPassed(false);
    const result=await api<Credential>(root,{method:'POST',body:JSON.stringify({name,branchId,reason:creationReason})});
    const connection:Connection={id:result.id,name:name.trim(),branchId,branchActive:true,
      version:result.version,status:'NOT_CONFIGURED',lastTestAt:null,callbackPath:result.callbackPath};
    setSelected(connection);setIssued(result);setHistory(empty);setSchema(null);setChangeReason('');
    setName('');setCreationReason('');
    await Promise.all([readConnections(),readSchema(connection.id)]);
  }
  async function change(action:'rotate'|'disable',connection:Connection) {
    setIssued(null);setTestPassed(false);
    const result=await api<Credential&{status:Connection['status']}>(root+'/'+connection.id+'/'+action,{method:'POST',
      body:JSON.stringify({version:connection.version,reason:changeReason})});
    replaceConnection({...connection,version:result.version,status:result.status,lastTestAt:null});
    if (result.signingSecret) setIssued(result);
    setChangeReason('');
    await Promise.all([readTests(connection.id),readSchema(connection.id)]);
  }
  async function sendTest(connection:Connection,secret:string) {
    setTestPassed(false);
    await api(connection.callbackPath,await signedSample(connection.id,secret));
    const [current]=await Promise.all([readTests(connection.id),readSchema(connection.id)]);
    if (current?.current) replaceConnection({...connection,status:'CONNECTED',lastTestAt:current.receivedAt});
    setTestPassed(true);
  }
  function open(connection:Connection) {
    setSelected(connection);setIssued(null);setChangeReason('');setHistory(empty);setSchema(null);setTestPassed(false);
    void run(async()=>{await Promise.all([readTests(connection.id),readSchema(connection.id)]);});
  }
  const keys=schemaKeys.split(/\r?\n/).map(key=>key.trim()).filter(Boolean);
  const validSchema=keys.length>0 && keys.length<=100 && new Set(keys).size===keys.length && keys.every(key=>/^[a-z][a-z0-9_]{0,63}$/.test(key));
  async function saveSchema(id:string,setup:SchemaSetup) {
    await api(root+'/'+id+'/schema',{method:'PUT',body:JSON.stringify({version:setup.schema?.version??0,
      connectionVersion:setup.version,keys,reason:schemaReason})});
    await readSchema(id);
  }

  return <section className="panel" data-generic-sources aria-busy={busy}>
    <form className="actions" onSubmit={event=>{event.preventDefault();void run(create);}}>
      <label>{t.branch}<select required disabled={busy} value={branchId} onChange={event=>setBranchId(event.target.value)}>
        <option value="">{t.choose}</option>
        {branches.filter(branch=>branch.active).map(branch=><option value={branch.id} key={branch.id}>{branch.name}</option>)}
      </select></label>
      <label>{t.name}<input required maxLength={120} disabled={busy} value={name} onChange={event=>setName(event.target.value)} /></label>
      <label>{t.reason}<input required minLength={3} maxLength={500} disabled={busy} value={creationReason}
        onChange={event=>setCreationReason(event.target.value)} /></label>
      <button disabled={busy||!branchId||!name.trim()||creationReason.trim().length<3}>{t.create}</button>
    </form>
    {error&&<p role="alert">{t.error}</p>}
    <button type="button" className="secondary" disabled={busy} onClick={()=>void run(async()=>{
      setIssued(null);setSelected(null);setHistory(empty);setSchema(null);setTestPassed(false);await readConnections();
    })}>{t.refresh}</button>
    {!list.items.length&&!busy&&!error&&<p>{t.none}</p>}
    <ul>{list.items.map(item=><li key={item.id}><bdi>{item.name}</bdi>{' · '}{status(item.status)}
      <button type="button" className="link" disabled={busy} onClick={()=>open(item)}>{t.open}</button></li>)}</ul>
    {list.nextCursor&&<button type="button" disabled={busy} onClick={()=>void run(()=>readConnections(list.nextCursor!))}>{t.more}</button>}
    {selected&&<section className="panel" data-generic-source-detail>
      <h3>{selected.name}</h3>
      <p>{status(selected.status)} · {t.version} {selected.version}</p>
      <label>{t.testEndpoint}<input readOnly value={new URL(selected.callbackPath,location.origin).href} /></label>
      <p>{t.scope} <code>{'{"testId":"<uuid>"}'}</code></p>
      <details>
        <summary>{t.protocol}</summary>
        <p>{t.signature}</p>
        <p dir="ltr"><code>lead-operations.generic-source:test:v1<br />{selected.id}<br />{'<timestamp>'}<br />{'<raw JSON body>'}</code></p>
        <p dir="ltr"><code>{'x-source-timestamp: <timestamp>'}<br />{'x-source-signature: v1=<signature>'}</code></p>
      </details>
      {issued?.id===selected.id&&issued.signingSecret&&<section data-generic-source-secret>
        <p>{t.once}</p>
        <label>{t.secret}<input readOnly value={issued.signingSecret} autoComplete="off" /></label>
        <button type="button" disabled={busy} onClick={()=>void run(()=>sendTest(selected,issued.signingSecret!))}>{t.test}</button>
        <button type="button" className="secondary" disabled={busy} onClick={()=>setIssued(null)}>{t.hide}</button>
      </section>}
      {testPassed&&<p role="status">{t.verified}</p>}
      <div className="actions">
        <label>{t.reason}<input minLength={3} maxLength={500} disabled={busy} value={changeReason}
          onChange={event=>setChangeReason(event.target.value)} /></label>
        <button type="button" disabled={busy||changeReason.trim().length<3||!selected.branchActive}
          onClick={()=>void run(()=>change('rotate',selected))}>{t.rotate}</button>
        <button type="button" disabled={busy||changeReason.trim().length<3||selected.status==='DISABLED'}
          onClick={()=>void run(()=>change('disable',selected))}>{t.disable}</button>
      </div>
      {schema&&<form className="workflow-form" data-generic-source-schema onSubmit={event=>{event.preventDefault();void run(()=>saveSchema(selected.id,schema));}}>
        <h4>{t.schemaTitle}</h4>
        {schema.schema&&<p>{t.version} {schema.schema.version} · {schema.schema.current?t.current:t.prior}</p>}
        {!schema.canSave&&<p>{t.schemaNeeded}</p>}
        {schema.canSave&&schema.schema&&!schema.schema.current&&<p>{t.schemaOld}</p>}
        <label>{t.keys}<textarea required maxLength={6500} value={schemaKeys} disabled={busy||!schema.canSave}
          onChange={event=>setSchemaKeys(event.target.value)} /></label>
        <p>{t.keysRule}</p>
        <label>{t.reason}<input minLength={3} maxLength={500} disabled={busy||!schema.canSave} value={schemaReason}
          onChange={event=>setSchemaReason(event.target.value)} /></label>
        <button disabled={busy||!schema.canSave||!validSchema||schemaReason.trim().length<3}>{t.saveSchema}</button>
      </form>}
      <h4>{t.history}</h4>
      {!history.items.length&&!busy&&<p>{t.emptyHistory}</p>}
      <ul>{history.items.map(item=><li key={item.testId} data-generic-source-test>
        <time dateTime={item.receivedAt}>{new Date(item.receivedAt).toLocaleString(locale)}</time>
        {' · '}{item.current?t.current:t.prior}{' · '}<bdi>{item.testId}</bdi>
      </li>)}</ul>
      {history.nextCursor&&<button type="button" disabled={busy}
        onClick={()=>void run(async()=>{await readTests(selected.id,history.nextCursor!);})}>{t.older}</button>}
    </section>}
  </section>;
}
