import type { ReportFormat } from "@/lib/llm/reportSchema";

const COMMON_RULES = [
  "N'invente jamais d'informations absentes de la source.",
  "Si une information est manquante, ambiguë ou incertaine, indique-le explicitement dans `caveats`.",
  "Ne fais aucune interprétation diagnostique supplémentaire.",
  "Le texte source provient d'une transcription ASR et peut contenir des erreurs (reconnaissance, ponctuation, traduction).",
  "Corrige uniquement les erreurs manifestes quand le sens est clair; en cas de doute, conserve l'intention d'origine et signale l'incertitude dans `caveats`.",
  "Respecte strictement le format JSON demandé, sans texte avant/après.",
  "Conserve la langue francaise.",
] as const;

const FORMAT_GUIDELINES: Record<ReportFormat, string> = {
  CRI: "CRI = restitution narrative fidele, tres detaillee, avec une redaction textuelle longue et complete.",
  CRO: "CRO = compte rendu operationnel, axe decisions, actions, priorites et points a executer.",
  CRS: "CRS = synthese ultra concise, uniquement l'essentiel critique en format tres court.",
};

const FORMAT_STYLE_RULES: Record<ReportFormat, readonly string[]> = {
  CRI: [
    "style narratif et textuel: developpe les informations utiles dans des paragraphes complets.",
    "tu peux produire un document long (plusieurs pages) si la source contient assez de matiere.",
    "niveau de detail tres eleve: preserve le contexte, la chronologie, les nuances et les formulations importantes.",
    "privilegie la prose continue; n'utilise des listes que si elles sont necessaires a la clarte.",
    "chaque section doit contenir des paragraphes substantiels (pas de phrases telegraphiques).",
    "reformulation minimale: reste tres proche des mots et du sens de la transcription.",
  ],
  CRO: [
    "style operationnel: privilegie ce qui est actionnable et directement exploitable.",
    "structuree les informations pour execution: decisions, actions, responsables, delais (si presents).",
    "priorise les elements decisifs en debut de section.",
    "supprime le secondaire non utile a la prise de decision.",
  ],
  CRS: [
    "style ultra synthetique: phrases courtes, sans developpement narratif.",
    "ne conserve que les points critiques; elimine tout detail secondaire.",
    "vise un format tres court et immediatement lisible (resume flash).",
    "limite le resultat a 2-3 sections courtes maximum.",
    "dans chaque section, 1 paragraphe bref (1-2 phrases) suffit.",
    "key_points et action_items doivent rester tres courts (3 items max chacun).",
  ],
};

export function buildReportSystemPrompt(): string {
  return [
    "Tu es un redacteur expert des comptes rendus professionnels.",
    "Ta mission: transformer une transcription brute en compte rendu structure selon le format demande.",
    ...COMMON_RULES,
  ].join("\n");
}

export function buildReportUserPrompt(format: ReportFormat, sourceText: string): string {
  return [
    `Format cible: ${format}.`,
    FORMAT_GUIDELINES[format],
    "",
    "Retourne uniquement un JSON valide avec cette structure:",
    `{
  "format": "${format}",
  "title": "...",
  "subtitle": "... (optionnel)",
  "sections": [
    { "heading": "...", "paragraphs": ["...", "..."] }
  ],
  "key_points": ["..."],
  "action_items": ["..."],
  "caveats": ["..."]
}`,
    "",
    "Contraintes de contenu:",
    "- sections: ordre logique clinique, titres clairs.",
    "- key_points: points saillants utiles a la lecture rapide.",
    "- action_items: suites concretes si explicites dans la source.",
    "- caveats: zones d'incertitude / informations absentes.",
    ...FORMAT_STYLE_RULES[format].map((rule) => `- ${rule}`),
    "",
    "SOURCE:",
    sourceText,
  ].join("\n");
}

export function buildLongInputChunkPrompt(
  chunkText: string,
  chunkIndex: number,
  chunkCount: number
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    "Tu es un assistant d'extraction factuelle.",
    "Produis une note factuelle concise, sans invention.",
    "Mentionne explicitement les ambiguïtés.",
    "La source vient d'une transcription ASR: corrige seulement les erreurs evidentes, sans inferer ce qui n'est pas dit.",
  ].join("\n");

  const userPrompt = [
    `Chunk ${chunkIndex + 1}/${chunkCount}.`,
    "Retourne un resume factuel en puces courtes.",
    "Inclure si presents: contexte, faits saillants, chronologie, personnes, actions, points incertains.",
    "",
    "SOURCE CHUNK:",
    chunkText,
  ].join("\n");

  return { systemPrompt, userPrompt };
}

export function buildLongInputConsolidationPrompt(chunkSummaries: string[]): {
  systemPrompt: string;
  userPrompt: string;
} {
  const systemPrompt = [
    "Tu consolides des resumes factuels de transcription.",
    "Ne garde que les informations presentes dans les resumes.",
    "Structure en texte clair, utilisable comme source de redaction.",
    "Considere que la source initiale etait une transcription ASR possiblement bruitee; corrige seulement les erreurs manifestes.",
  ].join("\n");

  const userPrompt = [
    "Consolide les resumes suivants en une source unique, coherent et dedupliquee.",
    "Conserve les formulations importantes sans les deformer.",
    "Termine par une section 'Points de vigilance' listant les zones incertaines.",
    "",
    "RESUMES A CONSOLIDER:",
    chunkSummaries.map((summary, index) => `### Resume ${index + 1}\n${summary}`).join("\n\n"),
  ].join("\n");

  return { systemPrompt, userPrompt };
}

export function buildReportFormatDescription(format: ReportFormat): string {
  return FORMAT_GUIDELINES[format];
}
