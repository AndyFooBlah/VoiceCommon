// Copyright 2026 Andrew Brook
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * `runLiveConformance` — run a chosen set of live checks against an app's
 * real Live configuration and get a report back.
 *
 * An app describes itself with a {@link LiveAppProfile}; the connect config
 * is produced by `buildLiveConnectConfig`, the same function `useSession`
 * calls, so the test exercises the setup message production sends.
 */

import type { FunctionDeclaration, LiveConnectConfig, SpeechConfig } from '@google/genai';
import { buildLiveConnectConfig, resolveLiveModel } from '../services/liveConnectConfig';
import type { ThinkingRequest } from '../services/liveModels';
import {
  canaryRegistryFreshness,
  canarySilentToolResponse,
  canaryThinkingContract,
  canaryToolBehaviorContract,
  canaryToolCallOrdering,
  checkAudioTurn,
  checkBargeIn,
  checkContextWindowCompression,
  checkEphemeralToken,
  checkLatency,
  checkManualTurnControl,
  checkModelListed,
  checkPatience,
  checkSessionResumption,
  checkSetupAccepted,
  checkTextTurn,
  checkToolDeclarationsAccepted,
  checkToolRoundTrip,
} from './checks';
import type {
  AudioTurnOptions,
  BargeInOptions,
  EphemeralTokenOptions,
  LatencyOptions,
  LiveCheckResult,
  LiveCheckTarget,
  PatienceOptions,
  TextTurnOptions,
  ToolProbe,
} from './checks';
import { makeRedactor } from './redact';

/** How an app talks to Gemini Live. Mirrors the relevant `useSession` options. */
export interface LiveAppProfile {
  /** Name shown in the report. */
  name: string;
  /** Live model id. Defaults to `DEFAULT_LIVE_MODEL`. */
  model?: string;
  /** Same meaning as `UseSessionOptions.thinkingLevel`. Default `'auto'`. */
  thinkingLevel?: ThinkingRequest;
  /** The app's real system instruction. */
  systemInstruction: string;
  /** The app's real tool declarations (without `endSession`). */
  tools?: FunctionDeclaration[];
  /** Append the `endSession` tool, as `useSession` does. Default true. */
  includeEndSessionTool?: boolean;
  speechConfig?: SpeechConfig;
  /** Turn-taking options, as passed to `useSession`. */
  manualTurnControl?: boolean;
  endOfSpeechSilenceMs?: number;
  endOfSpeechSensitivity?: 'HIGH' | 'LOW';
  /**
   * For a code path that calls `ai.live.connect` directly instead of going
   * through `useSession`: the exact `config` object that path builds. When
   * set, it is used as is and the fields above (other than `name` and
   * `model`) are ignored.
   */
  connectConfig?: LiveConnectConfig;
}

/** Names accepted in `RunLiveConformanceOptions.checks`. */
export const LIVE_CHECK_NAMES = [
  'setup',
  'text-turn',
  'audio-turn',
  'tool-declarations',
  'tool-round-trip',
  'manual-turn-control',
  'patience',
  'barge-in',
  'session-resumption',
  'context-compression',
  'model-listed',
  'ephemeral-token',
  'latency',
  'thinking-contract',
  'tool-behavior-contract',
  'registry-freshness',
  'tool-call-ordering',
  'silent-tool-response',
] as const;

export type LiveCheckName = (typeof LIVE_CHECK_NAMES)[number];

/**
 * The default set: everything that exercises the app's production path. The
 * provider-contract canaries are model-level, not app-level, so they run
 * only when named (VoiceCommon's own live suite runs them weekly).
 */
export const DEFAULT_LIVE_CHECKS: readonly LiveCheckName[] = [
  'setup',
  'text-turn',
  'audio-turn',
  'tool-declarations',
  'tool-round-trip',
  'manual-turn-control',
  'patience',
  'barge-in',
  'session-resumption',
  'context-compression',
  'model-listed',
  'ephemeral-token',
  'latency',
];

