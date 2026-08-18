import type { GenerationStrategy } from "@/lib/llm/hfClient";

export type ReportSourceKind = "transcription" | "word_note" | "text_note";

export type ReportClarificationQuestion = {
  id: string;
  question: string;
  rationale?: string;
};

export type ReportClarification = {
  needsClarification: boolean;
  summary: string;
  questions: ReportClarificationQuestion[];
};

export type ReportClarificationAnswer = {
  id: string;
  question: string;
  answer: string;
};

export type ReportClarificationGeneration = {
  clarification: ReportClarification;
  rawResponse: string;
  strategy: GenerationStrategy;
};

export function normalizeReportSourceKind(value?: string): ReportSourceKind {
  switch (value?.trim().toLowerCase()) {
    case "word_note":
      return "word_note";
    case "text_note":
      return "text_note";
    default:
      return "transcription";
  }
}

export function buildClarificationSystemPrompt(sourceKind?: ReportSourceKind): string {
  const normalized = normalizeReportSourceKind(sourceKind);
  const sourceDescription =
    normalized === "word_note"
      ? "une prise de note Word très abrégée et potentiellement fragmentaire"
      : normalized === "text_note"
        ? "une note texte potentiellement fragmentaire"
        : "une transcription ASR";

  return [
    "Tu analyses une source avant la rédaction d'un compte rendu professionnel.",
    `La source est ${sourceDescription}.`,
    "Identifie uniquement les informations manquantes qui empêcheraient une rédaction fidèle et exploitable.",
    "Ne demande jamais une information déjà présente, même sous forme abrégée.",
    "Ne complète jamais une abréviation ambiguë et n'invente jamais de fait.",
    "Pose au maximum cinq questions concrètes, courtes et directement répondables par l'utilisateur.",
    "Retourne uniquement un objet JSON valide, sans Markdown ni commentaire autour.",
  ].join("\n");
}

export function buildClarificationUserPrompt(sourceText: string, sourceKind?: ReportSourceKind): string {
  const normalized = normalizeReportSourceKind(sourceKind);
  return [
    'Retourne exactement cette structure:',
    '{"needsClarification":true,"summary":"...","questions":[{"id":"...","question":"...","rationale":"..."}]}',
    "Si aucune information importante ne manque, retourne needsClarification=false et questions=[].",
    "Les questions doivent couvrir en priorité le contexte, les personnes, les décisions, les actions, les échéances ou les objectifs lorsqu'ils sont réellement absents.",
    `Type de source: ${normalized}`,
    "SOURCE:",
    sourceText,
  ].join("\n");
}

export function parseReportClarificationJson(rawResponse: string): ReportClarification {
  let candidate = rawResponse.trim();
  if (candidate.startsWith("```")) {
    candidate = candidate.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("Réponse de clarification JSON invalide.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Réponse de clarification JSON invalide.");
  }

  const record = parsed as {
    summary?: unknown;
    questions?: unknown;
  };
  const questions: ReportClarificationQuestion[] = [];
  const seenIds = new Set<string>();
  if (Array.isArray(record.questions)) {
    for (const item of record.questions) {
      if (!item || typeof item !== "object" || questions.length >= 5) continue;
      const question = item as { id?: unknown; question?: unknown; rationale?: unknown };
      const id = typeof question.id === "string" ? question.id.trim() : "";
      const text = typeof question.question === "string" ? question.question.trim() : "";
      if (!id || !text || seenIds.has(id)) continue;
      seenIds.add(id);
      questions.push({
        id,
        question: text,
        rationale: typeof question.rationale === "string" ? question.rationale.trim() : undefined,
      });
    }
  }

  return {
    needsClarification: questions.length > 0,
    summary: typeof record.summary === "string" ? record.summary.trim() : "",
    questions,
  };
}

export function buildClarifiedSourceText(
  sourceText: string,
  answers: ReportClarificationAnswer[] = []
): string {
  const context = buildClarificationAnswersContext(answers);
  if (!context) return sourceText;
  return `${sourceText}\n\n${context}`;
}

export function buildClarificationAnswersContext(
  answers: ReportClarificationAnswer[] = []
): string {
  const normalizedAnswers = answers
    .map((item) => ({
      id: item.id.trim(),
      question: item.question.trim(),
      answer: item.answer.trim(),
    }))
    .filter((item) => item.answer.length > 0);

  if (!normalizedAnswers.length) return "";

  return [
    "INFORMATIONS COMPLÉMENTAIRES FOURNIES PAR L'UTILISATEUR:",
    ...normalizedAnswers.map(
      (item) => `- ${item.question || item.id}: ${item.answer}`
    ),
    "",
    "Ces informations complètent la source originale. Elles ne doivent pas remplacer ni contredire les éléments explicitement présents dans la source.",
  ].join("\n");
}
