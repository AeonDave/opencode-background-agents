import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Part, TextPart } from "@opencode-ai/sdk"
import { parseAgentWriteCapability } from "./agent-capability"
import { generateReadableId } from "./id"
import type { Logger } from "./logger"
import { generateMetadata } from "./metadata"
import type { OpencodeClient } from "./primitives/types"
import { deserializeDelegation, isRestorableState, serializeDelegation } from "./state"
import {
	ALL_COMPLETE_QUIET_PERIOD_MS,
	COMPLETE_DEBOUNCE_MS,
	DEFAULT_MAX_RUN_TIME_MS,
	isActiveStatus,
	isTerminalStatus,
	isUnlimitedRunTime,
	normalizeId,
	KEEP_CHILD_SESSIONS,
	PARENT_NOTIFICATION_TIMEOUT_MS,
	parsePersistedStatus,
	READ_POLL_INTERVAL_MS,
	READ_WAIT_UNLIMITED_MS,
	STALL_CHECK_MS,
	STOP_GRACE_MS,
	STRICT_READONLY,
	TERMINAL_WAIT_GRACE_MS,
	WATCHDOG_INTERVAL_MS,
} from "./types"
import type {
	AssistantSessionMessageItem,
	DelegateInput,
	DelegationListItem,
	DelegationManagerOptions,
	DelegationRecord,
	DelegationStatus,
	DelegationTerminalStatus,
	NativeSteerFn,
	ParentNotificationState,
	SessionMessageItem,
} from "./types"

class DelegationManager {
	private delegations: Map<string, DelegationRecord> = new Map()
	private delegationsBySession: Map<string, string> = new Map()
	private terminalWaiters: Map<string, { promise: Promise<void>; resolve: () => void }> = new Map()
	private timeoutTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
	private completeTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
	// Unique tool callIDs seen per delegation: part events fire repeatedly for the same
	// call (pending → running → completed), so the Set dedupes the toolCalls counter.
	private toolCallsSeen: Map<string, Set<string>> = new Map()
	// Child session IDs whose server-side session has already been deleted by cleanup, so we
	// never issue a second delete for the same delegation.
	private cleanedChildSessions: Set<string> = new Set()
	private watchdogTimer?: ReturnType<typeof setInterval>
	private client: OpencodeClient
	private baseDir: string
	private log: Logger
	private maxRunTimeMs: number
	private readPollIntervalMs: number
	private terminalWaitGraceMs: number
	private allCompleteQuietPeriodMs: number
	private completeDebounceMs: number
	private readWaitUnlimitedMs: number
	private idGenerator: () => string
	private metadataGenerator: typeof generateMetadata
	private nativeSteer?: NativeSteerFn
	private pendingByParent: Map<string, Set<string>> = new Map()
	private parentNotificationState: Map<string, ParentNotificationState> = new Map()
	private pendingNotifications: Map<string, string[]> = new Map()

	constructor(
		client: OpencodeClient,
		baseDir: string,
		log: Logger,
		options: DelegationManagerOptions = {},
	) {
		this.client = client
		this.baseDir = baseDir
		this.log = log
		this.maxRunTimeMs = options.maxRunTimeMs ?? DEFAULT_MAX_RUN_TIME_MS
		this.readPollIntervalMs = options.readPollIntervalMs ?? READ_POLL_INTERVAL_MS
		this.terminalWaitGraceMs = options.terminalWaitGraceMs ?? TERMINAL_WAIT_GRACE_MS
		this.allCompleteQuietPeriodMs = options.allCompleteQuietPeriodMs ?? ALL_COMPLETE_QUIET_PERIOD_MS
		this.completeDebounceMs = options.completeDebounceMs ?? COMPLETE_DEBOUNCE_MS
		this.readWaitUnlimitedMs = options.readWaitUnlimitedMs ?? READ_WAIT_UNLIMITED_MS
		this.idGenerator = options.idGenerator ?? generateReadableId
		this.metadataGenerator = options.metadataGenerator ?? generateMetadata
		this.nativeSteer = options.nativeSteer
		this.startWatchdog()
	}

	/**
	 * Start the stall watchdog: a single shared interval that recovers delegations whose
	 * heartbeat has gone silent past STALL_CHECK_MS by reconciling against the server's
	 * session status. Unref'd so it never keeps the process alive. No-op if STALL_CHECK_MS
	 * is non-positive or the runtime lacks setInterval.
	 */
	private startWatchdog(): void {
		if (this.watchdogTimer || STALL_CHECK_MS <= 0) return
		if (typeof setInterval !== "function") return
		this.watchdogTimer = setInterval(() => {
			void this.runWatchdog()
		}, WATCHDOG_INTERVAL_MS)
		// Node/Bun timers expose unref(); the DOM `number` fallback does not. Cast structurally
		// so this compiles in the facade repo (no @types/node) and at runtime under opencode.
		;(this.watchdogTimer as unknown as { unref?: () => void }).unref?.()
	}

	// ----- State persistence & restart recovery -----

	private stateFilePath(delegation: DelegationRecord): string {
		return delegation.artifact.filePath.replace(/\.md$/, ".state.json")
	}

	/**
	 * Mirror an ACTIVE delegation to disk (fire-and-forget). The state file only exists
	 * while the delegation is running: it is deleted on finalization, so any state file
	 * found at startup marks a delegation orphaned by a process exit.
	 */
	private persistState(id: string): void {
		const delegation = this.delegations.get(id)
		if (!delegation || isTerminalStatus(delegation.status)) return
		void fs
			.writeFile(this.stateFilePath(delegation), serializeDelegation(delegation), "utf8")
			.catch((error: Error) => {
				void this.debugLog(`persistState failed for ${id}: ${error.message}`)
			})
	}

	private removeStateFile(delegation: DelegationRecord): void {
		void fs.unlink(this.stateFilePath(delegation)).catch(() => {})
	}

