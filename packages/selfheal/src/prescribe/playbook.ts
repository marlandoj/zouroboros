/**
 * Playbook registry for self-prescription
 */

import { getWorkspaceRoot } from 'zouroboros-core';
import type { Playbook, MetricResult } from '../types.js';

const WORKSPACE = getWorkspaceRoot();
const MEMORY_SCRIPTS = `${WORKSPACE}/Skills/zo-memory-system/scripts`;

export function getPlaybook(metric: MetricResult): Playbook {
  const isCritical = metric.status === 'CRITICAL';
  const name = metric.name;

  switch (name) {
    case 'Memory Recall':
      return isCritical
        ? {
            id: 'B-graph-boost-weights',
            name: 'Graph-Boost Weight Tuning',
            description: 'Adjust RRF fusion weights in graph-boost.ts to improve recall',
            targetFile: 'Skills/zo-memory-system/scripts/graph-boost.ts',
            metricCommand: `bun ${MEMORY_SCRIPTS}/eval-continuation.ts 2>&1 | grep -oP 'Rate: \\K[\\d.]+'`,
            metricDirection: 'higher_is_better',
            constraints: [
              'Weights must sum to 1.0',
              'No single weight > 0.70 or < 0.05',
              'Only modify weight constants, not algorithm logic',
            ],
            maxFiles: 1,
            requiresApproval: false,
            readOnlyFiles: [
              'Skills/zo-memory-system/scripts/eval-continuation.ts',
              'Skills/zo-memory-system/assets/continuation-eval-fixture-set.json',
            ],
          }
        : {
            id: 'A-fixture-expansion',
            name: 'Continuation Fixture Expansion',
            description: 'Add new eval fixtures targeting recall gaps',
            targetFile: 'Skills/zo-memory-system/assets/continuation-eval-fixture-set.json',
            metricCommand: `bun ${MEMORY_SCRIPTS}/eval-continuation.ts 2>&1 | grep -oP 'Rate: \\K[\\d.]+'`,
            metricDirection: 'higher_is_better',
            constraints: [
              'Only add fixtures, never remove existing ones',
              'Max 10 new fixtures per cycle',
              'Fixtures must test real continuation scenarios',
            ],
            maxFiles: 1,
            requiresApproval: false,
            readOnlyFiles: ['Skills/zo-memory-system/scripts/eval-continuation.ts'],
          };

    case 'Graph Connectivity':
      return isCritical
        ? {
            id: 'D-entity-consolidation',
            name: 'Entity Consolidation & Hub Linking',
            description: 'Merge duplicate entities and create hub nodes',
            targetFile: null,
            metricCommand: `bun ${MEMORY_SCRIPTS}/graph.ts knowledge-gaps 2>&1 | grep -oP 'Linked facts: \\d+ \\(\\K[\\d.]+'`,
            metricDirection: 'higher_is_better',
            constraints: [
              'Only create links with weight >= 0.5',
              'Never delete existing links or facts',
              'Max 500 links per cycle',
            ],
            maxFiles: 1,
            requiresApproval: false,
            setupCommands: [
              `bun ${MEMORY_SCRIPTS}/graph.ts knowledge-gaps > /tmp/z-gaps.txt 2>&1`,
            ],
            runCommand: 'bun /tmp/z-graph-linker.ts 2>&1',
          }
        : {
            id: 'C-batch-wikilink',
            name: 'Batch Wikilink Extraction',
            description: 'Scan orphan facts for entity co-occurrence and auto-generate links',
            targetFile: 'Skills/zo-memory-system/scripts/graph.ts',
            metricCommand: `bun ${MEMORY_SCRIPTS}/graph.ts knowledge-gaps 2>&1 | grep -oP 'Linked facts: \\d+ \\(\\K[\\d.]+'`,
            metricDirection: 'higher_is_better',
            constraints: [
              'Only process facts without existing links',
              'Link threshold: co-occurrence >= 2',
              'Max 100 new links per cycle',
            ],
            maxFiles: 1,
            requiresApproval: false,
            readOnlyFiles: ['Skills/zo-memory-system/scripts/wikilink-utils.ts'],
          };

    case 'Routing Accuracy':
      return {
        id: 'E-routing-weights',
        name: 'Routing Weight Calibration',
        description: 'Tune 6-signal routing weights based on episode outcomes',
        targetFile: 'packages/swarm/src/routing/engine.ts',
        metricCommand: `bun ${WORKSPACE}/packages/swarm/src/routing/engine.accuracy.ts 2>/dev/null`,
        metricDirection: 'higher_is_better',
        constraints: [
          'Only modify STRATEGY_WEIGHTS_6SIGNAL in engine.ts',
          'Preserve weight sum normalization',
          'Test with synthetic episodes before commit',
        ],
        maxFiles: 1,
        requiresApproval: true,
        approvalReason: 'Changes affect all swarm routing decisions',
      };

    case 'Eval Calibration':
      return {
        id: 'F-eval-thresholds',
        name: 'Evaluation Threshold Tuning',
        description: 'Adjust Stage 2→3 trigger thresholds',
        targetFile: 'packages/selfheal/src/introspect/collector.ts',
        metricCommand: `ZO_WORKSPACE=${WORKSPACE} ZOUROBOROS_WORKSPACE=${WORKSPACE} ZOUROBOROS_MEMORY_DB=${WORKSPACE}/.zo/memory/shared-facts.db bun ${WORKSPACE}/packages/selfheal/dist/cli/introspect.js --json 2>/dev/null | jq -r 'first(.metrics[] | select(.name == "Eval Calibration")) | .value // 0'`,
        metricDirection: 'lower_is_better',
        constraints: [
          'Only modify threshold constants',
          'Do not change evaluation logic',
          'Document threshold changes in ROADMAP',
        ],
        maxFiles: 1,
        requiresApproval: false,
      };

    case 'Procedure Freshness':
      return {
        id: 'G-procedure-refresh',
        name: 'Stale Procedure Refresh',
        description: 'Identify and update stale procedures from episode analysis',
        targetFile: null,
        metricCommand: 'echo 0.82',
        metricDirection: 'higher_is_better',
        constraints: [
          'Only update procedures with >5 episodes since last evolution',
          'Preserve working procedure patterns',
          'Log all updates to episode store',
        ],
        maxFiles: 0,
        requiresApproval: true,
        approvalReason: 'May affect existing workflow behaviors',
      };

    case 'Episode Velocity':
      return {
        id: 'H-velocity-analysis',
        name: 'Episode Velocity Analysis',
        description: 'Analyze success/failure patterns to improve velocity',
        targetFile: null,
        metricCommand: 'echo 0.78',
        metricDirection: 'higher_is_better',
        constraints: [
          'Analyze only, do not modify code',
          'Generate report with recommendations',
          'Schedule for next evolution cycle',
        ],
        maxFiles: 0,
        requiresApproval: false,
      };

    case 'Wiring Health':
      return {
        id: 'I-wiring-reconcile',
        name: 'Wiring Sentinel Reconciliation',
        description: 'Report un-invoked exports, empty data stores, and broken path refs for wire-or-retire review',
        targetFile: null,
        metricCommand: 'echo 0',
        metricDirection: 'higher_is_better',
        constraints: [
          'Analyze and report only — never auto-delete code or data',
          'Each finding is wire-or-retire: escalate to a human for the disposition',
          'Do not modify the Wiring Sentinel scanner or its manifest to suppress findings',
        ],
        maxFiles: 0,
        requiresApproval: true,
        approvalReason: 'Dead-wiring dispositions (wire vs. retire) require human judgement; the loop must not delete its own capabilities',
      };

    default:
      return {
        id: 'Z-unknown',
        name: 'Unknown Metric',
        description: 'No playbook defined for this metric',
        targetFile: null,
        metricCommand: 'echo 0',
        metricDirection: 'higher_is_better',
        constraints: ['Manual intervention required'],
        maxFiles: 0,
        requiresApproval: true,
        approvalReason: 'No automated playbook available',
      };
  }
}

export function listPlaybooks(): string[] {
  return [
    'A-fixture-expansion: Add continuation fixtures',
    'B-graph-boost-weights: Tune RRF fusion weights',
    'C-batch-wikilink: Extract wikilinks from orphans',
    'D-entity-consolidation: Merge duplicates and hub-link',
    'E-routing-weights: Calibrate 6-signal routing',
    'F-eval-thresholds: Adjust Stage 2→3 triggers',
    'G-procedure-refresh: Update stale procedures',
    'H-velocity-analysis: Analyze success patterns',
    'I-wiring-reconcile: Report dead wiring for wire-or-retire review',
  ];
}