CREATE TABLE conversation_attention_review (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversation(id),
  previous_reason text NOT NULL,
  review_note text NOT NULL CHECK (length(review_note) BETWEEN 10 AND 2000),
  reviewed_by uuid NOT NULL REFERENCES user_account(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversation_attention_review_history_idx
  ON conversation_attention_review (conversation_id, id DESC);
