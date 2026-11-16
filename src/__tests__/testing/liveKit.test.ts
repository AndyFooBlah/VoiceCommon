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
 * Offline tests for LiveTestSession, the checks and runLiveConformance,
 * driven by a fake `@google/genai` whose "server" the tests script. No
 * network, no key. The real API is exercised by `npm run test:live`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DEFAULT_LIVE_CHECKS,
  LIVE_API_VERSION,
  LiveSetupError,
  LiveTestSession,
  LiveWaitError,
  assertLiveConformance,
  buildLiveConnectConfig,
  buildProfileConnectConfig,
  canaryThinkingContract,
  canaryToolBehaviorContract,
  checkSetupAccepted,
  checkTextTurn,
  checkToolRoundTrip,
  formatLiveConformanceReport,
  formatLiveTrace,
  resolveThinkingConfig,
  runLiveConformance,
} from '../../testing';

// ---------------------------------------------------------------------------
// Fake SDK
// ---------------------------------------------------------------------------

interface FakeServer {
  params: any;
  sent: Array<[kind: string, payload: any]>;
  /** Server accepts the setup: open, setupComplete, connect() resolves. */
  accept(): void;
  /** Server rejects the setup: open, then close. connect() never settles. */
  reject(code: number, reason: string): void;
  emit(message: any): void;
  close(code: number, reason: string): void;
}

const fake = vi.hoisted(() => ({
  clients: [] as any[],
  servers: [] as any[],
  onConnect: null as null | ((server: any) => void),
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  class FakeGoogleGenAI {
    live: any;
    constructor(options: any) {
      fake.clients.push(options);
      this.live = {
        connect: (params: any) =>
          new Promise((resolve) => {
            const sent: Array<[string, any]> = [];
            let closed = false;
            const close = (code: number, reason: string) => {
              if (closed) return;
              closed = true;
              params.callbacks.onclose({ code, reason });
            };
            const session = {
              sendRealtimeInput: (p: any) => sent.push(['realtimeInput', p]),
              sendClientContent: (p: any) => sent.push(['clientContent', p]),
              sendToolResponse: (p: any) => {
                sent.push(['toolResponse', p]);
                server.onToolResponse?.(p);
              },
              close: () => close(1000, ''),
            };
            const server: any = {
              params,
              sent,
              accept: () => {
                params.callbacks.onopen?.();
                params.callbacks.onmessage({ setupComplete: {} });
                resolve(session);
              },
              reject: (code: number, reason: string) => {
                params.callbacks.onopen?.();
                close(code, reason);
              },
              emit: (message: any) => params.callbacks.onmessage(message),
              close,
            };
            fake.servers.push(server);
            queueMicrotask(() => (fake.onConnect ?? ((s: any) => s.accept()))(server));
          }),
      };
    }
  }
  return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});

const audioPart = (bytes: number) => ({
  serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(bytes).toString('base64') } }] } },
});
const KEY = 'test-key-not-a-real-credential';
const CONFIG = buildLiveConnectConfig({ systemInstruction: 'test' });

function lastServer(): FakeServer {
  return fake.servers[fake.servers.length - 1];
}

/** A scripted server that answers any text with a short spoken reply. */
function talkativeServer(reply = 'Hello there.') {
  return (server: any) => {
    server.accept();
    const original = server.sent.push.bind(server.sent);
    server.sent.push = (entry: [string, any]) => {
      const n = original(entry);
      if (entry[0] === 'realtimeInput' && typeof entry[1].text === 'string') {
        queueMicrotask(() => {
          server.emit(audioPart(4800));
          server.emit({ serverContent: { outputTranscription: { text: reply } } });
          server.emit({ serverContent: { generationComplete: true } });
          server.emit({ serverContent: { turnComplete: true } });
        });
      }
      return n;
    };
  };
}

beforeEach(() => {
  fake.clients.length = 0;
  fake.servers.length = 0;
  fake.onConnect = null;
});

// ---------------------------------------------------------------------------
// LiveTestSession
// ---------------------------------------------------------------------------

