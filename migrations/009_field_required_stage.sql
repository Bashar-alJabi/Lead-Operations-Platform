UPDATE campaign_field SET required_stage = 'LEAD_CREATION' WHERE required AND required_stage = 'NONE';
ALTER TABLE campaign_field DROP COLUMN required;
