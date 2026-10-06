-- Null/missing policy members must fail closed at the database boundary too.
CREATE FUNCTION valid_payment_dispatch_policy(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_typeof(p)='object' AND p ?& ARRAY['maxAttempts','retentionMs','dispatchBudgetMs','retryBaseMs','retryMaxMs']
    AND p-'maxAttempts'-'retentionMs'-'dispatchBudgetMs'-'retryBaseMs'-'retryMaxMs'='{}'::jsonb
    AND jsonb_typeof(p->'maxAttempts')='number' AND jsonb_typeof(p->'retentionMs')='number'
    AND jsonb_typeof(p->'dispatchBudgetMs')='number' AND jsonb_typeof(p->'retryBaseMs')='number' AND jsonb_typeof(p->'retryMaxMs')='number'
    AND (p->>'maxAttempts') ~ '^[1-9][0-9]{0,2}$' AND (p->>'maxAttempts')::numeric<=100
    AND (p->>'retentionMs') ~ '^[1-9][0-9]{0,15}$' AND (p->>'retentionMs')::numeric<=9007199254740991
    AND (p->>'dispatchBudgetMs') ~ '^[1-9][0-9]{0,15}$' AND (p->>'dispatchBudgetMs')::numeric<(p->>'retentionMs')::numeric
    AND (p->>'retryBaseMs') ~ '^[1-9][0-9]{0,15}$' AND (p->>'retryBaseMs')::numeric<=9007199254740991
    AND (p->>'retryMaxMs') ~ '^[1-9][0-9]{0,15}$' AND (p->>'retryMaxMs')::numeric BETWEEN (p->>'retryBaseMs')::numeric AND 9007199254740991,false)
$$;
ALTER TABLE payment_dispatch ADD CONSTRAINT payment_dispatch_policy_shape CHECK (
  (first_dispatch_ms IS NULL)=(policy IS NULL) AND (policy IS NULL OR
    (first_dispatch_ms BETWEEN 0 AND 9007199254740991 AND valid_payment_dispatch_policy(policy)
      AND first_dispatch_ms::numeric+(policy->>'retentionMs')::numeric<=9007199254740991))
);
CREATE FUNCTION fence_payment_record_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payment_confirmation; event_type text;
BEGIN
  SELECT * INTO p FROM payment_confirmation WHERE event_id=NEW.confirmation_event_id AND intent_id=NEW.intent_id;
  SELECT e.event_type INTO event_type FROM payment_webhook_event e WHERE e.id=NEW.confirmation_event_id;
  IF (TG_OP='UPDATE' AND OLD.state IN ('FAILED','EXPIRED') AND NEW.state<>'CONFIRMED')
    OR (NEW.state<>'CONFIRMED' AND p.payment_status='PAID')
    OR (NEW.state='EXPIRED' AND p.session_status<>'EXPIRED')
    OR (NEW.state='FAILED' AND (p.session_status<>'COMPLETE' OR p.payment_status<>'UNPAID' OR event_type<>'checkout.session.async_payment_failed'))
    THEN RAISE EXCEPTION 'PAYMENT_STATE_PROOF_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_record_state_fence BEFORE INSERT OR UPDATE ON payment_record FOR EACH ROW EXECUTE FUNCTION fence_payment_record_state();
