import logger from "@/lib/logger";
import { buildReportFormatLabel } from "@/lib/llm/reportPrompts";
import {
  normalizeLlmReportChunkRatio,
  normalizeLlmReportWorkflowTextMaxTokens,
} from "@/lib/storage";
import {
  buildReportDetailLevelLabel,
  computeReportDetailTargetWordCount,
  type ReportDetailLevel,
} from "@/lib/llm/reportDetail";
import type { ReportFormat, ReportJson } from "@/lib/llm/reportSchema";

export interface WorkflowTextGeneratorParams {
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
  responseMode: "json" | "text";
}

export type WorkflowTextGenerator = (params: WorkflowTextGeneratorParams) => Promise<string>;

export interface WorkflowStageEmitter {
  (stage: string, data?: Record<string, unknown>): void;
}

export interface GenerateCloudMultiPassReportParams {
  format: ReportFormat;
  modelId: string;
  sourceText: string;
  temperature: number;
  maxTokens: number;
  detailLevel: Exclude<ReportDetailLevel, "standard">;
  chunkRatio?: number;
  maxSubpartsPerPart?: number;
  workflowTextMaxTokens?: number;
  fallbackPlanSourceText?: string;
  generateText: WorkflowTextGenerator;
  emitStage?: WorkflowStageEmitter;
}

export interface GenerateCloudMultiPassReportResult {
  report: ReportJson;
  rawResponse: string;
  strategy: "chatCompletion";
  pipelinePasses: number;
}

interface WorkflowPlan {
  format: ReportFormat;
  title: string;
  subtitle?: string;
  parts: WorkflowPlanPart[];
}

interface WorkflowPlanPart {
  heading: string;
  focus: string;
  subparts?: WorkflowPlanSubpart[];
}

interface WorkflowPlanSubpart {
  heading: string;
  focus: string;
}

interface WorkflowSubpartState {
  heading: string;
  focus: string;
  fragments: string[];
}

interface WorkflowPartState {
  heading: string;
  focus: string;
  fragments: string[];
  subparts: WorkflowSubpartState[];
  sectionText: string;
}

interface WorkflowExpansionTarget {
  mode: "new_part" | "new_subpart" | "expand_part" | "expand_subpart";
  partIndex?: number;
  subpartIndex?: number;
  heading: string;
  focus: string;
  rationale?: string;
  priority?: number;
}

interface WorkflowExpansionAnalysis {
  needs_more: boolean;
  summary?: string;
  targets: WorkflowExpansionTarget[];
}

interface WorkflowMetadata {
  title: string;
  subtitle?: string;
  key_points?: string[];
  action_items?: string[];
  caveats?: string[];
}

const WORKFLOW_CHUNK_RATIO_DEFAULT = 0.5;
const WORKFLOW_MAX_SUBPARTS_PER_PART_DEFAULT = 4;
const WORKFLOW_MAX_SUBPARTS_PER_PART_CAP = 8;
const WORKFLOW_MAX_EXPANSION_PASSES = 5;
const WORKFLOW_JSON_MAX_TOKENS = 2048;

export function resolveWorkflowChunkWordCount(sourceWordCount: number, chunkRatio = WORKFLOW_CHUNK_RATIO_DEFAULT): number {
  const ratio = normalizeLlmReportChunkRatio(chunkRatio, WORKFLOW_CHUNK_RATIO_DEFAULT);
  return Math.max(1, Math.floor(sourceWordCount * ratio));
}

function normalizeWorkflowMaxSubpartsPerPart(
  value: number | undefined,
  fallback = WORKFLOW_MAX_SUBPARTS_PER_PART_DEFAULT
): number {
  const normalizedValue = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(WORKFLOW_MAX_SUBPARTS_PER_PART_CAP, Math.round(normalizedValue)));
}

export async function generateCloudMultiPassReport(
  params: GenerateCloudMultiPassReportParams
): Promise<GenerateCloudMultiPassReportResult> {
  const sourceText = params.sourceText.trim();
  if (!sourceText) {
    throw new Error("Source vide pour la generation du compte rendu.");
  }

  const sourceWordCount = countWords(sourceText);
  const targetWordCount = computeReportDetailTargetWordCount(params.format, params.detailLevel, sourceWordCount);
  const maxSubpartsPerPart = normalizeWorkflowMaxSubpartsPerPart(params.maxSubpartsPerPart);
  const chunkWordLimit = resolveWorkflowChunkWordCount(sourceWordCount, params.chunkRatio);
  const workflowTextMaxTokens = normalizeLlmReportWorkflowTextMaxTokens(params.workflowTextMaxTokens);
  const chunks = splitTextIntoWordChunks(sourceText, chunkWordLimit);
  const fallbackPlanSourceText = params.fallbackPlanSourceText?.trim() || sourceText;

  logger.debug("[llm-api][workflow] run start", {
    format: params.format,
    detailLevel: params.detailLevel,
    modelId: params.modelId,
    sourceWordCount,
    chunkCount: chunks.length,
    chunkWordLimit,
    maxSubpartsPerPart,
    workflowTextMaxTokens,
    targetWordCount,
  });
  emitStage(params.emitStage, "workflow_start", {
    format: params.format,
    detailLevel: params.detailLevel,
    sourceWordCount,
    chunkCount: chunks.length,
    chunkWordLimit,
    maxSubpartsPerPart,
    workflowTextMaxTokens,
    targetWordCount,
  });

  const plan = await buildWorkflowPlan(
    params,
    sourceText,
    fallbackPlanSourceText,
    targetWordCount,
    maxSubpartsPerPart
  );
  logger.debug("[llm-api][workflow] plan resolved", {
    format: params.format,
    detailLevel: params.detailLevel,
    partCount: plan.parts.length,
    title: plan.title,
  });
  emitStage(params.emitStage, "workflow_plan_done", {
    format: params.format,
    detailLevel: params.detailLevel,
    partCount: plan.parts.length,
    hasSubtitle: Boolean(plan.subtitle),
    title: plan.title,
  });

  const state = await buildInitialState(params, plan, chunks);
  let pipelinePasses = 1;
  let report = buildReportJsonFromState(params.format, plan, state);
  let reportWordCount = countWords(renderReportForWordCount(report));

  logger.debug("[llm-api][workflow] initial report assembled", {
    format: params.format,
    detailLevel: params.detailLevel,
    pipelinePasses,
    reportWordCount,
    targetWordCount,
  });
  emitStage(params.emitStage, "workflow_section_assembled", {
    format: params.format,
    detailLevel: params.detailLevel,
    pipelinePasses,
    reportWordCount,
    targetWordCount,
  });

  while (reportWordCount < targetWordCount && pipelinePasses <= WORKFLOW_MAX_EXPANSION_PASSES) {
    const expansionPass = pipelinePasses;
    logger.debug("[llm-api][workflow] expansion needed", {
      format: params.format,
      detailLevel: params.detailLevel,
      expansionPass,
      reportWordCount,
      targetWordCount,
    });
    emitStage(params.emitStage, "workflow_expansion_analysis_start", {
      format: params.format,
      detailLevel: params.detailLevel,
      expansionPass,
      reportWordCount,
      targetWordCount,
    });

    const analysis = await analyzeExpansion(
      params,
      plan,
      state,
      sourceText,
      fallbackPlanSourceText,
      expansionPass
    );

    logger.debug("[llm-api][workflow] expansion analysis done", {
      format: params.format,
      detailLevel: params.detailLevel,
      expansionPass,
      needs_more: analysis.needs_more,
      targetCount: analysis.targets.length,
      summary: analysis.summary ?? null,
    });
    emitStage(params.emitStage, "workflow_expansion_analysis_done", {
      format: params.format,
      detailLevel: params.detailLevel,
      expansionPass,
      needs_more: analysis.needs_more,
      targetCount: analysis.targets.length,
      summary: analysis.summary ?? null,
    });

    const targets = normalizeExpansionTargets(analysis, plan, state, reportWordCount, targetWordCount, expansionPass);
    if (!targets.length) {
      logger.warn("[llm-api][workflow] no expansion target returned, injecting fallback target", {
        format: params.format,
        detailLevel: params.detailLevel,
        expansionPass,
      });
      targets.push(buildFallbackExpansionTarget(plan, state, expansionPass));
    }

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index]!;
      await applyExpansionTargets(params, plan, state, chunks, target, expansionPass, index + 1, targets.length);
    }

    report = buildReportJsonFromState(params.format, plan, state);
    reportWordCount = countWords(renderReportForWordCount(report));
    pipelinePasses += 1;

    logger.debug("[llm-api][workflow] expansion pass completed", {
      format: params.format,
      detailLevel: params.detailLevel,
      expansionPass,
      pipelinePasses,
      reportWordCount,
      targetWordCount,
    });
    emitStage(params.emitStage, "workflow_expansion_pass_done", {
      format: params.format,
      detailLevel: params.detailLevel,
      expansionPass,
      pipelinePasses,
      reportWordCount,
      targetWordCount,
    });
  }

  if (reportWordCount < targetWordCount) {
    logger.warn("[llm-api][workflow] expansion saturation reached", {
      format: params.format,
      detailLevel: params.detailLevel,
      pipelinePasses,
      reportWordCount,
      targetWordCount,
    });
    emitStage(params.emitStage, "workflow_expansion_saturation", {
      format: params.format,
      detailLevel: params.detailLevel,
      pipelinePasses,
      reportWordCount,
      targetWordCount,
      finalFallback: true,
    });
  }

  emitStage(params.emitStage, "workflow_metadata_start", {
    format: params.format,
    detailLevel: params.detailLevel,
    pipelinePasses,
    reportWordCount: countWords(renderReportForWordCount(report)),
    sourceWordCount,
  });

  const metadata = await buildFinalMetadata(params, plan, report, sourceText, fallbackPlanSourceText);
  report = {
    ...report,
    title: metadata.title || report.title,
    subtitle: metadata.subtitle ?? report.subtitle,
    key_points: normalizeStringArray(metadata.key_points),
    action_items: normalizeStringArray(metadata.action_items),
    caveats: normalizeStringArray(metadata.caveats),
  };

  const rawResponse = JSON.stringify(report, null, 2);
  emitStage(params.emitStage, "workflow_metadata_done", {
    format: params.format,
    detailLevel: params.detailLevel,
    pipelinePasses,
    title: report.title,
    hasSubtitle: Boolean(report.subtitle),
    keyPointCount: report.key_points?.length ?? 0,
    actionItemCount: report.action_items?.length ?? 0,
    caveatCount: report.caveats?.length ?? 0,
  });

  logger.debug("[llm-api][workflow] run done", {
    format: params.format,
    detailLevel: params.detailLevel,
    pipelinePasses,
    sourceWordCount,
    reportWordCount: countWords(renderReportForWordCount(report)),
  });
  emitStage(params.emitStage, "workflow_done", {
    format: params.format,
    detailLevel: params.detailLevel,
    pipelinePasses,
    sourceWordCount,
    reportWordCount: countWords(renderReportForWordCount(report)),
  });

  return {
    report,
    rawResponse,
    strategy: "chatCompletion",
    pipelinePasses,
  };
}

