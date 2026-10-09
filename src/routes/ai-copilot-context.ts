import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError,principalFromRequest } from '../security.js';
import { currentPaymentSession } from '../payments/access.js';
import { trustedCopilotSnapshot } from '../ai/copilot-context.js';
const uuid={ type:'string',format:'uuid' } as const;
export function registerAICopilotContextRoutes(app:FastifyInstance,db:Database,testTransport=false) {
  app.get<{ Params:{ id:string } }>('/api/conversations/:id/ai-summary-context',{ schema:{ params:{ type:'object',additionalProperties:false,required:['id'],properties:{ id:uuid } } } },async(request)=>{
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=>{
      const sessionId=await currentPaymentSession(tx,actor,request);if(!sessionId)throw new HttpError(403,'AI_COPILOT_ACCESS_REVOKED');
      const snapshot=await trustedCopilotSnapshot(tx,actor,request.params.id,sessionId);
      // An approved local read boundary, not model execution. Configuration and credentials remain server-side.
      return { tool:'getConversationSummaryContext',scope:{ leadId:snapshot.lead.id,conversationId:request.params.id },source:snapshot.context.summaryContext,
        hash:snapshot.hash,readOnly:true,providerInvoked:false,sendAllowed:false,mutationsAllowed:false,executionAvailable:testTransport,executionBlocker:testTransport ? null : 'AI_LIVE_DATA_TRANSFER_DISABLED' };
    });
  });
}
