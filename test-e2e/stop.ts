import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export default async function stopTestServer() {
  const fixture=JSON.parse(await readFile(resolve('.local/e2e/fixture.json'),'utf8')) as { testToken:string };
  const response=await fetch('http://127.0.0.1:4100/__test__/stop',{ method:'POST',
    headers:{ origin:'http://127.0.0.1:4100',authorization:'Bearer '+fixture.testToken },signal:AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Test server shutdown was rejected');
}
