export function newApiClientBaseUrls(publicBaseUrl?: string | null) {
  const normalized = publicBaseUrl?.trim().replace(/\/+$/, "") ?? "";
  if (!normalized) {
    return {
      openAiBaseUrl: "",
      claudeCodeBaseUrl: "",
    };
  }

  const alreadyVersioned = normalized.endsWith("/v1");
  return {
    openAiBaseUrl: alreadyVersioned ? normalized : `${normalized}/v1`,
    claudeCodeBaseUrl: alreadyVersioned ? normalized.slice(0, -3) : normalized,
  };
}
