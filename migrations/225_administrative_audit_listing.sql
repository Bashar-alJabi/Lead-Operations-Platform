CREATE INDEX audit_organization_record_idx ON audit_log(organization_id,id DESC);
CREATE INDEX audit_branch_record_idx ON audit_log(organization_id,branch_id,id DESC);
