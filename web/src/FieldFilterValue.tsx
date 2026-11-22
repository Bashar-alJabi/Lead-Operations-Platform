import {fieldFilterInputValue,type FilterField} from './field-filter.js';
type Field=FilterField&{options:{value:string;label:string;active:boolean}[]};
export function FieldFilterValue({field,value,onChange,label,all}:{field:Field;value:string;onChange:(v:string)=>void;label:string;all:string}){
 if(field.field_type==='MULTI_SELECT'){
  let selected:string[]=[];try{selected=value?JSON.parse(value) as string[]:[];}catch{/* Invalid saved value remains subject to server validation. */}
  return <select multiple aria-label={label} value={selected} onChange={e=>{const values=Array.from(e.currentTarget.selectedOptions,o=>o.value);onChange(values.length?JSON.stringify(values):'');}}>{field.options.filter(o=>o.active).map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>;
 }
 if(field.field_type==='TAGS'){
  let text='';try{text=value?(JSON.parse(value) as string[]).join(', '):'';}catch{text=value;}
  return <input aria-label={label} placeholder="tag1, tag2" value={text} onChange={e=>onChange(e.target.value)}/>;
 }
 if(field.field_type==='BOOLEAN')return <select aria-label={label} value={value} onChange={e=>onChange(e.target.value)}><option value="">{all}</option><option value="true">true</option><option value="false">false</option></select>;
 if(field.options?.length)return <select aria-label={label} value={value} onChange={e=>onChange(e.target.value)}><option value="">{all}</option>{field.options.filter(o=>o.active).map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>;
 const fieldType=field.filter_type??field.field_type;
 const type=['NUMBER','PERCENTAGE','DURATION','CURRENCY'].includes(fieldType)?'number':fieldType==='DATE'?'date':fieldType==='TIME'?'time':fieldType==='EMAIL'?'email':fieldType==='URL'?'url':'text';
 const isCalculatedNumber=field.filter_type==='NUMBER';
 return <><input aria-label={label} type={type} step={isCalculatedNumber?1:'any'} min={isCalculatedNumber?0:undefined}
  placeholder={fieldType==='DATETIME'?'YYYY-MM-DDTHH:mm:ssZ':undefined}
  value={fieldFilterInputValue(value)} onChange={e=>onChange(e.target.value)}/>{field.field_type==='CURRENCY'&&<small>{field.validation?.currency}</small>}</>;
}
