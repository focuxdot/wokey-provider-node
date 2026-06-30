export type SubscriptionPlanVendor = 'openai' | 'anthropic' | string;

const CODEX_EXACT_DISPLAY_NAMES: Record<string, string> = {
  pro: 'Codex Pro 20x',
  prolite: 'Codex Pro 5x',
  pro_lite: 'Codex Pro 5x',
  'pro-lite': 'Codex Pro 5x',
  'pro lite': 'Codex Pro 5x',
};

const UPPERCASE_WORDS = new Set(['cbp', 'k12']);

export function subscriptionPlanDisplayName(
  vendor: SubscriptionPlanVendor | undefined,
  raw?: string,
): string | undefined {
  const normalizedVendor = vendor?.trim().toLowerCase();
  if (normalizedVendor === 'openai') return codexPlanDisplayName(raw);
  if (normalizedVendor === 'anthropic') return claudePlanDisplayName(raw);
  return genericPlanDisplayName(raw);
}

export function normalizeClaudeSubscriptionType(...rawValues: Array<string | undefined>): string | undefined {
  const candidates = rawValues
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (!candidates.length) return undefined;
  return candidates
    .map((value, index) => ({ value, index, score: claudePlanSpecificity(value) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.value;
}

export function isConcreteClaudeSubscriptionType(raw?: string): boolean {
  return claudePlanSpecificity(raw ?? '') >= 10;
}

export function codexPlanDisplayName(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;

  const exact = CODEX_EXACT_DISPLAY_NAMES[trimmed.toLowerCase()];
  if (exact) return exact;

  const cleaned = cleanPlanName(trimmed);
  if (!cleaned) return trimmed;

  const cleanedExact = CODEX_EXACT_DISPLAY_NAMES[cleaned.toLowerCase()];
  if (cleanedExact) return cleanedExact;

  const displayName = titleizeWords(cleaned);
  return displayName.toLowerCase().startsWith('codex ') ? displayName : `Codex ${displayName}`;
}

export function claudePlanDisplayName(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const words = normalizedWords(trimmed);
  const maxMultiplier = words.includes('max') ? claudeMaxMultiplier(words) : undefined;
  if (words.includes('max')) return maxMultiplier ? `Claude Max ${maxMultiplier}` : 'Claude Max';
  if (words.includes('pro')) return 'Claude Pro';
  if (words.includes('team')) return 'Claude Team';
  if (words.includes('enterprise')) return 'Claude Enterprise';
  if (words.includes('ultra')) return 'Claude Ultra';
  return genericPlanDisplayName(trimmed);
}

export function genericPlanDisplayName(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const cleaned = cleanPlanName(trimmed);
  return cleaned ? titleizeWords(cleaned) : trimmed;
}

function cleanPlanName(raw: string): string {
  return raw
    .replace(/\b(claude|codex|account|plan)\b/gi, ' ')
    .replace(/_/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleizeWords(raw: string): string {
  const words = raw
    .split(/[_\-\s]+/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (!words.length) return raw;
  return words.map(wordDisplayName).join(' ') || raw;
}

function wordDisplayName(raw: string): string {
  const lower = raw.toLowerCase();
  if (UPPERCASE_WORDS.has(lower)) return lower.toUpperCase();
  if (raw === raw.toUpperCase() && /[a-z]/i.test(raw)) return raw;
  return /^[a-z]/.test(raw) ? raw.charAt(0).toUpperCase() + raw.slice(1) : raw;
}

function normalizedWords(raw: string): string[] {
  return raw
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function claudePlanSpecificity(raw: string): number {
  const words = normalizedWords(raw);
  if (!words.length) return 0;
  const hasConcretePlan = words.some((word) => ['max', 'pro', 'team', 'enterprise', 'ultra'].includes(word));
  if (!hasConcretePlan) return 1;
  return 10 + (claudeMaxMultiplier(words) ? 5 : 0);
}

function claudeMaxMultiplier(words: string[]): string | undefined {
  const multiplier = words.find((word) => /^\d+x$/.test(word));
  return multiplier;
}
