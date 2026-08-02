export interface SemVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemVersion(version: string): SemVersion {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Invalid version format: ${version}`);
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

export function compareSemVersions(a: SemVersion, b: SemVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function requireMinSemVersion(
  current: string,
  required: SemVersion,
  contextLabel: string
): void {
  const c = parseSemVersion(current);
  if (compareSemVersions(c, required) < 0) {
    throw new Error(
      `${contextLabel} requires v${required.major}.${required.minor}.${required.patch} or higher. Current version: ${current}.`
    );
  }
}
