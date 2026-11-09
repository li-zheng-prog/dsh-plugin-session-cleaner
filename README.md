# dsh-plugin-session-cleaner

Manually and permanently delete saved sessions by exact session ID from the DeepSeek Harness sidebar.

## Usage

- Hover over a session in the sidebar and click the trash button at the end of the row.
- Alternatively, click **Session Cleaner** (the trash icon below **Automations**) in the global panel at the top of the sidebar. The main area lists regular sessions, subagent sessions, and workspaces separately. Click the trash button on a row to open a confirmation dialog.
- Removing a workspace only removes its Harness registration; files on disk and sessions are preserved. Deleting a subagent session also handles its descendant subagent sessions and their session-specific descriptions; shared configuration is preserved.
- The dialog displays the session name and **full session ID**. Click **Permanently Delete** to delete it, or schedule deletion for the next startup if the session is in use.

Deletion removes the session's log directory, projection cache records, workspace session references, and pin/archive bookkeeping. It **does not** delete workspace files, shared attachments, or other sessions.

## Sessions opened during the current run

Harness 0.2.1-rc.3 has no API to close a session or release its agent. **Sessions opened during the current run remain held by the agent until the process exits**; switching conversations does not release them. Such sessions cannot be safely deleted while Harness is running.

The plugin handles them as follows:

1. Click **Permanently Delete** in the confirmation dialog. If the current run holds the session, it is automatically added to `<DSH_HOME>/session-cleaner/pending.json`.
2. On the next Harness startup, the plugin deletes queued sessions during host activation, **before the web interface loads**, and waits for deletion to finish before activation completes. This prevents the desktop client from reopening them first when it restores the last opened session. If a session is still in use, for example by another process that is exiting, it remains queued for the next startup.

> Deletion must happen immediately during activation because the desktop client restores the previous selection after startup. Once restored, Harness holds the session for the lifetime of the process and rejects deletion. Waiting until startup finishes could therefore leave the session undeletable on every restart.

Sessions that have never been opened during the current run are **deleted immediately**, without entering the queue.

## Safety boundaries

- Accepts only local requests initiated by the plugin interface, with a confirmation header, a JSON body, and a second confirmation of the exact ID. Cross-origin requests are rejected.
- Acquires the storage layer's cross-process write lock (a Windows kernel semaphore) before deletion, preventing accidental deletion of sessions another Harness process is writing.
- Rejects sessions that are running and does not stop any tasks.
- Deleting a regular session does not automatically delete related sessions. Deleting a session from the subagent section includes its descendant subagent sessions.
- Before deleting a directory, verifies that its path has the form `<storage-root>/<project-key>/<session-id>/` and rejects symbolic links and paths outside the expected root.

## Known limitations

- Sessions opened during the current run can only be deleted on the next startup because of Harness runtime ownership. The plugin deletes them during host activation, before the web interface loads. Sessions still held by another process remain in the queue for a later startup.
- If file deletion succeeds but cache or bookkeeping cleanup fails, the plugin returns a warning; the session itself has already been deleted from disk.
- The plugin depends on the JSONL persistence backend interface of the current Harness version and must be revalidated after a Harness upgrade.

## Installation

```powershell
dsh plugin --profile desktop add .   # Or install this directory using the plugin manager.
```

## License

This project is licensed under the [MIT License](LICENSE).
