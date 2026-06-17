import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { DelegationManager } from "../src/plugin/delegation-manager"
import type { Logger } from "../src/plugin/logger"
import type { OpencodeClient } from "../src/plugin/primitives/types"
import { serializeDelegation } from "../src/plugin/state"
import type { DelegationRecord } from "../src/plugin/types"

const noopLogger: Logger = {
	debug: () => Promise.resolve(),
	info: () => Promise.resolve(),
	warn: () => Promise.resolve(),
	error: () => Promise.resolve(),
}

interface RecordedPart {
	type: string
	text?: string
	synthetic?: boolean
}

interface RecordedPromptCall {
	sessionID: string
	body: {
		noReply?: boolean
		agent?: string
		model?: { providerID: string; modelID: string }
		parts: RecordedPart[]
		tools?: Record<string, boolean>
	}
}

interface FakeClientState {
	sessionCounter: number
	/** Deferred resolvers for client.session.prompt — one per delegated child session. */
	promptResolvers: Map<string, { resolve: (value: unknown) => void; reject: (e: Error) => void }>
	promptCalls: RecordedPromptCall[]
	promptAsyncCalls: RecordedPromptCall[]
	abortedSessions: string[]
	deletedSessions: string[]
	toasts: Array<{ title?: string; message?: string; variant?: string }>
	/** Session IDs whose promptAsync rejects (simulates busy-session rejection). */
	failPromptAsyncFor: Set<string>
	/** Override transcripts per session for messages()/peek/getResult. */
	messagesBySession: Map<string, unknown[]>
	/** /session/status map: only busy/retry entries exist; absent = settled. */
	statusMap: Record<string, { type: string }>
}

function createFakeClient(): { client: OpencodeClient; state: FakeClientState } {
	const state: FakeClientState = {
		sessionCounter: 0,
		promptResolvers: new Map(),
		promptCalls: [],
		promptAsyncCalls: [],
		abortedSessions: [],
		deletedSessions: [],
		toasts: [],
		failPromptAsyncFor: new Set(),
		messagesBySession: new Map(),
		statusMap: {},
	}

	const defaultTranscript = [
		{
			info: { role: "assistant" },
			parts: [{ type: "text", text: "FINAL RESULT" }],
		},
	]

	const client = {
		app: {
			agents: async () => ({
				data: [{ name: "researcher", description: "research things", mode: "subagent" }],
			}),
			log: async () => ({}),
		},
		config: {
			// researcher is read-only so delegate() takes the quiet path.
			get: async () => ({
				data: {
					agent: {
						researcher: { permission: { edit: "deny", write: "deny", bash: "deny" } },
					},
				},
			}),
		},
		tui: {
			showToast: async (input: { body: FakeClientState["toasts"][number] }) => {
				state.toasts.push(input.body)
				return {}
			},
		},
		session: {
			get: async (input: { path: { id: string } }) => ({
				data: { id: input.path.id, parentID: undefined },
			}),
			create: async () => {
				state.sessionCounter += 1
				return { data: { id: `ses_child_${state.sessionCounter}` } }
			},
			status: async () => ({ data: state.statusMap }),
			prompt: (input: { path: { id: string }; body: RecordedPromptCall["body"] }) => {
				state.promptCalls.push({ sessionID: input.path.id, body: input.body })
				return new Promise((resolve, reject) => {
					state.promptResolvers.set(input.path.id, { resolve, reject })
				})
			},
			promptAsync: async (input: { path: { id: string }; body: RecordedPromptCall["body"] }) => {
				if (state.failPromptAsyncFor.has(input.path.id)) {
					throw new Error("session is busy")
				}
				state.promptAsyncCalls.push({ sessionID: input.path.id, body: input.body })
				return {}
			},
			abort: async (input: { path: { id: string } }) => {
				state.abortedSessions.push(input.path.id)
				return {}
			},
			delete: async (input: { path: { id: string } }) => {
				state.deletedSessions.push(input.path.id)
				return {}
			},
			messages: async (input: { path: { id: string } }) => ({
				data: state.messagesBySession.get(input.path.id) ?? defaultTranscript,
			}),
		},
	}

	return { client: client as unknown as OpencodeClient, state }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error("waitFor: condition not met in time")
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.()
	}
})

