/** @jsxImportSource preact */
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { resolveClient, type ClientMode } from "../lib/app/client";
import {
  createFolder,
  describeSetError,
  destroyNode,
  downloadNode,
  filesAccounts,
  loadDirectories,
  loadDirectory,
  moveNode,
  planUploads,
  renameNode,
  uploadFile,
  type DirectoryPage,
  type FilesAccount,
} from "../lib/files/api";
import { describeCount, formatSize, formatType, formatWhen } from "../lib/files/format";
import { nameProblem } from "../lib/files/names";
import {
  ATTACHMENTS_ROLE,
  ATTACHMENTS_ROLE_NOTE,
  CHILD_PAGE_SIZE,
  FILENODE_CAPABILITY,
  NO_CAPABILITY_NOTE,
  NO_SOURCE_LINK_NOTE,
  NO_WRITE_SCOPE_NOTE,
  PARTIAL_SORT_NOTE,
  describeListing,
} from "../lib/files/scope";
import { ROOT_CRUMB, moveTargets, type Crumb } from "../lib/files/tree";
import type { FileNode, FileWriteResult } from "../lib/files/types";
import { FILENODE_CAP, hasCapability } from "../lib/jmap/capabilities";
import type { JmapClient } from "../lib/jmap/JmapClient";
import type { Session } from "../lib/jmap/types";

// The Files section (s03.C T3, over s03.B's FileNode collection).
//
// This file renders and decides nothing. Every rule lives in `lib/files/*` as a
// pure function with tests — the split s03.C settled on and `ContactsApp.tsx`
// restates: vitest runs in plain Node with no jsdom, so a rule living in a
// `.tsx` island is a rule with no test. Breadcrumbs, sort order, name checks,
// collision renaming, size formatting and the whole demo backend are all over
// there; what is left here is state and markup.
//
// Four things this screen does deliberately:
//
//  • **Upload is upload-then-create, always in that order** (`lib/files/api.ts`
//    header). A failed upload leaves NO node and keeps the user's selection, so
//    Retry is a real button rather than "drag them in again".
//  • **The file input is not a fallback.** Drag-and-drop is the flourish; the
//    `<input type="file">` is the path that works with a keyboard, a screen
//    reader, and a trackpad that does not drag. Both go through one function.
//  • **`Attachments` is an ordinary folder.** The sidestep's role directory
//    (`services/ingest/src/sidestep.ts`) gets a pill and a sentence explaining
//    where its contents came from, and nothing else — no special pane, no
//    pinned position.
//  • **Refusals become sentences.** A scope failure hides the controls it
//    refuses and says why, instead of leaving buttons that always fail.

interface Props {
  /** Injected in tests; the screen resolves its own otherwise (invariant §6.1). */
  client?: JmapClient;
  /** Injected in tests so the demo knobs can be driven without a browser URL. */
  search?: string;
}

interface UploadRow {
  key: string;
  name: string;
  size: number;
  /**
   * `uploading` covers both halves of the round trip. There is no separate
   * "filing" state because `uploadFile` is one call from here, and inventing a
   * transition the code cannot actually observe would be a progress bar that
   * lies. `fetch` cannot report upload bytes without dropping to XHR, so this
   * is a busy state, honestly labelled, rather than a percentage.
   */
  status: "waiting" | "uploading" | "done" | "failed";
  message?: string;
  /** Kept so Retry does not need the user to pick the file again. */
  file: File;
  /** The name the plan assigned, if it had to change to dodge a collision. */
  renamedFrom?: string;
}

