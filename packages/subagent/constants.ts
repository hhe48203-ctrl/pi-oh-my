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
export const EXCLUDED_CHILD_TOOLS = "subagent,subagent_async,background_delegate,check_delegate,bash_bg,check_bg";
export const DEFAULT_BASH_LABEL_PREVIEW_CHARS = 40;

export const MAX_STORED_OUTPUT = 100_000;
export const MAX_CHECK_OUTPUT = 10_000;
export const MAX_BG_TASKS = 4;
export const MAX_PANEL_TASKS = 6;
export const MAX_PANEL_LABEL = 44;
export const PANEL_REFRESH_MS = 1_000;
export const MAX_ERROR_STDERR = 1_500;
