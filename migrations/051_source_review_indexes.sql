-- Review uses immutable submission time cursors, separately from processing status/update time.
CREATE INDEX source_submission_connection_time_idx ON source_submission (connection_id,created_at DESC,id DESC);
CREATE INDEX source_submission_organization_time_idx ON source_submission (organization_id,created_at DESC,id DESC);
