-- The first immutable intent supplies the original endpoint credential reference, even when its ACK is lost.
CREATE TABLE payment_notification_credential_anchor (
  endpoint_id uuid PRIMARY KEY REFERENCES payment_notification_endpoint(id),
  intent_id uuid NOT NULL UNIQUE REFERENCES payment_link_intent(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_payment_notification_credential_anchor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_NOTIFICATION_CREDENTIAL_ANCHOR_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_link_intent i JOIN payment_notification_endpoint n ON n.id=i.notification_endpoint_id
    WHERE i.id=NEW.intent_id AND n.id=NEW.endpoint_id AND i.provider='ALMA'
      AND (i.connection_id,i.connection_version,i.account_ref,i.mode)=(n.connection_id,n.connection_version,n.account_ref,n.mode))
    THEN RAISE EXCEPTION 'PAYMENT_NOTIFICATION_CREDENTIAL_ORIGINAL_CONTEXT_REQUIRED'; END IF;
  NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER payment_notification_credential_anchor_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_notification_credential_anchor
  FOR EACH ROW EXECUTE FUNCTION guard_payment_notification_credential_anchor();
CREATE FUNCTION audit_payment_notification_credential_anchor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    SELECT organization_id,branch_id,NULL,'PAYMENT_READ_CREDENTIAL_ANCHORED','PAYMENT_NOTIFICATION_ENDPOINT',NEW.endpoint_id,jsonb_build_object('intentId',NEW.intent_id)
    FROM payment_link_intent WHERE id=NEW.intent_id;RETURN NEW;
END $$;
CREATE TRIGGER payment_notification_credential_anchor_audit AFTER INSERT ON payment_notification_credential_anchor
  FOR EACH ROW EXECUTE FUNCTION audit_payment_notification_credential_anchor();
CREATE FUNCTION anchor_payment_notification_credential() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO payment_notification_credential_anchor(endpoint_id,intent_id) VALUES(NEW.notification_endpoint_id,NEW.id) ON CONFLICT(endpoint_id) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_notification_credential_anchor_seed AFTER INSERT ON payment_link_intent
  FOR EACH ROW WHEN(NEW.provider='ALMA') EXECUTE FUNCTION anchor_payment_notification_credential();
INSERT INTO payment_notification_credential_anchor(endpoint_id,intent_id)
  SELECT DISTINCT ON(notification_endpoint_id) notification_endpoint_id,id FROM payment_link_intent WHERE provider='ALMA' ORDER BY notification_endpoint_id,created_at,id;
CREATE FUNCTION fence_payment_independent_read_finalization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.state='PROCESSED' AND NOT EXISTS(SELECT 1 FROM payment_independent_read_confirmation p
    WHERE p.attempt_id=OLD.lease_token AND p.session_status IN ('COMPLETE','EXPIRED')) THEN RAISE EXCEPTION 'PAYMENT_INDEPENDENT_READ_FINAL_STATUS_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_independent_read_z_finalization_fence BEFORE UPDATE ON payment_independent_read_job FOR EACH ROW EXECUTE FUNCTION fence_payment_independent_read_finalization();
