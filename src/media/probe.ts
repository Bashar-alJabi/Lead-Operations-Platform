import { spawn } from 'node:child_process';
import { MediaError } from './validation.js';

export type MediaStream = { codec: string; type: string };
export interface MediaProbe { inspect(bytes: Buffer): Promise<MediaStream[]> }

// Bytes only on stdin: uploaded filenames, URLs and nested network/file protocols never reach ffprobe.
export const ffprobeMediaProbe: MediaProbe = { async inspect(bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.MEDIA_PROBE_BINARY || 'ffprobe', [
      '-v','error','-protocol_whitelist','pipe','-format_whitelist','mov,mp3,ogg',
      '-probesize','1048576','-analyzeduration','2000000',
      '-show_entries','stream=codec_type,codec_name','-of','json','-i','pipe:0',
    ], { shell:false, windowsHide:true, stdio:['pipe','pipe','pipe'],
      // The probe has no use for database, encryption or provider credentials inherited by the API.
      env:{ PATH:process.env.PATH, ...(process.env.SystemRoot ? { SYSTEMROOT:process.env.SystemRoot } : {}),
        LANG:'C',AV_LOG_FORCE_NOCOLOR:'1' } });
    let stdout = Buffer.alloc(0); let diagnosticSize = 0; let settled = false;
    const finish = (error?:MediaError, streams?:MediaStream[]) => {
      if (settled) return; settled = true; clearTimeout(timeout);
      if (error) { child.kill(); reject(error); } else resolve(streams!);
    };
    const timeout = setTimeout(() => finish(new MediaError('MEDIA_PROBE_UNAVAILABLE',true)),10000);
    child.once('error',()=>finish(new MediaError('MEDIA_PROBE_UNAVAILABLE',true)));
    child.stdout.on('data',(chunk:Buffer)=> {
      if (stdout.length+chunk.length > 65536) finish(new MediaError('MEDIA_FORMAT_INVALID'));
      else stdout=Buffer.concat([stdout,chunk]);
    });
    child.stderr.on('data',(chunk:Buffer)=> {
      diagnosticSize+=chunk.length;
      if (diagnosticSize>65536) finish(new MediaError('MEDIA_FORMAT_INVALID'));
    });
    child.stdin.on('error',()=>{}); // Early probe rejection closes stdin; close/error determine the safe result.
    child.once('close',(code)=> {
      if (settled) return;
      if (code!==0) { finish(new MediaError('MEDIA_FORMAT_INVALID')); return; }
      try {
        const data=JSON.parse(stdout.toString('utf8')) as { streams?:unknown };
        if (!Array.isArray(data.streams) || !data.streams.length || data.streams.length>8) throw new Error();
        const streams=data.streams.map((value:unknown)=> {
          const stream=value as { codec_name?:unknown;codec_type?:unknown } | null;
          if (!stream || typeof stream.codec_name!=='string' || typeof stream.codec_type!=='string'
            || !/^[a-z0-9_]{1,40}$/.test(stream.codec_name) || !/^[a-z]{1,20}$/.test(stream.codec_type)) throw new Error();
          return { codec:stream.codec_name,type:stream.codec_type };
        });
        finish(undefined,streams);
      } catch { finish(new MediaError('MEDIA_FORMAT_INVALID')); }
    });
    child.stdin.end(bytes);
  });
} };