async function buildWorkflowPlan(
  params: GenerateCloudMultiPassReportParams,
  sourceText: string,
  fallbackPlanSourceText: string,
  targetWordCount: number,
  maxSubpartsPerPart: number
): Promise<WorkflowPlan> {
  const planPrompt = buildPlanPrompt(params.format, params.detailLevel, sourceText, targetWordCount, maxSubpartsPerPart);
  const fallbackPrompt = buildPlanPrompt(
    params.format,
    params.detailLevel,
    fallbackPlanSourceText,
    targetWordCount,
    maxSubpartsPerPart
  );

  emitStage(params.emitStage, "workflow_plan_start", {
    format: params.format,
    detailLevel: params.detailLevel,
    sourceWordCount: countWords(sourceText),
    targetWordCount,
  });
  logger.debug("[llm-api][workflow] plan request start", {
    format: params.format,
    detailLevel: params.detailLevel,
    sourceWordCount: countWords(sourceText),
    targetWordCount,
  });

  const rawPlan = await attemptJsonPrompt(params, planPrompt, fallbackPrompt, "plan", () =>
    buildFallbackPlan(params.format, params.detailLevel, targetWordCount, maxSubpartsPerPart)
  );
  const plan = normalizePlan(rawPlan, params.format, params.detailLevel, targetWordCount, maxSubpartsPerPart);

  logger.debug("[llm-api][workflow] plan parsed", {
    format: params.format,
    detailLevel: params.detailLevel,
    title: plan.title,
    partCount: plan.parts.length,
    partHeadings: plan.parts.map((part) => part.heading),
  });
  emitStage(params.emitStage, "workflow_plan_parsed", {
    format: params.format,
    detailLevel: params.detailLevel,
    title: plan.title,
    partCount: plan.parts.length,
    partTotal: plan.parts.length,
  });

  return plan;
}

async function buildInitialState(
  params: GenerateCloudMultiPassReportParams,
  plan: WorkflowPlan,
  chunks: WordChunk[]
): Promise<WorkflowPartState[]> {
  const state: WorkflowPartState[] = [];

  for (let partIndex = 0; partIndex < plan.parts.length; partIndex += 1) {
    const planPart = plan.parts[partIndex]!;
    logger.debug("[llm-api][workflow] part extraction start", {
      format: params.format,
      detailLevel: params.detailLevel,
      partIndex: partIndex + 1,
      partTotal: plan.parts.length,
      partHeading: planPart.heading,
      subpartCount: planPart.subparts?.length ?? 0,
    });
    emitStage(params.emitStage, "workflow_part_extract_start", {
      format: params.format,
      detailLevel: params.detailLevel,
      partIndex: partIndex + 1,
      partTotal: plan.parts.length,
      partHeading: planPart.heading,
      subpartCount: planPart.subparts?.length ?? 0,
    });

    const partFragments = await extractFragmentsForNode(params, {
      kind: "part",
      partIndex,
      partTotal: plan.parts.length,
      heading: planPart.heading,
      focus: planPart.focus,
    }, chunks, 1);

    const subparts: WorkflowSubpartState[] = [];
    for (let subpartIndex = 0; subpartIndex < (planPart.subparts?.length ?? 0); subpartIndex += 1) {
      const planSubpart = planPart.subparts![subpartIndex]!;
      const subpartFragments = await extractFragmentsForNode(params, {
        kind: "subpart",
        partIndex,
        partTotal: plan.parts.length,
        subpartIndex,
        subpartTotal: planPart.subparts?.length ?? 0,
        heading: planSubpart.heading,
        focus: planSubpart.focus,
      }, chunks, 1);

      subparts.push({
        heading: planSubpart.heading,
        focus: planSubpart.focus,
        fragments: subpartFragments,
      });
    }

    const reviewedSection = await reviewSectionDraft(params, {
      partIndex,
      partTotal: plan.parts.length,
      heading: planPart.heading,
      focus: planPart.focus,
      fragments: partFragments,
      subparts,
      expansionPass: 0,
    });

    state.push({
      heading: planPart.heading,
      focus: planPart.focus,
      fragments: partFragments,
      subparts,
      sectionText: reviewedSection,
    });

    logger.debug("[llm-api][workflow] part extraction done", {
      format: params.format,
      detailLevel: params.detailLevel,
      partIndex: partIndex + 1,
      partTotal: plan.parts.length,
      partHeading: planPart.heading,
      sectionWordCount: countWords(reviewedSection),
    });
    emitStage(params.emitStage, "workflow_part_extract_done", {
      format: params.format,
      detailLevel: params.detailLevel,
      partIndex: partIndex + 1,
      partTotal: plan.parts.length,
      partHeading: planPart.heading,
      sectionWordCount: countWords(reviewedSection),
    });
  }

  return state;
}

