/**
 * background-agents
 * Unified delegation system for OpenCode
 *
 * Replaces native `task` tool with persistent, async-first agent delegation.
 * All agent outputs are persisted to storage, orchestrator receives only key references.
 *
 * Based on oh-my-opencode by @code-yeongyu (MIT License)
 * https://github.com/code-yeongyu/oh-my-opencode
 *
 * This file is the plugin entry point. Implementation is split into sibling modules:
 *   id - metadata - types - logger - agent-capability - delegation-manager - tools - rules - context
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { parseAgentMode, parseAgentWriteCapability } from "./agent-capability"
import { formatDelegationContext } from "./context"
import { DelegationManager } from "./delegation-manager"
import { createLogger } from "./logger"
import { createNativeSteer } from "./native"
import { getProjectId } from "./primitives/get-project-id"
import type { OpencodeClient } from "./primitives/types"
import { DELEGATION_RULES } from "./rules"
import { deserializeDelegation, serializeDelegation } from "./state"
import {
	createDelegate,
	createDelegationList,
	createDelegationPeek,
	createDelegationRead,
	createDelegationStatus,
	createDelegationSteer,
	createDelegationStop,
} from "./tools"
import { STRICT_READONLY } from "./types"

/**
 * Expected input for experimental.chat.system.transform hook.
 */
interface SystemTransformInput {
	agent?: string
	sessionID?: string
}

