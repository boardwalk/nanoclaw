import fs from "fs";
import os from "os";
import path from "path";

import { Bot } from "grammy";
import {
  ASSISTANT_NAME,
  TELEGRAM_BOT_TOKEN,
  TRIGGER_PATTERN,
  VOICE_TRIGGER_PATTERN,
} from "./config.js";
import {
  getAllRegisteredGroups,
  storeChatMetadata,
  storeMessageDirect,
} from "./db.js";
import { logger } from "./logger.js";
import { isWhisperReady, transcribe } from "./whisper.js";

let bot: Bot | null = null;

/** Store a placeholder message for non-text content (photos, voice, etc.) */
function storeNonTextMessage(ctx: any, placeholder: string): void {
  const chatId = `tg:${ctx.chat.id}`;
  const registeredGroups = getAllRegisteredGroups();
  if (!registeredGroups[chatId]) return;

  const timestamp = new Date(ctx.message.date * 1000).toISOString();
  const senderName =
    ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || "Unknown";
  const caption = ctx.message.caption ? ` ${ctx.message.caption}` : "";

  storeChatMetadata(chatId, timestamp);
  storeMessageDirect({
    id: ctx.message.message_id.toString(),
    chat_jid: chatId,
    sender: ctx.from?.id?.toString() || "",
    sender_name: senderName,
    content: `${placeholder}${caption}`,
    timestamp,
    is_from_me: false,
  });
}

