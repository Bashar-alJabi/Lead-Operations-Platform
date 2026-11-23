CREATE OR REPLACE FUNCTION automation_classification_field_available(fid uuid,oid uuid,bid uuid,cid uuid,manager boolean)
 RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT cid IS NOT NULL AND automation_field_trigger_available(fid,oid,bid,cid,manager)
  AND EXISTS(SELECT 1 FROM field_definition f JOIN campaign_field scope ON scope.field_id=f.id AND scope.campaign_id=cid
   CROSS JOIN LATERAL jsonb_array_elements(f.options) opt
   WHERE f.id=fid AND f.field_type='TAGS' AND scope.usable_by_ai AND opt->>'active'='true')
$$;