const BackgroundAgentsPlugin: Plugin = async (ctx) => {
	const { client, directory } = ctx

	// Create logger early for all components
	const log = createLogger(client as OpencodeClient)

	// Project-level storage directory (shared across sessions)
	// Uses git root commit hash for cross-worktree consistency
	const projectId = await getProjectId(directory, client as OpencodeClient)
	const baseDir = path.join(os.homedir(), ".local", "share", "opencode", "delegations", projectId)

	// Ensure base directory exists (for debug logs etc)
	await fs.mkdir(baseDir, { recursive: true })

	// Native server-side steering (opencode >= 1.17 exposes serverUrl and the v2 prompt
	// route with delivery:"steer"). Older hosts: undefined → v1 fallback inside the manager.
	const serverUrl = (ctx as { serverUrl?: URL }).serverUrl
	const nativeSteer = serverUrl ? createNativeSteer(serverUrl, log) : undefined

	const manager = new DelegationManager(client as OpencodeClient, baseDir, log, { nativeSteer })

	await manager.debugLog("BackgroundAgentsPlugin initialized with delegation system")

	// Re-adopt delegations orphaned by a previous process exit (fire-and-forget so plugin
	// load is never delayed; reconciliation settles them as the server responds).
	void manager.restoreActiveDelegations()

	return {
		tool: {
			delegate: createDelegate(manager),
			delegation_read: createDelegationRead(manager),
			delegation_list: createDelegationList(manager),
			delegation_peek: createDelegationPeek(manager),
			delegation_steer: createDelegationSteer(manager),
			delegation_stop: createDelegationStop(manager),
			delegation_status: createDelegationStatus(manager),
		},

		// Prevent read-only agents from using native task tool (symmetric to delegate enforcement)
		"tool.execute.before": async (
			input: { tool: string },
			output: { args?: { subagent_type?: string } },
		) => {
			// Guard: Only intercept task tool
			if (input.tool !== "task") return

			// Guard: Require agent name
			const agentName = output.args?.subagent_type
			if (!agentName) return

			// Parse boundary 1: Check agent mode
			const { isSubAgent } = await parseAgentMode(client as OpencodeClient, agentName, log)

			// Guard: Allow non-sub-agents (main/built-in)
			if (!isSubAgent) return

			// Relaxed mode (default): every sub-agent — read-only OR write-capable — must go
			// through `delegate` so it runs async in the background. The native `task` tool is
			// synchronous and would BLOCK this supervisor session until the sub-agent finishes,
			// which is exactly the bug this guard prevents. Redirect all sub-agents to delegate.
			if (!STRICT_READONLY) {
				throw new Error(
					`❌ Agent '${agentName}' is a sub-agent — use the delegate tool for async background execution.\n\n` +
						`The native task tool runs synchronously and blocks this session until the sub-agent finishes.\n` +
						`Call delegate(agent="${agentName}", prompt=...) instead — it returns an ID immediately and runs in the background.\n` +
						`(Set BACKGROUND_AGENTS_STRICT_READONLY=1 to route write-capable sub-agents through task instead.)`,
				)
			}

			// Strict mode: only read-only sub-agents are forced onto delegate; write-capable
			// sub-agents keep using the native task tool to preserve undo/branching.
			const { isReadOnly } = await parseAgentWriteCapability(
				client as OpencodeClient,
				agentName,
				log,
			)

			// Guard: Allow write-capable agents (strict mode only)
			if (!isReadOnly) return

			// Fail fast: Read-only sub-agent via task is invalid
			throw new Error(
				`❌ Agent '${agentName}' is read-only and should use the delegate tool for async background execution.\n\n` +
					`Read-only agents have: edit="deny", write="deny", bash={"*":"deny"}\n` +
					`Use delegate for read-only sub-agents.\n` +
					`Use task for write-capable sub-agents.`,
			)
		},

		// Inject delegation rules into system prompt
		"experimental.chat.system.transform": async (_input: SystemTransformInput, output) => {
			output.system.push(DELEGATION_RULES)
		},

		// Deliver queued parent notifications on the next user turn if direct delivery failed.
		"chat.message": async (
			input: { sessionID?: string },
			output: { message?: { id?: string }; parts?: Array<{ type: string; text?: string }> },
		) => {
			if (!input.sessionID) return
			manager.injectPendingNotificationsIntoChatMessage(output, input.sessionID)
		},

		// Compaction hook - inject delegation context for context recovery
		"experimental.session.compacting": async (
			input: { sessionID: string },
			output: { context: string[]; prompt?: string },
		) => {
			const rootSessionID = await manager.getRootSessionID(input.sessionID)

			// Running delegations in this root session tree
			const running = manager.getRunningDelegations(rootSessionID).map((d) => ({
				id: d.id,
				agent: d.agent,
				title: d.title,
				description: d.description,
				status: d.status,
				startedAt: d.startedAt,
				lastHeartbeatAt: d.progress.lastHeartbeatAt,
				prompt: d.prompt,
			}))

			// Unread completed delegations to carry forward through compaction
			const unreadCompleted = manager.getUnreadCompletedDelegations(rootSessionID, 10).map((d) => ({
				id: d.id,
				agent: d.agent,
				title: d.title,
				description: d.description,
				status: d.status,
				completedAt: d.completedAt,
			}))

			// Early exit if nothing to inject
			if (running.length === 0 && unreadCompleted.length === 0) return

			output.context.push(formatDelegationContext(running, unreadCompleted))
		},

		// Event hook
		event: async ({ event }: { event: Event }): Promise<void> => {
			if (event.type === "session.status") {
				const statusType = event.properties.status?.type
				const sessionID = event.properties.sessionID
				if (statusType === "idle" && sessionID) {
					await manager.handleSessionIdle(sessionID)
				}
			}

			if (event.type === "session.idle") {
				const sessionID = event.properties.sessionID
				if (sessionID) {
					await manager.handleSessionIdle(sessionID)
				}
			}

			// message.updated carries only the message info (no parts): use it as a heartbeat.
			if (event.type === "message.updated") {
				const sessionID = event.properties.info.sessionID
				if (sessionID) {
					manager.handleMessageEvent(sessionID)
				}
			}

			// Part-level updates carry the actual content: text for lastMessage,
			// tool parts for the tool-call counter, and a heartbeat either way.
			if (event.type === "message.part.updated") {
				manager.handlePartEvent(event.properties.part)
			}
		},
	}
}

const BackgroundAgentsPluginWithInternals = Object.assign(BackgroundAgentsPlugin, {
	testInternals: {
		DelegationManager,
		formatDelegationContext,
		serializeDelegation,
		deserializeDelegation,
	},
} as const)

export default BackgroundAgentsPluginWithInternals