async function extractFragmentsForNode(
  params: GenerateCloudMultiPassReportParams,
  node: {
    kind: "part" | "subpart";
    partIndex: number;
    partTotal?: number;
    subpartIndex?: number;
    subpartTotal?: number;
    heading: string;
    focus: string;
  },
  chunks: WordChunk[],
  expansionPass: number,
  expansionReason?: string
): Promise<string[]> {
  const workflowTextMaxTokens = normalizeLlmReportWorkflowTextMaxTokens(params.workflowTextMaxTokens);
  const fragments: string[] = [];

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex]!;
    logger.debug("[llm-api][workflow] chunk extraction start", {
      format: params.format,
      detailLevel: params.detailLevel,
      expansionPass,
      chunkIndex: chunkIndex + 1,
      chunkTotal: chunks.length,
      chunkWordCount: chunk.wordCount,
      nodeKind: node.kind,
      partIndex: node.partIndex + 1,
      partTotal: node.partTotal ?? null,
      subpartIndex: node.subpartIndex !== undefined ? node.subpartIndex + 1 : null,
      subpartTotal: node.subpartTotal ?? null,
      heading: node.heading,
      expansionReason: expansionReason ?? null,
    });
    emitStage(params.emitStage, "workflow_chunk_extract_start", {
      format: params.format,
      detailLevel: params.detailLevel,
      expansionPass,
      chunkIndex: chunkIndex + 1,
      chunkTotal: chunks.length,
      chunkWordCount: chunk.wordCount,
      nodeKind: node.kind,
      partIndex: node.partIndex + 1,
      partTotal: node.partTotal ?? null,
      subpartIndex: node.subpartIndex !== undefined ? node.subpartIndex + 1 : null,
      subpartTotal: node.subpartTotal ?? null,
      heading: node.heading,
      expansionReason: expansionReason ?? null,
    });

    const prompt = buildChunkExtractionPrompt(params.format, params.detailLevel, node, chunk, chunkIndex + 1, chunks.length, expansionPass, expansionReason);
    const response = await params.generateText({
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      temperature: 0,
      maxTokens: Math.min(params.maxTokens, workflowTextMaxTokens),
      responseMode: "text",
    });
    const normalized = response.trim();
    if (normalized) {
      fragments.push(normalized);
    }

    logger.debug("[llm-api][workflow] chunk extraction done", {
      format: params.format,
      detailLevel: params.detailLevel,
      expansionPass,
      chunkIndex: chunkIndex + 1,
      chunkTotal: chunks.length,
      chunkWordCount: chunk.wordCount,
      outputWordCount: countWords(normalized),
      nodeKind: node.kind,
      partIndex: node.partIndex + 1,
      partTotal: node.partTotal ?? null,
      subpartIndex: node.subpartIndex !== undefined ? node.subpartIndex + 1 : null,
      subpartTotal: node.subpartTotal ?? null,
      heading: node.heading,
    });
    emitStage(params.emitStage, "workflow_chunk_extract_done", {
      format: params.format,
      detailLevel: params.detailLevel,
      expansionPass,
      chunkIndex: chunkIndex + 1,
      chunkTotal: chunks.length,
      chunkWordCount: chunk.wordCount,
      outputWordCount: countWords(normalized),
      nodeKind: node.kind,
      partIndex: node.partIndex + 1,
      partTotal: node.partTotal ?? null,
      subpartIndex: node.subpartIndex !== undefined ? node.subpartIndex + 1 : null,
      subpartTotal: node.subpartTotal ?? null,
      heading: node.heading,
    });
  }

  return uniqueStrings(fragments);
}

async function reviewSectionDraft(
  params: GenerateCloudMultiPassReportParams,
  section: {
    partIndex: number;
    partTotal: number;
    heading: string;
    focus: string;
    fragments: string[];
    subparts: WorkflowSubpartState[];
    expansionPass: number;
  }
): Promise<string> {
  const workflowTextMaxTokens = normalizeLlmReportWorkflowTextMaxTokens(params.workflowTextMaxTokens);
  const draft = buildSectionDraft(section.heading, section.focus, section.fragments, section.subparts);
  const draftWordCount = countWords(draft);

  logger.debug("[llm-api][workflow] section review start", {
    format: params.format,
    detailLevel: params.detailLevel,
    expansionPass: section.expansionPass,
    partIndex: section.partIndex + 1,
    partTotal: section.partTotal,
    heading: section.heading,
    draftWordCount,
    fragmentCount: section.fragments.length,
    subpartCount: section.subparts.length,
  });
  emitStage(params.emitStage, "workflow_section_review_start", {
    format: params.format,
    detailLevel: params.detailLevel,
    expansionPass: section.expansionPass,
    partIndex: section.partIndex + 1,
    partTotal: section.partTotal,
    heading: section.heading,
    draftWordCount,
    fragmentCount: section.fragments.length,
    subpartCount: section.subparts.length,
  });

  const prompt = buildSectionReviewPrompt(params.format, params.detailLevel, section.heading, section.focus, draft, draftWordCount, section.expansionPass);
  const reviewed = await params.generateText({
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    temperature: 0,
    maxTokens: Math.min(params.maxTokens, workflowTextMaxTokens),
    responseMode: "text",
  });

  const normalizedReviewed = reviewed.trim() || draft.trim();
  const repeatDetected = normalizeWhitespace(normalizedReviewed) !== normalizeWhitespace(draft);
  logger.debug("[llm-api][workflow] section review done", {
    format: params.format,
    detailLevel: params.detailLevel,
    expansionPass: section.expansionPass,
    partIndex: section.partIndex + 1,
    partTotal: section.partTotal,
    heading: section.heading,
    draftWordCount,
    outputWordCount: countWords(normalizedReviewed),
    repeatDetected,
  });
  emitStage(params.emitStage, "workflow_section_review_done", {
    format: params.format,
    detailLevel: params.detailLevel,
    expansionPass: section.expansionPass,
    partIndex: section.partIndex + 1,
    partTotal: section.partTotal,
    heading: section.heading,
    draftWordCount,
    outputWordCount: countWords(normalizedReviewed),
    repeatDetected,
  });

  return normalizedReviewed;
}

async function analyzeExpansion(
  params: GenerateCloudMultiPassReportParams,
  plan: WorkflowPlan,
  state: WorkflowPartState[],
  sourceText: string,
  fallbackPlanSourceText: string,
  expansionPass: number
): Promise<WorkflowExpansionAnalysis> {
  const currentReport = buildReportJsonFromState(params.format, plan, state);
  const currentReportText = renderReportForWordCount(currentReport);
  const planSummary = renderPlanSummary(plan);
  const prompt = buildExpansionAnalysisPrompt(
    params.format,
    params.detailLevel,
    sourceText,
    currentReportText,
    planSummary,
    expansionPass
  );
  const fallbackPrompt = buildExpansionAnalysisPrompt(
    params.format,
    params.detailLevel,
    fallbackPlanSourceText,
    currentReportText,
    planSummary,
    expansionPass
  );

  logger.debug("[llm-api][workflow] expansion analysis request start", {
    format: params.format,
    detailLevel: params.detailLevel,
    expansionPass,
    currentReportWordCount: countWords(currentReportText),
    sourceWordCount: countWords(sourceText),
  });

  const raw = await attemptJsonPrompt(params, prompt, fallbackPrompt, "analysis", () => ({ needs_more: false, targets: [] }));
  const parsed = normalizeExpansionAnalysis(raw);
  if (!parsed.targets.length) {
    parsed.targets = [buildExpansionFallbackTarget(plan, state, expansionPass)];
    parsed.needs_more = true;
  }
  return parsed;
}

