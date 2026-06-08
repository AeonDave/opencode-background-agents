import type { OpencodeClient } from "./primitives/types"

/**
 * Create a structured logger that sends messages to OpenCode's log API.
 * Catches errors silently to avoid disrupting tool execution.
 */
function createLogger(client: OpencodeClient) {
	const log = (level: "debug" | "info" | "warn" | "error", message: string) =>
		client.app.log({ body: { service: "background-agents", level, message } }).catch(() => {})
	return {
		debug: (msg: string) => log("debug", msg),
		info: (msg: string) => log("info", msg),
		warn: (msg: string) => log("warn", msg),
		error: (msg: string) => log("error", msg),
	}
}

type Logger = ReturnType<typeof createLogger>

export { createLogger }
export type { Logger }
