import test from 'node:test';import assert from 'node:assert/strict';import {googleSheetsAdapter,GoogleSheetsError} from '../src/google/sheets.js';
const grid={sheetId:0,row:1,column:1,rows:3,columns:3},filter={gridRange:{endRowIndex:3,endColumnIndex:3}},id='SyntheticGridSpreadsheet';
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
const data=(values:unknown)=>({spreadsheetId:id,valueRanges:[{dataFilters:[filter],valueRange:{range:'Renamed tab!A1:C3',majorDimension:'ROWS',values}}]});
test('sheet-ID reads pin exact numeric grid including zero defaults, tolerate renames, preserve all physical empty rows and long typed display text without formulas',async()=>{
 let calls=0;const a=googleSheetsAdapter(async(url,init)=>{calls++;assert.equal(String(url),'https://sheets.googleapis.com/v4/spreadsheets/'+id+'/values:batchGetByDataFilter');assert.equal(init!.method,'POST');assert.equal(init!.redirect,'error');assert.equal(new Headers(init!.headers).get('authorization'),'Bearer SyntheticGridAccess');
  assert.deepEqual(JSON.parse(String(init!.body)),{dataFilters:[{gridRange:{sheetId:0,startRowIndex:0,endRowIndex:3,startColumnIndex:0,endColumnIndex:3}}],majorDimension:'ROWS',valueRenderOption:'FORMATTED_VALUE'});return json(data([[0,false,'00012'],['=UNTRUSTED()','x'.repeat(20000)]]));});
 const rows=await a.readGrid('SyntheticGridAccess',id,grid);assert.deepEqual(rows[0],{rowNumber:1,cells:['0','false','00012']});assert.equal(rows[1]!.cells[1]!.length,20000);assert.deepEqual(rows[2],{rowNumber:3,cells:[null,null,null]});assert.equal(calls,1);
});
test('sheet-ID reads reject a different sheet/range, duplicate matches, hidden text controls and oversized values; readonly transport errors remain retryable',async()=>{
 const good=data([['ok']]);const bads=[{...good,spreadsheetId:'Other'}, {...good,valueRanges:[]},{...good,valueRanges:[good.valueRanges[0],good.valueRanges[0]]},
  {spreadsheetId:id,valueRanges:[{...good.valueRanges[0],dataFilters:[{gridRange:{...filter.gridRange,sheetId:8}}]}]},data([['x'.repeat(20001)]]),data([['bad\u0000text']]),data([[{},1]])];
 for(const bad of bads)await assert.rejects(googleSheetsAdapter(async()=>json(bad)).readGrid('SyntheticGridAccess',id,grid),e=>e instanceof GoogleSheetsError&&e.code==='GOOGLE_RESPONSE_INVALID');
 await assert.rejects(googleSheetsAdapter(async()=>{throw Error('Synthetic network outage');}).readGrid('SyntheticGridAccess',id,grid),e=>e instanceof GoogleSheetsError&&e.retryable&&e.code==='GOOGLE_PROVIDER_UNAVAILABLE');
});
