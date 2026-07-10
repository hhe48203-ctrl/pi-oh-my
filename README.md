# pi-oh-my

A collection of enhancements for the [Pi coding agent](https://pi.dev), inspired by [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent).

## Features

- **🔗 Hashline** — Eliminates stale-line edit errors. Read output gets `LINE#HASH|` tags per line; the agent edits by referencing anchors like `11#ABC` instead of reproducing `oldText`. If the file changed since the last read, the hash won't match and the edit is rejected before any corruption.

- **📐 Rules Injection** — Progressive disclosure for directory-level rules. When the agent reads a file in `src/auth/`, that directory's `AGENTS.md` is automatically appended to the read result. Avoids stuffing all rules into the system prompt. Deduplicated per session; re-injects after compaction.

- **📋 /init-deep** — One command walks your project tree and generates a concise `AGENTS.md` in each source directory (Purpose / Key Files / Conventions / Dependencies). Skips directories that already have one.

- **📝 update_plan** — Structured task checklist tool (pending/in_progress/completed). The LLM calls `update_plan` to track multi-step work with a live ✓/▶/○ checklist in the TUI. Inspired by Codex's `update_plan`. Can be used standalone or with plan-mode/goal-mode.

- **⏸ Plan Mode** — Read-only exploration → plan → execute. `/plan` or `Ctrl+Alt+P` enables a fail-closed read-only mode. Only `read`, `bash`, `grep`, `find`, `ls`, `update_plan`, and `get_goal` are available; write-capable, subagent, and background tools are blocked. Bash is limited to simple read-only commands: shell composition, redirects, interpreters, network commands, package managers, and mutating commands are rejected. The agent uses `update_plan` to create a checklist, then the user chooses to execute or refine. `update_plan` is needed for the checklist UI.

- **🎯 Goal Mode** — Persistent objective tracking with auto-continue. `/goal <objective>` sets a durable goal; the agent automatically continues turn after turn until the goal is complete, blocked, or the turn budget is exhausted. The model gets `get_goal`/`update_goal` tools (can only mark complete/blocked). It can be used by itself; pairing it with `update_plan` adds step tracking.

- **🤖 Subagent** — Parallel subagent delegation. The LLM calls `subagent({ prompt, description, tools? })` to spawn an isolated child Pi process with a fresh, non-persisted context. Multiple calls in one turn run in parallel automatically (`executionMode: "parallel"`). Read-only by default; add `bash,edit,write` for write access. No recursion (child can't spawn grandchildren).

- **🧪 Async Subagent** — Experimental `subagent_async` uses an in-process async Pi session instead of a child `pi` process. It keeps a fresh in-memory context but shares the parent Node runtime, useful for measuring spawn overhead.

- **🔄 Background Tasks** — Non-blocking `bash_bg` and `background_delegate` tools that start a process and return immediately with a `task_id`. The agent loop is NOT blocked — the LLM can continue working and poll results later with `check_bg` / `check_delegate`. Best for long-running commands (test suites, builds, dev servers) and long-running subagents (deep review, exploration).

- **📊 Log Analyze** — SQLite-backed session log analysis. `/log <sql>` queries imported session data; `/log-stats` shows daily, model, and tool summaries; `/log-import` imports historical sessions.

## Installation

### Full bundle

```bash
pi install ~/Desktop/pi-oh-my
```

### Individual

```bash
pi install ~/Desktop/pi-oh-my/packages/hashline           # only hashline
pi install ~/Desktop/pi-oh-my/packages/rules-injection     # only rules injection
pi install ~/Desktop/pi-oh-my/packages/init-deep           # only /init-deep
pi install ~/Desktop/pi-oh-my/packages/update-plan          # only update_plan tool
pi install ~/Desktop/pi-oh-my/packages/plan-mode           # only plan mode (needs update-plan)
pi install ~/Desktop/pi-oh-my/packages/goal-mode            # only goal mode (update-plan optional)
pi install ~/Desktop/pi-oh-my/packages/subagent             # only subagent
pi install ~/Desktop/pi-oh-my/packages/log-analyze          # only log analysis
```

Restart Pi or run `/reload`.

## Usage

**Hashline** — Just use `read` as normal. The output will have `LINE#HASH|` tags. Use `hashline_edit` instead of `edit`:

```
hashline_edit({
  path: "src/foo.ts",
  edits: [{ startAnchor: "1#A3F", endAnchor: "3#K2D", newContent: "..." }]
})
```

`startAnchor` only → single line; add `endAnchor` → range (inclusive); `newContent: ""` → delete. On "stale line" error, re-read and retry.

**Rules Injection** — No action needed. Put an `AGENTS.md` in any directory. It appears automatically when the agent reads a file there.

**``/init-deep``** — Run it; review the generated files; refine as needed.

```
/init-deep              # default depth 3
/init-deep --depth=5   # custom depth
```

**update_plan** — The agent calls the `update_plan` tool automatically for multi-step work (guided by system prompt guidelines). You can also view the plan:

```
/plan-status    # show current plan
```

**Plan Mode**:

```
/plan           # toggle read-only plan mode (or Ctrl+Alt+P)
# explore code, agent creates a plan with update_plan
# after exploration, choose: Execute / Refine / Stay
# bash remains available for simple read-only commands
```

**Goal Mode**:

```
/goal <objective>    # set a goal, agent auto-continues until done
/goal                # view current goal + budget
/goal pause          # pause (stop auto-continue)
/goal resume         # resume auto-continue
/goal clear          # remove the goal
```

**Subagent** — The agent calls `subagent` automatically when it identifies parallel, independent tasks. You can also hint:

```
Review src/auth/ and src/api/ in parallel using subagents
```

The tool call looks like:

```
subagent({
  prompt: "Review src/auth/login.ts for security issues...",
  description: "review auth module",
  tools: "read,grep,find,ls"        // optional, read-only by default
})
```

Multiple `subagent` calls in one turn run in parallel. Each gets an isolated process with fresh context.

**Async Subagent** — Same shape, but runs through the Pi SDK in the current Node process:

```
subagent_async({
  prompt: "Review src/auth/login.ts for security issues...",
  description: "review auth module",
  tools: "read,grep,find,ls"
})
```

Benchmark against process-spawned subagents:

```bash
bun run bench:subagents --iterations=1 --prompt="Reply exactly: OK"
```

**Background Tasks** — For long-running work that shouldn't block the agent loop:

```
# Start a background bash command
bash_bg({ command: "npm test", label: "run tests" })
→ "Background task started. Task ID: a1b2c3d4"

# Start a background subagent
background_delegate({ prompt: "Deep review of src/auth/...", description: "review auth" })
→ "Background subagent started. Task ID: e5f6g7h8"

# The agent can now do other work (read files, edit code, etc.)
# Later, poll for results:
check_bg({ task_id: "a1b2c3d4" })
→ "Status: running, Elapsed: 12.3s, --- output --- ..."
check_delegate({ task_id: "e5f6g7h8" })
→ "Status: completed, --- output --- ..."
```

Background tasks run in detached processes with their own timeout (default 10 min). Output is buffered (last 100KB); checks return the last 10KB. Tasks are killed on session shutdown.

**Log Analyze**:

```
/log SELECT * FROM v_daily_stats
/log-stats
/log-import
```

Subagent/background thresholds are centralized in `packages/subagent/constants.ts` (timeout, output caps, panel limits, refresh interval, bash label preview length), so tuning behavior does not require hunting for hardcoded values across files.

## Uninstall

```bash
pi uninstall pi-oh-my
```

## License

MIT
