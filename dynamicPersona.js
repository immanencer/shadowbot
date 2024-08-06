// dynamicPersona.js
import logger from './logger.js';

class DynamicPersona {
  constructor() {
    this.moodScale = 0;
    this.activeTraits = new Set(['cryptic', 'shadowy']);
    this.recentExperiences = [];
  }

  update(content) {
    this.updateMood(content);
    this.updateTraits(content);
    this.addExperience(content);
    this.logUpdate();
  }

  updateMood(content) {
    const moodKeywords = {
      positive: ['happy', 'joy', 'excited', 'wonderful'],
      negative: ['sad', 'angry', 'frustrated', 'terrible']
    };

    content = content.toLowerCase();
    if (moodKeywords.positive.some(word => content.includes(word))) {
      this.moodScale = Math.min(this.moodScale + 1, 10);
    } else if (moodKeywords.negative.some(word => content.includes(word))) {
      this.moodScale = Math.max(this.moodScale - 1, -10);
    }
  }

  updateTraits(content) {
    if (content.toLowerCase().includes('mystery')) this.activeTraits.add('mysterious');
    if (content.toLowerCase().includes('void')) this.activeTraits.add('void-obsessed');
  }

  addExperience(content) {
    this.recentExperiences.push({
      type: 'interaction',
      summary: content.substring(0, 50)
    });
    if (this.recentExperiences.length > 10) {
      this.recentExperiences.shift();
    }
  }

  logUpdate() {
    logger.debug('Dynamic persona updated', {
      moodScale: this.moodScale,
      activeTraits: Array.from(this.activeTraits),
      recentExperiencesCount: this.recentExperiences.length
    });
  }

  getMoodDescription() {
    if (this.moodScale > 5) return 'very positive';
    if (this.moodScale > 0) return 'slightly positive';
    if (this.moodScale < -5) return 'very negative';
    if (this.moodScale < 0) return 'slightly negative';
    return 'neutral';
  }

  getPrompt() {
    return `
      Current mood: ${this.getMoodDescription()}
      Active traits: ${Array.from(this.activeTraits).join(', ')}
      Recent experiences: ${this.recentExperiences.map(exp => exp.summary).join('. ')}
    `;
  }
}

export default new DynamicPersona();