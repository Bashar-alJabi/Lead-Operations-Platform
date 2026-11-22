CREATE TABLE generic_source_setup_revision (
 connection_id uuid NOT NULL REFERENCES integration_connection(id),
 version integer NOT NULL CHECK(version>0),
 operation text NOT NULL CHECK(operation IN ('CREATE','ROTATE','DISABLE')),
 actor_id uuid NOT NULL REFERENCES user_account(id),
 session_id uuid NOT NULL REFERENCES user_session(id),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
 changed_at timestamptz NOT NULL,
 PRIMARY KEY(connection_id,version)
);

CREATE TABLE generic_source_test_receipt (
 connection_id uuid NOT NULL REFERENCES integration_connection(id),
 test_id uuid NOT NULL,
 connection_version integer NOT NULL,
 signed_at timestamptz NOT NULL,
 body_hash bytea NOT NULL CHECK(octet_length(body_hash)=32),
 received_at timestamptz NOT NULL,
 PRIMARY KEY(connection_id,test_id),
 FOREIGN KEY(connection_id,connection_version) REFERENCES generic_source_setup_revision(connection_id,version)
);
CREATE INDEX generic_source_test_recent ON generic_source_test_receipt(connection_id,received_at DESC,test_id DESC);

CREATE FUNCTION guard_generic_source_setup_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection; previous generic_source_setup_revision;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'GENERIC_SOURCE_SETUP_IMMUTABLE'; END IF;
 SELECT * INTO c FROM integration_connection WHERE id=NEW.connection_id AND kind='GENERIC_SOURCE'
  AND provider='SIGNED_WEBHOOK' AND version=NEW.version AND ai_row_inserted_here(xmin);
 IF NOT FOUND THEN RAISE EXCEPTION 'GENERIC_SOURCE_SETUP_PROOF_REQUIRED'; END IF;
 SELECT * INTO previous FROM generic_source_setup_revision WHERE connection_id=c.id ORDER BY version DESC LIMIT 1;
 IF NEW.version<>COALESCE(previous.version+1,1) OR (NEW.operation='CREATE')<>(NEW.version=1)
  OR (NEW.operation='DISABLE')<>(c.status='DISABLED') OR (NEW.operation<>'DISABLE' AND c.status<>'NOT_CONFIGURED')
  OR (NEW.operation='DISABLE' AND previous.operation='DISABLE')
  OR NOT EXISTS(
   SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id JOIN branch b ON b.id=c.branch_id
   WHERE u.id=NEW.actor_id AND u.active AND u.organization_id=c.organization_id AND b.organization_id=c.organization_id
    AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=c.branch_id)
    AND (b.active OR NEW.operation='DISABLE')
    AND s.id=NEW.session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s,b
  )
  OR NEW.operation<>'DISABLE' AND NOT EXISTS(
   SELECT 1 FROM connection_secret s WHERE s.connection_id=c.id AND ai_row_inserted_here(s.xmin)
    AND s.key_version=1 AND octet_length(s.nonce)=12 AND octet_length(s.auth_tag)=16 AND octet_length(s.ciphertext)=64
  )
 THEN RAISE EXCEPTION 'GENERIC_SOURCE_SETUP_PROOF_REQUIRED'; END IF;
 NEW.changed_at=statement_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER generic_source_setup_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON generic_source_setup_revision
 FOR EACH ROW EXECUTE FUNCTION guard_generic_source_setup_revision();

CREATE FUNCTION record_generic_source_setup_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  SELECT organization_id,branch_id,NEW.actor_id,'GENERIC_SOURCE_'||NEW.operation,'SOURCE_CONNECTION',id,
   jsonb_build_object('version',NEW.version,'reason',NEW.reason)
  FROM integration_connection WHERE id=NEW.connection_id;
 RETURN NEW;
END $$;
CREATE TRIGGER generic_source_setup_revision_record AFTER INSERT ON generic_source_setup_revision
 FOR EACH ROW EXECUTE FUNCTION record_generic_source_setup_revision();

CREATE FUNCTION guard_generic_source_connection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.kind='GENERIC_SOURCE' AND NEW.provider='SIGNED_WEBHOOK' AND
   (NEW.version<>1 OR NEW.branch_id IS NULL OR NEW.status<>'NOT_CONFIGURED' OR NEW.last_success_at IS NOT NULL)
  THEN RAISE EXCEPTION 'GENERIC_SOURCE_SETUP_PROOF_REQUIRED'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.kind<>'GENERIC_SOURCE' OR OLD.provider<>'SIGNED_WEBHOOK' THEN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.kind='GENERIC_SOURCE' AND NEW.provider='SIGNED_WEBHOOK' THEN RAISE EXCEPTION 'GENERIC_SOURCE_IDENTITY_IMMUTABLE'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GENERIC_SOURCE_IDENTITY_IMMUTABLE'; END IF;
 IF (NEW.id,NEW.kind,NEW.provider,NEW.organization_id,NEW.branch_id,NEW.created_by,NEW.created_at)
  IS DISTINCT FROM (OLD.id,OLD.kind,OLD.provider,OLD.organization_id,OLD.branch_id,OLD.created_by,OLD.created_at)
 THEN RAISE EXCEPTION 'GENERIC_SOURCE_IDENTITY_IMMUTABLE'; END IF;
 IF NEW.version=OLD.version+1 AND NEW.status IN ('NOT_CONFIGURED','DISABLED') AND NEW.last_success_at IS NULL
 THEN RETURN NEW; END IF;
 IF NEW.version=OLD.version AND NEW.status='CONNECTED' AND OLD.status IN ('NOT_CONFIGURED','CONNECTED')
  AND (to_jsonb(NEW)-ARRAY['status','last_success_at','updated_at'])=(to_jsonb(OLD)-ARRAY['status','last_success_at','updated_at'])
  AND EXISTS(SELECT 1 FROM generic_source_test_receipt r WHERE r.connection_id=OLD.id AND r.connection_version=OLD.version
   AND r.received_at=NEW.last_success_at AND ai_row_inserted_here(r.xmin))
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'GENERIC_SOURCE_CONNECTION_PROOF_REQUIRED';
END $$;
CREATE TRIGGER generic_source_connection_guard BEFORE INSERT OR UPDATE OR DELETE ON integration_connection
 FOR EACH ROW EXECUTE FUNCTION guard_generic_source_connection();