async function setup(options: { nativeSteer?: (sessionID: string, text: string) => Promise<boolean> } = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-agents-test-"))
	const { client, state } = createFakeClient()
	let idCounter = 0
	const manager = new DelegationManager(client, dir, noopLogger, {
		completeDebounceMs: 10,
		readPollIntervalMs: 10,
		terminalWaitGraceMs: 50,
		allCompleteQuietPeriodMs: 5,
		readWaitUnlimitedMs: 150,
		idGenerator: () => `task-${++idCounter}`,
		metadataGenerator: async () => ({ title: "Stub title", description: "Stub description" }),
		nativeSteer: options.nativeSteer,
	})
	cleanups.push(async () => {
		manager.dispose()
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
	})
	return { manager, state, dir, client }
}

function delegateInput(overrides: Record<string, unknown> = {}) {
	return {
		parentSessionID: "ses_parent",
		parentMessageID: "msg_parent",
		parentAgent: "build",
		prompt: "Research the topic",
		agent: "researcher",
		...overrides,
	}
}

describe("async delegation", () => {
	test("delegate() returns while the subagent prompt is still pending", async () => {
		const { manager, state } = await setup()
		const record = await manager.delegate(delegateInput())

		// The supervisor got control back although the child prompt has not resolved.
		expect(record.status).toBe("running")
		expect(state.promptResolvers.has(record.sessionID)).toBe(true)
		expect(state.promptAsyncCalls.length).toBe(0)

		// Anti-recursion: the child cannot dispatch or control delegations.
		const promptCall = state.promptCalls.find((c) => c.sessionID === record.sessionID)
		expect(promptCall?.body.tools?.task).toBe(false)
		expect(promptCall?.body.tools?.delegate).toBe(false)
		expect(promptCall?.body.tools?.delegation_steer).toBe(false)
		expect(promptCall?.body.agent).toBe("researcher")
	})

	test("dispatch surfaces a clean 'started' toast (the on-screen cue a subagent launched)", async () => {
		const { manager, state } = await setup()
		const record = await manager.delegate(delegateInput({ agent: "researcher" }))

		await waitFor(() => state.toasts.some((t) => t.message?.startsWith("Delegation started")))
		const started = state.toasts.find((t) => t.message?.startsWith("Delegation started"))
		expect(started?.message).toContain(record.id)
		expect(started?.message).toContain("researcher")
		// Kept clean: the navigation hint lives in the supervisor's announcement, not the toast.
		expect(started?.message?.toLowerCase()).not.toContain("ctrl")
	})

	test("model override is passed to the child prompt and recorded on the delegation", async () => {
		const { manager, state } = await setup()
		const record = await manager.delegate(
			delegateInput({ model: { providerID: "anthropic", modelID: "claude-haiku-4-5" } }),
		)

		expect(record.model).toBe("anthropic/claude-haiku-4-5")
		const promptCall = state.promptCalls.find((c) => c.sessionID === record.sessionID)
		expect(promptCall?.body.model).toEqual({
			providerID: "anthropic",
			modelID: "claude-haiku-4-5",
		})

		const report = await manager.getStatusReport("ses_parent")
		expect(report).toContain("model=anthropic/claude-haiku-4-5")
	})

	test("without a model override the child prompt carries none (agent default applies)", async () => {
		const { manager, state } = await setup()
		const record = await manager.delegate(delegateInput())

		expect(record.model).toBeUndefined()
		const promptCall = state.promptCalls.find((c) => c.sessionID === record.sessionID)
		expect(promptCall?.body.model).toBeUndefined()
	})

	test("unknown agent is rejected before any session is created", async () => {
		const { manager, state } = await setup()
		await expect(manager.delegate(delegateInput({ agent: "ghost" }))).rejects.toThrow(
			/Agent "ghost" not found/,
		)
		expect(state.sessionCounter).toBe(0)
	})
})

