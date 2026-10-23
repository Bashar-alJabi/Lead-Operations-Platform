import { useEffect, useRef, useState } from 'react';
type Origin = { id: string; originKind: 'HUMAN_MANUAL'|'SOURCE'; sourceKind: string; createdAt: string; routing: { method: string; reason: string; ownerId: string | null } };
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
  const o = value?.origin;
  return <section className="panel" data-lead-intake-origin><h3>{t.title}</h3><button disabled={busy} onClick={() => void read()}>{t.read}</button>
    {error && <p role="alert">{error}</p>}{value && !o && <p>{t.empty}</p>}{o && <div data-lead-intake-record><p>{o.originKind === 'HUMAN_MANUAL' ? t.manual : t.source} · {o.sourceKind}</p>
      <p>{t.at}: <time dateTime={o.createdAt}>{new Date(o.createdAt).toLocaleString(locale)}</time></p><p>{t.routing}: {o.routing.method} · {o.routing.reason}</p>
      <p style={{ overflowWrap: 'anywhere' }}>{t.owner}: {o.routing.ownerId ?? t.unassigned}</p><p>{t.note}</p></div>}
  </section>;
}
