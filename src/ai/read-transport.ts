import type { Database } from '../db.js';
import type { AIInferenceRegistry } from './inference-provider.js';
// There is deliberately no environment/configuration switch enabling live customer-data inference.
// Explicit test injection is accepted only against the isolated synthetic database, outside production.
export async function assertAIReadTestTransport(db:Database,adapters?:AIInferenceRegistry):Promise<boolean> {
  if(!adapters)return false;
  if(process.env.NODE_ENV==='production' || (await db`SELECT current_database() AS name`)[0]?.name!=='lead_operations_test')throw new Error('AI_TEST_TRANSPORT_REQUIRES_ISOLATED_DATABASE');
  return true;
}
