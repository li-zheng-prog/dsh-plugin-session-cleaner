/**
 * Session cleaner — Host half.
 *
 * Deletes one persisted Harness Session by its exact id: the session log
 * directory, its projection-cache record and its workspace bookkeeping. The
 * operation is manual (a user confirmation is required by the HTTP surface),
 * refuses every session the current runtime still owns, and never touches
 * workspace files or shared attachments.
 *
 * Harness keeps every Session it has opened in this process live until the
 * process exits (the Agent registry has no public detach), so such a Session
 * cannot be removed safely while it runs. The cleaner therefore offers a
 * durable pending queue: the user arranges the deletion, and the Host purges
 * those Sessions while activating on the next start — before the Web client can
 * load and restore one of them, because a restored Session is held again for
 * the whole run and could never be deleted.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** Exact HTTP path the Client half calls to delete immediately. */
export const ROUTE_PATH = '/__dsh-session-cleaner/delete'
/** Exact HTTP path the Client half calls to arrange deletion at the next start. */
export const QUEUE_ROUTE_PATH = '/__dsh-session-cleaner/queue'
export const CATALOG_ROUTE_PATH = '/__dsh-session-cleaner/catalog'
export const WORKSPACE_ROUTE_PATH = '/__dsh-session-cleaner/workspace'
export const SUBAGENT_ROUTE_PATH = '/__dsh-session-cleaner/subagent'
/** Request header that binds a call to this plugin's own UI (blocks cross-site forms). */
export const CONFIRM_HEADER = 'x-dsh-session-cleaner'
/** Value required in {@link CONFIRM_HEADER}. */
export const CONFIRM_VALUE = 'confirmed'
/** Largest accepted request body; the shape is two short strings. */
const MAX_BODY_BYTES = 4096
/** Harness session ids are UUIDs, with or without the `session-` prefix. */
const SESSION_ID_PATTERN = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Loopback peers accepted for the destructive route. */
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
/** Plugin-owned directory (under the Harness home) holding the pending queue. */
const QUEUE_DIRECTORY = 'session-cleaner'
/** Pending-queue file name inside {@link QUEUE_DIRECTORY}. */
const QUEUE_FILENAME = 'pending.json'
/** In-process serialization of queue file read-modify-write cycles. */
let queueChain = Promise.resolve()

/** A failure that carries an HTTP status and a stable code for the Client to localize. */
export class CleanerError extends Error {
  /**
   * @param message - English diagnostic shown when the Client has no mapping.
   * @param options.status - HTTP status the route must answer with.
   * @param options.code - stable machine code the Client localizes.
   */
  constructor(message, { status = 500, code = 'failed' } = {}) {
    super(message)
    this.name = 'CleanerError'
    this.status = status
    this.code = code
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Read and validate one destructive request.
 *
 * The desktop shell proxies the page's `dsh-app://` origin to loopback and
 * strips `origin`/`sec-fetch-site`; a plain browser same-origin call keeps
 * both. A foreign origin, a cross-site fetch, a non-JSON body, a missing
 * confirmation header, an oversized body, or a non-matching exact-id
 * confirmation all fail closed.
 *
 * @param req - raw HTTP request owned by the exact route.
 * @returns the confirmed session id.
 */
export async function readDeleteRequest(req, { requireSessionId = true } = {}) {
  if (req.method !== 'POST') throw new CleanerError('Only POST is accepted.', { status: 405, code: 'method' })
  const peer = req.socket?.remoteAddress
  if (typeof peer !== 'string' || !LOOPBACK_PEERS.has(peer)) {
    throw new CleanerError('Only local requests may delete a session.', { status: 403, code: 'forbidden' })
  }
  const rawOrigin = req.headers.origin
  if (rawOrigin !== undefined && rawOrigin !== 'null') {
    let origin
    try {
      origin = new URL(rawOrigin)
    } catch {
      throw new CleanerError('The request origin is not a valid URL.', { status: 403, code: 'forbidden' })
    }
    const protocolOk = origin.protocol === 'http:' || origin.protocol === 'https:'
    if (!protocolOk || origin.host !== req.headers.host) {
      throw new CleanerError('Cross-origin deletion requests are refused.', { status: 403, code: 'forbidden' })
    }
  }
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new CleanerError('Cross-site deletion requests are refused.', { status: 403, code: 'forbidden' })
  }
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || contentType.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new CleanerError('A JSON request body is required.', { status: 400, code: 'content-type' })
  }
  if (req.headers[CONFIRM_HEADER] !== CONFIRM_VALUE) {
    throw new CleanerError('The deletion confirmation header is missing.', { status: 400, code: 'confirm' })
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new CleanerError('The request body is too large.', { status: 413, code: 'too-large' })
    chunks.push(chunk)
  }
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new CleanerError('The request body is not valid JSON.', { status: 400, code: 'json' })
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new CleanerError('The request body must be an object.', { status: 400, code: 'json' })
  }
  const sessionId = body.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256 || (requireSessionId && !SESSION_ID_PATTERN.test(sessionId))) {
    throw new CleanerError('The identifier is not valid.', { status: 400, code: 'invalid-id' })
  }
  if (body.confirm !== sessionId) {
    throw new CleanerError('The confirmation does not name the exact session id.', { status: 400, code: 'confirm' })
  }
  return { sessionId }
}