describe('LiveTestSession.connect', () => {
  it('connects with the key on the pinned API version and records setup', async () => {
    const session = await LiveTestSession.connect({ apiKey: KEY, model: 'gemini-3.8-live', config: CONFIG });
    expect(fake.clients[0]).toEqual({ apiKey: KEY, httpOptions: { apiVersion: LIVE_API_VERSION } });
    expect(lastServer().params.model).toBe('gemini-3.8-live');
    expect(lastServer().params.config).toBe(CONFIG);
    expect(session.trace.map((e) => e.type)).toEqual(['open', 'setupComplete']);
    expect(session.closed).toBeNull();
    await session.close();
    expect(session.closed).toEqual({ code: 1000, reason: '' });
  });

  it('uses an ephemeral token and an explicit API version when given', async () => {
    const session = await LiveTestSession.connect({
      ephemeralToken: 'auth_tokens/abcdef123456',
      apiVersion: 'v1beta',
      model: 'gemini-3.8-live',
      config: CONFIG,
    });
    expect(fake.clients[0]).toEqual({ apiKey: 'auth_tokens/abcdef123456', httpOptions: { apiVersion: 'v1beta' } });
    await session.close();
  });

  it('needs exactly one credential', async () => {
    await expect(LiveTestSession.connect({ model: 'm', config: {} })).rejects.toThrow(/needs an apiKey or an ephemeralToken/);
    await expect(
      LiveTestSession.connect({ apiKey: KEY, ephemeralToken: 'auth_tokens/x', model: 'm', config: {} }),
    ).rejects.toThrow(/not both/);
  });

  it('turns a rejected setup into a LiveSetupError carrying the close code and reason', async () => {
    // The SDK promise never settles here; only the close event arrives.
    fake.onConnect = (server) => server.reject(1007, 'Thinking level is not supported for this model.');
    const error = await LiveTestSession.connect({ apiKey: KEY, model: 'gemini-3.8-live', config: CONFIG }).catch((e) => e);
    expect(error).toBeInstanceOf(LiveSetupError);
    expect(error.code).toBe(1007);
    expect(error.reason).toBe('Thinking level is not supported for this model.');
    expect(error.message).toContain('socket closed with 1007');
    expect(error.message).toContain('before setupComplete');
  });

  it('redacts the credential from a rejection reason', async () => {
    fake.onConnect = (server) => server.reject(1008, `API key ${KEY} is not valid`);
    const error = await LiveTestSession.connect({ apiKey: KEY, model: 'm', config: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(LiveSetupError);
    expect(error.message).not.toContain(KEY);
    expect(error.reason).toBe('API key [REDACTED] is not valid');
  });

  it('times out when the server never answers', async () => {
    fake.onConnect = () => {};
    const error = await LiveTestSession.connect({ apiKey: KEY, model: 'm', config: {}, connectTimeoutMs: 30 }).catch((e) => e);
    expect(error).toBeInstanceOf(LiveSetupError);
    expect(error.message).toMatch(/Timed out after 30 ms/);
  });

  it('never keeps the credential on the session object or in the trace', async () => {
    const session = await LiveTestSession.connect({ apiKey: KEY, model: 'gemini-3.8-live', config: CONFIG });
    session.sendText('hello');
    expect(JSON.stringify(session.trace)).not.toContain(KEY);
    const own = Object.values(session as unknown as Record<string, unknown>)
      .filter((v) => typeof v === 'string' || (typeof v === 'object' && v !== null && !('sendRealtimeInput' in v)))
      .map((v) => {
        try {
          return JSON.stringify(v);
        } catch {
          return '';
        }
      })
      .join('|');
    expect(own).not.toContain(KEY);
    await session.close();
  });
});

describe('LiveTestSession trace and helpers', () => {
  it('records every kind of server event', async () => {
    const session = await LiveTestSession.connect({ apiKey: KEY, model: 'm', config: {}, captureOutputAudio: true });
    const server = lastServer();
    server.emit({ sessionResumptionUpdate: { resumable: true, newHandle: 'HANDLE-123456789' } });
    server.emit({ serverContent: { inputTranscription: { text: 'what is the capital' } } });
    server.emit(audioPart(960));
    server.emit(audioPart(480));
    server.emit({ serverContent: { outputTranscription: { text: 'Paris.' } } });
    server.emit({ toolCall: { functionCalls: [{ id: 'call_1', name: 'getWeather', args: { city: 'Paris' } }] } });
    server.emit({ toolCallCancellation: { ids: ['call_1'] } });
    server.emit({ serverContent: { interrupted: true } });
    server.emit({ serverContent: { generationComplete: true, turnComplete: true } });
    server.emit({ goAway: { timeLeft: '10s' } });
    server.emit({ usageMetadata: { totalTokenCount: 12, promptTokenCount: 8, responseTokenCount: 4 } });
    server.emit({ interactionStatus: 'IDLE' });

    expect(session.trace.map((e) => e.type)).toEqual([
      'open', 'setupComplete', 'sessionResumptionUpdate', 'inputTranscription', 'audio', 'audio',
      'outputTranscription', 'toolCall', 'toolCallCancellation', 'interrupted', 'generationComplete',
      'turnComplete', 'goAway', 'usage', 'interactionStatus',
    ]);
    expect(session.audioBytes()).toBe(1440);
    expect(session.outputAudioPcm().byteLength).toBe(1440);
    expect(session.inputText()).toBe('what is the capital');
    expect(session.outputText()).toBe('Paris.');
    expect(session.latestResumptionHandle()).toBe('HANDLE-123456789');
    expect(session.first('toolCall')?.calls).toEqual([{ id: 'call_1', name: 'getWeather', args: { city: 'Paris' } }]);
    expect(session.events('audio', session.mark())).toEqual([]);

    const text = formatLiveTrace(session.trace).join('\n');
    expect(text).toContain('audio x2 (0.03 s)');
    expect(text).toContain('"handle":"HANDLE…"');
    expect(text).not.toContain('HANDLE-123456789');
    await session.close();
  });

  it('sends text, activity signals and tool responses in the shapes the hook uses', async () => {
    const session = await LiveTestSession.connect({ apiKey: KEY, model: 'm', config: {} });
    const server = lastServer();
    session.sendText('hello');
    session.sendClientText('typed turn');
    session.activityStart();
    session.activityEnd();
    session.audioStreamEnd();
    session.respondToTool({ id: 'call_9', name: 'getWeather' }, 'sunny');
    session.respondToTool({ id: 'call_10', name: 'getWeather' }, { tempC: 18 });
    expect(server.sent).toEqual([
      ['realtimeInput', { text: 'hello' }],
      ['clientContent', { turns: [{ role: 'user', parts: [{ text: 'typed turn' }] }], turnComplete: true }],
      ['realtimeInput', { activityStart: {} }],
      ['realtimeInput', { activityEnd: {} }],
      ['realtimeInput', { audioStreamEnd: true }],
      ['toolResponse', { functionResponses: [{ id: 'call_9', name: 'getWeather', response: { result: 'sunny' } }] }],
      ['toolResponse', { functionResponses: [{ id: 'call_10', name: 'getWeather', response: { tempC: 18 } }] }],
    ]);
    await session.close();
  });

  it('streams PCM in 100 ms chunks of 16 kHz audio', async () => {
    const session = await LiveTestSession.connect({ apiKey: KEY, model: 'm', config: {} });
    const pcm = Buffer.alloc(8000, 7); // 250 ms
    await session.sendAudioPcm16k(pcm, { realtime: false, label: 'x' });
    const chunks = lastServer().sent.map(([, p]) => p.audio);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c: any) => c.mimeType === 'audio/pcm;rate=16000')).toBe(true);
    expect(chunks.map((c: any) => Buffer.from(c.data, 'base64').byteLength)).toEqual([3200, 3200, 1600]);
    expect(session.events('sentAudioStart')[0]).toMatchObject({ ms: 250, label: 'x' });
    expect(session.events('sentAudioEnd')[0]).toMatchObject({ complete: true });
    await session.close();
  });

  it('paces audio in real time by default', async () => {
    const session = await LiveTestSession.connect({ apiKey: KEY, model: 'm', config: {} });
    const started = Date.now();
    await session.sendSilence(300);
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    await session.close();
  });

  it('waitFor resolves on a later event, honours `since`, and times out with a clear error', async () => {
    const session = await LiveTestSession.connect({ apiKey: KEY, model: 'm', config: {} });
    const server = lastServer();
    server.emit({ serverContent: { turnComplete: true } });
    const since = session.mark();
    setTimeout(() => server.emit({ serverContent: { turnComplete: true } }), 20);
    const event = await session.waitForType('turnComplete', 1_000, { since });
    expect(session.trace.indexOf(event)).toBe(since);

    const error = await session
      .waitFor(() => false, 30, { since: session.mark(), description: 'something impossible' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(LiveWaitError);
    expect(error.message).toBe('Timed out after 30 ms waiting for something impossible');
    expect(error.closed).toBeNull();
    await session.close();
  });

  it('waitFor fails fast, with the close code, when the socket closes', async () => {
    const session = await LiveTestSession.connect({ apiKey: KEY, model: 'm', config: {} });
    setTimeout(() => lastServer().close(1011, 'Internal error'), 10);
    const error = await session.waitForType('turnComplete', 5_000, { since: session.mark() }).catch((e) => e);
    expect(error).toBeInstanceOf(LiveWaitError);
    expect(error.closed).toEqual({ code: 1011, reason: 'Internal error' });
    expect(error.message).toContain('1011');
    expect(() => session.sendText('x')).toThrow(/Session is closed \(1011/);
  });

  it('keeps an open microphone streaming while it waits, when asked', async () => {
    const session = await LiveTestSession.connect({ apiKey: KEY, model: 'm', config: {} });
    const server = lastServer();
    setTimeout(() => server.emit({ serverContent: { turnComplete: true } }), 250);
    await session.waitForType('turnComplete', 2_000, { since: session.mark(), streamSilence: true });
    const silentChunks = server.sent.filter(([kind, p]) => kind === 'realtimeInput' && p.audio);
    expect(silentChunks.length).toBeGreaterThanOrEqual(2);
    expect(Buffer.from(silentChunks[0][1].audio.data, 'base64').every((b) => b === 0)).toBe(true);
    await session.close();
  });
});

// ---------------------------------------------------------------------------
// Checks against the fake server
// ---------------------------------------------------------------------------

describe('checks', () => {
  const target = { apiKey: KEY, model: 'gemini-3.8-live', config: CONFIG };

  it('setup: pass, with metrics', async () => {
    const result = await checkSetupAccepted(target);
    expect(result).toMatchObject({ name: 'setup', pass: true, status: 'pass' });
    expect(result.metrics).toMatchObject({ toolDeclarations: 1, thinkingLevel: 'omitted' });
    expect(result.trace).toBeUndefined();
  });

  it('setup: fail reports the close code, the reason and a trace', async () => {
    fake.onConnect = (server) => server.reject(1007, 'Request contains an invalid argument.');
    const result = await checkSetupAccepted(target);
    expect(result).toMatchObject({ pass: false, status: 'fail' });
    expect(result.detail).toContain('1007');
    expect(result.detail).toContain('Request contains an invalid argument.');
    expect(result.metrics).toMatchObject({ closeCode: 1007 });
  });

  it('text-turn: pass when audio, transcription and turnComplete arrive', async () => {
    fake.onConnect = talkativeServer('Hello there.');
    const result = await checkTextTurn(target);
    expect(result).toMatchObject({ pass: true, status: 'pass' });
    expect(result.metrics).toMatchObject({ reply: 'Hello there.', audioSeconds: 0.1 });
  });

  it('text-turn: fail when the bot sends no audio, with a trace attached', async () => {
    fake.onConnect = (server) => {
      server.accept();
      setTimeout(() => server.emit({ serverContent: { turnComplete: true } }), 5);
    };
    const result = await checkTextTurn(target);
    expect(result).toMatchObject({ pass: false, status: 'fail' });
    expect(result.detail).toMatch(/no bot audio/);
    expect(result.trace?.join('\n')).toContain('turnComplete');
  });

  it('tool-round-trip: handles a turnComplete that precedes the spoken reply (async function calling)', async () => {
    fake.onConnect = (server) => {
      server.accept();
      server.onToolResponse = () => {
        // gemini-3.8-live: the calling turn ends first, then the reply starts.
        server.emit({ serverContent: { generationComplete: true } });
        server.emit({ serverContent: { turnComplete: true } });
        setTimeout(() => {
          server.emit(audioPart(4800));
          server.emit({ serverContent: { outputTranscription: { text: 'The code word is marigold.' } } });
          server.emit({ serverContent: { turnComplete: true } });
        }, 10);
      };
      setTimeout(
        () => server.emit({ toolCall: { functionCalls: [{ id: 'call_42', name: 'lookupConformanceCodeWord', args: {} }] } }),
        5,
      );
    };
    const result = await checkToolRoundTrip(target);
    expect(result).toMatchObject({ pass: true, status: 'pass' });
    expect(result.metrics).toMatchObject({ callIdPrefix: 'call', turnCompleteBeforeReply: true });
    // The built-in probe tool was added to the app's own declarations.
    const declared = lastServer().params.config.tools[0].functionDeclarations.map((d: any) => d.name);
    expect(declared).toEqual(['endSession', 'lookupConformanceCodeWord']);
  });

  it('tool-round-trip: fails without connecting when the probed tool is not declared', async () => {
    const result = await checkToolRoundTrip(target, { prompt: 'x', expectTool: 'notDeclared' });
    expect(result).toMatchObject({ pass: false, status: 'fail' });
    expect(result.detail).toContain("'notDeclared' is not declared");
    expect(fake.servers).toHaveLength(0);
  });
});

describe('provider-contract canaries', () => {
  /** A fake server that enforces whatever thinking contract it is given. */
  function serverWithThinkingContract(accepts: (level: string | undefined) => boolean) {
    return (server: any) => {
      const level = server.params.config.thinkingConfig?.thinkingLevel as string | undefined;
      if (accepts(level)) server.accept();
      else server.reject(1007, 'Thinking level is not supported for this model.');
    };
  }

  it('passes when the server behaves as the registry says', async () => {
    fake.onConnect = serverWithThinkingContract((level) => level === undefined);
    const result = await canaryThinkingContract(KEY, 'gemini-3.8-live');
    expect(result).toMatchObject({ pass: true, status: 'pass', name: 'thinking-contract:gemini-3.8-live' });
    expect(result.metrics).toEqual({
      none: 'accepted', MINIMAL: 'rejected(1007)', LOW: 'rejected(1007)', MEDIUM: 'rejected(1007)', HIGH: 'rejected(1007)',
    });
    // One setup attempt per request, each sending exactly what was asked.
    expect(fake.servers.map((s) => s.params.config.thinkingConfig?.thinkingLevel)).toEqual([
      undefined, 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH',
    ]);
  });

  it('reports CONTRACT CHANGED, not a plain failure, when the server flips', async () => {
    // Suppose gemini-3.8-live starts accepting LOW.
    fake.onConnect = serverWithThinkingContract((level) => level === undefined || level === 'LOW');
    const result = await canaryThinkingContract(KEY, 'gemini-3.8-live');
    expect(result.status).toBe('contract-changed');
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('PROVIDER CONTRACT CHANGED');
    expect(result.detail).toContain('LOW: registry says rejected, server accepted');
    expect(result.detail).toContain('src/services/liveModels.ts');
  });

  it('reports CONTRACT CHANGED when extended-thinking stops rejecting MINIMAL', async () => {
    fake.onConnect = serverWithThinkingContract((level) => level !== undefined);
    const result = await canaryThinkingContract(KEY, 'gemini-3.8-live-extended-thinking');
    expect(result.status).toBe('contract-changed');
    expect(result.detail).toContain('MINIMAL: registry says rejected, server accepted');
  });

  it('treats a non-1007 close as inconclusive (fail), not as a contract change', async () => {
    fake.onConnect = (server) => server.reject(1011, 'Internal error');
    const result = await canaryThinkingContract(KEY, 'gemini-3.8-live');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('could not measure');
  });

  it('skips a model the registry does not know', async () => {
    const result = await canaryThinkingContract(KEY, 'gemini-99-live-future');
    expect(result).toMatchObject({ status: 'skipped', pass: true });
    expect(fake.servers).toHaveLength(0);
  });

  it('tool-behavior canary: BLOCKING is rejected only by async-only models', async () => {
    const enforce = (server: any) => {
      const behavior = server.params.config.tools?.[0]?.functionDeclarations?.[0]?.behavior;
      const asyncOnly = server.params.model === 'gemini-3.8-live-extended-thinking';
      if (asyncOnly && behavior === 'BLOCKING') server.reject(1007, 'BLOCKING function calls are not supported for this model.');
      else server.accept();
    };
    fake.onConnect = enforce;
    expect((await canaryToolBehaviorContract(KEY, 'gemini-3.8-live-extended-thinking')).status).toBe('pass');
    expect((await canaryToolBehaviorContract(KEY, 'gemini-3.8-live')).status).toBe('pass');
    // The async-only model is sent a thinking level it accepts, so only the tool is under test.
    expect(fake.servers[0].params.config.thinkingConfig).toEqual(resolveThinkingConfig('gemini-3.8-live-extended-thinking', 'auto'));

    fake.onConnect = (server) => server.accept();
    const flipped = await canaryToolBehaviorContract(KEY, 'gemini-3.8-live-extended-thinking');
    expect(flipped.status).toBe('contract-changed');
  });
});

// ---------------------------------------------------------------------------
// runLiveConformance
// ---------------------------------------------------------------------------

describe('runLiveConformance', () => {
  const profile = { name: 'demo-app', systemInstruction: 'You are a demo.' };

  it('builds the connect config with the same builder useSession uses', () => {
    const built = buildProfileConnectConfig({
      ...profile,
      endOfSpeechSensitivity: 'LOW',
      endOfSpeechSilenceMs: 2500,
    });
    expect(built.model).toBe('gemini-3.8-live');
    expect(built.config).toEqual(
      buildLiveConnectConfig({
        systemInstruction: profile.systemInstruction,
        endOfSpeechSensitivity: 'LOW',
        endOfSpeechSilenceMs: 2500,
      }),
    );
  });

  it('uses a direct-connect config verbatim when the profile supplies one', () => {
    const connectConfig = { responseModalities: [] };
    expect(buildProfileConnectConfig({ ...profile, model: 'x', connectConfig })).toEqual({ model: 'x', config: connectConfig });
  });

  it('runs the chosen checks in order and reports', async () => {
    fake.onConnect = talkativeServer();
    const seen: string[] = [];
    const report = await runLiveConformance(profile, {
      apiKey: KEY,
      checks: ['setup', 'text-turn', 'context-compression'],
      onResult: (r) => seen.push(r.name),
    });
    expect(seen).toEqual(['setup', 'text-turn', 'context-compression']);
    expect(report).toMatchObject({ profile: 'demo-app', model: 'gemini-3.8-live', ok: true });
    expect(report.counts).toEqual({ pass: 3, warn: 0, skipped: 0, fail: 0, 'contract-changed': 0 });
    expect(() => assertLiveConformance(report)).not.toThrow();
    const text = formatLiveConformanceReport(report);
    expect(text).toContain('Live conformance: demo-app on gemini-3.8-live');
    expect(text).toContain('OK: 3 passed');
    expect(text).not.toContain(KEY);
  });

  it('reports an invalid profile as a failed setup without opening a connection', async () => {
    const report = await runLiveConformance(
      { ...profile, model: 'gemini-3.8-live', thinkingLevel: 'MINIMAL' },
      { apiKey: KEY },
    );
    expect(fake.servers).toHaveLength(0);
    expect(report.ok).toBe(false);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({ name: 'setup', status: 'fail' });
    expect(report.results[0].detail).toContain("does not accept a thinking level");
    expect(() => assertLiveConformance(report)).toThrow(/Live conformance failed for demo-app on gemini-3.8-live: setup/);
  });

  it('a rejected setup makes the report not ok and names the check', async () => {
    fake.onConnect = (server) => server.reject(1007, 'Unsupported voice.');
    const report = await runLiveConformance(profile, { apiKey: KEY, checks: ['setup'] });
    expect(report.ok).toBe(false);
    expect(formatLiveConformanceReport(report)).toContain('FAIL');
    expect(formatLiveConformanceReport(report)).toContain('Unsupported voice.');
  });

  it('requires a key and has a sensible default check list', async () => {
    await expect(runLiveConformance(profile, { apiKey: '' })).rejects.toThrow(/needs options.apiKey/);
    expect(DEFAULT_LIVE_CHECKS).toContain('ephemeral-token');
    expect(DEFAULT_LIVE_CHECKS).not.toContain('thinking-contract');
  });
});
