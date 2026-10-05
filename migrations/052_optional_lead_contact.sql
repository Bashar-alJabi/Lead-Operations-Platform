-- A source may contain only Campaign fields. Preserve the operational Lead without fabricating a person.
ALTER TABLE lead ALTER COLUMN contact_id DROP NOT NULL;
