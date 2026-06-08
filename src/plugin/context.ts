import type { DelegationStatus } from "./types"

interface DelegationForContext {
	id: string
	agent?: string
	title?: string
	description?: string
	status: DelegationStatus
	startedAt?: Date
	completedAt?: Date
	lastHeartbeatAt?: Date
	prompt?: string
}

/**
 * Format delegation context for injection during compaction.
 * Includes running delegations with notification reminder (only when running exist),
 * and recent completed delegations with full descriptions.
 */
function formatDelegationContext(
	running: DelegationForContext[],
	unreadCompleted: DelegationForContext[],
): string {
	const sections: string[] = ["<delegation-context>"]

	// Running delegations (if any)
	if (running.length > 0) {
		sections.push("## Running Delegations")
		sections.push("")
		for (const d of running) {
			sections.push(`### \`${d.id}\`${d.agent ? ` (${d.agent})` : ""}`)
			if (d.startedAt) {
				sections.push(`**Started:** ${d.startedAt.toISOString()}`)
			}
			if (d.lastHeartbeatAt) {
				sections.push(`**Last heartbeat:** ${d.lastHeartbeatAt.toISOString()}`)
			}
			if (d.prompt) {
				const truncatedPrompt = d.prompt.length > 200 ? `${d.prompt.slice(0, 200)}...` : d.prompt
				sections.push(`**Prompt:** ${truncatedPrompt}`)
			}
			sections.push("")
		}

		// Only include reminder when there ARE running delegations
		sections.push(
			"> **Note:** You WILL be notified via `<task-notification>` when delegations complete.",
		)
		sections.push("> Do NOT poll `delegation_list` - continue productive work.")
		sections.push("")
	}

	// Unread completed delegations (recent)
	if (unreadCompleted.length > 0) {
		sections.push("## Unread Completed Delegations")
		sections.push("")
		for (const d of unreadCompleted) {
			const statusEmoji =
				d.status === "complete"
					? "✅"
					: d.status === "error"
						? "❌"
						: d.status === "timeout"
							? "⏱️"
							: "🚫"
			sections.push(`### ${statusEmoji} \`${d.id}\``)
			sections.push(`**Title:** ${d.title || "(no title)"}`)
			sections.push(`**Status:** ${d.status}`)
			sections.push(`**Description:** ${d.description || "(no description)"}`)
			if (d.completedAt) {
				sections.push(`**Completed:** ${d.completedAt.toISOString()}`)
			}
			sections.push(`**Retrieve:** \`delegation_read("${d.id}")\``)
			sections.push("")
		}
		sections.push("> These are unread terminal delegations carried forward through compaction.")
		sections.push("")
	}

	sections.push("## Retrieval")
	sections.push('Use `delegation_read("id")` to access full delegation output.')
	sections.push("Do not poll delegation_list for completion; rely on task notifications.")
	sections.push("</delegation-context>")

	return sections.join("\n")
}

export type { DelegationForContext }
export { formatDelegationContext }
