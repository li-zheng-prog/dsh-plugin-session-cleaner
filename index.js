/**
 * dsh-plugin-session-cleaner — Host entry.
 *
 * Registers the destructive routes the Web UI calls after the user confirms an
 * exact session id, and drains the pending-deletion queue during the next
 * start. The operations themselves live in ./lib/delete.js so they can be
 * tested against a real JSONL persistence backend.
 *
 * Harness keeps every Session it opened in this process live until the process
 * exits, so a Session opened during this run cannot be removed now; it can only
 * be queued for the next start (see `enqueueSession`). That deferred deletion
 * must finish before the Web client loads, because the desktop client restores
 * the previously selected Session on boot and a restored Session becomes
 * undeletable for the rest of the run — so `apply` AWAITS the first purge pass
 * instead of scheduling it: the Host reports its URL to the Electron shell only
 * after profile activation settles, i.e. after this pass already ran.
 */
import {
  createDeleteRoute,
  createCatalogRoute,
  createSubagentRoute,
  createWorkspaceRoute,
  createQueueRoute,
  purgeQueuedSessionsAtStartup,
  scheduleBootPurgeRetry,
} from './lib/delete.js'

/** Plugin identity for diagnostics. */
export const name = 'session-cleaner'

/** Services the routes need; without them the plugin stays inactive. */
export const inject = ['webServer', 'sessionPersistence', 'sessions', 'agents', 'workspaceRegistry', 'storageDomain']

/** Install the routes and the startup purge as effects owned by this plugin. */
export async function apply(ctx) {
  ctx.effect(() => ctx.webServer.register(createSubagentRoute(ctx)), 'session-cleaner.subagent-route')
  ctx.effect(() => ctx.webServer.register(createCatalogRoute(ctx)), 'session-cleaner.catalog-route')
  ctx.effect(() => ctx.webServer.register(createWorkspaceRoute(ctx)), 'session-cleaner.workspace-route')
  ctx.effect(() => ctx.webServer.register(createDeleteRoute(ctx)), 'session-cleaner.route')
  ctx.effect(() => ctx.webServer.register(createQueueRoute(ctx)), 'session-cleaner.queue-route')
  // Awaited: no client may exist yet, so a queued Session is still cold here.
  // Returning from apply only after the pass finished is what keeps the Host
  // from announcing itself (and the Web client from restoring the Session)
  // while the deletion is still in flight.
  await purgeQueuedSessionsAtStartup(ctx)
  ctx.effect(() => scheduleBootPurgeRetry(ctx), 'session-cleaner.purge-retry')
}
