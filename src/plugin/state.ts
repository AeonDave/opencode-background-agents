/**
 * Delegation state persistence.
 *
 * Active delegations are mirrored to `<id>.state.json` next to their artifact so a plugin
 * restart can re-adopt them (the in-memory record is otherwise lost and the delegation is
 * orphaned). The state file exists only while the delegation is active: it is removed on
 * finalization, so any state file found at startup marks a delegation that was alive when
 * the previous process exited.
 */

import {
	DEFAULT_MAX_RUN_TIME_MS,
	isTerminalStatus,
	isUnlimitedRunTime,
	parsePersistedStatus,
} from "./types"
import type { DelegationRecord, DelegationStatus } from "./types"

const STATE_VERSION = 1

/** Serialize an active delegation record (Dates become ISO strings via toJSON). */
function serializeDelegation(record: DelegationRecord): string {
	return JSON.stringify({ version: STATE_VERSION, record })
}

function reviveDate(value: unknown): Date | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined
	const date = new Date(value)
	return Number.isNaN(date.getTime()) ? undefined : date
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Deserialize a persisted delegation state file. Returns undefined for unknown versions or
 * structurally invalid payloads — callers treat that as "no restorable state" and clean up.
 */
function deserializeDelegation(json: string): DelegationRecord | undefined {
	let parsed: unknown
	try {
		parsed = JSON.parse(json)
	} catch {
		return undefined
	}
	// JSON.parse can yield null/primitives/arrays: only a plain envelope object is valid.
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
	const envelope = parsed as { version?: unknown; record?: unknown }
	if (envelope.version !== STATE_VERSION) return undefined
	if (typeof envelope.record !== "object" || envelope.record === null || Array.isArray(envelope.record)) {
		return undefined
	}

	const raw = envelope.record as Record<string, unknown>
	const id = asString(raw.id)
	const rootSessionID = asString(raw.rootSessionID)
	const sessionID = asString(raw.sessionID)
	const parentSessionID = asString(raw.parentSessionID)
	const agent = asString(raw.agent)
	const artifact = raw.artifact as Record<string, unknown> | undefined
	const artifactPath = asString(artifact?.filePath)
	if (!id || !rootSessionID || !sessionID || !parentSessionID || !agent || !artifactPath) {
		return undefined
	}

	const status: DelegationStatus = parsePersistedStatus(asString(raw.status))
	const now = new Date()
	const progress = (raw.progress ?? {}) as Record<string, unknown>
	const notification = (raw.notification ?? {}) as Record<string, unknown>
	const retrieval = (raw.retrieval ?? {}) as Record<string, unknown>
	// 0 is a valid persisted value: it means the delegation runs without a deadline.
	const maxRunTimeMs =
		typeof raw.maxRunTimeMs === "number" && raw.maxRunTimeMs >= 0
			? raw.maxRunTimeMs
			: DEFAULT_MAX_RUN_TIME_MS

	return {
		id,
		rootSessionID,
		sessionID,
		parentSessionID,
		parentMessageID: asString(raw.parentMessageID) ?? "",
		parentAgent: asString(raw.parentAgent) ?? "",
		prompt: asString(raw.prompt) ?? "",
		agent,
		notificationCycle: typeof raw.notificationCycle === "number" ? raw.notificationCycle : 0,
		notificationCycleToken: asString(raw.notificationCycleToken) ?? `${parentSessionID}:0`,
		status,
		createdAt: reviveDate(raw.createdAt) ?? now,
		startedAt: reviveDate(raw.startedAt),
		completedAt: reviveDate(raw.completedAt),
		updatedAt: reviveDate(raw.updatedAt) ?? now,
		timeoutAt: isUnlimitedRunTime(maxRunTimeMs)
			? undefined
			: (reviveDate(raw.timeoutAt) ?? new Date(now.getTime() + maxRunTimeMs)),
		maxRunTimeMs,
		model: asString(raw.model),
		progress: {
			toolCalls: typeof progress.toolCalls === "number" ? progress.toolCalls : 0,
			lastUpdateAt: reviveDate(progress.lastUpdateAt) ?? now,
			lastHeartbeatAt: reviveDate(progress.lastHeartbeatAt) ?? now,
			lastMessage: asString(progress.lastMessage),
			lastMessageAt: reviveDate(progress.lastMessageAt),
			steerCount: typeof progress.steerCount === "number" ? progress.steerCount : undefined,
			lastSteerAt: reviveDate(progress.lastSteerAt),
		},
		notification: {
			terminalNotifiedAt: reviveDate(notification.terminalNotifiedAt),
			terminalNotificationCount:
				typeof notification.terminalNotificationCount === "number"
					? notification.terminalNotificationCount
					: 0,
		},
		retrieval: {
			retrievedAt: reviveDate(retrieval.retrievedAt),
			retrievalCount: typeof retrieval.retrievalCount === "number" ? retrieval.retrievalCount : 0,
			lastReaderSessionID: asString(retrieval.lastReaderSessionID),
		},
		artifact: {
			filePath: artifactPath,
			persistedAt: reviveDate(artifact?.persistedAt),
			byteLength: typeof artifact?.byteLength === "number" ? artifact.byteLength : undefined,
			persistError: asString(artifact?.persistError),
		},
		error: asString(raw.error),
		title: asString(raw.title),
		description: asString(raw.description),
		result: asString(raw.result),
	}
}

/** True when the record represents a delegation worth re-adopting after a restart. */
function isRestorableState(record: DelegationRecord): boolean {
	return !isTerminalStatus(record.status)
}

export { serializeDelegation, deserializeDelegation, isRestorableState, STATE_VERSION }
