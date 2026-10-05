export type SourceReference = { namespace:'META_AD'|'META_POST';externalId:string;headline:string|null;description:string|null };
const labels = {
  ar:{ title:'مرجع المصدر الوارد',ad:'إعلان Meta',post:'منشور Meta',invalid:'مرجع مصدر غير صالح؛ الرسالة محفوظة للمراجعة ولا يمكن ربطها تلقائيًا.' },
  fr:{ title:'Référence de source entrante',ad:'Publicité Meta',post:'Publication Meta',invalid:'Référence invalide ; message conservé pour examen, sans rattachement automatique.' },
  en:{ title:'Inbound source reference',ad:'Meta ad',post:'Meta post',invalid:'Invalid source reference; message retained for review without automatic attachment.' },
};
export function MessageSourceReference({ reference,invalid=false,locale }: { reference:SourceReference|null;invalid?:boolean;locale:'ar'|'fr'|'en' }) {
  const t=labels[locale];
  if (invalid) return <p role="status">{t.invalid}</p>;
  if (!reference) return null;
  return <aside className="message-source-reference" aria-label={t.title}>
    <strong>{t.title}</strong><p>{reference.namespace==='META_AD' ? t.ad : t.post} · <bdi>{reference.externalId}</bdi></p>
    {reference.headline && <p>{reference.headline}</p>}
    {reference.description && <p className="message-body">{reference.description}</p>}
  </aside>;
}
