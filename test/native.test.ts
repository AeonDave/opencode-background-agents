import { afterEach, describe, expect, test } from "bun:test"
import type { Logger } from "../src/plugin/logger"
import { createNativeSteer } from "../src/plugin/native"

const noopLogger: Logger = {
	debug: () => Promise.resolve(),
	info: () => Promise.resolve(),
	warn: () => Promise.resolve(),
	error: () => Promise.resolve(),
}

const realFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = realFetch
})

interface FetchCall {
	url: string
	body: unknown
}

function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
	const calls: FetchCall[] = []
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const call: FetchCall = {
			url: String(input),
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		}
		calls.push(call)
		return handler(call)
	}) as typeof fetch
	return calls
}

const json = (body: string, status = 200) =>
	new Response(body, { status, headers: { "content-type": "application/json" } })
const html = (status = 200) =>
	new Response("<!doctype html><html></html>", {
		status,
		headers: { "content-type": "text/html" },
	})

describe("createNativeSteer", () => {
	test("POSTs the v2 steer prompt and reports delivery", async () => {
		const calls = stubFetch(() => json("{}"))
		const steer = createNativeSteer(new URL("http://127.0.0.1:4096"), noopLogger)

		const delivered = await steer("ses_child", "[SUPERVISOR STEER] focus")
		expect(delivered).toBe(true)
		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).toBe("http://127.0.0.1:4096/api/session/ses_child/prompt")
		expect(calls[0]?.body).toEqual({
			prompt: { text: "[SUPERVISOR STEER] focus" },
			delivery: "steer",
		})
	})

	test("SPA fallback (200 + HTML) marks the capability unsupported and stops further attempts", async () => {
		// Servers without the v2 route answer API paths with the web UI page, NOT a 404.
		const calls = stubFetch(() => html(200))
		const steer = createNativeSteer(new URL("http://127.0.0.1:4096"), noopLogger)

		expect(await steer("ses_a", "x")).toBe(false)
		expect(await steer("ses_b", "y")).toBe(false)
		// Memoized: only the first call hit the network.
		expect(calls).toHaveLength(1)
	})

	test("plain 404 (no JSON) marks the capability unsupported", async () => {
		const calls = stubFetch(() => html(404))
		const steer = createNativeSteer(new URL("http://127.0.0.1:4096"), noopLogger)

		expect(await steer("ses_a", "x")).toBe(false)
		expect(await steer("ses_b", "y")).toBe(false)
		expect(calls).toHaveLength(1)
	})

	test("structured API errors fail the delivery but keep the capability", async () => {
		// SessionNotFoundError proves the route exists: the next steer must still go native.
		let response = json('{"_tag":"SessionNotFoundError"}', 404)
		const calls = stubFetch(() => response)
		const steer = createNativeSteer(new URL("http://127.0.0.1:4096"), noopLogger)

		expect(await steer("ses_a", "x")).toBe(false)
		response = json("{}")
		expect(await steer("ses_a", "x")).toBe(true)
		expect(calls).toHaveLength(2)
	})

	test("network failure returns false instead of throwing, without marking unsupported", async () => {
		globalThis.fetch = (async () => {
			throw new Error("ECONNREFUSED")
		}) as unknown as typeof fetch
		const steer = createNativeSteer(new URL("http://127.0.0.1:4096"), noopLogger)
		expect(await steer("ses_a", "x")).toBe(false)

		// Server back up: capability was never poisoned by the network blip.
		const calls = stubFetch(() => json("{}"))
		expect(await steer("ses_a", "x")).toBe(true)
		expect(calls).toHaveLength(1)
	})
})