export interface RunLiveConformanceOptions {
  /**
   * Long-lived Gemini API key, read from the Node test process environment
   * (for example `process.env.GEMINI_API_KEY`). Never logged or stored.
   */
  apiKey: string;
  /** Which checks to run, in order. Default {@link DEFAULT_LIVE_CHECKS}. */
  checks?: readonly LiveCheckName[];
  /** WebSocket API version. Defaults to the hook's `LIVE_API_VERSION`. */
  apiVersion?: string;
  /** For `tool-round-trip`: a prompt and the app tool it should trigger. */
  toolProbe?: ToolProbe;
  textTurn?: TextTurnOptions;
  audioTurn?: AudioTurnOptions;
  patience?: PatienceOptions;
  bargeIn?: BargeInOptions;
  ephemeralToken?: EphemeralTokenOptions;
  latency?: LatencyOptions;
  /** Called as each check finishes (progress output for long runs). */
  onResult?: (result: LiveCheckResult) => void;
}

export interface LiveConformanceReport {
  profile: string;
  model: string;
  startedAt: string;
  durationMs: number;
  results: LiveCheckResult[];
  /** True when nothing failed and no provider contract changed. */
  ok: boolean;
  counts: Record<LiveCheckResult['status'], number>;
}

/** Resolve a profile to the model and connect config production would use. */
export function buildProfileConnectConfig(profile: LiveAppProfile): { model: string; config: LiveConnectConfig } {
  const model = resolveLiveModel(profile.model);
  if (profile.connectConfig) return { model, config: profile.connectConfig };
  return {
    model,
    config: buildLiveConnectConfig({
      model,
      systemInstruction: profile.systemInstruction,
      tools: profile.tools,
      includeEndSessionTool: profile.includeEndSessionTool,
      thinkingLevel: profile.thinkingLevel,
      speechConfig: profile.speechConfig,
      manualTurnControl: profile.manualTurnControl,
      endOfSpeechSilenceMs: profile.endOfSpeechSilenceMs,
      endOfSpeechSensitivity: profile.endOfSpeechSensitivity,
    }),
  };
}

/**
 * Run live conformance checks for an app profile, one after another.
 *
 * Never throws for a provider-side failure: read `report.ok`, or call
 * {@link assertLiveConformance} to turn a bad report into a thrown Error.
 * A profile the registry knows is invalid (for example an explicit thinking
 * level the model rejects) is reported as a failed `setup` check carrying
 * the `LiveConfigError` text, without opening a connection.
 */
export async function runLiveConformance(
  profile: LiveAppProfile,
  options: RunLiveConformanceOptions,
): Promise<LiveConformanceReport> {
  if (!options.apiKey) throw new Error('runLiveConformance needs options.apiKey');
  const startedAt = new Date();
  const redact = makeRedactor([options.apiKey]);
  const names = options.checks ?? DEFAULT_LIVE_CHECKS;
  const results: LiveCheckResult[] = [];
  const record = (result: LiveCheckResult) => {
    results.push(result);
    options.onResult?.(result);
  };

  let model = resolveLiveModel(profile.model);
  let target: LiveCheckTarget | null = null;
  try {
    const built = buildProfileConnectConfig(profile);
    model = built.model;
    target = { apiKey: options.apiKey, model, config: built.config, apiVersion: options.apiVersion };
  } catch (err) {
    record({
      name: 'setup',
      pass: false,
      status: 'fail',
      detail: `invalid profile, nothing was sent: ${redact(err)}`,
      metrics: {},
      durationMs: 0,
    });
  }

  if (target) {
    for (const name of names) {
      record(await runOne(name, target, options));
    }
  }

  const counts = { pass: 0, warn: 0, skipped: 0, fail: 0, 'contract-changed': 0 };
  for (const r of results) counts[r.status] += 1;
  return {
    profile: profile.name,
    model,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    results,
    ok: counts.fail === 0 && counts['contract-changed'] === 0,
    counts,
  };
}

