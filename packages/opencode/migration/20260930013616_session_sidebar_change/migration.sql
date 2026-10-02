CREATE TABLE `session_sidebar_change` (
	`seq` integer PRIMARY KEY AUTOINCREMENT,
	`session_id` text NOT NULL,
	`old_project_id` text,
	`old_directory` text,
	`old_parent_id` text,
	`old_time_archived` integer,
	`project_id` text,
	`directory` text,
	`parent_id` text,
	`time_archived` integer,
	`title` text,
	`time_created` integer,
	`time_updated` integer
);
--> statement-breakpoint
CREATE INDEX `session_sidebar_change_session_seq_idx` ON `session_sidebar_change` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `session_sidebar_change_project_directory_seq_idx` ON `session_sidebar_change` (`project_id`,`directory`,`seq`);--> statement-breakpoint
CREATE INDEX `session_sidebar_change_old_project_directory_seq_idx` ON `session_sidebar_change` (`old_project_id`,`old_directory`,`seq`);--> statement-breakpoint
INSERT INTO session_sidebar_change (session_id, project_id, directory, parent_id, time_archived, title, time_created, time_updated)
SELECT id, project_id, directory, parent_id, time_archived, title, time_created, time_updated FROM session;--> statement-breakpoint
CREATE TRIGGER session_sidebar_insert AFTER INSERT ON session BEGIN
  INSERT INTO session_sidebar_change (session_id, project_id, directory, parent_id, time_archived, title, time_created, time_updated)
  VALUES (NEW.id, NEW.project_id, NEW.directory, NEW.parent_id, NEW.time_archived, NEW.title, NEW.time_created, NEW.time_updated);
END;--> statement-breakpoint
CREATE TRIGGER session_sidebar_update AFTER UPDATE ON session
WHEN OLD.project_id IS NOT NEW.project_id OR OLD.directory IS NOT NEW.directory
  OR OLD.parent_id IS NOT NEW.parent_id OR OLD.time_archived IS NOT NEW.time_archived
  OR OLD.title IS NOT NEW.title OR OLD.time_updated IS NOT NEW.time_updated
BEGIN
  INSERT INTO session_sidebar_change (session_id, old_project_id, old_directory, old_parent_id, old_time_archived,
    project_id, directory, parent_id, time_archived, title, time_created, time_updated)
  VALUES (NEW.id, OLD.project_id, OLD.directory, OLD.parent_id, OLD.time_archived,
    NEW.project_id, NEW.directory, NEW.parent_id, NEW.time_archived, NEW.title, NEW.time_created, NEW.time_updated);
END;--> statement-breakpoint
CREATE TRIGGER session_sidebar_delete AFTER DELETE ON session BEGIN
  INSERT INTO session_sidebar_change (session_id, old_project_id, old_directory, old_parent_id, old_time_archived)
  VALUES (OLD.id, OLD.project_id, OLD.directory, OLD.parent_id, OLD.time_archived);
END;
