import { STRICT_READONLY } from "./types"

/**
 * Shared sections, identical regardless of routing mode.
 */
const COMMON_HEADER = `<task-notification>
<delegation-system>

## Async Delegation

You have tools for parallel background work:
- \`delegate(prompt, agent, timeout_minutes?, model?)\` - Launch task, returns ID immediately. Size \`timeout_minutes\` to the task (default 15, **0 = no timeout** — you stay in control via steer/stop); a delivered steer re-opens a fresh window. Optionally pick the \`model\` ("provider/model-id") per task: cheap/fast for simple lookups, strong for deep work; omitted = the agent's default.
- \`delegation_read(id)\` - Retrieve completed result
- \`delegation_list()\` - List delegations (use sparingly)

## Interactive Control (while a delegation runs)

You are NOT blocked while a delegation runs — you can observe and adjust it:
- \`delegation_status()\` - Cheap live status (elapsed, tool calls, heartbeat, steers). Does NOT poll for completion.
- \`delegation_peek(id)\` - Live transcript digest of a RUNNING task (what it has done so far). Use it to gather evidence for a steer/stop decision mid-run — not as a completion poll.
- \`delegation_steer(id, message)\` - Inject an extra instruction into a RUNNING task (add a constraint, redirect, supply context). Delivered into the agent's CURRENT run via native server-side steering, even mid-step. If delivery fails the tool tells you — retry shortly or stop the task.
- \`delegation_stop(id)\` - Abort a running task; partial output is saved and readable via \`delegation_read(id)\`.

Use status to notice, peek to inspect, steer to course-correct without restarting, stop to cancel off-track work. Still rely on \`<task-notification>\` for completion — do not poll.`

/**
 * Relaxed mode (default): every sub-agent — read-only OR write/bash-capable — runs as an
 * async background delegation via \`delegate\`. The native blocking \`task\` tool must NOT be
 * used for sub-agents, because it freezes this (supervisor) session until the sub-agent
 * finishes, which defeats the whole point of background delegation.
 */
const RELAXED_ROUTING = `## Delegation Routing

**Always use \`delegate\` to dispatch a sub-agent.** This applies to EVERY sub-agent,
including write- and bash-capable ones (coders, operators, builders). \`delegate\` returns
an ID immediately and runs the agent in the background, so you stay free to keep working,
observe, steer, or stop it.

**Do NOT use the native \`task\` tool for sub-agents.** \`task\` runs synchronously and BLOCKS
this session until the sub-agent finishes — no async, no steering, no parallelism. It is
intercepted and rejected for sub-agents in this mode; use \`delegate\` instead.

> Caveat: a write-capable agent's file/bash side effects run outside OpenCode's
> undo/branching tree and cannot be reverted via the UI. That is the accepted trade-off
> for background execution in this mode.

## How It Works

1. Call \`delegate(prompt, agent)\` with a detailed prompt — for ANY sub-agent
2. Continue productive work while it runs (steer/stop/status as needed)
3. Receive a \`<task-notification>\` when it completes
4. Call \`delegation_read(id)\` to retrieve results`

/**
 * Strict mode (BACKGROUND_AGENTS_STRICT_READONLY=1): only read-only sub-agents may run as
 * background delegations; write-capable sub-agents are forced onto the native \`task\` tool to
 * preserve OpenCode's undo/branching for their side effects.
 */
const STRICT_ROUTING = `## Delegation Routing

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
5. Call \`delegation_read(id)\` to retrieve results`

const COMMON_FOOTER = `## Critical Constraints

**NEVER poll \`delegation_list\` to check completion.**
You WILL be notified via \`<task-notification>\`. Polling wastes tokens.

**NEVER wait idle.** Always have productive work while delegations run.

**Using the wrong tool will fail fast with guidance.**

</delegation-system>
</task-notification>`

/**
 * Build the delegation rules injected into the system prompt. The routing section reflects
 * the live \`STRICT_READONLY\` configuration so the model is told the SAME policy the
 * \`tool.execute.before\` guard actually enforces — preventing the model from picking the
 * blocking native \`task\` tool when background delegation is what's configured.
 */
function buildDelegationRules(strictReadonly: boolean = STRICT_READONLY): string {
	const routing = strictReadonly ? STRICT_ROUTING : RELAXED_ROUTING
	return `${COMMON_HEADER}\n\n${routing}\n\n${COMMON_FOOTER}`
}

/** Pre-built rules for the current process configuration. */
const DELEGATION_RULES = buildDelegationRules()

export { DELEGATION_RULES, buildDelegationRules }
