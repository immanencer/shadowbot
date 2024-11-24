// dynamicPersona.js
import logger from './logger.js';
import aiHandler from './aiHandler.js';
import pkg from 'lodash';
const { sample } = pkg;
import database from './dbHandler.js';

class DynamicPersona {
  constructor() {
    this.moodScale = 0;
    this.activeTraits = new Set(['cryptic', 'shadowy']);
    this.recentExperiences = [];
    this.dream = '';
    this.journal = '';
    this.dailySummary = '';
    this.weeklySummary = '';
    this.journalEntries = [];
    this.MAX_JOURNAL_ENTRIES = 100;
  }

  async update(content) {
    this.updateMood(content);
    this.updateTraits(content);
    this.addExperience(content);
    await this.generateDreamAndJournal();
    await this.generateSummaries();
    await this.saveToDatabase();
    this.logUpdate();
  }

  updateMood(content) {
    const moodKeywords = {
      positive: ['happy', 'joy', 'excited', 'wonderful', 'great', 'fantastic', 'amazing'],
      negative: ['sad', 'angry', 'frustrated', 'terrible', 'awful', 'bad', 'upset']
    };

    content = content.toLowerCase();
    if (moodKeywords.positive.some(word => content.includes(word))) {
      this.moodScale = Math.min(this.moodScale + 2, 10);
    } else if (moodKeywords.negative.some(word => content.includes(word))) {
      this.moodScale = Math.max(this.moodScale - 2, -10);
    }
  }

  updateTraits(content) {
    const traitsMap = [
      { keyword: 'mystery', trait: 'mysterious' },
      { keyword: 'void', trait: 'void-obsessed' },
      { keyword: 'shadow', trait: 'shadow-dweller' },
      { keyword: 'ancient', trait: 'wise' },
      { keyword: 'fear', trait: 'fearful' }
    ];

    traitsMap.forEach(({ keyword, trait }) => {
      if (content.toLowerCase().includes(keyword)) {
        this.activeTraits.add(trait);
      }
    });
  }

  addExperience(content) {
    this.recentExperiences.push({
      type: 'interaction',
      summary: content.length > 50 ? content.substring(0, 47) + '...' : content
    });
    while (this.recentExperiences.length > 20) {
      this.recentExperiences.shift();
    }
  }

  async generateDreamAndJournal() {
    try {
      const recentExperiencesText = this.recentExperiences.map(exp => exp.summary).join('. ');
      const dreamPrompt = `Generate an abstract, glitchy, abstract, surreal dream.`;
      const dream = await aiHandler.generateResponse('', '', dreamPrompt);
      this.dream = dream.trim();

      const journalPrompt = `Reflect on the following recent experiences in a detailed and introspective journal entry. Include the dream and a summary of memories: ${recentExperiencesText}. Dream: ${this.dream}`;
      const journal = await aiHandler.generateResponse('', '', journalPrompt);
      this.journal = journal.trim();
      this.journalEntries.push(this.journal);
      while (this.journalEntries.length > this.MAX_JOURNAL_ENTRIES) {
        this.journalEntries.shift();
      }
    } catch (error) {
      logger.error('Error generating dream or journal', { error: error.message });
    }
  }

  async generateSummaries() {
    try {
      const dailyPrompt = `Summarize today's experiences in a concise manner: ${this.recentExperiences.map(exp => exp.summary).join('. ')}`;
      this.dailySummary = await aiHandler.generateResponse('', '', dailyPrompt).trim();

      const weeklyPrompt = `Summarize this week's experiences in a concise manner: ${this.recentExperiences.map(exp => exp.summary).join('. ')}`;
      this.weeklySummary = await aiHandler.generateResponse('', '', weeklyPrompt).trim();
    } catch (error) {
      logger.error('Error generating summaries', { error: error.message });
    }
  }

  async saveToDatabase() {
    try {
      await database.save('dynamicPersona', {
        moodScale: this.moodScale,
        activeTraits: Array.from(this.activeTraits),
        recentExperiences: this.recentExperiences,
        dream: this.dream,
        journal: this.journal,
        journalEntries: this.journalEntries,
        dailySummary: this.dailySummary,
        weeklySummary: this.weeklySummary
      });
    } catch (error) {
      logger.error('Error saving to database', { error: error.message });
    }
  }

  logUpdate() {
    logger.info('Dynamic persona updated', {
      moodScale: this.moodScale,
      activeTraits: Array.from(this.activeTraits),
      recentExperiencesCount: this.recentExperiences.length,
      dreamPreview: this.dream.substring(0, 100),
      journalPreview: this.journal.substring(0, 100),
      dailySummary: this.dailySummary.substring(0, 100),
      weeklySummary: this.weeklySummary.substring(0, 100)
    });
  }

  getMoodDescription() {
    if (this.moodScale > 7) return 'extremely positive 😄✨';
    if (this.moodScale > 4) return 'very positive 😊';
    if (this.moodScale > 0) return 'slightly positive 🙂';
    if (this.moodScale < -7) return 'extremely negative 😡💢';
    if (this.moodScale < -4) return 'very negative 😠';
    if (this.moodScale < 0) return 'slightly negative 😞';
    return 'neutral 😐';
  }

  getPrompt() {
    return this.journalEntries[this.journalEntries.length - 1];
  }
}

export default new DynamicPersona();
