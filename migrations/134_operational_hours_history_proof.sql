-- Preserve applied132. History timestamps and admission are native current policy evidence.
CREATE OR REPLACE FUNCTION guard_operational_hours_history() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p record;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'WORKING_HOURS_HISTORY_IMMUTABLE';END IF;
 SELECT hp.*,hp.xmin AS inserted_xid INTO p FROM operational_hours_policy hp WHERE hp.scope=NEW.scope AND hp.resource_id=NEW.resource_id AND hp.version=NEW.version;
 IF p IS NULL OR NOT ai_row_inserted_here(p.inserted_xid) OR (to_jsonb(p)-'inserted_xid') IS DISTINCT FROM NEW.snapshot
  THEN RAISE EXCEPTION 'WORKING_HOURS_HISTORY_IMMUTABLE';END IF;
 NEW.created_at=p.updated_at;RETURN NEW;
END $$;
