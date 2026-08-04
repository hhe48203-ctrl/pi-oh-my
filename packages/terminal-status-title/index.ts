import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_TITLE = "π";
const PREFIX = "π";
const MAX_TITLE_LENGTH = 40;
const SPINNER_INTERVAL_MS = 120;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type Status = "idle" | "working" | "done" | "error";

function truncateTitle(title: string): string {
	return title.length <= MAX_TITLE_LENGTH ? title : `${title.slice(0, MAX_TITLE_LENGTH - 3)}...`;
}

function basename(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	return trimmed.split(/[\\/]/).pop() || DEFAULT_TITLE;
}

function getRawTitle(pi: ExtensionAPI, ctx: ExtensionContext): string {
	return pi.getSessionName()?.trim() || basename(ctx.cwd);
}

function statusIndicator(status: Status, spinnerFrame: number): string {
	if (status === "working") return SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
	if (status === "done") return "✓";
	if (status === "error") return "✗";
	return "○";
}

function formatTitle(pi: ExtensionAPI, ctx: ExtensionContext, status: Status, spinnerFrame: number): string {
	const rawTitle = getRawTitle(pi, ctx);
	const suffix = rawTitle === DEFAULT_TITLE ? DEFAULT_TITLE : `${PREFIX} | ${truncateTitle(rawTitle)}`;
	return `${statusIndicator(status, spinnerFrame)} | ${suffix}`;
}

export default function terminalStatusTitle(pi: ExtensionAPI): void {
	let status: Status = "idle";
	let spinnerFrame = 0;
	let spinnerInterval: ReturnType<typeof setInterval> | undefined;
	let deferredWrite: ReturnType<typeof setTimeout> | undefined;
	let lastCtx: ExtensionContext | undefined;

	function clearDeferredWrite(): void {
		if (!deferredWrite) return;
		clearTimeout(deferredWrite);
		deferredWrite = undefined;
	}

	function writeTitle(ctx: ExtensionContext | undefined = lastCtx): void {
		if (!ctx?.hasUI) return;
		lastCtx = ctx;
		ctx.ui.setTitle(formatTitle(pi, ctx, status, spinnerFrame));
	}

	function stopSpinner(): void {
		if (!spinnerInterval) return;
		clearInterval(spinnerInterval);
		spinnerInterval = undefined;
		spinnerFrame = 0;
	}

	function startSpinner(ctx: ExtensionContext): void {
		if (!ctx.hasUI || spinnerInterval) return;
		spinnerFrame = 0;
		spinnerInterval = setInterval(() => {
			if (status !== "working") {
				stopSpinner();
				return;
			}
			spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
			writeTitle();
		}, SPINNER_INTERVAL_MS);
		spinnerInterval.unref?.();
	}

	function setStatus(nextStatus: Status, ctx: ExtensionContext): void {
		clearDeferredWrite();
		status = nextStatus;
		lastCtx = ctx;
		if (status === "working") startSpinner(ctx);
		else stopSpinner();
		writeTitle(ctx);
	}

	function scheduleWrite(ctx: ExtensionContext): void {
		clearDeferredWrite();
		deferredWrite = setTimeout(() => {
			deferredWrite = undefined;
			writeTitle(ctx);
		}, 0);
		deferredWrite.unref?.();
	}

	pi.on("session_start", (_event, ctx) => {
		setStatus("idle", ctx);
		scheduleWrite(ctx);
	});

	pi.on("session_info_changed", (_event, ctx) => scheduleWrite(ctx));
	pi.on("agent_start", (_event, ctx) => setStatus("working", ctx));
	pi.on("agent_settled", (_event, ctx) => setStatus("done", ctx));
	pi.on("session_shutdown", () => {
		clearDeferredWrite();
		stopSpinner();
		lastCtx = undefined;
	});
}
