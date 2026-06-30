export function getEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value?.trim() ? value : fallback;
}

export function getEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
