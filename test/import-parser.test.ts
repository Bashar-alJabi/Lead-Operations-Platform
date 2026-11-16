import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {parseImportBytes} from '../src/imports/parser.js';
import {validateImportSignature} from '../src/imports/signature.js';
import {parseImportIsolated} from '../src/imports/parse-isolated.js';
import {checkWorkbookZip} from '../src/imports/zip-safety.js';
function workbook(format:'xlsx'|'xls',values:unknown[][]){const b=XLSX.utils.book_new();XLSX.utils.book_append_sheet(b,XLSX.utils.aoa_to_sheet(values),'Customers');return XLSX.write(b,{type:'buffer',bookType:format,compression:true}) as Buffer;}
test('CSV preserves Unicode, duplicate/prototype headers, quoted separators/newlines and untrusted formula text without casting or object keys',()=>{
 const p=parseImportBytes(Buffer.from('\ufeffname,name,__proto__,phone\r\n"عميل, أ","<img src=x>","=1+1",001234\r\n"two\nlines",x,y,+441234'),'CSV');
 assert.deepEqual(p.sheets[0]!.headers,['name','name','__proto__','phone']);assert.deepEqual(p.sheets[0]!.rows[0]!.cells,['عميل, أ','<img src=x>','=1+1','001234']);assert.equal(p.sheets[0]!.rows[1]!.cells[0],'two\nlines');
 assert.equal(parseImportBytes(Buffer.from('a;b\n1;2'),'CSV',';').rowCount,1);assert.equal(parseImportBytes(Buffer.from('a\tb\n1\t2'),'CSV','\t').sheets[0]!.headers.length,2);
});
test('CSV rejects binary/invalid UTF-8, oversized and malformed records or wrong widths and never silently truncates rows/columns',()=>{
 for(const b of [Buffer.from([0xff,0xfe]),Buffer.from('a\n\0'),Buffer.alloc(8388609),Buffer.alloc(0)])assert.throws(()=>parseImportBytes(b,'CSV'),/IMPORT_/);
 for(const text of ['a,b\n1,2,3','a,b\n"oops,2','a\n'+('x'.repeat(8193)),'a\n','<html>bad'])assert.throws(()=>parseImportBytes(Buffer.from(text),'CSV'),/IMPORT_/);
 assert.throws(()=>parseImportBytes(Buffer.from('a\n'+'x\n'.repeat(10001)),'CSV'),/IMPORT_ROW_LIMIT/);
 assert.throws(()=>parseImportBytes(Buffer.from(Array(65).fill('a').join(',')+'\n'+Array(65).fill('b').join(',')),'CSV'),/IMPORT_COLUMN_LIMIT/);
});
test('Excel XLSX and legacy OLE XLS preserve displayed strings and cell ordinals; formulas and malformed/empty workbooks fail closed',async()=>{
 for(const format of ['xlsx','xls'] as const){const b=workbook(format,[['name','phone'],['Test','00123'],['Other',42]]);const p=await parseImportIsolated(b,format.toUpperCase() as 'XLSX'|'XLS',',');
  assert.equal(p.rowCount,2);assert.equal(p.sheets[0]!.rows[0]!.number,2);assert.equal(p.sheets[0]!.rows[0]!.cells[1],'00123');assert.equal(p.sheets[0]!.rows[1]!.cells[1],'42');}
 const book=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([['name'],['cached']]);sheet.A2={t:'s',v:'cached',f:'HYPERLINK("https://example.test","cached")'};XLSX.utils.book_append_sheet(book,sheet,'Unsafe');
 await assert.rejects(parseImportIsolated(XLSX.write(book,{type:'buffer',bookType:'xlsx'}) as Buffer,'XLSX',','),/IMPORT_FORMULAS_REJECTED/);
 assert.throws(()=>validateImportSignature(Buffer.from('name\nhello'),'XLSX'),/IMPORT_FORMAT_MISMATCH/);
 await assert.rejects(parseImportIsolated(Buffer.from('PK\x03\x04invalid'),'XLSX',','),/IMPORT_ARCHIVE_REJECTED/);
 const blank=workbook('xlsx',[['name']]);await assert.rejects(parseImportIsolated(blank,'XLSX',','),/IMPORT_NO_DATA/);
 book.vbaraw=Buffer.from('Synthetic macro payload');await assert.rejects(parseImportIsolated(XLSX.write(book,{type:'buffer',bookType:'xlsm'}) as Buffer,'XLSX',','),/IMPORT_ARCHIVE_REJECTED/);
});
test('XLSX archive inspection caps expansion and isolated parser deadline kills only the child; later parses remain available',async()=>{
 const valid=workbook('xlsx',[['a'],['ok']]);await checkWorkbookZip(valid);
 const large=workbook('xlsx',[['a'],...Array.from({length:2500},()=>['x'.repeat(8192)])]);assert.ok(large.length<8388608);
 await assert.rejects(parseImportIsolated(large,'XLSX',','),/IMPORT_ARCHIVE_REJECTED/);
 await assert.rejects(parseImportIsolated(valid,'XLSX',',',1),/IMPORT_PARSE_RESOURCE_LIMIT/);assert.equal((await parseImportIsolated(valid,'XLSX',',')).rowCount,1);
});
