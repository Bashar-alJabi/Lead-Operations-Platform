import { createConnection } from 'node:net';
import { MediaError } from './validation.js';

export interface MediaScanner { scan(bytes: Buffer): Promise<{ clean: boolean; version: string }> }
export function clamAvScanner(host: string, port: number): MediaScanner {
  async function command(name: string, bytes?: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host, port });
      let response = ''; let settled = false;
      const finish = (value?: string) => {
        if (settled) return; settled = true; socket.destroy();
        if (value) resolve(value); else reject(new MediaError('MEDIA_SCANNER_UNAVAILABLE', true));
      };
      const deadline = setTimeout(() => finish(), 45000);
      socket.once('close', () => { clearTimeout(deadline); finish(); });
      socket.on('error', () => finish());
      socket.on('data', (data) => {
        response += data.toString('utf8');
        if (response.length > 2048) return finish();
        const end = response.indexOf('\0'); if (end >= 0) finish(response.slice(0, end));
      });
      socket.once('connect', () => {
        socket.write(`z${name}\0`);
        if (bytes) {
          // Bounded chunks use the clamd INSTREAM protocol, never an untrusted path.
          for (let offset = 0; offset < bytes.length; offset += 65536) {
            const chunk = bytes.subarray(offset, offset + 65536); const length = Buffer.alloc(4);
            length.writeUInt32BE(chunk.length); socket.write(length); socket.write(chunk);
          }
          socket.write(Buffer.alloc(4));
        }
      });
    });
  }
  return { async scan(bytes) {
    const version = await command('VERSION');
    const date = Date.parse(version.slice(version.lastIndexOf('/') + 1));
    if (!version.startsWith('ClamAV ') || !Number.isFinite(date) || date > Date.now() + 86400000
      || Date.now() - date > 7 * 86400000) throw new MediaError('MEDIA_SCANNER_DEFINITIONS_STALE', true);
    const result = await command('INSTREAM', bytes);
    if (result === 'stream: OK') return { clean: true, version };
    if (/^stream: .+ FOUND$/.test(result)) return { clean: false, version };
    throw new MediaError('MEDIA_SCANNER_UNAVAILABLE', true);
  } };
}
export function configuredMediaScanner(): MediaScanner {
  const host = process.env.CLAMAV_HOST; const port = Number(process.env.CLAMAV_PORT ?? 3310);
  if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new MediaError('MEDIA_SCANNER_NOT_CONFIGURED', true);
  return clamAvScanner(host, port);
}
