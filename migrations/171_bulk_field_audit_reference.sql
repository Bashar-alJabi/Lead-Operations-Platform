-- audit_log.target_id is a textual historical reference; keep its native type.
CREATE OR REPLACE FUNCTION bulk_field_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
    AND a.branch_id=l.branch_id AND a.action='BULK_FIELD_UPDATED' AND a.target_type='LEAD' AND a.target_id=l.id::text
    AND a.detail->>'batchId'=b.id::text AND a.detail->>'fieldId'=fd.id::text AND ai_row_inserted_here(a.xmin))
 ) THEN RAISE EXCEPTION 'BULK_RECEIPT_PROOF';END IF;
 RETURN NEW;
END $$;
