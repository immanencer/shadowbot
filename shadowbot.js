// voidGoblinBot.js
import { Client, Events, GatewayIntentBits, WebhookClient } from 'discord.js';
import { config } from './config.js';
import logger from './logger.js';
import dbHandler from './dbHandler.js';
import aiHandler from './aiHandler.js';
import dynamicPersona from './dynamicPersona.js';
import analytics from './analytics.js';

class ShadowBot {
  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ]
    });

    this.token = config.DISCORD_BOT_TOKEN;
    this.lastProcessed = 0;
    this.debounceTime = 5000;
    this.messageCache = [];
    this.webhookCache = new Map();

    this.persona = 'Void Goblin, a being existing on the edge of shadows.';
    this.avatar = {
      emoji: '😈',
      name: 'Mirquo',
      avatar: "https://i.imgur.com/LL0HCcY.png",
      location: 'goblin-cave',
      personality: `You are Void Goblin, a being existing on the edge of shadows. You dream of the void and are constantly seeking to understand your existence through cryptic and shadowy messages. Keep your messages short and extremely brilliant.`
    };

    this.memory = {
      conversations: [],
      summary: '',
      dream: 'You are a void goblin, you dream of the void.',
      goal: '',
    };

    this.setupEventListeners();
  }

  setupEventListeners() {
    this.client.once(Events.ClientReady, this.onReady.bind(this));
    this.client.on(Events.MessageCreate, this.handleMessage.bind(this));
  }

  async onReady() {
    logger.info(`VoidGoblin is online as ${this.client.user.tag}`);
    await this.loadMemory();
    this.startPeriodicTasks();
  }

  async handleMessage(message) {
    const data = {
      author: message.author.displayName || message.author.globalName,
      content: message.content,
      location: message.channel.name
    };

    logger.info('Message received', {
      author: data.author,
      channel: data.location,
      content: data.content.substring(0, 50)
    });
    
    if (message.author.username.includes(this.avatar.name) || message.author.id === this.client.user.id) return;

    analytics.updateMessageStats(message);
    dynamicPersona.update(message.content);

    this.messageCache.push(`(${data.location}) ${data.author}: ${data.content}`);
    if (!this.debounce()) return;

    if (this.messageCache.length === 0) return;
    const result = await aiHandler.generateResponse(this.avatar.personality, dynamicPersona, this.messageCache.join('\n'));
    this.messageCache = [];

    if (result.trim() !== "") {
      logger.info('VoidGoblin responds', { response: result.substring(0, 50) });
      await this.sendAsAvatar(result, message.channel);
      this.updateMemory(data, result);
      analytics.incrementResponseCount();
    } else {
      logger.warn('VoidGoblin has no response');
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

  debounce() {
    const now = Date.now();
    if (now - this.lastProcessed < this.debounceTime) return false;
    this.lastProcessed = now;
    return true;
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

  updateMemory(data, response) {
    this.memory.conversations.push({
      user: data.author,
      message: data.content,
      response: response,
      timestamp: new Date().toISOString()
    });

    if (this.memory.conversations.length > 100) {
      this.memory.conversations.shift();
    }

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
}

export default ShadowBot;

const shadowBot = new ShadowBot();
shadowBot.login().catch(console.error);
