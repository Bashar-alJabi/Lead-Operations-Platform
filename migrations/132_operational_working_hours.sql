-- Operational setup is authorized natively and projected into the existing routing inputs atomically.
CREATE FUNCTION operational_hours_valid(h jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE d record;r jsonb;s integer;e integer;previous_end integer;BEGIN
 IF jsonb_typeof(h) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 FOR d IN SELECT * FROM jsonb_each(h) LOOP
  IF d.key NOT IN ('mon','tue','wed','thu','fri','sat','sun') OR jsonb_typeof(d.value)<>'array' OR jsonb_array_length(d.value)>8 THEN RETURN false;END IF;
  previous_end=-1;
  FOR r IN SELECT * FROM jsonb_array_elements(d.value) LOOP
   IF jsonb_typeof(r)<>'array' OR jsonb_array_length(r)<>2 OR jsonb_typeof(r->0)<>'string' OR jsonb_typeof(r->1)<>'string'
    OR r->>0 !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR r->>1 !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' THEN RETURN false;END IF;
   s=split_part(r->>0,':',1)::integer*60+split_part(r->>0,':',2)::integer;e=split_part(r->>1,':',1)::integer*60+split_part(r->>1,':',2)::integer;
   IF s>=e OR s<previous_end THEN RETURN false;END IF;previous_end=e;
  END LOOP;
 END LOOP;RETURN true;
 EXCEPTION WHEN others THEN RETURN false;END $$;
CREATE FUNCTION operational_hours_open(h jsonb,tz text,at_time timestamptz) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE local_time timestamp;d text;m integer;BEGIN
 IF NOT operational_hours_valid(h) THEN RETURN false;END IF;IF h='{}' THEN RETURN true;END IF;
 local_time=at_time AT TIME ZONE tz;d=(ARRAY['mon','tue','wed','thu','fri','sat','sun'])[extract(isodow FROM local_time)::integer];
 m=extract(hour FROM local_time)::integer*60+extract(minute FROM local_time)::integer;
 RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(h->d,'[]')) r
  WHERE m>=split_part(r->>0,':',1)::integer*60+split_part(r->>0,':',2)::integer AND m<split_part(r->>1,':',1)::integer*60+split_part(r->>1,':',2)::integer);
 EXCEPTION WHEN others THEN RETURN false;END $$;
ALTER TABLE branch ADD CONSTRAINT branch_hours_valid CHECK(operational_hours_valid(business_hours)) NOT VALID;
ALTER TABLE user_account ADD CONSTRAINT user_hours_valid CHECK(operational_hours_valid(working_hours)) NOT VALID;
ALTER TABLE branch VALIDATE CONSTRAINT branch_hours_valid;
ALTER TABLE user_account VALIDATE CONSTRAINT user_hours_valid;
CREATE TABLE operational_hours_policy (
 scope text NOT NULL CHECK(scope IN ('BRANCH','USER')),resource_id uuid NOT NULL,branch_id uuid NOT NULL REFERENCES branch(id),
 version integer NOT NULL CHECK(version>0),hours jsonb NOT NULL CHECK(operational_hours_valid(hours)),
 actor_id uuid NOT NULL REFERENCES user_account(id),session_id uuid NOT NULL REFERENCES user_session(id),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND reason !~ '[[:cntrl:]]'),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(scope,resource_id),CHECK(scope<>'BRANCH' OR resource_id=branch_id)
);
CREATE INDEX operational_hours_branch ON operational_hours_policy(branch_id,scope,resource_id);
CREATE TABLE operational_hours_history (
 scope text NOT NULL,resource_id uuid NOT NULL,version integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(scope,resource_id,version),FOREIGN KEY(scope,resource_id) REFERENCES operational_hours_policy(scope,resource_id)
);
CREATE FUNCTION guard_operational_hours_policy() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE b record;target record;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'WORKING_HOURS_HISTORY_RETAINED';END IF;
 SELECT * INTO b FROM branch WHERE id=NEW.branch_id FOR UPDATE;
 IF b IS NULL OR NOT b.active THEN RAISE EXCEPTION 'WORKING_HOURS_CURRENT_BRANCH_REQUIRED';END IF;
 IF TG_OP='INSERT' AND NEW.version<>1 OR TG_OP='UPDATE' AND ((NEW.scope,NEW.resource_id,NEW.branch_id) IS DISTINCT FROM (OLD.scope,OLD.resource_id,OLD.branch_id) OR NEW.version<>OLD.version+1)
  THEN RAISE EXCEPTION 'WORKING_HOURS_VERSION_REQUIRED';END IF;
 IF NEW.scope='USER' THEN
  SELECT * INTO target FROM user_account WHERE id=NEW.resource_id AND branch_id=b.id AND organization_id=b.organization_id AND role IN ('AGENT','MANAGER') FOR SHARE;
  IF target IS NULL THEN RAISE EXCEPTION 'WORKING_HOURS_CURRENT_TARGET_REQUIRED';END IF;
 ELSE SELECT NULL::text AS role INTO target;END IF;
 PERFORM 1 FROM user_account u JOIN user_session s ON s.user_id=u.id WHERE u.id=NEW.actor_id AND s.id=NEW.session_id
  AND u.active AND u.organization_id=b.organization_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
  AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=b.id AND (NEW.scope='BRANCH' OR target.role='AGENT')) FOR SHARE OF u,s;
 IF NOT FOUND THEN RAISE EXCEPTION 'WORKING_HOURS_CURRENT_ACCESS_REQUIRED';END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER operational_hours_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON operational_hours_policy FOR EACH ROW EXECUTE FUNCTION guard_operational_hours_policy();
