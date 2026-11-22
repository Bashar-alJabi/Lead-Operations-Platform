CREATE FUNCTION lead_calculated_field_values(target_lead uuid, lead_created_at timestamptz, requested text[],
  evaluated_at timestamptz DEFAULT statement_timestamp())
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  WITH facts AS (
    SELECT
      min(m.sent_at) FILTER (WHERE m.direction = 'OUTBOUND') AS first_platform_contact,
      min(m.sent_at) FILTER (WHERE m.direction = 'OUTBOUND' AND m.author_type = 'AI') AS first_ai_contact,
      min(m.sent_at) FILTER (WHERE m.direction = 'OUTBOUND' AND m.author_type = 'HUMAN') AS first_human_contact,
      max(coalesce(m.sent_at, m.received_at)) AS last_contact,
      count(m.sent_at) FILTER (WHERE m.direction = 'OUTBOUND' AND m.author_type = 'AI') AS ai_attempts,
      count(m.sent_at) FILTER (WHERE m.direction = 'OUTBOUND' AND m.author_type = 'HUMAN') AS human_attempts,
      min(m.received_at) FILTER (WHERE m.direction = 'INBOUND') AS first_inbound
    FROM conversation cv JOIN conversation_message m ON m.conversation_id = cv.id
    WHERE cv.lead_id = target_lead
      AND requested && ARRAY['FIRST_PLATFORM_CONTACT_AT', 'FIRST_AI_CONTACT_AT', 'FIRST_HUMAN_CONTACT_AT',
        'TIME_SINCE_LAST_CONTACT_SECONDS', 'AI_CONTACT_ATTEMPTS', 'HUMAN_CONTACT_ATTEMPTS', 'HUMAN_RESPONSE_SECONDS']
  )
  SELECT jsonb_object_agg(kind, CASE kind
    WHEN 'LEAD_AGE_DAYS' THEN to_jsonb(greatest(0, floor(extract(epoch FROM evaluated_at - lead_created_at) / 86400)))
    WHEN 'FIRST_PLATFORM_CONTACT_AT' THEN to_jsonb(to_char(first_platform_contact AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHEN 'FIRST_AI_CONTACT_AT' THEN to_jsonb(to_char(first_ai_contact AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHEN 'FIRST_HUMAN_CONTACT_AT' THEN to_jsonb(to_char(first_human_contact AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHEN 'TIME_SINCE_LAST_CONTACT_SECONDS' THEN CASE WHEN last_contact IS NOT NULL
      THEN to_jsonb(greatest(0, floor(extract(epoch FROM evaluated_at - date_trunc('milliseconds', last_contact))))) END
    WHEN 'AI_CONTACT_ATTEMPTS' THEN to_jsonb(ai_attempts)
    WHEN 'HUMAN_CONTACT_ATTEMPTS' THEN to_jsonb(human_attempts)
    WHEN 'HUMAN_RESPONSE_SECONDS' THEN (
      SELECT to_jsonb(floor(extract(epoch FROM date_trunc('milliseconds', min(m.sent_at))
        - date_trunc('milliseconds', facts.first_inbound))))
      FROM conversation cv JOIN conversation_message m ON m.conversation_id = cv.id
      WHERE cv.lead_id = target_lead AND m.direction = 'OUTBOUND' AND m.author_type = 'HUMAN' AND m.sent_at >= facts.first_inbound
    ) END)
  FROM facts CROSS JOIN unnest(requested) AS item(kind)
$$;
