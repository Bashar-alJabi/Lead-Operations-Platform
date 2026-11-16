import {parse} from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import {importMaxBytes,importMaxRows,ImportParseError,type ImportFormat,type ParsedSheet,type ParsedImport} from './types.js';
export {validateImportSignature} from './signature.js';
import {validateImportSignature} from './signature.js';
function fail(code:string):never {throw new ImportParseError(code);}
function cell(value:unknown):string|null{
 if(value===null||value===undefined)return null;
 if(typeof value!=='string')fail('IMPORT_CELL_INVALID');
 if(value.length>8192||value.includes('\0'))fail('IMPORT_CELL_SIZE');return value;
}
function headers(values:(string|null)[]){return values.map((v,i)=>{const s=v?.trim()||'Column '+(i+1);if(s.length>256)fail('IMPORT_HEADER_SIZE');return s;});}
export function parseImportBytes(bytes:Buffer,format:ImportFormat,delimiter:','|';'|'\t'=','):ParsedImport{
 validateImportSignature(bytes,format);
 if(format==='CSV'){
  let records:unknown[][];try{records=parse(bytes,{bom:true,delimiter,cast:false,skip_empty_lines:true,max_record_size:65536}) as unknown[][];}
  catch{fail('IMPORT_CSV_INVALID');}
  if(records!.length<2)fail('IMPORT_NO_DATA');if(records!.length>importMaxRows+1)fail('IMPORT_ROW_LIMIT');
  const width=records![0]!.length;if(!width||width>64)fail('IMPORT_COLUMN_LIMIT');
  const values=records!.map(row=>row.map(cell));
  return {sheets:[{index:0,name:'CSV',headers:headers(values[0]!),headerRow:1,rows:values.slice(1).map((cells,i)=>({number:i+2,cells}))}],rowCount:values.length-1};
 }
 let book:XLSX.WorkBook;
 try{book=XLSX.read(bytes,{type:'buffer',dense:true,cellHTML:false,cellStyles:false,cellFormula:true,cellText:true,cellDates:false,
   bookVBA:true,bookDeps:false,bookFiles:false,sheetRows:importMaxRows+2,WTF:true,dateNF:'yyyy-mm-dd',UTC:true});}
 catch{fail('IMPORT_WORKBOOK_INVALID');}
 if(book!.vbaraw)fail('IMPORT_MACROS_REJECTED');
 if(!book!.SheetNames.length||book!.SheetNames.length>10)fail('IMPORT_SHEET_LIMIT');
 const sheets:ParsedSheet[]=[];let count=0,totalChars=0;
 for(const name of book!.SheetNames){
  if(name.length>128||/[\x00-\x1f\x7f]/.test(name))fail('IMPORT_SHEET_INVALID');
  const sheet=book!.Sheets[name]!;if(!sheet['!ref'])continue;
  if(sheet['!type']&&sheet['!type']!=='sheet')fail('IMPORT_SHEET_INVALID');
  const range=XLSX.utils.decode_range(sheet['!fullref']??sheet['!ref']);
  if(range.e.c>=64)fail('IMPORT_COLUMN_LIMIT');
  if(range.e.r-range.s.r>importMaxRows)fail('IMPORT_ROW_LIMIT');
  const data=(sheet as XLSX.WorkSheet&{'!data'?:XLSX.CellObject[][]})['!data'];
  const matrix:(string|null)[][]=[];
  for(let r=range.s.r;r<=range.e.r;r++){
   const row:(string|null)[]=[];
   for(let c=0;c<=range.e.c;c++){
    const v=data?.[r]?.[c]??sheet[XLSX.utils.encode_cell({r,c})] as XLSX.CellObject|undefined;
    if(v&&(v.f!==undefined||v.F!==undefined))fail('IMPORT_FORMULAS_REJECTED');if(v?.t==='e')fail('IMPORT_ERROR_CELL');
    const text=cell(!v||v.t==='z'?null:v.w??String(v.v??''));totalChars+=text?.length??0;
    if(totalChars>16*1024*1024)fail('IMPORT_TEXT_LIMIT');row.push(text);
   }matrix.push(row);
  }
  if(matrix.length<2)continue;
  count+=matrix.length-1;if(count>importMaxRows)fail('IMPORT_ROW_LIMIT');
  sheets.push({index:sheets.length,name,headers:headers(matrix[0]!),headerRow:range.s.r+1,rows:matrix.slice(1).map((cells,i)=>({number:range.s.r+i+2,cells}))});
 }
 if(!count)fail('IMPORT_NO_DATA');return {sheets,rowCount:count};
}
