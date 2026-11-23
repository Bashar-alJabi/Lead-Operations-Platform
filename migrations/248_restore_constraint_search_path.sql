-- pg_restore loads rows with an empty search_path. These CHECK functions call
-- application validators in public, so their own lookup must use that schema.
ALTER FUNCTION public.ai_knowledge_content_valid(jsonb) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.ai_tool_policy_valid(jsonb) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.ai_handoff_clock_valid(jsonb) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.valid_payment_dispatch_policy(jsonb) SET search_path TO pg_catalog, public, pg_temp;
