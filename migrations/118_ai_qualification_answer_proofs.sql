-- Tighten terminal error nullability without modifying an applied migration.
ALTER TABLE ai_customer_action ADD CONSTRAINT ai_action_error_required CHECK ((state='BLOCKED')=(error_code IS NOT NULL));