	/**
	 * Re-adopt delegations that were active when the previous process exited, then
	 * reconcile them against the server: sessions still busy keep running (events and
	 * the watchdog take over — the original prompt promise is gone); settled sessions
	 * are finalized from their messages so the parent still gets its notification.
	 */
	async restoreActiveDelegations(): Promise<void> {
		let rootDirs: string[]
		try {
			const entries = await fs.readdir(this.baseDir, { withFileTypes: true })
			rootDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
		} catch {
			return
		}

		const restored: DelegationRecord[] = []
		for (const dir of rootDirs) {
			const dirPath = path.join(this.baseDir, dir)
			let files: string[]
			try {
				files = await fs.readdir(dirPath)
			} catch {
				continue
			}
			for (const file of files.filter((name) => name.endsWith(".state.json"))) {
				const filePath = path.join(dirPath, file)
				try {
					const record = deserializeDelegation(await fs.readFile(filePath, "utf8"))
					if (!record || !isRestorableState(record)) {
						void fs.unlink(filePath).catch(() => {})
						continue
					}
					if (this.delegations.has(record.id)) continue

					this.delegations.set(record.id, record)
					this.delegationsBySession.set(record.sessionID, record.id)
					this.createTerminalWaiter(record.id)
					if (!this.pendingByParent.has(record.parentSessionID)) {
						this.pendingByParent.set(record.parentSessionID, new Set())
						this.resetParentAllCompleteNotificationCycle(record.parentSessionID)
					}
					this.pendingByParent.get(record.parentSessionID)?.add(record.id)
					// Join the restored batch to the parent's current notification cycle so the
					// all-complete signal fires once the batch settles.
					const parentState = this.getParentNotificationState(record.parentSessionID)
					record.notificationCycle = parentState.allCompleteCycle
					record.notificationCycleToken = parentState.allCompleteCycleToken
					this.scheduleTimeout(record.id)
					restored.push(record)
				} catch (error) {
					await this.debugLog(
						`restoreActiveDelegations: failed to restore ${filePath}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					)
				}
			}
		}

		if (restored.length === 0) return
		await this.debugLog(
			`restoreActiveDelegations: re-adopted ${restored.length} delegation(s): ${restored
				.map((r) => r.id)
				.join(", ")}`,
		)

		const statuses = await this.fetchSessionStatuses()
		// Status unavailable: leave everything running; the watchdog reconciles as soon as
		// the server responds (restored heartbeats are old, so the stall check fires fast).
		if (!statuses) return

		for (const record of restored) {
			const type = statuses[record.sessionID]?.type
			if (type === "busy" || type === "retry") continue
			await this.debugLog(
				`restoreActiveDelegations: ${record.id} settled while plugin was down; finalizing`,
			)
			this.scheduleComplete(record.id)
		}
	}

	/** Stop the watchdog interval (cleanup; safe to call multiple times). */
	dispose(): void {
		if (!this.watchdogTimer) return
		clearInterval(this.watchdogTimer)
		this.watchdogTimer = undefined
	}

	/**
	 * Reconcile each running delegation whose heartbeat has been silent for STALL_CHECK_MS
	 * against the server's reported session status. This recovers from hangs where the
	 * `session.idle` event was never delivered (opencode #6573). We only act on a status the
	 * server confirms is no longer running; heartbeat silence alone never finalizes a task.
	 */
	private async runWatchdog(): Promise<void> {
		const now = Date.now()
		const stalled = Array.from(this.delegations.values()).filter((delegation) => {
			if (!isActiveStatus(delegation.status)) return false
			if (this.completeTimers.has(delegation.id)) return false // already settling
			return now - delegation.progress.lastHeartbeatAt.getTime() >= STALL_CHECK_MS
		})
		if (stalled.length === 0) return

		const statuses = await this.fetchSessionStatuses()
		if (!statuses) return

		for (const delegation of stalled) {
			// The status map only contains non-idle (busy/retry) sessions: an absent entry
			// means the session has settled. "busy"/"retry" mean it is still working.
			const serverStatus = statuses[delegation.sessionID]?.type
			if (serverStatus === undefined || serverStatus === "idle") {
				await this.debugLog(
					`runWatchdog: ${delegation.id} settled on server but no idle event received; recovering`,
				)
				this.scheduleComplete(delegation.id)
			}
		}
	}

	/**
	 * Fetch the server's session-status map. `/session/status` returns a record keyed
	 * directly by sessionID that only contains non-idle (busy/retry) sessions — idle
	 * sessions are evicted, so an absent key means "settled". Returns undefined when the
	 * poll itself fails, so callers can distinguish "unknown" from "settled".
	 */
	private async fetchSessionStatuses(): Promise<Record<string, { type?: string }> | undefined> {
		try {
			const result = await this.client.session.status({})
			return result.data as Record<string, { type?: string }> | undefined
		} catch (error) {
			await this.debugLog(
				`fetchSessionStatuses: session.status poll failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
			return undefined
		}
	}

	/**
	 * Resolves the root session ID by walking up the parent chain.
	 */
	async getRootSessionID(sessionID: string): Promise<string> {
		let currentID = sessionID
		// Prevent infinite loops with max depth
		for (let depth = 0; depth < 10; depth++) {
			try {
				const session = await this.client.session.get({
					path: { id: currentID },
				})

				if (!session.data?.parentID) {
					return currentID
				}

				currentID = session.data.parentID
			} catch {
				// If we can't fetch the session, assume current is root or best effort
				return currentID
			}
		}
		return currentID
	}

	/**
	 * Get the delegations directory for a session scope (root session)
	 */
	private async getDelegationsDir(sessionID: string): Promise<string> {
		const rootID = await this.getRootSessionID(sessionID)
		return path.join(this.baseDir, rootID)
	}

	/**
	 * Ensure the delegations directory exists
	 */
	private async ensureDelegationsDir(sessionID: string): Promise<string> {
		const dir = await this.getDelegationsDir(sessionID)
		await fs.mkdir(dir, { recursive: true })
		return dir
	}

	private createTerminalWaiter(id: string): void {
		if (this.terminalWaiters.has(id)) return

		let resolve: (() => void) | undefined
		const promise = new Promise<void>((innerResolve) => {
			resolve = innerResolve
		})

		if (!resolve) {
			throw new Error(`Failed to initialize terminal waiter for delegation ${id}`)
		}

		this.terminalWaiters.set(id, { promise, resolve })
	}

	private resolveTerminalWaiter(id: string): void {
		const waiter = this.terminalWaiters.get(id)
		if (!waiter) return
		waiter.resolve()
	}

	private clearTimeoutTimer(id: string): void {
		const timer = this.timeoutTimers.get(id)
		if (!timer) return
		clearTimeout(timer)
		this.timeoutTimers.delete(id)
	}

	/**
	 * (Re)arm the timeout timer from the record's own `timeoutAt`. Used at registration,
	 * after a delivered steer (which re-opens the window), and when re-adopting restored
	 * delegations whose deadline may be near or already past. Delegations without a
	 * deadline (maxRunTimeMs=0) get no timer: the supervisor steers or stops them.
	 */
	private scheduleTimeout(id: string): void {
		this.clearTimeoutTimer(id)
		const delegation = this.delegations.get(id)
		if (!delegation || isTerminalStatus(delegation.status)) return
		if (!delegation.timeoutAt) return
		const delay = Math.max(delegation.timeoutAt.getTime() - Date.now() + 5_000, 1_000)
		const timer = setTimeout(() => {
			void this.handleTimeout(id)
		}, delay)
		this.timeoutTimers.set(id, timer)
	}

	// ----- Debounced completion (steer-aware) -----

	private cancelScheduledComplete(id: string): void {
		const timer = this.completeTimers.get(id)
		if (!timer) return
		clearTimeout(timer)
		this.completeTimers.delete(id)
	}

	/**
	 * Schedule a debounced COMPLETE transition. Called when the session signals it
	 * is done (prompt resolved or session.idle). A steer cancels this so the run is
	 * extended; the steer's own completion re-schedules it. Repeated calls for the
	 * same turn just reset the timer (idempotent), deduping the double signal.
	 */
	private scheduleComplete(id: string): void {
		const delegation = this.delegations.get(id)
		if (!delegation || isTerminalStatus(delegation.status)) return
		this.cancelScheduledComplete(id)
		const timer = setTimeout(() => {
			this.completeTimers.delete(id)
			void this.finalizeDelegation(id, "complete")
		}, this.completeDebounceMs)
		this.completeTimers.set(id, timer)
	}

	/** Resolve a delegation that is visible from the calling session's root scope. */
	private async resolveVisibleDelegation(
		sessionID: string,
		id: string,
	): Promise<DelegationRecord | undefined> {
		const normalizedId = normalizeId(id)
		if (!normalizedId) return undefined
		const rootSessionID = await this.getRootSessionID(sessionID)
		const delegation = this.delegations.get(normalizedId)
		if (delegation && this.isVisibleToSession(delegation, rootSessionID)) return delegation
		return undefined
	}

	/**
	 * Steer a running delegation: inject an extra instruction into its live session.
	 *
	 * Native-first: opencode >= 1.17 supports server-side steering (v2 prompt with
	 * `delivery: "steer"`), which injects the instruction into the CURRENT run even while
	 * the session is busy — the server owns the queueing. On servers without the
	 * capability we fall back to a v1 `promptAsync`, which can be rejected while the
	 * session is busy; in that case the supervisor is told to retry (or stop the task).
	 */
	async steerDelegation(sessionID: string, id: string, message: string): Promise<string> {
		const trimmed = message.trim()
		if (!trimmed) return "❌ Steering message is required."

		const delegation = await this.resolveVisibleDelegation(sessionID, id)
		if (!delegation) {
			return `❌ Delegation "${normalizeId(id)}" not found in this session. Use delegation_status().`
		}
		if (!isActiveStatus(delegation.status)) {
			return `❌ Delegation "${delegation.id}" is ${delegation.status}; cannot steer a finished task. Use delegation_read("${delegation.id}").`
		}

		// A steer extends the run: cancel any pending completion so the steered turn is
		// awaited. Remember whether one was pending — if delivery fails it must be restored,
		// or a settled delegation would sit in limbo until the watchdog recovers it.
		const hadPendingComplete = this.completeTimers.has(delegation.id)
		this.cancelScheduledComplete(delegation.id)

		const text = `[SUPERVISOR STEER] ${trimmed}`
		let delivered = false
		if (this.nativeSteer) {
			delivered = await this.nativeSteer(delegation.sessionID, text)
			if (delivered) {
				await this.debugLog(`steerDelegation: native steer delivered to ${delegation.id}`)
			}
		}
		if (!delivered) {
			try {
				await this.client.session.promptAsync({
					path: { id: delegation.sessionID },
					body: {
						agent: delegation.agent,
						parts: [{ type: "text", text }],
					},
				})
				delivered = true
				await this.debugLog(`steerDelegation: v1 fallback steer delivered to ${delegation.id}`)
			} catch (error) {
				await this.debugLog(
					`steerDelegation: delivery failed for ${delegation.id}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				)
			}
		}

		if (!delivered) {
			if (hadPendingComplete) this.scheduleComplete(delegation.id)
			return `❌ Steer could not be delivered to "${delegation.id}" right now (session busy and no native steering on this server). Retry in a moment, or delegation_stop("${delegation.id}") and re-delegate with the new instruction.`
		}

		this.updateDelegation(delegation.id, (record, now) => {
			record.progress.steerCount = (record.progress.steerCount ?? 0) + 1
			record.progress.lastSteerAt = now
			record.progress.lastMessage = `[steer] ${trimmed}`
			record.progress.lastMessageAt = now
			record.progress.lastHeartbeatAt = now
			// A steer extends the run, so it also gets a fresh timeout window.
			if (!isUnlimitedRunTime(record.maxRunTimeMs)) {
				record.timeoutAt = new Date(now.getTime() + record.maxRunTimeMs)
			}
		})
		this.scheduleTimeout(delegation.id)
		this.persistState(delegation.id)
		return `✅ Steer sent to "${delegation.id}". It will act on your instruction in its current run; a <task-notification> arrives when it reaches a terminal state.`
	}

	/**
	 * Stop a running delegation. `session.abort` is best-effort and can silently no-op over
	 * the SDK (opencode #29894 / #21176), leaving the turn running. We therefore abort, wait a
	 * short grace for the session to actually settle, and hard-delete it if it is still alive,
	 * so a stopped delegation can never keep consuming resources behind a "cancelled" label.
	 */
	async stopDelegation(sessionID: string, id: string): Promise<string> {
		const delegation = await this.resolveVisibleDelegation(sessionID, id)
		if (!delegation) {
			return `❌ Delegation "${normalizeId(id)}" not found in this session.`
		}
		if (isTerminalStatus(delegation.status)) {
			return `ℹ️ Delegation "${delegation.id}" already ${delegation.status}. Use delegation_read("${delegation.id}").`
		}

		this.cancelScheduledComplete(delegation.id)
		try {
			await this.client.session.abort({ path: { id: delegation.sessionID } })
		} catch (error) {
			await this.debugLog(
				`stopDelegation: abort failed for ${delegation.id}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}

		// Confirm the abort took effect; if the session is still running after the grace
		// window, force-delete it (the only hard kill the SDK offers).
		if (!(await this.confirmSessionStopped(delegation.sessionID))) {
			try {
				await this.client.session.delete({ path: { id: delegation.sessionID } })
				this.cleanedChildSessions.add(delegation.sessionID)
				await this.debugLog(`stopDelegation: force-deleted lingering session for ${delegation.id}`)
			} catch (error) {
				await this.debugLog(
					`stopDelegation: force-delete failed for ${delegation.id}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				)
			}
		}

		await this.finalizeDelegation(delegation.id, "cancelled", "Stopped by supervisor")
		return `🛑 Delegation "${delegation.id}" stopped. Partial output (if any) saved — delegation_read("${delegation.id}").`
	}

	/**
	 * Best-effort check that a session is no longer running after an abort. Polls
	 * `session.status` over a short grace window. The status map only contains non-idle
	 * sessions, so an absent entry (or explicit "idle") confirms the stop; "busy"/"retry"
	 * mean it is still running. If status cannot be read we return false and fall back to
	 * the force-delete path rather than assume success.
	 */
	private async confirmSessionStopped(sessionID: string): Promise<boolean> {
		const deadline = Date.now() + STOP_GRACE_MS
		while (Date.now() < deadline) {
			const statuses = await this.fetchSessionStatuses()
			if (!statuses) return false
			const type = statuses[sessionID]?.type
			if (type === undefined || type === "idle") return true
			await new Promise((resolve) => setTimeout(resolve, 250))
		}
		return false
	}

	/**
	 * Non-blocking snapshot of a RUNNING delegation's transcript so the supervisor can make
	 * mid-run decisions (steer, stop, or let it continue) without waiting for the terminal
	 * state. Read-only: no lifecycle side effects, does not count as retrieval.
	 */
	async peekDelegation(sessionID: string, id: string): Promise<string> {
		const delegation = await this.resolveVisibleDelegation(sessionID, id)
		if (!delegation) {
			return `❌ Delegation "${normalizeId(id)}" not found in this session. Use delegation_status().`
		}
		if (isTerminalStatus(delegation.status)) {
			return `ℹ️ Delegation "${delegation.id}" is ${delegation.status}; use delegation_read("${delegation.id}") for the full result.`
		}

		let messageData: SessionMessageItem[] | undefined
		try {
			const messages = await this.client.session.messages({
				path: { id: delegation.sessionID },
			})
			messageData = messages.data as SessionMessageItem[] | undefined
		} catch (error) {
			return `⚠️ Could not read live transcript for "${delegation.id}": ${
				error instanceof Error ? error.message : "Unknown error"
			}. It is still running; try again or rely on the <task-notification>.`
		}

		// Build a transcript digest: assistant text, tool activity, and steers.
		const MAX_TEXT_BLOCK = 700
		const MAX_DIGEST = 4_000
		const lines: string[] = []
		for (const message of messageData ?? []) {
			const role = message.info.role
			for (const part of message.parts) {
				if (part.type === "text") {
					const text = part.text.trim()
					if (!text) continue
					if (role === "assistant") {
						lines.push(
							text.length > MAX_TEXT_BLOCK ? `${text.slice(0, MAX_TEXT_BLOCK)} […]` : text,
						)
					} else if (text.startsWith("[SUPERVISOR STEER]")) {
						lines.push(`>> ${text.slice(0, 200)}`)
					}
					// Other user text is the original prompt; the supervisor already knows it.
					continue
				}
				if (part.type === "tool") {
					const state = part.state
					const title =
						(state.status === "running" || state.status === "completed") && state.title
							? `: ${state.title}`
							: ""
					const error = state.status === "error" ? ` — ${state.error.slice(0, 160)}` : ""
					lines.push(`[tool] ${part.tool} (${state.status})${title}${error}`)
				}
			}
		}

		// Tail-biased trim: the most recent activity is what decisions are made on.
		let digest = lines.join("\n")
		if (digest.length > MAX_DIGEST) {
			digest = `[… earlier activity trimmed …]\n${digest.slice(-MAX_DIGEST)}`
		}
		if (!digest) {
			digest = "(no visible activity yet — the agent may still be on its first model call)"
		}

		const now = Date.now()
		const elapsed = Math.round((now - (delegation.startedAt ?? delegation.createdAt).getTime()) / 1000)
		const deadline = delegation.timeoutAt
			? `timeout in ${Math.max(Math.round((delegation.timeoutAt.getTime() - now) / 1000), 0)}s`
			: "no timeout"
		const header = `## Peek: ${delegation.id} [${delegation.status}] agent=${delegation.agent}${delegation.model ? ` model=${delegation.model}` : ""}\nelapsed=${elapsed}s · ${deadline} · tools=${delegation.progress.toolCalls} · steers=${delegation.progress.steerCount ?? 0}`
		const footer = `Act on it: delegation_steer("${delegation.id}", …) · delegation_stop("${delegation.id}") · or wait for the <task-notification>. Do not poll peek in a loop.`

		return `${header}\n\n${digest}\n\n${footer}`
	}

	/** Human-readable status of active (and unread completed) delegations in scope. */
	async getStatusReport(sessionID: string): Promise<string> {
		const rootSessionID = await this.getRootSessionID(sessionID)
		const running = this.getRunningDelegations(rootSessionID)
		const now = Date.now()
		const age = (d?: Date) => (d ? `${Math.round((now - d.getTime()) / 1000)}s ago` : "n/a")

		if (running.length === 0) {
			const unread = this.getUnreadCompletedDelegations(rootSessionID, 5)
			if (unread.length === 0) return "No active delegations. Use delegation_list() for history."
			const lines = unread.map(
				(d) => `- **${d.id}** [${d.status}] ${d.title ?? ""} — unread; delegation_read("${d.id}")`,
			)
			return `No running delegations. Unread completed:\n${lines.join("\n")}`
		}

		const lines = running.map((d) => {
			const elapsed = Math.round((now - (d.startedAt ?? d.createdAt).getTime()) / 1000)
			const deadline = d.timeoutAt
				? `timeout in ${Math.max(Math.round((d.timeoutAt.getTime() - now) / 1000), 0)}s`
				: "no timeout"
			const parts = [
				`- **${d.id}** [${d.status}] agent=${d.agent}${d.model ? ` model=${d.model}` : ""}`,
				`  elapsed=${elapsed}s · ${deadline} · tools=${d.progress.toolCalls} · heartbeat=${age(d.progress.lastHeartbeatAt)}`,
			]
			if (d.progress.steerCount) {
				parts.push(`  steers=${d.progress.steerCount} (last ${age(d.progress.lastSteerAt)})`)
			}
			if (d.progress.lastMessage) parts.push(`  last: ${d.progress.lastMessage.slice(0, 120)}`)
			return parts.join("\n")
		})
		return `## Active delegations (${running.length})\n\n${lines.join("\n")}\n\nSteer: delegation_steer(id, message) · Stop: delegation_stop(id)`
	}

	private updateDelegation(
		id: string,
		mutate: (delegation: DelegationRecord, now: Date) => void,
	): DelegationRecord | undefined {
		const delegation = this.delegations.get(id)
		if (!delegation) return undefined

		const now = new Date()
		mutate(delegation, now)
		delegation.updatedAt = now
		return delegation
	}

	private registerDelegation(input: {
		id: string
		rootSessionID: string
		sessionID: string
		parentSessionID: string
		parentMessageID: string
		parentAgent: string
		prompt: string
		agent: string
		artifactPath: string
		maxRunTimeMs?: number
		model?: string
	}): DelegationRecord {
		if (!this.pendingByParent.has(input.parentSessionID)) {
			this.pendingByParent.set(input.parentSessionID, new Set())
			this.resetParentAllCompleteNotificationCycle(input.parentSessionID)
		}

		const parentNotificationState = this.getParentNotificationState(input.parentSessionID)
		const notificationCycle = parentNotificationState.allCompleteCycle
		const notificationCycleToken = parentNotificationState.allCompleteCycleToken

		const now = new Date()
		const maxRunTimeMs = input.maxRunTimeMs ?? this.maxRunTimeMs
		const delegation: DelegationRecord = {
			id: input.id,
			rootSessionID: input.rootSessionID,
			sessionID: input.sessionID,
			parentSessionID: input.parentSessionID,
			parentMessageID: input.parentMessageID,
			parentAgent: input.parentAgent,
			prompt: input.prompt,
			agent: input.agent,
			notificationCycle,
			notificationCycleToken,
			status: "registered",
			createdAt: now,
			updatedAt: now,
			timeoutAt: isUnlimitedRunTime(maxRunTimeMs)
				? undefined
				: new Date(now.getTime() + maxRunTimeMs),
			maxRunTimeMs,
			model: input.model,
			progress: {
				toolCalls: 0,
				lastUpdateAt: now,
				lastHeartbeatAt: now,
			},
			notification: {
				terminalNotificationCount: 0,
			},
			retrieval: {
				retrievalCount: 0,
			},
			artifact: {
				filePath: input.artifactPath,
			},
		}

		this.delegations.set(delegation.id, delegation)
		this.delegationsBySession.set(delegation.sessionID, delegation.id)
		this.createTerminalWaiter(delegation.id)
		this.pendingByParent.get(delegation.parentSessionID)?.add(delegation.id)
		this.persistState(delegation.id)

		return delegation
	}

	private markStarted(id: string): DelegationRecord | undefined {
		return this.updateDelegation(id, (delegation, now) => {
			if (isTerminalStatus(delegation.status)) return
			delegation.status = "running"
			delegation.startedAt = now
			delegation.progress.lastUpdateAt = now
			delegation.progress.lastHeartbeatAt = now
		})
	}

	private markProgress(id: string, messageText?: string): DelegationRecord | undefined {
		return this.updateDelegation(id, (delegation, now) => {
			if (isTerminalStatus(delegation.status)) return
			if (delegation.status === "registered") {
				delegation.status = "running"
				delegation.startedAt = delegation.startedAt ?? now
			}

			delegation.progress.lastUpdateAt = now
			delegation.progress.lastHeartbeatAt = now

			if (messageText) {
				delegation.progress.lastMessage = messageText
				delegation.progress.lastMessageAt = now
			}
		})
	}

	private markTerminal(
		id: string,
		status: DelegationTerminalStatus,
		error?: string,
	): { transitioned: boolean; delegation?: DelegationRecord } {
		const delegation = this.delegations.get(id)
		if (!delegation) return { transitioned: false }

		if (isTerminalStatus(delegation.status)) {
			return { transitioned: false, delegation }
		}

		const now = new Date()
		delegation.status = status
		delegation.completedAt = now
		delegation.updatedAt = now
		if (error) {
			delegation.error = error
		}

		const pending = this.pendingByParent.get(delegation.parentSessionID)
		if (pending) {
			pending.delete(delegation.id)
			if (pending.size === 0) {
				this.pendingByParent.delete(delegation.parentSessionID)
			}
		}

		this.clearTimeoutTimer(id)
		this.cancelScheduledComplete(id)
		this.toolCallsSeen.delete(id)
		this.resolveTerminalWaiter(id)

		return { transitioned: true, delegation }
	}

	private markNotified(id: string): DelegationRecord | undefined {
		return this.updateDelegation(id, (delegation, now) => {
			delegation.notification.terminalNotifiedAt = now
			delegation.notification.terminalNotificationCount += 1
		})
	}

	private getParentNotificationState(parentSessionID: string): ParentNotificationState {
		const existing = this.parentNotificationState.get(parentSessionID)
		if (existing) return existing

		const initialized: ParentNotificationState = {
			allCompleteNotificationCount: 0,
			allCompleteCycle: 0,
			allCompleteCycleToken: this.buildAllCompleteCycleToken(parentSessionID, 0),
		}
		this.parentNotificationState.set(parentSessionID, initialized)
		return initialized
	}

	private buildAllCompleteCycleToken(parentSessionID: string, cycle: number): string {
		return `${parentSessionID}:${cycle}`
	}

	private resetParentAllCompleteNotificationCycle(parentSessionID: string): void {
		const state = this.getParentNotificationState(parentSessionID)
		this.cancelScheduledAllComplete(state)
		state.allCompleteCycle += 1
		state.allCompleteCycleToken = this.buildAllCompleteCycleToken(
			parentSessionID,
			state.allCompleteCycle,
		)
		state.allCompleteNotifiedAt = undefined
		state.allCompleteNotifiedCycle = undefined
		state.allCompleteNotifiedCycleToken = undefined
	}

	private cancelScheduledAllComplete(state: ParentNotificationState): void {
		if (state.allCompleteScheduledTimer) {
			clearTimeout(state.allCompleteScheduledTimer)
		}
		state.allCompleteScheduledTimer = undefined
		state.allCompleteScheduledCycle = undefined
		state.allCompleteScheduledCycleToken = undefined
	}

	private areCycleTerminalNotificationsComplete(
		parentSessionID: string,
		cycleToken: string,
	): boolean {
		let cycleDelegationCount = 0

		for (const delegation of this.delegations.values()) {
			if (delegation.parentSessionID !== parentSessionID) continue
			if (delegation.notificationCycleToken !== cycleToken) continue

			cycleDelegationCount += 1
			if (!delegation.notification.terminalNotifiedAt) {
				return false
			}
		}

		return cycleDelegationCount > 0
	}

	private scheduleAllCompleteForParent(parentSessionID: string, parentAgent: string): void {
		const state = this.getParentNotificationState(parentSessionID)
		const cycle = state.allCompleteCycle
		const cycleToken = state.allCompleteCycleToken
		if (!this.areCycleTerminalNotificationsComplete(parentSessionID, cycleToken)) return

		if (state.allCompleteNotifiedCycleToken === cycleToken) return
		if (state.allCompleteScheduledCycleToken === cycleToken) return

		this.cancelScheduledAllComplete(state)

		state.allCompleteScheduledCycle = cycle
		state.allCompleteScheduledCycleToken = cycleToken
		state.allCompleteScheduledTimer = setTimeout(() => {
			void this.dispatchScheduledAllComplete(parentSessionID, parentAgent, cycle, cycleToken)
		}, this.allCompleteQuietPeriodMs)
	}

	private async dispatchScheduledAllComplete(
		parentSessionID: string,
		parentAgent: string,
		cycle: number,
		cycleToken: string,
	): Promise<void> {
		const state = this.getParentNotificationState(parentSessionID)

		if (state.allCompleteScheduledCycleToken !== cycleToken) return

		this.cancelScheduledAllComplete(state)

		if (state.allCompleteCycleToken !== cycleToken) return
		if (!this.areCycleTerminalNotificationsComplete(parentSessionID, cycleToken)) return
		if (state.allCompleteNotifiedCycleToken === cycleToken) return

		const deliveryStatus = await this.sendParentNotification(
			parentSessionID,
			parentAgent,
			this.buildAllCompleteNotification(parentSessionID, cycle, cycleToken),
			false,
		)

		if (state.allCompleteCycleToken !== cycleToken) return
		if (!this.areCycleTerminalNotificationsComplete(parentSessionID, cycleToken)) return

		state.allCompleteNotifiedAt = new Date()
		state.allCompleteNotificationCount += 1
		state.allCompleteNotifiedCycle = cycle
		state.allCompleteNotifiedCycleToken = cycleToken

		void this.showToast("All delegations complete.", "success")

		await this.debugLog(
			`all-complete notification ${deliveryStatus} for ${parentSessionID} cycle=${cycleToken}`,
		)
	}

	/**
	 * Best-effort TUI toast so the human sees delegation lifecycle events. The model-facing
	 * notifications are synthetic parts the TUI hides, so this is the human-facing channel.
	 * Silently no-ops when no TUI is attached (headless / SDK-driven sessions).
	 */
	private async showToast(
		message: string,
		variant: "info" | "success" | "warning" | "error",
	): Promise<void> {
		try {
			await this.client.tui.showToast({
				body: { title: "Background agents", message, variant },
			})
		} catch {
			// No TUI attached; nothing to do.
		}
	}

	private queuePendingNotification(parentSessionID: string, notification: string): void {
		const pending = this.pendingNotifications.get(parentSessionID) ?? []
		pending.push(notification)
		this.pendingNotifications.set(parentSessionID, pending)
	}

	private async sendParentNotification(
		parentSessionID: string,
		parentAgent: string,
		notification: string,
		noReply: boolean,
	): Promise<"sent" | "queued" | "timed-out"> {
		const session = this.client.session
		let timeout: ReturnType<typeof setTimeout> | undefined

		try {
			await this.debugLog(
				`parent notification sending for ${parentSessionID} noReply=${noReply} async=${Boolean(
					session.promptAsync,
				)}`,
			)

			const result = await Promise.race<"sent" | "timed-out">([
				session
					.promptAsync({
						path: { id: parentSessionID },
						body: {
							noReply,
							agent: parentAgent,
							// synthetic: visible to the model, hidden by the TUI — the human
							// is informed via a toast instead of raw notification XML.
							parts: [{ type: "text", text: notification, synthetic: true }],
						},
					})
					.then(() => "sent" as const),
				new Promise<"timed-out">((resolve) => {
					timeout = setTimeout(() => resolve("timed-out"), PARENT_NOTIFICATION_TIMEOUT_MS)
				}),
			])

			if (result === "timed-out") {
				await this.debugLog(
					`parent notification timed out for ${parentSessionID} after ${PARENT_NOTIFICATION_TIMEOUT_MS}ms`,
				)
			}

			return result
		} catch (error) {
			this.queuePendingNotification(parentSessionID, notification)
			await this.debugLog(
				`parent notification queued for ${parentSessionID}: ${
					error instanceof Error ? error.message : "Unknown error"
				}`,
			)
			return "queued"
		} finally {
			if (timeout) clearTimeout(timeout)
		}
	}

	injectPendingNotificationsIntoChatMessage(
		output: {
			message?: { id?: string }
			parts?: Array<{ type: string; text?: string }>
		},
		sessionID: string,
	): void {
		const pending = this.pendingNotifications.get(sessionID)
		if (!pending || pending.length === 0) return

		this.pendingNotifications.delete(sessionID)
		const notificationText = pending.join("\n\n")
		const parts = output.parts ?? []

		// Append as a separate synthetic part: the model sees it, the TUI hides it, and the
		// user's own text is left untouched. Part IDs only need the "prt" prefix to validate.
		parts.push({
			id: `prt_bg${Date.now().toString(16)}${Math.random().toString(36).slice(2, 10)}`,
			sessionID,
			messageID: output.message?.id,
			type: "text",
			text: notificationText,
			synthetic: true,
		} as { type: string; text?: string })
		output.parts = parts
	}

	private markRetrieved(id: string, readerSessionID: string): DelegationRecord | undefined {
		const record = this.updateDelegation(id, (delegation, now) => {
			delegation.retrieval.retrievedAt = now
			delegation.retrieval.retrievalCount += 1
			delegation.retrieval.lastReaderSessionID = readerSessionID
		})
		// The supervisor has now consumed this delegation's result; its child session is no
		// longer needed for navigation and only clutters the TUI's child-session cycle.
		this.maybeCleanupChildSession(id)
		return record
	}

	/**
	 * Delete a finished, already-read delegation's child session so it stops appearing in the
	 * TUI's child-session navigation (ctrl+x ↓ / ←/→). Only fires when the delegation is
	 * terminal AND has been retrieved; the persisted artifact remains the durable record, so
	 * delegation_read keeps working afterwards. No-op when cleanup is disabled
	 * (BACKGROUND_AGENTS_KEEP_CHILD_SESSIONS=1) or the session was already deleted.
	 */
	private maybeCleanupChildSession(id: string): void {
		if (KEEP_CHILD_SESSIONS) return
		const delegation = this.delegations.get(id)
		if (!delegation) return
		if (!isTerminalStatus(delegation.status)) return
		if (!delegation.retrieval.retrievedAt) return
		if (this.cleanedChildSessions.has(delegation.sessionID)) return
		this.cleanedChildSessions.add(delegation.sessionID)
		void this.client.session
			.delete({ path: { id: delegation.sessionID } })
			.then(() => this.debugLog(`Cleaned up child session for read delegation ${delegation.id}`))
			.catch((error: Error) =>
				this.debugLog(
					`maybeCleanupChildSession: delete failed for ${delegation.id}: ${error.message}`,
				),
			)
	}

	private hasUnreadCompletion(delegation: DelegationRecord): boolean {
		if (!isTerminalStatus(delegation.status)) return false
		if (!delegation.notification.terminalNotifiedAt) return false
		if (!delegation.completedAt) return false

		if (!delegation.retrieval.retrievedAt) return true
		return delegation.retrieval.retrievedAt.getTime() < delegation.completedAt.getTime()
	}

	private async waitForTerminal(id: string, timeoutMs: number): Promise<"terminal" | "timeout"> {
		const delegation = this.delegations.get(id)
		if (!delegation) return "timeout"
		if (isTerminalStatus(delegation.status)) return "terminal"

		const waiter = this.terminalWaiters.get(id)
		if (!waiter) return "timeout"

		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			const result = await Promise.race<"terminal" | "timeout">([
				waiter.promise.then(() => "terminal"),
				new Promise<"timeout">((resolve) => {
					timer = setTimeout(() => resolve("timeout"), timeoutMs)
				}),
			])
			return result
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	private async generateUniqueDelegationId(artifactDir: string): Promise<string> {
		for (let attempt = 0; attempt < 20; attempt++) {
			const candidate = this.idGenerator()
			if (this.delegations.has(candidate)) continue

			const candidatePath = path.join(artifactDir, `${candidate}.md`)
			try {
				await fs.access(candidatePath)
			} catch {
				return candidate
			}
		}

		throw new Error("Failed to generate unique delegation ID after 20 attempts")
	}

	private getDelegationBySession(sessionID: string): DelegationRecord | undefined {
		const delegationId = this.delegationsBySession.get(sessionID)
		if (!delegationId) return undefined
		return this.delegations.get(delegationId)
	}

	private isVisibleToSession(delegation: DelegationRecord, rootSessionID: string): boolean {
		return delegation.rootSessionID === rootSessionID
	}

	private buildTerminalNotification(delegation: DelegationRecord, remainingCount: number): string {
		// Title/description/error can come from arbitrary agent output: collapse to a single
		// line so the notification XML never contains broken markdown or multi-line dumps.
		const singleLine = (s: string) => s.replace(/\s+/g, " ").trim()
		const title = delegation.title ? singleLine(delegation.title) : ""
		const description = delegation.description ? singleLine(delegation.description) : ""
		const lines = [
			"<task-notification>",
			`<task-id>${delegation.id}</task-id>`,
			`<status>${delegation.status}</status>`,
			`<summary>Background agent ${delegation.status}: ${title || delegation.id}</summary>`,
			title ? `<title>${title}</title>` : "",
			description ? `<description>${description}</description>` : "",
			delegation.error ? `<error>${singleLine(delegation.error)}</error>` : "",
			`<artifact>${delegation.artifact.filePath}</artifact>`,
			`<retrieval>Use delegation_read("${delegation.id}") for full output.</retrieval>`,
			remainingCount > 0 ? `<remaining>${remainingCount}</remaining>` : "",
			"</task-notification>",
		]

		return lines.filter((line) => line.length > 0).join("\n")
	}

	private buildAllCompleteNotification(
		parentSessionID: string,
		cycle: number,
		cycleToken: string,
	): string {
		// cycle-token is a boundary watermark.
		// Receivers should ignore all-complete payloads whose token is older than
		// the latest known registration cycle for this parent session.
		return [
			"<task-notification>",
			"<type>all-complete</type>",
			"<status>completed</status>",
			"<summary>All delegations complete.</summary>",
			`<parent-session-id>${parentSessionID}</parent-session-id>`,
			`<cycle>${cycle}</cycle>`,
			`<cycle-token>${cycleToken}</cycle-token>`,
			"</task-notification>",
		].join("\n")
	}

	private buildDeterministicTerminalReadResponse(delegation: DelegationRecord): string {
		const lines = [
			`Delegation ID: ${delegation.id}`,
			`Status: ${delegation.status}`,
			`Agent: ${delegation.agent}`,
			`Started: ${delegation.startedAt?.toISOString() || delegation.createdAt.toISOString()}`,
			`Completed: ${delegation.completedAt?.toISOString() || "N/A"}`,
			`Artifact: ${delegation.artifact.filePath}`,
		]

		if (delegation.title) lines.push(`Title: ${delegation.title}`)
		if (delegation.description) lines.push(`Description: ${delegation.description}`)
		if (delegation.error) lines.push(`Error: ${delegation.error}`)

		lines.push(`\nUse delegation_read("${delegation.id}") again after persistence completes.`)
		return lines.join("\n")
	}

	private async readPersistedArtifact(filePath: string): Promise<string | null> {
		try {
			return await fs.readFile(filePath, "utf8")
		} catch {
			return null
		}
	}

	private async waitForPersistedArtifact(
		filePath: string,
		maxWaitMs: number,
	): Promise<string | null> {
		const start = Date.now()
		while (Date.now() - start < maxWaitMs) {
			const content = await this.readPersistedArtifact(filePath)
			if (content !== null) return content
			await new Promise((resolve) => setTimeout(resolve, this.readPollIntervalMs))
		}

		return null
	}

	private async resolveDelegationResult(delegation: DelegationRecord): Promise<string> {
		if (delegation.status === "error") {
			return `Error: ${delegation.error || "Delegation failed."}`
		}

		if (delegation.status === "cancelled") {
			const partial = await this.getResult(delegation)
			return `${partial}\n\n[STOPPED BY SUPERVISOR]`
		}

		if (delegation.status === "timeout") {
			const partial = await this.getResult(delegation)
			return `${partial}\n\n[TIMEOUT REACHED]`
		}

		return await this.getResult(delegation)
	}

	private async finalizeDelegation(
		delegationId: string,
		status: DelegationTerminalStatus,
		error?: string,
	): Promise<void> {
		const { transitioned, delegation } = this.markTerminal(delegationId, status, error)
		if (!transitioned || !delegation) return

		await this.debugLog(`finalizeDelegation(${delegation.id}, ${status}) started`)

		const resolvedResult = await this.resolveDelegationResult(delegation)
		delegation.result = resolvedResult

		if (resolvedResult.trim().length > 0) {
			const metadata = await this.metadataGenerator(
				this.client,
				resolvedResult,
				delegation.sessionID,
				(msg) => this.debugLog(msg),
			)
			delegation.title = metadata.title
			delegation.description = metadata.description
		}

		await this.persistOutput(delegation, resolvedResult)
		await this.notifyParent(delegation.id)
		// Last step: with the artifact persisted and the parent notified, the delegation no
		// longer needs crash recovery. (A crash before this point re-finalizes on restart.)
		this.removeStateFile(delegation)
	}

	private async notifyParent(delegationId: string): Promise<void> {
		try {
			const delegation = this.delegations.get(delegationId)
			if (!delegation) return
			if (!isTerminalStatus(delegation.status)) return
			if (delegation.notification.terminalNotifiedAt) {
				await this.debugLog(`notifyParent skipped for ${delegation.id}; already notified`)
				return
			}

			const remainingCount = this.getPendingCount(delegation.parentSessionID)
			const terminalNotification = this.buildTerminalNotification(delegation, remainingCount)

			// Wake semantics: a completion that still has siblings running (remaining > 0) must
			// WAKE the supervisor (noReply=false) so it can act on this result and steer/await
			// the rest — otherwise an idle supervisor stays dormant until the WHOLE batch
			// settles, even when an actionable result is already in. When this is the last one
			// (remaining === 0) we stay silent here and let the all-complete notification (also
			// noReply=false, scheduled just below) deliver the single wake, avoiding a double-wake.
			const noReply = remainingCount === 0
			const deliveryStatus = await this.sendParentNotification(
				delegation.parentSessionID,
				delegation.parentAgent,
				terminalNotification,
				noReply,
			)

			this.markNotified(delegation.id)

			const toastVariant =
				delegation.status === "complete"
					? ("success" as const)
					: delegation.status === "error"
						? ("error" as const)
						: ("warning" as const)
			void this.showToast(
				`Delegation ${delegation.id} ${delegation.status}${delegation.title ? `: ${delegation.title}` : ""}`,
				toastVariant,
			)

			this.scheduleAllCompleteForParent(delegation.parentSessionID, delegation.parentAgent)

			await this.debugLog(
				`notifyParent ${deliveryStatus} for ${delegation.id} (remaining=${remainingCount}, status=${delegation.status})`,
			)
		} catch (error) {
			await this.debugLog(
				`notifyParent failed for ${delegationId}: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
		}
	}

	/**
	 * Delegate a task to an agent
	 */
	async delegate(input: DelegateInput): Promise<DelegationRecord> {
		// Validate agent exists before creating session
		const agentsResult = await this.client.app.agents({})
		const agents = (agentsResult.data ?? []) as {
			name: string
			description?: string
			mode?: string
		}[]
		const validAgent = agents.find((a) => a.name === input.agent)

		if (!validAgent) {
			const available = agents
				.filter((a) => a.mode === "subagent" || a.mode === "all" || !a.mode)
				.map((a) => `• ${a.name}${a.description ? ` - ${a.description}` : ""}`)
				.join("\n")

			throw new Error(
				`Agent "${input.agent}" not found.\n\nAvailable agents:\n${available || "(none)"}`,
			)
		}

		// Read-only guard. Strict mode rejects write-capable agents (original behavior);
		// relaxed mode (default in this fork) allows them with a logged warning so the
		// undo/branching caveat is observable.
		const { isReadOnly } = await parseAgentWriteCapability(this.client, input.agent, this.log)
		if (!isReadOnly) {
			if (STRICT_READONLY) {
				throw new Error(
					`Agent "${input.agent}" is write-capable and requires the native \`task\` tool for proper undo/branching support.\n\n` +
						`Use \`task\` instead of \`delegate\` for write-capable agents.\n\n` +
						`Read-only sub-agents (edit/write/bash denied) use \`delegate\`.\n` +
						`Write-capable sub-agents (any write permission) use \`task\`.`,
				)
			}
			this.log.warn(
				`delegate: agent "${input.agent}" is write/bash-capable; running it as a background delegation. ` +
					`Its file/bash side effects live outside OpenCode's undo/branching tree and cannot be reverted via the UI. ` +
					`Set BACKGROUND_AGENTS_STRICT_READONLY=1 to forbid this.`,
			)
		}

		const artifactDir = await this.ensureDelegationsDir(input.parentSessionID)
		const rootSessionID = await this.getRootSessionID(input.parentSessionID)
		const stableId = await this.generateUniqueDelegationId(artifactDir)
		const artifactPath = path.join(artifactDir, `${stableId}.md`)

		await this.debugLog(`delegate() called, generated stable ID: ${stableId}`)

		// Create isolated session for delegation. The title doubles as the child session's
		// label in the TUI session list and child-session navigation (ctrl+x ↓ / ←/→), so it
		// leads with the agent name and delegation id to make each running subagent
		// identifiable at a glance instead of a generic "Delegation: <id>".
		const sessionResult = await this.client.session.create({
			body: {
				title: `${input.agent} · ${stableId}`,
				parentID: input.parentSessionID,
			},
		})

		await this.debugLog(`session.create result: ${JSON.stringify(sessionResult.data)}`)

		if (!sessionResult.data?.id) {
			throw new Error("Failed to create delegation session")
		}

		const delegation = this.registerDelegation({
			id: stableId,
			rootSessionID,
			sessionID: sessionResult.data.id,
			parentSessionID: input.parentSessionID,
			parentMessageID: input.parentMessageID,
			parentAgent: input.parentAgent,
			prompt: input.prompt,
			agent: input.agent,
			artifactPath,
			maxRunTimeMs: input.maxRunTimeMs,
			model: input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined,
		})

		await this.debugLog(`Registered delegation ${delegation.id} before execution`)
		this.scheduleTimeout(delegation.id)
		this.markStarted(delegation.id)
		this.persistState(delegation.id)

		// Human-facing dispatch signal. After delegate() returns the supervisor turn ends, so
		// the TUI shows it idle while the child runs in the background — without this toast the
		// dispatch looks like nothing happened. Completion is announced by a second toast.
		void this.showToast(
			`Delegation started: ${delegation.id} → ${input.agent}${
				delegation.model ? ` (${delegation.model})` : ""
			}`,
			"info",
		)

		// Fire the prompt (using prompt() instead of promptAsync() to properly initialize agent loop)
		// Agent param is critical for MCP tools - tells OpenCode which agent's config to use
		// Anti-recursion: a delegated session must not dispatch or control delegations.
		// Disable native task, delegate, and all delegation_* control tools, plus state-modifying helpers.
		this.client.session
			.prompt({
				path: { id: delegation.sessionID },
				body: {
					agent: input.agent,
					// Supervisor-chosen model override; omitted = the agent's configured model.
					...(input.model ? { model: input.model } : {}),
					parts: [{ type: "text", text: input.prompt }],
					tools: {
						task: false,
						delegate: false,
						delegation_steer: false,
						delegation_stop: false,
						delegation_status: false,
						delegation_peek: false,
						delegation_read: false,
						delegation_list: false,
						todowrite: false,
						plan_save: false,
					},
				},
			})
			.then((result) => {
				// A turn that fails server-side (e.g. ProviderModelNotFoundError from a bad
				// `model` override, provider-auth, or context-overflow) still RESOLVES here:
				// the failure rides on the returned assistant message's `error` field, and that
				// errored message is NOT persisted to the transcript. getResult() would then see
				// only the user prompt and mislabel the run "complete" with no output. Detecting
				// it here lets us finalize as `error` immediately, before the session.idle debounce
				// (which also fires for the failed turn) settles it as a silent "complete".
				const turnError = this.extractTurnError(result)
				if (turnError) {
					void this.finalizeDelegation(delegation.id, "error", turnError)
					return
				}
				this.scheduleComplete(delegation.id)
			})
			.catch((error: Error) => {
				void this.finalizeDelegation(delegation.id, "error", error.message)
			})

		return delegation
	}

	/**
	 * Extract a turn-level failure from a `session.prompt` result. Server-side turn errors
	 * resolve the prompt promise (rather than rejecting it) with the failure on
	 * `data.info.error` as `{ name, data: { message? } }`. Typed structurally so the plugin
	 * stays decoupled from the SDK version the host bundles. Returns a one-line
	 * "Name: message" string, or undefined when the turn carried no error.
	 */
	private extractTurnError(result: unknown): string | undefined {
		const error = (
			result as {
				data?: { info?: { error?: { name?: string; data?: { message?: string } } } }
			}
		)?.data?.info?.error
		if (!error) return undefined
		const name = error.name ?? "TurnError"
		const message = error.data?.message?.trim()
		return message ? `${name}: ${message}` : name
	}

	/**
	 * Handle delegation timeout
	 */
	private async handleTimeout(delegationId: string): Promise<void> {
		const delegation = this.delegations.get(delegationId)
		if (!delegation || isTerminalStatus(delegation.status)) return

		await this.debugLog(`handleTimeout for delegation ${delegation.id}`)

		// Try to cancel the session
		try {
			await this.client.session.delete({
				path: { id: delegation.sessionID },
			})
			this.cleanedChildSessions.add(delegation.sessionID)
		} catch {
			// Ignore
		}

		await this.finalizeDelegation(
			delegation.id,
			"timeout",
			`Delegation timed out after ${Math.round(delegation.maxRunTimeMs / 1000)}s`,
		)
	}

	/**
	 * Handle session.idle event - called when a session becomes idle. Schedules the
	 * debounced completion; a native steer delivered in the window re-busies the session
	 * and the steer handler cancels the pending completion.
	 */
	async handleSessionIdle(sessionID: string): Promise<void> {
		const delegation = this.findBySession(sessionID)
		if (!delegation || isTerminalStatus(delegation.status)) return

		await this.debugLog(`handleSessionIdle for delegation ${delegation.id}`)
		this.scheduleComplete(delegation.id)
	}

	/**
	 * Get the result from a delegation's session
	 */
	private async getResult(delegation: DelegationRecord): Promise<string> {
		try {
			const messages = await this.client.session.messages({
				path: { id: delegation.sessionID },
			})

			const messageData = messages.data as SessionMessageItem[] | undefined

			if (!messageData || messageData.length === 0) {
				await this.debugLog(`getResult: No messages found for session ${delegation.sessionID}`)
				return `Delegation "${delegation.description}" completed but produced no output.`
			}

			await this.debugLog(
				`getResult: Found ${messageData.length} messages. Roles: ${messageData.map((m) => m.info.role).join(", ")}`,
			)

			// Find the last message from the assistant/model
			const isAssistantMessage = (m: SessionMessageItem): m is AssistantSessionMessageItem =>
				m.info.role === "assistant"

			const assistantMessages = messageData.filter(isAssistantMessage)

			if (assistantMessages.length === 0) {
				await this.debugLog(
					`getResult: No assistant messages found in ${JSON.stringify(messageData.map((m) => ({ role: m.info.role, keys: Object.keys(m) })))}`,
				)
				return `Delegation "${delegation.description}" completed but produced no assistant response.`
			}

			const lastMessage = assistantMessages[assistantMessages.length - 1]

			// Extract text parts from the message
			const isTextPart = (p: Part): p is TextPart => p.type === "text"
			const textParts = lastMessage.parts.filter(isTextPart)

			if (textParts.length === 0) {
				await this.debugLog(
					`getResult: No text parts found in message: ${JSON.stringify(lastMessage)}`,
				)
				return `Delegation "${delegation.description}" completed but produced no text content.`
			}

			return textParts.map((p) => p.text).join("\n")
		} catch (error) {
			await this.debugLog(
				`getResult error: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
			return `Delegation "${delegation.description}" completed but result could not be retrieved: ${
				error instanceof Error ? error.message : "Unknown error"
			}`
		}
	}

	/**
	 * Persist delegation output to storage
	 */
	private async persistOutput(delegation: DelegationRecord, content: string): Promise<void> {
		try {
			// Use title/description if available (generated by small model), otherwise fallback
			const title = delegation.title || delegation.id
			const description = delegation.description || "(No description generated)"

			const header = `# ${title}

${description}

**ID:** ${delegation.id}
**Agent:** ${delegation.agent}
**Status:** ${delegation.status}
**Session:** ${delegation.sessionID}
**Started:** ${(delegation.startedAt || delegation.createdAt).toISOString()}
**Completed:** ${delegation.completedAt?.toISOString() || "N/A"}

---

`
			await fs.writeFile(delegation.artifact.filePath, header + content, "utf8")

			const stats = await fs.stat(delegation.artifact.filePath)
			this.updateDelegation(delegation.id, (record, now) => {
				record.artifact.persistedAt = now
				record.artifact.byteLength = stats.size
				record.artifact.persistError = undefined
			})

			await this.debugLog(`Persisted output to ${delegation.artifact.filePath}`)
		} catch (error) {
			this.updateDelegation(delegation.id, (record) => {
				record.artifact.persistError =
					error instanceof Error ? error.message : "Unknown persistence error"
			})
			await this.debugLog(
				`Failed to persist output: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
		}
	}

	/**
	 * Read a delegation's output by ID. Blocks if the delegation is still running.
	 */
	async readOutput(sessionID: string, id: string): Promise<string> {
		const normalizedId = normalizeId(id)
		if (!normalizedId) {
			throw new Error("Delegation ID is required")
		}

		const rootSessionID = await this.getRootSessionID(sessionID)
		let delegation = this.delegations.get(normalizedId)
		if (delegation && !this.isVisibleToSession(delegation, rootSessionID)) {
			delegation = undefined
		}

		const fallbackFilePath = path.join(
			await this.getDelegationsDir(sessionID),
			`${normalizedId}.md`,
		)

		const immediateArtifactPath = delegation?.artifact.filePath || fallbackFilePath
		const immediateRead = await this.readPersistedArtifact(immediateArtifactPath)
		if (immediateRead !== null) {
			if (delegation) this.markRetrieved(delegation.id, sessionID)
			return immediateRead
		}

		if (!delegation) {
			throw new Error(
				`Delegation "${normalizedId}" not found.\n\nUse delegation_list() to see available delegations.`,
			)
		}

		if (isActiveStatus(delegation.status)) {
			// With a deadline, wait until it (plus grace). Without one, read cannot block a
			// tool call forever: wait a bounded window, then defer to the <task-notification>.
			const remainingMs = delegation.timeoutAt
				? Math.max(
						delegation.timeoutAt.getTime() - Date.now() + this.terminalWaitGraceMs,
						this.readPollIntervalMs,
					)
				: this.readWaitUnlimitedMs

			await this.debugLog(
				`readOutput: waiting up to ${remainingMs}ms for delegation ${delegation.id} to reach terminal state`,
			)

			const waitResult = await this.waitForTerminal(delegation.id, remainingMs)
			if (waitResult === "timeout" && isActiveStatus(delegation.status)) {
				// Only delegations with a deadline are force-timed-out; an unlimited
				// delegation just keeps running and the caller is told to await the
				// notification.
				if (delegation.timeoutAt) {
					await this.handleTimeout(delegation.id)
				}
			}
		}

		if (isTerminalStatus(delegation.status)) {
			const delayedPersisted = await this.waitForPersistedArtifact(
				delegation.artifact.filePath,
				Math.max(this.readPollIntervalMs * 8, 500),
			)
			if (delayedPersisted !== null) {
				this.markRetrieved(delegation.id, sessionID)
				return delayedPersisted
			}
		}

		const persisted = await this.readPersistedArtifact(delegation.artifact.filePath)
		if (persisted !== null) {
			this.markRetrieved(delegation.id, sessionID)
			return persisted
		}

		if (isTerminalStatus(delegation.status)) {
			return this.buildDeterministicTerminalReadResponse(delegation)
		}

		return `Delegation "${delegation.id}" is still running. You will receive a <task-notification> when it reaches a terminal state.`
	}

	/**
	 * List all delegations for a session
	 */
	async listDelegations(sessionID: string): Promise<DelegationListItem[]> {
		const rootSessionID = await this.getRootSessionID(sessionID)
		const results: DelegationListItem[] = []

		// Add in-memory delegations in this root session scope
		for (const delegation of this.delegations.values()) {
			if (!this.isVisibleToSession(delegation, rootSessionID)) continue

			results.push({
				id: delegation.id,
				status: delegation.status,
				title: delegation.title || delegation.id,
				description:
					delegation.description ||
					(delegation.status === "running" || delegation.status === "registered"
						? "(running)"
						: "(no description)"),
				agent: delegation.agent,
				unread: this.hasUnreadCompletion(delegation),
			})
		}

		// Check filesystem for persisted delegations
		try {
			const dir = await this.getDelegationsDir(rootSessionID)
			const files = await fs.readdir(dir)

			for (const file of files) {
				if (file.endsWith(".md")) {
					const id = file.replace(".md", "")
					// Deduplicate: prioritize in-memory status
					if (!results.find((r) => r.id === id)) {
						// Try to read title, agent, description from file
						let title = "(loaded from storage)"
						let description = ""
						let agent: string | undefined
						let status: DelegationStatus = "complete"
						try {
							const filePath = path.join(dir, file)
							const content = await fs.readFile(filePath, "utf8")
							const titleMatch = content.match(/^# (.+)$/m)
							if (titleMatch) title = titleMatch[1]
							const agentMatch = content.match(/^\*\*Agent:\*\* (.+)$/m)
							if (agentMatch) agent = agentMatch[1]
							const statusMatch = content.match(/^\*\*Status:\*\* (.+)$/m)
							status = parsePersistedStatus(statusMatch?.[1]?.trim())
							// Get first paragraph after title as description
							const lines = content.split("\n")
							if (lines.length > 2 && lines[2]) {
								description = lines[2].slice(0, 150)
							}
						} catch {
							// Ignore read errors
						}
						results.push({
							id,
							status,
							title,
							description,
							agent,
							unread: false,
						})
					}
				}
			}
		} catch {
			// Directory may not exist yet
		}

		results.sort((a, b) => a.id.localeCompare(b.id))
		return results
	}

	/**
	 * Delete a delegation by id (cancels if running, removes from storage)
	 * Used internally for cleanup (timeout, etc.)
	 */
	async deleteDelegation(sessionID: string, id: string): Promise<boolean> {
		const normalizedId = normalizeId(id)
		const delegation = this.delegations.get(normalizedId)

		if (delegation) {
			if (isActiveStatus(delegation.status)) {
				try {
					await this.client.session.delete({
						path: { id: delegation.sessionID },
					})
					this.cleanedChildSessions.add(delegation.sessionID)
				} catch {
					// Session may already be deleted
				}
				this.markTerminal(delegation.id, "cancelled", "Delegation deleted by cleanup")
			}

			this.clearTimeoutTimer(delegation.id)
			this.terminalWaiters.delete(delegation.id)
			this.delegationsBySession.delete(delegation.sessionID)
			this.toolCallsSeen.delete(delegation.id)
			this.removeStateFile(delegation)
			this.delegations.delete(delegation.id)
		}

		// Remove from filesystem
		try {
			const dir = await this.getDelegationsDir(sessionID)
			const filePath = path.join(dir, `${normalizedId}.md`)
			await fs.unlink(filePath)
			return true
		} catch {
			return false
		}
	}

	/**
	 * Find a delegation by its session ID
	 */
	findBySession(sessionID: string): DelegationRecord | undefined {
		return this.getDelegationBySession(sessionID)
	}

	/**
	 * Handle message events for progress tracking
	 */
	handleMessageEvent(sessionID: string, messageText?: string): void {
		const delegation = this.findBySession(sessionID)
		if (!delegation) return
		this.markProgress(delegation.id, messageText)
	}

	/**
	 * Handle message.part.updated events for progress tracking: heartbeat on any part
	 * activity, lastMessage from streamed text parts, and a deduped tool-call counter
	 * (the `message.updated` event does not carry parts, so this is the only place
	 * tool activity is visible to the plugin).
	 */
	handlePartEvent(part: Part): void {
		const delegation = this.findBySession(part.sessionID)
		if (!delegation || isTerminalStatus(delegation.status)) return

		if (part.type === "tool") {
			let seen = this.toolCallsSeen.get(delegation.id)
			if (!seen) {
				seen = new Set()
				this.toolCallsSeen.set(delegation.id, seen)
			}
			seen.add(part.callID)
			const toolCalls = seen.size
			this.markProgress(delegation.id)
			this.updateDelegation(delegation.id, (record) => {
				record.progress.toolCalls = toolCalls
			})
			return
		}

		const text = part.type === "text" && part.text.trim().length > 0 ? part.text : undefined
		this.markProgress(delegation.id, text)
	}

	/**
	 * Get count of pending delegations for a parent session
	 */
	getPendingCount(parentSessionID: string): number {
		const pendingSet = this.pendingByParent.get(parentSessionID)
		if (!pendingSet) return 0
		return Array.from(pendingSet).filter((id) => {
			const delegation = this.delegations.get(id)
			return delegation ? isActiveStatus(delegation.status) : false
		}).length
	}

	/**
	 * Get all currently running delegations (in-memory only)
	 */
	getRunningDelegations(rootSessionID?: string): DelegationRecord[] {
		return Array.from(this.delegations.values()).filter((delegation) => {
			if (rootSessionID && delegation.rootSessionID !== rootSessionID) return false
			return isActiveStatus(delegation.status)
		})
	}

	getUnreadCompletedDelegations(rootSessionID: string, limit = 10): DelegationRecord[] {
		return Array.from(this.delegations.values())
			.filter((delegation) => delegation.rootSessionID === rootSessionID)
			.filter((delegation) => this.hasUnreadCompletion(delegation))
			.sort((a, b) => {
				const aTime = a.completedAt?.getTime() || 0
				const bTime = b.completedAt?.getTime() || 0
				return bTime - aTime
			})
			.slice(0, limit)
	}

	/**
	 * Get recent completed delegations for compaction injection
	 */
	async getRecentCompletedDelegations(
		sessionID: string,
		limit: number = 10,
	): Promise<DelegationListItem[]> {
		const all = await this.listDelegations(sessionID)
		return all.filter((d) => isTerminalStatus(d.status)).slice(-limit)
	}

	/**
	 * Log debug messages
	 */
	async debugLog(msg: string): Promise<void> {
		// Only log if debug is enabled (could be env var or static const)
		// For now, mirroring previous behavior but writing to the new baseDir/debug.log
		const timestamp = new Date().toISOString()
		const line = `${timestamp}: ${msg}\n`
		const debugFile = path.join(this.baseDir, "background-agents-debug.log")

		try {
			await fs.appendFile(debugFile, line, "utf8")
		} catch {
			// Ignore errors, try to ensure dir once if it fails?
			// Simpler to just ignore for debug logs
		}
	}
}

export { DelegationManager }
