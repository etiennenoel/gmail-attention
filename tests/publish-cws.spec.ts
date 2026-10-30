import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDeterministicZipArchive } from '../scripts/package-extension.script';
import {
  publishToChromeWebStore,
  redactSecrets,
  resolvePublishConfigFromEnvAndArgs,
} from '../scripts/publish-cws.script';

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
}

function makeMockResponse(status: number, bodyObj: unknown): Response {
  const text = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as unknown as Response;
}

describe('publishToChromeWebStore (Chrome Web Store API v2)', () => {
  let tmpDir: string;
  let zipPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-cws-test-'));
    zipPath = path.join(tmpDir, 'gmail-attention.zip');
    const validZip = createDeterministicZipArchive([
      {
        relativePosixPath: 'manifest.json',
        data: Buffer.from(JSON.stringify({ manifest_version: 3, name: 'Gmail @tention', version: '1.0.0' })),
      },
    ]);
    fs.writeFileSync(zipPath, validZip);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exchanges OAuth2 refresh token, uploads ZIP, polls :fetchStatus while IN_PROGRESS, and calls :publish', async () => {
    const requests: RecordedRequest[] = [];
    let statusCalls = 0;

    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const rawBody = init?.body;
      const bodyText =
        typeof rawBody === 'string'
          ? rawBody
          : rawBody instanceof Uint8Array
            ? `<binary:${rawBody.byteLength}>`
            : '';

      requests.push({ url, method, headers, bodyText });

      if (url === 'https://oauth2.googleapis.com/token') {
        return makeMockResponse(200, {
          access_token: 'mock-oauth-token-ephemeral-secret-token',
          expires_in: 3599,
          token_type: 'Bearer',
        });
      }

      if (url.endsWith(':upload')) {
        return makeMockResponse(200, {
          name: 'publishers/pub-123/items/abcdefghijklmnopabcdefghijklmnop',
          itemId: 'abcdefghijklmnopabcdefghijklmnop',
          crxVersion: '1.0.0',
          uploadState: 'IN_PROGRESS',
        });
      }

      if (url.endsWith(':fetchStatus')) {
        statusCalls++;
        return makeMockResponse(200, {
          itemId: 'abcdefghijklmnopabcdefghijklmnop',
          lastAsyncUploadState: statusCalls < 2 ? 'IN_PROGRESS' : 'SUCCEEDED',
        });
      }

      if (url.endsWith(':publish')) {
        return makeMockResponse(200, {
          name: 'publishers/pub-123/items/abcdefghijklmnopabcdefghijklmnop',
          itemId: 'abcdefghijklmnopabcdefghijklmnop',
          state: 'PENDING_REVIEW',
        });
      }

      return makeMockResponse(404, { error: 'unexpected route' });
    };

    const result = await publishToChromeWebStore(
      {
        publisherId: 'pub-123',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        zipPath,
        publishMode: 'STAGED_PUBLISH',
        deployPercentage: 50,
        pollIntervalMs: 1,
        maxPollAttempts: 5,
        auth: {
          clientId: 'client-id-xyz',
          clientSecret: 'super-secret-client',
          refreshToken: 'mock-refresh-token-super-secret-refresh',
        },
      },
      {
        fetchImpl: fakeFetch,
        sleepImpl: async () => {},
      }
    );

    expect(result).toEqual({
      itemId: 'abcdefghijklmnopabcdefghijklmnop',
      crxVersion: '1.0.0',
      uploadState: 'SUCCEEDED',
      publishMode: 'STAGED_PUBLISH',
      submissionState: 'PENDING_REVIEW',
    });

    expect(requests).toHaveLength(5);
    expect(requests[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(requests[1]?.url).toBe(
      'https://chromewebstore.googleapis.com/upload/v2/publishers/pub-123/items/abcdefghijklmnopabcdefghijklmnop:upload'
    );
    expect(requests[1]?.headers['Content-Type']).toBe('application/zip');
    expect(requests[2]?.url).toBe(
      'https://chromewebstore.googleapis.com/v2/publishers/pub-123/items/abcdefghijklmnopabcdefghijklmnop:fetchStatus'
    );
    expect(requests[4]?.url).toBe(
      'https://chromewebstore.googleapis.com/v2/publishers/pub-123/items/abcdefghijklmnopabcdefghijklmnop:publish'
    );
    expect(JSON.parse(requests[4]!.bodyText)).toEqual({
      publishType: 'STAGED_PUBLISH',
      deployInfos: [{ deployPercentage: 50 }],
    });
  });

  it('supports UPLOAD_ONLY mode with a direct CWS_ACCESS_TOKEN without calling :publish', async () => {
    const calledUrls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      calledUrls.push(url);
      return makeMockResponse(200, {
        itemId: 'abcdefghijklmnopabcdefghijklmnop',
        crxVersion: '1.0.0',
        uploadState: 'SUCCEEDED',
      });
    };

    const result = await publishToChromeWebStore(
      {
        publisherId: 'pub-123',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        zipPath,
        publishMode: 'UPLOAD_ONLY',
        auth: { accessToken: 'mock-oauth-token-direct-token' },
      },
      { fetchImpl: fakeFetch }
    );

    expect(calledUrls).toEqual([
      'https://chromewebstore.googleapis.com/upload/v2/publishers/pub-123/items/abcdefghijklmnopabcdefghijklmnop:upload',
    ]);
    expect(result.submissionState).toBe('UPLOADED_DRAFT');
  });

  it('fails clearly on FAILED uploadState, rejects unsafe resource IDs, and redacts secrets from errors', async () => {
    await expect(
      publishToChromeWebStore(
        {
          publisherId: '../bad',
          extensionId: 'abcdefghijklmnopabcdefghijklmnop',
          zipPath,
          publishMode: 'DEFAULT_PUBLISH',
          auth: { accessToken: 'mock-oauth-token-secret' },
        },
        { fetchImpl: async () => makeMockResponse(200, {}) }
      )
    ).rejects.toThrow(/Invalid CWS_PUBLISHER_ID/);

    const failingFetch: typeof fetch = async () =>
      makeMockResponse(401, {
        error: 'invalid token mock-oauth-token-ultra-sensitive-token',
      });

    await expect(
      publishToChromeWebStore(
        {
          publisherId: 'pub-123',
          extensionId: 'abcdefghijklmnopabcdefghijklmnop',
          zipPath,
          publishMode: 'DEFAULT_PUBLISH',
          auth: { accessToken: 'mock-oauth-token-ultra-sensitive-token' },
        },
        { fetchImpl: failingFetch }
      )
    ).rejects.toThrow(/\[REDACTED\]/);

    expect(
      redactSecrets('Bearer mock-oauth-token-abc123 {"refresh_token":"mock-refresh-token-secret"}', ['mock-refresh-token-secret'])
    ).toBe('Bearer [REDACTED] {"refresh_token":"[REDACTED]"}');
  });

  it('parses CLI flags and environment variables via resolvePublishConfigFromEnvAndArgs and fails fast when tokens or IDs are missing', () => {
    const cfg = resolvePublishConfigFromEnvAndArgs(
      ['--upload-only', '--zip=/tmp/custom.zip'],
      {
        CWS_PUBLISHER_ID: 'pub-999',
        CWS_EXTENSION_ID: 'abcdefghijklmnopabcdefghijklmnop',
        CWS_ACCESS_TOKEN: 'tok',
      }
    );
    expect(cfg.publishMode).toBe('UPLOAD_ONLY');
    expect(cfg.zipPath).toBe('/tmp/custom.zip');
    expect(cfg.publisherId).toBe('pub-999');

    expect(() => resolvePublishConfigFromEnvAndArgs([], {})).toThrow(
      /Missing required Chrome Web Store environment variable\(s\): CWS_PUBLISHER_ID, CWS_EXTENSION_ID, CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN/
    );

    expect(() =>
      resolvePublishConfigFromEnvAndArgs([], {
        CWS_PUBLISHER_ID: 'pub-999',
        CWS_EXTENSION_ID: 'abcdefghijklmnopabcdefghijklmnop',
        CWS_CLIENT_ID: 'cid',
      })
    ).toThrow(/CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN/);
  });
});
