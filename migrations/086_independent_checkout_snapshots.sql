-- A trusted read may recover a link after lost ACK. It must never manufacture a creation acknowledgement.
CREATE TABLE payment_independent_checkout_snapshot (
  proof_id uuid PRIMARY KEY,intent_id uuid NOT NULL REFERENCES payment_link_intent(id),
  FOREIGN KEY(proof_id,intent_id) REFERENCES payment_independent_read_confirmation(id,intent_id),
  ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 32768),
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12),auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16),key_version integer NOT NULL CHECK(key_version=1)
);
CREATE FUNCTION guard_independent_checkout_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_INDEPENDENT_CHECKOUT_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_independent_read_confirmation p JOIN payment_independent_read_attempt a ON a.id=p.attempt_id
    JOIN payment_independent_read_job j ON j.notification_id=a.notification_id
    WHERE p.id=NEW.proof_id AND p.intent_id=NEW.intent_id AND a.state='RUNNING' AND j.state='RUNNING'
      AND j.lease_token=a.id AND j.lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'PAYMENT_INDEPENDENT_CHECKOUT_CURRENT_PROOF_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER independent_checkout_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_independent_checkout_snapshot
  FOR EACH ROW EXECUTE FUNCTION guard_independent_checkout_snapshot();
CREATE FUNCTION audit_independent_checkout_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    SELECT i.organization_id,i.branch_id,NULL,'PAYMENT_INDEPENDENT_CHECKOUT_RECORDED','PAYMENT_LINK',i.id,
      jsonb_build_object('proofId',p.id,'sessionStatus',p.session_status,'financialWrite',false)
    FROM payment_link_intent i JOIN payment_independent_read_confirmation p ON p.id=NEW.proof_id WHERE i.id=NEW.intent_id;
  RETURN NEW;
END $$;
CREATE TRIGGER independent_checkout_snapshot_audit AFTER INSERT ON payment_independent_checkout_snapshot
  FOR EACH ROW EXECUTE FUNCTION audit_independent_checkout_snapshot();
