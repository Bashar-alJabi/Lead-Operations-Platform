import type { Database } from '../db.js';
import { sourceBindingIssues } from './bindings.js';

// Bounded metadata only. Never return credentials, customer values or hidden field identifiers.
export async function sourceBindingRows(db:Database,campaignId:string|null,after:string|null,limit:number,bindingId:string|null=null,connectionId:string|null=null) {
  return db`SELECT b.id,b.connection_id,b.resource_id,b.campaign_id,b.external_campaign_id,b.external_adset_id,b.external_ad_id,
    b.active,b.connection_version,b.version,b.created_at,b.updated_at,f.external_id AS form_external_id,f.name AS form_name,
    p.external_id AS page_external_id,p.name AS page_name,c.name AS connection_name,c.status AS connection_status,c.version AS current_connection_version,
    ca.source_kind,ca.status AS campaign_status,br.active AS branch_active,
    COALESCE((ca.messaging_config->>'enabled')::boolean,false) AS messaging_enabled,COALESCE((ca.ai_config->>'enabled')::boolean,false) AS ai_enabled,
    f.active AS form_active,f.connection_version AS form_connection_version,p.active AS page_active,p.connection_version AS page_connection_version,
    (c.branch_id=ca.branch_id OR (c.branch_id IS NULL AND EXISTS (SELECT 1 FROM source_resource_access a WHERE a.resource_id=f.id AND a.branch_id=ca.branch_id AND a.active))) AS has_access,
    EXISTS (SELECT 1 FROM connection_secret WHERE connection_id=c.id) AS connection_credential_available,
    EXISTS (SELECT 1 FROM source_resource_secret WHERE resource_id=p.id) AS page_credential_available,
    c.capabilities->>'sourceHandshakeVerified'='true' AS handshake_verified,c.config->>'appId' IS NOT NULL AS app_id_configured,
    subscription.state='SUCCEEDED' AND subscription.subscribed AND subscription.connection_version=c.version AND subscription.page_version=p.version AS subscription_verified,
    m.version IS NOT NULL AND m.connection_version=c.version AND m.questions=f.questions
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.target_snapshot) target
        LEFT JOIN field_definition fd ON fd.id=(target->>'id')::uuid
        LEFT JOIN campaign_field cf ON cf.field_id=fd.id AND cf.campaign_id=b.campaign_id
        WHERE fd.id IS NULL OR cf.field_id IS NULL OR NOT fd.active OR NOT cf.active OR fd.organization_id<>c.organization_id
          OR (fd.branch_id IS NOT NULL AND fd.branch_id<>ca.branch_id) OR (fd.campaign_id IS NOT NULL AND fd.campaign_id<>b.campaign_id)
          OR fd.value_mode NOT IN ('SOURCE','MANUAL') OR fd.field_type='CALCULATED'
          OR fd.version<>(target->>'version')::integer OR cf.version<>(target->>'binding_version')::integer
          OR fd.field_type<>target->>'field_type' OR fd.value_mode<>target->>'value_mode'
          OR fd.options IS DISTINCT FROM target->'options' OR fd.validation IS DISTINCT FROM target->'validation' OR cf.required_stage<>target->>'required_stage')
      AND NOT EXISTS (SELECT 1 FROM campaign_field required JOIN field_definition fd ON fd.id=required.field_id
        WHERE required.campaign_id=b.campaign_id AND required.active AND fd.active AND required.required_stage='LEAD_CREATION'
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.entries) entry WHERE entry->>'kind'='LEAD_FIELD' AND entry->>'fieldId'=fd.id::text)) AS mapping_configured
    FROM source_campaign_binding b JOIN source_resource f ON f.id=b.resource_id JOIN source_resource p ON p.id=f.parent_id
    JOIN integration_connection c ON c.id=b.connection_id JOIN campaign ca ON ca.id=b.campaign_id JOIN branch br ON br.id=ca.branch_id
    LEFT JOIN LATERAL (SELECT state,subscribed,connection_version,page_version FROM source_subscription_attempt
      WHERE connection_id=c.id AND page_id=p.id ORDER BY started_at DESC,id DESC LIMIT 1) subscription ON true
    LEFT JOIN LATERAL (SELECT version,connection_version,questions,entries,target_snapshot FROM source_mapping_revision
      WHERE binding_id=b.id AND status='PUBLISHED' ORDER BY version DESC LIMIT 1) m ON true
    WHERE (${campaignId}::uuid IS NULL OR b.campaign_id=${campaignId}::uuid) AND (${connectionId}::uuid IS NULL OR b.connection_id=${connectionId}::uuid)
      AND (${bindingId}::uuid IS NULL OR b.id=${bindingId}::uuid)
      AND (${after}::uuid IS NULL OR b.id>${after}::uuid) ORDER BY b.id LIMIT ${limit}`;
}
export async function sourceCampaignIssues(db:Database,campaign:Record<string,any>,lock=false):Promise<string[]> {
  if (campaign.source_kind!=='META') return campaign.source_kind==='MANUAL' ? [] : ['SOURCE_BINDING_NOT_READY'];
  if (lock) await db`SELECT fd.id FROM field_definition fd JOIN campaign_field cf ON cf.field_id=fd.id WHERE cf.campaign_id=${campaign.id} FOR SHARE OF fd,cf`;
  let after:string|null=null;let active=false;const issues=new Set<string>();
  do {
    const rows=await sourceBindingRows(db,campaign.id,after,100);
    for (const row of rows) if (row.active) {
      active=true;for (const issue of sourceBindingIssues({ ...row,source_kind:campaign.source_kind,branch_active:campaign.branch_active })) issues.add(issue);
    }
    after=rows.length===100 ? rows.at(-1)!.id as string : null;
  } while (after);
  if (!active) issues.add('SOURCE_BINDING_NOT_READY');return [...issues];
}
export async function sourceConnectionRuntime(db:Database,connectionId:string) {
  let after:string|null=null;let ready=false;
  do {
    const rows=await sourceBindingRows(db,null,after,100,null,connectionId);
    ready=rows.some((r)=>r.active && r.campaign_status==='ACTIVE' && !r.messaging_enabled && !r.ai_enabled && sourceBindingIssues(r).length===0);
    after=!ready && rows.length===100 ? rows.at(-1)!.id as string : null;
  } while (after);
  return { processingAvailable:true,intakeReady:ready,processingStatus:ready ? 'SOURCE_INTAKE_READY' : 'SOURCE_SETUP_REVIEW_REQUIRED' };
}
