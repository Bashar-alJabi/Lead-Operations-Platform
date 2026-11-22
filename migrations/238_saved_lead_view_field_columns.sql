ALTER TABLE saved_lead_view ADD COLUMN field_columns uuid[];
ALTER TABLE saved_lead_view ADD CONSTRAINT saved_lead_view_field_columns_bound
  CHECK(field_columns IS NULL OR (cardinality(field_columns)<=12 AND coalesce(array_ndims(field_columns),1)=1 AND array_position(field_columns,NULL) IS NULL
    AND (cardinality(field_columns)=0 OR (scope<>'ORGANIZATION' AND filters ? 'campaignId'))));
