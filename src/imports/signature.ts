import {importMaxBytes,ImportParseError,type ImportFormat} from './types.js';
export function validateImportSignature(bytes:Buffer,format:ImportFormat){
 const fail=(s:string):never=>{throw new ImportParseError(s);};
 if(!bytes.length||bytes.length>importMaxBytes)fail('IMPORT_FILE_SIZE');
 if(format==='XLSX'&&!bytes.subarray(0,4).equals(Buffer.from([0x50,0x4b,3,4])))fail('IMPORT_FORMAT_MISMATCH');
 if(format==='XLS'&&!bytes.subarray(0,8).equals(Buffer.from('d0cf11e0a1b11ae1','hex')))fail('IMPORT_FORMAT_MISMATCH');
 if(format==='CSV'){
  let text='';try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('IMPORT_CSV_UTF8_REQUIRED');}
  if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))fail('IMPORT_CSV_CONTROL_CHARACTER');
  if(/^\s*<(?:!doctype|html|\?xml)/i.test(text))fail('IMPORT_FORMAT_MISMATCH');
 }
}
