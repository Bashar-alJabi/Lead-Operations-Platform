ALTER TABLE source_submission
  ADD CONSTRAINT source_submission_campaign_branch_fk FOREIGN KEY (campaign_id, branch_id) REFERENCES campaign(id, branch_id),
  ADD CONSTRAINT source_submission_resolution_contact_org_fk FOREIGN KEY (resolution_contact_id, organization_id) REFERENCES contact(id, organization_id),
  ADD CONSTRAINT source_submission_campaign_requires_branch CHECK (campaign_id IS NULL OR branch_id IS NOT NULL);

CREATE INDEX contact_name_prefix_idx ON contact (organization_id, (lower(name)) text_pattern_ops);
CREATE INDEX contact_phone_prefix_idx ON contact (organization_id, phone_normalized text_pattern_ops) WHERE phone_normalized IS NOT NULL;
CREATE INDEX contact_email_prefix_idx ON contact (organization_id, email_normalized text_pattern_ops) WHERE email_normalized IS NOT NULL;
