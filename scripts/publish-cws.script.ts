import * as fs from 'fs';
import * as path from 'path';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ZIP_PATH = path.resolve(PROJECT_ROOT, 'release/gmail-attention.zip');

const OAUTH2_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CWS_UPLOAD_BASE_URL = 'https://chromewebstore.googleapis.com/upload/v2';
const CWS_API_BASE_URL = 'https://chromewebstore.googleapis.com/v2';

const SAFE_RESOURCE_ID_REGEX = /^[a-zA-Z0-9_-]{3,128}$/;

export type CwsPublishModeType = 'DEFAULT_PUBLISH' | 'STAGED_PUBLISH' | 'UPLOAD_ONLY';

export interface CwsAuthConfigInterface {
  readonly accessToken?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly refreshToken?: string;
}

export interface PublishCwsConfigInterface {
  readonly publisherId: string;
  readonly extensionId: string;
  readonly zipPath: string;
  readonly publishMode: CwsPublishModeType;
  readonly deployPercentage?: number;
  readonly skipReview?: boolean;
  readonly pollIntervalMs?: number;
  readonly maxPollAttempts?: number;
  readonly auth: CwsAuthConfigInterface;
}

export interface PublishCwsDependenciesInterface {
  readonly fetchImpl?: typeof fetch;
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

export interface CwsUploadResponseInterface {
  readonly name?: string;
  readonly itemId?: string;
  readonly crxVersion?: string;
  readonly uploadState?: string;
}

export interface CwsFetchStatusResponseInterface {
  readonly name?: string;
  readonly itemId?: string;
  readonly lastAsyncUploadState?: string;
  readonly takenDown?: boolean;
  readonly warned?: boolean;
}

export interface CwsPublishResponseInterface {
  readonly name?: string;
  readonly itemId?: string;
  readonly state?: string;
}

export interface PublishCwsResultInterface {
  readonly itemId: string;
  readonly crxVersion: string;
  readonly uploadState: string;
  readonly publishMode: CwsPublishModeType;
  readonly submissionState: string;
}

/**
 * Redacts OAuth tokens and secrets from diagnostic text so credentials never leak to CI logs.
 */
export function redactSecrets(rawText: string, secrets: readonly (string | undefined)[]): string {
  let sanitized = rawText;
  for (const secret of secrets) {
    if (secret && secret.trim().length >= 4) {
      sanitized = sanitized.split(secret.trim()).join('[REDACTED]');
    }
  }
  sanitized = sanitized.replace(
    /("(?:access_token|refresh_token|client_secret)"\s*:\s*")[^"]*(")/gi,
    '$1[REDACTED]$2'
  );
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
  return sanitized;
}

function validateResourceIdentifier(label: string, value: string): string {
  const trimmed = value.trim();
  if (!SAFE_RESOURCE_ID_REGEX.test(trimmed)) {
    throw new Error(`Invalid ${label}: expected alphanumeric/hyphen/underscore identifier.`);
  }
  return trimmed;
}

function validateZipBuffer(zipPath: string): Buffer {
  const resolved = path.resolve(zipPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Extension ZIP archive not found at ${resolved}. Run 'npm run package' first.`
    );
  }
  const buf = fs.readFileSync(resolved);
  const pkSignature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  if (buf.length < 22 || !buf.subarray(0, 4).equals(pkSignature)) {
    throw new Error(`Invalid ZIP archive header in ${resolved}`);
  }
  return buf;
}

/**
 * Resolves a short-lived Chrome Web Store OAuth2 Bearer token either from `auth.accessToken`
 * or by exchanging `clientId` + `clientSecret` + `refreshToken` against Google's OAuth2 endpoint.
 */
export async function resolveChromeWebStoreAccessToken(
  auth: CwsAuthConfigInterface,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  if (auth.accessToken && auth.accessToken.trim().length > 0) {
    return auth.accessToken.trim();
  }

  const clientId = auth.clientId?.trim() ?? '';
  const clientSecret = auth.clientSecret?.trim() ?? '';
  const refreshToken = auth.refreshToken?.trim() ?? '';

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Missing Chrome Web Store credentials. Provide either CWS_ACCESS_TOKEN or all of CWS_CLIENT_ID, CWS_CLIENT_SECRET, and CWS_REFRESH_TOKEN.'
    );
  }

  const formBody = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetchImpl(OAUTH2_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formBody.toString(),
  });

  const rawBody = await response.text();
  if (!response.ok) {
    const safeError = redactSecrets(rawBody, [clientSecret, refreshToken]);
    throw new Error(
      `OAuth2 token exchange failed with HTTP ${response.status}: ${safeError.slice(0, 400)}`
    );
  }

  const parsed = JSON.parse(rawBody) as { access_token?: string };
  if (!parsed.access_token || typeof parsed.access_token !== 'string') {
    throw new Error('OAuth2 token endpoint response did not include an access_token.');
  }

  return parsed.access_token.trim();
}

function isUploadInProgress(state: string | undefined): boolean {
  return state === 'IN_PROGRESS' || state === 'UPLOAD_IN_PROGRESS';
}

/**
 * Uploads the packaged Manifest V3 `.zip` via Chrome Web Store API v2 (`:upload`),
 * polls `:fetchStatus` if async validation is in progress, and submits for review (`:publish`).
 */
export async function publishToChromeWebStore(
  config: PublishCwsConfigInterface,
  deps: PublishCwsDependenciesInterface = {}
): Promise<PublishCwsResultInterface> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleepImpl =
    deps.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const publisherId = validateResourceIdentifier('CWS_PUBLISHER_ID', config.publisherId);
  const extensionId = validateResourceIdentifier('CWS_EXTENSION_ID', config.extensionId);

  if (
    config.deployPercentage !== undefined &&
    (!Number.isInteger(config.deployPercentage) ||
      config.deployPercentage < 0 ||
      config.deployPercentage > 100)
  ) {
    throw new Error(
      `Invalid deployPercentage "${config.deployPercentage}": expected integer between 0 and 100.`
    );
  }

  const zipBuffer = validateZipBuffer(config.zipPath);
  const accessToken = await resolveChromeWebStoreAccessToken(config.auth, fetchImpl);
  const secretsToRedact = [
    accessToken,
    config.auth.accessToken,
    config.auth.clientSecret,
    config.auth.refreshToken,
  ];

  const itemPath = `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}`;

  // 1. Upload ZIP package to CWS API v2
  const uploadUrl = `${CWS_UPLOAD_BASE_URL}/${itemPath}:upload`;
  const uploadResponse = await fetchImpl(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/zip',
    },
    body: new Uint8Array(zipBuffer),
  });

  const rawUploadText = await uploadResponse.text();
  if (!uploadResponse.ok) {
    throw new Error(
      `Chrome Web Store :upload failed with HTTP ${uploadResponse.status}: ${redactSecrets(
        rawUploadText,
        secretsToRedact
      ).slice(0, 600)}`
    );
  }

  const uploadJson = JSON.parse(rawUploadText) as CwsUploadResponseInterface;
  let finalUploadState = uploadJson.uploadState ?? 'UNKNOWN';
  const crxVersion = uploadJson.crxVersion ?? 'unknown';

  // 2. Poll :fetchStatus while async package scan is IN_PROGRESS
  if (isUploadInProgress(finalUploadState)) {
    const pollIntervalMs = config.pollIntervalMs ?? 3_000;
    const maxPollAttempts = config.maxPollAttempts ?? 30;
    const statusUrl = `${CWS_API_BASE_URL}/${itemPath}:fetchStatus`;

    for (let attempt = 1; attempt <= maxPollAttempts; attempt++) {
      await sleepImpl(pollIntervalMs);
      const statusResponse = await fetchImpl(statusUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const rawStatusText = await statusResponse.text();
      if (!statusResponse.ok) {
        throw new Error(
          `Chrome Web Store :fetchStatus failed with HTTP ${statusResponse.status}: ${redactSecrets(
            rawStatusText,
            secretsToRedact
          ).slice(0, 600)}`
        );
      }

      const statusJson = JSON.parse(rawStatusText) as CwsFetchStatusResponseInterface;
      finalUploadState = statusJson.lastAsyncUploadState ?? 'UNKNOWN';
      if (!isUploadInProgress(finalUploadState)) {
        break;
      }
    }
  }

  if (finalUploadState !== 'SUCCEEDED') {
    throw new Error(
      `Chrome Web Store package upload did not succeed (final uploadState: ${finalUploadState}).`
    );
  }

  // 3. Optionally stop after upload without submitting for review
  if (config.publishMode === 'UPLOAD_ONLY') {
    return {
      itemId: uploadJson.itemId ?? extensionId,
      crxVersion,
      uploadState: finalUploadState,
      publishMode: config.publishMode,
      submissionState: 'UPLOADED_DRAFT',
    };
  }

  // 4. Submit uploaded revision for publishing via CWS API v2 :publish
  const publishUrl = `${CWS_API_BASE_URL}/${itemPath}:publish`;
  const publishPayload: Record<string, unknown> = {
    publishType: config.publishMode,
  };
  if (config.deployPercentage !== undefined) {
    publishPayload['deployInfos'] = [{ deployPercentage: config.deployPercentage }];
  }
  if (config.skipReview === true) {
    publishPayload['skipReview'] = true;
  }

  const publishResponse = await fetchImpl(publishUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(publishPayload),
  });

  const rawPublishText = await publishResponse.text();
  if (!publishResponse.ok) {
    throw new Error(
      `Chrome Web Store :publish failed with HTTP ${publishResponse.status}: ${redactSecrets(
        rawPublishText,
        secretsToRedact
      ).slice(0, 600)}`
    );
  }

  const publishJson = JSON.parse(rawPublishText) as CwsPublishResponseInterface;
  return {
    itemId: publishJson.itemId ?? uploadJson.itemId ?? extensionId,
    crxVersion,
    uploadState: finalUploadState,
    publishMode: config.publishMode,
    submissionState: publishJson.state ?? 'SUBMITTED',
  };
}

export function resolvePublishConfigFromEnvAndArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): PublishCwsConfigInterface {
  let zipPath = env['CWS_ZIP_PATH']?.trim() || DEFAULT_ZIP_PATH;
  let publishModeRaw = (env['CWS_PUBLISH_MODE']?.trim() || 'DEFAULT_PUBLISH').toUpperCase();
  let deployPercentageRaw = env['CWS_DEPLOY_PERCENTAGE']?.trim();
  let skipReview = env['CWS_SKIP_REVIEW']?.trim().toLowerCase() === 'true';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--upload-only') {
      publishModeRaw = 'UPLOAD_ONLY';
    } else if (arg === '--skip-review') {
      skipReview = true;
    } else if (arg === '--zip' && argv[i + 1]) {
      zipPath = argv[++i]!;
    } else if (arg.startsWith('--zip=')) {
      zipPath = arg.slice('--zip='.length);
    } else if (arg === '--publish-type' && argv[i + 1]) {
      publishModeRaw = argv[++i]!.toUpperCase();
    } else if (arg.startsWith('--publish-type=')) {
      publishModeRaw = arg.slice('--publish-type='.length).toUpperCase();
    } else if (arg === '--deploy-percentage' && argv[i + 1]) {
      deployPercentageRaw = argv[++i]!;
    } else if (arg.startsWith('--deploy-percentage=')) {
      deployPercentageRaw = arg.slice('--deploy-percentage='.length);
    }
  }

  if (
    publishModeRaw !== 'DEFAULT_PUBLISH' &&
    publishModeRaw !== 'STAGED_PUBLISH' &&
    publishModeRaw !== 'UPLOAD_ONLY'
  ) {
    throw new Error(
      `Unsupported CWS publish mode "${publishModeRaw}". Expected DEFAULT_PUBLISH, STAGED_PUBLISH, or UPLOAD_ONLY.`
    );
  }

  const publisherId = env['CWS_PUBLISHER_ID']?.trim() ?? '';
  const extensionId = env['CWS_EXTENSION_ID']?.trim() ?? '';
  const accessToken = env['CWS_ACCESS_TOKEN']?.trim() || undefined;
  const clientId = env['CWS_CLIENT_ID']?.trim() || undefined;
  const clientSecret = env['CWS_CLIENT_SECRET']?.trim() || undefined;
  const refreshToken = env['CWS_REFRESH_TOKEN']?.trim() || undefined;

  const missingVars: string[] = [];
  if (!publisherId) {
    missingVars.push('CWS_PUBLISHER_ID');
  }
  if (!extensionId) {
    missingVars.push('CWS_EXTENSION_ID');
  }
  if (!accessToken) {
    if (!clientId) {
      missingVars.push('CWS_CLIENT_ID');
    }
    if (!clientSecret) {
      missingVars.push('CWS_CLIENT_SECRET');
    }
    if (!refreshToken) {
      missingVars.push('CWS_REFRESH_TOKEN');
    }
  }

  if (missingVars.length > 0) {
    throw new Error(
      `Missing required Chrome Web Store environment variable(s): ${missingVars.join(', ')} (provide CWS_PUBLISHER_ID, CWS_EXTENSION_ID, and either CWS_ACCESS_TOKEN or CWS_CLIENT_ID + CWS_CLIENT_SECRET + CWS_REFRESH_TOKEN).`
    );
  }

  const deployPercentage =
    deployPercentageRaw !== undefined && deployPercentageRaw.length > 0
      ? Number(deployPercentageRaw)
      : undefined;

  return {
    publisherId,
    extensionId,
    zipPath,
    publishMode: publishModeRaw,
    deployPercentage,
    skipReview,
    auth: {
      accessToken,
      clientId,
      clientSecret,
      refreshToken,
    },
  };
}

async function main(): Promise<void> {
  const config = resolvePublishConfigFromEnvAndArgs(process.argv.slice(2));
  const result = await publishToChromeWebStore(config);
  process.stdout.write(
    `Chrome Web Store v2 submission succeeded for item ${result.itemId}:\n` +
      `  crxVersion:      ${result.crxVersion}\n` +
      `  uploadState:     ${result.uploadState}\n` +
      `  publishMode:     ${result.publishMode}\n` +
      `  submissionState: ${result.submissionState}\n`
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const singleLine = message.replace(/\r?\n/g, ' ');
    process.stdout.write(`::error title=Chrome Web Store Publish Failed::${singleLine}\n`);
    process.stderr.write(`Chrome Web Store publish failed: ${message}\n`);
    process.exitCode = 1;
  });
}
