-- Normalize immutable worksheet context once, without rewriting any captured original.
ALTER TABLE lead_import_dataset ADD COLUMN source_schema integer NOT NULL DEFAULT 1 CHECK(source_schema IN (1,2));
ALTER TABLE lead_import_dataset ALTER COLUMN source_schema SET DEFAULT 2;
CREATE TABLE lead_import_dataset_sheet (
 dataset_id uuid NOT NULL,file_id uuid NOT NULL,sheet_index integer NOT NULL,name text NOT NULL,headers jsonb NOT NULL CHECK(lead_import_cells_valid(headers,true)),
 header_row integer NOT NULL,row_count integer NOT NULL,mapping_version integer NOT NULL,
 PRIMARY KEY(dataset_id,sheet_index),FOREIGN KEY(dataset_id,file_id) REFERENCES lead_import_dataset(id,file_id),
 FOREIGN KEY(file_id,sheet_index,mapping_version) REFERENCES lead_import_mapping_revision(file_id,sheet_index,version)
);
-- Schema1 originals already retain these values. Historical extraction changes no source record.
INSERT INTO lead_import_dataset_sheet(dataset_id,file_id,sheet_index,name,headers,header_row,row_count,mapping_version)
 SELECT DISTINCT ON(d.id,s.import_sheet_index) d.id,d.file_id,s.import_sheet_index,s.raw_payload->'sheet'->>'name',s.raw_payload->'sheet'->'headers',
 (s.raw_payload->'sheet'->>'headerRow')::integer,
 (SELECT count(*)::int FROM lead_import_dataset_row dr WHERE dr.dataset_id=d.id AND dr.sheet_index=s.import_sheet_index),
 (s.raw_payload->'mapping'->>'version')::integer FROM lead_import_dataset d JOIN source_submission s ON s.import_dataset_id=d.id ORDER BY d.id,s.import_sheet_index,s.id;
ALTER TABLE source_submission ADD CONSTRAINT import_source_sheet FOREIGN KEY(import_dataset_id,import_sheet_index) REFERENCES lead_import_dataset_sheet(dataset_id,sheet_index);
CREATE FUNCTION lead_import_dataset_schema_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.source_schema<>2 THEN RAISE EXCEPTION 'IMPORT_DATASET_SCHEMA_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE TRIGGER lead_import_dataset_schema_guard BEFORE INSERT ON lead_import_dataset FOR EACH ROW EXECUTE FUNCTION lead_import_dataset_schema_guard();
CREATE FUNCTION lead_import_dataset_sheet_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d lead_import_dataset;r lead_import_review;sh lead_import_sheet;mv integer;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'IMPORT_DATASET_SHEET_IMMUTABLE';END IF;
 SELECT ds.* INTO d FROM lead_import_dataset ds WHERE ds.id=NEW.dataset_id AND ai_row_inserted_here(ds.xmin);
 SELECT * INTO r FROM lead_import_review WHERE id=d.review_id;
 SELECT * INTO sh FROM lead_import_sheet WHERE file_id=d.file_id AND sheet_index=NEW.sheet_index;
 SELECT (x->>'version')::integer INTO mv FROM jsonb_array_elements(r.selection) x WHERE (x->>'sheet')::integer=NEW.sheet_index;
 IF d.id IS NULL OR sh.file_id IS NULL OR NEW.mapping_version IS DISTINCT FROM mv
  OR (NEW.file_id,NEW.name,NEW.headers,NEW.header_row,NEW.row_count) IS DISTINCT FROM (sh.file_id,sh.name,sh.headers,sh.header_row,sh.row_count)
  THEN RAISE EXCEPTION 'IMPORT_DATASET_SHEET_PROOF';END IF;RETURN NEW;
