import { describe, expect, it } from 'vitest';
import { SERVICE_LOGO_MAP } from '../services';

describe('shared service logo metadata', () => {
  it('provides logos for every custom service', () => {
    for (const serviceId of ['deepbrid', 'torrentclaw', 'kurato'] as const) {
      expect(SERVICE_LOGO_MAP[serviceId]).toMatch(/^https?:\/\//);
    }
  });
});
