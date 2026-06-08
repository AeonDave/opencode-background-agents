const DELEGATION_RULES = `<task-notification>
<delegation-system>

## Async Delegation

You have tools for parallel background work:
- \`delegate(prompt, agent)\` - Launch task, returns ID immediately
- \`delegation_read(id)\` - Retrieve completed result
- \`delegation_list()\` - List delegations (use sparingly)

## Interactive Control (while a delegation runs)

You are NOT blocked while a delegation runs — you can observe and adjust it:
- \`delegation_status()\` - Cheap live status (elapsed, tool calls, heartbeat, steers). Does NOT poll for completion.
- \`delegation_steer(id, message)\` - Inject an extra instruction into a RUNNING task (add a constraint, redirect, supply context). The agent acts on it in its current run; if the session is mid-step the steer is queued and delivered at the next turn boundary (never dropped).
- \`delegation_stop(id)\` - Abort a running task; partial output is saved and readable via \`delegation_read(id)\`.

Use status to decide; steer to course-correct without restarting; stop to cancel off-track work. Still rely on \`<task-notification>\` for completion — do not poll.

## Delegation Routing

Agents route based on their permissions:

| Agent Type | Tool | Why |
|------------|------|-----|
| Read-only sub-agents (edit/write/bash denied) | \`delegate\` | Background session, async |
| Write-capable sub-agents (any write permission) | \`task\` | Native task, preserves undo/branching |

**Read-only sub-agents** have edit="deny", write="deny", bash={"*":"deny"}.
**Write-capable sub-agents** have any write tool enabled.

## How It Works

1. For read-only sub-agents: Call \`delegate\` with detailed prompt
2. For write-capable sub-agents: Call \`task\` with detailed prompt
3. Continue productive work while it runs
4. Receive notification when complete
5. Call \`delegation_read(id)\` to retrieve results

## Critical Constraints

**NEVER poll \`delegation_list\` to check completion.**
You WILL be notified via \`<task-notification>\`. Polling wastes tokens.

**NEVER wait idle.** Always have productive work while delegations run.

**Using wrong tool will fail fast with guidance.**

</delegation-system>
</task-notification>`

export { DELEGATION_RULES }
