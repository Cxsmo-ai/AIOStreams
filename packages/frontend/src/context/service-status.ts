type ServiceCredentialMetadata = {
  id: string;
  required?: boolean;
  default?: string | null;
  forced?: string | null;
};

type ServiceMetadata = {
  credentials: readonly ServiceCredentialMetadata[];
};

type ServiceState = {
  enabled?: boolean;
  credentials: Record<string, string>;
};

/** Merge server credential metadata without overwriting a user's choices. */
export function applyServiceMetadata<T extends ServiceState>(
  service: T,
  metadata: ServiceMetadata
): T {
  const credentials = { ...service.credentials };

  for (const credential of metadata.credentials) {
    if (credential.forced) {
      credentials[credential.id] = credential.forced;
    } else if (credential.default && credentials[credential.id] === undefined) {
      credentials[credential.id] = credential.default;
    }
  }

  let enabled = service.enabled;
  if (enabled === undefined) {
    const requiredCredentials = metadata.credentials.filter(
      (credential) => credential.required
    );
    if (requiredCredentials.length > 0) {
      enabled = requiredCredentials.every(
        (credential) =>
          credential.forced ||
          credential.default ||
          credentials[credential.id] !== undefined
      );
    }
  }

  return { ...service, credentials, enabled };
}

/** Saving a TorrentClaw key in its Services form is an explicit enable action. */
export function enableServiceAfterCredentialSave(
  serviceId: string,
  wasEnabled: boolean | undefined,
  credentials: Record<string, unknown>
): boolean {
  if (
    serviceId === 'torrentclaw' &&
    typeof credentials.apiKey === 'string' &&
    credentials.apiKey.trim().length > 0
  ) {
    return true;
  }
  return wasEnabled ?? true;
}
