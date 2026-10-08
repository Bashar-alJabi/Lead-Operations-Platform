import { createHash } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { MediaError,validateMedia } from '../media/validation.js';

export const knowledgeAssetTypes=['text/plain','application/pdf','image/png','image/jpeg'] as const;
export function knowledgeAssetMaxBytes() {
  const size=Number(process.env.KNOWLEDGE_ASSET_MAX_BYTES ?? 10*1024*1024);
  if(!Number.isSafeInteger(size) || size<1024 || size>25*1024*1024)throw new MediaError('KNOWLEDGE_ASSET_LIMIT_INVALID');return size;
}
export async function validateKnowledgeAsset(bytes:Buffer,mime:string):Promise<string|null> {
  if(bytes.length<1 || bytes.length>knowledgeAssetMaxBytes())throw new MediaError('KNOWLEDGE_ASSET_SIZE_INVALID');
  if(mime==='text/plain') {
    if(bytes.length>32768)throw new MediaError('KNOWLEDGE_TEXT_SIZE_INVALID');
    const text=bytes.toString('utf8');
    if(!Buffer.from(text,'utf8').equals(bytes) || !text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
      || await fileTypeFromBuffer(bytes).catch(()=>undefined))throw new MediaError('KNOWLEDGE_TEXT_INVALID');
    return text;
  }
  if(!knowledgeAssetTypes.includes(mime as typeof knowledgeAssetTypes[number]))throw new MediaError('KNOWLEDGE_ASSET_TYPE_UNSUPPORTED');
  await validateMedia(bytes,mime==='application/pdf' ? 'document' : 'image',mime,createHash('sha256').update(bytes).digest('hex'));
  // Binary assets are approved references, never invented OCR or extracted business facts.
  return null;
}
