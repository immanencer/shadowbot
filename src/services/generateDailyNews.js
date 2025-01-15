
import { updateSolanaAssets } from './solanaAssets.js';
import { fetchMemory } from './memoryService.js';
import Exa from 'exa-js';

export async function generateDailyNews() {
  const memoryResult = await fetchMemory('solana news');
  const memoryText = memoryResult?.documents?.flat().join('\n') || '';

  let exaResults = '';
  if (process.env.EXA_KEY) {
    try {
      const exa = new Exa(process.env.EXA_KEY);
      const exaResponse = await exa.search({
        query: memoryText,
        type: 'neural',
        useAutoprompt: true,
        numResults: 5
      });
      exaResults = exaResponse?.results
        ?.map((r) => `- ${r.title || 'Untitled'}`)
        .join('\n') || '';
    } catch (error) {
      console.error('Exa search error:', error.message);
    }
  }

  // Update the Solana assets report with a new daily news section
  const priorAssetReport = '...existing Solana Assets Report...';
  const updatedReport = await updateSolanaAssets(priorAssetReport);

  const dailyNews = `
DAILY NEWS:
Memory highlights:
${memoryText}

EXA SEARCH RESULTS:
${exaResults}

UPDATED SOLANA REPORT:
${updatedReport}
`.trim();

  return dailyNews;
}