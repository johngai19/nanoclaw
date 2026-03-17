import https from 'https';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { textToSpeech } from '../tts.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// ── OpenAI helpers ────────────────────────────────────────────────────────────

/** Download a Telegram file by file_id, return raw Buffer. */
async function downloadTelegramFile(
  token: string,
  fileId: string,
): Promise<Buffer> {
  const metaUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`;
  const filePath = await new Promise<string>((resolve, reject) => {
    https
      .get(metaUrl, (res) => {
        let data = '';
        res.on('data', (c: Buffer) => {
          data += c.toString();
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as {
              ok: boolean;
              result?: { file_path: string };
            };
            if (parsed.ok && parsed.result?.file_path)
              resolve(parsed.result.file_path);
            else reject(new Error(`getFile failed: ${data}`));
          } catch (e) {
            reject(e);
          }
        });
        res.on('error', reject);
      })
      .on('error', reject);
  });

  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  return new Promise<Buffer>((resolve, reject) => {
    https
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

/** Transcribe audio buffer using OpenAI gpt-4o-transcribe. */
async function transcribeAudio(
  apiKey: string,
  audioBuffer: Buffer,
  mimeType = 'audio/ogg',
): Promise<string> {
  const boundary = `----Boundary${Math.random().toString(36).slice(2)}`;
  const CRLF = '\r\n';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="model"${CRLF}${CRLF}gpt-4o-transcribe${CRLF}` +
        `--${boundary}${CRLF}Content-Disposition: form-data; name="language"${CRLF}${CRLF}zh${CRLF}` +
        `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="audio.ogg"${CRLF}Content-Type: ${mimeType}${CRLF}${CRLF}`,
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
        res.on('data', (c: Buffer) => {
          data += c.toString();
        });
        res.on('end', () => {
          try {
            const r = JSON.parse(data) as {
              text?: string;
              error?: { message: string };
            };
            resolve(r.text ?? '[语音转录失败]');
          } catch {
            resolve('[语音转录解析错误]');
          }
        });
      },
    );
    req.on('error', (err) => {
      logger.error({ err }, 'Transcription request error');
      resolve('[转录请求失败]');
    });
    req.write(body);
    req.end();
  });
}