function runOne(
  name: LiveCheckName,
  target: LiveCheckTarget,
  options: RunLiveConformanceOptions,
): Promise<LiveCheckResult> {
  switch (name) {
    case 'setup':
      return checkSetupAccepted(target);
    case 'text-turn':
      return checkTextTurn(target, options.textTurn);
    case 'audio-turn':
      return checkAudioTurn(target, options.audioTurn);
    case 'tool-declarations':
      return checkToolDeclarationsAccepted(target);
    case 'tool-round-trip':
      return checkToolRoundTrip(target, options.toolProbe);
    case 'manual-turn-control':
      return checkManualTurnControl(target, options.audioTurn);
    case 'patience':
      return checkPatience(target, options.patience);
    case 'barge-in':
      return checkBargeIn(target, options.bargeIn);
    case 'session-resumption':
      return checkSessionResumption(target);
    case 'context-compression':
      return checkContextWindowCompression(target);
    case 'model-listed':
      return checkModelListed(target.apiKey, target.model);
    case 'ephemeral-token':
      return checkEphemeralToken(target, options.ephemeralToken);
    case 'latency':
      return checkLatency(target, options.latency);
    case 'thinking-contract':
      return canaryThinkingContract(target.apiKey, target.model, { apiVersion: target.apiVersion });
    case 'tool-behavior-contract':
      return canaryToolBehaviorContract(target.apiKey, target.model, { apiVersion: target.apiVersion });
    case 'registry-freshness':
      return canaryRegistryFreshness(target.apiKey);
    case 'tool-call-ordering':
      return canaryToolCallOrdering(target.apiKey, target.model, { apiVersion: target.apiVersion });
    case 'silent-tool-response':
      return canarySilentToolResponse(target.apiKey, target.model, { apiVersion: target.apiVersion });
    default: {
      const unknown: never = name;
      return Promise.resolve({
        name: String(unknown),
        pass: false,
        status: 'fail',
        detail: `unknown check '${String(unknown)}'; valid names: ${LIVE_CHECK_NAMES.join(', ')}`,
        metrics: {},
        durationMs: 0,
      });
    }
  }
}

const STATUS_LABEL: Record<LiveCheckResult['status'], string> = {
  pass: 'PASS',
  warn: 'WARN',
  skipped: 'SKIP',
  fail: 'FAIL',
  'contract-changed': 'CONTRACT CHANGED',
};

/** One line per check, plus a summary. Safe to print: contains no secrets. */
export function formatLiveConformanceReport(report: LiveConformanceReport): string {
  const width = Math.max(...report.results.map((r) => r.name.length), 5);
  const lines = report.results.map((r) => {
    const metrics = Object.entries(r.metrics)
      .filter(([, v]) => v !== '' && v !== -1)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    return `${STATUS_LABEL[r.status].padEnd(16)} ${r.name.padEnd(width)}  ${r.detail}${metrics ? `\n${' '.repeat(18 + width)}[${metrics}]` : ''}`;
  });
  const c = report.counts;
  return [
    `Live conformance: ${report.profile} on ${report.model} (${(report.durationMs / 1000).toFixed(0)} s)`,
    ...lines,
    `${report.ok ? 'OK' : 'NOT OK'}: ${c.pass} passed, ${c.warn} warned, ${c.skipped} skipped, ${c.fail} failed, ${c['contract-changed']} contract changed`,
  ].join('\n');
}

/** Throw an Error carrying the formatted report unless `report.ok`. */
export function assertLiveConformance(report: LiveConformanceReport): void {
  if (report.ok) return;
  const bad = report.results.filter((r) => r.status === 'fail' || r.status === 'contract-changed');
  throw new Error(
    `Live conformance failed for ${report.profile} on ${report.model}: ${bad.map((r) => r.name).join(', ')}\n` +
      formatLiveConformanceReport(report),
  );
}
