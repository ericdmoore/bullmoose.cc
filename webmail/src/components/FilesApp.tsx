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
import { ROOT_CRUMB, childrenOf, moveTargets, type Crumb } from "../lib/files/tree";
import type { FileNode, FileWriteResult } from "../lib/files/types";
import { FILENODE_CAP, hasCapability } from "../lib/jmap/capabilities";
import type { JmapClient } from "../lib/jmap/JmapClient";
import type { Session } from "../lib/jmap/types";
import CollectionColumn from "./CollectionColumn";
import { publishGroups } from "../lib/shell/publishGroups";
import { copyText, mintFileLink } from "../lib/files/share";
import type { CollectionGroup } from "../lib/shell/collections";
import { hrefWithParams, urlParam } from "../lib/shell/publish";
import { isUnmodifiedPrimaryClick, syncDetailUrl } from "../lib/ui/navigation";
import {
  Alert,
  Badge,
  Breadcrumb,
  Button,
  Column,
  DescList,
  DescRow,
  EmptyState,
  Field,
  Input,
  PageNotice,
  Select,
  StackedList,
  SurfaceFrame,
} from "./ui";
import { FolderIcon } from "./icons";

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

  /** The query the deep links are read from and built onto — the injected one
   *  in tests and the demo, the browser's otherwise. */
  const queryString = search ?? globalThis.location?.search ?? "";

  // `/files?c=<folder>&f=<node>` — the FOLDER and the row inside it, because a
  // file id alone is not enough: a fresh load starts at the root, and a link
  // to something three folders down would resolve to a listing that does not
  // contain it. `?c=` is the collection param the other realms use, and here
  // the collection column IS the folder tree.
  const [dirId, setDirId] = useState<string | null>(() => {
    const c = urlParam("c", queryString);
    return c === undefined || c === "root" ? null : c;
  });
  const [page, setPage] = useState<DirectoryPage | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(CHILD_PAGE_SIZE);

  // Self-repaired by the directory load below: a `?f=` naming something that
  // is not in this listing (moved, deleted, another account's) clears rather
  // than pinning the detail pane to a file nobody can see.
  const [selectedId, setSelectedId] = useState<string | undefined>(() => urlParam("f", queryString));
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
        setSelectedId((current) => (current && result.children.some((n) => n.id === current) ? current : undefined));
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

  useEffect(() => {
    if (!client || !accountId) return;
    let cancelled = false;
    void loadDirectories(client, accountId)
      .then((res) => {
        if (!cancelled) setDirectories(res.directories);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, accountId, reloadKey]);

  const children = page?.children ?? [];
  const selected = children.find((n) => n.id === selectedId);
  const readRefusal = page?.refusal;
  const canWrite = !readRefusal && !writeRefused;

  // ── the two links this screen mints ─────────────────────────────────────
  // Both are built from the LIVE `dirId` rather than from whatever the address
  // bar happens to say: browsing into a folder changes the state first, and a
  // row href assembled from a stale `?c=` would point at a file in the folder
  // you just left. `hrefWithParams` drops a key whose value is `undefined`, so
  // the root folder mints no `?c=` at all.
  const fileHref = (nodeId: string): string =>
    hrefWithParams("/files", { c: dirId ?? undefined, f: nodeId }, queryString);
  const dirHref = (id: string | null): string =>
    hrefWithParams("/files", { c: id ?? undefined, f: undefined }, queryString);

  /**
   * Browse into a folder (or back to the root) — the one place that happens.
   *
   * Four call sites used to inline the same three setters; they now also keep
   * the address bar honest, which matters here more than elsewhere: the URL
   * carries the folder, so a stale `?c=` would be a link to the wrong listing.
   */
  const openDirectory = (id: string | null): void => {
    setDirId(id);
    setSelectedId(undefined);
    setLimit(CHILD_PAGE_SIZE);
    syncDetailUrl(dirHref(id));
  };

  // ── reporting a write ───────────────────────────────────────────────────
  const report = useCallback((result: FileWriteResult, subject: FileNode | null, ok: string): boolean => {
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
  }, []);

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
  // #339 — mint, copy, and SAY WHICH happened. A "Copied" that is really
  // "minted but the clipboard refused" (no secure context, no gesture) sends
  // someone to paste whatever was there before.
  const [shareNote, setShareNote] = useState("");
  const copyLink = useCallback(async () => {
    if (!client || !accountId || !selected) return;
    setShareNote("");
    const out = await mintFileLink(client, accountId, {
      name: selected.name,
      type: selected.type,
      blobId: selected.blobId,
    });
    if ("refusal" in out) {
      setShareNote(out.refusal.message);
      return;
    }
    const copied = await copyText(out.link.url);
    const until = new Date(out.link.expiresAt).toLocaleString();
    setShareNote(copied ? `Link copied — expires ${until}.` : `Link minted (copy failed): ${out.link.url}`);
  }, [client, accountId, selected]);

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

  const fileGroups: CollectionGroup[] = useMemo(() => {
    const dirs = directories ?? [];
    const top = childrenOf(dirs, null);
    return [
      {
        id: "places",
        label: "Places",
        items: [
          { id: "root", label: "All files", icon: FolderIcon },
          ...top.map((d) => ({
            id: d.id,
            label: d.name,
            icon: FolderIcon,
            note: d.role === ATTACHMENTS_ROLE ? "from mail" : undefined,
            children: childrenOf(dirs, d.id).map((c) => ({
              id: c.id,
              label: c.name,
              icon: FolderIcon,
              note: c.role === ATTACHMENTS_ROLE ? "from mail" : undefined,
            })),
          })),
        ],
      },
    ];
  }, [directories]);

  // s25 T4 (#226): the tray renders leaf-nodes only for realms that
  // publish. One line, off the SAME array the column renders, so the
  // two can never disagree about what this realm's collections are.
  useEffect(() => publishGroups("files", "/files", fileGroups), [fileGroups]);

  // ── render ──────────────────────────────────────────────────────────────

  if (fatal) {
    return (
      <PageNotice title="Files are not reachable" error>
        <p>{fatal}</p>
        <p class="mt-2">
          <a href="/login" class="font-medium text-brand-600 hover:text-brand-500">
            Sign in again
          </a>
          , or append <code>?demo=1</code> to browse sample data.
        </p>
      </PageNotice>
    );
  }

  if (!client || !session) {
    return <PageNotice>Connecting…</PageNotice>;
  }

  if (!hasCapability(session, FILENODE_CAP)) {
    return (
      <PageNotice title="No files here">
        <p>{NO_CAPABILITY_NOTE}</p>
        <p class="mt-2">
          The capability this section needs is <code>{FILENODE_CAPABILITY}</code>.
        </p>
      </PageNotice>
    );
  }

  if (accounts.length === 0) {
    return (
      <PageNotice title="No files here">
        This session reaches no account with a Files realm. A token scoped to mail only, or a grant that shares a
        mailbox but not the account, both land here — the files are not missing, they are out of reach.
      </PageNotice>
    );
  }

  const inAttachments = page?.dir?.role === ATTACHMENTS_ROLE;
  const listingNote = describeListing(children.length, page?.total);
  const hasMore = typeof page?.total === "number" && page.total > children.length;
  const crumbs = page?.trail.crumbs ?? [ROOT_CRUMB];

  const filesFooter = (
    <div class="px-2 pb-4">
      {canWrite ? (
        <>
          <Field label="New folder" error={folderProblem} class="mb-3">
            <Input
              type="text"
              value={folderName}
              placeholder="Folder name"
              aria-invalid={folderProblem ? "true" : undefined}
              onInput={(ev) => {
                setFolderName((ev.currentTarget as HTMLInputElement).value);
                setFolderProblem(undefined);
              }}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") {
                  ev.preventDefault();
                  void submitFolder();
                }
              }}
            />
          </Field>
          <Button
            variant="primary"
            class="mb-4 w-full"
            disabled={busy || folderName.trim() === ""}
            onClick={() => void submitFolder()}
          >
            Create folder
          </Button>
          <label class="block text-sm/6 font-medium text-gray-900 dark:text-white" htmlFor="files-input">
            Upload files
          </label>
          <input
            id="files-input"
            type="file"
            multiple
            disabled={busy}
            class="mt-2 block w-full text-sm text-gray-500 file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-brand-700 hover:file:bg-brand-100 dark:file:bg-brand-500/20 dark:file:text-brand-100"
            onChange={(ev) => {
              const input = ev.currentTarget as HTMLInputElement;
              const picked = Array.from(input.files ?? []);
              input.value = "";
              void runUploads(picked);
            }}
          />
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">…or drop them onto the list.</p>
        </>
      ) : (
        <p class="text-xs text-gray-500 dark:text-gray-400">
          {readRefusal ? "Nothing can be changed here while files cannot be read." : NO_WRITE_SCOPE_NOTE}
        </p>
      )}
      {uploads.length > 0 ? (
        <section class="mt-4 border-t border-gray-100 pt-3 dark:border-white/10" aria-label="Uploads">
          <h2 class="text-xs font-semibold tracking-wide text-gray-500 uppercase">Uploads</h2>
          <ul class="mt-2 divide-y divide-gray-100 dark:divide-white/5">
            {uploads.map((row) => (
              <li key={row.key} class="py-2 text-xs">
                <div class="flex items-center justify-between gap-2">
                  <span class="min-w-0 truncate font-medium text-gray-900 dark:text-white">{row.name}</span>
                  <Badge tone={row.status === "failed" ? "error" : row.status === "done" ? "success" : "neutral"}>
                    {statusLabel(row.status)}
                  </Badge>
                </div>
                {row.renamedFrom ? (
                  <p class="mt-0.5 text-gray-500">renamed from “{row.renamedFrom}” — that name was taken</p>
                ) : null}
                {row.message ? <p class="mt-0.5 text-red-600 dark:text-red-400">{row.message}</p> : null}
              </li>
            ))}
          </ul>
          <div class="mt-2 flex flex-wrap gap-2">
            {uploads.some((r) => r.status === "failed") ? (
              <Button size="sm" disabled={busy} onClick={retryFailed}>
                Retry failed
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={busy}
              onClick={() => setUploads((prev) => prev.filter((r) => r.status === "failed"))}
            >
              Clear finished
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );

  return (
    <div class="flex h-full min-h-0 w-full flex-col">
      {mode === "demo" ? (
        <Alert tone="info" class="m-4 shrink-0">
          Demo data — none of these files are real{modeReason ? ` (${modeReason})` : ""}.
        </Alert>
      ) : null}
      {page?.trail.truncated ? (
        <Alert tone="warn" class="mx-4 mb-2 shrink-0">
          The trail above is incomplete — a parent folder of this one could not be read, so this is not the full path.
        </Alert>
      ) : null}
      {readRefusal ? (
        <Alert tone="warn" class="mx-4 mb-2 shrink-0">
          {readRefusal.message}
        </Alert>
      ) : null}
      {!readRefusal && writeRefused ? (
        <Alert tone="warn" class="mx-4 mb-2 shrink-0">
          {NO_WRITE_SCOPE_NOTE}
        </Alert>
      ) : null}

      <SurfaceFrame>
        <CollectionColumn
          title="Files"
          storageKey="bm.cc.files"
          groups={fileGroups}
          selectedId={dirId ?? "root"}
          onSelect={(id) => openDirectory(id === "root" ? null : id)}
          actions={
            accounts.length > 1 ? (
              <Field label="Account" class="px-2 pb-2">
                <Select
                  value={accountId}
                  onChange={(ev) => {
                    setAccountId((ev.currentTarget as HTMLSelectElement).value);
                    setDirectories(undefined);
                    openDirectory(null);
                  }}
                >
                  {accounts.map((a) => (
                    <option value={a.id}>
                      {a.name}
                      {a.isPersonal ? "" : " (shared)"}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null
          }
          footer={filesFooter}
        />

        <Column
          aria-label="Folder contents"
          class="w-full shrink-0 border-gray-200 max-lg:border-b lg:w-96 lg:border-r dark:border-white/10"
          header={
            <div class="flex flex-col gap-2 px-4 pt-4 pb-2">
              <Breadcrumb
                items={crumbs.map((crumb, i, all) => ({
                  label: crumb.name,
                  current: i === all.length - 1,
                  onSelect: i === all.length - 1 ? undefined : () => openDirectory(crumb.id),
                }))}
              />
              <p class="text-xs text-gray-500 dark:text-gray-400">
                {describeCount(page?.total ?? children.length)}
                {listingNote ? ` ${listingNote}` : ""}
                {hasMore ? ` ${PARTIAL_SORT_NOTE}` : ""}
              </p>
            </div>
          }
        >
          <div
            class={
              dropping
                ? "min-h-full bg-brand-50 ring-1 ring-inset ring-brand-500/30 dark:bg-brand-500/10"
                : "min-h-full"
            }
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
            {children.length === 0 && !loading ? (
              <EmptyState title={dirId === null ? "Nothing in Files yet" : "This folder is empty"}>
                {readRefusal
                  ? "Nothing is listed because this session cannot read files."
                  : dirId === null
                    ? "Make a folder, drop something in, or wait — large incoming attachments file themselves here."
                    : "Drop files here, or upload from the collection column."}
              </EmptyState>
            ) : (
              <StackedList>
                {children.map((node) => (
                  <li
                    key={node.id}
                    class="relative flex items-center gap-x-2 py-3 pr-2 pl-2 hover:bg-gray-50 dark:hover:bg-white/[0.03]"
                  >
                    {/* A REAL link to `/files?c=<folder>&f=<node>`, and a
                        plain click still selects in place. A file with no URL
                        cannot be sent to anyone, opened in its own tab beside
                        the folder, or linked to from a message — which for a
                        drive is most of the point of having one. Every
                        modified click falls through to the browser untouched
                        (lib/ui/navigation.ts).

                        `onDblClick` survives the change: a double click still
                        fires a click first, which selects, and the second
                        opens the folder. */}
                    <a
                      href={fileHref(node.id)}
                      aria-current={node.id === selectedId ? "true" : undefined}
                      class={
                        "flex min-w-0 flex-1 items-center gap-x-3 text-left " +
                        (node.id === selectedId ? "font-semibold" : "")
                      }
                      onClick={(ev) => {
                        if (!isUnmodifiedPrimaryClick(ev)) return;
                        ev.preventDefault();
                        setSelectedId(node.id);
                        setRenaming(false);
                        // Keep the address bar on the file being read, so the
                        // link you would copy is the one you are looking at.
                        syncDetailUrl(fileHref(node.id));
                      }}
                      onDblClick={() => {
                        if (node.nodeType === "directory") openDirectory(node.id);
                      }}
                    >
                      <FolderIcon
                        class={
                          node.nodeType === "directory"
                            ? "size-5 shrink-0 text-brand-500"
                            : "size-5 shrink-0 text-gray-400"
                        }
                      />
                      <span class="min-w-0 flex-auto">
                        <span class="block truncate text-sm/6 font-semibold text-gray-900 dark:text-white">
                          {node.name}
                        </span>
                        <span class="mt-0.5 block text-xs/5 text-gray-500 dark:text-gray-400">
                          {node.nodeType === "directory" ? "Folder" : formatSize(node.size)}
                        </span>
                      </span>
                      {node.role === ATTACHMENTS_ROLE ? <Badge>from mail</Badge> : null}
                    </a>
                    {node.nodeType === "directory" ? (
                      <Button size="sm" onClick={() => openDirectory(node.id)}>
                        Open
                      </Button>
                    ) : null}
                  </li>
                ))}
              </StackedList>
            )}
            {hasMore ? (
              <div class="px-4 py-3">
                <Button disabled={loading} onClick={() => setLimit((n) => n + CHILD_PAGE_SIZE)}>
                  {loading ? "Loading…" : `Load more (${(page?.total ?? 0) - children.length} left)`}
                </Button>
              </div>
            ) : null}
          </div>
        </Column>

        <Column aria-label="File detail" class="min-w-0 grow">
          {selected ? (
            <article class="px-4 py-5 sm:px-6">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="text-base/7 font-semibold text-gray-900 dark:text-white">{selected.name}</h2>
                {selected.role === ATTACHMENTS_ROLE ? <Badge>from mail</Badge> : null}
              </div>
              <DescList class="mt-4">
                <DescRow term="Kind">{formatType(selected.type, selected.nodeType)}</DescRow>
                {selected.nodeType === "file" ? <DescRow term="Size">{formatSize(selected.size)}</DescRow> : null}
                <DescRow term="Modified">{formatWhen(selected.modified)}</DescRow>
                <DescRow term="Added">{formatWhen(selected.created)}</DescRow>
              </DescList>
              {selected.role === ATTACHMENTS_ROLE ? (
                <p class="mt-3 text-sm text-gray-500 dark:text-gray-400">{ATTACHMENTS_ROLE_NOTE}</p>
              ) : null}
              {inAttachments && selected.nodeType === "file" ? (
                <p class="mt-3 text-sm text-gray-500 dark:text-gray-400">{NO_SOURCE_LINK_NOTE}</p>
              ) : null}

              {selected.nodeType === "file" && selected.blobId ? (
                <div class="mt-4 flex flex-wrap items-center gap-2">
                  <Button disabled={busy} onClick={() => void download()}>
                    Download
                  </Button>
                  {/* #339 — the API has minted expiring public links since
                      s03.B; this was the surface with no way to reach it. */}
                  <Button disabled={busy} onClick={() => void copyLink()}>
                    Copy link
                  </Button>
                  {shareNote ? (
                    <span class="text-sm text-gray-500 dark:text-gray-400" data-testid="share-note">
                      {shareNote}
                    </span>
                  ) : null}
                </div>
              ) : null}

              {canWrite ? (
                <div class="mt-4 flex flex-col gap-3">
                  {renaming ? (
                    <div class="flex flex-wrap items-end gap-2">
                      <Field label="Rename" class="min-w-40 grow" error={nameProblem(renameValue) ?? undefined}>
                        <Input
                          type="text"
                          value={renameValue}
                          onInput={(ev) => setRenameValue((ev.currentTarget as HTMLInputElement).value)}
                        />
                      </Field>
                      <Button
                        variant="primary"
                        disabled={busy || !!nameProblem(renameValue)}
                        onClick={() => void submitRename()}
                      >
                        Save
                      </Button>
                      <Button onClick={() => setRenaming(false)}>Cancel</Button>
                    </div>
                  ) : (
                    <div class="flex flex-wrap gap-2">
                      <Button
                        disabled={busy}
                        onClick={() => {
                          setRenameValue(selected.name);
                          setRenaming(true);
                        }}
                      >
                        Rename
                      </Button>
                      <Button variant="danger" disabled={busy} onClick={() => void remove()}>
                        Delete
                      </Button>
                    </div>
                  )}

                  <details
                    class="rounded-md ring-1 ring-gray-200 ring-inset dark:ring-white/10"
                    onToggle={() => void openMoveTargets()}
                  >
                    <summary class="cursor-pointer px-3 py-2 text-sm font-medium text-gray-900 dark:text-white">
                      Move
                    </summary>
                    <div class="px-3 pb-3">
                      {directories === undefined ? (
                        <p class="text-sm text-gray-500">Loading folders…</p>
                      ) : targets.length === 0 ? (
                        <p class="text-sm text-gray-500">
                          There is nowhere else to put this — make another folder first.
                        </p>
                      ) : (
                        <div class="flex flex-wrap items-end gap-2">
                          <Field label="Move to" class="min-w-40 grow">
                            <Select name="target" aria-label="Move to" id="files-move-target">
                              {targets.map((t) => (
                                <option value={t.id ?? ""}>{t.name}</option>
                              ))}
                            </Select>
                          </Field>
                          <Button
                            disabled={busy}
                            onClick={() => {
                              const el = document.getElementById("files-move-target") as HTMLSelectElement | null;
                              if (el) void submitMove(el.value);
                            }}
                          >
                            Move here
                          </Button>
                        </div>
                      )}
                    </div>
                  </details>
                </div>
              ) : null}
            </article>
          ) : (
            <EmptyState title="Select an item">Details show here.</EmptyState>
          )}
        </Column>
      </SurfaceFrame>

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
