import { tool } from "@opencode-ai/plugin"
import type { ToolContext, ToolResult } from "@opencode-ai/plugin"
import type { DelegationManager } from "./delegation-manager"
import { DEFAULT_MAX_RUN_TIME_MS, isUnlimitedRunTime, parseModelString } from "./types"

interface DelegateArgs {
	prompt: string
	agent: string
	timeout_minutes?: number
	model?: string
}

function createDelegate(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `Delegate a task to an agent. Returns immediately with a readable ID.

Use this for:
- Research tasks (will be auto-saved)
- Parallel work that can run in background
- Any task where you want persistent, retrievable output

On completion, a notification will arrive with the ID and terminal summary.
Use \`delegation_read\` with the ID to retrieve full persisted output (including after compaction).`,
		args: {
			prompt: tool.schema
				.string()
				.describe("The full detailed prompt for the agent. Must be in English."),
			agent: tool.schema
				.string()
				.describe(
					'Agent to delegate to. Any sub-agent works; write/bash-capable agents run in the background too (their changes live outside undo/branching). Set BACKGROUND_AGENTS_STRICT_READONLY=1 to restrict to read-only sub-agents only.',
				),
			timeout_minutes: tool.schema
				.number()
				.int()
				.min(0)
				.optional()
				.describe(
					`Optional max runtime in minutes for THIS delegation (default ${Math.round(
						DEFAULT_MAX_RUN_TIME_MS / 60_000,
					)}). Use 0 for NO timeout — you stay in control via delegation_steer/delegation_stop. Size it to the task: short for quick lookups, long (or 0) for deep research/builds. A delivered steer re-opens a fresh window of the same size.`,
				),
			model: tool.schema
				.string()
				.optional()
				.describe(
					'Optional model override for THIS delegation as "provider/model-id" (e.g. "anthropic/claude-haiku-4-5"). Size the brain to the task: a cheap/fast model for simple lookups, a strong one for deep work. Omitted = the agent\'s configured model.',
				),
		},
		async execute(args: DelegateArgs, toolCtx: ToolContext): Promise<ToolResult> {
			if (!toolCtx?.sessionID) {
				return "❌ delegate requires sessionID. This is a system error."
			}
			if (!toolCtx?.messageID) {
				return "❌ delegate requires messageID. This is a system error."
			}

			let model: ReturnType<typeof parseModelString>
			if (args.model !== undefined) {
				model = parseModelString(args.model)
				if (!model) {
					return `❌ Invalid model "${args.model}". Expected "provider/model-id" (e.g. "anthropic/claude-haiku-4-5"), or omit it to use the agent's configured model.`
				}
			}

			try {
				const delegation = await manager.delegate({
					parentSessionID: toolCtx.sessionID,
					parentMessageID: toolCtx.messageID,
					parentAgent: toolCtx.agent,
					prompt: args.prompt,
					agent: args.agent,
					// 0 is meaningful (no timeout): only an omitted argument falls back to the default.
					maxRunTimeMs:
						args.timeout_minutes !== undefined ? args.timeout_minutes * 60_000 : undefined,
					model,
				})

				// A plugin tool's `state.title` comes from the RETURNED object, not ctx.metadata
				// (registry.ts:150). We set a concise one — surfaces that render custom-tool
				// titles get a clean header instead of the empty default. Note: OpenCode's
				// generic tool renderer shows the raw args inline regardless of this title; the
				// human-facing "a subagent launched" cue is the dispatch toast + the child
				// session title (`<agent> · <id>`), not this field.
				const modelShort = delegation.model?.split("/").pop()
				const toolTitle = `${args.agent}${modelShort ? ` · ${modelShort}` : ""} · ${delegation.id}`

				// Get total active count for this parent session
				const pendingSet = manager.getPendingCount(toolCtx.sessionID)
				const totalActive = pendingSet

				const timeoutLabel = isUnlimitedRunTime(delegation.maxRunTimeMs)
					? "none (steer/stop it whenever needed)"
					: `${Math.round(delegation.maxRunTimeMs / 60_000)}min (a steer resets the window)`
				let response = `Delegation started: ${delegation.id}\nAgent: ${args.agent}${delegation.model ? `\nModel: ${delegation.model}` : ""}\nTimeout: ${timeoutLabel}`
				if (totalActive > 1) {
					response += `\n\n${totalActive} delegations now active.`
				}
				response += `\nYou WILL be notified when ${totalActive > 1 ? "ALL complete" : "complete"}. Do NOT poll.`

				return { title: toolTitle, output: response }
			} catch (error) {
				// Return validation errors as guidance, not exceptions
				return `❌ Delegation failed:\n\n${error instanceof Error ? error.message : "Unknown error"}`
			}
		},
	})
}

