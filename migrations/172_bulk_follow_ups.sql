-- Reuse the immutable real-Human authority envelope; existing trigger follows the function OID.
ALTER FUNCTION bulk_field_batch_guard() RENAME TO bulk_human_batch_guard;
CREATE TABLE bulk_follow_up_batch (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organization(id),
 actor_id uuid NOT NULL REFERENCES user_account(id),actor_role text NOT NULL CHECK(actor_role IN ('SUPER_ADMIN','MANAGER','AGENT')),
 branch_scope uuid REFERENCES branch(id),session_id uuid NOT NULL REFERENCES user_session(id),
 request_key uuid NOT NULL,request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32),
 item_count integer NOT NULL CHECK(item_count BETWEEN 1 AND 50),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(actor_id,request_key)
);
CREATE TRIGGER bulk_follow_up_batch_guard BEFORE INSERT OR UPDATE OR DELETE ON bulk_follow_up_batch
 FOR EACH ROW EXECUTE FUNCTION bulk_human_batch_guard();
CREATE TABLE bulk_follow_up_receipt (
 batch_id uuid NOT NULL REFERENCES bulk_follow_up_batch(id),lead_id uuid NOT NULL REFERENCES lead(id),
 branch_id uuid NOT NULL REFERENCES branch(id),campaign_id uuid NOT NULL REFERENCES campaign(id),
 session_id uuid NOT NULL REFERENCES user_session(id),lead_version integer NOT NULL CHECK(lead_version>0),
 owner_user_id uuid NOT NULL REFERENCES user_account(id),follow_up_id uuid NOT NULL UNIQUE REFERENCES follow_up(id),
 history_id bigint NOT NULL UNIQUE REFERENCES follow_up_history(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(batch_id,lead_id)
);
CREATE INDEX bulk_follow_up_batch_actor_history ON bulk_follow_up_batch(actor_id,created_at DESC,id DESC);
CREATE INDEX bulk_follow_up_receipt_lead_history ON bulk_follow_up_receipt(lead_id,created_at DESC,batch_id);
CREATE FUNCTION bulk_follow_up_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BULK_RECEIPT_IMMUTABLE';END IF;
 IF NEW.created_at<transaction_timestamp() OR NEW.created_at>clock_timestamp() OR NOT EXISTS(
  SELECT 1 FROM bulk_follow_up_batch b JOIN user_account u ON u.id=b.actor_id JOIN user_session s ON s.user_id=u.id
   JOIN lead l ON l.id=NEW.lead_id JOIN campaign c ON c.id=l.campaign_id
   JOIN follow_up f ON f.id=NEW.follow_up_id JOIN user_account owner ON owner.id=f.owner_user_id
   JOIN follow_up_history h ON h.id=NEW.history_id
  WHERE b.id=NEW.batch_id AND b.organization_id=l.organization_id AND c.organization_id=l.organization_id AND c.branch_id=l.branch_id
   AND u.organization_id=b.organization_id AND u.active AND u.role=b.actor_role AND u.branch_id IS NOT DISTINCT FROM b.branch_scope
   AND s.id=NEW.session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
   AND (u.role='SUPER_ADMIN' OR u.branch_id=l.branch_id AND (u.role='MANAGER' OR u.role='AGENT' AND l.assigned_agent_id=u.id))
   AND NEW.branch_id=l.branch_id AND NEW.campaign_id=l.campaign_id AND NEW.lead_version=l.version
   AND f.lead_id=l.id AND f.kind='HUMAN' AND f.status='OPEN' AND f.version=1 AND f.created_by=u.id AND ai_row_inserted_here(f.xmin)
   AND NEW.owner_user_id=f.owner_user_id AND owner.organization_id=l.organization_id AND owner.branch_id=l.branch_id
   AND owner.active AND owner.role IN ('MANAGER','AGENT') AND (u.role<>'AGENT' OR owner.id=u.id)
   AND h.follow_up_id=f.id AND h.actor_user_id=u.id AND h.event_type='CREATED' AND ai_row_inserted_here(h.xmin)
   AND h.detail->>'owner'=owner.id::text AND (h.detail->>'dueAt')::timestamptz=f.due_at
   AND h.detail->>'priority'=f.priority AND (h.detail->>'note') IS NOT DISTINCT FROM f.note
   AND EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=b.organization_id AND a.branch_id=l.branch_id AND a.actor_user_id=u.id
    AND a.action='FOLLOW_UP_CREATED' AND a.target_type='FOLLOW_UP' AND a.target_id=f.id::text AND ai_row_inserted_here(a.xmin))
   AND EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=b.organization_id AND a.branch_id=l.branch_id AND a.actor_user_id=u.id
    AND a.action='BULK_FOLLOW_UP_CREATED' AND a.target_type='FOLLOW_UP' AND a.target_id=f.id::text AND a.detail->>'batchId'=b.id::text
    AND a.detail->>'leadId'=l.id::text AND ai_row_inserted_here(a.xmin))
   AND EXISTS(SELECT 1 FROM lead_activity a WHERE a.lead_id=l.id AND a.actor_user_id=u.id AND a.event_type='FOLLOW_UP_CREATED'
    AND a.detail->>'followUpId'=f.id::text AND ai_row_inserted_here(a.xmin))
 ) THEN RAISE EXCEPTION 'BULK_RECEIPT_PROOF';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bulk_follow_up_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON bulk_follow_up_receipt
 FOR EACH ROW EXECUTE FUNCTION bulk_follow_up_receipt_guard();
CREATE FUNCTION bulk_follow_up_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM bulk_follow_up_receipt r WHERE r.history_id=OLD.id) THEN RAISE EXCEPTION 'BULK_HISTORY_IMMUTABLE';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER bulk_follow_up_history_guard BEFORE UPDATE OR DELETE ON follow_up_history
 FOR EACH ROW EXECUTE FUNCTION bulk_follow_up_history_guard();
