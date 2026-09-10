CREATE TABLE revision_seals (
  revision_id uuid PRIMARY KEY REFERENCES revisions(id)
);
INSERT INTO revision_seals SELECT id FROM revisions;
CREATE TRIGGER revision_seals_immutable BEFORE UPDATE OR DELETE ON revision_seals FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE FUNCTION reject_sealed_revision_append() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM revision_seals WHERE revision_id=NEW.revision_id) THEN
    RAISE EXCEPTION 'immutable revision relationships';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revision_tags_sealed BEFORE INSERT ON revision_tags FOR EACH ROW EXECUTE FUNCTION reject_sealed_revision_append();
CREATE TRIGGER relations_sealed BEFORE INSERT ON relations FOR EACH ROW EXECUTE FUNCTION reject_sealed_revision_append();
CREATE TRIGGER provenance_sealed BEFORE INSERT ON provenance FOR EACH ROW EXECUTE FUNCTION reject_sealed_revision_append();
CREATE TRIGGER revision_blobs_sealed BEFORE INSERT ON revision_blobs FOR EACH ROW EXECUTE FUNCTION reject_sealed_revision_append();
ALTER TABLE records ADD FOREIGN KEY(current_revision) REFERENCES revision_seals(revision_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE records ADD FOREIGN KEY(published_revision) REFERENCES revision_seals(revision_id) DEFERRABLE INITIALLY DEFERRED;