describe("completion and notifications", () => {
	test("prompt resolution finalizes the delegation, persists artifact, notifies parent", async () => {
		const { manager, state } = await setup()
		const record = await manager.delegate(delegateInput())

		state.promptResolvers.get(record.sessionID)?.resolve({})
		await waitFor(() => record.status === "complete")

		// Artifact persisted with header + result.
		const artifact = await fs.readFile(record.artifact.filePath, "utf8")
		expect(artifact).toContain("FINAL RESULT")
		expect(artifact).toContain("Stub title")
		expect(artifact).toContain(`**ID:** ${record.id}`)

		// Terminal notification: synthetic part to the parent, noReply so it doesn't wake it.
		await waitFor(() =>
			state.promptAsyncCalls.some(
				(c) => c.sessionID === "ses_parent" && c.body.parts[0]?.text?.includes("<task-id>"),
			),
		)
		const terminal = state.promptAsyncCalls.find(
			(c) => c.sessionID === "ses_parent" && c.body.parts[0]?.text?.includes("<task-id>"),
		)
		expect(terminal?.body.noReply).toBe(true)
		expect(terminal?.body.parts[0]?.synthetic).toBe(true)
		expect(terminal?.body.parts[0]?.text).toContain(`<task-id>${record.id}</task-id>`)
		expect(terminal?.body.parts[0]?.text).toContain("delegation_read")

		// All-complete: noReply=false wakes the supervisor exactly once per cycle.
		await waitFor(() =>
			state.promptAsyncCalls.some((c) => c.body.parts[0]?.text?.includes("all-complete")),
		)
		const allComplete = state.promptAsyncCalls.find((c) =>
			c.body.parts[0]?.text?.includes("all-complete"),
		)
		expect(allComplete?.body.noReply).toBe(false)
		expect(allComplete?.body.parts[0]?.synthetic).toBe(true)

		// Human-facing channel: toasts, not raw XML.
		await waitFor(() => state.toasts.length >= 2)
		expect(state.toasts.some((t) => t.message?.includes(record.id))).toBe(true)
		expect(state.toasts.some((t) => t.message === "All delegations complete.")).toBe(true)

		// State file is gone once the delegation no longer needs crash recovery.
		const stateFile = record.artifact.filePath.replace(/\.md$/, ".state.json")
		await sleep(50) // removeStateFile is fire-and-forget
		await expect(fs.access(stateFile)).rejects.toThrow()
	})

	test("prompt rejection finalizes as error and still notifies the parent", async () => {
		const { manager, state } = await setup()
		const record = await manager.delegate(delegateInput())

		state.promptResolvers.get(record.sessionID)?.reject(new Error("model exploded"))
		await waitFor(() => record.status === "error")

		const artifact = await fs.readFile(record.artifact.filePath, "utf8")
		expect(artifact).toContain("model exploded")
		await waitFor(() =>
			state.promptAsyncCalls.some((c) => c.body.parts[0]?.text?.includes("<status>error</status>")),
		)
	})

	test("a completion with siblings still running WAKES the supervisor (noReply=false)", async () => {
		// Regression: an idle supervisor must be woken as soon as ANY delegation completes
		// while others are still running, so it can act on the result and steer/await the
		// rest. Previously every terminal notification used noReply=true, leaving the
		// supervisor dormant until the WHOLE batch settled.
		const { manager, state } = await setup()
		const first = await manager.delegate(delegateInput())
		const second = await manager.delegate(delegateInput())

		// Only the FIRST finishes; the SECOND keeps running (remaining = 1).
		state.promptResolvers.get(first.sessionID)?.resolve({})
		await waitFor(() => first.status === "complete")
		expect(second.status).toBe("running")

		await waitFor(() =>
			state.promptAsyncCalls.some(
				(c) =>
					c.sessionID === "ses_parent" &&
					c.body.parts[0]?.text?.includes(`<task-id>${first.id}</task-id>`),
			),
		)
		const terminal = state.promptAsyncCalls.find(
			(c) =>
				c.sessionID === "ses_parent" &&
				c.body.parts[0]?.text?.includes(`<task-id>${first.id}</task-id>`),
		)
		// remaining > 0 → must wake the supervisor.
		expect(terminal?.body.noReply).toBe(false)
		expect(terminal?.body.parts[0]?.text).toContain("<remaining>1</remaining>")

		// The batch is not complete yet, so no all-complete wake has fired.
		expect(
			state.promptAsyncCalls.some((c) => c.body.parts[0]?.text?.includes("all-complete")),
		).toBe(false)
	})

	test("the LAST completion stays silent and all-complete delivers exactly one final wake", async () => {
		// Boundary of the wake fix: across a full batch the supervisor must be woken exactly
		// TWICE — once by the first completion (siblings remained) and once by all-complete —
		// never a third time. The last completion itself (remaining === 0) must stay silent
		// (noReply=true) so it does not double-wake alongside all-complete.
		const { manager, state } = await setup()
		const first = await manager.delegate(delegateInput())
		const second = await manager.delegate(delegateInput())

		state.promptResolvers.get(first.sessionID)?.resolve({})
		await waitFor(() => first.status === "complete")
		state.promptResolvers.get(second.sessionID)?.resolve({})
		await waitFor(() => second.status === "complete")

		// Wait until the all-complete wake has been dispatched.
		await waitFor(() =>
			state.promptAsyncCalls.some((c) => c.body.parts[0]?.text?.includes("all-complete")),
		)

		const wakeText = (c: RecordedPromptCall) => c.body.parts[0]?.text ?? ""
		const parentCalls = state.promptAsyncCalls.filter((c) => c.sessionID === "ses_parent")

		// The last completion's terminal notification stays silent.
		const secondTerminal = parentCalls.find((c) =>
			wakeText(c).includes(`<task-id>${second.id}</task-id>`),
		)
		expect(secondTerminal?.body.noReply).toBe(true)
		expect(secondTerminal?.body.parts[0]?.text).not.toContain("<remaining>")

		// Exactly two wakes total: first terminal (remaining>0) + all-complete.
		const wakes = parentCalls.filter((c) => c.body.noReply === false)
		expect(wakes.length).toBe(2)
		expect(wakes.filter((c) => wakeText(c).includes("all-complete")).length).toBe(1)
		expect(
			wakes.filter((c) => wakeText(c).includes(`<task-id>${first.id}</task-id>`)).length,
		).toBe(1)
	})

	test("a turn error on the resolved prompt finalizes as error, not silent complete", async () => {
		// Regression: a server-side turn failure (e.g. a bad model override →
		// ProviderModelNotFoundError) RESOLVES session.prompt() with the error on
		// data.info.error, and the errored assistant message is never persisted. The run
		// must surface as `error`, not the misleading "complete with no output".
		const { manager, state } = await setup()
		const record = await manager.delegate(delegateInput())

		// No assistant message in the transcript — exactly what the live failure produced.
		state.messagesBySession.set(record.sessionID, [{ info: { role: "user" }, parts: [] }])
		state.promptResolvers.get(record.sessionID)?.resolve({
			data: {
				info: {
					role: "assistant",
					error: {
						name: "ProviderModelNotFoundError",
						data: { message: "model anthropic/claude-sonnet-4-5 not found" },
					},
				},
				parts: [],
			},
		})

		await waitFor(() => record.status === "error")
		expect(record.error).toContain("ProviderModelNotFoundError")
		expect(record.error).toContain("claude-sonnet-4-5")

		const artifact = await fs.readFile(record.artifact.filePath, "utf8")
		expect(artifact).toContain("ProviderModelNotFoundError")
		await waitFor(() =>
			state.promptAsyncCalls.some((c) => c.body.parts[0]?.text?.includes("<status>error</status>")),
		)
	})

	test("undeliverable parent notification is queued and injected into the next chat message", async () => {
		const { manager, state } = await setup()
		const record = await manager.delegate(delegateInput())

		// Parent session rejects prompts → notification falls back to the queue.
		state.failPromptAsyncFor.add("ses_parent")
		state.promptResolvers.get(record.sessionID)?.resolve({})
		await waitFor(() => record.status === "complete")
		await sleep(50) // let notifyParent + all-complete settle into the queue

		const output: { message?: { id?: string }; parts?: Array<{ type: string; text?: string }> } = {
			message: { id: "msg_next" },
			parts: [{ type: "text", text: "user says hi" }],
		}
		manager.injectPendingNotificationsIntoChatMessage(output, "ses_parent")

		expect(output.parts?.length).toBe(2)
		const injected = output.parts?.[1] as RecordedPart & { id?: string }
		expect(injected.synthetic).toBe(true)
		expect(injected.text).toContain("<task-notification>")
		expect(injected.id?.startsWith("prt")).toBe(true)

		// Queue is drained: a second injection is a no-op.
		const again = { parts: [] as Array<{ type: string; text?: string }> }
		manager.injectPendingNotificationsIntoChatMessage(again, "ses_parent")
		expect(again.parts.length).toBe(0)
	})
})

