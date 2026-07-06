# pi-oh-my

A collection of enhancements for the [Pi coding agent](https://pi.dev), inspired by [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) and [oh-my-pi](https://github.com/can1357/oh-my-pi).

## Features

- **🔗 Hashline** — Eliminates stale-line edit errors. Read output gets `LINE#HASH|` tags per line; the agent edits by referencing anchors like `11#ABC` instead of reproducing `oldText`. If the file changed since the last read, the hash won't match and the edit is rejected before any corruption.

- **📐 Rules Injection** — Progressive disclosure for directory-level rules. When the agent reads a file in `src/auth/`, that directory's `AGENTS.md` is automatically appended to the read result. Avoids stuffing all rules into the system prompt. Deduplicated per session; re-injects after compaction.

- **📋 /init-deep** — One command walks your project tree and generates a concise `AGENTS.md` in each source directory (Purpose / Key Files / Conventions / Dependencies). Skips directories that already have one.

- **📝 update_plan** — Structured task checklist tool (pending/in_progress/completed). The LLM calls `update_plan` to track multi-step work with a live ✓/▶/○ checklist in the TUI. Inspired by Codex's `update_plan`. Can be used standalone or with plan-mode/goal-mode.

- **⏸ Plan Mode** — Read-only exploration → plan → execute. `/plan` or `Ctrl+Alt+P` toggles a safe read-only mode (no edit/write, bash restricted to safe commands). The agent uses `update_plan` to create a checklist, then the user chooses to execute or refine. Requires update-plan.

- **🎯 Goal Mode** — Persistent objective tracking with auto-continue. `/goal <objective>` sets a durable goal; the agent automatically continues turn after turn until the goal is complete, blocked, or the turn budget is exhausted. The model gets `get_goal`/`update_goal` tools (can only mark complete/blocked). Requires update-plan.

## Installation

### All three (full bundle)

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
pi install ~/Desktop/pi-oh-my/packages/goal-mode            # only goal mode (needs update-plan)
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
```

**Goal Mode**:

```
/goal <objective>    # set a goal, agent auto-continues until done
/goal                # view current goal + budget
/goal pause          # pause (stop auto-continue)
/goal resume         # resume auto-continue
/goal clear          # remove the goal
```

## Uninstall

```bash
pi uninstall pi-oh-my
```

## License

MIT
