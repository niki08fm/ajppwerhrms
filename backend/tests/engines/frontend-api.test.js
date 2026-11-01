import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../frontend/src/services/api.js';
afterEach(() => vi.unstubAllGlobals());
describe('Cross-origin API request headers', () => {
  it('keeps bodyless GET and DELETE requests simple and includes session cookies', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      data: []
    })));
    vi.stubGlobal('fetch', fetch);
    await api.get('/employees', {
      q: 'Anita'
    });
    await api.del('/example');
    for (const [, options] of fetch.mock.calls) {
      expect(options.headers['Content-Type']).toBeUndefined();
      expect(options.credentials).toBe('include');
      expect(options.body).toBeUndefined();
    }
  });
  it('still sends JSON for mutations, preserves explicit headers and lets FormData set its boundary', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await api.post('/employees', {
      name: 'Sample'
    });
    await api.get('/secure', {}, {
      'X-PII': 'full'
    });
    const form = new FormData();
    form.set('name', 'Sample');
    await api.post('/upload', form);
    expect(fetch.mock.calls[0][1]).toMatchObject({
      headers: {
        'Content-Type': 'application/json'
      },
      body: '{"name":"Sample"}'
    });
    expect(fetch.mock.calls[1][1].headers).toEqual({
      'X-PII': 'full'
    });
    expect(fetch.mock.calls[2][1].headers).toEqual({});
    expect(fetch.mock.calls[2][1].body).toBe(form);
  });
});
