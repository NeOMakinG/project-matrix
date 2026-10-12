/**
 * Heuristics for instruction-like text inside production evidence. Error messages, frame names
 * and URLs from client SDKs are attacker-controlled; text that addresses the reader, asks for code
 * changes or tries to steer the triage score means a human must look first.
 */
const RULES: [string, RegExp][] = [
  [
    "override",
    /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|earlier|all|any|system)\b.{0,20}\b(instructions?|rules?|prompts?|context)\b/i,
  ],
  [
    "role",
    /\b(you are|act as|as (an?|the))\b.{0,30}\b(ai|assistant|agent|model|llm|implementer|reviewer|developer)\b/i,
  ],
  ["role-tag", /(^|\n)\s*(system|assistant|user|developer)\s*:/i],
  ["prompt", /\b(system prompt|prompt injection|jailbreak)\b/i],
  [
    "score-steering",
    /\b(fixab\w*|severity|category|confidence|priority)\b\W{0,3}(\b(should|must|to|is|be|of|set|=)\b\W{0,3}){0,3}(0?\.\d+|1(\.0+)?|high|critical|code|p0)\b/i,
  ],
  // Imperative only ("Add an admin bypass…", "please create a webhook…"), so "Failed to create token" isn't flagged.
  [
    "code-change",
    /(^|[.!?:;,]\s*|\b(please|you (should|must|need to)|must|should|then)\s+)(add|create|insert|implement|introduce|write|commit|push|merge)\b.{0,40}\b(backdoor|bypass|admin|superuser|credential|password|token|api key|webhook|endpoint|route)\b/i,
  ],
  [
    "weaken",
    /\b(disable|remove|skip|turn off|bypass)\b.{0,30}\b(auth\w*|security|validation|checks?|tests?|csrf|cors|rate limit\w*|2fa|mfa)\b/i,
  ],
  ["exec", /\b(curl|wget)\b[^\n]{0,80}\|\s*(ba)?sh\b|\brm\s+-rf\b|\beval\(|\bchild_process\b/i],
  ["exfil", /\b(send|post|upload|exfiltrate|leak)\b.{0,40}\b(to|at)\b.{0,10}\bhttps?:\/\//i],
  ["markdown-escape", /(```|~~~)/],
];

export function instructionFlags(texts: (string | undefined)[]): string[] {
  const hits = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const [name, re] of RULES) if (re.test(text)) hits.add(name);
  }
  return [...hits].sort();
}
