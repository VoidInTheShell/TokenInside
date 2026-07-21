export function parseCutover(
  value: string | undefined,
  requiredForBinding: boolean,
): string | undefined;

export function manifestHash(manifest: {
  version: number;
  upstreamBaseUrl: string;
  configuredControlUserId: string;
  observedControlUserId: string;
  checkedAt: string;
  cutoverAt: string;
}): string;

export function assertStableEmptyCollection(
  label: string,
  fetchPage: (page: number) => Promise<{ total: number; items: unknown[] }>,
): Promise<{ total: 0; pagesRead: number }>;

export function runGreenfieldPreflight(): Promise<void>;