/** Refuse a session the current runtime still has live. */
function assertNotInUse(ctx, sessionId) {
  const agent = ctx.agents?.get?.(sessionId)
  if (agent !== undefined && agent !== null) {
    throw new CleanerError(
      agent.status === 'running'
        ? 'The session is running. Stop its task first; the cleaner never stops work.'
        : 'Harness holds this session until the current run ends. Arrange deletion for the next start instead.',
      { status: 409, code: agent.status === 'running' ? 'running' : 'held' },
    )
  }
  if (ctx.sessions?.get?.(sessionId) !== undefined) {
    throw new CleanerError(
      'Harness holds this session until the current run ends. Arrange deletion for the next start instead.',
      { status: 409, code: 'held' },
    )
  }
}

/**
 * Resolve and validate the exact directory owned by one stored session.
 *
 * The directory must be `<persistenceRoot>/<project-key>/<encoded-session-id>/`,
 * must be two ordinary, non-symlinked directories below the persistence root,
 * and its real path must match the lexical one. Anything else is refused
 * rather than guessed at.
 *
 * @param persistence - the JSONL persistence backend.
 * @param header - the stored session header naming the session and its cwd.
 * @returns the absolute session directory to remove.
 */
export async function resolveSessionDirectory(persistence, header) {
  const root = persistence.root
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new CleanerError('This persistence backend does not expose a local session root.', { status: 409, code: 'unsupported' })
  }
  if (typeof persistence.locate !== 'function') {
    throw new CleanerError('This persistence backend cannot locate a session directory.', { status: 409, code: 'unsupported' })
  }
  const located = persistence.locate(header)
  if (located === null || typeof located !== 'object' || located.kind !== 'jsonl' || typeof located.path !== 'string') {
    throw new CleanerError('This persistence backend does not store sessions as JSONL directories.', { status: 409, code: 'unsupported' })
  }
  const absoluteRoot = path.resolve(root)
  const directory = path.dirname(path.resolve(located.path))
  const relative = path.relative(absoluteRoot, directory)
  const segments = relative.split(path.sep)
  if (segments.length !== 2 || segments.some(part => part === '' || part === '.' || part === '..')) {
    throw new CleanerError('The session path does not match the per-session directory layout.', { status: 409, code: 'unsupported' })
  }
  if (segments[1] !== header.id) {
    throw new CleanerError('The session path does not end in the exact session id.', { status: 409, code: 'unsupported' })
  }
  let realRoot
  let realDirectory
  try {
    realRoot = await fs.realpath(absoluteRoot)
    realDirectory = await fs.realpath(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new CleanerError('The session directory no longer exists.', { status: 404, code: 'not-found' })
    throw error
  }
  if (path.relative(realRoot, realDirectory) !== relative || path.dirname(realDirectory) === realDirectory) {
    throw new CleanerError('The session directory resolves outside the persistence root.', { status: 409, code: 'unsupported' })
  }
  for (const candidate of [path.dirname(realDirectory), realDirectory]) {
    const info = await fs.lstat(candidate)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new CleanerError('The session directory is not an ordinary directory.', { status: 409, code: 'unsupported' })
    }
  }
  return directory
}

