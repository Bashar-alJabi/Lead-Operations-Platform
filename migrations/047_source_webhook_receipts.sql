CREATE TABLE source_webhook_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  connection_version integer NOT NULL CHECK (connection_version>0),
  page_id uuid NOT NULL,
  external_page_id text NOT NULL CHECK (external_page_id ~ '^[0-9]{1,30}$'),
  external_form_id text NOT NULL CHECK (external_form_id ~ '^[0-9]{1,30}$'),
  external_lead_id text NOT NULL CHECK (external_lead_id ~ '^[0-9]{1,30}$'),
  source_created_at timestamptz NOT NULL,
  raw_notification jsonb NOT NULL CHECK (jsonb_typeof(raw_notification)='object'),
  envelope_hash bytea NOT NULL CHECK (octet_length(envelope_hash)=32),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id,external_lead_id),
  FOREIGN KEY (page_id,connection_id) REFERENCES source_resource(id,connection_id)
);
CREATE INDEX source_webhook_history_idx ON source_webhook_event (connection_id,received_at DESC,id DESC);
CREATE FUNCTION preserve_source_webhook_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SOURCE_WEBHOOK_RECEIPT_IMMUTABLE'; END IF;
  IF NOT EXISTS (SELECT 1 FROM integration_connection WHERE id=NEW.connection_id AND kind='META' AND provider='META_LEAD_ADS')
    OR NOT EXISTS (SELECT 1 FROM source_resource WHERE id=NEW.page_id AND connection_id=NEW.connection_id
      AND resource_kind='PAGE' AND external_id=NEW.external_page_id)
    THEN RAISE EXCEPTION 'SOURCE_WEBHOOK_SCOPE_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_webhook_event_integrity BEFORE INSERT OR UPDATE OR DELETE ON source_webhook_event
  FOR EACH ROW EXECUTE FUNCTION preserve_source_webhook_event();

CREATE TABLE source_subscription_attempt (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  connection_version integer NOT NULL CHECK (connection_version>0),
  page_id uuid NOT NULL,
  page_version integer NOT NULL CHECK (page_version>0),
  actor_user_id uuid NOT NULL REFERENCES user_account(id),
  action text NOT NULL CHECK (action IN ('TEST','SUBSCRIBE')),
  state text NOT NULL DEFAULT 'RUNNING' CHECK (state IN ('RUNNING','SUCCEEDED','FAILED','SUPERSEDED')),
  subscribed boolean,
  error_code text CHECK (error_code ~ '^[A-Z0-9_]{1,100}$'),
  lease_until timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (page_id,connection_id) REFERENCES source_resource(id,connection_id),
  CHECK ((state='RUNNING' AND finished_at IS NULL AND subscribed IS NULL AND error_code IS NULL)
    OR (state='SUCCEEDED' AND finished_at IS NOT NULL AND subscribed IS NOT NULL AND error_code IS NULL)
    OR (state IN ('FAILED','SUPERSEDED') AND finished_at IS NOT NULL AND subscribed IS NULL AND error_code IS NOT NULL))
);
CREATE UNIQUE INDEX source_subscription_running_idx ON source_subscription_attempt (connection_id) WHERE state='RUNNING';
CREATE INDEX source_subscription_history_idx ON source_subscription_attempt (connection_id,page_id,started_at DESC,id DESC);
CREATE FUNCTION preserve_source_subscription_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SOURCE_SUBSCRIPTION_HISTORY_IMMUTABLE'; END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM source_resource WHERE id=NEW.page_id AND connection_id=NEW.connection_id AND resource_kind='PAGE')
      THEN RAISE EXCEPTION 'SOURCE_SUBSCRIPTION_PAGE_REQUIRED'; END IF;
  ELSIF OLD.state<>'RUNNING' OR (NEW.id,NEW.connection_id,NEW.connection_version,NEW.page_id,NEW.page_version,
    NEW.actor_user_id,NEW.action,NEW.lease_until,NEW.started_at) IS DISTINCT FROM
    (OLD.id,OLD.connection_id,OLD.connection_version,OLD.page_id,OLD.page_version,OLD.actor_user_id,OLD.action,OLD.lease_until,OLD.started_at)
    THEN RAISE EXCEPTION 'SOURCE_SUBSCRIPTION_HISTORY_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_subscription_attempt_integrity BEFORE INSERT OR UPDATE OR DELETE ON source_subscription_attempt
  FOR EACH ROW EXECUTE FUNCTION preserve_source_subscription_attempt();
