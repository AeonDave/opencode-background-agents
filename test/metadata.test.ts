import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { generateMetadata } from "../src/plugin/metadata"
import type { OpencodeClient } from "../src/plugin/primitives/types"

// A client whose config fetch fails forces the deterministic fallback path.
const failingClient = {
	config: {
		get: async () => {
			throw new Error("no config in tests")
		},
	},
} as unknown as OpencodeClient

const noopLog = async () => {}

describe("metadata fallback", () => {
	test("skips code fences and produces a clean single-line title", async () => {
		const content = [
			"```sh",
			"WS=/app/workspaces/session_x; TMP=/tmp/y",
			"```",
			"",
			"Scan finished: 3 open ports found on the target host.",
		].join("\n")
		const meta = await generateMetadata(failingClient, content, "ses_parent", noopLog)
		expect(meta.title).not.toContain("```")
		expect(meta.title).not.toContain("\n")
		expect(meta.description).not.toContain("```")
		expect(meta.description).not.toContain("\n")
	})

	test("empty content yields safe defaults", async () => {
		const meta = await generateMetadata(failingClient, "", "ses_parent", noopLog)
		expect(meta.title.length).toBeGreaterThan(0)
		expect(meta.description.length).toBeGreaterThan(0)
	})

	test("fuzz: never throws, never leaks fences/newlines, respects length caps", async () => {
		await fc.assert(
			fc.asyncProperty(fc.string({ maxLength: 2000 }), async (content) => {
				const meta = await generateMetadata(failingClient, content, "ses_parent", noopLog)
				expect(meta.title.length).toBeLessThanOrEqual(33) // 30 + ellipsis
				expect(meta.description.length).toBeLessThanOrEqual(153) // 150 + ellipsis
				expect(meta.title).not.toContain("\n")
				expect(meta.title).not.toContain("`")
				expect(meta.description).not.toContain("\n")
				expect(meta.description).not.toContain("`")
			}),
			{ numRuns: 300 },
		)
	})
})
