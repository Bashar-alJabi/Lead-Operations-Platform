CREATE FUNCTION guard_bank_account_history_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM bank_transfer_account a WHERE a.id=NEW.account_id AND a.version=NEW.version AND to_jsonb(a)=NEW.snapshot)
    THEN RAISE EXCEPTION 'BANK_ACCOUNT_HISTORY_SNAPSHOT_INVALID'; END IF; RETURN NEW; END $$;
CREATE TRIGGER bank_account_history_insert_guard BEFORE INSERT ON bank_transfer_account_history FOR EACH ROW EXECUTE FUNCTION guard_bank_account_history_insert();
CREATE FUNCTION audit_bank_source_configuration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    SELECT a.organization_id,a.branch_id,CASE WHEN TG_OP='INSERT' THEN NEW.approved_by ELSE NULL END,
      CASE WHEN TG_OP='INSERT' THEN 'BANK_SOURCE_NATIVE_APPROVED' ELSE 'BANK_SOURCE_NATIVE_DISABLED' END,
      'BANK_SOURCE',NEW.id,jsonb_build_object('accountId',a.id,'description',NEW.description) FROM bank_transfer_account a WHERE a.id=NEW.account_id;
  RETURN NEW; END $$;
CREATE TRIGGER bank_source_audit AFTER INSERT OR UPDATE ON bank_settlement_source FOR EACH ROW EXECUTE FUNCTION audit_bank_source_configuration();
