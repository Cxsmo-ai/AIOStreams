const env = process.env as Record<string, string | undefined>;
env.NODE_ENV ??= 'test';
env.SECRET_KEY ??= '0'.repeat(64); // 64-char hex required by the validator
if (!env.BASE_URL || env.BASE_URL === '/') {
  env.BASE_URL = 'http://localhost:3000'; // Vitest may inject Vite's non-URL base.
}
env.LOG_LEVEL ??= 'error'; // keep test output clean; override to debug locally
