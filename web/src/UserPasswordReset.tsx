import { useState } from 'react';

type Locale='ar'|'en'|'fr';
type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Delivery='QUEUED'|'RECENT_REQUEST';
const labels={
  ar:{title:'إرسال رابط استعادة كلمة المرور',recipient:'البريد المسجّل',reason:'سبب طلب الاستعادة',
    submit:'طلب إرسال الرابط',queued:'أُضيف رابط الاستعادة إلى طابور البريد.',recent:'يوجد طلب استعادة حديث لهذا الحساب.',
    unavailable:'اختبر اتصال بريد الحسابات قبل إرسال الرابط.',error:'تعذّر طلب استعادة كلمة المرور.'},
  en:{title:'Send password reset link',recipient:'Registered email',reason:'Reset request reason',
    submit:'Queue reset link',queued:'The password reset email was queued.',recent:'This account already has a recent reset request.',
    unavailable:'Verify the identity email connection before requesting a link.',error:'The password reset request failed.'},
  fr:{title:'Envoyer un lien de réinitialisation',recipient:'Adresse enregistrée',reason:'Motif de la réinitialisation',
    submit:'Mettre le lien en file d’attente',queued:'L’e-mail de réinitialisation a été mis en file d’attente.',recent:'Ce compte a déjà une demande récente.',
    unavailable:'Vérifiez la connexion e-mail des comptes avant de demander un lien.',error:'La demande de réinitialisation a échoué.'},
};

export const passwordResetLabel=(locale:Locale)=>labels[locale].title;

export function UserPasswordReset({id,email,locale,api}:{id:string;email:string;locale:Locale;api:Api}) {
  const t=labels[locale];
  const [reason,setReason]=useState('');
  const [delivery,setDelivery]=useState<Delivery|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');

  async function request() {
    setBusy(true);setError('');setDelivery(null);
    try {
      const result=await api<{delivery:Delivery}>(`/api/users/${id}/password-reset`,{method:'POST',body:JSON.stringify({reason})});
      setDelivery(result.delivery);setReason('');
    } catch (failure) {
      setError(String(failure).includes('IDENTITY_EMAIL_UNAVAILABLE')?t.unavailable:t.error);
    } finally { setBusy(false); }
  }

  return <section data-user-password-reset aria-busy={busy}>
    <h3>{t.title}</h3><p>{t.recipient}{' · '}<bdi>{email}</bdi></p>
    <form className="workflow-form" onSubmit={event=>{event.preventDefault();void request();}}>
      <label>{t.reason}<input required minLength={3} maxLength={500} value={reason} onChange={event=>setReason(event.target.value)} disabled={busy} /></label>
      <button disabled={busy||reason.trim().length<3}>{t.submit}</button>
    </form>
    {delivery&&<p role="status">{delivery==='QUEUED'?t.queued:t.recent}</p>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
