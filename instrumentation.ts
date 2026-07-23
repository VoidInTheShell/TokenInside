export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureRuntimeStartup } = await import("@/lib/runtime-startup");
  void ensureRuntimeStartup();
}
