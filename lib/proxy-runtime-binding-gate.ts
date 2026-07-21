export type ProxyRuntimeBindingGateResult<T> =
  | { ready: true; value: T }
  | { ready: false; error: unknown };

/**
 * Resolve the fail-closed runtime binding before the proxy acquires any
 * concurrency slot or persists a pending request. Keeping this tiny boundary
 * dependency-injected makes the ordering contract directly testable without
 * loading the full Next.js route.
 */
export async function resolveProxyRuntimeBinding<T>(
  resolve: () => Promise<T>,
): Promise<ProxyRuntimeBindingGateResult<T>> {
  try {
    return { ready: true, value: await resolve() };
  } catch (error) {
    return { ready: false, error };
  }
}
