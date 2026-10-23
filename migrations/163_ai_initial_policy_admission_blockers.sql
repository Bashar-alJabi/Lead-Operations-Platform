ALTER FUNCTION ai_initial_admission_blockers(jsonb) RENAME TO ai_initial_prerequisite_blockers;
CREATE FUNCTION ai_initial_admission_blockers(ctx jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT ai_initial_prerequisite_blockers(ctx)||CASE WHEN ctx->'initialMessage' IS NOT NULL AND ctx->'initialMessage'<>'null'
  AND (ctx->'initialMessage'->>'ready' IS DISTINCT FROM 'true' OR position(COALESCE(ctx->'effective'->'disclosure'->>'text','missing disclosure') IN COALESCE(ctx->'initialMessage'->>'body',''))=0)
 THEN '["AI_INITIAL_MESSAGE_REVIEW_REQUIRED"]'::jsonb ELSE '[]'::jsonb END
$$;
