import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { parseModelString } from "../src/plugin/types"

describe("parseModelString", () => {
	test("splits provider and model on the first slash", () => {
		expect(parseModelString("anthropic/claude-haiku-4-5")).toEqual({
			providerID: "anthropic",
			modelID: "claude-haiku-4-5",
		})
	})

	test("model IDs may contain slashes (only the first segment is the provider)", () => {
		expect(parseModelString("openrouter/meta-llama/llama-3.3-70b")).toEqual({
			providerID: "openrouter",
			modelID: "meta-llama/llama-3.3-70b",
		})
	})

	test("trims surrounding whitespace", () => {
		expect(parseModelString("  anthropic/claude-haiku-4-5  ")).toEqual({
			providerID: "anthropic",
			modelID: "claude-haiku-4-5",
		})
	})

	test("rejects strings that cannot address a model", () => {
		expect(parseModelString("")).toBeUndefined()
		expect(parseModelString("anthropic")).toBeUndefined()
		expect(parseModelString("anthropic/")).toBeUndefined()
		expect(parseModelString("/claude-haiku-4-5")).toBeUndefined()
		expect(parseModelString("/")).toBeUndefined()
	})

	test("fuzz: never throws, and accepted values always have both parts", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 200 }), (input) => {
				const result = parseModelString(input)
				if (result !== undefined) {
					expect(result.providerID.length).toBeGreaterThan(0)
					expect(result.modelID.length).toBeGreaterThan(0)
					expect(result.providerID).not.toContain("/")
				}
			}),
			{ numRuns: 500 },
		)
	})
})
