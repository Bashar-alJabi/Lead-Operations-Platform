-- A Contact can be edited without updating its Leads. Bind the actual recipient without retaining its value in the snapshot.
ALTER FUNCTION ai_initial_intake_context(uuid,timestamptz) RENAME TO ai_initial_intake_base_context;
CREATE FUNCTION ai_initial_intake_context(rid uuid,at_time timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_set(ctx,'{contact}',ctx->'contact' || jsonb_build_object('version',ct.version,
   'recipientSha256',CASE WHEN ct.phone_normalized IS NOT NULL THEN encode(sha256(convert_to(ct.phone_normalized,'UTF8')),'hex') ELSE NULL END))
 FROM lead_intake_receipt r JOIN lead l ON l.id=r.lead_id LEFT JOIN contact ct ON ct.id=l.contact_id
 CROSS JOIN LATERAL (SELECT ai_initial_intake_base_context(rid,at_time) AS ctx) base WHERE r.id=rid AND ctx IS NOT NULL
$$;
-- Existing historical 154 snapshots are retained and cannot acquire this new current authority retroactively.