export async function connectTelegram(botToken: string): Promise<void> {
  bot = new Bot(botToken);

  // Command to get chat ID (useful for registration)
  bot.command("chatid", (ctx) => {
    const chatId = ctx.chat.id;
    const chatType = ctx.chat.type;
    const chatName =
      chatType === "private"
        ? ctx.from?.first_name || "Private"
        : (ctx.chat as any).title || "Unknown";

    ctx.reply(
      `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
      { parse_mode: "Markdown" },
    );
  });

  // Command to check bot status
  bot.command("ping", (ctx) => {
    ctx.reply(`${ASSISTANT_NAME} is online.`);
  });

  bot.on("message:text", async (ctx) => {
    // Skip commands
    if (ctx.message.text.startsWith("/")) return;

    const chatId = `tg:${ctx.chat.id}`;
    let content = ctx.message.text;
    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const senderName =
      ctx.from?.first_name ||
      ctx.from?.username ||
      ctx.from?.id.toString() ||
      "Unknown";
    const sender = ctx.from?.id.toString() || "";
    const msgId = ctx.message.message_id.toString();

    // Determine chat name
    const chatName =
      ctx.chat.type === "private"
        ? senderName
        : (ctx.chat as any).title || chatId;

    // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
    // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
    // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
    const botUsername = ctx.me?.username?.toLowerCase();
    if (botUsername) {
      const entities = ctx.message.entities || [];
      const isBotMentioned = entities.some((entity) => {
        if (entity.type === "mention") {
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

    // Store chat metadata for discovery
    storeChatMetadata(chatId, timestamp, chatName);

    // Check if this chat is registered
    const registeredGroups = getAllRegisteredGroups();
    const group = registeredGroups[chatId];

    if (!group) {
      logger.debug(
        { chatId, chatName },
        "Message from unregistered Telegram chat",
      );
      return;
    }

    // Store message — startMessageLoop() will pick it up
    storeMessageDirect({
      id: msgId,
      chat_jid: chatId,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatId, chatName, sender: senderName },
      "Telegram message stored",
    );
  });

  // Handle non-text messages with placeholders so the agent knows something was sent
  bot.on("message:photo", (ctx) => storeNonTextMessage(ctx, "[Photo]"));
  bot.on("message:video", (ctx) => storeNonTextMessage(ctx, "[Video]"));
  bot.on("message:voice", async (ctx) => {
    const chatId = `tg:${ctx.chat.id}`;
    const registeredGroups = getAllRegisteredGroups();
    if (!registeredGroups[chatId]) return;

    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const senderName =
      ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || "Unknown";
    const sender = ctx.from?.id?.toString() || "";
    const msgId = ctx.message.message_id.toString();

    // Fallback to placeholder if Whisper is not available
    if (!isWhisperReady()) {
      storeChatMetadata(chatId, timestamp);
      storeMessageDirect({
        id: msgId,
        chat_jid: chatId,
        sender,
        sender_name: senderName,
        content: "[Voice message]",
        timestamp,
        is_from_me: false,
      });
      return;
    }

    // Show typing indicator while transcribing
    try {
      await bot!.api.sendChatAction(chatId.replace(/^tg:/, ""), "typing");
    } catch { /* ignore typing errors */ }

    const voiceDir = path.join(os.tmpdir(), "nanoclaw-voice");
    const tempFile = path.join(voiceDir, `${msgId}.ogg`);

    try {
      // Download voice file
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const response = await fetch(fileUrl);
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);

      fs.mkdirSync(voiceDir, { recursive: true });
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(tempFile, buffer);

      // Transcribe
      const text = await transcribe(tempFile);

      if (!text) {
        // Empty transcription — store as placeholder
        storeChatMetadata(chatId, timestamp);
        storeMessageDirect({
          id: msgId,
          chat_jid: chatId,
          sender,
          sender_name: senderName,
          content: "[Voice message (empty)]",
          timestamp,
          is_from_me: false,
        });
        return;
      }

      // Check if it matches the voice trigger pattern
      const triggerMatch = text.match(VOICE_TRIGGER_PATTERN);
      if (triggerMatch) {
        // Strip the "Hey Andy" prefix and store as @Andy <remainder>
        const remainder = text.slice(triggerMatch[0].length).trim();
        const content = `@${ASSISTANT_NAME} ${remainder}`;

        storeChatMetadata(chatId, timestamp);
        storeMessageDirect({
          id: msgId,
          chat_jid: chatId,
          sender,
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });

        logger.info(
          { chatId, sender: senderName },
          "Voice message transcribed (trigger match)",
        );
      } else {
        // No trigger — echo transcription to chat only (don't store,
        // so it won't be picked up and sent to Claude)
        await sendTelegramMessage(chatId, text);

        logger.info(
          { chatId, sender: senderName },
          "Voice message transcribed (no trigger, echo only)",
        );
      }
    } catch (err) {
      logger.error({ chatId, err }, "Voice transcription failed");

      // Fallback to placeholder on error
      storeChatMetadata(chatId, timestamp);
      storeMessageDirect({
        id: msgId,
        chat_jid: chatId,
        sender,
        sender_name: senderName,
        content: "[Voice message]",
        timestamp,
        is_from_me: false,
      });
    } finally {
      // Clean up temp file
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch { /* ignore cleanup errors */ }
    }
  });
  bot.on("message:audio", (ctx) => storeNonTextMessage(ctx, "[Audio]"));
  bot.on("message:document", (ctx) => {
    const name = ctx.message.document?.file_name || "file";
    storeNonTextMessage(ctx, `[Document: ${name}]`);
  });
  bot.on("message:sticker", (ctx) => {
    const emoji = ctx.message.sticker?.emoji || "";
    storeNonTextMessage(ctx, `[Sticker ${emoji}]`);
  });
  bot.on("message:location", (ctx) => storeNonTextMessage(ctx, "[Location]"));
  bot.on("message:contact", (ctx) => storeNonTextMessage(ctx, "[Contact]"));

  // Handle errors gracefully
  bot.catch((err) => {
    logger.error({ err: err.message }, "Telegram bot error");
  });

  // Clear any previously registered bot commands
  await bot.api.deleteMyCommands();

  // Start polling
  bot.start({
    onStart: (botInfo) => {
      logger.info(
        { username: botInfo.username, id: botInfo.id },
        "Telegram bot connected",
      );
      console.log(`\n  Telegram bot: @${botInfo.username}`);
      console.log(
        `  Send /chatid to the bot to get a chat's registration ID\n`,
      );
    },
  });
}

export async function sendTelegramMessage(
  chatId: string,
  text: string,
): Promise<void> {
  if (!bot) {
    logger.warn("Telegram bot not initialized");
    return;
  }

  try {
    const numericId = chatId.replace(/^tg:/, "");

    // Telegram has a 4096 character limit per message — split if needed
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await bot.api.sendMessage(numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await bot.api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info({ chatId, length: text.length }, "Telegram message sent");
  } catch (err) {
    logger.error({ chatId, err }, "Failed to send Telegram message");
  }
}

export async function setTelegramTyping(chatId: string): Promise<void> {
  if (!bot) return;
  try {
    const numericId = chatId.replace(/^tg:/, "");
    await bot.api.sendChatAction(numericId, "typing");
  } catch (err) {
    logger.debug({ chatId, err }, "Failed to send Telegram typing indicator");
  }
}

export function isTelegramConnected(): boolean {
  return bot !== null;
}

export function stopTelegram(): void {
  if (bot) {
    bot.stop();
    bot = null;
    logger.info("Telegram bot stopped");
  }
}
