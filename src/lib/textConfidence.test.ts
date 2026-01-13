import { describe, it, expect } from 'vitest';
import { langScore, repetitionScore, estimateConfidenceFromText, lengthScore, fluencyScore, formatScore } from './textConfidence';

describe('textConfidence', () => {
  it('langScore higher for French text', () => {
    const fr = 'Bonjour je m\'appelle Émilie et je parle français.';
    const en = 'Hello my name is Emily and I speak English.';
    expect(langScore(fr)).toBeGreaterThan(langScore(en));
  });

  it('repetitionScore penalises repeated n-grams', () => {
    const repeated = 'oui oui oui oui oui oui oui';
    const normal = 'oui bonjour comment allez-vous aujourd\'hui';
    expect(repetitionScore(repeated)).toBeLessThan(repetitionScore(normal));
  });

  it('estimateConfidenceFromText gives decent score for normal French sentence', () => {
    const text = 'Bonjour, ceci est une courte phrase de test. Nous parlons lentement.';
    const score = estimateConfidenceFromText(text, 4);
    expect(score).toBeGreaterThan(0.4);
  });

  it('is more tolerant for a longer news-like French sentence', () => {
    const sample = "Des dizaines de morts selon les chiffres dont on dispose actuellement, plus d'un millier d'arrestations, des menaces américaines et internet coupés dans le pays, Niran est actuellement touché par d'importantes manifestations réclamant notamment un changement de régime, mais alors que se passent-ils sur place et ces manifestations pourrait-elle vraiment me dire";
    const score = estimateConfidenceFromText(sample, 20);
    // Debug: print component scores
    console.info('DEBUG sample scores', {
      lang: langScore(sample),
      fluency: fluencyScore(sample),
      repetition: repetitionScore(sample),
      format: formatScore(sample),
      length: lengthScore(sample, 20),
      combined: score,
    });
    // Expect tolerant estimator to give ~75% confidence for this news-like text
    expect(score).toBeGreaterThan(0.749);
  });

  it('lengthScore decreases when words per second unrealistic', () => {
    const text = 'un '.repeat(120).trim(); // 120 words
    // short duration -> high wps -> low score
    expect(lengthScore(text, 10)).toBeLessThan(0.3);
    // long duration -> low wps -> low score too
    expect(lengthScore(text, 200)).toBeLessThan(0.6);
  });
});