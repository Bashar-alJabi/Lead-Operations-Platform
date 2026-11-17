import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

// Only the external SDK is substituted. Document/CSP, bootstrap, sessions,
// committed metadata admission, scoped reads and mutations use the real app.
const syntheticSDK=`(()=>{
 const picker={Action:{PICKED:'picked',CANCEL:'cancel'},ViewId:{SPREADSHEETS:'sheets'},DocsViewMode:{LIST:'list'}};
 picker.DocsView=class {constructor(id){if(id!=='sheets')throw Error('Unexpected view');}setMode(v){if(v!=='list')throw Error('Unexpected mode');return this;}setMimeTypes(v){if(v!=='application/vnd.google-apps.spreadsheet')throw Error('Unexpected MIME');return this;}};
 picker.PickerBuilder=class {
  addView(){return this;}setOAuthToken(v){if(!v.startsWith('BrowserGoogleAccess_'))throw Error('Unexpected access');return this;}
  setDeveloperKey(v){if(v!=='BrowserSyntheticSelectionKey_123')throw Error('Unexpected key');return this;}
  setAppId(v){if(v!=='123456789012')throw Error('Unexpected app');return this;}
  setOrigin(v){if(v!==window.location.origin)throw Error('Unexpected origin');return this;}setLocale(v){document.documentElement.dataset.sdkLocale=v;return this;}
  setCallback(v){this.callback=v;return this;}build(){const callback=this.callback;return {setVisible(v){if(!v)throw Error('Unexpected visibility');const b=document.createElement('button');b.textContent='Choose synthetic file';b.addEventListener('click',()=>callback({action:'picked',docs:[{id:'BrowserSyntheticSpreadsheet_123',name:'FORGED_SDK_TITLE',url:'https://untrusted.example.test/forged'}]}));document.body.appendChild(b);}};}
 };
 window.google={picker};window.gapi={load(name,options){if(name!=='picker')throw Error('Unexpected module');options.callback();}};
})();`;

