// aiHandler.js
// Remove: import OpenAI from 'openai';
import { config } from './config.js';
import logger from './logger.js';
import fs from 'fs';

class AIHandler {
  constructor() {

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
    const response = await fetch(config.OPENAI_API_URI + '/auth/key', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  }

  async fetchModelInfo() {
    const response = await fetch(config.OPENAI_API_URI + '/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const models = await response.json();
    return models.data.find(model => model.id === this.model);
  }

  rollingMessages = [];
  
  formatGroupChatMessages(messages) {
    return messages
      .map(m => `${m.name || m.role} said ${m.content}`)
      .join('\n');
  }

  async generateResponse(persona, dynamicPersonaPrompt, messageContent) {
    await this.waitForRateLimit();

    this.rollingMessages.push({ role: 'user', content: messageContent });

    const promptText = this.formatGroupChatMessages([
      { channel: 'system', name: 'System', content: this.system_prompt },
      { channel: 'assistant', name: 'Assistant', content: `CURRENT PERSONA\n${persona}\nDYNAMIC PERSONALITY LOG: ${dynamicPersonaPrompt}` },
      ...this.rollingMessages
    ]);

    try {
      const completion = await this.retryFetch(() =>
        fetch(`${config.OPENAI_API_URI}/completions`, {
          method: 'POST',
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: this.model,
            prompt: promptText,
            temperature: 0.8,
            top_p: 1,
            max_tokens: 512,
          }),
        }).then(response => {
          if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
          return response.json();
        })
      );

      logger.info('AI response generated', { 
        prompt: messageContent.substring(0, 50),
        response: completion.choices[0].text.substring(0, 50)
      });

      this.rollingMessages.push({ role: 'assistant', content: completion.choices[0].text });

      this.rateLimit.creditsRemaining--;
      if (this.rateLimit.creditsRemaining % 10 === 0) {
        this.updateLimits(); // Update limits every 10 requests
      }

      this.rollingMessages.splice(-50);

      return completion.choices[0].text;
    } catch (error) {
      logger.error('AI chat error', { error: error.message });
      if (error.response?.status === 402) {
        logger.error('Out of credits. Please add credits to your account.');
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