-- No unverified account-manager retention extension is assumed for Orders writes.
CREATE FUNCTION fence_paypal_order_dispatch_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.policy IS NOT NULL AND EXISTS(SELECT 1 FROM payment_link_intent i WHERE i.id=NEW.intent_id AND i.provider='PAYPAL')
    AND NEW.policy<>jsonb_build_object('maxAttempts',5,'retentionMs',21600000,'dispatchBudgetMs',20000,'retryBaseMs',2000,'retryMaxMs',60000)
    THEN RAISE EXCEPTION 'PAYMENT_ORDER_POLICY_INVALID'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER paypal_order_dispatch_policy_fence BEFORE INSERT OR UPDATE ON payment_dispatch FOR EACH ROW EXECUTE FUNCTION fence_paypal_order_dispatch_policy();
