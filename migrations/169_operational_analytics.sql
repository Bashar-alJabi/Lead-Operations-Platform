-- Read projection only: financial truth and Enrollment authority remain in their existing guards.
CREATE VIEW analytics_payment_fact AS
 SELECT p.id,p.state,p.confirmed_at,p.created_at,p.provider,p.mode,
  COALESCE(i.organization_id,b.organization_id) AS organization_id,
  COALESCE(i.lead_id,b.lead_id) AS lead_id,
  COALESCE(i.amount,b.amount)::numeric AS amount,
  COALESCE(i.currency,b.currency) AS currency
 FROM payment_record p LEFT JOIN payment_link_intent i ON i.id=p.intent_id
 LEFT JOIN bank_transfer_request b ON b.id=p.bank_request_id;

CREATE INDEX lead_org_cohort_page ON lead(organization_id,created_at DESC,id DESC);
CREATE INDEX lead_agent_cohort_page ON lead(assigned_agent_id,branch_id,created_at DESC,id DESC);
CREATE INDEX analytics_message_outbound ON conversation_message(conversation_id,author_type,sent_at)
 INCLUDE(author_user_id) WHERE direction='OUTBOUND' AND sent_at IS NOT NULL;
CREATE INDEX analytics_message_inbound ON conversation_message(conversation_id,received_at)
 WHERE direction='INBOUND' AND received_at IS NOT NULL;
CREATE INDEX analytics_conversation_state ON conversation(lead_id,state,controller_type);
CREATE INDEX analytics_follow_up_state ON follow_up(lead_id,status,due_at);
