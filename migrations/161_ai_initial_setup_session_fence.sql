-- Revalidate the real operator while retaining account/session locks through configuration commit.
CREATE OR REPLACE FUNCTION lead_intake_human_allowed_scope(oid uuid,bid uuid,uid uuid,sid uuid) RETURNS boolean LANGUAGE plpgsql AS $$ DECLARE allowed boolean;BEGIN
 SELECT true INTO allowed FROM user_account u JOIN user_session ss ON ss.user_id=u.id
 WHERE u.id=uid AND u.organization_id=oid AND u.active AND ss.id=sid AND ss.revoked_at IS NULL AND ss.expires_at>clock_timestamp()
  AND (u.role='SUPER_ADMIN' OR u.role='MANAGER' AND u.branch_id=bid) FOR SHARE OF u,ss;
 RETURN COALESCE(allowed,false);
END $$;
