import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateNotificationText,renderNotification,effectiveNotificationTemplate,requireNotificationBodyTypes,type NotificationTemplate} from '../src/notifications.js';
test('Notification wording accepts only bounded plain text and nonrecursive campaign/owner substitutions',()=>{
 for(const text of ['',' ','{{secret}}','{{campaign}','{owner}','bad\x00content'])assert.throws(()=>validateNotificationText(text,160));
 assert.throws(()=>validateNotificationText('x'.repeat(161),160));
 assert.equal(validateNotificationText('  Hello {{owner}}\n{{campaign}} <img>  ',160),'Hello {{owner}}\n{{campaign}} <img>');
 assert.equal(renderNotification('{{campaign}} / {{owner}}',{campaign:'$&{{owner}}',owner:'<script>literal</script>'}),'$&{{owner}} / <script>literal</script>');
 assert.equal(validateNotificationText('😀'.repeat(160),160),'😀'.repeat(160));
 for(const value of [null,[],{enabled:'true',version:0},{enabled:true,version:'0'},{enabled:true,version:2147483647}])assert.throws(()=>requireNotificationBodyTypes(value,'enabled'));
 assert.doesNotThrow(()=>requireNotificationBodyTypes({enabled:false,version:0},'enabled'));
});
test('Notification templates use current active campaign then branch then organization and same-language safe defaults',()=>{
 const templates:NotificationTemplate[]=[{scope:'GLOBAL',resource_id:'o',branch_id:null,title:'global',body:'g',active:true,version:2},{scope:'BRANCH',resource_id:'b',branch_id:'b',title:'branch',body:'b',active:true,version:3},{scope:'CAMPAIGN',resource_id:'c',branch_id:'b',title:'campaign',body:'c',active:true,version:4}];
 assert.equal(effectiveNotificationTemplate(templates,'o','b','c','en').source,'CAMPAIGN');templates[2]!.active=false;
 assert.equal(effectiveNotificationTemplate([{...templates[2]!,active:true,branch_id:'old'}],'o','b','c','en').source,'DEFAULT');
 assert.equal(effectiveNotificationTemplate(templates,'o','b','c','en').source,'BRANCH');templates[1]!.active=false;
 assert.equal(effectiveNotificationTemplate(templates,'o','b','c','en').source,'GLOBAL');templates[0]!.active=false;
 assert.equal(effectiveNotificationTemplate(templates,'o','b','c','fr').source,'DEFAULT');
 assert.match(effectiveNotificationTemplate(templates,'o','b','c','fr').title,/humain/);
 assert.equal(effectiveNotificationTemplate(templates,'foreign','other','hidden','ar').source,'DEFAULT');
 assert.match(effectiveNotificationTemplate(templates,'o','b','c','en','AI_HANDOFF_SLA_EXCEEDED').title,/target exceeded/);
 assert.match(effectiveNotificationTemplate([],'o','b','c','fr','AI_HANDOFF_SLA_EXCEEDED').title,/dépassé/);
 templates.push({scope:'BRANCH',resource_id:'b',branch_id:'b',title:'SLA only',body:'SLA body',version:1,active:true,event_type:'AI_HANDOFF_SLA_EXCEEDED'});
 assert.equal(effectiveNotificationTemplate(templates,'o','b','c','en','AI_HANDOFF_SLA_EXCEEDED').title,'SLA only');
 assert.notEqual(effectiveNotificationTemplate(templates,'o','b','c','en').title,'SLA only');
 for(const event of ['LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','FOLLOW_UP_DUE','PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED'] as const){
  assert.equal(effectiveNotificationTemplate(templates,'o','b','c','en',event).source,'DEFAULT');
  assert.notEqual(effectiveNotificationTemplate([],'o','b','c','fr',event).title,effectiveNotificationTemplate([],'o','b','c','en',event).title);
 }
});
