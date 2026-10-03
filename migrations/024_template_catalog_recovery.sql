CREATE TABLE messaging_template_catalog_sync (
  connection_id uuid PRIMARY KEY REFERENCES integration_connection(id),
  connection_version integer NOT NULL,
  synced_at timestamptz NOT NULL
);
