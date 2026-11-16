// Trusted parser code only. No application config, DB, storage credentials or network adapters.
import {parseImportBytes} from './parser.js';
import {ImportParseError,type ImportFormat} from './types.js';
import {checkWorkbookZip} from './zip-safety.js';
process.once('message',async(m:{bytes:string;format:ImportFormat;delimiter:','|';'|'\t'})=>{
 try{const bytes=Buffer.from(m.bytes,'base64');if(m.format==='XLSX')await checkWorkbookZip(bytes);
  const result=parseImportBytes(bytes,m.format,m.delimiter);process.send?.({result},()=>process.exit(0));}
 catch(e){process.send?.({error:e instanceof ImportParseError?e.code:'IMPORT_PARSE_FAILED'},()=>process.exit(0));}
});