test('Google Picker uses a session-bound popup and independent metadata, survives lost admission ACK across locale, retries only readonly failure, pages sheets and preserves safe scoped history',async({page,context})=>{
 const fixture=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string;testToken:string},origin='http://127.0.0.1:4100';
 const rate={'x-e2e-rate-scope':randomUUID()};await context.setExtraHTTPHeaders(rate);
 const errors:string[]=[],external:string[]=[];
 context.on('page',p=>{p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error'&&/unique.*key|same key/i.test(m.text()))errors.push(m.text());});});
 page.on('pageerror',e=>errors.push(e.message));
 context.on('request',r=>{if(new URL(r.url()).origin!==origin)external.push(r.url());});
 await context.route('https://apis.google.com/js/api.js',route=>route.fulfill({status:200,contentType:'application/javascript',body:syntheticSDK}));
 const control=async(metadataFailure=false)=>{const r=await page.request.post('/__test__/google',{headers:{origin,authorization:'Bearer '+fixture.testToken},data:{mode:'GOOD',metadataFailure}});expect(r.status()).toBe(200);return r.json();};
 const before=await control();
 await page.goto('/');await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('en');await page.getByLabel('Email',{exact:true}).fill('manager@browser.test');await page.getByLabel('Password',{exact:true}).fill(fixture.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
 const actor=await (await page.request.get('/api/auth/me')).json();
 const created=await page.request.post('/api/google/connections',{headers:{origin},data:{name:'Browser metadata selection',branchId:actor.branchId,clientId:'123-selection-browser.apps.googleusercontent.com',clientSecret:'BrowserGoogleSynthetic_Selection',reason:'Synthetic Picker journey'}});expect(created.status()).toBe(201);const id=(await created.json()).id,root='/api/google/connections/'+id;
 expect((await page.request.put(root+'/picker',{headers:{origin},data:{version:0,connectionVersion:1,projectNumber:'123456789012',apiKey:'BrowserSyntheticSelectionKey_123',reason:'Synthetic SDK configuration'}})).status()).toBe(200);
 const auth=await page.request.post(root+'/authorize',{headers:{origin},data:{version:1}});expect(auth.status()).toBe(200);const state=new URL((await auth.json()).url).searchParams.get('state')!;
 expect((await page.request.get('/api/google/callback?'+new URLSearchParams({state,code:'BrowserSyntheticSelectionCode'}),{maxRedirects:0})).status()).toBe(302);
 await page.goto('/?google='+id);const workspace=page.locator('[data-google-picker-workspace]');await expect(workspace).toContainText('No verified resources');
 let lost=true;const intents:unknown[]=[];await page.route('**'+root+'/picker/tickets',async route=>{intents.push(route.request().postDataJSON());if(lost){lost=false;const actual=await route.fetch();expect(actual.status()).toBe(200);await route.abort('failed');}else await route.continue();});
 await workspace.getByRole('button',{name:'Prepare Google file selection',exact:true}).click();await expect(workspace.getByRole('button',{name:'Retry the same selection request',exact:true})).toBeVisible();
 await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('fr');await workspace.getByRole('button',{name:'Renvoyer la même demande',exact:true}).click();await expect(workspace.locator('[data-google-picker-ticket]')).toContainText('Sélection attendue');expect(intents).toHaveLength(2);expect(intents[1]).toEqual(intents[0]);await page.unroute('**'+root+'/picker/tickets');
 await control(true);const popupEvent=page.waitForEvent('popup');await workspace.getByRole('link',{name:'Ouvrir Google Picker',exact:true}).click();const popup=await popupEvent;
 await expect(popup.getByRole('button',{name:'Choose synthetic file',exact:true})).toBeVisible();await expect(popup.locator('html')).toHaveAttribute('data-sdk-locale','en');
 const html=await popup.content();for(const secret of ['BrowserGoogleAccess_','BrowserGoogleSynthetic_Selection','BrowserSyntheticSelectionKey_123','BrowserGoogleRefresh_'])expect(html).not.toContain(secret);
 expect(popup.url()).toMatch(/\/api\/google\/picker\/tickets\/[0-9a-f-]+\/open$/);const ticketId=new URL(popup.url()).pathname.split('/')[5],tr='/api/google/picker/tickets/'+ticketId;
 await popup.getByRole('button',{name:'Choose synthetic file',exact:true}).click();await expect(popup.getByRole('alert')).toContainText('GOOGLE_PROVIDER_UNAVAILABLE');
 await workspace.getByRole('button',{name:'Actualiser la sélection Google',exact:true}).click();await expect(workspace.locator('[data-google-picker-ticket]')).toContainText('Échec de vérification');await control(false);
 await workspace.getByRole('button',{name:'Revérifier les métadonnées du fichier',exact:true}).click();await expect(workspace.locator('[data-google-picker-ticket]')).toContainText('Métadonnées vérifiées enregistrées');await popup.close();
 await expect(workspace).toContainText('Trusted spreadsheet <img src=x onerror=alert(1)>');expect(await workspace.locator('img').count()).toBe(0);await expect(workspace).not.toContainText('FORGED_SDK_TITLE');
 const status=await (await page.request.get(tr)).json();expect(status.state).toBe('VERIFIED');const calls=(await control()).googleMetadataCalls;expect(calls-before.googleMetadataCalls).toBe(2);
 expect((await page.request.post(tr+'/selection',{headers:{origin},data:{spreadsheetId:'BrowserSyntheticSpreadsheet_123'}})).status()).toBe(200);expect((await control()).googleMetadataCalls).toBe(calls);
 await workspace.getByRole('button',{name:'Voir les feuilles et l’historique',exact:true}).click();const resource=workspace.locator('[data-google-resource]');await expect(resource).toContainText('Trusted worksheet 0');await expect(resource).not.toContainText('Trusted worksheet 26');await resource.getByRole('button',{name:'Autres feuilles Google',exact:true}).click();await expect(resource).toContainText('Trusted worksheet 26');await expect(resource).toContainText('OBJECT');
 const rr='/api/google/resources/'+status.resourceId,detail=await (await page.request.get(rr)).json();expect(detail.metadata.sheets).toBeUndefined();expect(detail.sheet_count).toBe(27);expect(JSON.stringify(detail)).not.toContain('UNREQUESTED_SYNTHETIC_CELL');
 const reason='Disable metadata <svg onload=alert(1)>';await resource.getByLabel('Motif de désactivation de la ressource Google',{exact:true}).fill(reason);await resource.getByRole('button',{name:'Désactiver la ressource Google',exact:true}).click();await expect(resource).toHaveCount(0);await workspace.getByRole('button',{name:'Voir les feuilles et l’historique',exact:true}).click();await expect(resource.locator('[data-google-resource-history]')).toContainText(reason);expect(await resource.locator('svg').count()).toBe(0);
 await page.setViewportSize({width:390,height:844});await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('ar');await expect(page.locator('html')).toHaveAttribute('dir','rtl');await resource.scrollIntoViewIfNeeded();await page.screenshot({path:'.local/e2e/google-selection-ar.png'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
 await page.route('**'+root+'/resources?**',route=>route.abort('failed'));await workspace.getByRole('button',{name:'تحديث ملفات Google',exact:true}).click();await expect(workspace.getByRole('alert')).toBeVisible();await expect(resource).toHaveCount(0);await expect(workspace).not.toContainText('Trusted spreadsheet');await page.unroute('**'+root+'/resources?**');await workspace.getByRole('button',{name:'تحديث ملفات Google',exact:true}).click();await expect(workspace.getByRole('alert')).toHaveCount(0);await expect(workspace).toContainText('Trusted spreadsheet');
 expect(external).toEqual(['https://apis.google.com/js/api.js']);expect(errors).toEqual([]);
});
