import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import { runInProcessSubagent } from "../packages/subagent/async-subagent.ts";
import { DEFAULT_TIMEOUT_MS, DEFAULT_TOOLS, EXCLUDED_CHILD_TOOLS, SUBAGENT_PROMPT } from "../packages/subagent/constants.ts";

type BenchResult = {
  readonly kind: "in_process" | "spawn_process";
  readonly iteration: number;
  readonly ms: number;
  readonly rssDeltaMb: number;
  readonly peakRssMb: number;
  readonly ok: boolean;
  readonly output: string;
};

type BenchConfig = {
  readonly iterations: number;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly tools: string;
};

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function rssMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

async function sampleProcessRssMb(pid: number): Promise<number> {
  const result = await new Promise<string>((resolve) => {
    const ps = spawn("ps", ["-o", "rss=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    ps.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    ps.on("close", () => resolve(output));
    ps.on("error", () => resolve(""));
  });
  return rssMb(Number(result.trim() || 0) * 1024);
}

async function runWithParentRssSampling<T>(run: () => Promise<T>): Promise<{ readonly value: T; readonly peakRssMb: number }> {
  let peak = process.memoryUsage.rss();
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage.rss());
  }, 25);
  try {
    const value = await run();
    return { value, peakRssMb: rssMb(peak) };
  } finally {
    clearInterval(sampler);
  }
}

async function benchInProcess(config: BenchConfig, iteration: number): Promise<BenchResult> {
  const parentBefore = process.memoryUsage.rss();
  const started = performance.now();
  const sampled = await runWithParentRssSampling(() =>
    runInProcessSubagent({
      cwd: process.cwd(),
      prompt: config.prompt,
      tools: config.tools,
      timeoutMs: config.timeoutMs,
      currentModel: undefined,
      modelRegistry: undefined,
    })
  );
  const ms = performance.now() - started;
  const parentAfter = process.memoryUsage.rss();
  return {
    kind: "in_process",
    iteration,
    ms: Math.round(ms),
    rssDeltaMb: rssMb(parentAfter - parentBefore),
    peakRssMb: sampled.peakRssMb,
    ok: !sampled.value.timedOut && sampled.value.stopReason !== "error" && sampled.value.stopReason !== "aborted",
    output: sampled.value.text.slice(0, 200),
  };
}

async function benchSpawnProcess(config: BenchConfig, iteration: number): Promise<BenchResult> {
  const started = performance.now();
  const args = [
    "-p",
    "--no-session",
    "--tools",
    config.tools,
    "--exclude-tools",
    EXCLUDED_CHILD_TOOLS,
    "--append-system-prompt",
    SUBAGENT_PROMPT,
    config.prompt,
  ];
  const child = spawn("pi", args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let stderr = "";
  let peakRssMb = 0;
  const samples: Promise<void>[] = [];
  const sampler = setInterval(() => {
    if (child.pid !== undefined) {
      samples.push(
        sampleProcessRssMb(child.pid).then((rss) => {
          peakRssMb = Math.max(peakRssMb, rss);
        }),
      );
    }
  }, 25);
  const timeout = setTimeout(() => child.kill("SIGTERM"), config.timeoutMs);

  const code = await new Promise<number | null>((resolve) => {
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", resolve);
    child.on("error", () => resolve(-1));
  });
  clearInterval(sampler);
  clearTimeout(timeout);
  await Promise.all(samples);

  return {
    kind: "spawn_process",
    iteration,
    ms: Math.round(performance.now() - started),
    rssDeltaMb: 0,
    peakRssMb,
    ok: code === 0,
    output: (output.trim() || stderr.trim()).slice(0, 200),
  };
}

async function main(): Promise<void> {
  const config: BenchConfig = {
    iterations: positiveInt(argValue("iterations"), 1),
    prompt: argValue("prompt") ?? "Reply exactly: OK",
    timeoutMs: positiveInt(argValue("timeout-ms"), DEFAULT_TIMEOUT_MS),
    tools: argValue("tools") ?? DEFAULT_TOOLS,
  };
  const results: BenchResult[] = [];
  for (let index = 1; index <= config.iterations; index += 1) {
    results.push(await benchInProcess(config, index));
    results.push(await benchSpawnProcess(config, index));
  }
  console.log(JSON.stringify({ config, results }, null, 2));
}

await main();
