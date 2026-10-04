export type CallToActionButton = { type:'URL';text:string;url:string } | { type:'PHONE_NUMBER';text:string;phone_number:string };

export function TemplateButtons({ buttons }:{ buttons:CallToActionButton[] }) {
  return <div className="actions">{(Array.isArray(buttons) ? buttons.slice(0,2) : []).map((button,index)=> {
    // Backend validates the canonical historical snapshot; render only safe targets even for malformed cached data.
    if (!button || typeof button.text!=='string') return null;
    if (button.type==='PHONE_NUMBER') return typeof button.phone_number==='string' && !/[\x00-\x20\x7f]/.test(button.phone_number)
      && /^\+[1-9][0-9]{7,14}$/.test(button.phone_number)
      ? <a key={index} href={'tel:'+button.phone_number}>{button.text} · {button.phone_number}</a> : null;
    if (button.type!=='URL' || typeof button.url!=='string') return null;
    if (button.url.includes('{{') || button.url.includes('}}')) return <span key={index}>{button.text} · {button.url}</span>;
    if (button.url.length>2000 || /[\x00-\x20\x7f\\]/.test(button.url)) return null;
    try { const url=new URL(button.url);if (url.protocol!=='https:' || url.username || url.password) return null; }
    catch { return null; }
    return <a key={index} href={button.url} target="_blank" rel="noopener noreferrer">{button.text} · {button.url}</a>;
  })}</div>;
}