/**
 * Remove one session: files first (under the cross-process write lease), then
 * every durable reference to it. A cleanup step that fails after the log is
 * gone produces a warning instead of leaving the user with a half-reported
 * failure and a ghost row.
 *
 * @param ctx - plugin Host context with sessions, agents, persistence, storage and workspace services.
 * @param sessionId - exact stored session id.
 * @returns explicit result with the cleaned id and any post-file warnings.
 */
export async function deleteSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new CleanerError('The session id is not valid.', { status: 400, code: 'invalid-id' })
  }
  assertNotInUse(ctx, sessionId)
  const persistence = ctx.sessionPersistence
  if (persistence === undefined || persistence === null || typeof persistence.stat !== 'function') {
    throw new CleanerError('Session persistence is unavailable in this profile.', { status: 503, code: 'unavailable' })
  }
  const snapshot = await persistence.stat(sessionId)
  if (snapshot === undefined || snapshot === null || snapshot.header?.id !== sessionId) {
    throw new CleanerError('The session does not exist or is already deleted.', { status: 404, code: 'not-found' })
  }
  const header = snapshot.header
  const directory = await resolveSessionDirectory(persistence, header)

  let handle
  let closeFailure
  try {
    // The native write lease excludes writers in this process and every other
    // profile/process. On Windows it is a kernel semaphore, not a file handle,
    // so removing the directory while it is held is safe.
    handle = await persistence.open(sessionId, 'write')
    assertNotInUse(ctx, sessionId)
    if (handle.header?.id !== sessionId || handle.header?.cwd !== header.cwd || handle.header?.createdAt !== header.createdAt) {
      throw new CleanerError('The session changed while it was being deleted; close the dialog and retry.', { status: 409, code: 'changed' })
    }
    try {
      await fs.rm(directory, { recursive: true, force: false })
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // Already gone (an external cleaner won the race); treat the log as deleted.
      } else if (error?.code === 'EBUSY' || error?.code === 'EPERM' || error?.code === 'EACCES') {
        throw new CleanerError('Windows refused to remove the session files; close anything using them and retry.', { status: 409, code: 'files-busy' })
      } else {
        throw new CleanerError(`The session files could not be removed: ${String(error?.message ?? error)}`, { status: 500, code: 'files' })
      }
    }
  } catch (error) {
    if (error instanceof CleanerError) throw error
    if (error?.name === 'SessionAlreadyOwnedError') {
      throw new CleanerError('Another Harness runtime owns the session; close it and retry.', { status: 409, code: 'owned' })
    }
    if (error?.name === 'SessionPersistenceNotFoundError') {
      throw new CleanerError('The session does not exist or is already deleted.', { status: 404, code: 'not-found' })
    }
    throw new CleanerError(`The session could not be deleted: ${String(error?.message ?? error)}`, { status: 500, code: 'failed' })
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch (error) {
        closeFailure = error
      }
    }
  }

  const warnings = []
  if (closeFailure !== undefined) warnings.push(`The session write lease did not close cleanly: ${String(closeFailure?.message ?? closeFailure)}`)
  await removeBookkeeping(ctx, sessionId, warnings)
  try {
    ctx.emit?.('api-session/removed', sessionId)
  } catch (error) {
    warnings.push(`The interface refresh event could not be emitted: ${String(error?.message ?? error)}`)
  }
  return { sessionId, warnings }
}

/** Drop the projection-cache record, workspace references, pin and archive entries. */
async function removeBookkeeping(ctx, sessionId, warnings) {
  try {
    const domain = ctx.storageDomain?.get?.('session_projcache')
    const table = domain?.table?.('sessions')
    if (table !== undefined) await table.delete(sessionId)
  } catch (error) {
    warnings.push(`The projection cache record was not removed: ${String(error?.message ?? error)}`)
  }
  try {
    const registry = ctx.workspaceRegistry
    if (registry !== undefined && registry !== null) {
      for (const workspace of registry.list()) {
        if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) {
          await workspace.detachSession(sessionId)
        }
      }
      await registry.unpinSession(sessionId)
      await registry.unarchiveSession(sessionId)
    }
  } catch (error) {
    warnings.push(`The workspace bookkeeping was not fully removed: ${String(error?.message ?? error)}`)
  }
}

