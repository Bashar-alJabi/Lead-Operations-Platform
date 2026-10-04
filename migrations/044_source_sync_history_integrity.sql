ALTER TABLE source_resource_sync ADD CONSTRAINT source_sync_outcome_shape CHECK (
  (state='RUNNING' AND resource_count IS NULL AND error_code IS NULL)
  OR (state='SUCCEEDED' AND resource_count IS NOT NULL AND error_code IS NULL)
  OR (state IN ('FAILED','SUPERSEDED') AND resource_count IS NULL AND error_code IS NOT NULL)
);
CREATE FUNCTION preserve_source_sync_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SOURCE_SYNC_HISTORY_IMMUTABLE'; END IF;
  IF OLD.state<>'RUNNING' OR (NEW.id,NEW.connection_id,NEW.connection_version,NEW.resource_kind,NEW.parent_id,
    NEW.actor_user_id,NEW.lease_until,NEW.started_at) IS DISTINCT FROM
    (OLD.id,OLD.connection_id,OLD.connection_version,OLD.resource_kind,OLD.parent_id,OLD.actor_user_id,OLD.lease_until,OLD.started_at)
    THEN RAISE EXCEPTION 'SOURCE_SYNC_HISTORY_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_sync_history_integrity BEFORE UPDATE OR DELETE ON source_resource_sync
  FOR EACH ROW EXECUTE FUNCTION preserve_source_sync_history();
