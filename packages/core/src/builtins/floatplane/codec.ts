export function containsAv1(value: unknown): boolean {
  try {
    return /\bav1\b|av01/i.test(JSON.stringify(value));
  } catch {
    return false;
  }
}