describe("steering", () => {
	test("native steer is preferred: delivered server-side, counts, re-opens the timeout window", async () => {
		const nativeCalls: Array<{ sessionID: string; text: string }> = []
		const { manager, state } = await setup({
			nativeSteer: async (sessionID, text) => {
				nativeCalls.push({ sessionID, text })
				return true
			},
		})
		const record = await manager.delegate(delegateInput({ maxRunTimeMs: 60_000 }))
		const originalDeadline = record.timeoutAt?.getTime()
		expect(originalDeadline).toBeDefined()

		await sleep(25)
		const reply = await manager.steerDelegation("ses_parent", record.id, "focus on X")
		expect(reply).toContain("✅")

		expect(nativeCalls).toEqual([
			{ sessionID: record.sessionID, text: "[SUPERVISOR STEER] focus on X" },
		])
		// The v1 fallback must NOT have been used.
		expect(state.promptAsyncCalls.filter((c) => c.sessionID === record.sessionID)).toHaveLength(0)
		expect(record.progress.steerCount).toBe(1)
		expect(record.timeoutAt?.getTime()).toBeGreaterThan(originalDeadline as number)
	})

	test("falls back to v1 promptAsync when native steering is unavailable", async () => {
		const { manager, state } = await setup({ nativeSteer: async () => false })
		const record = await manager.delegate(delegateInput({ maxRunTimeMs: 60_000 }))

		const reply = await manager.steerDelegation("ses_parent", record.id, "focus on X")
		expect(reply).toContain("✅")

		const steer = state.promptAsyncCalls.find((c) => c.sessionID === record.sessionID)
		expect(steer?.body.parts[0]?.text).toBe("[SUPERVISOR STEER] focus on X")
		expect(record.progress.steerCount).toBe(1)
	})

	test("steer on an unlimited delegation never creates a deadline", async () => {
		const { manager } = await setup()
		const record = await manager.delegate(delegateInput({ maxRunTimeMs: 0 }))
		expect(record.timeoutAt).toBeUndefined()

		await manager.steerDelegation("ses_parent", record.id, "keep going")
		expect(record.timeoutAt).toBeUndefined()
	})

	test("undeliverable steer (no native, busy session) reports failure and the run still completes", async () => {
		const { manager, state } = await setup({ nativeSteer: async () => false })
		const record = await manager.delegate(delegateInput())

		state.failPromptAsyncFor.add(record.sessionID)
		const reply = await manager.steerDelegation("ses_parent", record.id, "change approach")
		expect(reply).toContain("❌")
		expect(reply).toContain("Retry")
		expect(record.progress.steerCount ?? 0).toBe(0)

		// The failed steer does not wedge the lifecycle: the session settles and completes.
		state.failPromptAsyncFor.delete(record.sessionID)
		state.promptResolvers.get(record.sessionID)?.resolve({})
		await waitFor(() => record.status === "complete")
	})

	test("failed steer restores a pending completion instead of stranding the delegation", async () => {
		const { manager, state } = await setup({ nativeSteer: async () => false })
		const record = await manager.delegate(delegateInput())

		// The session settles: a debounced completion is now pending.
		state.failPromptAsyncFor.add(record.sessionID)
		await manager.handleSessionIdle(record.sessionID)

		// A steer that fails to deliver cancelled that pending completion — it must come back.
		const reply = await manager.steerDelegation("ses_parent", record.id, "too slow")
		expect(reply).toContain("❌")
		await waitFor(() => record.status === "complete", 1_000)
	})

	test("steering a finished delegation is rejected", async () => {
		const { manager, state } = await setup()
		const record = await manager.delegate(delegateInput())
		state.promptResolvers.get(record.sessionID)?.resolve({})
		await waitFor(() => record.status === "complete")

		const reply = await manager.steerDelegation("ses_parent", record.id, "too late")
		expect(reply).toContain("❌")
		expect(reply).toContain("complete")
	})
})

