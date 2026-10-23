-- Approval keeps raw catalog metadata; execution compares the same supported projection as parseTextTemplate.
CREATE FUNCTION ai_initial_safe_components(parts jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(jsonb_agg(CASE WHEN p->>'type'='BUTTONS' THEN jsonb_build_object('type','BUTTONS','buttons',
   (SELECT jsonb_agg(jsonb_build_object('type',btn->'type','text',btn->'text')||CASE btn->>'type' WHEN 'URL' THEN jsonb_build_object('url',btn->'url') WHEN 'PHONE_NUMBER' THEN jsonb_build_object('phone_number',btn->'phone_number') ELSE '{}' END ORDER BY bn)
    FROM jsonb_array_elements(p->'buttons') WITH ORDINALITY bs(btn,bn)))
  WHEN p->>'type'='HEADER' THEN jsonb_build_object('type','HEADER','format',p->'format')||CASE WHEN p->>'format'='TEXT' THEN jsonb_build_object('text',p->'text') ELSE '{}' END
  ELSE jsonb_build_object('type',p->'type','text',p->'text') END ORDER BY CASE p->>'type' WHEN 'HEADER' THEN 1 WHEN 'BODY' THEN 2 WHEN 'FOOTER' THEN 3 ELSE 4 END),'[]')
 FROM jsonb_array_elements(parts) WITH ORDINALITY ps(p,n)
$$;
ALTER FUNCTION ai_initial_template_snapshot(jsonb) RENAME TO ai_initial_raw_template_snapshot;
CREATE FUNCTION ai_initial_template_snapshot(ctx jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_set(ai_initial_raw_template_snapshot(ctx),'{components}',ai_initial_safe_components(ctx->'initialMessage'->'approval'->'template'->'components'))
$$;
