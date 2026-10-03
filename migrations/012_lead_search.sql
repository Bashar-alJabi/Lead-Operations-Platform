CREATE INDEX follow_up_open_lead_due_idx ON follow_up (lead_id, due_at) WHERE status = 'OPEN';
CREATE INDEX lead_field_value_lookup_idx ON lead_field_value (field_id, md5(value::text));
