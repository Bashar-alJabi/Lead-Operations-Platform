-- Bounded Human requests, not a new source of Field/Lead authorization.
CREATE TABLE bulk_field_batch (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organization(id),
 actor_id uuid NOT NULL REFERENCES user_account(id),
 actor_role text NOT NULL CHECK(actor_role IN ('SUPER_ADMIN','MANAGER','AGENT')),
 branch_scope uuid REFERENCES branch(id),
 session_id uuid NOT NULL REFERENCES user_session(id),
 request_key uuid NOT NULL,
 request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32),
 -- Deliberately no FK: an unknown/hidden requested Field must have the same failure surface.
 field_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('SET','ADD_TAGS','REMOVE_TAGS')),
 item_count integer NOT NULL CHECK(item_count BETWEEN 1 AND 50),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(actor_id,request_key)
);
CREATE TABLE bulk_field_receipt (
 batch_id uuid NOT NULL REFERENCES bulk_field_batch(id),
 lead_id uuid NOT NULL REFERENCES lead(id),
 branch_id uuid NOT NULL REFERENCES branch(id),
 campaign_id uuid NOT NULL REFERENCES campaign(id),
 field_id uuid NOT NULL REFERENCES field_definition(id),
 session_id uuid NOT NULL REFERENCES user_session(id),
 lead_version integer NOT NULL CHECK(lead_version>0),
 definition_version integer NOT NULL CHECK(definition_version>0),
 binding_version integer NOT NULL CHECK(binding_version>0),
 result_version integer NOT NULL CHECK(result_version>0),
 history_id bigint NOT NULL UNIQUE REFERENCES field_value_history(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(batch_id,lead_id)
);
CREATE INDEX bulk_field_batch_actor_history ON bulk_field_batch(actor_id,created_at DESC,id DESC);
CREATE INDEX bulk_field_receipt_lead_history ON bulk_field_receipt(lead_id,created_at DESC,batch_id);

CREATE FUNCTION bulk_field_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BULK_BATCH_IMMUTABLE';END IF;
 IF NEW.created_at<transaction_timestamp() OR NEW.created_at>clock_timestamp() OR NOT EXISTS(
  SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id
  WHERE u.id=NEW.actor_id AND u.organization_id=NEW.organization_id AND u.active
   AND u.role=NEW.actor_role AND u.branch_id IS NOT DISTINCT FROM NEW.branch_scope
   AND s.id=NEW.session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
 ) THEN RAISE EXCEPTION 'BULK_BATCH_AUTHORITY';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bulk_field_batch_guard BEFORE INSERT OR UPDATE OR DELETE ON bulk_field_batch
 FOR EACH ROW EXECUTE FUNCTION bulk_field_batch_guard();

CREATE FUNCTION bulk_field_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BULK_RECEIPT_IMMUTABLE';END IF;
 IF NEW.created_at<transaction_timestamp() OR NEW.created_at>clock_timestamp() OR NOT EXISTS(
  SELECT 1 FROM bulk_field_batch b JOIN user_account u ON u.id=b.actor_id
   JOIN user_session s ON s.user_id=u.id JOIN lead l ON l.id=NEW.lead_id
   JOIN campaign ca ON ca.id=l.campaign_id JOIN campaign_field cf ON cf.campaign_id=ca.id AND cf.field_id=b.field_id
   JOIN field_definition fd ON fd.id=cf.field_id
   JOIN lead_field_value fv ON fv.lead_id=l.id AND fv.field_id=fd.id
   JOIN field_value_history h ON h.id=NEW.history_id
  WHERE b.id=NEW.batch_id AND b.field_id=NEW.field_id AND b.organization_id=l.organization_id
   AND ca.organization_id=l.organization_id AND ca.branch_id=l.branch_id
   AND u.organization_id=b.organization_id AND u.active AND u.role=b.actor_role
   AND u.branch_id IS NOT DISTINCT FROM b.branch_scope AND s.id=NEW.session_id
   AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
   AND (u.role='SUPER_ADMIN' OR u.branch_id=l.branch_id AND (u.role='MANAGER' OR u.role='AGENT' AND l.assigned_agent_id=u.id))
   AND NEW.branch_id=l.branch_id AND NEW.campaign_id=l.campaign_id AND NEW.lead_version=l.version
   AND fd.organization_id=l.organization_id AND (fd.branch_id IS NULL OR fd.branch_id=l.branch_id)
   AND (fd.campaign_id IS NULL OR fd.campaign_id=ca.id) AND fd.active AND cf.active AND fd.value_mode='MANUAL'
   AND fd.version=NEW.definition_version AND cf.version=NEW.binding_version
   AND (u.role='SUPER_ADMIN' OR (cf.show_in_details OR cf.show_in_table) AND
    (u.role='MANAGER' AND cf.visible_to_manager AND cf.editable_by_manager OR u.role='AGENT' AND cf.visible_to_agent AND cf.editable_by_agent))
   AND (b.operation='SET' OR fd.field_type='TAGS')
   AND fv.version=NEW.result_version AND fv.updated_by=u.id AND fv.source='MANUAL' AND ai_row_inserted_here(fv.xmin)
   AND h.lead_id=l.id AND h.field_id=fd.id AND h.actor_user_id=u.id AND h.source='MANUAL'
   AND h.new_value IS NOT DISTINCT FROM fv.value AND ai_row_inserted_here(h.xmin)
   AND EXISTS(SELECT 1 FROM audit_log a WHERE a.actor_user_id=u.id AND a.organization_id=b.organization_id
    AND a.branch_id=l.branch_id AND a.action='BULK_FIELD_UPDATED' AND a.target_type='LEAD' AND a.target_id=l.id
    AND a.detail->>'batchId'=b.id::text AND a.detail->>'fieldId'=fd.id::text AND ai_row_inserted_here(a.xmin))
 ) THEN RAISE EXCEPTION 'BULK_RECEIPT_PROOF';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bulk_field_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON bulk_field_receipt
 FOR EACH ROW EXECUTE FUNCTION bulk_field_receipt_guard();
CREATE FUNCTION bulk_field_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM bulk_field_receipt r WHERE r.history_id=OLD.id) THEN RAISE EXCEPTION 'BULK_HISTORY_IMMUTABLE';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER bulk_field_history_guard BEFORE UPDATE OR DELETE ON field_value_history
 FOR EACH ROW EXECUTE FUNCTION bulk_field_history_guard();
