-- Connection health describes provider reachability, not the implementation milestone.
UPDATE integration_connection SET last_error_code=NULL,status='CONNECTED',updated_at=now()
  WHERE kind='META' AND provider='META_LEAD_ADS' AND status='WARNING' AND last_error_code='INTAKE_NOT_CONFIGURED';
UPDATE integration_connection SET capabilities=capabilities-'intakeReady'
  WHERE kind='META' AND provider='META_LEAD_ADS' AND capabilities ? 'intakeReady';
CREATE INDEX source_binding_connection_cursor_idx ON source_campaign_binding (connection_id,id);
CREATE INDEX source_binding_campaign_cursor_idx ON source_campaign_binding (campaign_id,id);
