import {test} from 'node:test';import assert from 'node:assert/strict';
import {googleExportCell,googleNewWorksheetBody,type GoogleNewWorksheet} from '../src/google/export-cells.js';
import {googleSheetsAdapter,GoogleSheetsError} from '../src/google/sheets.js';
const input:GoogleNewWorksheet={sheetId:8342,title:'Lead export synthetic',cells:[['=HEADER','Phone','Amount'],['=HYPERLINK("https://untrusted.invalid")','000123','999999999999999999.99'],[0,false,null]]};
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
const code=(name:GoogleSheetsError['code'])=>(e:unknown)=>e instanceof GoogleSheetsError&&e.code===name;
const ack=()=>({spreadsheetId:'SyntheticExport',replies:[{addSheet:{properties:{sheetId:input.sheetId,title:input.title,sheetType:'GRID',gridProperties:{rowCount:3,columnCount:3}}}},{}]});
test('Google export preserves exact literal and structured text without CSV prefixes, numeric parsing, truncation or executable formulas',()=>{
 assert.equal(googleExportCell('=RAW()'),'=RAW()');assert.equal(googleExportCell('0000123'),'0000123');assert.equal(googleExportCell(false),false);assert.equal(googleExportCell(0),0);assert.equal(googleExportCell(null),null);
 assert.equal(googleExportCell({currency:'EUR',amount:'12345678901234567890.01'}),'{"currency":"EUR","amount":"12345678901234567890.01"}');
 assert.equal(googleExportCell('x'.repeat(20000)),'x'.repeat(20000));
 for(const v of [Number.NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'x'.repeat(20001),'bad\0text','bad\ud800'])assert.throws(()=>googleExportCell(v),code('GOOGLE_INPUT_INVALID'));
 const body=JSON.parse(googleNewWorksheetBody(input));assert.equal(body.requests.length,2);assert.equal(body.includeSpreadsheetInResponse,false);
 assert.deepEqual(body.requests[0],{addSheet:{properties:{sheetId:8342,title:input.title,sheetType:'GRID',gridProperties:{rowCount:3,columnCount:3}}}});
 const write=body.requests[1].updateCells;assert.deepEqual(write.start,{sheetId:8342,rowIndex:0,columnIndex:0});assert.equal(write.fields,'userEnteredValue');
 assert.deepEqual(write.rows[1].values.map((v:any)=>v.userEnteredValue),[{stringValue:input.cells[1]![0]},{stringValue:'000123'},{stringValue:'999999999999999999.99'}]);
 assert.deepEqual(write.rows[2].values.map((v:any)=>v.userEnteredValue),[{numberValue:0},{boolValue:false},{stringValue:''}]);assert.ok(!JSON.stringify(body).includes('formulaValue'));
});
test('Google new-sheet write is one confined atomic request with exact identity ACK and finite UNKNOWN outcomes, never a hidden retry',async()=>{
 let calls=0;const adapter=googleSheetsAdapter(async(u,init)=>{calls++;assert.equal(String(u),'https://sheets.googleapis.com/v4/spreadsheets/SyntheticExport:batchUpdate');assert.equal(init!.method,'POST');assert.equal(init!.redirect,'error');assert.ok(init!.signal);assert.equal(new Headers(init!.headers).get('authorization'),'Bearer SyntheticExportAccess');assert.equal(init!.body,googleNewWorksheetBody(input));return json(ack());});
 assert.deepEqual(await adapter.createWorksheet('SyntheticExportAccess','SyntheticExport',input),{sheetId:8342,title:input.title,rows:3,columns:3});assert.equal(calls,1);
 for(const bad of [{...ack(),spreadsheetId:'wrong'},{...ack(),replies:[]},{...ack(),replies:[{addSheet:{properties:{sheetId:8}}},{}]}, {...ack(),replies:[ack().replies[0],{unexpected:true}]}])await assert.rejects(googleSheetsAdapter(async()=>json(bad)).createWorksheet('SyntheticExportAccess','SyntheticExport',input),code('GOOGLE_RESULT_UNKNOWN'));
 let lost=0;await assert.rejects(googleSheetsAdapter(async()=>{lost++;throw Error('secret synthetic provider details');}).createWorksheet('SyntheticExportAccess','SyntheticExport',input),e=>code('GOOGLE_RESULT_UNKNOWN')(e)&&!String(e).includes('secret'));assert.equal(lost,1);
 await assert.rejects(googleSheetsAdapter(async()=>json({secret:'ignored'},503)).createWorksheet('SyntheticExportAccess','SyntheticExport',input),code('GOOGLE_RESULT_UNKNOWN'));
});
test('Google new-sheet serialization rejects invalid shape, dangerous targets and excessive total payload before any transport',async()=>{
 let calls=0;const adapter=googleSheetsAdapter(async()=>{calls++;return json(ack());});
 for(const bad of [{...input,sheetId:-1},{...input,title:'bad/title'},{...input,cells:[]},{...input,cells:[[1],[1,2]]},{...input,cells:[Array(65).fill('x')]},{...input,cells:Array.from({length:10002},()=>['x'])},{...input,cells:[['x'.repeat(20001)]]},{...input,cells:Array.from({length:10},()=>Array(64).fill('x'.repeat(20000)))}])await assert.rejects(adapter.createWorksheet('SyntheticExportAccess','SyntheticExport',bad),code('GOOGLE_INPUT_INVALID'));
 await assert.rejects(adapter.createWorksheet('SyntheticExportAccess','https://untrusted.invalid',input),code('GOOGLE_INPUT_INVALID'));assert.equal(calls,0);
});
test('Independent numeric-grid read returns exact user-entered types and sparse empty cells, not formula results or formatted values',async()=>{
 const grid={sheetId:8342,row:4,column:2,rows:2,columns:3};
 const value=()=>({spreadsheetId:'SyntheticExport',sheets:[{properties:{sheetId:8342,title:'Renamed by external user',gridProperties:{rowCount:100,columnCount:20}},data:[{startRow:3,startColumn:1,rowData:[{values:[{userEnteredValue:{stringValue:'=RAW()'}},{userEnteredValue:{numberValue:0}},{userEnteredValue:{boolValue:false}}]},{values:[{userEnteredValue:{stringValue:'x'.repeat(20000)}}]}]}]}]});
 let calls=0;const adapter=googleSheetsAdapter(async(u,init)=>{calls++;const url=new URL(String(u));assert.equal(url.pathname,'/v4/spreadsheets/SyntheticExport:getByDataFilter');assert.ok(url.searchParams.get('fields')!.includes('userEnteredValue'));assert.ok(!url.searchParams.get('fields')!.includes('effectiveValue'));assert.equal(init!.method,'POST');assert.deepEqual(JSON.parse(String(init!.body)),{includeGridData:true,dataFilters:[{gridRange:{sheetId:8342,startRowIndex:3,endRowIndex:5,startColumnIndex:1,endColumnIndex:4}}]});return json(value());});
 assert.deepEqual(await adapter.readEnteredGrid('SyntheticExportAccess','SyntheticExport',grid),{sheetId:8342,title:'Renamed by external user',cells:[['=RAW()',0,false],['x'.repeat(20000),'','']]});assert.equal(calls,1);
 const empty=value() as any;delete empty.sheets[0].data;assert.deepEqual((await googleSheetsAdapter(async()=>json(empty)).readEnteredGrid('SyntheticExportAccess','SyntheticExport',grid)).cells,[['','',''],['','','']]);
 for(const mutate of [(v:any)=>v.spreadsheetId='other',(v:any)=>v.sheets[0].properties.sheetId=1,(v:any)=>v.sheets.push(v.sheets[0]),(v:any)=>v.sheets[0].data[0].startRow=0,(v:any)=>v.sheets[0].data[0].rowData[0].values[0].userEnteredValue={formulaValue:'=RAW()'},(v:any)=>v.sheets[0].data[0].rowData[0].values[0].userEnteredValue={stringValue:'x',numberValue:1}]){const v=value();mutate(v);await assert.rejects(googleSheetsAdapter(async()=>json(v)).readEnteredGrid('SyntheticExportAccess','SyntheticExport',grid),code('GOOGLE_RESPONSE_INVALID'));}
});