function createDelegationRead(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `Read the output of a delegation by its ID.
Use this to retrieve results from delegated tasks if the inline notification was lost during compaction.`,
		args: {
			id: tool.schema.string().describe("The delegation ID (e.g., 'elegant-blue-tiger')"),
		},
		async execute(args: { id: string }, toolCtx: ToolContext): Promise<ToolResult> {
			if (!toolCtx?.sessionID) {
				return "❌ delegation_read requires sessionID. This is a system error."
			}

			return { title: args.id, output: await manager.readOutput(toolCtx.sessionID, args.id) }
		},
	})
}

function createDelegationList(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `List all delegations for the current session.
Shows both running and completed delegations.`,
		args: {},
		async execute(_args: Record<string, never>, toolCtx: ToolContext): Promise<string> {
			if (!toolCtx?.sessionID) {
				return "❌ delegation_list requires sessionID. This is a system error."
			}

			const delegations = await manager.listDelegations(toolCtx.sessionID)

			if (delegations.length === 0) {
				return "No delegations found for this session."
			}

			const lines = delegations.map((d) => {
				const titlePart = d.title ? ` | ${d.title}` : ""
				const unreadPart = d.unread ? " [unread]" : ""
				const descPart = d.description ? `\n  → ${d.description}` : ""
				return `- **${d.id}**${titlePart} [${d.status}]${unreadPart}${descPart}`
			})

			return `## Delegations\n\n${lines.join("\n")}`
		},
	})
}

function createDelegationSteer(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `Send an extra instruction to a RUNNING delegation without stopping it.
Use to add a constraint, redirect focus, or supply missing context mid-run.
Only works while the delegation is active (registered/running); finished tasks reject.`,
		args: {
			id: tool.schema.string().describe("The delegation ID to steer (e.g., 'elegant-blue-tiger')."),
			message: tool.schema
				.string()
				.describe("The additional instruction to inject into the running agent. Must be in English."),
		},
		async execute(args: { id: string; message: string }, toolCtx: ToolContext): Promise<ToolResult> {
			if (!toolCtx?.sessionID) {
				return "❌ delegation_steer requires sessionID. This is a system error."
			}
			return {
				title: args.id,
				output: await manager.steerDelegation(toolCtx.sessionID, args.id, args.message),
			}
		},
	})
}

function createDelegationPeek(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `Peek at the LIVE transcript of a RUNNING delegation without blocking or stopping it.
Returns a digest of what the agent has done so far (assistant text, tool activity, steers)
so you can decide mid-run whether to steer, stop, or let it continue.
Read-only and instant. Use when a delegation is long-running and you need evidence for a
decision — do NOT call it in a polling loop; completion still arrives via <task-notification>.`,
		args: {
			id: tool.schema.string().describe("The delegation ID to peek at (e.g., 'elegant-blue-tiger')."),
		},
		async execute(args: { id: string }, toolCtx: ToolContext): Promise<ToolResult> {
			if (!toolCtx?.sessionID) {
				return "❌ delegation_peek requires sessionID. This is a system error."
			}
			return { title: args.id, output: await manager.peekDelegation(toolCtx.sessionID, args.id) }
		},
	})
}

function createDelegationStop(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `Stop a RUNNING delegation. Aborts its session and saves any partial output.
Use to cancel work that is off-track, redundant, or no longer needed. Read the
partial result afterwards with delegation_read(id).`,
		args: {
			id: tool.schema.string().describe("The delegation ID to stop."),
		},
		async execute(args: { id: string }, toolCtx: ToolContext): Promise<ToolResult> {
			if (!toolCtx?.sessionID) {
				return "❌ delegation_stop requires sessionID. This is a system error."
			}
			return { title: args.id, output: await manager.stopDelegation(toolCtx.sessionID, args.id) }
		},
	})
}

function createDelegationStatus(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `Show live status of active delegations: status, elapsed time, tool calls,
last heartbeat, steer count, and last activity. Use to decide whether to steer or
stop a task. This is a cheap status check — it does NOT block or poll for completion.`,
		args: {},
		async execute(_args: Record<string, never>, toolCtx: ToolContext): Promise<string> {
			if (!toolCtx?.sessionID) {
				return "❌ delegation_status requires sessionID. This is a system error."
			}
			return await manager.getStatusReport(toolCtx.sessionID)
		},
	})
}

export {
	createDelegate,
	createDelegationList,
	createDelegationPeek,
	createDelegationRead,
	createDelegationStatus,
	createDelegationSteer,
	createDelegationStop,
}
