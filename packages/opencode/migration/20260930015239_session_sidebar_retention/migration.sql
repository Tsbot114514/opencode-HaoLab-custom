CREATE TABLE `session_sidebar_base` (
	`session_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`directory` text NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`version` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_sidebar_state` (
	`id` integer PRIMARY KEY,
	`seq` integer NOT NULL,
	`floor` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `session_sidebar_change` ADD `slug` text;--> statement-breakpoint
ALTER TABLE `session_sidebar_change` ADD `version` text;--> statement-breakpoint
CREATE INDEX `session_sidebar_base_project_directory_id_idx` ON `session_sidebar_base` (`project_id`,`directory`,`session_id`);--> statement-breakpoint
DROP TRIGGER session_sidebar_insert;--> statement-breakpoint
DROP TRIGGER session_sidebar_update;--> statement-breakpoint
DROP TRIGGER session_sidebar_delete;--> statement-breakpoint
INSERT INTO session_sidebar_state (id, seq, floor)
SELECT 1, coalesce(max(seq), 0), coalesce(max(seq), 0) FROM session_sidebar_change;--> statement-breakpoint
INSERT INTO session_sidebar_base (session_id, project_id, directory, title, slug, version, time_created, time_updated)
SELECT id, project_id, directory, title, slug, version, time_created, time_updated FROM session
WHERE parent_id IS NULL AND time_archived IS NULL;--> statement-breakpoint
DELETE FROM session_sidebar_change;--> statement-breakpoint
CREATE TRIGGER session_sidebar_insert AFTER INSERT ON session BEGIN
  INSERT INTO session_sidebar_change (session_id, project_id, directory, parent_id, time_archived, title, slug, version, time_created, time_updated)
  VALUES (NEW.id, NEW.project_id, NEW.directory, NEW.parent_id, NEW.time_archived, NEW.title, NEW.slug, NEW.version, NEW.time_created, NEW.time_updated);
END;--> statement-breakpoint
CREATE TRIGGER session_sidebar_update AFTER UPDATE ON session
WHEN OLD.project_id IS NOT NEW.project_id OR OLD.directory IS NOT NEW.directory
  OR OLD.parent_id IS NOT NEW.parent_id OR OLD.time_archived IS NOT NEW.time_archived
  OR OLD.title IS NOT NEW.title OR OLD.slug IS NOT NEW.slug OR OLD.version IS NOT NEW.version
  OR OLD.time_updated IS NOT NEW.time_updated
BEGIN
  INSERT INTO session_sidebar_change (session_id, old_project_id, old_directory, old_parent_id, old_time_archived,
    project_id, directory, parent_id, time_archived, title, slug, version, time_created, time_updated)
  VALUES (NEW.id, OLD.project_id, OLD.directory, OLD.parent_id, OLD.time_archived,
    NEW.project_id, NEW.directory, NEW.parent_id, NEW.time_archived, NEW.title, NEW.slug, NEW.version, NEW.time_created, NEW.time_updated);
END;--> statement-breakpoint
CREATE TRIGGER session_sidebar_delete AFTER DELETE ON session BEGIN
  INSERT INTO session_sidebar_change (session_id, old_project_id, old_directory, old_parent_id, old_time_archived)
  VALUES (OLD.id, OLD.project_id, OLD.directory, OLD.parent_id, OLD.time_archived);
END;--> statement-breakpoint
CREATE TRIGGER session_sidebar_retention AFTER INSERT ON session_sidebar_change BEGIN
  UPDATE session_sidebar_state SET seq = NEW.seq WHERE id = 1;
  DELETE FROM session_sidebar_base WHERE session_id = (
    SELECT session_id FROM session_sidebar_change ORDER BY seq LIMIT 1
  ) AND NEW.seq - (SELECT floor FROM session_sidebar_state WHERE id = 1) > 512;
  INSERT INTO session_sidebar_base (session_id, project_id, directory, title, slug, version, time_created, time_updated)
  SELECT session_id, project_id, directory, title, slug, version, time_created, time_updated
  FROM session_sidebar_change
  WHERE seq = (SELECT min(seq) FROM session_sidebar_change)
    AND NEW.seq - (SELECT floor FROM session_sidebar_state WHERE id = 1) > 512
    AND project_id IS NOT NULL AND parent_id IS NULL AND time_archived IS NULL
  ON CONFLICT (session_id) DO UPDATE SET project_id=excluded.project_id, directory=excluded.directory,
    title=excluded.title, slug=excluded.slug, version=excluded.version,
    time_created=excluded.time_created, time_updated=excluded.time_updated;
  UPDATE session_sidebar_state SET floor = (SELECT min(seq) FROM session_sidebar_change)
  WHERE id = 1 AND NEW.seq - floor > 512;
  DELETE FROM session_sidebar_change WHERE seq = (SELECT floor FROM session_sidebar_state WHERE id = 1);
END;