/**
 * Resolve the Harness home directory that owns this run.
 *
 * @param ctx - plugin Host context.
 * @returns the absolute Harness home.
 */
function resolveHome(ctx) {
  const home = ctx.get?.('profileContext')?.home
  if (typeof home === 'string' && home !== '') return home
  const fromEnv = typeof process === 'undefined' ? undefined : process.env?.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  throw new CleanerError('Cannot resolve the Harness home directory for the pending queue.', { status: 500, code: 'queue-home' })
}

/** Absolute path of the pending-deletion queue file. */
function queueFilePath(ctx) {
  return path.join(resolveHome(ctx), QUEUE_DIRECTORY, QUEUE_FILENAME)
}

/** Serialize one queue read-modify-write cycle in this process. */
function withQueueLock(operation) {
  const next = queueChain.then(operation, operation)
  queueChain = next.catch(() => {})
  return next
}

/** Read the pending queue, dropping entries that cannot name a session. */
async function readQueueEntries(ctx) {
  const file = queueFilePath(ctx)
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw new CleanerError(`The pending-deletion queue could not be read: ${String(error?.message ?? error)}`, { status: 500, code: 'queue' })
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CleanerError('The pending-deletion queue contains invalid JSON.', { status: 500, code: 'queue' })
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)) {
    throw new CleanerError('The pending-deletion queue has an unsupported format.', { status: 500, code: 'queue' })
  }
  const sessions = parsed.sessions
  return sessions
    .filter(entry => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && SESSION_ID_PATTERN.test(entry.id))
    .map(entry => ({ id: entry.id, enqueuedAt: Number.isSafeInteger(entry.enqueuedAt) && entry.enqueuedAt > 0 ? entry.enqueuedAt : 0 }))
}

/** Atomically replace the pending queue. */
async function writeQueueEntries(ctx, entries) {
  const file = queueFilePath(ctx)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const body = `${JSON.stringify({ version: 1, sessions: entries }, null, 2)}\n`
  const temporary = `${file}.tmp-${String(process.pid)}-${String(Date.now())}`
  await fs.writeFile(temporary, body, 'utf8')
  await fs.rename(temporary, file)
}

/**
 * Arrange one session's deletion for the next Host start. Harness keeps every
 * Session it opened in this process live until the process ends, so a held
 * session can only be removed after a restart; the queue makes that automatic.
 *
 * @param ctx - plugin Host context.
 * @param sessionId - exact stored session id.
 * @returns whether the id was newly queued.
 */
export async function enqueueSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new CleanerError('The session id is not valid.', { status: 400, code: 'invalid-id' })
  }
  const persistence = ctx.sessionPersistence
  if (persistence === undefined || persistence === null || typeof persistence.stat !== 'function') {
    throw new CleanerError('Session persistence is unavailable in this profile.', { status: 503, code: 'unavailable' })
  }
  const snapshot = await persistence.stat(sessionId)
  if (snapshot === undefined || snapshot === null || snapshot.header?.id !== sessionId) {
    throw new CleanerError('The session does not exist or is already deleted.', { status: 404, code: 'not-found' })
  }
  return withQueueLock(async () => {
    const entries = await readQueueEntries(ctx)
    if (entries.some(entry => entry.id === sessionId)) return { sessionId, alreadyQueued: true }
    entries.push({ id: sessionId, enqueuedAt: Date.now() })
    await writeQueueEntries(ctx, entries)
    return { sessionId, alreadyQueued: false }
  })
}

/**
 * Purge every queued session that is no longer held. The Host calls this during
 * plugin activation at the next start (see `purgeQueuedSessionsAtStartup`);
 * sessions the runtime already holds, or whose files cannot be removed yet,
 * stay queued for a later start.
 *
 * @param ctx - plugin Host context.
 * @returns the ids deleted now and the ids still queued.
 */