describe("stop", () => {
	test("stop aborts the session, finalizes as cancelled, and marks partial output", async () => {
		const { manager, state } = await setup()
		const record = await manager.delegate(delegateInput())

		const reply = await manager.stopDelegation("ses_parent", record.id)
		expect(reply).toContain("🛑")
		expect(state.abortedSessions).toContain(record.sessionID)
		expect(record.status).toBe("cancelled")

		const output = await manager.readOutput("ses_parent", record.id)
		expect(output).toContain("[STOPPED BY SUPERVISOR]")
	})

	test("stop force-deletes a session that survives abort", async () => {
		const { manager, state } = await setup()
		const record = await manager.delegate(delegateInput())

		// Server keeps reporting the session busy after abort → hard delete kicks in.
		state.statusMap[record.sessionID] = { type: "busy" }
		await manager.stopDelegation("ses_parent", record.id)
		expect(state.deletedSessions).toContain(record.sessionID)
		expect(record.status).toBe("cancelled")
	})
})

describe("timeouts", () => {
	test("delegation with a deadline is force-timed-out by a blocking read past the deadline", async () => {
		const { manager, state } = await setup()
		const record = await manager.delegate(delegateInput({ maxRunTimeMs: 80 }))
		expect(record.timeoutAt).toBeDefined()

		const output = await manager.readOutput("ses_parent", record.id)
		expect(record.status).toBe("timeout")
		expect(output).toContain("[TIMEOUT REACHED]")
		// handleTimeout tears the session down.
		expect(state.deletedSessions).toContain(record.sessionID)
	})

	test("unlimited delegation (0) has no deadline and read defers to the notification", async () => {
		const { manager } = await setup()
		const record = await manager.delegate(delegateInput({ maxRunTimeMs: 0 }))
		expect(record.timeoutAt).toBeUndefined()

		const report = await manager.getStatusReport("ses_parent")
		expect(report).toContain("no timeout")

		// readWaitUnlimitedMs=150 → bounded wait, then the delegation is STILL RUNNING.
		const output = await manager.readOutput("ses_parent", record.id)
		expect(record.status).toBe("running")
		expect(output).toContain("still running")
	})
})

