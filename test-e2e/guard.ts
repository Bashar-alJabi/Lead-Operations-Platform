export function requireLocalE2ETarget(url:string | undefined,acknowledgement:string | undefined,nodeEnv:string | undefined):string {
  let parsed:URL | null=null;
  try { if (url) parsed=new URL(url); } catch { /* Never include a connection string in diagnostics. */ }
  if (!parsed || !['postgres:','postgresql:'].includes(parsed.protocol)
    || !['localhost','127.0.0.1','[::1]'].includes(parsed.hostname) || parsed.pathname !== '/lead_operations_test'
    || acknowledgement !== '1' || nodeEnv === 'production')
    throw new Error('E2E requires local lead_operations_test and E2E_RESET_TEST_DATABASE=1, outside production');
  return url!;
}
