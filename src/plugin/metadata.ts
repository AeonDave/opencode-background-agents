import type { TextPart } from "@opencode-ai/sdk"
import type { OpencodeClient } from "./primitives/types"

interface GeneratedMetadata {
	title: string
	description: string
}

/**
 * Generate title and description from result content using small_model
 * Falls back to truncation if small_model unavailable
 */
async function generateMetadata(
	client: OpencodeClient,
	resultContent: string,
	parentID: string,
	debugLog: (msg: string) => Promise<void>,
): Promise<GeneratedMetadata> {
	const fallbackMetadata = (): GeneratedMetadata => {
		// Fallback: derive title/description from the content, skipping code fences and
		// markdown noise so notifications never contain broken ``` blocks or raw shell dumps.
		const clean = (s: string) =>
			s
				.replace(/```[a-z]*\n?/g, " ")
				.replace(/[`#*_>|]/g, "")
				.replace(/\s+/g, " ")
				.trim()
		const meaningfulLine =
			resultContent
				.split("\n")
				.map((l) => clean(l))
				.find((l) => l.length > 3) || "Delegation result"
		const title = meaningfulLine.slice(0, 30) + (meaningfulLine.length > 30 ? "..." : "")
		const cleanedContent = clean(resultContent.slice(0, 600))
		const description = cleanedContent.slice(0, 150) + (cleanedContent.length > 150 ? "..." : "")
		return { title, description: description || "(no description)" }
	}

	try {
		// Get config to check for small_model
		const config = await client.config.get()
		const configData = config.data as { small_model?: string } | undefined

		if (!configData?.small_model) {
			await debugLog("generateMetadata: No small_model configured, using fallback")
			return fallbackMetadata()
		}

		await debugLog(`generateMetadata: Using small_model ${configData.small_model}`)

		// small_model is "provider/model"; the model can itself contain slashes.
		const [providerID, ...modelSegments] = configData.small_model.split("/")
		const modelID = modelSegments.join("/")

		// Create a session for metadata generation
		const session = await client.session.create({
			body: {
				title: "Metadata Generation",
				parentID,
			},
		})

		if (!session.data?.id) {
			await debugLog("generateMetadata: Failed to create session")
			return fallbackMetadata()
		}

		try {
			// Prompt the small model for metadata
			const prompt = `Generate a title and description for this research result.

RULES:
- Title: 2-5 words, max 30 characters, sentence case
- Description: 2-3 sentences, max 150 characters, summarize key findings

RESULT CONTENT:
${resultContent.slice(0, 2000)}

Respond with ONLY valid JSON in this exact format:
{"title": "Your Title Here", "description": "Your description here."}`

			// Await prompt response directly with timeout safety net
			const PROMPT_TIMEOUT_MS = 30000
			const result = await Promise.race([
				client.session.prompt({
					path: { id: session.data.id },
					body: {
						...(providerID && modelID ? { model: { providerID, modelID } } : {}),
						parts: [{ type: "text", text: prompt }],
					},
				}),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Prompt timeout after 30s")), PROMPT_TIMEOUT_MS),
				),
			])

			// Extract text from the response
			const responseParts = result.data?.parts as TextPart[] | undefined
			const textPart = responseParts?.find((p): p is TextPart => p.type === "text")
			if (!textPart) {
				await debugLog("generateMetadata: No text part in response")
				return fallbackMetadata()
			}

			// Parse JSON response
			const jsonMatch = textPart.text.match(/\{[\s\S]*\}/)
			if (!jsonMatch) {
				await debugLog(`generateMetadata: No JSON found in response: ${textPart.text}`)
				return fallbackMetadata()
			}

			const parsed = JSON.parse(jsonMatch[0]) as { title?: string; description?: string }
			if (!parsed.title || !parsed.description) {
				await debugLog("generateMetadata: Invalid JSON structure")
				return fallbackMetadata()
			}

			await debugLog(`generateMetadata: Generated title="${parsed.title}"`)
			return {
				title: parsed.title.slice(0, 30),
				description: parsed.description.slice(0, 150),
			}
		} finally {
			// The metadata session is throwaway: delete it so every delegation does not
			// leave an extra child session behind.
			void client.session.delete({ path: { id: session.data.id } }).catch(() => {})
		}
	} catch (error) {
		await debugLog(
			`generateMetadata error: ${error instanceof Error ? error.message : "Unknown error"}`,
		)
		return fallbackMetadata()
	}
}

export type { GeneratedMetadata }
export { generateMetadata }