async function applyExpansionTarget(
  params: GenerateCloudMultiPassReportParams,
  plan: WorkflowPlan,
  state: WorkflowPartState[],
  chunks: WordChunk[],
  target: WorkflowExpansionTarget,
  expansionPass: number,
  targetIndex: number,
  targetCount: number
): Promise<void> {
  if (target.mode === "new_part") {
    plan.parts.push({
      heading: target.heading,
      focus: target.focus,
      subparts: [],
    });
    logger.debug("[llm-api][workflow] expansion structure created", {
      format: params.format,
      detailLevel: params.detailLevel,
      expansionPass,
      structureKind: "part",
      targetIndex,
      targetCount,
      heading: target.heading,
      focusPreview: buildTextPreview(target.focus),
      rationale: target.rationale ?? null,
    });
    emitStage(params.emitStage, "workflow_expansion_structure_created", {
      format: params.format,
      detailLevel: params.detailLevel,
      expansionPass,
      structureKind: "part",
      targetIndex,
      targetCount,
      targetTotal: targetCount,
      heading: target.heading,
      rationale: target.rationale ?? null,
    });
  }

  const fallbackPartIndex = Math.max(0, Math.min(state.length - 1, target.partIndex ?? 0));
  const partIndex = clampIndex(target.partIndex ?? fallbackPartIndex, state.length);
  const partState = state[partIndex];
  const effectivePart = partState ?? createFallbackPartState(target.heading, target.focus);
  if (!state[partIndex]) {
    state.splice(partIndex, 0, effectivePart);
  }

  const subpartLimit = normalizeWorkflowMaxSubpartsPerPart(params.maxSubpartsPerPart);
  let mode = target.mode;
  let preservePartHeading = false;
  const requestedSubpartIndex = clampIndex(target.subpartIndex ?? 0, Math.max(1, effectivePart.subparts.length || 1));
  const requestedSubpartExists = Boolean(effectivePart.subparts[requestedSubpartIndex]);
  if (mode === "new_subpart" && effectivePart.subparts.length >= subpartLimit) {
    mode = "expand_part";
    preservePartHeading = true;
  } else if (mode === "expand_subpart" && !requestedSubpartExists && effectivePart.subparts.length >= subpartLimit) {
    mode = "expand_part";
    preservePartHeading = true;
  }

  const nodeKind = mode === "expand_subpart" || mode === "new_subpart" ? "subpart" : "part";
  const nodeHeading = target.heading || (nodeKind === "part" ? `Complément ${partIndex + 1}` : `Sous-partie ${partIndex + 1}`);
  const nodeFocus = target.focus || "Extraire tout ce qui peut encore enrichir le compte rendu.";
  let subpartIndex: number | undefined;

  if (nodeKind === "subpart") {
    if (mode === "new_subpart") {
      subpartIndex = Math.max(0, effectivePart.subparts.length);
      effectivePart.subparts.splice(subpartIndex, 0, {
        heading: nodeHeading,
        focus: nodeFocus,
        fragments: [],
      });
      const planPart = plan.parts[partIndex];
      if (planPart) {
        const subparts = [...(planPart.subparts ?? [])];
        subparts.push({
          heading: nodeHeading,
          focus: nodeFocus,
        });
        planPart.subparts = subparts;
      }
      logger.debug("[llm-api][workflow] expansion structure created", {
        format: params.format,
        detailLevel: params.detailLevel,
        expansionPass,
        structureKind: "subpart",
        partIndex: partIndex + 1,
        targetIndex,
        targetCount,
        heading: nodeHeading,
        focusPreview: buildTextPreview(nodeFocus),
        rationale: target.rationale ?? null,
      });
      emitStage(params.emitStage, "workflow_expansion_structure_created", {
        format: params.format,
        detailLevel: params.detailLevel,
        expansionPass,
        structureKind: "subpart",
        partIndex: partIndex + 1,
        targetIndex,
        targetCount,
        targetTotal: targetCount,
        heading: nodeHeading,
        rationale: target.rationale ?? null,
      });
    } else {
      subpartIndex = clampIndex(target.subpartIndex ?? 0, effectivePart.subparts.length);
      if (!effectivePart.subparts[subpartIndex]) {
        effectivePart.subparts.splice(subpartIndex, 0, {
          heading: nodeHeading,
          focus: nodeFocus,
          fragments: [],
        });
      }
    }
  } else if (!preservePartHeading) {
    effectivePart.heading = nodeHeading;
    effectivePart.focus = nodeFocus;
  }

  logger.debug("[llm-api][workflow] expansion target start", {
    format: params.format,
    detailLevel: params.detailLevel,
    expansionPass,
    targetIndex,
    targetCount,
    targetTotal: targetCount,
    mode,
    reroutedFromSubpart: mode !== target.mode,
    partIndex: partIndex + 1,
    partTotal: state.length,
    subpartIndex: subpartIndex !== undefined ? subpartIndex + 1 : null,
    subpartTotal: effectivePart.subparts.length || null,
    heading: nodeHeading,
    rationale: target.rationale ?? null,
  });
  emitStage(params.emitStage, "workflow_expansion_target_start", {
    format: params.format,
    detailLevel: params.detailLevel,
    expansionPass,
    targetIndex,
    targetCount,
    targetTotal: targetCount,
    mode,
    reroutedFromSubpart: mode !== target.mode,
    partIndex: partIndex + 1,
    partTotal: state.length,
    subpartIndex: subpartIndex !== undefined ? subpartIndex + 1 : null,
    subpartTotal: effectivePart.subparts.length || null,
    heading: nodeHeading,
    rationale: target.rationale ?? null,
  });

  const nodeFragments = await extractFragmentsForNode(
    params,
    {
      kind: nodeKind,
      partIndex,
      partTotal: state.length,
      subpartIndex,
      subpartTotal: effectivePart.subparts.length || undefined,
      heading: nodeHeading,
      focus: nodeFocus,
    },
    chunks,
    expansionPass,
    target.rationale
  );

  if (nodeKind === "part") {
    effectivePart.fragments = mergeUniqueFragments([...(effectivePart.fragments ?? []), ...nodeFragments]);
    if (!preservePartHeading) {
      effectivePart.heading = nodeHeading;
      effectivePart.focus = nodeFocus;
    }
  } else {
    const subpartState = effectivePart.subparts[subpartIndex ?? 0];
    if (subpartState) {
      subpartState.fragments = mergeUniqueFragments([...(subpartState.fragments ?? []), ...nodeFragments]);
      subpartState.heading = nodeHeading;
      subpartState.focus = nodeFocus;
    }
  }

  effectivePart.sectionText = await reviewSectionDraft(params, {
    partIndex,
    partTotal: state.length,
    heading: effectivePart.heading,
    focus: effectivePart.focus,
    fragments: effectivePart.fragments,
    subparts: effectivePart.subparts,
    expansionPass,
  });

  logger.debug("[llm-api][workflow] expansion target done", {
    format: params.format,
    detailLevel: params.detailLevel,
    expansionPass,
    targetIndex,
    targetCount,
    targetTotal: targetCount,
    mode,
    reroutedFromSubpart: mode !== target.mode,
    partIndex: partIndex + 1,
    partTotal: state.length,
    subpartIndex: subpartIndex !== undefined ? subpartIndex + 1 : null,
    subpartTotal: effectivePart.subparts.length || null,
    heading: nodeHeading,
    outputWordCount: countWords(effectivePart.sectionText),
  });
  emitStage(params.emitStage, "workflow_expansion_target_done", {
    format: params.format,
    detailLevel: params.detailLevel,
    expansionPass,
    targetIndex,
    targetCount,
    targetTotal: targetCount,
    mode,
    reroutedFromSubpart: mode !== target.mode,
    partIndex: partIndex + 1,
    partTotal: state.length,
    subpartIndex: subpartIndex !== undefined ? subpartIndex + 1 : null,
    subpartTotal: effectivePart.subparts.length || null,
    heading: nodeHeading,
    outputWordCount: countWords(effectivePart.sectionText),
  });
}

