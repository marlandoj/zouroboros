/**
 * Stage 2: Semantic evaluation
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { SeedSpec, SemanticResult, SemanticCriterion, ReflectionTokenSet } from './types.js';

/**
 * Parse a seed specification from YAML content
 */
export function parseSeed(seedPath: string): SeedSpec {
  const content = readFileSync(seedPath, 'utf-8');
  const spec: SeedSpec = {};

  const goalMatch = content.match(/^goal:\s*"?(.+?)"?\s*$/m);
  if (goalMatch) spec.goal = goalMatch[1];

  spec.constraints = [];
  spec.acceptanceCriteria = [];

  const lines = content.split('\n');
  let inConstraints = false;
  let inAC = false;

  for (const line of lines) {
    if (line.match(/^constraints:/)) {
      inConstraints = true;
      inAC = false;
      continue;
    }
    if (line.match(/^acceptance_criteria:/)) {
      inAC = true;
      inConstraints = false;
      continue;
    }
    if (line.match(/^[a-z_]+:/) && !line.startsWith('  ')) {
      inConstraints = false;
      inAC = false;
      continue;
    }

    const itemMatch = line.match(/^\s+-\s+"?(.+?)"?\s*$/);
    if (itemMatch) {
      if (inConstraints) spec.constraints!.push(itemMatch[1]);
      if (inAC) spec.acceptanceCriteria!.push(itemMatch[1]);
    }
  }

  return spec;
}

/**
 * Run semantic evaluation against acceptance criteria
 */
export function runSemanticEvaluation(
  seed: SeedSpec,
  artifactPath: string
): SemanticResult {
  const criteria: SemanticCriterion[] = [];

  for (const ac of seed.acceptanceCriteria || []) {
    const keywords = ac.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const evidence = searchForEvidence(ac, artifactPath);
    const reflectionTokens = generateReflectionTokens(keywords, evidence);
    // Token-weighted confidence: binary met (70%) + token agreement (30%)
    const confidence = 0.7 * (evidence.found ? 1 : 0) + 0.3 * reflectionTokens.agreement;
    criteria.push({
      name: ac,
      met: evidence.found,
      evidence: evidence.details,
      reflectionTokens,
      confidence,
    });
  }

  const totalCount = criteria.length || 1;
  // acCompliance is now the mean confidence across criteria (continuous, not binary)
  const acCompliance = criteria.reduce((sum, c) => sum + c.confidence, 0) / totalCount;
  const tokenAgreement = criteria.reduce((sum, c) => sum + c.reflectionTokens.agreement, 0) / totalCount;

  // Calculate goal alignment (simplified)
  const goalAlignment = calculateGoalAlignment(seed, artifactPath);

  // Calculate drift score
  const driftScore = calculateDrift(seed, artifactPath);

  // Overall score
  const overallScore = 0.5 * goalAlignment + 0.3 * acCompliance + 0.2 * (1 - driftScore);

  const recommendations: string[] = [];
  if (acCompliance < 0.8) {
    const unmet = criteria.filter(c => !c.met).map(c => c.name);
    recommendations.push(`Unmet acceptance criteria: ${unmet.join(', ')}`);
  }
  if (goalAlignment < 0.7) {
    recommendations.push('Goal alignment is low — verify implementation matches the stated objective');
  }
  if (driftScore > 0.3) {
    recommendations.push('Significant drift detected — review scope changes against original spec');
  }

  return {
    acCompliance,
    goalAlignment,
    driftScore,
    overallScore,
    criteria,
    recommendations,
    passed: overallScore >= 0.8,
    tokenAgreement,
  };
}

interface EvidenceResult {
  found: boolean;
  details: string;
  matchDensity: number;
  filesSearched: number;
  filesMatched: number;
}

function searchForEvidence(criterion: string, artifactPath: string): EvidenceResult {
  const keywords = criterion.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  let filesMatched = 0;
  let filesSearched = 0;
  let bestMatchDensity = 0;

  function searchDir(dir: string, depth: number = 0): void {
    if (depth > 3) return;

    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith('.') || entry === 'node_modules') continue;

        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          searchDir(fullPath, depth + 1);
        } else if (stat.isFile() && isCodeFile(entry)) {
          filesSearched++;
          try {
            const content = readFileSync(fullPath, 'utf-8').toLowerCase();
            const matchCount = keywords.filter((kw) => content.includes(kw)).length;
            const density = keywords.length > 0 ? matchCount / keywords.length : 0;
            if (matchCount >= Math.ceil(keywords.length / 2)) {
              filesMatched++;
              if (density > bestMatchDensity) bestMatchDensity = density;
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  if (existsSync(artifactPath)) {
    const stat = statSync(artifactPath);
    if (stat.isDirectory()) {
      searchDir(artifactPath);
    } else if (stat.isFile()) {
      filesSearched = 1;
      try {
        const content = readFileSync(artifactPath, 'utf-8').toLowerCase();
        const matchCount = keywords.filter((kw) => content.includes(kw)).length;
        const density = keywords.length > 0 ? matchCount / keywords.length : 0;
        if (matchCount >= Math.ceil(keywords.length / 2)) {
          filesMatched++;
          bestMatchDensity = density;
        }
      } catch {
        // Skip
      }
    }
  }

  return {
    found: filesMatched > 0,
    details: filesSearched > 0
      ? `Found evidence in ${filesMatched} of ${filesSearched} searched files`
      : 'No files searched',
    matchDensity: bestMatchDensity,
    filesSearched,
    filesMatched,
  };
}

function generateReflectionTokens(
  keywords: string[],
  evidence: EvidenceResult,
): ReflectionTokenSet {
  // [Retrieve]: more context needed — fires when no evidence found and criterion is substantive
  const retrieve = !evidence.found && keywords.length > 2;

  // [ISREL]: retrieved content is relevant — keyword density meets or exceeds 60%
  const isRel = evidence.found && evidence.matchDensity >= 0.6;

  // [ISSUP]: retrieved content supports the criterion — found in multiple files OR strong single match
  const isSup = evidence.found && (evidence.filesMatched > 1 || evidence.matchDensity >= 0.8);

  // [ISUSE]: information is sufficient/actionable — found across a reasonably broad search
  const isUse = evidence.found && evidence.filesSearched > 1;

  const positives = [!retrieve, isRel, isSup, isUse].filter(Boolean).length;
  return {
    retrieve,
    isRel,
    isSup,
    isUse,
    agreement: positives / 4,
  };
}

function isCodeFile(filename: string): boolean {
  const codeExts = ['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h', '.md'];
  return codeExts.some((ext) => filename.endsWith(ext));
}

function calculateGoalAlignment(seed: SeedSpec, artifactPath: string): number {
  // Simplified goal alignment check
  if (!seed.goal) return 0.5;

  const goalKeywords = seed.goal.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
  const evidence = searchForEvidence(seed.goal, artifactPath);

  return evidence.found ? 0.9 : 0.5;
}

export function calculateDrift(seed: SeedSpec, artifactPath: string): number {
  // Simplified drift calculation
  // In a full implementation, this would compare ontology fields, constraints, etc.
  return 0.1; // Assume low drift for now
}
