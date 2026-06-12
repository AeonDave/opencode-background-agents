import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { deserializeDelegation, serializeDelegation } from "../src/plugin/state"
import type { DelegationRecord, DelegationStatus } from "../src/plugin/types"

function makeRecord(overrides: Partial<DelegationRecord> = {}): DelegationRecord {
	const now = new Date("2026-06-12T10:00:00.000Z")
	return {
		id: "brave-red-fox",
		rootSessionID: "ses_root",
		sessionID: "ses_child",
		parentSessionID: "ses_parent",
		parentMessageID: "msg_1",
		parentAgent: "build",
		prompt: "Research X",
		agent: "researcher",
		notificationCycle: 1,
		notificationCycleToken: "ses_parent:1",
		status: "running",
		createdAt: now,
		startedAt: now,
		updatedAt: now,
		timeoutAt: new Date(now.getTime() + 900_000),
		maxRunTimeMs: 900_000,
		model: "anthropic/claude-haiku-4-5",
		progress: {
			toolCalls: 3,
			lastUpdateAt: now,
			lastHeartbeatAt: now,
			lastMessage: "working…",
			lastMessageAt: now,
			steerCount: 1,
			lastSteerAt: now,
		},
		notification: { terminalNotificationCount: 0 },
		retrieval: { retrievalCount: 0 },
		artifact: { filePath: "D:/tmp/brave-red-fox.md" },
		...overrides,
	}
}

describe("state round-trip", () => {
	test("preserves identity, status, dates, and timeout window", () => {
		const record = makeRecord()
		const revived = deserializeDelegation(serializeDelegation(record))
		expect(revived).toBeDefined()
		expect(revived?.id).toBe(record.id)
		expect(revived?.sessionID).toBe(record.sessionID)
		expect(revived?.parentSessionID).toBe(record.parentSessionID)
		expect(revived?.status).toBe(record.status)
		expect(revived?.maxRunTimeMs).toBe(record.maxRunTimeMs)
		expect(revived?.model).toBe("anthropic/claude-haiku-4-5")
		expect(revived?.timeoutAt?.getTime()).toBe(record.timeoutAt?.getTime())
		expect(revived?.createdAt.getTime()).toBe(record.createdAt.getTime())
		expect(revived?.progress.toolCalls).toBe(3)
		expect(revived?.progress.steerCount).toBe(1)
		expect(revived?.artifact.filePath).toBe(record.artifact.filePath)
	})

	test("unlimited delegation (maxRunTimeMs=0) revives without a deadline", () => {
		const record = makeRecord({ maxRunTimeMs: 0, timeoutAt: undefined })
		const revived = deserializeDelegation(serializeDelegation(record))
		expect(revived?.maxRunTimeMs).toBe(0)
		expect(revived?.timeoutAt).toBeUndefined()
	})

	test("rejects unknown version", () => {
		const payload = JSON.stringify({ version: 999, record: makeRecord() })
		expect(deserializeDelegation(payload)).toBeUndefined()
	})

	test("rejects records missing essential fields", () => {
		const record = makeRecord() as unknown as Record<string, unknown>
		delete record.sessionID
		const payload = JSON.stringify({ version: 1, record })
		expect(deserializeDelegation(payload)).toBeUndefined()
	})

	test("rejects corrupt JSON without throwing", () => {
		expect(deserializeDelegation("{not json")).toBeUndefined()
		expect(deserializeDelegation("")).toBeUndefined()
		expect(deserializeDelegation("null")).toBeUndefined()
	})
})

describe("state fuzzing", () => {
	test("deserialize never throws on arbitrary strings", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 500 }), (input) => {
				const result = deserializeDelegation(input)
				expect(result === undefined || typeof result.id === "string").toBe(true)
			}),
			{ numRuns: 500 },
		)
	})

	test("deserialize never throws on arbitrary JSON payloads", () => {
		fc.assert(
			fc.property(fc.jsonValue(), (value) => {
				const result = deserializeDelegation(JSON.stringify(value))
				if (result !== undefined) {
					// Anything accepted must be structurally usable downstream.
					expect(typeof result.id).toBe("string")
					expect(typeof result.sessionID).toBe("string")
					expect(result.createdAt instanceof Date).toBe(true)
					expect(Number.isNaN(result.createdAt.getTime())).toBe(false)
				}
			}),
			{ numRuns: 500 },
		)
	})

	test("round-trip holds for arbitrary valid records", () => {
		const dateArb = fc
			.integer({ min: 1_600_000_000_000, max: 2_000_000_000_000 })
			.map((ms) => new Date(ms))
		const statusArb = fc.constantFrom<DelegationStatus>("registered", "running")
		const recordArb = fc
			.record({
				id: fc.stringMatching(/^[a-z][a-z0-9-]{2,30}$/),
				status: statusArb,
				maxRunTimeMs: fc.oneof(fc.constant(0), fc.integer({ min: 60_000, max: 86_400_000 })),
				createdAt: dateArb,
				steerCount: fc.option(fc.integer({ min: 0, max: 50 }), { nil: undefined }),
				toolCalls: fc.integer({ min: 0, max: 1000 }),
			})
			.map(({ id, status, maxRunTimeMs, createdAt, steerCount, toolCalls }) =>
				makeRecord({
					id,
					status,
					maxRunTimeMs,
					createdAt,
					timeoutAt:
						maxRunTimeMs > 0 ? new Date(createdAt.getTime() + maxRunTimeMs) : undefined,
					progress: {
						toolCalls,
						lastUpdateAt: createdAt,
						lastHeartbeatAt: createdAt,
						steerCount,
					},
				}),
			)

		fc.assert(
			fc.property(recordArb, (record) => {
				const revived = deserializeDelegation(serializeDelegation(record))
				expect(revived).toBeDefined()
				expect(revived?.id).toBe(record.id)
				expect(revived?.status).toBe(record.status)
				expect(revived?.maxRunTimeMs).toBe(record.maxRunTimeMs)
				expect(revived?.timeoutAt?.getTime()).toBe(record.timeoutAt?.getTime())
				expect(revived?.progress.toolCalls).toBe(record.progress.toolCalls)
			}),
			{ numRuns: 300 },
		)
	})
})
