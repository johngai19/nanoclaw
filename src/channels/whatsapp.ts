import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import https from 'https';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import { readEnvFile } from '../env.js';
import { textToSpeech } from '../tts.js';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  STORE_DIR,
} from '../config.js';
import { getLastGroupSync, setLastGroupSync, updateChatName } from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Transcribe audio buffer via OpenAI gpt-4o-transcribe */
async function transcribeAudioWA(
  apiKey: string,
  audioBuffer: Buffer,
): Promise<string> {
  const boundary = `----Boundary${Math.random().toString(36).slice(2)}`;
  const CRLF = '\r\n';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="model"${CRLF}${CRLF}gpt-4o-transcribe${CRLF}` +
        `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="audio.ogg"${CRLF}Content-Type: audio/ogg${CRLF}${CRLF}`,
    ),
    audioBuffer,
    Buffer.from(`${CRLF}--${boundary}--${CRLF}`),
  ]);
  return new Promise<string>((resolve) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          try {
            const r = JSON.parse(data) as { text?: string };
            resolve(r.text ?? '[语音转录失败]');
          } catch { resolve('[语音转录解析错误]'); }
        });
      },
    );
    req.on('error', () => resolve('[转录请求失败]'));
    req.write(body);
    req.end();
  });
}

/** Describe image via OpenAI GPT-4o Vision */
async function describeImageWA(
  apiKey: string,
  imageBuffer: Buffer,
): Promise<string> {
  const base64 = imageBuffer.toString('base64');
  const body = JSON.stringify({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: [
      { type: 'text', text: '请简洁描述这张图片的内容（中文，≤100字）。若是截图/代码/文档，重点描述文字内容。' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'auto' } },
    ]}],
    max_tokens: 300,
  });
  return new Promise<string>((resolve) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          try {
            const r = JSON.parse(data) as { choices?: Array<{ message: { content: string } }> };
            const content = r.choices?.[0]?.message?.content;
            resolve(content ? `[图片: ${content}]` : '[图片描述失败]');
          } catch { resolve('[图片描述解析错误]'); }
        });
      },
    );
    req.on('error', () => resolve('[图片请求失败]'));
    req.write(body);
    req.end();
  });
}

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;

  private opts: WhatsAppChannelOpts;
  /** Per-JID output mode: 'text' | 'voice' | 'both'. Default: 'text'. */
  private chatOutputMode = new Map<string, 'text' | 'voice' | 'both'>();

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      logger.warn(
        { err },
        'Failed to fetch latest WA Web version, using default',
      );
      return { version: undefined };
    });
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
        );
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info(
          {
            reason,
            shouldReconnect,
            queuedMessages: this.outgoingQueue.length,
          },
          'Connection closed',
        );

        if (shouldReconnect) {
          logger.info('Reconnecting...');
          this.connectInternal().catch((err) => {
            logger.error({ err }, 'Failed to reconnect, retrying in 5s');
            setTimeout(() => {
              this.connectInternal().catch((err2) => {
                logger.error({ err: err2 }, 'Reconnection retry failed');
              });
            }, 5000);
          });
        } else {
          logger.info('Logged out. Run /setup to re-authenticate.');
          process.exit(0);
        }
      } else if (connection === 'open') {
        this.connected = true;
        logger.info('Connected to WhatsApp');

        // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
        this.sock.sendPresenceUpdate('available').catch((err) => {
          logger.warn({ err }, 'Failed to send presence update');
        });

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          // Unwrap container types (viewOnceMessageV2, ephemeralMessage,
          // editedMessage, etc.) so that conversation, extendedTextMessage,
          // imageMessage, etc. are accessible at the top level.
          const normalized = normalizeMessageContent(msg.message);
          if (!normalized) continue;
          const rawJid = msg.key.remoteJid;
          if (!rawJid || rawJid === 'status@broadcast') continue;

          // Translate LID JID to phone JID if applicable
          const chatJid = await this.translateJid(rawJid);

          const timestamp = new Date(
            Number(msg.messageTimestamp) * 1000,
          ).toISOString();

          // Always notify about chat metadata for group discovery
          const isGroup = chatJid.endsWith('@g.us');
          this.opts.onChatMetadata(
            chatJid,
            timestamp,
            undefined,
            'whatsapp',
            isGroup,
          );

          // Only deliver full message for registered groups
          const groups = this.opts.registeredGroups();
          if (groups[chatJid]) {
            let content =
              normalized.conversation ||
              normalized.extendedTextMessage?.text ||
              normalized.imageMessage?.caption ||
              normalized.videoMessage?.caption ||
              '';

            // ── Voice / audio message → transcribe ───────────────────────
            const isAudio = !!(normalized.audioMessage || (normalized as any).pttMessage);
            if (!content && isAudio) {
              const envVars = readEnvFile(['OPENAI_API_KEY']);
              const apiKey = envVars.OPENAI_API_KEY || '';
              if (apiKey) {
                try {
                  const buf = await downloadMediaMessage(msg, 'buffer', {}) as Buffer;
                  const transcript = await transcribeAudioWA(apiKey, buf);
                  content = `[Voice transcript: ${transcript}]`;
                  logger.info({ chatJid, chars: transcript.length }, 'WA voice transcribed');
                } catch (err) {
                  logger.error({ err }, 'WA voice transcription failed');
                  content = '[Voice message — transcription error]';
                }
              } else {
                content = '[Voice message — OPENAI_API_KEY not set]';
              }
            }

            // ── Image message → describe ──────────────────────────────────
            if (!content && normalized.imageMessage) {
              const envVars = readEnvFile(['OPENAI_API_KEY']);
              const apiKey = envVars.OPENAI_API_KEY || '';
              if (apiKey) {
                try {
                  const buf = await downloadMediaMessage(msg, 'buffer', {}) as Buffer;
                  content = await describeImageWA(apiKey, buf);
                  logger.info({ chatJid }, 'WA image described');
                } catch (err) {
                  logger.error({ err }, 'WA image vision failed');
                  content = '[Photo — vision error]';
                }
              } else {
                content = '[Photo — OPENAI_API_KEY not set]';
              }
            }

            // Skip protocol messages with no text content (encryption keys, read receipts, etc.)
            if (!content) continue;

            // ── Voice mode commands (/voice /text /both) ──────────────────
            const trimmed = content.trim().toLowerCase();
            if (trimmed === '/voice') {
              this.chatOutputMode.set(chatJid, 'voice');
              await this.sock.sendMessage(chatJid, {
                text: `${ASSISTANT_NAME}: 🔊 纯语音模式。/text 切换文字，/both 切换语音+文字。`,
              });
              logger.info({ chatJid }, 'WA output mode: voice');
              continue;
            }
            if (trimmed === '/text') {
              this.chatOutputMode.set(chatJid, 'text');
              await this.sock.sendMessage(chatJid, {
                text: `${ASSISTANT_NAME}: 💬 纯文字模式。/voice 切换语音，/both 切换语音+文字。`,
              });
              logger.info({ chatJid }, 'WA output mode: text');
              continue;
            }
            if (trimmed === '/both') {
              this.chatOutputMode.set(chatJid, 'both');
              await this.sock.sendMessage(chatJid, {
                text: `${ASSISTANT_NAME}: 🔊💬 语音+文字模式。/voice 纯语音，/text 纯文字。`,
              });
              logger.info({ chatJid }, 'WA output mode: both');
              continue;
            }

            const sender = msg.key.participant || msg.key.remoteJid || '';
            const senderName = msg.pushName || sender.split('@')[0];

            const fromMe = msg.key.fromMe || false;
            // Detect bot messages: with own number, fromMe is reliable
            // since only the bot sends from that number.
            // With shared number, bot messages carry the assistant name prefix
            // (even in DMs/self-chat) so we check for that.
            const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
              ? fromMe
              : content.startsWith(`${ASSISTANT_NAME}:`);

            this.opts.onMessage(chatJid, {
              id: msg.key.id || '',
              chat_jid: chatJid,
              sender,
              sender_name: senderName,
              content,
              timestamp,
              is_from_me: fromMe,
              is_bot_message: isBotMessage,
            });
          }
        } catch (err) {
          logger.error(
            { err, remoteJid: msg.key?.remoteJid },
            'Error processing incoming message',
          );
        }
      }
    });
  }

  /** Send a TTS voice note via WhatsApp. */
  private async sendVoiceNote(jid: string, text: string): Promise<void> {
    const env = readEnvFile(['OPENAI_API_KEY']);
    const openaiKey = env.OPENAI_API_KEY || '';
    try {
      const audioBuffer = await textToSpeech(text, openaiKey);
      if (!audioBuffer) {
        logger.warn({ jid }, 'WA TTS returned null');
        return;
      }
      await this.sock.sendMessage(jid, {
        audio: audioBuffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
      });
      logger.info({ jid, length: text.length }, 'WA voice note sent (TTS)');
    } catch (err) {
      logger.warn({ jid, err }, 'WA TTS failed');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const mode = this.chatOutputMode.get(jid) ?? 'text';

    // Voice output (voice or both)
    if (mode === 'voice' || mode === 'both') {
      if (this.connected) {
        await this.sendVoiceNote(jid, text);
      }
      if (mode === 'voice') return; // skip text
    }

    // Text output (text or both)
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      return;
    }
    try {
      await this.sock.sendMessage(jid, { text: prefixed });
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  async syncGroups(force: boolean): Promise<void> {
    return this.syncGroupMetadata(force);
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug(
        { lidJid: jid, phoneJid: cached },
        'Translated LID to phone JID (cached)',
      );
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info(
          { lidJid: jid, phoneJid },
          'Translated LID to phone JID (signalRepository)',
        );
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Send directly — queued items are already prefixed by sendMessage
        await this.sock.sendMessage(item.jid, { text: item.text });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('whatsapp', (opts: ChannelOpts) => new WhatsAppChannel(opts));
