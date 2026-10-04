import { MediaError } from './validation.js';

// Bounded RIFF metadata parsing, not image decoding. No filename/URL or native code execution.
export function webpMetadata(bytes:Buffer): { width:number;height:number;animated:boolean } {
  const invalid=()=> { throw new MediaError('MEDIA_FORMAT_INVALID'); };
  if (bytes.length<30 || bytes.toString('ascii',0,4)!=='RIFF' || bytes.toString('ascii',8,12)!=='WEBP'
    || bytes.readUInt32LE(4)+8!==bytes.length) return invalid();
  let offset=12; let width=0; let height=0; let animated=false; let image=false; let animationHeader=false; let frames=0;
  const seen=new Set<string>(); let chunks=0;
  while (offset<bytes.length) {
    if (++chunks>10000 || offset+8>bytes.length) return invalid();
    const kind=bytes.toString('ascii',offset,offset+4); const size=bytes.readUInt32LE(offset+4);
    const start=offset+8; const end=start+size; const next=end+(size%2);
    if (next>bytes.length || (size%2 && bytes[end]!==0)) return invalid();
    if (['VP8X','VP8 ','VP8L','ANIM'].includes(kind) && seen.has(kind)) return invalid();
    seen.add(kind);
    if (kind==='VP8X') {
      if (offset!==12 || size!==10) return invalid();
      animated=Boolean(bytes[start]!&2);
      width=bytes.readUIntLE(start+4,3)+1; height=bytes.readUIntLE(start+7,3)+1;
    } else if (kind==='VP8 ' || kind==='VP8L') {
      if (image || animated) return invalid(); image=true;
      let w:number; let h:number;
      if (kind==='VP8 ') {
        if (size<10 || (bytes[start]!&1)!==0 || bytes.toString('hex',start+3,start+6)!=='9d012a') return invalid();
        w=bytes.readUInt16LE(start+6)&0x3fff; h=bytes.readUInt16LE(start+8)&0x3fff;
      } else {
        if (size<5 || bytes[start]!==0x2f) return invalid();
        const bits=bytes.readUInt32LE(start+1); w=(bits&0x3fff)+1; h=((bits>>>14)&0x3fff)+1;
      }
      if (!w || !h || (width && (width!==w || height!==h))) return invalid();
      width=w; height=h;
    } else if (kind==='ANIM') {
      if (!animated || size!==6) return invalid(); animationHeader=true;
    } else if (kind==='ANMF') {
      if (!animated || !animationHeader || size<24) return invalid();
      const x=2*bytes.readUIntLE(start,3); const y=2*bytes.readUIntLE(start+3,3);
      if (x+bytes.readUIntLE(start+6,3)+1>width || y+bytes.readUIntLE(start+9,3)+1>height) return invalid();
      frames++;
    }
    offset=next;
  }
  if (!width || !height || (animated ? !animationHeader || !frames : !image)) return invalid();
  return { width,height,animated };
}
