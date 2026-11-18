import {GoogleSheetsError} from './errors.js';
export type GoogleExportCell=string|number|boolean|null;
export type GoogleNewWorksheet={sheetId:number;title:string;cells:GoogleExportCell[][]};
const maxBodyBytes=8388608;
function invalid():never{throw new GoogleSheetsError('GOOGLE_INPUT_INVALID');}
// Exact text, never CSV prefixes, locale number parsing or a formulaValue.
export function googleExportCell(value:unknown):GoogleExportCell{
 if(value===null||value===undefined)return null;
 if(typeof value==='boolean')return value;
 if(typeof value==='number'){if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)invalid();return value;}
 const text=typeof value==='string'?value:typeof value==='object'?JSON.stringify(value):String(value);
 if(text.length>20000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)||!text.isWellFormed())invalid();return text;
}
export function googleNewWorksheetBody(input:GoogleNewWorksheet):string{
 if(!Number.isSafeInteger(input.sheetId)||input.sheetId<0||input.sheetId>2147483647||typeof input.title!=='string'||!input.title.trim()||input.title.length>100
  ||/[\x00-\x1f\x7f\\/?:*\[\]]/.test(input.title)||!input.title.isWellFormed()||!Array.isArray(input.cells)||input.cells.length<1||input.cells.length>10001)invalid();
 const columns=input.cells[0]?.length??0;if(columns<1||columns>64)invalid();let budget=4096;
 // Bound serialization before allocating the complete request and nested cell objects.
 for(const row of input.cells){if(!Array.isArray(row)||row.length!==columns)invalid();for(const cell of row){
  if(cell!==null&&!['string','number','boolean'].includes(typeof cell))invalid();googleExportCell(cell);
  budget+=Buffer.byteLength(JSON.stringify(cell??''))+64;if(budget>maxBodyBytes)invalid();
 }}
 const body=JSON.stringify({requests:[{addSheet:{properties:{sheetId:input.sheetId,title:input.title,sheetType:'GRID',gridProperties:{rowCount:input.cells.length,columnCount:columns}}}},
  {updateCells:{start:{sheetId:input.sheetId,rowIndex:0,columnIndex:0},fields:'userEnteredValue',rows:input.cells.map(row=>({values:row.map(value=>({userEnteredValue:
   typeof value==='number'?{numberValue:value}:typeof value==='boolean'?{boolValue:value}:{stringValue:value??''}}))}))}}],includeSpreadsheetInResponse:false});
 if(Buffer.byteLength(body)>maxBodyBytes)invalid();return body;
}
