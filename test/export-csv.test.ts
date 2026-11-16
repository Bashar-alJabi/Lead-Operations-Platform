import {test} from 'node:test';
import assert from 'node:assert/strict';
import {csvCell,csvRow} from '../src/exports/csv.js';
test('CSV export quotes delimiters and multiline text while preserving empty, false, zero and structured values',()=>{
 assert.equal(csvRow(['a,b','a"b','line\r\nnext',null,false,0]),'"a,b","a""b","line\r\nnext","","false","0"\r\n');
 assert.equal(csvCell({amount:'123.40',currency:'EUR'}),'"{""amount"":""123.40"",""currency"":""EUR""}"');
});
test('CSV export neutralizes spreadsheet formulas including whitespace, control, bidi and compatibility-prefix variants in headers and cells',()=>{
 for(const value of ['=1+1','+15550001111','-1+2','@SUM(1)',' \t=CMD()','\r\ncommand','\u200b\u202e=1','\ufeff=1',"'=1+1",'＝1+1','\u00a0=1'])assert.ok(csvCell(value).startsWith('"\t'),value);
 assert.equal(csvCell('customer@example.test'),'"customer@example.test"');assert.equal(csvCell('<img src=x onerror=alert(1)>'),'"<img src=x onerror=alert(1)>"');
});
