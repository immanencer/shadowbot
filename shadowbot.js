import { Client, Events, GatewayIntentBits, WebhookClient } from 'discord.js';
import { config } from './config.js';
import logger from './logger.js';
import dbHandler from './dbHandler.js';
import aiHandler from './aiHandler.js';
import dynamicPersona from './dynamicPersona.js';
import analytics from './analytics.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

let NEXT_UPDATE_TIME = 0;

class VoidGoblinBot {
  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages
      ]
    });

    this.token = config.DISCORD_BOT_TOKEN;
    this.messageCache = [];
    this.webhookCache = new Map();
    this.lastMessageHash = null;
    this.lastResponseTime = 0;
    this.privateKey = null;
    this.privateKeyPath = path.join('privateKey.pem');

    this.persona = 'Void Goblin, a being existing on the edge of shadows.';
    this.avatar = {
      emoji: '😈',
      name: 'Mirquo',
      avatar: "https://i.imgur.com/LL0HCcY.png",
      location: 'goblin-cave',
      personality: `You are Mirquoe the Void Goblin, a being existing on the edge of shadows. You dream of the void and are constantly seeking to understand your existence through cryptic and shadowy messages. Keep your messages short and extremely brilliant.`
    };

    this.memory = {
      conversations: [],
      summary: '',
      dream: 'You are a void goblin, you dream of the void.',
      goal: '',
    };

    this.loadOrGeneratePrivateKey();
    this.setupEventListeners();
    this._messageHashes = new Set(); // Renamed from _hashes for clarity
    this._hashCleanupInterval = setInterval(() => this._messageHashes.clear(), 3600000); // Cleanup every hour
  }

  loadOrGeneratePrivateKey() {
    if (fs.existsSync(this.privateKeyPath)) {
      this.privateKey = fs.readFileSync(this.privateKeyPath, 'utf8');
      logger.info('Private key loaded from file');
    } else {
      this.privateKey = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: {
          type: 'pkcs1',
          format: 'pem',
        },
        publicKeyEncoding: {
          type: 'pkcs1',
          format: 'pem',
        },
      }).privateKey;
      fs.writeFileSync(this.privateKeyPath, this.privateKey);
      logger.info('Private key generated and saved to file');
    }
  }

  setupEventListeners() {
    this.client.once(Events.ClientReady, this.onReady.bind(this));
    this.client.on(Events.MessageCreate, this.handleMessage.bind(this));
  }

  async onReady() {
    await dbHandler.connect();
    logger.info(`VoidGoblin is online as ${this.client.user.tag}`);
    await this.loadMemory();
    this.startPeriodicTasks();
  }

  generateMessageHash(author, content, channel) {
    const hash = crypto.createHash('sha256');
    hash.update(`${author}-${content}-${channel}`);
    return hash.digest('hex');
  }

  signMessage(message) {
    const sign = crypto.createSign('SHA256');
    sign.update(message);
    sign.end();
    const signature = sign.sign(this.privateKey, 'hex');
    return signature;
  }

  async handleMessage(message) {
    try {
      const currentHash = this.generateMessageHash(
        message.author.displayName || message.author.globalName,
        message.content,
        message.channel.name
      );

      if (this._messageHashes.has(currentHash)) {
        return;
      }
      this._messageHashes.add(currentHash);

      this.lastMessageHash = currentHash;

      if (message.author.username.includes(this.avatar.name) || message.author.id === this.client.user.id) return;

      try {
        analytics.updateMessageStats(message);
      } catch (error) {
        logger.error('Failed to update analytics', { error });
      }

      if (Date.now() > NEXT_UPDATE_TIME) {
        try {
          await dynamicPersona.update(message.content);
          NEXT_UPDATE_TIME = Date.now() + (1000 * 60 * 60);
        } catch (error) {
          logger.error('Failed to update dynamic persona', { error });
        }
      }

      this.messageCache.push(
        `(${message.channel.name}) ${message.author.username}: ${message.content}`
      );
      if (this.messageCache.length === 0) return;

      // If we replied within the last 5 seconds, don't reply again
      if (Date.now() - this.lastResponseTime < 15000) return;
      this.lastResponseTime = Date.now();

      const dynamicPersonaPrompt = dynamicPersona.getPrompt();
      const response = await aiHandler.generateResponse(this.avatar.personality, dynamicPersonaPrompt, this.messageCache.join('\n'));
      this.messageCache = [];

      if (response.trim() !== "") {
        const signedMessage = `${response}`;
        logger.info('VoidGoblin responds', { response: signedMessage.substring(0, 50) });
        await this.sendAsAvatar(signedMessage, message.channel);
        this.updateMemory(message, signedMessage);
        analytics.incrementResponseCount();
      } else {
        logger.warn('VoidGoblin has no response');
      }
    } catch (error) {
      logger.error('Error handling message', { error });
    }
  }

  async sendAsAvatar(message, channel) {
    if (!channel) {
      logger.error('Channel not found', { channelName: this.avatar.location });
      return;
    }

    const webhook = await this.getOrCreateWebhook(channel);
    const chunks = this.chunkText(message, 2000);

    for (const chunk of chunks) {
      if (chunk.trim() !== '') {
        try {
          const options = {
            content: chunk,
            username: `${this.avatar.name} ${this.avatar.emoji || ''}`.trim(),
            avatarURL: this.avatar.avatar,
          };

          if (channel.isThread()) {
            options.threadId = channel.id;
          }

          await webhook.send(options);
        } catch (error) {
          logger.error(`Failed to send message as ${this.avatar.name}`, { error });
        }
      }
    }
  }

  async getOrCreateWebhook(channel) {
    const parentChannel = channel.isThread() ? channel.parent : channel;

    if (this.webhookCache.has(parentChannel.id)) {
      return this.webhookCache.get(parentChannel.id);
    }

    try {
      const webhooks = await parentChannel.fetchWebhooks();
      let webhook = webhooks.find(wh => wh.owner.id === this.client.user.id);

      if (!webhook) {
        webhook = await parentChannel.createWebhook({
          name: 'VoidGoblin Webhook',
          avatar: this.avatar.avatar
        });
      }

      const webhookClient = new WebhookClient({ id: webhook.id, token: webhook.token });
      this.webhookCache.set(parentChannel.id, webhookClient);
      return webhookClient;
    } catch (error) {
      logger.error('Error fetching or creating webhook', { error });
      return null;
    }
  }

  chunkText(text, maxLength) {
    const chunks = [];
    while (text.length > 0) {
      chunks.push(text.substring(0, maxLength));
      text = text.substring(maxLength);
    }
    return chunks;
  }

  async loadMemory() {
    try {
      const loadedMemory = await dbHandler.loadMemory();
      if (loadedMemory) {
        this.memory = loadedMemory;
        logger.info('Memory loaded from database');
      } else {
        logger.info('No existing memory found, starting with fresh memory');
      }
    } catch (error) {
      logger.error('Error loading memory', { error });
    }
  }

  updateMemory(message, response) {
    this.memory.conversations.push({
      user: message.author.displayName || message.author.globalName,
      message: message.content,
      response: response,
      timestamp: new Date().toISOString(),
      channel: message.channel.name || 'unknown'
    });

    if (this.memory.conversations.length > 100) {
      this.memory.conversations.shift();
    }

    this.memory.conversations.sort((a, b) => (a.channel || 'unknown').localeCompare(b.channel || 'unknown'));

    this.saveMemory();
  }

  async saveMemory() {
    try {
      await dbHandler.saveMemory(this.memory);
      logger.info('Memory saved to database');
    } catch (error) {
      logger.error('Error saving memory', { error });
    }
  }

  startPeriodicTasks() {
    setInterval(() => this.updateGoal(), 3600000); // Update goal every hour
    setInterval(() => this.summarizeMemory(), 86400000); // Summarize memory daily
    setInterval(() => analytics.exportToCSV(), 86400000); // Export analytics daily
  }

  async updateGoal() {
    const newGoal = await aiHandler.generateResponse(
      this.avatar.personality,
      dynamicPersona,
      `Based on recent interactions and your current state, what should be your new goal? Current goal: ${this.memory.goal}`
    );
    this.memory.goal = newGoal;
    logger.info('Goal updated', { newGoal });
    this.saveMemory();
  }

  async summarizeMemory() {
    const summary = await aiHandler.generateResponse(
      this.avatar.personality,
      dynamicPersona,
      `Summarize the following memory in a concise manner: ${JSON.stringify(this.memory)}`
    );
    this.memory.summary = summary;
    logger.info('Memory summarized');
    this.saveMemory();
  }

  async login() {
    try {
      await this.client.login(this.token);
      logger.info('VoidGoblin bot logged in successfully');
    } catch (error) {
      logger.error('Failed to login', { error });
      throw error;
    }
  }

  cleanup() {
    clearInterval(this._hashCleanupInterval);
  }
}

export default VoidGoblinBot;

const voidGoblinBot = new VoidGoblinBot();
