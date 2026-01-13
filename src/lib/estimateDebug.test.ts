import { describe, it } from 'vitest';
import estimateConfidenceFromText, { scoreDetails } from './textConfidence';

const samples = [
  {
    name: 'news-like sample',
    text:
      "Des dizaines de morts selon les chiffres dont on dispose actuellement, plus d'un millier d'arrestations, des menaces américaines et internet coupés dans le pays, Niran est actuellement touché par d'importantes manifestations réclamant notamment un changement de régime, mais alors que se passent-ils sur place et ces manifestations pourrait-elle vraiment me dire",
    duration: 20,
  },
  {
    name: 'short polite',
    text: 'Bonjour, ceci est une courte phrase de test. Nous parlons lentement.',
    duration: 4,
  },
];

describe.runIf(process.env.ESTIMATE_DEBUG === '1')('estimateDebug', () => {
  for (const s of samples) {
    it(s.name, () => {
      const score = estimateConfidenceFromText(s.text, s.duration);
      console.info('ESTIMATE DEBUG', { name: s.name, score, details: scoreDetails(s.text, s.duration) });
    });
  }
});