export default function FilesApp({ client: injected, search }: Props) {
  const [client, setClient] = useState<JmapClient | undefined>(injected);
  const [mode, setMode] = useState<ClientMode>("live");
  const [modeReason, setModeReason] = useState<string | undefined>(undefined);
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [fatal, setFatal] = useState<string | undefined>(undefined);

  const [accounts, setAccounts] = useState<FilesAccount[]>([]);
  const [accountId, setAccountId] = useState<string>("");

  const [dirId, setDirId] = useState<string | null>(null);
  const [page, setPage] = useState<DirectoryPage | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(CHILD_PAGE_SIZE);

  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const [folderName, setFolderName] = useState("");
  const [folderProblem, setFolderProblem] = useState<string | undefined>(undefined);

  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [dropping, setDropping] = useState(false);

  const [directories, setDirectories] = useState<FileNode[] | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | undefined>(undefined);
  /** Set once the server has actually refused a write, so controls can go. */
  const [writeRefused, setWriteRefused] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  // ── bootstrap ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let active = injected;
        if (!active) {
          const resolved = resolveClient();
          // No session → the door, never a convincing drive of files that do
          // not exist (../lib/app/client.ts:50-62).
          if (resolved.mode === "unauthenticated") {
            location.assign("/login");
            return;
          }
          if (resolved.mode === "demo") {
            // Demo-only, and loaded on demand so the fixture drive is never in
            // a live bundle (the pattern `CalendarView.tsx` established).
            const { filesDemoClient } = await import("../lib/files/demoFiles");
            active = filesDemoClient(resolved.demo.client, search ?? location.search);
          } else {
            active = resolved.client;
          }
          if (!cancelled) {
            setMode(resolved.mode);
            setModeReason(resolved.reason);
          }
        }
        const live = await active.session();
        if (cancelled) return;
        // NOT `primaryAccountId()`: for a grant-reached principal the primary
        // is "" and that call throws (../lib/files/api.ts `filesAccounts`).
        const reachable = filesAccounts(live);
        setClient(active);
        setSession(live);
        setAccounts(reachable);
        setAccountId(reachable[0]?.id ?? "");
      } catch (err) {
        if (!cancelled) setFatal(message(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [injected, search]);

  // ── the current directory ───────────────────────────────────────────────
  useEffect(() => {
    if (!client || !accountId) return;
    let cancelled = false;
    setLoading(true);
    void loadDirectory(client, accountId, dirId, { limit })
      .then((result) => {
        if (cancelled) return;
        setPage(result);
        // Selection survives a refresh only if the item is still here.
        setSelectedId((current) =>
          current && result.children.some((n) => n.id === current) ? current : undefined,
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A failure on the FIRST load means there is no screen to render, so
        // it is fatal. A failure on a later one means a refresh went wrong
        // while a perfectly good listing is still on screen — replacing that
        // with an error page loses the thing the person was working on.
        setPage((current) => {
          if (current) setToast(message(err));
          else setFatal(message(err));
          return current;
        });
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [client, accountId, dirId, limit, reloadKey]);

  // ── push sync: StateChange → re-query (never queryChanges) ──────────────
  // `FileNode/queryChanges` throws `cannotCalculateChanges` server-side
  // (filenode.ts:119-121), so re-querying is not laziness, it is the only
  // path — the same one the mail store takes.
  useEffect(() => {
    if (!client || !accountId) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void client
      .watch(() => refresh(), { accountId })
      .then((off) => (cancelled ? off() : (stop = off)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [client, accountId, refresh]);

  const children = page?.children ?? [];
  const selected = children.find((n) => n.id === selectedId);
  const readRefusal = page?.refusal;
  const canWrite = !readRefusal && !writeRefused;

  // ── reporting a write ───────────────────────────────────────────────────
  const report = useCallback(
    (result: FileWriteResult, subject: FileNode | null, ok: string): boolean => {
      if (result.refusal) {
        setToast(result.refusal.message);
        // A scope refusal is not transient: stop offering what cannot be done.
        if (result.refusal.type === "forbidden") setWriteRefused(true);
        return false;
      }
      if (result.error) {
        setToast(describeSetError(result.error, subject));
        return false;
      }
      setToast(ok);
      return true;
    },
    [],
  );

  // ── new folder ──────────────────────────────────────────────────────────
  const submitFolder = useCallback(async () => {
    if (!client || !accountId) return;
    // Validated here AND in `createFolder`, which is the one that counts —
    // this only decides whether to bother the server (`lib/files/names.ts`).
    const problem = nameProblem(folderName);
    setFolderProblem(problem ?? undefined);
    if (problem) return;
    setBusy(true);
    try {
      const result = await createFolder(client, accountId, dirId, folderName);
      if (result.error) {
        // The server's own refusal, rendered where the typing happened rather
        // than in a toast that vanishes.
        setFolderProblem(describeSetError(result.error, { name: folderName.trim() }));
        return;
      }
      if (report(result, null, `Folder “${folderName.trim()}” created.`)) {
        setFolderName("");
        setFolderProblem(undefined);
        refresh();
      }
    } catch (err) {
      setToast(message(err));
    } finally {
      setBusy(false);
    }
  }, [client, accountId, dirId, folderName, report, refresh]);

  // ── uploads ─────────────────────────────────────────────────────────────
  const runUploads = useCallback(
    async (files: File[]) => {
      if (!client || !accountId || files.length === 0) return;
      // Names are resolved against the folder AND against each other before
      // anything is sent (`planUploads`), so two identically named files in one
      // drop do not race for the same name.
      const planned = planUploads(
        files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
        children,
      );
      const rows: UploadRow[] = planned.map((p, i) => ({
        key: `${Date.now()}-${i}-${p.name}`,
        name: p.name,
        size: files[i]!.size,
        status: "waiting",
        file: files[i]!,
        ...(p.renamedFrom ? { renamedFrom: p.renamedFrom } : {}),
      }));
      setUploads((prev) => [...prev, ...rows]);

      const patch = (key: string, update: Partial<UploadRow>): void =>
        setUploads((prev) => prev.map((r) => (r.key === key ? { ...r, ...update } : r)));

      setBusy(true);
      try {
        // Sequential on purpose: a parallel fan-out of five 40 MB files is a
        // good way to make the tab, and the Worker, unhappy. The status column
        // is the progress signal — `fetch` cannot report upload bytes without
        // dropping to XHR, and lying with a fake bar would be worse.
        for (const row of rows) {
          patch(row.key, { status: "uploading" });
          const result = await uploadFile(client, accountId, dirId, {
            name: row.name,
            size: row.file.size,
            type: row.file.type,
            // The File itself — never read into a string or an array first, so
            // the browser streams it (`JmapClient.upload`).
            body: row.file,
          });
          if (result.refusal) {
            patch(row.key, { status: "failed", message: result.refusal.message });
            if (result.refusal.type === "forbidden") setWriteRefused(true);
            continue;
          }
          if (result.error) {
            patch(row.key, { status: "failed", message: describeSetError(result.error, null) });
            continue;
          }
          patch(row.key, { status: "done" });
        }
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [client, accountId, dirId, children, refresh],
  );

  const retryFailed = useCallback(() => {
    const failed = uploads.filter((r) => r.status === "failed");
    if (failed.length === 0) return;
    setUploads((prev) => prev.filter((r) => r.status !== "failed"));
    void runUploads(failed.map((r) => r.file));
  }, [uploads, runUploads]);

  // ── rename / move / delete ──────────────────────────────────────────────
  const submitRename = useCallback(async () => {
    if (!client || !accountId || !selected) return;
    setBusy(true);
    try {
      const result = await renameNode(client, accountId, selected.id, renameValue);
      if (report(result, selected, "Renamed.")) {
        setRenaming(false);
        refresh();
      }
    } finally {
      setBusy(false);
    }
  }, [client, accountId, selected, renameValue, report, refresh]);

  const submitMove = useCallback(
    async (target: string) => {
      if (!client || !accountId || !selected) return;
      setBusy(true);
      try {
        const parentId = target === "" ? null : target;
        if (report(await moveNode(client, accountId, selected.id, parentId), selected, "Moved.")) {
          setSelectedId(undefined);
          setDirectories(undefined);
          refresh();
        }
      } finally {
        setBusy(false);
      }
    },
    [client, accountId, selected, report, refresh],
  );

  const remove = useCallback(async () => {
    if (!client || !accountId || !selected) return;
    setBusy(true);
    try {
      // First try WITHOUT onDestroyRemoveChildren: the server's
      // `fileNodeHasChildren` refusal is the confirmation step, and it costs
      // nothing to let it be the thing that decides whether to ask.
      const first = await destroyNode(client, accountId, selected.id);
      if (!first.error && !first.refusal) {
        setToast("Deleted.");
        setSelectedId(undefined);
        refresh();
        return;
      }
      if (first.error?.type === "fileNodeHasChildren") {
        const sure = confirm(
          `“${selected.name}” is not empty.\n\n` +
            "Deleting it deletes everything inside it, and any share links pointing at those " +
            "files stop working. Cancel to keep it.",
        );
        if (!sure) return;
        if (report(await destroyNode(client, accountId, selected.id, true), selected, "Deleted.")) {
          setSelectedId(undefined);
          refresh();
        }
        return;
      }
      report(first, selected, "Deleted.");
    } finally {
      setBusy(false);
    }
  }, [client, accountId, selected, report, refresh]);

  /**
   * Get the bytes back out. Goes through `fetch` and an object URL because the
   * download route authenticates with a bearer HEADER, so a plain link cannot
   * carry the credential — see `downloadNode`'s note. The URL is revoked
   * immediately; leaking one pins the whole file in memory for the tab's life.
   */
  const download = useCallback(async () => {
    if (!client || !accountId || !selected) return;
    setBusy(true);
    try {
      const { bytes, name, type } = await downloadNode(client, accountId, selected);
      const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setToast(message(err));
    } finally {
      setBusy(false);
    }
  }, [client, accountId, selected]);

  const openMoveTargets = useCallback(async () => {
    if (!client || !accountId || directories) return;
    try {
      const { directories: dirs } = await loadDirectories(client, accountId);
      setDirectories(dirs);
    } catch (err) {
      setToast(message(err));
    }
  }, [client, accountId, directories]);

  const targets: Crumb[] = useMemo(
    () => (selected && directories ? moveTargets(directories, selected) : []),
    [selected, directories],
  );

  // ── render ──────────────────────────────────────────────────────────────

  if (fatal) {
    return (
      <main class="shell shell-error">
        <h1>Files are not reachable</h1>
        <p class="muted">{fatal}</p>
        <p class="muted">
          <a href="/login">Sign in again</a>, or append <code>?demo=1</code> to browse sample data.
        </p>
      </main>
    );
  }

  if (!client || !session) {
    return (
      <main class="shell">
        <p class="muted">Connecting…</p>
      </main>
    );
  }

  // The plain-client floor (arch.md §8.6): with the capability absent this is a
  // sentence, not an empty drive with five buttons that would 400.
  if (!hasCapability(session, FILENODE_CAP)) {
    return (
      <main class="shell shell-error">
        <h1>No files here</h1>
        <p class="empty-means">{NO_CAPABILITY_NOTE}</p>
        <p class="muted">
          The capability this section needs is <code>{FILENODE_CAPABILITY}</code>.
        </p>
      </main>
    );
  }

  if (accounts.length === 0) {
    return (
      <main class="shell">
        <h1>No files here</h1>
        {/* Not "you have no files" — this session reaches no account that
            advertises the Files capability at all, which is a different thing
            and a different fix (session.ts:22-58). */}
        <p class="empty-means">
          This session reaches no account with a Files realm. A token scoped to mail only, or a
          grant that shares a mailbox but not the account, both land here — the files are not
          missing, they are out of reach.
        </p>
      </main>
    );
  }

  /** Are we inside the sidestep's folder? Only then is the missing reverse
   *  link to the source message worth a sentence. */
  const inAttachments = page?.dir?.role === ATTACHMENTS_ROLE;
  const listingNote = describeListing(children.length, page?.total);
  const hasMore = typeof page?.total === "number" && page.total > children.length;

  return (
    <div class="app files">
      <header class="topbar">
        <nav class="crumbs" aria-label="Breadcrumb">
          {/* Before the first listing lands there is still a place to be: the
              root. An empty bar for a moment reads as a broken header. */}
          {(page?.trail.crumbs ?? [ROOT_CRUMB]).map((crumb, i, all) =>
            i === all.length - 1 ? (
              <span class="crumb crumb-here" aria-current="page">
                {crumb.name}
              </span>
            ) : (
              <>
                <button
                  class="crumb link-button"
                  onClick={() => {
                    setDirId(crumb.id);
                    setSelectedId(undefined);
                    setLimit(CHILD_PAGE_SIZE);
                  }}
                >
                  {crumb.name}
                </button>
                <span class="crumb-sep" aria-hidden="true">
                  /
                </span>
              </>
            ),
          )}
        </nav>

        {accounts.length > 1 ? (
          <label class="files-account">
            <span class="muted">Account</span>
            <select
              value={accountId}
              onChange={(ev) => {
                setAccountId((ev.currentTarget as HTMLSelectElement).value);
                setDirId(null);
                setSelectedId(undefined);
                setDirectories(undefined);
              }}
            >
              {accounts.map((a) => (
                <option value={a.id}>
                  {a.name}
                  {a.isPersonal ? "" : " (shared)"}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </header>

      {mode === "demo" ? (
        <p class="banner">
          Demo data — none of these files are real{modeReason ? ` (${modeReason})` : ""}.
        </p>
      ) : null}

      {page?.trail.truncated ? (
        <p class="banner banner-warn">
          The trail above is incomplete — a parent folder of this one could not be read, so this is
          not the full path.
        </p>
      ) : null}

      {readRefusal ? <p class="banner banner-warn">{readRefusal.message}</p> : null}
      {!readRefusal && writeRefused ? <p class="banner banner-warn">{NO_WRITE_SCOPE_NOTE}</p> : null}

      <div class="body">
        <aside class="sidebar">
          {canWrite ? (
            <>
              <form
                class="files-newfolder"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  void submitFolder();
                }}
              >
                <label>
                  <span class="muted">New folder</span>
                  <input
                    type="text"
                    value={folderName}
                    placeholder="Folder name"
                    aria-invalid={folderProblem ? "true" : undefined}
                    aria-describedby={folderProblem ? "folder-problem" : undefined}
                    onInput={(ev) => {
                      setFolderName((ev.currentTarget as HTMLInputElement).value);
                      setFolderProblem(undefined);
                    }}
                  />
                </label>
                <button type="submit" disabled={busy || folderName.trim() === ""}>
                  Create folder
                </button>
                {folderProblem ? (
                  <p id="folder-problem" class="files-problem">
                    {folderProblem}
                  </p>
                ) : null}
              </form>

              {/* The accessible upload path. It is a real <input type="file">,
                  labelled, keyboard-reachable and first — the drop zone below
                  is the shortcut, not the interface. */}
              <div class="files-upload">
                <label class="files-upload-label" for="files-input">
                  Upload files
                </label>
                <input
                  id="files-input"
                  type="file"
                  multiple
                  disabled={busy}
                  onChange={(ev) => {
                    const input = ev.currentTarget as HTMLInputElement;
                    const picked = Array.from(input.files ?? []);
                    // Clear so picking the same file twice still fires.
                    input.value = "";
                    void runUploads(picked);
                  }}
                />
                <p class="muted files-hint">…or drop them onto the list.</p>
              </div>
            </>
          ) : (
            <p class="muted files-hint">
              {readRefusal
                ? "Nothing can be changed here while files cannot be read."
                : NO_WRITE_SCOPE_NOTE}
            </p>
          )}

          {uploads.length > 0 ? (
            <section class="files-queue">
              <h2 class="files-queue-h">Uploads</h2>
              <ul>
                {uploads.map((row) => (
                  <li class={`files-queue-row is-${row.status}`}>
                    <span class="files-queue-name">{row.name}</span>
                    <span class="pill">{statusLabel(row.status)}</span>
                    {row.renamedFrom ? (
                      <span class="muted files-queue-note">
                        renamed from “{row.renamedFrom}” — that name was taken
                      </span>
                    ) : null}
                    {row.message ? <span class="files-queue-note">{row.message}</span> : null}
                  </li>
                ))}
              </ul>
              <div class="actions">
                {uploads.some((r) => r.status === "failed") ? (
                  <button disabled={busy} onClick={retryFailed}>
                    Retry failed
                  </button>
                ) : null}
                <button
                  class="link-button"
                  disabled={busy}
                  onClick={() => setUploads((prev) => prev.filter((r) => r.status === "failed"))}
                >
                  Clear finished
                </button>
              </div>
            </section>
          ) : null}
        </aside>

        <main class="content">
          <p class="scope-line">
            {describeCount(page?.total ?? children.length)}
            {listingNote ? ` ${listingNote}` : ""}
            {hasMore ? ` ${PARTIAL_SORT_NOTE}` : ""}
          </p>

          <div class="files-panes">
            <ul
              class={`file-list${dropping ? " is-dropping" : ""}`}
              onDragOver={(ev) => {
                if (!canWrite) return;
                ev.preventDefault();
                setDropping(true);
              }}
              onDragLeave={() => setDropping(false)}
              onDrop={(ev) => {
                ev.preventDefault();
                setDropping(false);
                if (!canWrite) return;
                const dropped = Array.from(ev.dataTransfer?.files ?? []);
                void runUploads(dropped);
              }}
            >
              {children.map((node) => (
                <li>
                  <button
                    class={`file-row${node.id === selectedId ? " is-selected" : ""}`}
                    onDblClick={() => {
                      if (node.nodeType === "directory") {
                        setDirId(node.id);
                        setSelectedId(undefined);
                        setLimit(CHILD_PAGE_SIZE);
                      }
                    }}
                    onClick={() => {
                      setSelectedId(node.id);
                      setRenaming(false);
                    }}
                  >
                    <span class="file-icon" aria-hidden="true">
                      {node.nodeType === "directory" ? "▸" : "·"}
                    </span>
                    <span class="file-name">{node.name}</span>
                    {node.role === ATTACHMENTS_ROLE ? <span class="pill">from mail</span> : null}
                    <span class="file-meta muted">
                      {node.nodeType === "directory" ? "Folder" : formatSize(node.size)}
                    </span>
                  </button>
                  {node.nodeType === "directory" ? (
                    <button
                      class="link-button file-open"
                      onClick={() => {
                        setDirId(node.id);
                        setSelectedId(undefined);
                        setLimit(CHILD_PAGE_SIZE);
                      }}
                    >
                      Open
                    </button>
                  ) : null}
                </li>
              ))}

              {children.length === 0 && !loading ? (
                <li class="empty-means">
                  {readRefusal
                    ? "Nothing is listed because this session cannot read files."
                    : dirId === null
                      ? "There is nothing in Files yet. Make a folder, drop something in, or wait — " +
                        "large incoming attachments file themselves here."
                      : "This folder is empty."}
                </li>
              ) : null}

              {hasMore ? (
                <li class="files-pager">
                  <button
                    class="link-button"
                    disabled={loading}
                    onClick={() => setLimit((n) => n + CHILD_PAGE_SIZE)}
                  >
                    {loading ? "Loading…" : `Load more (${(page?.total ?? 0) - children.length} left)`}
                  </button>
                </li>
              ) : null}
            </ul>

            <section class="file-detail">
              {selected ? (
                <article class="panel">
                  <h2>
                    {selected.name}
                    {selected.role === ATTACHMENTS_ROLE ? <span class="pill">from mail</span> : null}
                  </h2>

                  <div class="row">
                    <p class="detail-line">
                      <span class="muted">Kind</span> {formatType(selected.type, selected.nodeType)}
                    </p>
                    {selected.nodeType === "file" ? (
                      <p class="detail-line">
                        <span class="muted">Size</span> {formatSize(selected.size)}
                      </p>
                    ) : null}
                    <p class="detail-line">
                      <span class="muted">Modified</span> {formatWhen(selected.modified)}
                    </p>
                    <p class="detail-line">
                      <span class="muted">Added</span> {formatWhen(selected.created)}
                    </p>
                  </div>

                  {selected.role === ATTACHMENTS_ROLE ? (
                    <p class="caveats">{ATTACHMENTS_ROLE_NOTE}</p>
                  ) : null}
                  {inAttachments && selected.nodeType === "file" ? (
                    <p class="caveats">{NO_SOURCE_LINK_NOTE}</p>
                  ) : null}

                  {/* Outside the write gate on purpose: reading the bytes back
                      needs `read`, which anyone who can see this row already
                      has. A read-only session can still get its files out. */}
                  {selected.nodeType === "file" && selected.blobId ? (
                    <div class="actions">
                      <button disabled={busy} onClick={() => void download()}>
                        Download
                      </button>
                    </div>
                  ) : null}

                  {canWrite ? (
                    <>
                      {renaming ? (
                        <form
                          class="files-rename"
                          onSubmit={(ev) => {
                            ev.preventDefault();
                            void submitRename();
                          }}
                        >
                          <input
                            type="text"
                            value={renameValue}
                            onInput={(ev) =>
                              setRenameValue((ev.currentTarget as HTMLInputElement).value)
                            }
                          />
                          <button type="submit" disabled={busy || !!nameProblem(renameValue)}>
                            Save
                          </button>
                          <button type="button" class="link-button" onClick={() => setRenaming(false)}>
                            Cancel
                          </button>
                          {nameProblem(renameValue) ? (
                            <p class="files-problem">{nameProblem(renameValue)}</p>
                          ) : null}
                        </form>
                      ) : (
                        <div class="actions">
                          <button
                            disabled={busy}
                            onClick={() => {
                              setRenameValue(selected.name);
                              setRenaming(true);
                            }}
                          >
                            Rename
                          </button>
                          <button class="danger" disabled={busy} onClick={() => void remove()}>
                            Delete
                          </button>
                        </div>
                      )}

                      <details class="attach" onToggle={() => void openMoveTargets()}>
                        <summary>Move</summary>
                        <div class="attach-body">
                          {directories === undefined ? (
                            <p class="muted">Loading folders…</p>
                          ) : targets.length === 0 ? (
                            <p class="muted">
                              There is nowhere else to put this — make another folder first.
                            </p>
                          ) : (
                            <form
                              onSubmit={(ev) => {
                                ev.preventDefault();
                                const value = (
                                  ev.currentTarget.elements.namedItem("target") as HTMLSelectElement
                                ).value;
                                void submitMove(value);
                              }}
                            >
                              <select name="target" aria-label="Move to">
                                {targets.map((t) => (
                                  <option value={t.id ?? ""}>{t.name}</option>
                                ))}
                              </select>
                              <button type="submit" disabled={busy}>
                                Move here
                              </button>
                            </form>
                          )}
                        </div>
                      </details>
                    </>
                  ) : null}
                </article>
              ) : (
                <p class="muted">Select an item.</p>
              )}
            </section>
          </div>
        </main>
      </div>

      {toast ? (
        <div class="toast" role="status" onClick={() => setToast(undefined)}>
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function statusLabel(status: UploadRow["status"]): string {
  switch (status) {
    case "waiting":
      return "waiting";
    case "uploading":
      return "sending bytes";
    case "done":
      return "filed";
    case "failed":
      return "failed";
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
