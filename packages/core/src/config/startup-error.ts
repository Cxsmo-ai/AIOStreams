/** Shared startup/configuration error without importing the settings store. */
export class ConfigStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigStartupError';
  }
}
