export function safeRequestUrl(url:string|undefined):string|undefined {
  // Webhook verification and OAuth URLs may carry credentials. Never log any query string.
  return url?.split('?')[0];
}