async function buildFinalMetadata(
  params: GenerateCloudMultiPassReportParams,
  plan: WorkflowPlan,
  report: ReportJson,
  sourceText: string,
  fallbackPlanSourceText: string
): Promise<WorkflowMetadata> {
  const reportText = renderReportForWordCount(report);
  const planSummary = renderPlanSummary(plan);
  const prompt = buildMetadataPrompt(params.format, params.detailLevel, reportText, planSummary);
  const fallbackPrompt = buildMetadataPrompt(
    params.format,
    params.detailLevel,
    fallbackPlanSourceText,
    planSummary
  );

  logger.debug("[llm-api][workflow] metadata request start", {
    format: params.format,
    detailLevel: params.detailLevel,
    reportWordCount: countWords(reportText),
    sourceWordCount: countWords(sourceText),
  });

  const raw = await attemptJsonPrompt(params, prompt, fallbackPrompt, "metadata", () =>
    fallbackMetadata(plan.title, reportText)
  );
  const metadata = normalizeMetadata(raw, plan.title, reportText);
  logger.debug("[llm-api][workflow] metadata request done", {
    format: params.format,
    detailLevel: params.detailLevel,
    title: metadata.title,
    hasSubtitle: Boolean(metadata.subtitle),
  });

  return metadata;
}

function buildReportJsonFromState(
  format: ReportFormat,
  plan: WorkflowPlan,
  state: WorkflowPartState[]
): ReportJson {
  return {
    format,
    title: plan.title || buildReportFormatLabel(format),
    subtitle: plan.subtitle,
    sections: state.map((part) => ({
      heading: part.heading,
      paragraphs: splitParagraphs(part.sectionText || buildSectionDraft(part.heading, part.focus, part.fragments, part.subparts)),
    })),
  };
}

function buildSectionDraft(
  heading: string,
  focus: string,
  fragments: string[],
  subparts: WorkflowSubpartState[]
): string {
  const lines: string[] = [
    `SECTION: ${heading}`,
    `OBJECTIF: ${focus}`,
  ];

  if (fragments.length) {
    lines.push("CONTENU EXTRAIT:");
    for (const fragment of fragments) {
      lines.push(fragment);
    }
  }

  for (const subpart of subparts) {
    lines.push("");
    lines.push(`SOUS-PARTIE: ${subpart.heading}`);
    lines.push(`OBJECTIF: ${subpart.focus}`);
    if (subpart.fragments.length) {
      lines.push("CONTENU EXTRAIT:");
      for (const fragment of subpart.fragments) {
        lines.push(fragment);
      }
    }
  }

  return lines.join("\n");
}

function renderPlanSummary(plan: WorkflowPlan): string {
  const lines: string[] = [
    `FORMAT: ${plan.format}`,
    `TITRE: ${plan.title}`,
  ];
  if (plan.subtitle) {
    lines.push(`SOUS-TITRE: ${plan.subtitle}`);
  }
  lines.push("PARTIES:");
  plan.parts.forEach((part, partIndex) => {
    lines.push(`- [${partIndex + 1}] ${part.heading} :: ${part.focus}`);
    part.subparts?.forEach((subpart, subpartIndex) => {
      lines.push(`  - [${partIndex + 1}.${subpartIndex + 1}] ${subpart.heading} :: ${subpart.focus}`);
    });
  });
  return lines.join("\n");
}

function renderReportForWordCount(report: ReportJson): string {
  const lines: string[] = [report.title];
  if (report.subtitle) {
    lines.push(report.subtitle);
  }
  for (const section of report.sections) {
    lines.push(section.heading);
    lines.push(...section.paragraphs);
  }
  if (report.key_points?.length) {
    lines.push(...report.key_points);
  }
  if (report.action_items?.length) {
    lines.push(...report.action_items);
  }
  if (report.caveats?.length) {
    lines.push(...report.caveats);
  }
  return lines.join("\n");
}

function splitParagraphs(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  if (paragraphs.length) {
    return paragraphs;
  }
  return [normalized];
}

function splitTextIntoWordChunks(text: string, maxWordsPerChunk: number): WordChunk[] {
  const normalized = text.trim();
  if (!normalized) return [];
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];

  const chunkSize = Math.max(1, Math.floor(maxWordsPerChunk));
  const chunks: WordChunk[] = [];
  let cursor = 0;
  while (cursor < tokens.length) {
    const end = Math.min(tokens.length, cursor + chunkSize);
    const slice = tokens.slice(cursor, end);
    chunks.push({
      text: slice.join(" "),
      wordCount: slice.length,
    });
    cursor = end;
  }
  logger.debug("[llm-api][workflow] transcript split", {
    wordCount: tokens.length,
    chunkCount: chunks.length,
    maxWordsPerChunk: chunkSize,
  });
  return chunks;
}

interface WordChunk {
  text: string;
  wordCount: number;
}

