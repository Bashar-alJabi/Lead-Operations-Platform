import { HttpError } from '../security.js';

export const knowledgeSections=['description','product','prices','locations','schedules','availability','requirements','registration','policies'] as const;
export type KnowledgeContent={ sections:Record<typeof knowledgeSections[number],string>;faqs:{ question:string;answer:string }[];allowedClaims:string[];prohibitedClaims:string[];links:{ label:string;url:string }[] };
export const emptyKnowledge=():KnowledgeContent=>({ sections:Object.fromEntries(knowledgeSections.map((key)=>[key,''])) as KnowledgeContent['sections'],faqs:[],allowedClaims:[],prohibitedClaims:[],links:[] });
const invalid=()=>{ throw new HttpError(400,'AI_KNOWLEDGE_CONTENT_INVALID'); };
function object(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==keys.length || keys.some((k)=>!Object.hasOwn(value,k)))return invalid();return value as Record<string,unknown>;
}
function text(value:unknown,max:number,required=true):string {
  if(typeof value!=='string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || Buffer.from(value,'utf8').toString('utf8')!==value)return invalid();const result=value.trim();if(result.length>max || (required && !result))return invalid();return result;
}
function array<T>(value:unknown,max:number,normalize:(v:unknown)=>T):T[] { if(!Array.isArray(value) || value.length>max)return invalid();return value.map(normalize); }
export function normalizeKnowledge(value:unknown):KnowledgeContent {
  const input=object(value,['sections','faqs','allowedClaims','prohibitedClaims','links']),sections=object(input.sections,knowledgeSections);
  const result:KnowledgeContent={ sections:Object.fromEntries(knowledgeSections.map((key)=>[key,text(sections[key],8000,false)])) as KnowledgeContent['sections'],
    faqs:array(input.faqs,40,(v)=>{ const faq=object(v,['question','answer']);return { question:text(faq.question,500),answer:text(faq.answer,4000) }; }),
    allowedClaims:array(input.allowedClaims,80,(v)=>text(v,500)),prohibitedClaims:array(input.prohibitedClaims,80,(v)=>text(v,500)),
    links:array(input.links,30,(v)=>{ const link=object(v,['label','url']);const raw=text(link.url,2048);let url:URL;try { url=new URL(raw); }catch { return invalid(); }
      if(url.protocol!=='https:' || url.username || url.password || /[\s\u0000-\u001f\u007f]/.test(raw))return invalid();
      const normalized=url.toString();if(normalized.length>2048)return invalid();return { label:text(link.label,200),url:normalized }; }) };
  // Conservative formatted size also bounds PostgreSQL's spaced jsonb representation.
  if(Buffer.byteLength(JSON.stringify(result,null,1),'utf8')>65536)return invalid();return result;
}
export function knowledgeHasContent(content:KnowledgeContent) { return Object.values(content.sections).some(Boolean) || content.faqs.length>0 || content.allowedClaims.length>0 || content.links.length>0; }
export const knowledgeContentSchema={ type:'object',additionalProperties:false,required:['sections','faqs','allowedClaims','prohibitedClaims','links'],properties:{
  sections:{ type:'object',additionalProperties:false,required:knowledgeSections,properties:Object.fromEntries(knowledgeSections.map((key)=>[key,{ type:'string',maxLength:8000 }])) },
  faqs:{ type:'array',maxItems:40,items:{ type:'object',additionalProperties:false,required:['question','answer'],properties:{ question:{ type:'string',minLength:1,maxLength:500 },answer:{ type:'string',minLength:1,maxLength:4000 } } } },
  allowedClaims:{ type:'array',maxItems:80,items:{ type:'string',minLength:1,maxLength:500 } },prohibitedClaims:{ type:'array',maxItems:80,items:{ type:'string',minLength:1,maxLength:500 } },
  links:{ type:'array',maxItems:30,items:{ type:'object',additionalProperties:false,required:['label','url'],properties:{ label:{ type:'string',minLength:1,maxLength:200 },url:{ type:'string',maxLength:2048 } } } },
} } as const;
