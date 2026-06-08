# opencode-background-agents

> Keep working while research runs in the background. Results survive context compaction.

A plugin for [OpenCode](https://github.com/sst/opencode) that turns sub-agent delegation into an async, supervised workflow. Fire off tasks, keep coding, steer or stop them mid-run, and retrieve persisted results whenever you need them.

## Credits

This is a new, independent project built on an existing idea. The core concept — async "fire-and-forget" delegation with disk-persisted results — comes from [kdcokenny/opencode-background-agents](https://github.com/kdcokenny/opencode-background-agents), and the underlying delegation engine is based on [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) by @code-yeongyu (MIT).

This project goes further with two main advantages:

- **Interactive supervisor control** — check status, inject instructions, or cancel a delegation while it runs, instead of only firing and forgetting.
- **Write-capable background agents** — write- and bash-capable sub-agents can run in the background too, not just read-only ones (toggleable).

## Why This Exists

Context windows fill up. When compaction kicks in, the AI loses track of research it just did, then re-explains and re-researches. Background agents fix this:

- **Keep working** — Delegate a task and continue the conversation. You are never blocked waiting for a sub-agent.
- **Survive compaction** — Results are written to disk as markdown. When context gets tight, the AI knows exactly where to retrieve past work.
- **Stay in control** — Check status, steer, or stop a running delegation at any time.

## How It Works

```
1. Delegate   →  "Research OAuth2 PKCE best practices"
2. Continue   →  Keep coding, brainstorming, reviewing
3. Supervise  →  status / steer / stop while it runs (optional)
4. Notified   →  <task-notification> arrives on terminal state
5. Retrieve   →  delegation_read(id) returns the full result
```

Each delegation runs in its own isolated OpenCode session and is auto-tagged with a title and summary. Results are persisted to `~/.local/share/opencode/delegations/<project>/` as markdown, so the AI can scan past research and retrieve exactly what it needs — even after compaction, restarts, or crashes.

## Tools

The plugin registers six tools:

| Tool | Purpose |
|------|---------|
| `delegate(prompt, agent)` | Launch a background task; returns a readable ID immediately |
| `delegation_read(id)` | Retrieve the full persisted result of a delegation |
| `delegation_list()` | List all delegations with titles, summaries, and read state |
| `delegation_status()` | Cheap live status of active delegations (elapsed, tool calls, heartbeat, steer count) — never blocks or polls |
| `delegation_steer(id, message)` | Inject an extra instruction into a **running** delegation |
| `delegation_stop(id)` | Abort a running delegation and keep its partial output |

### Interactive control

`status`, `steer`, and `stop` give the supervisor mid-run control, similar to a lead talking to a teammate:

- **Status** is read from memory and instant — use it to decide whether to intervene.
- **Steer** queues an instruction at the next turn boundary, so it is never dropped. Steering extends the run until the steered turn settles.
- **Stop** aborts the session cleanly; partial output is saved and readable with `delegation_read(id)`, marked `[STOPPED BY SUPERVISOR]`.

Completion is still delivered via `<task-notification>` — there is no need to poll.

## Installation

### From npm (recommended)

Add the package to the `plugin` array in your OpenCode config at `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["@aeondave/opencode-background-agents@latest"]
}
```

OpenCode installs the plugin and its dependencies automatically on the next start. To pin a version, replace `@latest` with a specific version (e.g. `@0.1.0`).

### From a local clone (shim)

Run from a local checkout — useful before publishing or while hacking on the plugin:

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

   On Windows, use forward slashes and include the drive letter, for example:

   ```ts
   export { default } from "C:/opencode-background-agents/src/plugin/background-agents.ts"
   ```

3. Restart OpenCode. The plugin loads from your working tree, so edits to `src/` take effect on the next restart. Delete the shim file to uninstall.

> Use one method at a time. If you add the npm entry, remove the local shim (and vice versa) so the plugin is not loaded twice.

## Configuration

| Environment variable | Default | Effect |
|----------------------|---------|--------|
| `BACKGROUND_AGENTS_STRICT_READONLY` | unset | When set to `1`, only read-only sub-agents may use `delegate`; write/bash-capable agents are rejected and told to use the native `task` tool. |

By default the read-only restriction is **relaxed**: write- and bash-capable sub-agents can run as background delegations, with a logged warning. Background sessions live outside OpenCode's undo/branching tree, so their file/bash side effects cannot be reverted through the UI. Enable strict mode if you want the original safe behavior.

Delegations time out after **15 minutes**.

## Real-Time Monitoring

Besides `delegation_status()`, you can navigate sub-agent sessions in the TUI:

| Shortcut | Action |
|----------|--------|
| `Ctrl+X Up` | Jump to parent session |
| `Ctrl+X Left` | Previous sub-agent |
| `Ctrl+X Right` | Next sub-agent |

Navigating into a running child session is read-only — use `delegation_steer` to actually talk to it.

## Lifecycle Behavior

The plugin mirrors Claude Code-style background-agent lifecycle behavior within OpenCode plugin boundaries:

- Stable delegation IDs are reused across state, artifact path, notifications, and retrieval.
- Explicit lifecycle transitions (`registered` → `running` → terminal).
- Terminal-state protection: late progress events cannot regress a terminal status.
- Persistence happens before terminal notification delivery.
- `delegation_read(id)` blocks until terminal/timeout and returns deterministic terminal info with a persisted fallback.
- Compaction carries forward running and unread completed delegations with retrieval hints.

This is plugin-level lifecycle parity, not runtime-internal parity. It does not replicate OpenCode's internal task queue, notification-priority controls, or native undo/branching for write-capable background execution.

## Development

```bash
npm install      # install dev dependencies
npm run typecheck
```

## FAQ

**How does the AI know what each delegation contains?**
Each delegation is auto-tagged with a title and summary when it completes, so `delegation_list()` shows described entries rather than opaque IDs.

**Does this persist after the session ends?**
Yes. Results are saved to disk and survive compaction, restarts, and crashes. New sessions start fresh, but the files remain on disk.

**Does this bloat my context?**
The opposite — heavy work runs in a separate session, and only the distilled result returns when you call `delegation_read()`.

**Can write-capable agents run in the background?**
Yes, by default. Their changes live outside OpenCode's undo/branching tree and cannot be reverted via the UI. Set `BACKGROUND_AGENTS_STRICT_READONLY=1` to forbid this.

## Disclaimer

This project is not built by the OpenCode team and is not affiliated with [OpenCode](https://github.com/sst/opencode).

## License

MIT
