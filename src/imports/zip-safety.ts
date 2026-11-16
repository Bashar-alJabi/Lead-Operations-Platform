import {fromBuffer,type ZipFile,type Entry} from 'yauzl';
import {ImportParseError} from './types.js';
// Inspect every expanded byte, not just the attacker-controlled ZIP size declarations.
export function checkWorkbookZip(bytes:Buffer):Promise<void>{
 return new Promise((resolve,reject)=>{
  let zip:ZipFile|undefined,settled=false,total=0,entries=0;const names=new Set<string>();
  const fail=()=>{if(settled)return;settled=true;zip?.close();reject(new ImportParseError('IMPORT_ARCHIVE_REJECTED'));};
  fromBuffer(bytes,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},(error,z)=>{
   if(error||!z)return fail();zip=z;z.once('error',fail);
   z.once('end',()=>{if(settled)return;if(!names.has('[Content_Types].xml')||!names.has('xl/workbook.xml'))return fail();settled=true;resolve();});
   z.on('entry',(entry:Entry)=>{
    if(++entries>512||entry.uncompressedSize>16*1024*1024||entry.generalPurposeBitFlag&1||entry.fileName.startsWith('/')
     ||entry.fileName.split('/').some(p=>p==='..')||names.has(entry.fileName)||/vbaProject|embeddings\//i.test(entry.fileName))return fail();
    names.add(entry.fileName);if(entry.fileName.endsWith('/')){z.readEntry();return;}
    z.openReadStream(entry,(e,stream)=>{
     if(e||!stream)return fail();stream.once('error',fail);
     stream.on('data',(chunk:Buffer)=>{total+=chunk.length;if(total>32*1024*1024){stream.destroy();fail();}});
     stream.once('end',()=>{if(!settled)z.readEntry();});stream.resume();
    });
   });z.readEntry();
  });
 });
}