export async function purgeQueuedSessions(ctx) {
  return withQueueLock(async () => {
  const entries = await readQueueEntries(ctx)
  if (entries.length === 0) return { deleted: [], kept: [] }
  const remaining = []
  const deleted = []
  for (const entry of entries) {
    const sessionId = entry.id
    try {
      const snapshot = await ctx.sessionPersistence.stat(sessionId)
      if (snapshot === undefined || snapshot === null) continue
      if (ctx.agents?.get?.(sessionId) !== undefined || ctx.sessions?.get?.(sessionId) !== undefined) {
        remaining.push(entry)
        continue
      }
      await deleteSession(ctx, sessionId)
      deleted.push(sessionId)
    } catch (error) {
      if (error instanceof CleanerError && error.code === 'not-found') continue
      remaining.push(entry)
    }
  }
  await writeQueueEntries(ctx, remaining)
  return { deleted, kept: remaining.map(entry => entry.id) }
  })
}

/**
 * Delay before the startup-retry pass, in milliseconds. The first pass is
 * awaited during plugin activation; this retry exists only for a transient
 * failure (a lease the previous process is still releasing, a briefly locked
 * file), never as the primary mechanism.
 */
export const BOOT_PURGE_RETRY_MS = 2500

/** Report one boot-purge failure without letting diagnostics throttle startup. */
function warnBootPurge(ctx, error) {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('session-cleaner') : undefined
    logger?.warn?.(`pending deletion purge failed: ${String(error?.message ?? error)}`)
  } catch {
    // Diagnostics must never break boot.
  }
}

/**
 * Run the first pending-deletion pass as part of Host startup and report
 * whether anything is still queued.
 *
 * The plugin AWAITS this during activation, which is what makes deferred
 * deletion reliable: the Desktop Host reports its URL to the Electron shell
 * only after the profile finished activating, and the Web client restores its
 * previously selected Session immediately after loading. Harness cannot release
 * a Session once the runtime holds it, so a queued Session that the client
 * restored is undeletable for the rest of that run — and every later start
 * restores it again. Purging while the Session is still cold is therefore the
 * only reliable window; an earlier revision waited 2.5s, lost that window, and
 * could never delete a Session opened in the previous run.
 *
 * Failures are reported and never reject: startup must continue, and the
 * scheduled retry gets another chance.
 *
 * @param ctx - plugin Host context.
 * @returns whether sessions remain queued after this pass.
 */
export async function purgeQueuedSessionsAtStartup(ctx) {
  try {
    return (await purgeQueuedSessions(ctx)).kept.length > 0
  } catch (error) {
    warnBootPurge(ctx, error)
    return true
  }
}

/**
 * Retry the pending-deletion pass once shortly after startup. Only useful when
 * the awaited first pass hit a transient failure; a Session the Web client has
 * already restored stays queued until a later start instead.
 *
 * @param ctx - plugin Host context.
 * @param options - retry delay override (tests use a short one).
 * @returns disposer that cancels the pending retry.
 */
export function scheduleBootPurgeRetry(ctx, { retryMs = BOOT_PURGE_RETRY_MS } = {}) {
  let cancelled = false
  let timer = setTimeout(() => {
    timer = undefined
    if (cancelled) return
    void purgeQueuedSessionsAtStartup(ctx)
  }, retryMs)
  return () => {
    cancelled = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
}

function sendError(res, error) {
  const status = error instanceof CleanerError ? error.status : 500
  sendJson(res, status, {
    ok: false,
    code: error instanceof CleanerError ? error.code : 'failed',
    error: error instanceof Error ? error.message : String(error),
  })
}

/**
 * Build the exact route that deletes one confirmed session.
 *
 * @param ctx - plugin Host context.
 * @returns the `webServer.register` argument.
 */
export function createDeleteRoute(ctx) {
  return {
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      try {
        const { sessionId } = await readDeleteRequest(req)
        try {
          const result = await deleteSession(ctx, sessionId)
          sendJson(res, 200, { ok: true, sessionId: result.sessionId, warnings: result.warnings })
        } catch (error) {
          if (!(error instanceof CleanerError) || error.code !== 'held') throw error
          const result = await enqueueSession(ctx, sessionId)
          sendJson(res, 200, { ok: true, sessionId, queued: true, alreadyQueued: result.alreadyQueued })
        }
      } catch (error) {
        sendError(res, error)
      }
    },
  }
}

