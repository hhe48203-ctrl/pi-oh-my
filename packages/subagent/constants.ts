export const SUBAGENT_PROMPT = [
  "You are a focused subagent working on a delegated task.",
  "Complete it thoroughly but efficiently.",
  "Provide a clear summary of your findings or actions.",
  "Do not ask questions — make reasonable assumptions and proceed.",
  "You have no knowledge of any parent conversation.",
].join(" ");

export const DEFAULT_TOOLS = "read,grep,find,ls";
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const KILL_GRACE_MS = 5000;
export const EXCLUDED_CHILD_TOOLS = "subagent,subagent_async,spawn_bg,bash_bg,check_bg,check_spawn";
