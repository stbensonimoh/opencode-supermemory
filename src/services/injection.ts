import { CONFIG } from "../config.js";

const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /`[^`]+`/g;

const MEMORY_KEYWORD_PATTERN = new RegExp(
  `\\b(${CONFIG.keywordPatterns.join("|")})\\b`,
  "i",
);

export const MEMORY_NUDGE_MESSAGE = `[MEMORY TRIGGER DETECTED]
The user wants you to remember something. You MUST use the \`supermemory\` tool with \`mode: "add"\` to save this information.

Extract the key information the user wants remembered and save it as a concise, searchable memory.
- Use \`scope: "project"\` for project-specific preferences (e.g., "run lint with tests")
- Use \`scope: "user"\` for personal preferences in this project (e.g., "prefers concise responses")
- Choose an appropriate \`type\`: "preference", "project-config", "learned-pattern", etc.

DO NOT skip this step. The user explicitly asked you to remember.`;

function removeCodeBlocks(text: string): string {
  return text.replace(CODE_BLOCK_PATTERN, "").replace(INLINE_CODE_PATTERN, "");
}

export function detectMemoryKeyword(text: string): boolean {
  const textWithoutCode = removeCodeBlocks(text);
  return MEMORY_KEYWORD_PATTERN.test(textWithoutCode);
}

// Patterns that suggest the current message depends on context from earlier
// sessions: references to past work, decisions, conventions, or preferences.
// Mirrors the guidance in the recall directive. Deliberately conservative,
// so trivial or self-contained messages skip the recall API call.
const RECALL_TRIGGER_PATTERN = new RegExp(
  [
    "like (we|you) did",
    "as (we|you) did",
    "as before",
    "like before",
    "the (bug|issue|fix|decision|setup|config|convention) from before",
    "earlier (today|this week|session)",
    "last (time|session|week|time we)",
    "the (auth|api|design|build|pipeline|branch|plugin) (we|you) (set up|built|fixed|discussed|decided)",
    "what (did|were) we (decide|do|use|agree)",
    "how (did|do) we (do|set up|handle|fix)",
    "do (i|you) (prefer|usually)",
    "my (usual|standard|normal|preferred) (setup|flow|workflow|approach)",
    "keep (going|working) (on|from)",
    "continue (from|where|on)",
    "pick (it|this|up) (where|from)",
    "we (discussed|agreed|decided|talked)",
    "previous (conversation|session|decision|version)",
    "from (the|our) (last|previous)",
  ].join("|"),
  "i",
);

export function matchesRecallHeuristic(text: string): boolean {
  const textWithoutCode = removeCodeBlocks(text);
  return RECALL_TRIGGER_PATTERN.test(textWithoutCode);
}
