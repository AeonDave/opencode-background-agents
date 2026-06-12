/**
 * Native server capabilities (opencode >= 1.17).
 *
 * The v2 API (`/api/session/{id}/prompt`) supports `delivery: "steer"` — server-side
 * mid-turn steering of a busy session. This replaces the plugin's former client-side
 * steer queue (enqueue on busy-rejection, flush at the next turn boundary): the server
 * now owns that machinery natively and can inject the instruction into the CURRENT run
 * instead of waiting for the next one.
 *
 * Called via plain fetch on the host's serverUrl rather than the SDK v2 client so the
 * plugin stays decoupled from the SDK version the host bundles. Capability is detected
 * once (404 = endpoint absent on this server) and memoized.
 */

import type { Logger } from "./logger"
import type { NativeSteerFn } from "./types"

function createNativeSteer(serverUrl: URL, log: Logger): NativeSteerFn {
	// undefined = unknown yet; false = server lacks the endpoint (stop trying).
	let supported: boolean | undefined

	return async (sessionID: string, text: string): Promise<boolean> => {
		if (supported === false) return false

		let response: Response
		try {
			response = await fetch(new URL(`/api/session/${sessionID}/prompt`, serverUrl), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ prompt: { text }, delivery: "steer" }),
			})
		} catch (error) {
			// Transient network failure: report undelivered, do NOT mark unsupported.
			log.warn(
				`native steer: request failed for ${sessionID}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
			return false
		}

		// Drain the body so the connection is released either way.
		void response.text().catch(() => {})

		// The API speaks JSON in both success and error cases. A non-JSON response is the
		// server's SPA/static fallback answering for a route it does not have — including
		// a 200+HTML page — so JSON is the capability signal, not the status code.
		const isJson = (response.headers.get("content-type") ?? "").includes("application/json")
		if (!isJson) {
			supported = false
			log.warn("native steer: server has no /api/session/{id}/prompt route; using v1 fallback")
			return false
		}
		if (!response.ok) {
			// Structured API error (e.g. SessionNotFoundError): the route exists, this
			// delivery failed. Keep the capability for future steers.
			supported = true
			log.warn(`native steer: HTTP ${response.status} for ${sessionID}`)
			return false
		}
		supported = true
		return true
	}
}

export { createNativeSteer }