END $$;
CREATE TRIGGER lead_import_dataset_sheet_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_import_dataset_sheet FOR EACH ROW EXECUTE FUNCTION lead_import_dataset_sheet_guard();
CREATE FUNCTION lead_import_source_payload_v1(dataset_arg uuid,sheet_arg integer,row_arg integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('schema',1,'kind',CASE WHEN f.format='CSV' THEN 'CSV_IMPORT' ELSE 'EXCEL_IMPORT' END,
  'file',jsonb_build_object('id',f.id,'sha256',f.content_sha256,'label',f.label,'format',f.format,'delimiter',f.delimiter),
  'sheet',jsonb_build_object('index',s.sheet_index,'name',s.name,'headers',s.headers,'headerRow',s.header_row),
  'row',jsonb_build_object('number',raw.row_number,'cells',raw.cells),'mapping',jsonb_build_object('version',m.version,'entries',m.entries),'reviewId',r.id)
 FROM lead_import_dataset d JOIN lead_import_file f ON f.id=d.file_id JOIN lead_import_review r ON r.id=d.review_id
 JOIN lead_import_row raw ON raw.file_id=f.id AND raw.sheet_index=sheet_arg AND raw.row_number=row_arg
 JOIN lead_import_sheet s ON s.file_id=raw.file_id AND s.sheet_index=raw.sheet_index
 JOIN jsonb_array_elements(r.selection) selected ON (selected->>'sheet')::integer=s.sheet_index
 JOIN lead_import_mapping_revision m ON m.file_id=f.id AND m.sheet_index=s.sheet_index AND m.version=(selected->>'version')::integer WHERE d.id=dataset_arg
$$;
CREATE OR REPLACE FUNCTION lead_import_source_payload(dataset_arg uuid,sheet_arg integer,row_arg integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN d.source_schema=1 THEN lead_import_source_payload_v1(dataset_arg,sheet_arg,row_arg) ELSE
 jsonb_build_object('schema',2,'kind',CASE WHEN f.format='CSV' THEN 'CSV_IMPORT' ELSE 'EXCEL_IMPORT' END,
 'datasetId',d.id,'fileId',f.id,'sheetIndex',sh.sheet_index,'row',jsonb_build_object('number',raw.row_number,'cells',raw.cells),
 'mappingVersion',sh.mapping_version,'reviewId',d.review_id) END
 FROM lead_import_dataset d JOIN lead_import_file f ON f.id=d.file_id
 JOIN lead_import_dataset_sheet sh ON sh.dataset_id=d.id AND sh.sheet_index=sheet_arg
 JOIN lead_import_row raw ON raw.file_id=f.id AND raw.sheet_index=sh.sheet_index AND raw.row_number=row_arg WHERE d.id=dataset_arg
$$;
CREATE OR REPLACE FUNCTION lead_import_dataset_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;ready integer;skipped integer;invalid integer;dups integer;
BEGIN
 SELECT count(*)::integer,count(*) FILTER(WHERE disposition='READY_FOR_INTAKE')::integer,count(*) FILTER(WHERE disposition='SKIPPED')::integer,
 count(*) FILTER(WHERE disposition='INVALID')::integer,count(*) FILTER(WHERE duplicate)::integer INTO n,ready,skipped,invalid,dups FROM lead_import_dataset_row WHERE dataset_id=NEW.id;
 IF NOT COALESCE(lead_import_dataset_current(NEW),false) OR (n,ready,skipped,invalid,dups) IS DISTINCT FROM (NEW.total,NEW.ready_count,NEW.skipped_count,NEW.invalid_count,NEW.duplicate_count)
 OR n<>(SELECT count(*) FROM source_submission WHERE import_dataset_id=NEW.id)
 OR (SELECT count(*) FROM lead_import_dataset_sheet WHERE dataset_id=NEW.id)<>(SELECT jsonb_array_length(selection) FROM lead_import_review WHERE id=NEW.review_id)
 OR NEW.total<>(SELECT sum(row_count) FROM lead_import_dataset_sheet WHERE dataset_id=NEW.id)
 THEN RAISE EXCEPTION 'IMPORT_DATASET_COMPLETE_CAPTURE_REQUIRED';END IF;RETURN NEW;
END $$;