/**
 * Build the exact route that arranges one confirmed session's deletion for the
 * next Host start.
 *
 * @param ctx - plugin Host context.
 * @returns the `webServer.register` argument.
 */
export function createQueueRoute(ctx) {
  return {
    kind: 'exact',
    path: QUEUE_ROUTE_PATH,
    handler: async (req, res) => {
      try {
        const { sessionId } = await readDeleteRequest(req)
        const result = await enqueueSession(ctx, sessionId)
        sendJson(res, 200, { ok: true, sessionId: result.sessionId, alreadyQueued: result.alreadyQueued })
      } catch (error) {
        sendError(res, error)
      }
    },
  }
}

/** List authoritative workspace registrations and stored subagent session identities. */
export function createCatalogRoute(ctx) {
  return {
    kind: 'exact', path: CATALOG_ROUTE_PATH,
    handler: async (req, res) => {
      try {
        await readDeleteRequest(req)
        const snapshots = await ctx.sessionPersistence.list()
        const subagents = snapshots.filter(item => item.header?.origin === 'subagent').map(item => ({
          id: item.header.id, parentSessionId: item.header.parentSession,
        }))
        const workspaces = ctx.workspaceRegistry.list().map(item => ({ id: item.id, title: item.title, path: item.path }))
        sendJson(res, 200, { ok: true, subagents, workspaces })
      } catch (error) { sendError(res, error) }
    },
  }
}

/** Remove the registry entry through Harness, preserving directory and logs. */
export function createWorkspaceRoute(ctx) {
  return {
    kind: 'exact', path: WORKSPACE_ROUTE_PATH,
    handler: async (req, res) => {
      try {
        const { sessionId } = await readDeleteRequest(req, { requireSessionId: false })
        if (!ctx.workspaceRegistry.get(sessionId)) throw new CleanerError('Workspace not found.', { status: 404, code: 'not-found' })
        if (!await ctx.workspaceRegistry.delete(sessionId)) throw new CleanerError('Workspace not found.', { status: 404, code: 'not-found' })
        sendJson(res, 200, { ok: true })
      } catch (error) { sendError(res, error) }
    },
  }
}

/** Delete the selected subagent's session and its subagent descendants. */
export function createSubagentRoute(ctx) {
  return {
    kind: 'exact', path: SUBAGENT_ROUTE_PATH,
    handler: async (req, res) => {
      try {
        const { sessionId } = await readDeleteRequest(req)
        const snapshots = await ctx.sessionPersistence.list()
        const headers = snapshots.map(item => item.header).filter(header => header?.origin === 'subagent')
        if (!headers.some(header => header.id === sessionId)) throw new CleanerError('Subagent session not found.', { status: 404, code: 'not-found' })
        const ids = [sessionId]
        const seen = new Set(ids)
        for (let i = 0; i < ids.length; i++) {
          for (const header of headers) {
            if (header.parentSession === ids[i] && !seen.has(header.id)) { seen.add(header.id); ids.push(header.id) }
          }
        }
        for (const id of ids) {
          if (ctx.agents?.get?.(id)?.status === 'running') throw new CleanerError('A subagent is running.', { status: 409, code: 'running' })
        }
        const warnings = []
        let queued = 0
        for (const id of ids.reverse()) {
          try {
            const result = await deleteSession(ctx, id)
            warnings.push(...result.warnings.map(warning => `${id}: ${warning}`))
          } catch (error) {
            if (error instanceof CleanerError && error.code === 'held') {
              try { await enqueueSession(ctx, id); queued++; continue } catch (queueError) { error = queueError }
            }
            warnings.push(`${id}: ${String(error?.message ?? error)}`)
          }
        }
        sendJson(res, 200, { ok: true, sessionId, queuedCount: queued, warnings })
      } catch (error) { sendError(res, error) }
    },
  }
}
