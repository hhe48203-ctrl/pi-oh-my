import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	enhanceWithHashes,
	registerHashlineEditTool,
} from "./hashline.ts";
import {
	findDirectoryAgentsMd,
	formatAgentsMdBlock,
	InjectedPathsCache,
} from "./rules.ts";
import { registerInitDeepCommand } from "./init-deep.ts";

const injectedCache = new InjectedPathsCache();

export default function (pi: ExtensionAPI) {
	// ── 1. Hashline: register the hashline_edit tool ──────────────────
	registerHashlineEditTool(pi);

	// ── 2. /init-deep command ─────────────────────────────────────────
	registerInitDeepCommand(pi);

	// ── 3. Combined read enhancer: hash tags + directory AGENTS.md ────
	pi.on("tool_result", async (event, ctx) => {
		// Only enhance successful read results
		if (event.toolName !== "read" || event.isError) return;

		// Find the text content part
		const textPart = event.content.find(
			(c): c is { type: "text"; text: string } => c.type === "text",
		);
		if (!textPart) return;

		const text = textPart.text;
		const input = event.input as { path?: string; offset?: number };
		if (!input.path) return;

		const startLine = input.offset ?? 1;

		// Step A: Add hash anchors to file content lines
		let enhanced = enhanceWithHashes(text, startLine);

		// Step B: Append directory-level AGENTS.md context (if not already injected)
		try {
			const absolutePath = resolve(ctx.cwd, input.path);
			const dir = dirname(absolutePath);
			const agentsMdPath = findDirectoryAgentsMd(dir);

			if (agentsMdPath) {
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!injectedCache.has(sessionFile, agentsMdPath)) {
					const block = await formatAgentsMdBlock(agentsMdPath);
					if (block) {
						enhanced += block;
						injectedCache.add(sessionFile, agentsMdPath);
					}
				}
			}
		} catch {
			// Silently skip on error — don't break the read
		}

		// Return the modified content
		const newContent = event.content.map((c) => {
			if (c.type === "text") {
				return { type: "text" as const, text: enhanced };
			}
			return c;
		});

		return { content: newContent };
	});

	// ── 4. Clear injection cache on compaction ────────────────────────
	// After compaction, old tool results (with injected AGENTS.md) are
	// summarized away. Clearing the cache allows re-injection on the next
	// read, so the agent still sees directory rules.
	pi.on("session_compact", async (_event, ctx) => {
		injectedCache.clearSession(ctx.sessionManager.getSessionFile());
	});

	// ── 5. Clear all state on shutdown ────────────────────────────────
	pi.on("session_shutdown", async () => {
		injectedCache.clear();
	});
}