/** Describe an image using OpenAI GPT-4o Vision. */
async function describeImage(
  apiKey: string,
  imageBuffer: Buffer,
): Promise<string> {
  const base64 = imageBuffer.toString('base64');
  const body = JSON.stringify({
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '请简洁描述这张图片的内容（中文，≤100字）。若是截图/代码/文档，重点描述文字内容。',
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${base64}`,
              detail: 'auto',
            },
          },
        ],
      },
    ],
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
        res.on('data', (c: Buffer) => {
          data += c.toString();
        });
        res.on('end', () => {
          try {
            const r = JSON.parse(data) as {
              choices?: Array<{ message: { content: string } }>;
              error?: { message: string };
            };
            const content = r.choices?.[0]?.message?.content;
            resolve(content ? `[图片: ${content}]` : '[图片描述失败]');
          } catch {
            resolve('[图片描述解析错误]');
          }
        });
      },
    );
    req.on('error', (err) => {
      logger.error({ err }, 'Vision request error');
      resolve('[图片请求失败]');
    });
    req.write(body);
    req.end();
  });
}

// ── Channel ───────────────────────────────────────────────────────────────────

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a Telegram message with Markdown, falling back to plain text on error.
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, { ...options, parse_mode: 'Markdown' });
  } catch (err) {
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private openaiApiKey: string;

  /** Per-chat output mode: 'text' | 'voice' | 'both'. Default: 'text'. */
  private chatOutputMode = new Map<string, 'text' | 'voice' | 'both'>();

  constructor(
    botToken: string,
    openaiApiKey: string,
    opts: TelegramChannelOpts,
  ) {
    this.botToken = botToken;
    this.openaiApiKey = openaiApiKey;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: { baseFetchConfig: { agent: https.globalAgent, compress: true } },
    });

    // /chatid — get registration ID
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as { title?: string }).title || 'Unknown';
      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // /ping — health check
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // /voice — pure voice output
    this.bot.command('voice', (ctx) => {
      const jid = `tg:${ctx.chat.id}`;
      this.chatOutputMode.set(jid, 'voice');
      ctx.reply('🔊 纯语音模式。/text 切换文字，/both 切换语音+文字。');
      logger.info({ jid }, 'Output mode: voice');
    });

    // /text — pure text output (default)
    this.bot.command('text', (ctx) => {
      const jid = `tg:${ctx.chat.id}`;
      this.chatOutputMode.set(jid, 'text');
      ctx.reply('💬 纯文字模式。/voice 切换语音，/both 切换语音+文字。');
      logger.info({ jid }, 'Output mode: text');
    });

    // /both — voice + text output simultaneously
    this.bot.command('both', (ctx) => {
      const jid = `tg:${ctx.chat.id}`;
      this.chatOutputMode.set(jid, 'both');
      ctx.reply('🔊💬 语音+文字模式。/voice 纯语音，/text 纯文字。');
      logger.info({ jid }, 'Output mode: both');
    });

    const TELEGRAM_BOT_COMMANDS = new Set([
      'chatid',
      'ping',
      'voice',
      'text',
      'both',
    ]);

    // ── Text messages ─────────────────────────────────────────────────────────
    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as { title?: string }).title || chatJid;

      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // ── Non-text helper ───────────────────────────────────────────────────────
    const storeNonText = (ctx: any, placeholder: string): void => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    // ── Voice input → transcribe ──────────────────────────────────────────────
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const apiKey = this.openaiApiKey;
      if (!apiKey) {
        storeNonText(ctx, '[Voice message — OPENAI_API_KEY not set]');
        return;
      }

      try {
        const buf = await downloadTelegramFile(
          this.botToken,
          ctx.message.voice.file_id,
        );
        const transcript = await transcribeAudio(apiKey, buf, 'audio/ogg');
        storeNonText(ctx, `[Voice transcript: ${transcript}]`);
        logger.info({ chatJid, chars: transcript.length }, 'Voice transcribed');
      } catch (err) {
        logger.error({ err }, 'Voice transcription failed');
        storeNonText(ctx, '[Voice message — transcription error]');
      }
    });

    // ── Photo input → describe ────────────────────────────────────────────────
    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const apiKey = this.openaiApiKey;
      if (!apiKey) {
        storeNonText(ctx, '[Photo — OPENAI_API_KEY not set]');
        return;
      }

      try {
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1];
        const buf = await downloadTelegramFile(this.botToken, largest.file_id);
        const description = await describeImage(apiKey, buf);
        storeNonText(ctx, description);
        logger.info({ chatJid }, 'Photo described via Vision');
      } catch (err) {
        logger.error({ err }, 'Image vision failed');
        storeNonText(ctx, '[Photo — vision error]');
      }
    });

    // ── Other non-text types ──────────────────────────────────────────────────
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  /** Send TTS voice note to a Telegram chat. */
  private async sendVoiceNote(numericId: string, text: string): Promise<void> {
    try {
      const audioBuffer = await textToSpeech(text, this.openaiApiKey);
      if (!audioBuffer) return;
      const { InputFile } = await import('grammy');
      const file = new InputFile(audioBuffer, 'response.ogg');
      try {
        await this.bot!.api.sendVoice(numericId, file);
      } catch (voiceErr: any) {
        if (voiceErr?.description?.includes('VOICE_MESSAGES_FORBIDDEN')) {
          const audioFile = new InputFile(audioBuffer, 'reply.ogg');
          await this.bot!.api.sendAudio(numericId, audioFile, {
            title: 'Reply',
            performer: ASSISTANT_NAME,
          });
        } else throw voiceErr;
      }
      logger.info(
        { jid: `tg:${numericId}`, length: text.length },
        'Telegram voice message sent (TTS)',
      );
    } catch (err) {
      logger.warn({ err }, 'TTS failed, falling back to text');
    }
  }

  /**
   * Send a message to a JID.
   * Respects per-chat output mode: text | voice | both.
   */
  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    const numericId = jid.replace(/^tg:/, '');
    const mode = this.chatOutputMode.get(jid) ?? 'text';

    // Voice output (voice or both)
    if (mode === 'voice' || mode === 'both') {
      await this.sendVoiceNote(numericId, text);
      if (mode === 'voice') return; // skip text
    }

    // Text output (text or both)
    try {
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN', 'OPENAI_API_KEY']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  const openaiApiKey =
    process.env.OPENAI_API_KEY || envVars.OPENAI_API_KEY || '';
  if (!openaiApiKey) {
    logger.warn(
      'Telegram: OPENAI_API_KEY not set — voice transcription and TTS will be unavailable',
    );
  }
  return new TelegramChannel(token, openaiApiKey, opts);
});
