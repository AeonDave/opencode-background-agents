import type { Message, Part } from "@opencode-ai/sdk"
import type { generateMetadata } from "./metadata"

interface SessionMessageItem {
	info: Message
	parts: Part[]
}

interface AssistantSessionMessageItem {
	info: Message & { role: "assistant" }
	parts: Part[]
}

type DelegationStatus = "registered" | "running" | "complete" | "error" | "cancelled" | "timeout"

type DelegationTerminalStatus = Extract<
	DelegationStatus,
	"complete" | "error" | "cancelled" | "timeout"
>

interface DelegationProgress {
	toolCalls: number
	lastUpdateAt: Date
	lastHeartbeatAt: Date
	lastMessage?: string
	lastMessageAt?: Date
	steerCount?: number
	lastSteerAt?: Date
}

interface DelegationNotificationState {
	terminalNotifiedAt?: Date
	terminalNotificationCount: number
}

interface ParentNotificationState {
	allCompleteNotifiedAt?: Date
	allCompleteNotificationCount: number
	allCompleteCycle: number
	allCompleteCycleToken: string
	allCompleteNotifiedCycle?: number
	allCompleteNotifiedCycleToken?: string
	allCompleteScheduledCycle?: number
	allCompleteScheduledCycleToken?: string
	allCompleteScheduledTimer?: ReturnType<typeof setTimeout>
}

interface DelegationRetrievalState {
	retrievedAt?: Date
	retrievalCount: number
	lastReaderSessionID?: string
}

interface DelegationArtifactState {
	filePath: string
	persistedAt?: Date
	byteLength?: number
	persistError?: string
}

interface DelegationRecord {
	id: string
	rootSessionID: string
	sessionID: string
	parentSessionID: string
	parentMessageID: string
	parentAgent: string
	prompt: string
	agent: string
	notificationCycle: number
	notificationCycleToken: string
	status: DelegationStatus
	createdAt: Date
	startedAt?: Date
	completedAt?: Date
	updatedAt: Date
	timeoutAt: Date
	progress: DelegationProgress
	notification: DelegationNotificationState
	retrieval: DelegationRetrievalState
	artifact: DelegationArtifactState
	error?: string
	title?: string
	description?: string
	result?: string
}

const DEFAULT_MAX_RUN_TIME_MS = 15 * 60 * 1000 // 15 minutes
const TERMINAL_WAIT_GRACE_MS = 10_000
const READ_POLL_INTERVAL_MS = 250
const ALL_COMPLETE_QUIET_PERIOD_MS = 50
const PARENT_NOTIFICATION_TIMEOUT_MS = 5_000
// Debounced completion: a delegation is finalized COMPLETE_DEBOUNCE_MS after the
// session signals it is done, so an in-flight steer can cancel and extend the run.
// This also dedupes the prompt-resolve + session.idle double finalization.
const COMPLETE_DEBOUNCE_MS = 750
// Robust stop: `session.abort` is best-effort/cooperative and can silently no-op over
// the SDK (opencode #29894 / #21176). After aborting we wait up to STOP_GRACE_MS for the
// session to settle; if it is still active we hard-delete it so it cannot keep running.
const STOP_GRACE_MS = 1_500
// Stall watchdog: subagent sessions driven over the SDK can hang with status stuck on
// "busy" and never emit `session.idle` (opencode #6573); the prompt `.then()` may also
// never resolve. The watchdog periodically re-checks delegations whose heartbeat has been
// silent for STALL_CHECK_MS by polling `session.status`. A confirmed-idle session means we
// missed the idle event (→ schedule completion); a confirmed-error finalizes early. We
// never finalize on heartbeat silence alone — long LLM/bash calls legitimately emit no
// message events — only when the server confirms the session is no longer running.
const WATCHDOG_INTERVAL_MS = 5_000
const STALL_CHECK_MS = 20_000
// Read-only guard relaxation. By default this fork ALLOWS write/bash-capable
// sub-agents to use `delegate` (needed for offensive operators that run bash/MCP
// tooling), logging a warning about the undo/branching caveat. Set
// BACKGROUND_AGENTS_STRICT_READONLY=1 to restore the original strict behavior
// that rejects write-capable agents and forces them onto the native `task` tool.
const STRICT_READONLY = process.env.BACKGROUND_AGENTS_STRICT_READONLY === "1"

interface DelegateInput {
	parentSessionID: string
	parentMessageID: string
	parentAgent: string
	prompt: string
	agent: string
}

interface DelegationListItem {
	id: string
	status: DelegationStatus
	title?: string
	description?: string
	agent?: string
	unread?: boolean
}

interface DelegationManagerOptions {
	maxRunTimeMs?: number
	readPollIntervalMs?: number
	terminalWaitGraceMs?: number
	allCompleteQuietPeriodMs?: number
	idGenerator?: () => string
	metadataGenerator?: typeof generateMetadata
}

function isTerminalStatus(status: DelegationStatus): status is DelegationTerminalStatus {
	return (
		status === "complete" || status === "error" || status === "cancelled" || status === "timeout"
	)
}

function isActiveStatus(status: DelegationStatus): boolean {
	return status === "registered" || status === "running"
}

function normalizeId(value: string): string {
	return value.trim()
}

function parsePersistedStatus(raw: string | undefined): DelegationStatus {
	if (!raw) return "complete"
	if (raw === "registered") return "registered"
	if (raw === "running") return "running"
	if (raw === "complete") return "complete"
	if (raw === "error") return "error"
	if (raw === "cancelled") return "cancelled"
	if (raw === "timeout") return "timeout"
	return "complete"
}

export type {
	SessionMessageItem,
	AssistantSessionMessageItem,
	DelegationStatus,
	DelegationTerminalStatus,
	DelegationProgress,
	DelegationNotificationState,
	ParentNotificationState,
	DelegationRetrievalState,
	DelegationArtifactState,
	DelegationRecord,
	DelegateInput,
	DelegationListItem,
	DelegationManagerOptions,
}
export {
	DEFAULT_MAX_RUN_TIME_MS,
	TERMINAL_WAIT_GRACE_MS,
	READ_POLL_INTERVAL_MS,
	ALL_COMPLETE_QUIET_PERIOD_MS,
	PARENT_NOTIFICATION_TIMEOUT_MS,
	COMPLETE_DEBOUNCE_MS,
	STOP_GRACE_MS,
	WATCHDOG_INTERVAL_MS,
	STALL_CHECK_MS,
	STRICT_READONLY,
	isTerminalStatus,
	isActiveStatus,
	normalizeId,
	parsePersistedStatus,
}
