// aiHandler.js
import OpenAI from 'openai';
import { config } from './config.js';
import logger from './logger.js';
import fs from 'fs';

class AIHandler {
  constructor() {
    this.openai = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: config.OPENROUTER_API_KEY,
      defaultHeaders: {
        "HTTP-Referer": config.YOUR_SITE_URL,
        "X-Title": config.YOUR_SITE_NAME,
      }
    });
    this.model = config.MODEL || 'meta-llama/llama-3.1-405b-instruct';
    this.rateLimit = {
      requests: 1,
      interval: 1000, // 1 second in milliseconds
      lastRequest: 0,
      creditsRemaining: null,
      maxTokens: null,
    };
    this.updateLimits();
    
    this.system_prompt = fs.readFileSync('./system_prompt.md', 'utf8');
   
  }

  async updateLimits() {
    try {
      const [keyInfo, modelInfo] = await Promise.all([
        this.retryFetch(() => this.fetchKeyInfo()),
        this.retryFetch(() => this.fetchModelInfo()),
      ]);

      this.rateLimit.creditsRemaining = keyInfo.data.limit - keyInfo.data.usage;
      this.rateLimit.requests = Math.min(this.rateLimit.creditsRemaining, 200);
      this.rateLimit.maxTokens = modelInfo.per_request_limits;

      logger.info('Rate limits updated', {
        creditsRemaining: this.rateLimit.creditsRemaining,
        requestsPerSecond: this.rateLimit.requests,
        maxTokens: this.rateLimit.maxTokens,
      });
    } catch (error) {
      logger.error('Failed to update rate limits', { error: error.message });
    }
  }

  async retryFetch(fetchFunction, maxRetries = 3, delay = 1000) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fetchFunction();
      } catch (error) {
        if (i === maxRetries - 1) throw error;
        logger.warn(`Fetch failed, retrying (${i + 1}/${maxRetries})`, { error: error.message });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  async fetchKeyInfo() {
    const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  }

  async fetchModelInfo() {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const models = await response.json();
    return models.data.find(model => model.id === this.model);
  }

  rollingMessages = [];
  
  async generateResponse(persona, dynamicPersonaPrompt, messageContent) {
    await this.waitForRateLimit();

    this.rollingMessages.push({role: 'user', content: messageContent});

    const messages = [
      { role: "system", content: this.system_prompt },
      { role: "assistant", content: `CURRENT PERSONA\n${persona}\nDYNAMIC PERSONALITY LOG: ${dynamicPersonaPrompt}` },
      ...this.rollingMessages
    ];

    try {
      const completion = await this.retryFetch(() => 
        this.openai.chat.completions.create({
          model: this.model,
          messages: messages,
          temperature: 0.8,
          top_p: 1,
          repetition_penalty: 1,
          max_tokens: 512,
          stop: "\n"
        })
      );

      logger.info('AI response generated', { 
        prompt: messageContent.substring(0, 50),
        response: completion.choices[0].message.content.substring(0, 50)
      });

      this.rollingMessages.push({role: 'assistant', content: completion.choices[0].message.content})

      this.rateLimit.creditsRemaining--;
      if (this.rateLimit.creditsRemaining % 10 === 0) {
        this.updateLimits(); // Update limits every 10 requests
      }

      this.rollingMessages.splice(-50);

      return completion.choices[0].message.content;
    } catch (error) {
      logger.error('AI chat error', { error: error.message });
      if (error.response?.status === 402) {
        logger.error('Out of credits. Please add credits to your OpenRouter account.');
      }
      return '👾 Error generating response';
    }
  }

  async waitForRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.rateLimit.lastRequest;
    const minInterval = this.rateLimit.interval / this.rateLimit.requests;

    if (timeSinceLastRequest < minInterval) {
      const delay = minInterval - timeSinceLastRequest;
      logger.debug(`Rate limiting: waiting for ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    this.rateLimit.lastRequest = Date.now();
  }
}

export default new AIHandler();