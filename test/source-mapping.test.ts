import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewSourceMapping,validateMappingEntries,suggestMapping,sourceCatalogHash,mappingTargetHash,type MappingEntry,type MappingTarget } from '../src/sources/field-mapping.js';
import type { SourceQuestion } from '../src/sources/meta-provider.js';
const q=(key:string|null,type='CUSTOM'):SourceQuestion=>({ key,type,externalId:null,label:key,options:[] });
const target=(id:string,field_type:MappingTarget['field_type']):MappingTarget=>({ id,key:id,label:id,field_type,value_mode:'SOURCE',options:[],validation:{},version:1,binding_version:1,required_stage:'NONE' });
const entry=(sourceKey:string,kind:MappingEntry['kind']='LEAD_FIELD',fieldId?:string,transform:MappingEntry['transform']='TEXT'):MappingEntry=>({ sourceKey,kind,...(fieldId ? { fieldId } : {}),transform,optionMap:[] });
test('source preview converts explicit typed values through existing field validation without fixed contact requirements',()=> {
  const targets=[target('score','NUMBER'),target('enabled','BOOLEAN'),{ ...target('amount','CURRENCY'),validation:{ currency:'USD' } },
    { ...target('interests','MULTI_SELECT'),options:[{ value:'course',label:'Course',active:true }] }];
  const entries=[entry('full_name','CONTACT_NAME'),entry('phone','CONTACT_PHONE'),entry('email','CONTACT_EMAIL'),entry('score','LEAD_FIELD','score','NUMBER'),
    entry('enabled','LEAD_FIELD','enabled','BOOLEAN'),entry('amount','LEAD_FIELD','amount','CURRENCY'),{ ...entry('interests','LEAD_FIELD','interests','LIST'),optionMap:[{ source:'Provider course',target:'course' }] }];
  const values=[['full_name',' <img src=x> '],['phone','+1 (555) 000-1111'],['email',' USER@Example.COM '],['score','12.50'],['enabled','false'],['amount','1.250000'],['interests','Provider course']];
  const preview=previewSourceMapping(entries,entries.map((e)=>q(e.sourceKey)),targets,values.map(([key,value])=>({ key:key!,values:[value!] })),['score']);
  assert.equal(preview.valid,true);assert.deepEqual(preview.contact,{ name:'<img src=x>',phone:'+15550001111',email:'user@example.com' });
  assert.deepEqual(preview.fields.map((f)=>f.value),[12.5,false,{ amount:1.25,currency:'USD' },['course']]);
  assert.equal(previewSourceMapping([],[],[],[],[]).valid,true);
});
test('source preview rejects invalid numbers, scalar ambiguity, Boolean guesses, required missing values and unsafe field values',()=> {
  const targets=[target('score','NUMBER'),target('flag','BOOLEAN'),target('link','URL')];
  const entries=[entry('score','LEAD_FIELD','score','NUMBER'),entry('flag','LEAD_FIELD','flag','BOOLEAN'),entry('link','LEAD_FIELD','link')];
  const questions=entries.map((e)=>q(e.sourceKey));
  for (const value of ['1e3','0x10','Infinity','9007199254740993','01']) assert.equal(previewSourceMapping(entries,questions,targets,[{ key:'score',values:[value] }],['score']).valid,false);
  const preview=previewSourceMapping(entries,questions,targets,[{ key:'score',values:['1','2'] },{ key:'flag',values:['yes'] },{ key:'link',values:['javascript:alert(1)'] }],['score']);
  assert.deepEqual(preview.errors.map((e)=>e.code),['SOURCE_MAPPING_SCALAR_REQUIRED','SOURCE_MAPPING_BOOLEAN_INVALID','FIELD_VALUE_INVALID','SOURCE_REQUIRED_VALUE_MISSING']);
  assert.throws(()=>previewSourceMapping(entries,questions,targets,[{ key:'score',values:['1'] },{ key:'score',values:['2'] }],[]),/SOURCE_MAPPING_DUPLICATE_INPUT/);
});
test('mapping rejects unknown or duplicate source identities, duplicate destinations and calculated/system fields',()=> {
  assert.throws(()=>validateMappingEntries([entry('x','CONTACT_NAME')],[q(null)],[]),/SOURCE_MAPPING_QUESTION_UNKNOWN_OR_AMBIGUOUS/);
  assert.throws(()=>validateMappingEntries([entry('x','CONTACT_NAME')],[q('x'),q('x')],[]),/SOURCE_MAPPING_QUESTION_UNKNOWN_OR_AMBIGUOUS/);
  assert.throws(()=>validateMappingEntries([entry('x','CONTACT_NAME'),entry('y','CONTACT_NAME')],[q('x'),q('y')],[]),/SOURCE_MAPPING_DUPLICATE_TARGET/);
  assert.throws(()=>validateMappingEntries([entry('x','LEAD_FIELD','x')],[q('x')],[{ ...target('x','TEXT'),value_mode:'SYSTEM' }]),/SOURCE_MAPPING_TARGET_NOT_FOUND/);
  assert.throws(()=>validateMappingEntries([entry('x','LEAD_FIELD','x','TEXT')],[q('x')],[target('x','NUMBER')]),/SOURCE_MAPPING_TRANSFORM_INVALID/);
  assert.throws(()=>validateMappingEntries([{ ...entry('x','CONTACT_NAME'),optionMap:[{ source:'a',target:'b' }] }],[q('x')],[]),/SOURCE_MAPPING_OPTION_NOT_ALLOWED/);
});
test('mapping suggestions require review, never fabricate source keys and fingerprints track catalog and field changes',()=> {
  assert.deepEqual(suggestMapping(q('full_name'),[]),{ kind:'CONTACT_NAME',transform:'TEXT' });
  assert.deepEqual(suggestMapping(q('score'),[target('score','NUMBER')]),{ kind:'LEAD_FIELD',fieldId:'score',transform:'NUMBER' });
  assert.equal(suggestMapping(q(null,'FULL_NAME'),[]),null);assert.equal(suggestMapping(q('constructor'),[]),null);assert.equal(suggestMapping(q('__proto__'),[]),null);
  assert.notDeepEqual(sourceCatalogHash([q('x')]),sourceCatalogHash([q('y')]));assert.notEqual(mappingTargetHash(target('x','TEXT')),mappingTargetHash({ ...target('x','TEXT'),version:2 }));
});