function countWords(text: string): number {
  if (!text) return 0;
  const matches = text.trim().match(/[\p{L}\p{N}]+(?:[’'_-][\p{L}\p{N}]+)*/gu);
  return matches ? matches.length : 0;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function buildTextPreview(text: string): string {
  const normalized = text.trim();
  if (!normalized) return "";
  if (normalized.length <= 256) return normalized;
  return `${normalized.slice(0, 128)}...[${normalized.length - 256} chars omitted]...${normalized.slice(-128)}`;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function mergeUniqueFragments(fragments: string[]): string[] {
  const normalized = uniqueStrings(fragments);
  return normalized;
}

function createFallbackPartState(heading: string, focus: string): WorkflowPartState {
  return {
    heading,
    focus,
    fragments: [],
    subparts: [],
    sectionText: "",
  };
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, Math.floor(index)));
}

function buildFallbackExpansionTarget(
  plan: WorkflowPlan,
  state: WorkflowPartState[],
  expansionPass: number
): WorkflowExpansionTarget {
  const partIndex = clampIndex(expansionPass - 1, Math.max(1, state.length || plan.parts.length));
  const planPart = plan.parts[partIndex] ?? plan.parts[0];
  const baseHeading = planPart?.heading ?? `Complement ${expansionPass}`;
  const focus = planPart?.focus
    ? `${planPart.focus} Ajouter aussi les details, noms cites, nuances et elements complementaires qui figurent deja dans la transcription.`
    : "Ajouter tout contenu complementaire deja present dans la transcription, y compris les noms cites, les avis exprimes et les nuances.";

  return {
    mode: "new_subpart",
    partIndex,
    heading: `Complement ${baseHeading}`,
    focus,
    rationale: "Fallback automatique pour agrandir le compte rendu sans perdre de matiere.",
    priority: 1,
  };
}

function normalizePlan(
  raw: unknown,
  format: ReportFormat,
  detailLevel: Exclude<ReportDetailLevel, "standard">,
  targetWordCount: number,
  maxSubpartsPerPart: number
): WorkflowPlan {
  if (!raw || typeof raw !== "object") {
    return buildFallbackPlan(format, detailLevel, targetWordCount, maxSubpartsPerPart);
  }

  const record = raw as Record<string, unknown>;
  const title = toTrimmedString(record.title) ?? `${buildReportFormatLabel(format)} ${buildReportDetailLevelLabel(detailLevel)}`;
  const subtitle = toTrimmedString(record.subtitle) ?? undefined;
  const partsRaw = Array.isArray(record.parts) ? record.parts : [];
  const parts = partsRaw
    .map((part): WorkflowPlanPart | null => {
      if (!part || typeof part !== "object") return null;
      const partRecord = part as Record<string, unknown>;
      const heading = toTrimmedString(partRecord.heading);
      const focus = toTrimmedString(partRecord.focus);
      if (!heading || !focus) return null;
      const subpartsRaw = Array.isArray(partRecord.subparts) ? partRecord.subparts : [];
      const subparts = subpartsRaw
        .map((subpart): WorkflowPlanSubpart | null => {
          if (!subpart || typeof subpart !== "object") return null;
          const subpartRecord = subpart as Record<string, unknown>;
          const subHeading = toTrimmedString(subpartRecord.heading);
          const subFocus = toTrimmedString(subpartRecord.focus);
          if (!subHeading || !subFocus) return null;
          return { heading: subHeading, focus: subFocus };
        })
        .filter((subpart): subpart is WorkflowPlanSubpart => Boolean(subpart));
      return { heading, focus, subparts };
    })
    .filter((part): part is WorkflowPlanPart => Boolean(part));

  if (!parts.length) {
    return buildFallbackPlan(format, detailLevel, targetWordCount, maxSubpartsPerPart);
  }

  return limitWorkflowPlanSubparts({
    format,
    title,
    subtitle,
    parts,
  }, maxSubpartsPerPart);
}

function buildFallbackPlan(
  format: ReportFormat,
  detailLevel: Exclude<ReportDetailLevel, "standard">,
  targetWordCount: number,
  maxSubpartsPerPart: number
): WorkflowPlan {
  const label = buildReportFormatLabel(format);
  const detailLabel = buildReportDetailLevelLabel(detailLevel);
  const commonParts: WorkflowPlanPart[] =
    format === "CRI"
      ? [
          {
            heading: "Contexte et deroule",
            focus: "Restituer le contexte general, les interlocuteurs nommes, la chronologie et les faits majeurs.",
            subparts: [
              {
                heading: "Elements saillants",
                focus: "Mettre en avant les details qui donnent de la profondeur au compte rendu et les nuances importantes.",
              },
            ],
          },
          {
            heading: "Points developpes",
            focus: "Developper les themes importants, les avis exprimes et les informations de fond utiles a la comprehension.",
            subparts: [
              {
                heading: "Avis et positions",
                focus: "Conserver les positions formulees par les interlocuteurs nommes et leur impact dans le compte rendu.",
              },
            ],
          },
          {
            heading: "Synthese approfondie",
            focus: "Consolider les decisions, points de vigilance, suites et zones d'incertitude dans un format detaille.",
          },
        ]
      : format === "CRO"
        ? [
            {
              heading: "Contexte operationnel",
              focus: "Restituer le contexte, les enjeux, les interlocuteurs nommes et les faits necessaires a la decision.",
              subparts: [
                {
                  heading: "Constats utiles",
                  focus: "Saisir les points de contexte et les details utiles a l'action.",
                },
              ],
            },
            {
              heading: "Decisions et actions",
              focus: "Developper les decisions prises, les actions associees, les responsables et les delais si presentes.",
              subparts: [
                {
                  heading: "Priorites et suites",
                  focus: "Lister les priorites et la suite operationnelle avec les nuances exprimees par les interlocuteurs nommes.",
                },
              ],
            },
            {
              heading: "Points de vigilance",
              focus: "Conserver les risques, objections, incertitudes et points a surveiller sans les appauvrir.",
            },
          ]
        : [
            {
              heading: "Essentiel",
              focus: "Restituer l'essentiel de la transcription avec les faits majeurs, les noms cites et les informations critiques.",
            },
            {
              heading: "Elements complementaires",
              focus: "Ajouter les details utiles qui enrichissent la lecture sans alourdir inutilement le document.",
            },
          ];

  return limitWorkflowPlanSubparts({
    format,
    title: `${label} ${detailLabel}`,
    subtitle: `Plan de secours genere pour atteindre une cible d'environ ${targetWordCount} mots.`,
    parts: commonParts,
  }, maxSubpartsPerPart);
}

function limitWorkflowPlanSubparts(plan: WorkflowPlan, maxSubpartsPerPart: number): WorkflowPlan {
  const safeLimit = normalizeWorkflowMaxSubpartsPerPart(maxSubpartsPerPart);
  return {
    ...plan,
    parts: plan.parts.map((part) => {
      const subparts = (part.subparts ?? []).slice(0, safeLimit);
      return {
        ...part,
        subparts,
      };
    }),
  };
}

function normalizeExpansionAnalysis(raw: unknown): WorkflowExpansionAnalysis {
  if (!raw || typeof raw !== "object") {
    return { needs_more: false, targets: [] };
  }

  const record = raw as Record<string, unknown>;
  const targetsRaw = Array.isArray(record.targets) ? record.targets : [];
  const targets = targetsRaw
    .map((target): WorkflowExpansionTarget | null => {
      if (!target || typeof target !== "object") return null;
      const targetRecord = target as Record<string, unknown>;
      const mode = toTrimmedString(targetRecord.mode) as WorkflowExpansionTarget["mode"] | undefined;
      const heading = toTrimmedString(targetRecord.heading);
      const focus = toTrimmedString(targetRecord.focus);
      if (!mode || !heading || !focus) return null;
      return {
        mode,
        partIndex: toOptionalIndex(targetRecord.partIndex),
        subpartIndex: toOptionalIndex(targetRecord.subpartIndex),
        heading,
        focus,
        rationale: toTrimmedString(targetRecord.rationale) ?? undefined,
        priority: typeof targetRecord.priority === "number" ? targetRecord.priority : undefined,
      };
    })
    .filter((target): target is WorkflowExpansionTarget => Boolean(target));

  return {
    needs_more: Boolean(record.needs_more),
    summary: toTrimmedString(record.summary) ?? undefined,
    targets,
  };
}

function normalizeMetadata(raw: unknown, fallbackTitle: string, reportText: string): WorkflowMetadata {
  if (!raw || typeof raw !== "object") {
    return fallbackMetadata(fallbackTitle, reportText);
  }

  const record = raw as Record<string, unknown>;
  const title = toTrimmedString(record.title) ?? fallbackTitle;
  const subtitle = toTrimmedString(record.subtitle) ?? undefined;
  const key_points = normalizeStringArray(record.key_points);
  const action_items = normalizeStringArray(record.action_items);
  const caveats = normalizeStringArray(record.caveats);

  return {
    title,
    subtitle,
    key_points,
    action_items,
    caveats,
  };
}

function fallbackMetadata(fallbackTitle: string, reportText: string): WorkflowMetadata {
  const firstParagraph = splitParagraphs(reportText)[0] ?? fallbackTitle;
  return {
    title: fallbackTitle,
    subtitle: firstParagraph === fallbackTitle ? undefined : firstParagraph.slice(0, 180),
    key_points: [],
    action_items: [],
    caveats: [],
  };
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return normalized.length ? normalized : undefined;
}

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function toOptionalIndex(value: unknown): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

export function buildPlanPrompt(
  format: ReportFormat,
  detailLevel: Exclude<ReportDetailLevel, "standard">,
  sourceText: string,
  targetWordCount: number,
  maxSubpartsPerPart: number
): { systemPrompt: string; userPrompt: string } {
  const subpartConstraint =
    maxSubpartsPerPart > 0
      ? `Limite structurelle: ${maxSubpartsPerPart} sous-parties maximum par partie.`
      : "Limite structurelle: aucune sous-partie.";
  const systemPrompt = [
    "Tu es un architecte experimente de comptes rendus professionnels.",
    "Tu dois analyser une transcription complete et proposer un plan structuré.",
    "Retourne uniquement du JSON valide, sans texte autour.",
    "Le plan doit prevoir des parties majeures et, si cela apporte de la precision, des sous-parties.",
    subpartConstraint,
    "Le plan doit preparer une redaction tres detaillee, pas un resume court.",
    `Format cible: ${buildReportFormatLabel(format)}.`,
    `Niveau de detail: ${buildReportDetailLevelLabel(detailLevel)}.`,
    `Cible finale minimale: environ ${targetWordCount} mots pour le compte rendu final.`,
  ].join("\n");

  const userPrompt = [
    `Format attendu: ${format}.`,
    "Analyse la transcription suivante dans son integralite et propose un plan de compte rendu.",
    "Le plan doit couvrir les grandes parties, les grands points a aborder, et autoriser des sous-parties quand cela enrichit la structure.",
    subpartConstraint,
    "Retourne uniquement un JSON valide avec cette structure:",
    `{
  "format": "${format}",
  "title": "...",
  "subtitle": "... (optionnel)",
  "parts": [
    {
      "heading": "...",
      "focus": "...",
      "subparts": [
        { "heading": "...", "focus": "..." }
      ]
    }
  ]
}`,
    "Contraintes de plan:",
    "- 3 a 8 parties principales maximum, sauf si la transcription justifie davantage de matiere.",
    maxSubpartsPerPart > 0
      ? `- Chaque partie peut contenir 0 a ${maxSubpartsPerPart} sous-parties.`
      : "- Les sous-parties sont desactivees.",
    "- Les focus doivent indiquer quoi recuperer lors des phases d'extraction.",
    "- Si des interlocuteurs sont nommes, le plan doit le refléter pour permettre de citer leurs avis.",
    "- Le plan doit permettre d'atteindre une redaction longue, dense et riche en details.",
    "",
    "TRANSCRIPTION COMPLETE:",
    sourceText,
  ].join("\n");

  return { systemPrompt, userPrompt };
}

function buildChunkExtractionPrompt(
  format: ReportFormat,
  detailLevel: Exclude<ReportDetailLevel, "standard">,
  node: {
    kind: "part" | "subpart";
    partIndex: number;
    subpartIndex?: number;
    heading: string;
    focus: string;
  },
  chunk: WordChunk,
  chunkIndex: number,
  chunkCount: number,
  expansionPass: number,
  expansionReason?: string
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    "Tu extrais le maximum de matiere utile d'un bloc de transcription.",
    "Tu ne dois pas inventer d'informations.",
    "Tu dois restituer tout ce qui est pertinent pour la cible demandee.",
    "Conserve les noms des interlocuteurs et leurs avis ou positions lorsqu'ils sont exprimes.",
    "Le texte source peut contenir des erreurs ASR: corrige uniquement ce qui est evident.",
    `Format cible: ${buildReportFormatLabel(format)}.`,
    `Niveau de detail: ${buildReportDetailLevelLabel(detailLevel)}.`,
  ].join("\n");

  const userPrompt = [
    `Phase: extraction ${node.kind === "part" ? "de partie" : "de sous-partie"}.`,
    `Partie cible: ${node.heading}.`,
    `Objectif editorial: ${node.focus}.`,
    `Bloc ${chunkIndex}/${chunkCount}.`,
    `Passage d'agrandissement: ${expansionPass}.`,
    expansionReason ? `Raison de l'agrandissement: ${expansionReason}.` : "",
    "Rends un texte developpe, dense, sans ajouter de titre ni de commentaire meta.",
    "N'hesite pas a produire plusieurs paragraphes si le bloc apporte beaucoup de matiere.",
    "Si ce bloc n'apporte rien de nouveau pour cette cible, reponds par une ligne vide.",
    "",
    "BLOC DE TRANSCRIPTION:",
    chunk.text,
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  return { systemPrompt, userPrompt };
}

function buildSectionReviewPrompt(
  format: ReportFormat,
  detailLevel: Exclude<ReportDetailLevel, "standard">,
  heading: string,
  focus: string,
  draft: string,
  draftWordCount: number,
  expansionPass: number
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    "Tu ameliore et dedoubles un brouillon de compte rendu.",
    "Tu conserves toute la matiere utile, tu supprimes les repetitions, tu fluidifies l'ecriture.",
    "Tu ne dois pas raccourcir artificiellement si cela fait perdre de la matiere pertinente.",
    "Retourne uniquement le texte final de la partie, avec des paragraphes separes par des lignes vides.",
    `Format cible: ${buildReportFormatLabel(format)}.`,
    `Niveau de detail: ${buildReportDetailLevelLabel(detailLevel)}.`,
  ].join("\n");

  const userPrompt = [
    `Partie: ${heading}.`,
    `Objectif: ${focus}.`,
    `Brouillon a relire (environ ${draftWordCount} mots).`,
    `Passage d'agrandissement: ${expansionPass}.`,
    "Verifie qu'aucune repetition ne subsiste entre les fragments et que les sous-parties ne se recoupent pas.",
    "Tu peux rephraser pour eliminer les doublons tout en conservant les details, les noms cites et les nuances.",
    "Retourne un texte final coherent, detaille, organise en paragraphes.",
    "",
    "BROUILLON:",
    draft,
  ].join("\n");

  return { systemPrompt, userPrompt };
}

function buildExpansionAnalysisPrompt(
  format: ReportFormat,
  detailLevel: Exclude<ReportDetailLevel, "standard">,
  sourceText: string,
  currentReportText: string,
  planSummary: string,
  expansionPass: number
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    "Tu compares une transcription complete a un compte rendu deja produit.",
    "Tu dois identifier ce qui manque encore dans le compte rendu courant, sans inventer de contenu.",
    "Tu peux proposer une nouvelle partie ou une nouvelle sous-partie si cela permet d'agrandir utilement le texte.",
    "Retourne uniquement du JSON valide.",
    `Format cible: ${buildReportFormatLabel(format)}.`,
    `Niveau de detail: ${buildReportDetailLevelLabel(detailLevel)}.`,
  ].join("\n");

  const userPrompt = [
    `Passage d'agrandissement: ${expansionPass}.`,
    "Analyse l'ensemble de la transcription ci-dessous en la comparant au compte rendu courant et au plan.",
    "Identifie uniquement ce qui peut encore etre ajoute parce que c'est present dans la transcription mais pas encore dans le compte rendu.",
    "Tu peux creer une nouvelle partie ou une nouvelle sous-partie si c'est le meilleur moyen d'agrandir le texte.",
    "Retourne uniquement un JSON valide avec cette structure:",
    `{
  "needs_more": true,
  "summary": "...",
  "targets": [
    {
      "mode": "new_part | new_subpart | expand_part | expand_subpart",
      "partIndex": 1,
      "subpartIndex": 1,
      "heading": "...",
      "focus": "...",
      "rationale": "...",
      "priority": 1
    }
  ]
}`,
    "Contraintes:",
    "- Les index sont 1-based quand ils sont presentes.",
    "- Les targets doivent rester exploitables pour une extraction supplementaire.",
    "- Si le compte rendu peut encore etre enrichi avec de la matiere non redondante, fais-le remonter.",
    "- Si besoin, cree une nouvelle sous-partie pour aller chercher du detail plus fin.",
    "",
    "PLAN COURANT:",
    planSummary,
    "",
    "COMPTE RENDU COURANT:",
    currentReportText,
    "",
    "TRANSCRIPTION COMPLETE:",
    sourceText,
  ].join("\n");

  return { systemPrompt, userPrompt };
}

function buildMetadataPrompt(
  format: ReportFormat,
  detailLevel: Exclude<ReportDetailLevel, "standard">,
  reportText: string,
  planSummary: string
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    "Tu finalises les metadonnees d'un compte rendu deja construit.",
    "Tu retournes uniquement du JSON valide.",
    "Tu ne dois pas re-ecrire les sections, seulement proposer le titre, le sous-titre et les listes auxiliaires.",
    `Format cible: ${buildReportFormatLabel(format)}.`,
    `Niveau de detail: ${buildReportDetailLevelLabel(detailLevel)}.`,
  ].join("\n");

  const userPrompt = [
    "A partir du compte rendu suivant et du plan associe, propose les metadonnees finales.",
    "Retourne uniquement un JSON valide avec cette structure:",
    `{
  "title": "...",
  "subtitle": "... (optionnel)",
  "key_points": ["..."],
  "action_items": ["..."],
  "caveats": ["..."]
}`,
    "Le titre doit rester fidele a la matiere et au format.",
    "Le sous-titre est optionnel et peut resumer la portee du compte rendu.",
    "Les listes auxiliaires doivent rester coherentes avec le contenu deja present.",
    "",
    "PLAN:",
    planSummary,
    "",
    "COMPTE RENDU:",
    reportText,
  ].join("\n");

  return { systemPrompt, userPrompt };
}

