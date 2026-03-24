/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { execFile, execSync } from 'child_process';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/**
 * Read a secret from 1Password via the `op` CLI.
 * ref format: op://vault/item/field
 */
function readOpSecret(ref: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Search for `op` in common install locations
    const opPaths = [
      '/opt/homebrew/bin/op',
      '/usr/local/bin/op',
      '/usr/bin/op',
      'op',
    ];
    const tryNext = (i: number) => {
      if (i >= opPaths.length) {
        reject(new Error('op CLI not found'));
        return;
      }
      execFile(
        opPaths[i],
        ['read', '--no-newline', ref],
        (err, stdout, stderr) => {
          if (err) {
            if (i < opPaths.length - 1) tryNext(i + 1);
            else reject(new Error(stderr || err.message));
          } else {
            resolve(stdout);
          }
        },
      );
    };
    tryNext(0);
  });
}

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

/**
 * Keys from data/env/env that containers are allowed to request via /secret.
 * Anthropic auth keys are excluded — containers get those injected automatically.
 */
const ALLOWED_SECRET_KEYS = new Set([
  'OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'BRAVE_BASE_URL',
  'BRAVE_SEARCH_API_KEY',
  'AZURE_OPENAI_URL',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_URL_2',
  'AZURE_OPENAI_API_KEY_2',
  'OPENROUTER_API_URL',
  'OPENROUTER_API_KEY',
  'SILICONFLOW_BASE_URL',
  'SILICONFLOW_API_KEY',
  'SUPABASE_ACCESS_TOKEN',
  'STRIPE_BASE_URL',
  'STRIPE_SECRET',
  'V0_BASE_URL',
  'V0_API_KEY',
  'ALIBABA_CLOUD_BASE_URL',
  'ALIBABA_CLOUD_ACCESS_KEY_ID',
  'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
  'AWS_BASE_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'HOSTINGER_BASE_URL',
  'HOSTINGER_API_KEY',
  'GODADDY_BASE_URL',
  'GODADDY_OTE_URL',
  'GODADDY_API_KEY',
  'GODADDY_API_SECRET',
  'CONTEXT7_TOKEN',
  'PODBEAN_ID',
  'PODBEAN_SECRET',
  'VERCEL_TOKEN',
  'V0_BASE_URL',
  'V0_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'SLACK_BOT_TOKEN',
  'DISCORD_BOT_TOKEN',
]);

/** Try to read a fresh OAuth token from macOS Keychain (Claude Code stores it there). */
function readKeychainToken(): string | null {
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    const creds = JSON.parse(raw);
    const token = creds?.claudeAiOauth?.accessToken;
    const expiresAt = creds?.claudeAiOauth?.expiresAt || 0;
    if (token && expiresAt > Date.now()) {
      logger.info('Fresh OAuth token read from Keychain');
      return token;
    }
    logger.warn('Keychain token expired or missing');
  } catch (e: any) {
    logger.debug({ err: e.message }, 'Could not read Keychain (expected on Linux)');
  }
  return null;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  // Try keychain first, fall back to .env
  const keychainToken = readKeychainToken();
  if (keychainToken) {
    secrets.CLAUDE_CODE_OAUTH_TOKEN = keychainToken;
  }

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  let oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  // Periodically refresh token from keychain (every 30 min)
  if (process.platform === 'darwin') {
    setInterval(() => {
      const fresh = readKeychainToken();
      if (fresh && fresh !== oauthToken) {
        oauthToken = fresh;
        logger.info('OAuth token refreshed from Keychain');
      }
    }, 30 * 60 * 1000);
  }

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // 1Password secret retrieval endpoint
      // Usage: GET /op-read?ref=op://vault/item/field
      if (req.url?.startsWith('/op-read')) {
        const url = new URL(req.url, 'http://localhost');
        const ref = url.searchParams.get('ref');
        if (!ref || !ref.startsWith('op://')) {
          res.writeHead(400);
          res.end('Bad Request: ref must start with op://');
          return;
        }
        readOpSecret(ref)
          .then((value) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(value);
            logger.info({ ref }, '1Password secret served');
          })
          .catch((err) => {
            logger.error({ ref, err }, '1Password read failed');
            res.writeHead(500);
            res.end(`Error: ${err.message}`);
          });
        return;
      }

      // Named secret retrieval from data/env/env
      // Usage: GET /secret?key=OPENAI_API_KEY
      if (req.url?.startsWith('/secret')) {
        const url = new URL(req.url, 'http://localhost');
        const key = url.searchParams.get('key');
        if (!key || !ALLOWED_SECRET_KEYS.has(key)) {
          res.writeHead(403);
          res.end(`Forbidden: key not in allowlist`);
          return;
        }
        const envSecrets = readEnvFile([key]);
        const value = envSecrets[key] || process.env[key] || '';
        if (!value) {
          res.writeHead(404);
          res.end(`Not found: ${key} not set`);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(value);
        logger.info({ key }, 'Secret served to container');
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
