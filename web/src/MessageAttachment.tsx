import { useState } from 'react';
export type Attachment = { id: string; state: string; mediaKind: string; mime: string;
  sizeBytes: number | null; errorCode: string | null; version: number };
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
export function MessageAttachment({ attachment, locale, canRetry = false, api }: {
  attachment: Attachment; locale: 'ar'|'fr'|'en'; canRetry?: boolean; api: Api;
}) {
  const [value, setValue] = useState(attachment); const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const t = {
    ar: { title: 'مرفق', download: 'تحميل الملف المفحوص', refresh: 'تحديث حالة المرفق',
      pending: 'التحميل متاح بعد نجاح التحقق وفحص المحتوى فقط.', reason: 'سبب إعادة المحاولة بعد معالجة الفشل', retry: 'إعادة محاولة المعالجة' },
    fr: { title: 'Pièce jointe', download: 'Télécharger le fichier vérifié', refresh: 'Actualiser',
      pending: 'Le téléchargement nécessite une validation et une analyse réussies.', reason: 'Motif après correction du problème', retry: 'Relancer le traitement' },
    en: { title: 'Attachment', download: 'Download scanned file', refresh: 'Refresh attachment',
      pending: 'Download is available only after validation and a successful content scan.', reason: 'Reason after resolving the failure', retry: 'Retry processing' },
  }[locale];
  async function act(action: 'refresh'|'retry'|'download') {
    setBusy(true); setError('');
    try {
      const path = `/api/messaging/attachments/${value.id}`;
      if (action === 'download') {
        const response = await fetch(path + '/download', { credentials: 'same-origin' });
        if (!response.ok) throw new Error((await response.json()).error ?? 'DOWNLOAD_FAILED');
        const blob = await response.blob(); const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a'); anchor.href = url;
        anchor.download = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'attachment.bin';
        anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        setValue(await api<Attachment>(path + (action === 'retry' ? '/retry' : ''), action === 'retry'
          ? { method: 'POST', body: JSON.stringify({ version: value.version, reason: reason.trim() }) } : undefined));
        setReason('');
      }
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  return <div className="panel"><strong>{t.title}</strong> · {value.mediaKind} · {value.mime} · {value.state}
    {value.sizeBytes != null && <span> · {(value.sizeBytes / 1024).toFixed(1)} KiB</span>}
    {value.errorCode && <p role="status">{value.errorCode}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {value.state === 'READY'
      ? <button type="button" className="secondary" disabled={busy} onClick={() => void act('download')}>{t.download}</button>
      : <><p>{t.pending}</p><button type="button" className="secondary" disabled={busy} onClick={() => void act('refresh')}>{t.refresh}</button></>}
    {canRetry && value.state === 'FAILED' && <div><label>{t.reason}<input value={reason} minLength={10} maxLength={1000}
      onChange={(event) => setReason(event.target.value)} /></label>
      <button type="button" disabled={busy || reason.trim().length < 10} onClick={() => void act('retry')}>{t.retry}</button></div>}
  </div>;
}
