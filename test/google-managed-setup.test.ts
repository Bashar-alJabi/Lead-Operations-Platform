import test from 'node:test';
import assert from 'node:assert/strict';
import {googleSetup} from '../src/google/connections.js';
test('Google callback and return URLs derive only from the configured application origin, with HTTPS or explicit development loopback and no credential/query/path redirects',()=>{
 const previous=process.env.APP_ORIGIN;
 try{
  for(const value of ['','not-a-url','http://external.example','https://user:secret@example.test','https://example.test/other','https://example.test/?next=https://evil.test','https://example.test/#secret','ftp://example.test']){
   process.env.APP_ORIGIN=value;assert.throws(()=>googleSetup(),/GOOGLE_PLATFORM_URL_REQUIRED/);
  }
  process.env.APP_ORIGIN='https://platform.example.test';assert.deepEqual(googleSetup(),{redirectUri:'https://platform.example.test/api/google/callback',returnUrl:'https://platform.example.test/',allowLoopbackHttp:false});
  for(const origin of ['http://127.0.0.1:5173','http://localhost:5173','http://[::1]:5173']){process.env.APP_ORIGIN=origin;assert.equal(googleSetup().redirectUri,origin+'/api/google/callback');assert.equal(googleSetup().allowLoopbackHttp,true);}
 }finally{if(previous===undefined)delete process.env.APP_ORIGIN;else process.env.APP_ORIGIN=previous;}
});
