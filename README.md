# opencode-background-agents

Async background delegation for [OpenCode](https://github.com/sst/opencode) — fire off tasks, keep working, steer or stop mid-run, and retrieve persisted results after compaction or restart.

## Contents

- [Why use it](#why-use-it)
- [How it works](#how-it-works)
- [Tools](#tools)
- [Interactive control](#interactive-control)
- [Installation](#installation)
- [Configuration](#configuration)
- [Best practices](#best-practices)
- [Monitoring](#monitoring)
- [Lifecycle and reliability](#lifecycle-and-reliability)
- [Development](#development)
- [FAQ](#faq)
- [Credits](#credits)
- [Disclaimer](#disclaimer)
- [License](#license)

## Why use it

Context windows fill up. When compaction kicks in, past research vanishes and the AI re-does work it already did. This plugin addresses that by:

- **Keeping you unblocked.** Delegate a task and continue the conversation immediately; no waiting for a sub-agent to finish.
- **Surviving compaction.** Results are written to disk as markdown. After compaction, the AI retrieves them by ID rather than re-running the task.
- **Giving mid-run control.** Check status, inject instructions, or abort a delegation while it runs — not just fire-and-forget.
- **Sizing resources per task.** Timeout and model are set at delegation time: a short window and a cheap model for quick lookups; a long window and a strong model for deep research or builds.
- **Allowing write-capable agents.** Write- and bash-capable sub-agents can run in the background too, not only read-only ones (toggleable via env var).

## How it works

```
1. Delegate   →  "Research OAuth2 PKCE best practices"
2. Continue   →  Keep coding, brainstorming, reviewing
3. Supervise  →  status / steer / stop while it runs (optional)
4. Notified   →  <task-notification> arrives on terminal state
5. Retrieve   →  delegation_read(id) returns the full result
```

Each delegation runs in its own isolated OpenCode session and is auto-tagged with a title and summary on completion. Results are persisted to `~/.local/share/opencode/delegations/<project>/` as markdown, so the AI can locate and retrieve past work even after compaction, restarts, or crashes.

## Tools

| Tool | Purpose |
|------|---------|
| `delegate(prompt, agent, timeout_minutes?, model?)` | Launch a background task; returns a readable ID immediately. The supervisor can size the timeout and pick the model per task. |
| `delegation_read(id)` | Retrieve the full persisted result of a delegation. |
| `delegation_list()` | List all delegations with titles, summaries, and read state. |
| `delegation_status()` | Live status of active delegations (elapsed, tool calls, heartbeat, steer count) — instant, never polls. |
| `delegation_peek(id)` | Live transcript digest of a running delegation — read intermediate work to decide whether to steer or stop. |
| `delegation_steer(id, message)` | Inject an extra instruction into a running delegation. |
| `delegation_stop(id)` | Abort a running delegation and keep its partial output. |

## Interactive control

`status`, `peek`, `steer`, and `stop` give mid-run supervisor control without blocking the main conversation.

- **Status** is read from memory and instant. Use it to notice that a delegation needs attention.
- **Peek** reads the live transcript of a running delegation — assistant text, tool activity, steers sent so far — without affecting it. Use it to gather evidence before deciding whether to steer or stop.
- **Steer** uses OpenCode's native server-side steering (`delivery: "steer"`, OpenCode >= 1.17): the instruction is injected into the agent's current run, even while the session is mid-step. On older servers the plugin falls back to a direct v1 prompt; if the session is busy and rejects it, the tool reports the failure so the supervisor can retry or stop. A delivered steer extends the run and resets the timeout window.
- **Stop** aborts the session cleanly. Partial output is saved and readable via `delegation_read(id)`, marked `[STOPPED BY SUPERVISOR]`.

Completion is delivered via `<task-notification>` — there is no need to poll.

Notifications are split by audience: the model receives the `<task-notification>` XML as a hidden synthetic part (the TUI does not render it), while the human gets a TUI toast. The chat stays clean and the supervisor still receives full machine-readable context.

## Installation

### From npm

Add the package to the `plugin` array in your OpenCode config at `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["@aeondave/opencode-background-agents@latest"]
}
```

OpenCode installs the plugin and its dependencies automatically on the next start. To pin a version, replace `@latest` with a specific version (e.g. `@0.1.0`).

### From source (git clone)

Run from a local checkout — useful before publishing or while hacking on the plugin.

1. Clone the repository and install dependencies:

   ```bash
   git clone https://github.com/AeonDave/opencode-background-agents.git
   cd opencode-background-agents
   npm install
   ```

2. Create a shim file in your global plugin directory that re-exports the checkout's entry point. The directory is `plugin` (singular):

   - Path: `~/.config/opencode/plugin/background-agents.ts`
   - Content — a single line pointing at the absolute path of the cloned entry point:

   ```ts
   export { default } from "/absolute/path/to/opencode-background-agents/src/plugin/background-agents.ts"
   ```

   On Windows, use forward slashes and include the drive letter:

   ```ts
   export { default } from "C:/opencode-background-agents/src/plugin/background-agents.ts"
   ```

3. Restart OpenCode. The plugin loads from your working tree, so edits to `src/` take effect on the next restart. Delete the shim file to uninstall.

> Use one method at a time. If you add the npm entry, remove the local shim (and vice versa) to avoid loading the plugin twice.

## Configuration

| Environment variable | Default | Effect |
|----------------------|---------|--------|
| `BACKGROUND_AGENTS_STRICT_READONLY` | unset | When set to `1`, only read-only sub-agents may use `delegate`; write/bash-capable agents are rejected and told to use the native `task` tool. |
| `BACKGROUND_AGENTS_TIMEOUT_MINUTES` | `15` | Default max runtime per delegation. `0` = no timeout. |

By default the read-only restriction is relaxed: write- and bash-capable sub-agents can run as background delegations, with a logged warning. Background sessions live outside OpenCode's undo/branching tree, so their file and bash side effects cannot be reverted through the UI. Enable strict mode if you want the original safe behavior.

### Timeouts

Each delegation gets its own timeout window (default 15 minutes). The supervisor sets it per task via `delegate(..., timeout_minutes)` — short for quick lookups, long for deep research or builds, or `0` for no timeout at all. Because the supervisor can steer or stop a delegation at any moment, an unbounded run is a legitimate choice, not a leak. A delivered steer re-opens a fresh window of the same size. `delegation_status()` shows remaining time (or `no timeout`) per task.

## Best practices

- **Size timeouts per task.** Use a short window for quick lookups and a long one for builds or deep research. Use `0` when you genuinely want the agent to run until done — you can always stop it.
- **Size the model per task.** `delegate(..., model: "provider/model-id")` overrides the agent's configured model for that one delegation: a cheap, fast model for simple lookups, a strong one for deep work. Omitted, the agent's default applies. An invalid model fails the delegation with an error notification.
- **Do not poll.** `delegation_status()` is instant and cheap. `<task-notification>` will arrive automatically on completion.
- **Peek before steering.** Read the live transcript with `delegation_peek` to understand what the agent is doing before sending a correction. Steering without evidence often misdirects rather than corrects.
- **Read results via `delegation_read`.** Do not try to reconstruct output from status or peek; the full persisted markdown is always available once the delegation reaches a terminal state.
- **Enable strict read-only mode when undo safety matters.** If you need to guarantee that background work does not touch the filesystem outside OpenCode's undo tree, set `BACKGROUND_AGENTS_STRICT_READONLY=1`.

## Monitoring

Besides `delegation_status()`, you can navigate sub-agent sessions directly in the TUI:

| Shortcut | Action |
|----------|--------|
| `Ctrl+X Up` | Jump to parent session |
| `Ctrl+X Left` | Previous sub-agent |
| `Ctrl+X Right` | Next sub-agent |

Navigating into a running child session is read-only. Use `delegation_steer` to actually send instructions to it.

## Lifecycle and reliability

- Stable delegation IDs are reused across state, artifact path, notifications, and retrieval.
- Explicit lifecycle transitions: `registered` → `running` → terminal state.
- Terminal-state protection: late progress events cannot regress a completed or stopped delegation.
- Results are persisted before terminal notification delivery.
- Compaction carries forward running and unread completed delegations with retrieval hints.
- **Restart recovery.** Active delegations are mirrored to `<id>.state.json` beside their artifact. On plugin start, orphaned state files are re-adopted and reconciled against the server: sessions still running resume normally (steer, stop, status, and read all work again); settled sessions are finalized from their messages so the parent still receives its notification.

This is plugin-level lifecycle parity. It does not replicate OpenCode's internal task queue, notification-priority controls, or native undo/branching for write-capable background execution.

## Development

```bash
npm install        # install dev dependencies
npm run typecheck
bun test           # unit + property-based (fast-check) test suite
```

The test suite covers the full delegation lifecycle against a fake OpenCode client (async dispatch, completion notifications, native and fallback steering, stop, timeout vs unlimited runs, peek, crash-recovery restore), native-steer capability detection, and fuzzing of the state serializer and metadata fallback.

## FAQ

**How does the AI know what each delegation contains?**
Each delegation is auto-tagged with a title and summary when it completes, so `delegation_list()` shows described entries rather than opaque IDs.

**Does this persist after the session ends?**
Yes. Results are saved to disk and survive compaction, restarts, and crashes. Delegations that were still running when OpenCode exited are re-adopted on the next start and finalized normally.

**Does this bloat my context?**
The opposite — heavy work runs in a separate session, and only the distilled result returns when you call `delegation_read()`.

**Can write-capable agents run in the background?**
Yes, by default. Their changes live outside OpenCode's undo/branching tree and cannot be reverted via the UI. Set `BACKGROUND_AGENTS_STRICT_READONLY=1` to forbid this.

**Can I use a different model for a specific delegation?**
Yes. Pass `model: "provider/model-id"` as the fourth argument to `delegate` (e.g. `anthropic/claude-haiku-4-5`). The override applies only to that delegation; other delegations keep their agent's configured model. An invalid format is rejected immediately by the tool; a nonexistent model fails the delegation with an error notification. The active model shows up in `delegation_status()` and `delegation_peek`.

## Credits

The core concept — async fire-and-forget delegation with disk-persisted results — comes from [kdcokenny/opencode-background-agents](https://github.com/kdcokenny/opencode-background-agents). The underlying delegation engine is based on [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) by @code-yeongyu (MIT). This project extends both with interactive supervisor control and lifecycle reliability.

## Disclaimer

This project is not built by the OpenCode team and is not affiliated with [OpenCode](https://github.com/sst/opencode).

## License

MIT
