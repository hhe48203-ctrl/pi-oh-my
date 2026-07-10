import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import hashline from "./packages/hashline/index.ts";
import rulesInjection from "./packages/rules-injection/index.ts";
import initDeep from "./packages/init-deep/index.ts";
import updatePlan from "./packages/update-plan/index.ts";
import planMode from "./packages/plan-mode/index.ts";
import goalMode from "./packages/goal-mode/index.ts";
import subagent from "./packages/subagent/index.ts";
import logAnalyze from "./packages/log-analyze/index.ts";
import { registerBuiltInToolCards } from "./packages/builtin-tools/index.ts";

const ALL_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "find", "grep", "ls"];

export default function (pi: ExtensionAPI) {
	registerBuiltInToolCards(pi);

	// Register this before Plan Mode so its startup activation is followed by
	// Plan Mode's final read-only tool reconciliation.
	pi.on("session_start", () => {
		pi.setActiveTools([...new Set([...pi.getActiveTools(), ...ALL_BUILTIN_TOOLS])]);
	});

	hashline(pi);
	rulesInjection(pi);
	initDeep(pi);
	updatePlan(pi);
	goalMode(pi);
	subagent(pi);
	logAnalyze(pi);
	planMode(pi);
}
