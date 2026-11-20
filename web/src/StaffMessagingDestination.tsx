import { useEffect, useState } from 'react';
import type { NotificationApi, NotificationLocale } from './NotificationCenter.js';

const words = {
 ar:{title:'رقم الإشعارات الداخلية',number:'رقم الموظف بالصيغة الدولية',verify:'أدخل رقمك بالصيغة الدولية للتأكيد',unset:'لم يُضبط رقم للإشعارات الداخلية.',yes:'الموافقة مسجلة',no:'بانتظار موافقة الموظف',inactive:'التفعيل غير متاح للحساب أو الفرع حاليًا.',save:'حفظ رقم الموظف',remove:'إزالة الرقم',accept:'أوافق على استقبال الإشعارات الداخلية',revoke:'سحب الموافقة',history:'سجل الرقم والموافقة',more:'إصدارات أقدم',refresh:'تحديث الرقم',empty:'لا توجد تغييرات محفوظة.',SET:'تعديل الرقم',GRANT:'تأكيد الموافقة',REVOKE:'سحب الموافقة',ACCOUNT_CHANGED:'إبطال الرقم بسبب تغيّر الحساب'},
 en:{title:'Internal messaging number',number:'Staff phone in international format',verify:'Confirm your international phone number',unset:'No internal messaging number configured.',yes:'Consent recorded',no:'Awaiting staff consent',inactive:'Activation is unavailable for this account or branch.',save:'Save staff number',remove:'Remove number',accept:'Consent to internal notifications',revoke:'Withdraw consent',history:'Number and consent history',more:'Older versions',refresh:'Refresh number',empty:'No changes recorded.',SET:'Number updated',GRANT:'Consent granted',REVOKE:'Consent withdrawn',ACCOUNT_CHANGED:'Number cleared after account change'},
 fr:{title:'Numéro de messagerie interne',number:'Numéro professionnel au format international',verify:'Confirmez votre numéro au format international',unset:'Aucun numéro de messagerie interne configuré.',yes:'Consentement enregistré',no:'En attente du consentement',inactive:'Activation indisponible pour ce compte ou cette agence.',save:'Enregistrer le numéro',remove:'Retirer le numéro',accept:'Accepter les notifications internes',revoke:'Retirer le consentement',history:'Historique du numéro et du consentement',more:'Versions précédentes',refresh:'Actualiser le numéro',empty:'Aucun changement enregistré.',SET:'Numéro modifié',GRANT:'Consentement accordé',REVOKE:'Consentement retiré',ACCOUNT_CHANGED:'Numéro effacé après modification du compte'},
} as const;

type Destination = { version: number; phoneLast4: string | null; consented: boolean; canActivate: boolean };
type History = { items: { version: number; operation: 'SET'|'GRANT'|'REVOKE'|'ACCOUNT_CHANGED';
  phoneLast4: string | null; consented: boolean; changedAt: string }[]; nextVersion: number | null };

export function staffMessagingLabel(locale: NotificationLocale) { return words[locale].title; }

export function StaffMessagingDestination({ api, locale, staffId }: {
  api: NotificationApi; locale: NotificationLocale; staffId?: string;
}) {
  const t = words[locale];
  const path = staffId ? `/api/users/${staffId}/notification-messaging-destination` : '/api/notification-messaging/destination';
  const [destination, setDestination] = useState<Destination | null>(null);
  const [phone, setPhone] = useState('');
  const [history, setHistory] = useState<History | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setDestination(null);setHistory(null);setError('');setPhone('');
    void api<Destination>(path).then(row => { if (active) setDestination(row); })
      .catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [path]);

  async function run(action: () => Promise<void>) {
    setBusy(true);setError('');setPhone('');
    try { await action(); }
    catch (failure) { setDestination(null);setHistory(null);setError(String(failure)); }
    finally { setBusy(false); }
  }

  function save(number: string | null, enabled?: boolean) {
    if (!destination) return;
    void run(async () => {
      setDestination(await api<Destination>(path, { method: 'PUT', body: JSON.stringify({
        version: destination.version, phone: number, ...(staffId ? {} : { enabled }),
      }) }));
      setHistory(null);
    });
  }

  function loadHistory(before?: number) {
    void run(async () => setHistory(await api<History>(path+'/history'+(before ? `?before=${before}` : ''))));
  }

  return <section className="panel form-panel" data-staff-messaging-destination>
    <h3>{t.title}</h3>
    {error && <p role="alert">{error}</p>}
    <button className="secondary" disabled={busy} onClick={() => void run(async () => {
      setDestination(await api<Destination>(path));setHistory(null);
    })}>{t.refresh}</button>
    {destination && <>
      {destination.phoneLast4 ? <p><bdi>••••{destination.phoneLast4}</bdi> · {destination.consented ? t.yes : t.no}</p> : <p>{t.unset}</p>}
      {!destination.canActivate && <p>{t.inactive}</p>}
      {destination.canActivate && (staffId || destination.phoneLast4 && !destination.consented) &&
        <form onSubmit={event => { event.preventDefault();save(phone, true); }}>
          <label>{staffId ? t.number : t.verify}<input value={phone} type="tel" dir="ltr" required
            autoComplete="off" maxLength={16} pattern="\+[1-9][0-9]{7,14}" disabled={busy}
            onChange={event => setPhone(event.target.value)} /></label>
          <button disabled={busy}>{staffId ? t.save : t.accept}</button>
        </form>}
      {destination.phoneLast4 && staffId && <button disabled={busy} onClick={() => save(null)}>{t.remove}</button>}
      {destination.consented && !staffId && <button disabled={busy} onClick={() => save(null, false)}>{t.revoke}</button>}
      <button className="secondary" disabled={busy} onClick={() => loadHistory()}>{t.history}</button>
      {history && (history.items.length ? <ul>{history.items.map(item => <li key={item.version}>
        {t[item.operation]} {item.phoneLast4 && <bdi>••••{item.phoneLast4}</bdi>} · <time dateTime={item.changedAt}>{new Date(item.changedAt).toLocaleString(locale)}</time>
      </li>)}</ul> : <p>{t.empty}</p>)}
      {history?.nextVersion && <button className="secondary" disabled={busy} onClick={() => loadHistory(history.nextVersion!)}>{t.more}</button>}
    </>}
  </section>;
}
