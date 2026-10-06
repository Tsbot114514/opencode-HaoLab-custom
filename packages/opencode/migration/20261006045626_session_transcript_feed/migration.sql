CREATE TABLE `session_transcript_change` (
	`seq` integer PRIMARY KEY AUTOINCREMENT,
	`session_id` text NOT NULL,
	`generation` text NOT NULL,
	`kind` text NOT NULL,
	`message_id` text,
	`part_id` text
);
--> statement-breakpoint
CREATE TABLE `session_transcript_meta` (
	`id` integer PRIMARY KEY,
	`epoch` text NOT NULL,
	`seq` integer NOT NULL,
	`floor` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_transcript_state` (
	`session_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`directory` text NOT NULL,
	`workspace_id` text,
	`generation` text NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_transcript_change_session_generation_seq_idx` ON `session_transcript_change` (`session_id`,`generation`,`seq`);--> statement-breakpoint
CREATE INDEX `session_transcript_change_entity_seq_idx` ON `session_transcript_change` (`session_id`,`generation`,`kind`,`message_id`,`part_id`,`seq`);
--> statement-breakpoint
INSERT INTO session_transcript_meta (id,epoch,seq,floor) VALUES (1,lower(hex(randomblob(16))),0,0);
--> statement-breakpoint
INSERT INTO session_transcript_state (session_id,project_id,directory,workspace_id,generation,deleted)
SELECT id,project_id,directory,workspace_id,lower(hex(randomblob(16))),0 FROM session;
--> statement-breakpoint
CREATE TRIGGER session_transcript_insert AFTER INSERT ON session BEGIN
  INSERT INTO session_transcript_state (session_id,project_id,directory,workspace_id,generation,deleted)
  VALUES (NEW.id,NEW.project_id,NEW.directory,NEW.workspace_id,lower(hex(randomblob(16))),0)
  ON CONFLICT(session_id) DO UPDATE SET project_id=excluded.project_id,directory=excluded.directory,
    workspace_id=excluded.workspace_id,generation=excluded.generation,deleted=0;
  INSERT INTO session_transcript_change (session_id,generation,kind)
  SELECT session_id,generation,'session' FROM session_transcript_state WHERE session_id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER session_transcript_update AFTER UPDATE ON session BEGIN
  UPDATE session_transcript_state SET project_id=NEW.project_id,directory=NEW.directory,workspace_id=NEW.workspace_id,
    generation=CASE WHEN OLD.project_id IS NOT NEW.project_id OR OLD.directory IS NOT NEW.directory
      OR OLD.workspace_id IS NOT NEW.workspace_id THEN lower(hex(randomblob(16))) ELSE generation END
  WHERE session_id=NEW.id;
  INSERT INTO session_transcript_change (session_id,generation,kind)
  SELECT session_id,generation,'session' FROM session_transcript_state WHERE session_id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER session_transcript_delete AFTER DELETE ON session BEGIN
  UPDATE session_transcript_state SET deleted=1 WHERE session_id=OLD.id;
  INSERT INTO session_transcript_change (session_id,generation,kind)
  SELECT session_id,generation,'session' FROM session_transcript_state WHERE session_id=OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER message_transcript_insert AFTER INSERT ON message BEGIN
  INSERT INTO session_transcript_change (session_id,generation,kind,message_id)
  SELECT NEW.session_id,generation,'message',NEW.id FROM session_transcript_state WHERE session_id=NEW.session_id;
END;
--> statement-breakpoint
CREATE TRIGGER message_transcript_update AFTER UPDATE ON message
WHEN OLD.data IS NOT NEW.data OR OLD.session_id IS NOT NEW.session_id OR OLD.id IS NOT NEW.id
  OR OLD.time_created IS NOT NEW.time_created OR OLD.time_updated IS NOT NEW.time_updated
BEGIN
  INSERT INTO session_transcript_change (session_id,generation,kind,message_id)
  SELECT OLD.session_id,generation,'message',OLD.id FROM session_transcript_state
  WHERE session_id=OLD.session_id AND (OLD.session_id IS NOT NEW.session_id OR OLD.id IS NOT NEW.id);
  INSERT INTO session_transcript_change (session_id,generation,kind,message_id)
  SELECT NEW.session_id,generation,'message',NEW.id FROM session_transcript_state WHERE session_id=NEW.session_id;
END;
--> statement-breakpoint
CREATE TRIGGER message_transcript_delete AFTER DELETE ON message BEGIN
  INSERT INTO session_transcript_change (session_id,generation,kind,message_id)
  SELECT OLD.session_id,generation,'message',OLD.id FROM session_transcript_state WHERE session_id=OLD.session_id;
END;
--> statement-breakpoint
CREATE TRIGGER part_transcript_insert AFTER INSERT ON part BEGIN
  INSERT INTO session_transcript_change (session_id,generation,kind,message_id,part_id)
  SELECT NEW.session_id,generation,'part',NEW.message_id,NEW.id FROM session_transcript_state WHERE session_id=NEW.session_id;
END;
--> statement-breakpoint
CREATE TRIGGER part_transcript_update AFTER UPDATE ON part
WHEN OLD.data IS NOT NEW.data OR OLD.session_id IS NOT NEW.session_id OR OLD.message_id IS NOT NEW.message_id
  OR OLD.id IS NOT NEW.id OR OLD.time_created IS NOT NEW.time_created OR OLD.time_updated IS NOT NEW.time_updated
BEGIN
  INSERT INTO session_transcript_change (session_id,generation,kind,message_id,part_id)
  SELECT OLD.session_id,generation,'part',OLD.message_id,OLD.id FROM session_transcript_state
  WHERE session_id=OLD.session_id AND (OLD.session_id IS NOT NEW.session_id OR OLD.message_id IS NOT NEW.message_id OR OLD.id IS NOT NEW.id);
  INSERT INTO session_transcript_change (session_id,generation,kind,message_id,part_id)
  SELECT NEW.session_id,generation,'part',NEW.message_id,NEW.id FROM session_transcript_state WHERE session_id=NEW.session_id;
END;
--> statement-breakpoint
CREATE TRIGGER part_transcript_delete AFTER DELETE ON part BEGIN
  INSERT INTO session_transcript_change (session_id,generation,kind,message_id,part_id)
  SELECT OLD.session_id,generation,'part',OLD.message_id,OLD.id FROM session_transcript_state WHERE session_id=OLD.session_id;
END;
--> statement-breakpoint
CREATE TRIGGER session_transcript_retention AFTER INSERT ON session_transcript_change BEGIN
  UPDATE session_transcript_meta SET seq=NEW.seq,floor=max(floor,NEW.seq-65536) WHERE id=1;
  DELETE FROM session_transcript_state WHERE deleted=1
    AND session_id IN (SELECT session_id FROM session_transcript_change WHERE seq <= (SELECT floor FROM session_transcript_meta WHERE id=1))
    AND NOT EXISTS (SELECT 1 FROM session_transcript_change c WHERE c.session_id=session_transcript_state.session_id
      AND c.seq > (SELECT floor FROM session_transcript_meta WHERE id=1));
  DELETE FROM session_transcript_change WHERE seq <= (SELECT floor FROM session_transcript_meta WHERE id=1);
END;
