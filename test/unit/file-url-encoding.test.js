'use strict';

// Regression tests for URL-unsafe file IDs.
//
// ChatGPT composes some file IDs from several parts joined by '#', e.g.
//   1db208971374e16#file_000000008458727384502278001937d6#p_0.ecfab8dfdb.jpg
// Interpolated into a URL raw, the first '#' begins the fragment, so the path
// is truncated AND the ?conversation_id= query string is swallowed and never
// transmitted. The server receives no conversation_id and returns 422.

const HASH_FILE_ID = '1db208971374e16#file_000000008458727384502278001937d6#p_0.ecfab8dfdb.jpg';
const CONV_ID = '69f3658a-18b0-8328-87a5-9dd0e7fe5d53';

describe('file download URL encoding', () => {
  let downloader, CONFIG, requested;

  beforeEach(() => {
    jest.resetModules();
    ({ CONFIG } = require('../../lib/config'));
    CONFIG.throttleMs = 0;
    CONFIG.accountId = null;
    downloader = require('../../lib/downloader');

    requested = [];
    global.fetch = jest.fn().mockImplementation((url) => {
      requested.push(url);
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ status: 'success', download_url: 'https://example.test/f.jpg' }),
      });
    });
  });

  afterEach(() => { delete global.fetch; });

  test('percent-encodes # so the query string actually reaches the server', async () => {
    await downloader.getFileDownloadUrl('token', HASH_FILE_ID, CONV_ID);

    expect(requested).toHaveLength(1);
    const parsed = new URL(requested[0]);

    // The bug: with a raw '#', hash is non-empty and search is ''.
    expect(parsed.hash).toBe('');
    expect(parsed.searchParams.get('conversation_id')).toBe(CONV_ID);
    expect(parsed.searchParams.get('inline')).toBe('false');
  });

  test('the full file ID survives in the path, not just the first segment', async () => {
    await downloader.getFileDownloadUrl('token', HASH_FILE_ID, CONV_ID);

    const parsed = new URL(requested[0]);
    expect(decodeURIComponent(parsed.pathname.split('/files/download/')[1])).toBe(HASH_FILE_ID);
    expect(parsed.pathname).toContain('%23');
  });

  test('ordinary file IDs are unaffected', async () => {
    await downloader.getFileDownloadUrl('token', 'file-abc123', CONV_ID);

    const parsed = new URL(requested[0]);
    expect(parsed.pathname).toBe('/backend-api/files/download/file-abc123');
    expect(parsed.searchParams.get('conversation_id')).toBe(CONV_ID);
  });
});
