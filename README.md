# pi-oh-my

A collection of enhancements for the [Pi coding agent](https://pi.dev), inspired by [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) and [oh-my-pi](https://github.com/can1357/oh-my-pi).

## Features

- **🔗 Hashline** — Eliminates stale-line edit errors. Read output gets `LINE#HASH|` tags per line; the agent edits by referencing anchors like `11#ABC` instead of reproducing `oldText`. If the file changed since the last read, the hash won't match and the edit is rejected before any corruption.

- **📐 Rules Injection** — Progressive disclosure for directory-level rules. When the agent reads a file in `src/auth/`, that directory's `AGENTS.md` is automatically appended to the read result. Avoids stuffing all rules into the system prompt. Deduplicated per session; re-injects after compaction.

- **📋 /init-deep** — One command walks your project tree and generates a concise `AGENTS.md` in each source directory (Purpose / Key Files / Conventions / Dependencies). Skips directories that already have one.

## Installation

```bash
pi install ~/Desktop/pi-oh-my
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

## Uninstall

```bash
pi uninstall pi-oh-my
```

## License

MIT
