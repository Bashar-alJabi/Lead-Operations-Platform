import type postgres from 'postgres';
import {calculateLeadFieldsBatch} from './calculated-fields.js';
import type {CalculationKind} from './fields.js';
import type {Principal} from './security.js';

// Called in the same snapshot as the authorized, campaign-filtered Lead page.
export async function readCampaignTableFields(tx:postgres.TransactionSql,actor:Principal,campaignId:string,leadIds:string[]){
  const rows=await tx`SELECT fd.id,fd.label,fd.field_type,fd.calculation->>'kind' AS calculation
    FROM campaign_field cf JOIN campaign c ON c.id=cf.campaign_id JOIN field_definition fd ON fd.id=cf.field_id
    WHERE c.id=${campaignId} AND c.organization_id=${actor.organizationId} AND fd.organization_id=c.organization_id
      AND (fd.branch_id IS NULL OR fd.branch_id=c.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=c.id)
      AND fd.active AND cf.active AND cf.show_in_table AND (${actor.role==='SUPER_ADMIN'} OR c.branch_id=${actor.branchId}
       AND (${actor.role==='MANAGER'} AND cf.visible_to_manager OR ${actor.role==='AGENT'} AND cf.visible_to_agent
        AND EXISTS(SELECT 1 FROM lead l WHERE l.campaign_id=c.id AND l.branch_id=c.branch_id AND l.assigned_agent_id=${actor.id})))
    ORDER BY cf.position,fd.key,fd.id LIMIT 12`;
  const fields=rows.map(({id,label,field_type})=>({id,label,fieldType:field_type}));
  const values=new Map(leadIds.map(id=>[id,Object.create(null) as Record<string,unknown>]));
  if(!leadIds.length || !rows.length) return {fields,values};

  const stored=rows.filter(row=>row.field_type!=='CALCULATED').map(row=>row.id as string);
  if(stored.length){
    const cells=await tx`SELECT lead_id,field_id,CASE WHEN jsonb_typeof(value)='string' AND length(value#>>'{}')>240
      THEN to_jsonb(left(value#>>'{}',240)||'…') ELSE value END AS value
      FROM lead_field_value WHERE lead_id IN ${tx(leadIds)} AND field_id IN ${tx(stored)}`;
    for(const cell of cells) values.get(cell.lead_id)![cell.field_id]=cell.value;
  }
  const calculated=rows.filter(row=>row.field_type==='CALCULATED'&&row.calculation);
  const facts=await calculateLeadFieldsBatch(tx,leadIds,[...new Set(calculated.map(row=>row.calculation as CalculationKind))]);
  for(const [id,record] of values) for(const field of calculated) record[field.id]=facts[id]?.[field.calculation]??null;
  return {fields,values};
}