describe("child session cleanup", () => {
	test("reading a finished delegation deletes its child session exactly once", async () => {
		const { manager, state } = await setup()
		const record = await manager.delegate(delegateInput())

		state.promptResolvers.get(record.sessionID)?.resolve({})
		await waitFor(() => record.status === "complete")

		// Finishing alone must NOT delete the child session: it stays navigable until read.
		expect(state.deletedSessions).not.toContain(record.sessionID)

		const output = await manager.readOutput("ses_parent", record.id)
		expect(output).toContain("FINAL RESULT")
		await waitFor(() => state.deletedSessions.includes(record.sessionID))

		// Re-reading is served from the persisted artifact and never double-deletes.
		const again = await manager.readOutput("ses_parent", record.id)
		expect(again).toContain("FINAL RESULT")
		expect(state.deletedSessions.filter((id) => id === record.sessionID).length).toBe(1)
	})

	test("a running delegation's session is never cleaned up by a (deferred) read", async () => {
		const { manager, state } = await setup()
		const record = await manager.delegate(delegateInput({ maxRunTimeMs: 0 }))

		// Unlimited delegation: read returns "still running" without forcing terminal state.
		const output = await manager.readOutput("ses_parent", record.id)
		expect(output).toContain("still running")
		expect(record.status).toBe("running")
		expect(state.deletedSessions).not.toContain(record.sessionID)
	})
})

