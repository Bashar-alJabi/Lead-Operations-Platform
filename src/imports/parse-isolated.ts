import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ImportParseError,importMaxBytes,type ImportFormat,type ParsedImport} from './types.js';

// A memory/CPU failure kills this child, never the HTTP server/worker. No shell or inherited secrets.
export async function parseImportIsolated(bytes:Buffer,format:ImportFormat,delimiter:','|';'|'\t',timeoutMs=15000):Promise<ParsedImport>{
 if(!bytes.length||bytes.length>importMaxBytes)throw new ImportParseError('IMPORT_FILE_SIZE');
 return new Promise((resolve,reject)=>{
  const child=fork(fileURLToPath(new URL('./parse-child.js',import.meta.url)),[],{execArgv:['--max-old-space-size=128','--permission',
   '--allow-fs-read='+fileURLToPath(new URL('./',import.meta.url)),
   '--allow-fs-read='+fileURLToPath(new URL('../../../node_modules/',import.meta.url)),
   '--allow-fs-read='+fileURLToPath(new URL('../../../package.json',import.meta.url))],windowsHide:true,
   env:{...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})},stdio:['ignore','ignore','ignore','ipc']});
  let settled=false;const finish=(error:string|null,result?:ParsedImport)=>{if(settled)return;settled=true;clearTimeout(timer);child.kill();if(error)reject(new ImportParseError(error));else resolve(result!);};
  const timer=setTimeout(()=>finish('IMPORT_PARSE_RESOURCE_LIMIT'),timeoutMs);
  child.once('error',()=>finish('IMPORT_PARSER_UNAVAILABLE'));child.once('exit',()=>finish('IMPORT_PARSE_RESOURCE_LIMIT'));
  child.once('message',(m:{result?:ParsedImport;error?:string})=>{
   if(m.error)finish(/^IMPORT_[A-Z_]+$/.test(m.error)?m.error:'IMPORT_PARSE_FAILED');
   else if(m.result&&Array.isArray(m.result.sheets)&&m.result.rowCount<=10000)finish(null,m.result);else finish('IMPORT_PARSE_FAILED');
  });
  child.send({bytes:bytes.toString('base64'),format,delimiter},e=>{if(e)finish('IMPORT_PARSER_UNAVAILABLE');});
 });
}