CREATE FUNCTION check_generic_source_connection_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='GENERIC_SOURCE' AND NEW.provider='SIGNED_WEBHOOK' AND
  (TG_OP='INSERT' OR NEW.version<>OLD.version) AND NOT EXISTS(
   SELECT 1 FROM generic_source_setup_revision r WHERE r.connection_id=NEW.id AND r.version=NEW.version
    AND ai_row_inserted_here(r.xmin)
  )
 THEN RAISE EXCEPTION 'GENERIC_SOURCE_SETUP_REVISION_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER generic_source_connection_revision_required AFTER INSERT OR UPDATE ON integration_connection
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind='GENERIC_SOURCE' AND NEW.provider='SIGNED_WEBHOOK')
 EXECUTE FUNCTION check_generic_source_connection_revision();

CREATE FUNCTION check_generic_source_secret_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integration_connection; cid uuid;
BEGIN
 IF TG_OP='UPDATE' AND NEW.connection_id<>OLD.connection_id AND EXISTS(
  SELECT 1 FROM integration_connection WHERE id=OLD.connection_id AND kind='GENERIC_SOURCE' AND provider='SIGNED_WEBHOOK'
 ) THEN RAISE EXCEPTION 'GENERIC_SOURCE_SECRET_ROTATION_REQUIRED'; END IF;
 cid=CASE WHEN TG_OP='DELETE' THEN OLD.connection_id ELSE NEW.connection_id END;
 SELECT * INTO c FROM integration_connection WHERE id=cid AND kind='GENERIC_SOURCE' AND provider='SIGNED_WEBHOOK';
 IF FOUND AND (TG_OP='DELETE' OR NOT EXISTS(
  SELECT 1 FROM generic_source_setup_revision r WHERE r.connection_id=c.id AND r.version=c.version
   AND r.operation IN ('CREATE','ROTATE') AND ai_row_inserted_here(r.xmin)
 )) THEN RAISE EXCEPTION 'GENERIC_SOURCE_SECRET_ROTATION_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER generic_source_secret_revision_required AFTER INSERT OR UPDATE OR DELETE ON connection_secret
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_generic_source_secret_revision();

CREATE FUNCTION guard_generic_source_test_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'GENERIC_SOURCE_TEST_IMMUTABLE'; END IF;
 IF NEW.signed_at NOT BETWEEN clock_timestamp()-interval '5 minutes' AND clock_timestamp()+interval '5 minutes'
  OR NOT EXISTS(
   SELECT 1 FROM integration_connection c JOIN branch b ON (b.id,b.organization_id)=(c.branch_id,c.organization_id)
   WHERE c.id=NEW.connection_id AND c.kind='GENERIC_SOURCE' AND c.provider='SIGNED_WEBHOOK'
    AND c.version=NEW.connection_version AND c.status IN ('NOT_CONFIGURED','CONNECTED') AND b.active
   FOR SHARE OF c,b
  )
 THEN RAISE EXCEPTION 'GENERIC_SOURCE_TEST_CONTEXT_CHANGED'; END IF;
 NEW.received_at=statement_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER generic_source_test_guard BEFORE INSERT OR UPDATE OR DELETE ON generic_source_test_receipt
 FOR EACH ROW EXECUTE FUNCTION guard_generic_source_test_receipt();

CREATE FUNCTION record_generic_source_test() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE integration_connection SET status='CONNECTED',last_success_at=NEW.received_at,updated_at=NEW.received_at
  WHERE id=NEW.connection_id;
 INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
  SELECT organization_id,branch_id,'GENERIC_SOURCE_TEST_VERIFIED','SOURCE_CONNECTION',id,
   jsonb_build_object('version',NEW.connection_version,'testId',NEW.test_id)
  FROM integration_connection WHERE id=NEW.connection_id;
 RETURN NEW;
END $$;
CREATE TRIGGER generic_source_test_record AFTER INSERT ON generic_source_test_receipt
 FOR EACH ROW EXECUTE FUNCTION record_generic_source_test();
