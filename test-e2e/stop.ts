import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { request } from 'node:http';
export default async function stopTestServer() {
  const fixture=JSON.parse(await readFile(resolve('.local/e2e/fixture.json'),'utf8')) as { testToken:string };
  // Playwright exits its CLI explicitly. Avoid Undici's Windows async-handle teardown race after global fetch.
  await new Promise<void>((resolve,reject)=> {
    const req=request('http://127.0.0.1:4100/__test__/stop',{ method:'POST',agent:false,
      headers:{ origin:'http://127.0.0.1:4100',authorization:'Bearer '+fixture.testToken,connection:'close' } },(res)=> {
      res.resume();res.once('error',()=>reject(new Error('Test server shutdown failed')));
      res.once('close',()=>res.statusCode===200 ? resolve() : reject(new Error('Test server shutdown was rejected')));
    });
    req.setTimeout(5000,()=>req.destroy(new Error('Test server shutdown timed out')));
    req.once('error',()=>reject(new Error('Test server shutdown failed')));req.end();
  });
}
