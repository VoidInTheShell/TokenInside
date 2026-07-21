import { createHash } from "node:crypto";

export const greenfieldInstallationManifestVersion = 1 as const;

export type GreenfieldInstallationManifest = {
  version: typeof greenfieldInstallationManifestVersion;
  upstreamBaseUrl: string;
  configuredControlUserId: string;
  observedControlUserId: string;
  checkedAt: string;
  cutoverAt: string;
  manifestHash: string;
};

export function normalizeGreenfieldUpstreamBaseUrl(value: string) {
  return new URL(value).toString().replace(/\/+$/, "");
}

function manifestHashPayload(
  manifest: Omit<GreenfieldInstallationManifest, "manifestHash">,
) {
  return JSON.stringify({
    version: manifest.version,
    upstreamBaseUrl: normalizeGreenfieldUpstreamBaseUrl(
      manifest.upstreamBaseUrl,
    ),
    configuredControlUserId: manifest.configuredControlUserId,
    observedControlUserId: manifest.observedControlUserId,
    checkedAt: manifest.checkedAt,
    cutoverAt: manifest.cutoverAt,
  });
}

export function greenfieldInstallationManifestHash(
  manifest: Omit<GreenfieldInstallationManifest, "manifestHash">,
) {
  return createHash("sha256").update(manifestHashPayload(manifest)).digest("hex");
}

export function verifyGreenfieldInstallationManifest(
  manifest: GreenfieldInstallationManifest | null | undefined,
) {
  if (!manifest || manifest.version !== greenfieldInstallationManifestVersion) {
    return { ready: false as const, reason: "manifest_missing_or_unsupported" as const };
  }
  const expectedHash = greenfieldInstallationManifestHash(manifest);
  if (expectedHash !== manifest.manifestHash) {
    return { ready: false as const, reason: "manifest_hash_invalid" as const };
  }
  return { ready: true as const, reason: undefined };
}

export function verifyGreenfieldInstallationBinding(input: {
  manifest: GreenfieldInstallationManifest | null | undefined;
  upstreamBaseUrl: string;
  configuredControlUserId?: string;
}) {
  const verified = verifyGreenfieldInstallationManifest(input.manifest);
  if (!verified.ready) return verified;
  if (
    normalizeGreenfieldUpstreamBaseUrl(input.upstreamBaseUrl) !==
    normalizeGreenfieldUpstreamBaseUrl(input.manifest!.upstreamBaseUrl)
  ) {
    return { ready: false as const, reason: "upstream_base_url_drift" as const };
  }
  if (
    !input.configuredControlUserId ||
    input.configuredControlUserId !== input.manifest!.configuredControlUserId
  ) {
    return { ready: false as const, reason: "control_user_id_drift" as const };
  }
  return { ready: true as const, reason: undefined };
}
