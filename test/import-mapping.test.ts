import {test} from 'node:test';
import assert from 'node:assert/strict';
import {convertImportCell,mapImportRow,validateImportMapping,type ImportMappingTarget,type ImportMappingEntry} from '../src/imports/mapping.js';
const target=(id:string,field_type:ImportMappingTarget['field_type'],extra:Partial<ImportMappingTarget>={}):ImportMappingTarget=>({id,key:id,label:id,field_type,value_mode:'MANUAL',options:[],validation:{},required_stage:'NONE',...extra});
test('Import typed conversion rejects locale guessing and coercion, preserves zero/false and validates JSON lists/currency/dates through the domain boundary',()=>{
 const targets=[target('n','NUMBER'),target('b','BOOLEAN'),target('t','TAGS'),target('c','CURRENCY',{validation:{currency:'EUR'}}),target('d','DATE')],entries:ImportMappingEntry[]=targets.map((f,column)=>({column,kind:'LEAD_FIELD',fieldId:f.id}));
 const row=mapImportRow(2,['0','FALSE','["x","y"]','12.500000','2026-11-16'],entries,targets,false);assert.equal(row.valid,true);assert.deepEqual(row.fields.map(f=>f.value),[0,false,['x','y'],{amount:12.5,currency:'EUR'},'2026-11-16']);
 for(const v of ['1,000','1e3','01','NaN','Infinity','1 000'])assert.throws(()=>convertImportCell(v,'NUMBER',{}));
 assert.throws(()=>convertImportCell('yes','BOOLEAN',{}));assert.throws(()=>convertImportCell('a,b','TAGS',{}));assert.throws(()=>convertImportCell('{}','TAGS',{}));
 assert.equal(mapImportRow(2,['9007199254740993','yes','["x","x"]','1.0000001','2026-02-30'],entries,targets,false).errors.length,5);
 assert.equal(convertImportCell('  ','NUMBER',{}),null);assert.equal(convertImportCell('=1+1','TEXT',{}),'=1+1');
});
test('Import column indices preserve duplicate/prototype headers and enforce single valid current targets without required Contact assumptions',()=>{
 const targets=[target('amount','NUMBER')],entries:ImportMappingEntry[]=[{column:0,kind:'CONTACT_NAME'},{column:1,kind:'CONTACT_PHONE'},{column:2,kind:'CONTACT_EMAIL'},{column:3,kind:'LEAD_FIELD',fieldId:'amount'}];
 validateImportMapping(entries,4,targets);const r=mapImportRow(2,[' Name ','+33 (1) 23-45-67-89','TEST@EXAMPLE.TEST','0'],entries,targets,false);assert.equal(r.valid,true);assert.equal(r.contact!.phoneNormalized,'+33123456789');assert.equal(r.contact!.emailNormalized,'test@example.test');
 assert.equal(mapImportRow(3,[null,null,null,'0'],entries,targets,false).contact,null);
 assert.throws(()=>validateImportMapping([...entries,{column:0,kind:'CONTACT_EMAIL'}],4,targets),/IMPORT_MAPPING_COLUMN_INVALID/);
 assert.throws(()=>validateImportMapping([{column:0,kind:'CONTACT_NAME'},{column:1,kind:'CONTACT_NAME'}],4,targets),/IMPORT_MAPPING_DUPLICATE_TARGET/);
 assert.throws(()=>validateImportMapping([{column:4,kind:'CONTACT_NAME'}],4,targets));assert.throws(()=>validateImportMapping([{column:0,kind:'LEAD_FIELD',fieldId:'hidden'}],4,targets),/IMPORT_MAPPING_FIELD_NOT_AVAILABLE/);
});
test('Import row errors identify source indices without leaking hidden required Fields; typed empty required and inactive options remain invalid',()=>{
 const targets=[target('n','NUMBER',{required_stage:'LEAD_CREATION'}),target('s','STATUS',{options:[{value:'ok',label:'OK',active:true},{value:'old',label:'Old',active:false}]})],entries:ImportMappingEntry[]=[{column:0,kind:'LEAD_FIELD',fieldId:'n'},{column:1,kind:'LEAD_FIELD',fieldId:'s'}];
 const r=mapImportRow(9,[null,'old'],entries,targets,false);assert.equal(r.valid,false);assert.deepEqual(r.errors,[{column:1,code:'FIELD_VALUE_INVALID'},{column:null,code:'IMPORT_REQUIRED_VALUE_MISSING'}]);
 const hidden=mapImportRow(2,['1','ok'],entries,targets,true);assert.equal(hidden.valid,false);assert.deepEqual(hidden.errors,[{column:null,code:'IMPORT_REQUIRED_VALUE_MISSING'}]);assert.ok(!JSON.stringify(hidden.errors).includes('fieldId'));
});
