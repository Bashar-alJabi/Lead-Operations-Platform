-- The provider's precision is a financial constraint, not an arbitrary requested scale.
ALTER TABLE payment_link_intent ADD CONSTRAINT paypal_money_precision CHECK(provider<>'PAYPAL' OR
  (quantum='1' AND scale=CASE WHEN currency IN ('HUF','JPY','TWD') THEN 0 ELSE 2 END));
ALTER TABLE payment_confirmation ADD CONSTRAINT paypal_unpaid_reference CHECK(provider<>'PAYPAL' OR
  payment_status='PAID' OR payment_ref IS NULL);
CREATE FUNCTION fence_payment_capture_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.policy IS NOT NULL AND NEW.policy<>jsonb_build_object('maxAttempts',5,'retentionMs',21600000,'dispatchBudgetMs',30000,'retryBaseMs',2000,'retryMaxMs',60000)
    THEN RAISE EXCEPTION 'PAYMENT_CAPTURE_POLICY_INVALID'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_capture_policy_fence BEFORE INSERT OR UPDATE ON payment_capture_job FOR EACH ROW EXECUTE FUNCTION fence_payment_capture_policy();
