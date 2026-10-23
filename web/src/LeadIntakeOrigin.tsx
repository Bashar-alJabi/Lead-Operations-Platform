import { useEffect, useRef, useState } from 'react';
type Origin = { id: string; originKind: 'HUMAN_MANUAL'|'SOURCE'; sourceKind: string; createdAt: string; routing: { method: string; reason: string; ownerId: string | null };
  initialAI: { id: string; state: 'ADMITTED'|'BLOCKED'; blockers: string[]; createdAt: string; knowledgeVersion: number | null;
    ownerAvailable: boolean | null; initialContactWithoutAgent: boolean | null; senderReason: string | null } | null };
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
const labels = {
  ar: { title: 'مصدر إنشاء Lead', read: 'مراجعة مصدر الإنشاء', empty: 'لا يتوفر سجل إنشاء موثّق لهذه Lead.', manual: 'إدخال يدوي بواسطة مستخدم مخوّل', source: 'استقبال من مصدر مرتبط', at: 'وقت توثيق الإنشاء', routing: 'التوزيع عند الإنشاء', owner: 'المالك عند الإنشاء', unassigned: 'دون مالك', note: 'هذا سجل تاريخي. قد يكون المالك الحالي مختلفًا.' },
  en: { title: 'Lead intake origin', read: 'Review intake origin', empty: 'No verified intake record is available for this Lead.', manual: 'Manual entry by an authorized user', source: 'Intake from a connected source', at: 'Recorded at', routing: 'Routing at intake', owner: 'Owner at intake', unassigned: 'Unassigned', note: 'This is a historical record. The current owner may differ.' },
  fr: { title: 'Origine de création du prospect', read: 'Consulter l’origine', empty: 'Aucune trace de création vérifiée disponible pour ce prospect.', manual: 'Saisie manuelle par un utilisateur autorisé', source: 'Réception depuis une source connectée', at: 'Enregistré le', routing: 'Distribution à la création', owner: 'Responsable à la création', unassigned: 'Non attribué', note: 'Il s’agit d’un historique. Le responsable actuel peut être différent.' },
};
export function LeadIntakeOrigin({ leadId, revision, locale, api }: { leadId: string; revision: number; locale: 'ar'|'en'|'fr'; api: Api }) {
  const t = labels[locale], [value, setValue] = useState<{ origin: Origin | null } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), sequence = useRef(0);
  useEffect(() => { sequence.current++; setValue(null); setError(''); setBusy(false); return () => { sequence.current++; }; }, [leadId, revision]);
  async function read() {
    const s = ++sequence.current; setBusy(true); setError(''); setValue(null);
    try { const r = await api<{ origin: Origin | null }>('/api/leads/' + leadId + '/intake-origin'); if (sequence.current === s) setValue(r); }
    catch (e) { if (sequence.current === s) { setValue(null); setError((e as Error).message); } }
    finally { if (sequence.current === s) setBusy(false); }
  }
  const o = value?.origin, a = o?.initialAI;
  const aiLabels = {
    ar: { title: 'تقييم التواصل الأولي عند الإنشاء', admitted: 'استوفت إعدادات القبول الأولي', blocked: 'تعذّر القبول الأولي', pending: 'لم يبدأ التشغيل أو إرسال الرسالة. القبول لا يثبت التواصل أو التسليم.', knowledge: 'نسخة المعرفة المنشورة', sender: 'اختيار المرسل', availability: 'كان المالك متاحًا', yes: 'نعم', no: 'لا', fallback: 'عند غياب موظف متاح: متابعة الفرع بواسطة الإدارة', without: 'السماح بالتواصل دون موظف متاح' },
    en: { title: 'Initial contact assessment at intake', admitted: 'Initial configuration admitted', blocked: 'Initial admission blocked', pending: 'Runtime and message sending have not started. Admission does not prove contact or delivery.', knowledge: 'Published knowledge version', sender: 'Sender resolution', availability: 'Owner was available', yes: 'Yes', no: 'No', fallback: 'When no employee is available: branch manager attention', without: 'Contact without an available employee allowed' },
    fr: { title: 'Évaluation du premier contact à la création', admitted: 'Configuration initiale admise', blocked: 'Admission initiale bloquée', pending: 'Le traitement et l’envoi n’ont pas commencé. L’admission ne prouve aucun contact ni livraison.', knowledge: 'Version des connaissances publiées', sender: 'Sélection de l’expéditeur', availability: 'Responsable disponible à la création', yes: 'Oui', no: 'Non', fallback: 'Sans employé disponible : suivi par la direction de la succursale', without: 'Contact sans employé disponible autorisé' },
  }[locale];
  const unassessed = { ar: 'غير مُقيّم', en: 'Not assessed', fr: 'Non évalué' }[locale];
  const busyReason = { ar: 'إعدادات AI قيد التحديث أو مشغولة. لم يبدأ التواصل الأولي.', en: 'AI configuration is being updated or busy. Initial contact has not started.', fr: 'La configuration IA est en cours de modification ou occupée. Le premier contact n’a pas commencé.' }[locale];
  return <section className="panel" data-lead-intake-origin><h3>{t.title}</h3><button disabled={busy} onClick={() => void read()}>{t.read}</button>
    {error && <p role="alert">{error}</p>}{value && !o && <p>{t.empty}</p>}{o && <div data-lead-intake-record><p>{o.originKind === 'HUMAN_MANUAL' ? t.manual : t.source} · {o.sourceKind}</p>
      <p>{t.at}: <time dateTime={o.createdAt}>{new Date(o.createdAt).toLocaleString(locale)}</time></p><p>{t.routing}: {o.routing.method} · {o.routing.reason}</p>
      <p style={{ overflowWrap: 'anywhere' }}>{t.owner}: {o.routing.ownerId ?? t.unassigned}</p><p>{t.note}</p>
      {a && <div data-initial-ai-admission><h4>{aiLabels.title}</h4><p>{a.state === 'ADMITTED' ? aiLabels.admitted : aiLabels.blocked}</p>
        <p>{aiLabels.pending}</p><p>{aiLabels.knowledge}: {a.knowledgeVersion ?? '—'}</p><p style={{ overflowWrap: 'anywhere' }}>{aiLabels.sender}: {a.senderReason ?? unassessed}</p>
        <p>{aiLabels.availability}: {a.ownerAvailable === true ? aiLabels.yes : a.ownerAvailable === false ? aiLabels.no : unassessed}</p><p>{aiLabels.without}: {a.initialContactWithoutAgent === true ? aiLabels.yes : a.initialContactWithoutAgent === false ? aiLabels.no : unassessed}</p>
        {a.ownerAvailable === false && <p>{aiLabels.fallback}</p>}{a.blockers.length > 0 && <ul>{a.blockers.map(reason => <li key={reason} style={{ overflowWrap: 'anywhere' }}>{reason === 'AI_INITIAL_DEPENDENCY_BUSY' ? busyReason : reason}</li>)}</ul>}</div>}
    </div>}
  </section>;
}
