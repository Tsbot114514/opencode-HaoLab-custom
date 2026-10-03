CREATE TABLE `session_sidebar_count` (
	`project_id` text NOT NULL,
	`directory` text NOT NULL,
	`total` integer NOT NULL,
	CONSTRAINT `session_sidebar_count_pk` PRIMARY KEY(`project_id`, `directory`),
	CONSTRAINT "session_sidebar_count_nonnegative" CHECK("total" >= 0)
);--> statement-breakpoint
INSERT INTO session_sidebar_count (project_id, directory, total)
SELECT project_id, directory, count(*) FROM session
WHERE parent_id IS NULL AND time_archived IS NULL
GROUP BY project_id, directory;--> statement-breakpoint
CREATE TRIGGER session_sidebar_count_insert AFTER INSERT ON session
WHEN NEW.parent_id IS NULL AND NEW.time_archived IS NULL BEGIN
  INSERT INTO session_sidebar_count (project_id, directory, total)
  VALUES (NEW.project_id, NEW.directory, 1)
  ON CONFLICT (project_id, directory) DO UPDATE SET total = total + 1;
END;--> statement-breakpoint
CREATE TRIGGER session_sidebar_count_delete AFTER DELETE ON session
WHEN OLD.parent_id IS NULL AND OLD.time_archived IS NULL BEGIN
  UPDATE session_sidebar_count SET total = total - 1
  WHERE project_id = OLD.project_id AND directory = OLD.directory;
  DELETE FROM session_sidebar_count
  WHERE project_id = OLD.project_id AND directory = OLD.directory AND total = 0;
END;--> statement-breakpoint
CREATE TRIGGER session_sidebar_count_update_out AFTER UPDATE OF project_id, directory, parent_id, time_archived ON session
WHEN OLD.parent_id IS NULL AND OLD.time_archived IS NULL
  AND (NEW.parent_id IS NOT NULL OR NEW.time_archived IS NOT NULL
    OR OLD.project_id IS NOT NEW.project_id OR OLD.directory IS NOT NEW.directory) BEGIN
  UPDATE session_sidebar_count SET total = total - 1
  WHERE project_id = OLD.project_id AND directory = OLD.directory;
  DELETE FROM session_sidebar_count
  WHERE project_id = OLD.project_id AND directory = OLD.directory AND total = 0;
END;--> statement-breakpoint
CREATE TRIGGER session_sidebar_count_update_in AFTER UPDATE OF project_id, directory, parent_id, time_archived ON session
WHEN NEW.parent_id IS NULL AND NEW.time_archived IS NULL
  AND (OLD.parent_id IS NOT NULL OR OLD.time_archived IS NOT NULL
    OR OLD.project_id IS NOT NEW.project_id OR OLD.directory IS NOT NEW.directory) BEGIN
  INSERT INTO session_sidebar_count (project_id, directory, total)
  VALUES (NEW.project_id, NEW.directory, 1)
  ON CONFLICT (project_id, directory) DO UPDATE SET total = total + 1;
END;
