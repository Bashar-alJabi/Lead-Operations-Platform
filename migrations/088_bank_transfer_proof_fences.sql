-- Required manual evidence must fail closed for SQL NULL, and proof activation is atomic.
ALTER TABLE bank_transfer_confirmation ADD CONSTRAINT bank_manual_evidence_required CHECK(
  source<>'AUTHORIZED_MANUAL' OR (reason IS NOT NULL AND bank_verified IS TRUE));
CREATE FUNCTION bank_confirmation_has_payment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM payment_record p JOIN enrollment e ON e.payment_id=p.id
    JOIN bank_transfer_request r ON r.id=p.bank_request_id WHERE p.bank_confirmation_id=NEW.id AND p.bank_request_id=NEW.request_id
      AND p.state='CONFIRMED' AND e.lead_id=r.lead_id) THEN RAISE EXCEPTION 'BANK_PROOF_PAYMENT_ENROLLMENT_REQUIRED'; END IF;
  RETURN NEW; END $$;
CREATE CONSTRAINT TRIGGER bank_confirmation_financial_fence AFTER INSERT ON bank_transfer_confirmation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_confirmation_has_payment();
CREATE FUNCTION bank_payment_has_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.bank_request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM enrollment e JOIN bank_transfer_request r ON r.id=NEW.bank_request_id
    WHERE e.payment_id=NEW.id AND e.lead_id=r.lead_id) THEN RAISE EXCEPTION 'BANK_PAYMENT_ENROLLMENT_REQUIRED'; END IF;
  RETURN NEW; END $$;
CREATE CONSTRAINT TRIGGER bank_payment_financial_fence AFTER INSERT ON payment_record
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_payment_has_enrollment();