describe("peek", () => {
	test("peek digests tool activity, assistant text, and steers without side effects", async () => {
		const { manager, state } = await setup()
		const record = await manager.delegate(delegateInput())

		state.messagesBySession.set(record.sessionID, [
			{
				info: { role: "user" },
				parts: [
					{ type: "text", text: "Research the topic" },
					{ type: "text", text: "[SUPERVISOR STEER] focus on X" },
				],
			},
			{
				info: { role: "assistant" },
				parts: [
					{ type: "text", text: "Working on it." },
					{
						type: "tool",
						tool: "webfetch",
						callID: "call_1",
						state: { status: "running", title: "Fetching docs" },
					},
				],
			},
		])

		const peek = await manager.peekDelegation("ses_parent", record.id)
		expect(peek).toContain(`## Peek: ${record.id}`)
		expect(peek).toContain("[tool] webfetch (running): Fetching docs")
		expect(peek).toContain("Working on it.")
		expect(peek).toContain(">> [SUPERVISOR STEER] focus on X")
		// The original prompt is NOT echoed back.
		expect(peek).not.toContain("Research the topic")
		// Read-only: no retrieval, no lifecycle change.
		expect(record.retrieval.retrievalCount).toBe(0)
		expect(record.status).toBe("running")
	})

	test("peek on a terminal delegation redirects to delegation_read", async () => {
		const { manager, state } = await setup()
		const record = await manager.delegate(delegateInput())
		state.promptResolvers.get(record.sessionID)?.resolve({})
		await waitFor(() => record.status === "complete")

		const peek = await manager.peekDelegation("ses_parent", record.id)
		expect(peek).toContain("ℹ️")
		expect(peek).toContain("delegation_read")
	})
})

describe("progress events", () => {
	test("tool-call counter dedupes repeated part updates for the same callID", async () => {
		const { manager } = await setup()
		const record = await manager.delegate(delegateInput())

		const toolPart = (callID: string, status: string) =>
			({
				type: "tool",
				callID,
				tool: "grep",
				sessionID: record.sessionID,
				state: { status },
			}) as never

		manager.handlePartEvent(toolPart("call_1", "pending"))
		manager.handlePartEvent(toolPart("call_1", "running"))
		manager.handlePartEvent(toolPart("call_1", "completed"))
		manager.handlePartEvent(toolPart("call_2", "pending"))
		expect(record.progress.toolCalls).toBe(2)

		manager.handlePartEvent({
			type: "text",
			text: "streamed update",
			sessionID: record.sessionID,
		} as never)
		expect(record.progress.lastMessage).toBe("streamed update")
	})
})

