// RFC4180 quoting plus spreadsheet formula protection for every untrusted cell/header.
export function csvCell(value:unknown):string {
 let text=value===null||value===undefined?'':typeof value==='object'?JSON.stringify(value):String(value);
 const start=text.normalize('NFKC').replace(/^[\s'\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]*/u,'');
 // A tab inside the quoted field remains text in Excel after CSV save/re-open.
 // It is an intentional part of the exported value, not a universal round-trip encoding.
 if(/^[=+@-]/u.test(start)||/^[\t\r\n]/u.test(text))text='\t'+text;
 return '"'+text.replaceAll('"','""')+'"';
}
export function csvRow(values:unknown[]){return values.map(csvCell).join(',')+'\r\n';}