async function attemptJsonPrompt(
  params: GenerateCloudMultiPassReportParams,
  primaryPrompt: { systemPrompt: string; userPrompt: string },
  fallbackPrompt: { systemPrompt: string; userPrompt: string },
  label: "plan" | "analysis" | "metadata",
  finalFallback?: () => unknown
): Promise<unknown> {
  const attempts = [primaryPrompt, fallbackPrompt];

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]!;
    try {
      logger.debug("[llm-api][workflow] json prompt start", {
        format: params.format,
        detailLevel: params.detailLevel,
        label,
        attempt: index + 1,
      });
      const raw = await params.generateText({
        systemPrompt: attempt.systemPrompt,
        userPrompt: attempt.userPrompt,
        temperature: 0,
        maxTokens: WORKFLOW_JSON_MAX_TOKENS,
        responseMode: "json",
      });
      logger.debug("[llm-api][workflow] json prompt raw", {
        format: params.format,
        detailLevel: params.detailLevel,
        label,
        attempt: index + 1,
        responseLength: raw.length,
      });
      const parsed = parseJsonLike(raw);
      if (parsed !== null) {
        if (index > 0) {
          emitStage(params.emitStage, "workflow_json_fallback_used", {
            format: params.format,
            detailLevel: params.detailLevel,
            label,
            attempt: index + 1,
          });
        }
        return parsed;
      }
      throw new Error("JSON invalide.");
    } catch (error) {
      logger.warn("[llm-api][workflow] json prompt failed", {
        format: params.format,
        detailLevel: params.detailLevel,
        label,
        attempt: index + 1,
        message: error instanceof Error ? error.message : String(error),
      });
      if (index === attempts.length - 1) {
        const fallback = finalFallback?.() ?? null;
        if (fallback !== null) {
          emitStage(params.emitStage, "workflow_json_final_fallback", {
            format: params.format,
            detailLevel: params.detailLevel,
            label,
            attempt: index + 1,
          });
        }
        return fallback;
      }
    }
  }

  return null;
}

