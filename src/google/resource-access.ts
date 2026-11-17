import type postgres from 'postgres';
import type {FastifyRequest} from 'fastify';
import {HttpError,requireRole,type Principal} from '../security.js';
import {googleConnection,googleSession} from './connections.js';

export async function managedGoogleSharing(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest,id:string,write=false){
 requireRole(actor,'SUPER_ADMIN');
 const found=(await tx`SELECT connection_id FROM google_resource WHERE id=${id}`)[0];if(!found)throw new HttpError(404,'GOOGLE_RESOURCE_NOT_FOUND');
 const c=await googleConnection(tx,actor,found.connection_id,write),session=await googleSession(tx,actor,request);
 if(c.branch_id!==null)throw new HttpError(404,'GOOGLE_SHARED_RESOURCE_NOT_FOUND');
 const r=(await tx`SELECT id,version,active,connection_version FROM google_resource WHERE id=${id} FOR SHARE`)[0]!;
 return {c,r,session};
}
export async function googleOperationalCampaign(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest,id:string){
 const session=await googleSession(tx,actor,request);
 const c=(await tx`SELECT ca.id,ca.branch_id FROM campaign ca JOIN branch b ON b.id=ca.branch_id
  WHERE ca.id=${id} AND ca.organization_id=${actor.organizationId} AND b.organization_id=${actor.organizationId} AND b.active
  AND (${actor.role==='SUPER_ADMIN'} OR ca.branch_id=${actor.branchId}) FOR SHARE OF ca,b`)[0];
 if(!c)throw new HttpError(404,'GOOGLE_CAMPAIGN_NOT_FOUND');return {id:c.id as string,branch_id:c.branch_id as string,session};
}
export async function googleOperationalResource(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest,campaignId:string,resourceId:string){
 requireRole(actor,'SUPER_ADMIN','MANAGER');
 // Sharing mutations lock the Connection first too; they cannot revoke halfway through this bounded read.
 const found=(await tx`SELECT connection_id FROM google_resource WHERE id=${resourceId} AND organization_id=${actor.organizationId}`)[0];
 if(!found)throw new HttpError(404,'GOOGLE_RESOURCE_UNAVAILABLE');await tx`SELECT id FROM integration_connection WHERE id=${found.connection_id} FOR SHARE`;
 const campaign=await googleOperationalCampaign(tx,actor,request,campaignId);
 const r=(await tx`SELECT r.id,r.connection_id,r.spreadsheet_id,r.version,r.connection_version FROM google_resource r
  WHERE r.id=${resourceId} AND google_resource_available(r.id,${actor.organizationId},${campaign.branch_id}) FOR SHARE OF r`)[0];
 if(!r)throw new HttpError(404,'GOOGLE_RESOURCE_UNAVAILABLE');return {campaign,resource:r};
}
