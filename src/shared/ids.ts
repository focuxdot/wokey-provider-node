import { nanoid } from 'nanoid';

const SHORT_ID_LENGTH = 10;

export function generateProviderId(): string {
  return nanoid(SHORT_ID_LENGTH);
}

export function generateNodeId(): string {
  return nanoid(SHORT_ID_LENGTH);
}

export function formatDerivedNodeId(suffix: string): string {
  return suffix;
}