function parseJsonLike(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const primary = fenced?.[1]?.trim() ?? trimmed;
  const candidates = uniqueStrings([
    primary,
    extractBalancedJson(primary),
    buildBraceSliceCandidate(primary),
  ]);

  for (const candidate of candidates) {
    if (!candidate || candidate.includes("{") === false || candidate.includes("}") === false) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }

  return null;
}

function buildBraceSliceCandidate(value: string): string {
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return "";
  }
  return value.slice(firstBrace, lastBrace + 1);
}

function extractBalancedJson(value: string): string {
  const start = value.indexOf("{");
  if (start < 0) return value;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (!char) continue;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }
  return value.slice(start);
}

function normalizeExpansionTargets(
  analysis: WorkflowExpansionAnalysis,
  plan: WorkflowPlan,
  state: WorkflowPartState[],
  reportWordCount: number,
  targetWordCount: number,
  expansionPass: number
): WorkflowExpansionTarget[] {
  const targets = analysis.targets
    .map((target) => normalizeExpansionTarget(target, plan, state))
    .filter((target): target is WorkflowExpansionTarget => Boolean(target));

  if (targets.length) {
    return targets;
  }

  if (reportWordCount >= targetWordCount) {
    return [];
  }

  return [buildFallbackExpansionTarget(plan, state, expansionPass)];
}

function normalizeExpansionTarget(
  target: WorkflowExpansionTarget,
  plan: WorkflowPlan,
  state: WorkflowPartState[]
): WorkflowExpansionTarget | null {
  const mode = target.mode;
  if (!mode) return null;

  const normalized: WorkflowExpansionTarget = {
    mode,
    heading: target.heading.trim(),
    focus: target.focus.trim(),
    rationale: target.rationale?.trim() || undefined,
    priority: target.priority,
  };

  if (mode === "new_part") {
    return normalized;
  }

  const partIndex = clampIndex((target.partIndex ?? 1) - 1, Math.max(plan.parts.length, state.length));
  normalized.partIndex = partIndex;

  if (mode === "new_subpart" || mode === "expand_subpart") {
    const part = state[partIndex] ?? createFallbackPartState(plan.parts[partIndex]?.heading ?? target.heading, target.focus);
    const subpartIndex = clampIndex((target.subpartIndex ?? 1) - 1, Math.max(1, part.subparts.length + 1));
    normalized.subpartIndex = subpartIndex;
  }

  return normalized;
}

function buildExpansionFallbackTarget(plan: WorkflowPlan, state: WorkflowPartState[], expansionPass: number): WorkflowExpansionTarget {
  const partIndex = clampIndex(expansionPass - 1, Math.max(1, state.length || plan.parts.length));
  const planPart = plan.parts[partIndex] ?? plan.parts[0];
  return {
    mode: "new_subpart",
    partIndex,
    heading: `Complement ${planPart?.heading ?? expansionPass}`,
    focus: planPart
      ? `${planPart.focus} Ajouter tout ce qui manque encore dans la transcription: noms cites, avis exprimes, nuances, exemples et details contextuels.`
      : "Ajouter tout contenu complementaire deja present dans la transcription, avec les noms cites, les avis et les nuances.",
    rationale: "Fallback automatique pour enrichir la partie avec de la matiere deja presente dans la transcription.",
    priority: 1,
  };
}

async function applyExpansionTargets(
  params: GenerateCloudMultiPassReportParams,
  plan: WorkflowPlan,
  state: WorkflowPartState[],
  chunks: WordChunk[],
  target: WorkflowExpansionTarget,
  expansionPass: number,
  targetIndex: number,
  targetCount: number
): Promise<void> {
  return applyExpansionTarget(params, plan, state, chunks, target, expansionPass, targetIndex, targetCount);
}

function emitStage(emit: WorkflowStageEmitter | undefined, stage: string, data?: Record<string, unknown>) {
  emit?.(stage, data);
}
