CREATE FUNCTION campaign_conversion_field_allowed(c campaign,f field_definition,cf campaign_field,viewer text)
 RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(c.id=cf.campaign_id AND f.id=cf.field_id AND f.organization_id=c.organization_id
  AND (f.branch_id IS NULL OR f.branch_id=c.branch_id) AND (f.campaign_id IS NULL OR f.campaign_id=c.id)
  AND f.active AND cf.active AND f.value_mode<>'CALCULATED' AND f.field_type<>'CALCULATED'
  AND (viewer='SUPER_ADMIN' OR viewer='MANAGER' AND cf.visible_to_manager OR viewer='AGENT' AND cf.visible_to_agent),false)
$$;

CREATE FUNCTION campaign_conversion_field(c campaign,conf jsonb,viewer text)
 RETURNS SETOF field_definition LANGUAGE sql STABLE AS $$
 SELECT f.* FROM campaign_field cf JOIN field_definition f ON f.id=cf.field_id
 WHERE cf.campaign_id=c.id AND f.id::text=conf->>'fieldId' AND conf->>'type'='FIELD_VALUE'
  AND campaign_conversion_field_allowed(c,f,cf,viewer)
  AND conf->'value' IS NOT NULL AND conf->'value'<>'null'::jsonb AND stored_field_value_valid(conf->'value',f)
$$;

CREATE FUNCTION guard_campaign_conversion_config() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conf jsonb;
BEGIN
 conf=NEW.conversion_config;
 IF TG_OP='UPDATE' AND conf IS NOT DISTINCT FROM OLD.conversion_config THEN RETURN NEW; END IF;
 IF conf='{}'::jsonb OR conf IN ('{"type":"PAYMENT_CONFIRMED"}'::jsonb,'{"type":"ENROLLMENT_CONFIRMED"}'::jsonb)
 THEN RETURN NEW; END IF;
 IF jsonb_typeof(conf)='object' AND conf ?& ARRAY['type','fieldId','value'] AND conf-ARRAY['type','fieldId','value']='{}'::jsonb
  AND EXISTS(SELECT 1 FROM campaign_conversion_field(NEW,conf,'SUPER_ADMIN'))
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'CAMPAIGN_CONVERSION_INVALID';
END $$;
CREATE TRIGGER campaign_conversion_config_guard BEFORE INSERT OR UPDATE OF conversion_config ON campaign
 FOR EACH ROW EXECUTE FUNCTION guard_campaign_conversion_config();
