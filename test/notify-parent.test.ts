import { describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { DelegationManager } from "../src/plugin/delegation-manager"
import type { Logger } from "../src/plugin/logger"
import type { OpencodeClient } from "../src/plugin/primitives/types"
import { createNotifyParent } from "../src/plugin/tools"

const noopLogger: Logger = {
	debug: () => Promise.resolve(),
	info: () => Promise.resolve(),
	warn: () => Promise.resolve(),
	error: () => Promise.resolve(),
}

describe("notify_parent tool", () => {
	test("createNotifyParent executes correctly via tool wrapper", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-notify-tool-test-"))
		const promptAsyncCalls: Array<{ sessionID: string; body: unknown }> = []
		let sessionCounter = 0

		const client = {
			app: {
				agents: async () => ({
					data: [{ name: "researcher", mode: "subagent" }],
				}),
				log: async () => ({}),
			},
			config: {
				get: async () => ({
					data: {
						agent: {
							researcher: { permission: { edit: "deny", write: "deny", bash: "deny" } },
						},
					},
				}),
			},
			tui: {
				showToast: async () => ({}),
			},
			session: {
				get: async (input: { path: { id: string } }) => ({
					data: { id: input.path.id, parentID: undefined },
				}),
				create: async () => {
					sessionCounter += 1
					return { data: { id: `ses_child_${sessionCounter}` } }
				},
				status: async () => ({ data: {} }),
				prompt: () => new Promise(() => {}),
				promptAsync: async (input: { path: { id: string }; body: unknown }) => {
					promptAsyncCalls.push({ sessionID: input.path.id, body: input.body })
					return {}
				},
			},
		}

		const manager = new DelegationManager(client as unknown as OpencodeClient, dir, noopLogger, {
			idGenerator: () => "task-child-1",
		})

		const notifyParentTool = createNotifyParent(manager)

		// 1. Tool execution without sessionID fails cleanly
		const noSessionRes = await notifyParentTool.execute(
			{ message: "Blocker text" },
			// @ts-expect-error test missing sessionID
			{ messageID: "msg_1", agent: "researcher" },
		)
		expect(noSessionRes).toContain("❌")
		expect(noSessionRes).toContain("sessionID")

		// 2. Delegate a task to create a child session
		const delegation = await manager.delegate({
			parentSessionID: "ses_parent_1",
			parentMessageID: "msg_p_1",
			parentAgent: "planner",
			prompt: "Work on subtask",
			agent: "researcher",
		})

		// 3. Child calls notify_parent via tool execution
		const result = (await notifyParentTool.execute(
			{ message: "Need clarification on architectural choice" },
			{
				sessionID: delegation.sessionID,
				messageID: "msg_c_1",
				agent: "researcher",
				abort: new AbortController().signal,
			} as never,
		)) as { title: string; output: string }

		expect(result.title).toBe("notify_parent")
		expect(result.output).toContain("✅")
		expect(result.output).toContain("sent to parent")

		// 4. Verify parent promptAsync call payload
		expect(promptAsyncCalls.length).toBe(1)
		const call = promptAsyncCalls[0]
		expect(call.sessionID).toBe("ses_parent_1")
		const body = call.body as {
			noReply?: boolean
			agent?: string
			parts: Array<{ type: string; text?: string; synthetic?: boolean }>
		}
		expect(body.noReply).toBe(false)
		expect(body.agent).toBe("planner")
		expect(body.parts[0]?.synthetic).toBe(true)
		expect(body.parts[0]?.text).toContain('<child-notification delegation="task-child-1" agent="researcher">')
		expect(body.parts[0]?.text).toContain("Need clarification on architectural choice")
		expect(body.parts[0]?.text).toContain('delegation_steer("task-child-1", "...")')

		manager.dispose()
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
	})
})
