# Independent Workspace Backup

This standalone, opt-in script preserves raw SQLite rows and streams workspace/session
files into a verified ZIP. It does not change application backup code or call migration,
restore, or backup APIs. **Its independent format v3 is not an import contract supported
by the installed application.** There is no restore command here.

## Before Running

- Obtain authorization to independently read the source database and files. This is not
  a workaround for a refused application migration API or permission restriction.
- Stop all work in the source workspace and its descendants. Run from a management
  terminal/session outside the source. Keep the local desktop API running and idle.
- Use Node.js 24 or newer and install this repository's existing dependencies. Bun is
  not the runtime for this script; no new dependency is needed.
- Choose an existing output parent outside both the workspace and global app data.
  Allow disk space for the ZIP plus two standalone database copies and metadata.
- Backups are **unencrypted**. Workspace/session files may contain credentials or other
  secrets. Manifest/report contain local paths, session IDs, filenames and source schema.
  Protect the destination and never commit generated backups, reports or connection files.

From `packages/opencode`, first inspect help:

```sh
node script/backup-workspace.mjs --help
```

After reviewing the scope, substitute your own authorized local paths:

```sh
node script/backup-workspace.mjs --directory <workspace> --output <existing-backup-parent> --connection <sidecar.json> --name workspace
```

Angle-bracket placeholders are not literal shell arguments. The optional connection
default is the desktop `ai.opencode.desktop/sidecar.json` under Windows roaming app
data, macOS Application Support, or Linux XDG data home. Use `--connection` when the
installation differs. Only loopback HTTP(S) APIs are accepted; redirects are refused.
Connection credentials are used for authenticated read requests, not included in reports.

`--database <trusted-source.db>` explicitly selects a database. Otherwise the only
candidate is `paths.data/opencode.db` from `/path`; the script never searches arbitrary
databases. Both modes require a nonempty in-scope API session list matching IDs,
directories and update times in the database snapshot. This is evidence of correspondence,
not proof of database identity; choose the explicit path if there is ambiguity.

## Scope And Consistency

Selection uses local-OS path membership, including descendants, child and archived
sessions. Windows comparisons are case-insensitive; POSIX comparisons are case-sensitive.
Only the six source tables `project`, `session`, `message`, `part`, `todo`, and
`session_message` are copied; project rows are limited to referenced parents. Exact
native SQLite text, integer, float, blob and null values are retained, including large
JSON strings without parsing or reserializing them. Source table DDL is trusted and copied;
triggers, secondary indexes, migrations and other tables are not copied. The script never
opens an input archive or executes archive-supplied SQL. An unsupported schema fails closed.

Files include the workspace, selected `session/<id>` directories, and selected
`storage/session_diff/<id>.json`. Missing session directories/diffs are legitimate and
recorded rather than fabricated. Existing empty directories are retained. An existing
`.opencode-project.json` identity is reused; otherwise an identity marker is generated
**only inside the archive**, never in the source.

Directory exclusions: `.git`, `node_modules`, `.cache`, `.next`, `.turbo`, `__pycache__`,
`.venv`, `venv`. Symlinks outside excluded directories, hard-linked files and special
files are refused. No unrelated sessions, global credentials tables, `session_share`, or
event journals are exported. Ordinary files are not scanned for secrets or ignored by
`.gitignore`. Review source contents before authorizing a backup.

Database reads use one read-only SQLite transaction. Files stream afterwards with
before/after size, modification and change-time checks. API statuses are checked before
and after, resolving active sessions and rejecting those inside the source descendants.
This does not lock the live application: transient activity, new files, or adversarial
filesystem replacement can evade metadata checks. Quiesce the source; this is not a
volume-level atomic snapshot, a hostile-filesystem sandbox, or a live migration protocol.
Filesystem permissions, ownership, ACLs and extended attributes are not preserved.

## Output And Verification

A unique timestamped directory holds `sessions.sqlite`, `manifest.json`,
`verified-extracted-sessions.sqlite`, `<name>.opencode-project.zip.report.json`, and the ZIP.
The ZIP is written as `.partial` and renamed only after verification. Failed attempts
may retain diagnostic artifacts and `FAILED.json`; a report without the final ZIP is not
a published backup. Existing destinations are not reused. No automatic deletion occurs.

The ZIP root is `manifest.json`, `sessions.sqlite`, `workspace/`, `sessions/<id>/`, and
`diffs/<id>.json`. Manifest fields are `format=opencode-project`, `version=3`, and
`transport=sqlite`. Both the copied and ZIP-extracted database receive `quick_check`,
foreign-key validation, complete table counts and framed-cell SHA-256 verification.
Every ZIP entry is reread with CRC and SHA-256 checking; the complete archive also gets
a SHA-256. Reports contain aggregates and file hashes, never an array of database rows.

`framed-cells-v1`: each row starts with ASCII `R<columnCount>:`; each cell starts with
`<tag><byteLength>:` followed by its payload. Tags: N=null/empty, T=UTF-8 text,
I=decimal integer, F=8-byte big-endian IEEE754, B=raw blob. Columns follow source
`PRAGMA table_info`; selected IDs are sorted and rows use primary-key order.

The default individual-file and total uncompressed payload cap is 10 GiB, including
SQLite and ZIP metadata. Override deliberately with `--max-bytes <positive-integer>`.
The cap is not a peak-memory or total disk-space limit: a large SQLite cell is materialized
by the native driver; database copies and compression require extra resources.

## Synthetic Tests

```sh
node --test script/backup-workspace.test.mjs
```

Tests create disposable databases and a fake loopback API, not real-user backups.
