-- Customer snapshots carry the configured list inside toolPolicy; approvedTools remains diagnostic [].
CREATE OR REPLACE FUNCTION ai_qualification_admissible(ctx jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(ctx IS NOT NULL AND ctx->'conversation'->>'controller'='AI'
   AND ctx->'conversation'->>'state' IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD')
   AND ctx->'conversation'->'attentionReason'='null'::jsonb
   AND ctx->'toolPolicy'->'allowedTools' ? 'updateQualificationField' AND ctx->'qualification' IS NOT NULL
   AND jsonb_array_length(ctx->'questions')>0,false)
$$;