CREATE FUNCTION guard_operational_hours_projection() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE h jsonb;old_h jsonb;scope_name text;BEGIN
 scope_name=CASE WHEN TG_TABLE_NAME='branch' THEN 'BRANCH' ELSE 'USER' END;
 h=CASE WHEN scope_name='BRANCH' THEN to_jsonb(NEW)->'business_hours' ELSE to_jsonb(NEW)->'working_hours' END;
 old_h=CASE WHEN scope_name='BRANCH' THEN to_jsonb(OLD)->'business_hours' ELSE to_jsonb(OLD)->'working_hours' END;
 IF h IS DISTINCT FROM old_h
  AND NOT EXISTS(SELECT 1 FROM operational_hours_policy hp WHERE hp.scope=scope_name AND hp.resource_id=NEW.id AND hp.hours=h
    AND hp.branch_id=CASE WHEN scope_name='BRANCH' THEN NEW.id ELSE (to_jsonb(NEW)->>'branch_id')::uuid END AND ai_row_inserted_here(hp.xmin))
  THEN RAISE EXCEPTION 'WORKING_HOURS_AUTHORIZED_SETUP_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE TRIGGER branch_hours_projection_guard BEFORE UPDATE OF business_hours ON branch FOR EACH ROW EXECUTE FUNCTION guard_operational_hours_projection();
CREATE TRIGGER user_hours_projection_guard BEFORE UPDATE OF working_hours ON user_account FOR EACH ROW EXECUTE FUNCTION guard_operational_hours_projection();
CREATE FUNCTION guard_operational_hours_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM operational_hours_policy p WHERE p.scope=NEW.scope AND p.resource_id=NEW.resource_id AND p.version=NEW.version AND to_jsonb(p)=NEW.snapshot)
  THEN RAISE EXCEPTION 'WORKING_HOURS_HISTORY_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER operational_hours_history_guard BEFORE INSERT OR UPDATE OR DELETE ON operational_hours_history FOR EACH ROW EXECUTE FUNCTION guard_operational_hours_history();
CREATE FUNCTION record_operational_hours_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.scope='BRANCH' THEN UPDATE branch SET business_hours=NEW.hours,updated_at=clock_timestamp() WHERE id=NEW.resource_id;
 ELSE UPDATE user_account SET working_hours=NEW.hours,updated_at=clock_timestamp() WHERE id=NEW.resource_id;END IF;
 INSERT INTO operational_hours_history(scope,resource_id,version,snapshot) VALUES(NEW.scope,NEW.resource_id,NEW.version,to_jsonb(NEW));
 INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) SELECT b.organization_id,b.id,NEW.actor_id,'WORKING_HOURS_CONFIGURED',NEW.scope,NEW.resource_id,
  jsonb_build_object('version',NEW.version,'reason',NEW.reason) FROM branch b WHERE b.id=NEW.branch_id;RETURN NEW;
END $$;
CREATE TRIGGER operational_hours_policy_record AFTER INSERT OR UPDATE ON operational_hours_policy FOR EACH ROW EXECUTE FUNCTION record_operational_hours_policy();
