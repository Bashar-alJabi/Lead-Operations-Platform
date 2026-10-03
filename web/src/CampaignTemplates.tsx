import { useEffect, useState } from 'react';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Locale = 'ar'|'fr'|'en';
type Template = { id: string; name: string; language: string; category: string | null;
  status: string; body: string; bound: boolean; version: number };
const labels = {
  ar: { title: 'قوالب الحملة', explain: 'اختر القوالب المعتمدة التي يجوز استخدامها في محادثات هذه الحملة. يُعاد فحص الاعتماد والرقم المثبت عند الإرسال.',
    bind: 'السماح للحملة', unbind: 'إزالة السماح', empty: 'لا قوالب نصية لهذا الاتصال؛ أنشئها وزامنها من إعدادات Messaging.', more: 'المزيد' },
  fr: { title: 'Modèles de campagne', explain: 'Choisissez les modèles approuvés pour cette campagne. L’approbation et l’expéditeur fixé sont revérifiés avant l’envoi.',
    bind: 'Autoriser', unbind: 'Retirer', empty: 'Aucun modèle texte pour cette connexion. Créez et synchronisez-les dans Messagerie.', more: 'Plus' },
  en: { title: 'Campaign templates', explain: 'Choose approved templates allowed in this campaign. Approval and the pinned sender are checked again before sending.',
    bind: 'Allow', unbind: 'Remove', empty: 'No text templates for this connection. Create and sync them in Messaging setup.', more: 'More' },
} as const;

export function CampaignTemplates({ campaignId, senderId, locale, api }: {
  campaignId: string; senderId: string | null; locale: Locale; api: Api;
}) {
  const t = labels[locale];
  const [items, setItems] = useState<Template[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function load(next?: string) {
    const page = await api<{ items: Template[]; nextAfter: string | null; canManage: boolean }>(
      `/api/messaging/campaigns/${campaignId}/templates${next ? '?after=' + encodeURIComponent(next) : ''}`);
    setItems((current) => next ? [...current, ...page.items] : page.items);
    setAfter(page.nextAfter);
    setCanManage(page.canManage);
  }
  useEffect(() => { setItems([]); setAfter(null); setCanManage(false); setError('');
    void load().catch((failure) => setError(String(failure))); }, [campaignId, senderId]);
  async function toggle(item: Template) {
    setBusy(true); setError('');
    try { await api(`/api/messaging/campaigns/${campaignId}/templates/${item.id}`, {
      method: 'PUT', body: JSON.stringify({ version: item.version, bound: !item.bound }),
    }); await load(); }
    catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  return <section className="panel"><h3>{t.title}</h3><p>{t.explain}</p>
    {error && <p role="alert" className="error">{error}</p>}
    <ul>{items.map((item) => <li key={item.id}>{item.name} · {item.language} · {item.status}
      <p style={{ whiteSpace: 'pre-wrap' }}>{item.body}</p>
      {canManage && <button className="secondary" disabled={busy || (!item.bound && item.status !== 'APPROVED')}
        onClick={() => void toggle(item)}>{item.bound ? t.unbind : t.bind}</button>}</li>)}</ul>
    {!items.length && <p>{t.empty}</p>}
    {after && <button className="secondary" onClick={() => void load(after).catch((failure) => setError(String(failure)))}>{t.more}</button>}
  </section>;
}