describe("crash recovery", () => {
	test("restore re-adopts an orphaned state file and finalizes the settled delegation", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-agents-restore-"))
		const { client, state } = createFakeClient()
		cleanups.push(async () => {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		})

		const rootDir = path.join(dir, "ses_root")
		await fs.mkdir(rootDir, { recursive: true })
		const now = new Date()
		const record: DelegationRecord = {
			id: "orphaned-task",
			rootSessionID: "ses_root",
			sessionID: "ses_orphan_child",
			parentSessionID: "ses_root",
			parentMessageID: "msg_1",
			parentAgent: "build",
			prompt: "long job",
			agent: "researcher",
			notificationCycle: 1,
			notificationCycleToken: "ses_root:1",
			status: "running",
			createdAt: now,
			startedAt: now,
			updatedAt: now,
			maxRunTimeMs: 0,
			progress: { toolCalls: 2, lastUpdateAt: now, lastHeartbeatAt: now },
			notification: { terminalNotificationCount: 0 },
			retrieval: { retrievalCount: 0 },
			artifact: { filePath: path.join(rootDir, "orphaned-task.md") },
		}
		const stateFile = path.join(rootDir, "orphaned-task.state.json")
		await fs.writeFile(stateFile, serializeDelegation(record), "utf8")

		// New process: session is absent from /session/status → settled while we were down.
		const manager = new DelegationManager(client, dir, noopLogger, {
			completeDebounceMs: 10,
			allCompleteQuietPeriodMs: 5,
			metadataGenerator: async () => ({ title: "Restored", description: "Recovered run" }),
		})
		cleanups.push(() => manager.dispose())

		await manager.restoreActiveDelegations()

		// The artifact is persisted BEFORE the parent notification, so waiting on the
		// notification guarantees the file exists too.
		await waitFor(() =>
			state.promptAsyncCalls.some(
				(c) => c.sessionID === "ses_root" && c.body.parts[0]?.text?.includes("orphaned-task"),
			),
		)
		const artifact = await fs.readFile(record.artifact.filePath, "utf8")
		expect(artifact).toContain("FINAL RESULT")

		// The state file is consumed: nothing left for the next restart.
		await sleep(50) // removeStateFile is fire-and-forget
		await expect(fs.access(stateFile)).rejects.toThrow()

		const list = await manager.listDelegations("ses_root")
		const restored = list.find((d) => d.id === "orphaned-task")
		expect(restored?.status).toBe("complete")
	})

	test("restore leaves a still-busy delegation running", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-agents-restore2-"))
		const { client, state } = createFakeClient()
		cleanups.push(async () => {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		})

		const rootDir = path.join(dir, "ses_root")
		await fs.mkdir(rootDir, { recursive: true })
		const now = new Date()
		const record: DelegationRecord = {
			id: "busy-task",
			rootSessionID: "ses_root",
			sessionID: "ses_busy_child",
			parentSessionID: "ses_root",
			parentMessageID: "msg_1",
			parentAgent: "build",
			prompt: "long job",
			agent: "researcher",
			notificationCycle: 1,
			notificationCycleToken: "ses_root:1",
			status: "running",
			createdAt: now,
			startedAt: now,
			updatedAt: now,
			maxRunTimeMs: 0,
			progress: { toolCalls: 0, lastUpdateAt: now, lastHeartbeatAt: now },
			notification: { terminalNotificationCount: 0 },
			retrieval: { retrievalCount: 0 },
			artifact: { filePath: path.join(rootDir, "busy-task.md") },
		}
		await fs.writeFile(
			path.join(rootDir, "busy-task.state.json"),
			serializeDelegation(record),
			"utf8",
		)
		state.statusMap.ses_busy_child = { type: "busy" }

		const manager = new DelegationManager(client, dir, noopLogger, {
			completeDebounceMs: 10,
			allCompleteQuietPeriodMs: 5,
			metadataGenerator: async () => ({ title: "T", description: "D" }),
		})
		cleanups.push(() => manager.dispose())

		await manager.restoreActiveDelegations()
		await sleep(60)

		const running = manager.getRunningDelegations("ses_root")
		expect(running.map((d) => d.id)).toContain("busy-task")
		expect(state.promptAsyncCalls.length).toBe(0)
	})
})
