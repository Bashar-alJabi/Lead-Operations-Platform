export type FilterField={field_type:string;validation?:{currency?:string}};
export function fieldFilterInputValue(value:unknown):string {
 if(Array.isArray(value))return JSON.stringify(value);
 if(value&&typeof value==='object'&&'amount'in value)return String(value.amount);
 return String(value??'');
}
export function fieldFilterValue(field:FilterField|undefined,text:string):unknown {
 if(field?.field_type==='MULTI_SELECT')return JSON.parse(text);
 if(field?.field_type==='TAGS'){
  if(text.startsWith('[')){try{const v:unknown=JSON.parse(text);if(Array.isArray(v))return v;}catch{/* A literal tag is still validated by the server. */}}
  return text.split(',').map(t=>t.trim()).filter(Boolean);
 }
 if(field?.field_type==='CURRENCY')return {amount:Number(text),currency:field.validation?.currency};
 if(field&&['NUMBER','PERCENTAGE','DURATION'].includes(field.field_type))return Number(text);
 if(field?.field_type==='BOOLEAN')return text==='true';
 return text;
}
