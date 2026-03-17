/**
 * Multi-provider Text-to-Speech
 *
 * Priority:
 *   English → Azure TTS (Anna / AnnaNeural)
 *   Chinese → SiliconFlow IndexTTS-2 (anna)
 *   Fallback → OpenAI TTS (shimmer / anna)
 *
 * Environment variables read from data/env/env via readEnvFile.
 */
import https from 'https';
import http from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/** True if the text is primarily Chinese (>20% CJK characters). */
export function isChinese(text: string): boolean {
  if (!text) return false;
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}]/gu) || []).length;
  return cjk / text.length > 0.2;
}

/** HTTP(S) POST returning a raw Buffer, or null on failure. */
function postRaw(
  urlStr: string,
  headers: Record<string, string | number>,
  body: Buffer | string,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      resolve(null);
      return;
    }
    const isHttps = url.protocol === 'https:';
    const bodyBuf = typeof body === 'string' ? Buffer.from(body) : body;
    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: { ...headers, 'content-length': bodyBuf.length },
    };
    const req = (isHttps ? https : http).request(opts, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          logger.warn({ status: res.statusCode, body: Buffer.concat(chunks).toString().slice(0, 200) }, 'TTS non-2xx');
          resolve(null);
        });
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', () => resolve(null));
    });
    req.on('error', (err) => { logger.warn({ err }, 'TTS request error'); resolve(null); });
    req.write(bodyBuf);
    req.end();
  });
}

/** Azure OpenAI TTS — English, voice AnnaNeural (or configurable). */
async function azureTTS(text: string): Promise<Buffer | null> {
  const env = readEnvFile(['AZURE_OPENAI_URL', 'AZURE_OPENAI_API_KEY']);
  const baseUrl = env.AZURE_OPENAI_URL?.replace(/\/$/, '');
  const apiKey = env.AZURE_OPENAI_API_KEY;
  if (!baseUrl || !apiKey) return null;

  // Try Azure Speech Service SSML endpoint if the URL looks like a speech endpoint
  // Otherwise use Azure OpenAI TTS compatible endpoint
  const isSpeechUrl = baseUrl.includes('.speech.microsoft.com') || baseUrl.includes('.tts.speech');
  if (isSpeechUrl) {
    const ssml = `<speak version='1.0' xml:lang='en-US'><voice name='en-US-AnnaNeural'>${text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] ?? c))}</voice></speak>`;
    return postRaw(`${baseUrl}`, {
      'Ocp-Apim-Subscription-Key': apiKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'ogg-16khz-16bit-mono-opus',
    }, ssml);
  }

  // Azure OpenAI TTS deployment
  const body = JSON.stringify({ model: 'tts-1', voice: 'nova', input: text, response_format: 'opus' });
  const url = `${baseUrl}/openai/deployments/tts/audio/speech?api-version=2024-05-01-preview`;
  return postRaw(url, {
    'api-key': apiKey,
    'Content-Type': 'application/json',
  }, body);
}

/** SiliconFlow IndexTTS-2 — Chinese, anna voice. */
async function siliconflowTTS(text: string): Promise<Buffer | null> {
  const env = readEnvFile(['SILICONFLOW_BASE_URL', 'SILICONFLOW_API_KEY']);
  const baseUrl = env.SILICONFLOW_BASE_URL?.replace(/\/$/, '');
  const apiKey = env.SILICONFLOW_API_KEY;
  if (!baseUrl || !apiKey) return null;

  const body = JSON.stringify({
    model: 'FunAudioLLM/IndexTTS-2',
    voice: 'anna',
    input: text,
    response_format: 'opus',
  });
  return postRaw(`${baseUrl}/v1/audio/speech`, {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }, body);
}

/** OpenAI TTS fallback — shimmer voice. */
async function openaiTTS(text: string, apiKey: string): Promise<Buffer | null> {
  const body = JSON.stringify({ model: 'tts-1', voice: 'shimmer', input: text, response_format: 'opus' });
  return postRaw('https://api.openai.com/v1/audio/speech', {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }, body);
}

/**
 * Convert text to speech using the appropriate provider.
 *   Chinese  → SiliconFlow IndexTTS-2 (anna) → fallback OpenAI
 *   English  → Azure TTS (Anna)              → fallback OpenAI
 *
 * Returns OGG/Opus buffer, or null on total failure.
 */
export async function textToSpeech(text: string, openaiApiKey: string): Promise<Buffer | null> {
  const truncated = text.length > 4000 ? text.slice(0, 4000) + '…' : text;
  const chinese = isChinese(truncated);

  logger.debug({ chinese, len: truncated.length }, 'TTS dispatch');

  let result: Buffer | null = null;
  if (chinese) {
    result = await siliconflowTTS(truncated);
    if (result) { logger.info({ len: truncated.length }, 'TTS: SiliconFlow'); return result; }
    logger.warn('SiliconFlow TTS failed, falling back to OpenAI');
  } else {
    result = await azureTTS(truncated);
    if (result) { logger.info({ len: truncated.length }, 'TTS: Azure'); return result; }
    logger.warn('Azure TTS failed, falling back to OpenAI');
  }

  result = await openaiTTS(truncated, openaiApiKey);
  if (result) { logger.info({ len: truncated.length }, 'TTS: OpenAI fallback'); }
  return result;
}
