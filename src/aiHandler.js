// aiHandler.js
// A more robust AI handler with improved stability, error handling, and logging.

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

    // System prompt is mainly used for instruction-based completions;
    // for simple prompt completions, we skip it.
    try {
      this.system_prompt = fs.readFileSync('./system_prompt.md', 'utf8');
    } catch (error) {
      logger.warn('System prompt file not found or unreadable.', { error: error.message });
      this.system_prompt = ''; // Fallback to empty string
    }

    // Preemptively update rate limits on instantiation
    this.updateLimits();
  }

  /**
   * Updates the rate limit by fetching key info and model info from the API.
   * Catches and logs any errors, preventing the entire application from crashing.
   */
  async updateLimits() {
    try {
      const [keyInfo, modelInfo] = await Promise.all([
        this.retryFetch(() => this.fetchKeyInfo()),
        this.retryFetch(() => this.fetchModelInfo()),
      ]);

      // Validate keyInfo structure
      if (!keyInfo?.data?.limit || typeof keyInfo.data.limit !== 'number') {
        throw new Error('Invalid keyInfo structure: "limit" not found.');
      }
      if (!keyInfo?.data?.usage || typeof keyInfo.data.usage !== 'number') {
        throw new Error('Invalid keyInfo structure: "usage" not found.');
      }

      // Validate modelInfo structure
      if (!modelInfo?.per_request_limits) {
        throw new Error('Invalid modelInfo structure: "per_request_limits" not found.');
      }

      // Update internal rate limit values
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

  /**
   * Retries a fetchFunction up to maxRetries, waiting delay ms between tries.
   * Throws the last error if all retries fail.
   */
  async retryFetch(fetchFunction, maxRetries = 3, delay = 1000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await fetchFunction();
        return result;
      } catch (error) {
        if (error.message.includes('HTTP 404')) {
          logger.error('Fetch failed: Endpoint not found', { error: error.message });
          throw error;
        }
        if (attempt === maxRetries) {
          logger.error(`Fetch failed after ${maxRetries} attempts`, { error: error.message });
          throw error;
        }
        logger.warn(`Fetch failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`, {
          error: error.message,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Retrieves key info (e.g., usage limits) from the remote API.
   */
  async fetchKeyInfo() {
    const response = await fetch(`${config.OPENAI_API_URI}/auth/key`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
      },
    });
    if (response.status === 404) {
      throw new Error('Key info fetch failed: HTTP 404 - Endpoint not found');
    }
    if (!response.ok) {
      throw new Error(`Key info fetch failed: HTTP ${response.status}`);
    }
    return response.json();
  }

  /**
   * Fetches information about available models, then finds one matching this.model.
   */
  async fetchModelInfo() {
    const response = await fetch(`${config.OPENAI_API_URI}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Model info fetch failed: HTTP ${response.status}`);
    }

    const models = await response.json();
    if (!models?.data) {
      throw new Error('No model data returned from API.');
    }

    const foundModel = models.data.find((m) => m.id === this.model);
    if (!foundModel) {
      throw new Error(`Requested model "${this.model}" not found in model list.`);
    }

    return foundModel;
  }

  rollingMessages = [];

  /**
   * Utility method to format a chat-like array of messages into a single string.
   * For instruct-based prompts, we often reference past messages for context.
   */
  formatGroupChatMessages(messages) {
    return messages
      .map((m) => `${m.name || m.role} said ${m.content}`)
      .join('\n');
  }

  /**
   * Generates a response for instruction-based or chat-like interactions.
   * This is suitable for instruct fine-tuned models.
   */
  async generateResponse(persona, dynamicPersonaPrompt, messageContent) {
    // Enforce the current rate limit
    await this.waitForRateLimit();

    // Build up a combined prompt from system prompt, persona, rolling context, etc.
    const promptText = this.formatGroupChatMessages([
      { channel: 'system', name: 'System', content: this.system_prompt },
      { channel: 'assistant', name: 'Assistant', content: `${persona} ${dynamicPersonaPrompt}` },
      ...this.rollingMessages,
    ]) + messageContent;

    try {
      const completion = await this.retryFetch(() =>
        fetch(`${config.OPENAI_API_URI}/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: this.model,
            prompt: promptText,
            temperature: 0.8,
            top_p: 0.85,
            max_tokens: 280,
            frequency_penalty: 0.3,
            presence_penalty: 0.5,
          }),
        }).then((response) => {
          if (!response.ok) {
            throw new Error(`Chat completion error: HTTP ${response.status}`);
          }
          return response.json();
        })
      );

      const text = completion?.choices?.[0]?.text || '';
      logger.info('AI response generated', {
        prompt: messageContent.substring(0, 50),
        response: text.substring(0, 50),
      });

      // Store the response in a rolling message array for context in subsequent calls
      this.rollingMessages.push({ role: 'assistant', content: text });

      // Decrement credits and update if we used up a multiple of 10
      this.rateLimit.creditsRemaining--;
      if (this.rateLimit.creditsRemaining % 10 === 0) {
        this.updateLimits();
      }

      // Limit the rolling message history to prevent memory overrun
      if (this.rollingMessages.length > 50) {
        this.rollingMessages.splice(0, this.rollingMessages.length - 50);
      }

      return text;
    } catch (error) {
      logger.error('AI chat error', { error: error.message });
      if (error.message.includes('HTTP 402')) {
        logger.error('Out of credits. Please add credits to your account.');
      }
      return '👾 Error generating response';
    }
  }

  /**
   * Generates a completion for plain prompts, suitable for models that are not fine-tuned
   * for instruct/chat. It simply sends a raw prompt to the model.
   */
  async generateCompletion(prompt) {
    // Enforce the current rate limit
    await this.waitForRateLimit();

    try {
      const completion = await this.retryFetch(() =>
        fetch(`${config.OPENAI_API_URI}/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: this.model,
            prompt: prompt,
            temperature: 0.7,
            top_p: 0.8,
            frequency_penalty: 0.5,
            presence_penalty: 0.5,
            max_tokens: 128,
            stop: ['\n\n'],
          }),
        }).then((response) => {
          if (!response.ok) {
            throw new Error(`Completion error: HTTP ${response.status}`);
          }
          return response.json();
        })
      );

      const text = completion?.choices?.[0]?.text || '';
      logger.info('Completion generated', {
        prompt: prompt.substring(0, 50),
        response: text.substring(0, 50),
      });

      this.rateLimit.creditsRemaining--;
      if (this.rateLimit.creditsRemaining % 10 === 0) {
        this.updateLimits();
      }

      return text;
    } catch (error) {
      logger.error('AI completion error', { error: error.message });
      if (error.message.includes('HTTP 402')) {
        logger.error('Out of credits. Please add credits to your account.');
      }
      return '👾 Error generating completion';
    }
  }

  /**
   * Enforces rate limiting by calculating the time since last request
   * and waiting if necessary to avoid exceeding the assigned throughput.
   */
  async waitForRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.rateLimit.lastRequest;
    // Calculate the minimal interval based on how many requests per interval are allowed
    const minInterval = this.rateLimit.interval / Math.max(this.rateLimit.requests, 1);

    if (timeSinceLastRequest < minInterval) {
      const delay = minInterval - timeSinceLastRequest;
      logger.debug(`Rate limiting: waiting for ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    this.rateLimit.lastRequest = Date.now();

    // If no credits remain, log this and return early to avoid unnecessary API calls
    if (this.rateLimit.creditsRemaining !== null && this.rateLimit.creditsRemaining <= 0) {
      logger.warn('Credits have dropped to zero or below; additional calls may fail.');
    }
  }
}

export default new AIHandler();