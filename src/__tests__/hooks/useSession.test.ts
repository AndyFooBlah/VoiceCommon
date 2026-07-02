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
 * Tests for the useSession hook — VoiceCommon's core session lifecycle engine.
 *
 * Covers:
 *   - Initial state: DISCONNECTED, empty messages, null sessionId/error, not recording
 *   - startSession: Firestore session creation, mixer start, Gemini connection, status transitions
 *   - startSession overrides: overrideInstruction and overrideAutoGreetText passed through
 *   - startSession failure paths: mixer error (no orphaned session), Gemini connect error
 *   - stopSession: finalizes as 'completed', archives audio, closes Gemini, calls onSessionEnd
 *   - stopSession when not recording: no-op
 *   - Session resumption on unexpected disconnect: reconnect with the resumption
 *     handle WITHOUT restarting the recorder (one continuous recording); halt and
 *     finalize only after repeated resume failures
 *   - Tool call dispatch: onToolCall called, sendToolResponse sent with result
 *   - endSession tool: sends tool response then calls onSessionEndRequest
 *   - speechConfig: passed through to Gemini config
 *   - sessionsCollection: custom path used in createSession and finalizeSession
 *   - onBotSpeaking: called true on audio, false when sources drain
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { ConnectionStatus } from '../../types';
import { useSession } from '../../hooks/useSession';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be defined before vi.mock() hoisting
// ---------------------------------------------------------------------------

const {
  capturedCallbacks,
  mockLiveSession,
  mockLiveConnect,
  mockMixerStart,
  mockMixerStop,
  mockMixerFlush,
  mockMixedDest,
  mockPlaybackContext,
  mockInputContext,
  mockWorkletNode,
  storageSpies,
} = vi.hoisted(() => {
  // Capture Gemini Live callbacks so tests can fire them directly
  const capturedCallbacks: { current: Record<string, (...args: unknown[]) => unknown> } = {
    current: {},
  };

  // Stub AudioWorkletNode port — reused across tests
  const mockWorkletNode = {
    port: { onmessage: null as ((e: MessageEvent) => void) | null },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  // Minimal MediaStreamAudioDestinationNode stub
  const mockMixedDest = {
    stream: { getTracks: () => [] },
  };

  // Playback AudioContext stub — simulates 24kHz context
  const mockPlaybackContext = {
    sampleRate: 24000,
    currentTime: 0,
    state: 'running' as AudioContextState,
    destination: {},
    createBuffer: vi.fn().mockReturnValue({
      copyToChannel: vi.fn(),
      duration: 0.1,
      length: 2400,
    }),
    createBufferSource: vi.fn().mockReturnValue({
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
      addEventListener: vi.fn(),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };

  // Input AudioContext stub (16kHz) with AudioWorklet support
  const mockInputContext = {
    sampleRate: 16000,
    destination: {},
    currentTime: 0,
    createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
    audioWorklet: {
      addModule: vi.fn().mockResolvedValue(undefined),
    },
  };

  // Gemini Live session stub
  const mockLiveSession = {
    close: vi.fn(),
    sendRealtimeInput: vi.fn().mockResolvedValue(undefined),
    sendToolResponse: vi.fn().mockResolvedValue(undefined),
  };

  // Gemini Live connect stub — captures callbacks and config and returns session.
  // Typed as `any` so tests can inspect callArgs.config without TS narrowing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockLiveConnect = vi.fn(async (args: any) => {
    capturedCallbacks.current = args.callbacks as Record<string, (...args: unknown[]) => unknown>;
    return mockLiveSession;
  });

  // Mixer stubs
  const mockMixerStart = vi.fn().mockResolvedValue(undefined);
  const mockMixerStop = vi.fn().mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));
  const mockMixerFlush = vi.fn().mockReturnValue(null);

  // Storage service stubs
  const storageSpies = {
    createSession: vi.fn().mockResolvedValue('session-abc'),
    finalizeSession: vi.fn().mockResolvedValue(undefined),
    archiveAudioToGCS: vi.fn().mockResolvedValue('https://storage.example.com/audio.webm'),
    syncTranscriptToFirestore: vi.fn().mockResolvedValue(undefined),
  };

  return {
    capturedCallbacks,
    mockLiveSession,
    mockLiveConnect,
    mockMixerStart,
    mockMixerStop,
    mockMixerFlush,
    mockMixedDest,
    mockPlaybackContext,
    mockInputContext,
    mockWorkletNode,
    storageSpies,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return { live: { connect: mockLiveConnect } };
  }),
  Modality: { AUDIO: 'AUDIO', TEXT: 'TEXT' },
  Type: { OBJECT: 'object', STRING: 'string', NUMBER: 'number' },
  ThinkingLevel: { MINIMAL: 'MINIMAL', LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', NONE: 'NONE' },
  StartSensitivity: { START_SENSITIVITY_HIGH: 'START_SENSITIVITY_HIGH' },
  EndSensitivity: { END_SENSITIVITY_HIGH: 'END_SENSITIVITY_HIGH', END_SENSITIVITY_LOW: 'END_SENSITIVITY_LOW' },
}));

vi.mock('../../hooks/useAudioMixer', () => ({
  useAudioMixer: () => ({
    get stream() { return { getTracks: () => [], getAudioTracks: () => [] }; },
    get playbackContext() { return mockPlaybackContext; },
    get inputContext() { return mockInputContext; },
    get mixedDest() { return mockMixedDest; },
    start: mockMixerStart,
    stop: mockMixerStop,
    flush: mockMixerFlush,
  }),
}));

vi.mock('../../services/storage', () => storageSpies);

vi.mock('../../services/config', () => ({
  getConfig: vi.fn(() => ({ geminiApiKey: 'test-api-key', firebase: {} })),
  initializeVoiceCommon: vi.fn(),
  mintLiveToken: vi.fn().mockResolvedValue({
    token: 'test-ephemeral-token',
    expireTime: '2099-01-01T00:00:00.000Z',
  }),
}));

// AudioWorkletNode is not available in jsdom — install a global stub.
// Must be a regular function (not arrow) so it's constructable via `new`.
vi.stubGlobal(
  'AudioWorkletNode',
  vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.port = mockWorkletNode.port;
    this.connect = mockWorkletNode.connect;
    this.disconnect = mockWorkletNode.disconnect;
  }),
);

// URL.createObjectURL / revokeObjectURL are not in jsdom
vi.stubGlobal('URL', {
  ...URL,
  createObjectURL: vi.fn(() => 'blob:mock-url'),
  revokeObjectURL: vi.fn(),
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS = {
  userId: 'user-123',
  systemInstruction: 'You are a helpful assistant.',
  autoGreetText: 'Hello! How can I help?',
};

function renderSession(overrides: Partial<typeof DEFAULT_OPTIONS & {
  tools?: any[];
  onToolCall?: (name: string, args: Record<string, unknown>) => Promise<string>;
  onSessionEndRequest?: () => void;
  onSessionEnd?: () => void;
  onBotSpeaking?: (speaking: boolean) => void;
  speechConfig?: any;
  endOfSpeechSilenceMs?: number;
  endOfSpeechSensitivity?: 'HIGH' | 'LOW';
  manualTurnControl?: boolean;
  sessionsCollection?: string;
  archiveAudio?: (blob: Blob, userId: string, sessionId: string) => Promise<string>;
}> = {}) {
  return renderHook(() => useSession({ ...DEFAULT_OPTIONS, ...overrides }));
}

// ---------------------------------------------------------------------------
// beforeEach: reset all mocks to clean defaults
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  capturedCallbacks.current = {};

  // Re-apply default return values after clearAllMocks
  storageSpies.createSession.mockResolvedValue('session-abc');
  storageSpies.finalizeSession.mockResolvedValue(undefined);
  storageSpies.archiveAudioToGCS.mockResolvedValue('https://storage.example.com/audio.webm');
  storageSpies.syncTranscriptToFirestore.mockResolvedValue(undefined);

  mockMixerStart.mockResolvedValue(undefined);
  mockMixerStop.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));
  mockMixerFlush.mockReturnValue(null);

  mockInputContext.audioWorklet.addModule.mockResolvedValue(undefined);
  mockInputContext.createMediaStreamSource.mockReturnValue({ connect: vi.fn() });

  mockWorkletNode.connect.mockReset();
  mockWorkletNode.disconnect.mockReset();
  mockWorkletNode.port.onmessage = null;

  // Reset playback context buffer source mock
  mockPlaybackContext.createBufferSource.mockReturnValue({
    buffer: null,
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as (() => void) | null,
    addEventListener: vi.fn(),
  });

  mockLiveConnect.mockImplementation(async ({ callbacks }: { callbacks: Record<string, unknown> }) => {
    capturedCallbacks.current = callbacks as Record<string, (...args: unknown[]) => unknown>;
    return mockLiveSession;
  });

  mockLiveSession.close.mockReset();
  mockLiveSession.sendRealtimeInput.mockResolvedValue(undefined);
  mockLiveSession.sendToolResponse.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Convenience: start a session and await completion
// ---------------------------------------------------------------------------

async function startSession(result: ReturnType<typeof renderSession>['result']) {
  await act(async () => {
    await result.current.startSession();
  });
}

// ===========================================================================
// Test suites
// ===========================================================================

describe('initial state', () => {
  it('starts DISCONNECTED', () => {
    const { result } = renderSession();
    expect(result.current.connectionStatus).toBe(ConnectionStatus.DISCONNECTED);
  });

  it('starts with empty messages array', () => {
    const { result } = renderSession();
    expect(result.current.messages).toEqual([]);
  });

  it('starts with null sessionId', () => {
    const { result } = renderSession();
    expect(result.current.sessionId).toBeNull();
  });

  it('starts with null error', () => {
    const { result } = renderSession();
    expect(result.current.error).toBeNull();
  });

  it('starts with isRecording=false', () => {
    const { result } = renderSession();
    expect(result.current.isRecording).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('startSession', () => {
  it('creates a Firestore session document with the correct userId', async () => {
    const { result } = renderSession();
    await startSession(result);

    expect(storageSpies.createSession).toHaveBeenCalledTimes(1);
    expect(storageSpies.createSession).toHaveBeenCalledWith('user-123', 'sessions', undefined);
  });

  it('sets sessionId from Firestore response', async () => {
    const { result } = renderSession();
    await startSession(result);

    expect(result.current.sessionId).toBe('session-abc');
  });

  it('starts the audio mixer', async () => {
    const { result } = renderSession();
    await startSession(result);

    expect(mockMixerStart).toHaveBeenCalledTimes(1);
  });

  it('connects to Gemini Live API', async () => {
    const { result } = renderSession();
    await startSession(result);

    expect(mockLiveConnect).toHaveBeenCalledTimes(1);
  });

  it('passes the system instruction to Gemini', async () => {
    const { result } = renderSession();
    await startSession(result);

    const callArgs = mockLiveConnect.mock.calls[0][0];
    const systemPart = callArgs.config.systemInstruction.parts[0].text;
    expect(systemPart).toBe('You are a helpful assistant.');
  });

  it('sets status to CONNECTED after successful start', async () => {
    const { result } = renderSession();
    await startSession(result);

    expect(result.current.connectionStatus).toBe(ConnectionStatus.CONNECTED);
  });

  it('sets isRecording=true after successful start', async () => {
    const { result } = renderSession();
    await startSession(result);

    expect(result.current.isRecording).toBe(true);
  });

  it('sends the autoGreetText to Gemini after connecting', async () => {
    const { result } = renderSession();
    await startSession(result);

    expect(mockLiveSession.sendRealtimeInput).toHaveBeenCalledWith({
      text: 'Hello! How can I help?',
    });
  });

  it('does not send greeting when autoGreetText is not provided', async () => {
    const { result } = renderSession({ autoGreetText: undefined });
    await startSession(result);

    expect(mockLiveSession.sendRealtimeInput).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.any(String) }),
    );
  });

  it('registers the endSession tool in addition to caller-provided tools', async () => {
    const customTool = { name: 'myTool', description: 'My tool', parameters: {} };
    const { result } = renderSession({ tools: [customTool as any] });
    await startSession(result);

    const callArgs = mockLiveConnect.mock.calls[0][0];
    const declarations = callArgs.config.tools[0].functionDeclarations;
    const names = declarations.map((d: any) => d.name);
    expect(names).toContain('endSession');
    expect(names).toContain('myTool');
  });

  it('uses AUDIO response modality', async () => {
    const { result } = renderSession();
    await startSession(result);

    const callArgs = mockLiveConnect.mock.calls[0][0];
    expect(callArgs.config.responseModalities).toContain('AUDIO');
  });

  it('wires up onmessage, onerror, and onclose callbacks', async () => {
    const { result } = renderSession();
    await startSession(result);

    expect(typeof capturedCallbacks.current.onmessage).toBe('function');
    expect(typeof capturedCallbacks.current.onerror).toBe('function');
    expect(typeof capturedCallbacks.current.onclose).toBe('function');
  });

  it('is a no-op when already recording', async () => {
    const { result } = renderSession();
    await startSession(result);
    const callsBefore = mockLiveConnect.mock.calls.length;

    await act(async () => {
      await result.current.startSession();
    });

    expect(mockLiveConnect.mock.calls.length).toBe(callsBefore);
  });
});

// ---------------------------------------------------------------------------
describe('startSession with overrides', () => {
  it('uses overrideInstruction instead of options.systemInstruction', async () => {
    const { result } = renderSession();

    await act(async () => {
      await result.current.startSession('Override system instruction');
    });

    const callArgs = mockLiveConnect.mock.calls[0][0];
    const systemPart = callArgs.config.systemInstruction.parts[0].text;
    expect(systemPart).toBe('Override system instruction');
  });

  it('uses overrideAutoGreetText instead of options.autoGreetText', async () => {
    const { result } = renderSession();

    await act(async () => {
      await result.current.startSession(undefined, 'Custom greeting override');
    });

    expect(mockLiveSession.sendRealtimeInput).toHaveBeenCalledWith({
      text: 'Custom greeting override',
    });
  });

  it('suppresses greeting when overrideAutoGreetText is empty string', async () => {
    const { result } = renderSession();

    await act(async () => {
      await result.current.startSession(undefined, '');
    });

    // Empty string should not be sent
    expect(mockLiveSession.sendRealtimeInput).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: '' }),
    );
  });
});

// ---------------------------------------------------------------------------
describe('startSession failure paths', () => {
  it('creates a Firestore session then errors without connecting Gemini when mixer.start() fails', async () => {
    // The hook calls createSession() BEFORE mixer.start(), so a session doc is
    // created. When the mixer then fails, the session is finalized as 'interrupted'.
    mockMixerStart.mockRejectedValueOnce(new Error('Microphone denied'));

    const { result } = renderSession();
    await startSession(result);

    // Session doc was created but then finalized as interrupted
    expect(storageSpies.createSession).toHaveBeenCalledTimes(1);
    expect(storageSpies.finalizeSession).toHaveBeenCalledWith(
      'session-abc',
      'interrupted',
      0,
      undefined,
      'sessions',
    );
    expect(result.current.connectionStatus).toBe(ConnectionStatus.ERROR);
    expect(result.current.isRecording).toBe(false);
  });

  it('sets error message when mixer.start() fails', async () => {
    mockMixerStart.mockRejectedValueOnce(new Error('NotAllowedError'));

    const { result } = renderSession();
    await startSession(result);

    expect(result.current.error).toBeTruthy();
    expect(result.current.error).toContain('Failed to start session');
  });

  it('finalizes orphaned session as interrupted when Gemini connect() fails', async () => {
    mockLiveConnect.mockRejectedValueOnce(new Error('Gemini WebSocket failed'));

    const { result } = renderSession();
    await startSession(result);

    expect(storageSpies.createSession).toHaveBeenCalledTimes(1);
    expect(storageSpies.finalizeSession).toHaveBeenCalledWith(
      'session-abc',
      'interrupted',
      0,
      undefined,
      'sessions',
    );
  });

  it('sets status to ERROR when Gemini connect() fails', async () => {
    mockLiveConnect.mockRejectedValueOnce(new Error('Gemini WebSocket failed'));

    const { result } = renderSession();
    await startSession(result);

    expect(result.current.connectionStatus).toBe(ConnectionStatus.ERROR);
  });

  it('clears sessionId after Gemini connect failure', async () => {
    mockLiveConnect.mockRejectedValueOnce(new Error('Gemini WebSocket failed'));

    const { result } = renderSession();
    await startSession(result);

    expect(result.current.sessionId).toBeNull();
  });

  it('calls mixer.stop() to clean up after Gemini connect failure', async () => {
    mockLiveConnect.mockRejectedValueOnce(new Error('Gemini WebSocket failed'));

    const { result } = renderSession();
    await startSession(result);

    expect(mockMixerStop).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('stopSession', () => {
  it('is a no-op when not recording', async () => {
    const { result } = renderSession();
    await act(async () => {
      await result.current.stopSession();
    });

    expect(mockMixerStop).not.toHaveBeenCalled();
    expect(storageSpies.finalizeSession).not.toHaveBeenCalled();
  });

  it('closes the Gemini Live session', async () => {
    const { result } = renderSession();
    await startSession(result);
    await act(async () => {
      await result.current.stopSession();
    });

    expect(mockLiveSession.close).toHaveBeenCalledTimes(1);
  });

  it('calls mixer.stop()', async () => {
    const { result } = renderSession();
    await startSession(result);
    await act(async () => {
      await result.current.stopSession();
    });

    expect(mockMixerStop).toHaveBeenCalledTimes(1);
  });

  it('archives audio to GCS', async () => {
    const { result } = renderSession();
    await startSession(result);
    await act(async () => {
      await result.current.stopSession();
    });

    expect(storageSpies.archiveAudioToGCS).toHaveBeenCalledTimes(1);
    expect(storageSpies.archiveAudioToGCS).toHaveBeenCalledWith(
      expect.any(Blob),
      'user-123',
      'session-abc',
    );
  });

  it('finalizes session as completed with audio URL', async () => {
    const { result } = renderSession();
    await startSession(result);
    await act(async () => {
      await result.current.stopSession();
    });

    expect(storageSpies.finalizeSession).toHaveBeenCalledWith(
      'session-abc',
      'completed',
      expect.any(Number),
      'https://storage.example.com/audio.webm',
      'sessions',
    );
  });

  it('finalizes session as completed even when audio upload fails', async () => {
    storageSpies.archiveAudioToGCS.mockRejectedValueOnce(new Error('Upload failed'));

    const { result } = renderSession();
    await startSession(result);
    await act(async () => {
      await result.current.stopSession();
    });

    expect(storageSpies.finalizeSession).toHaveBeenCalledWith(
      'session-abc',
      'completed',
      expect.any(Number),
      undefined,
      'sessions',
    );
  });

  // Regression for LegacyBot #128: apps with Storage rules scoped to a different
  // path layout need to override the default `sessions/{userId}/*` upload path.
  it('calls archiveAudio override instead of default when provided', async () => {
    const archiveAudio = vi.fn().mockResolvedValue('https://custom.example/path.webm');
    const { result } = renderSession({ archiveAudio });

    await startSession(result);
    await act(async () => {
      await result.current.stopSession();
    });

    expect(archiveAudio).toHaveBeenCalledTimes(1);
    expect(archiveAudio).toHaveBeenCalledWith(
      expect.any(Blob),
      'user-123',
      'session-abc',
    );
    expect(storageSpies.archiveAudioToGCS).not.toHaveBeenCalled();
    expect(storageSpies.finalizeSession).toHaveBeenCalledWith(
      'session-abc',
      'completed',
      expect.any(Number),
      'https://custom.example/path.webm',
      'sessions',
    );
  });

  it('calls onSessionEnd callback after finalization', async () => {
    const onSessionEnd = vi.fn();
    const { result } = renderSession({ onSessionEnd });
    await startSession(result);
    await act(async () => {
      await result.current.stopSession();
    });

    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });

  it('sets isRecording=false', async () => {
    const { result } = renderSession();
    await startSession(result);
    await act(async () => {
      await result.current.stopSession();
    });

    expect(result.current.isRecording).toBe(false);
  });

  it('sets status to DISCONNECTED', async () => {
    const { result } = renderSession();
    await startSession(result);
    await act(async () => {
      await result.current.stopSession();
    });

    expect(result.current.connectionStatus).toBe(ConnectionStatus.DISCONNECTED);
  });
});

// ---------------------------------------------------------------------------
describe('session resumption on unexpected disconnect', () => {
  it('enables session resumption and context-window compression on connect', async () => {
    const { result } = renderSession();
    await startSession(result);

    const cfg = mockLiveConnect.mock.calls[0][0].config;
    expect(cfg.sessionResumption).toBeDefined();
    expect(cfg.contextWindowCompression).toBeDefined();
  });

  it('resumes the session on an unexpected disconnect without restarting the recorder', async () => {
    const { result } = renderSession();
    await startSession(result);
    const connectsBefore = mockLiveConnect.mock.calls.length; // initial connect
    const mixerStartsBefore = mockMixerStart.mock.calls.length; // recorder started once

    await act(async () => {
      capturedCallbacks.current.onclose?.({ code: 1011, wasClean: true });
      await new Promise((res) => setTimeout(res, 0));
    });

    // Reconnected (a new live.connect) but did NOT restart the recorder — the
    // recording must be one continuous file across the reconnect.
    expect(mockLiveConnect.mock.calls.length).toBe(connectsBefore + 1);
    expect(mockMixerStart.mock.calls.length).toBe(mixerStartsBefore);
    expect(result.current.connectionStatus).not.toBe(ConnectionStatus.ERROR);
  });

  it('passes the stored resumption handle when it resumes', async () => {
    const { result } = renderSession();
    await startSession(result);

    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        sessionResumptionUpdate: { resumable: true, newHandle: 'HANDLE-1' },
      });
    });
    await act(async () => {
      capturedCallbacks.current.onclose?.({ code: 1011, wasClean: true });
      await new Promise((res) => setTimeout(res, 0));
    });

    const resumeCall = mockLiveConnect.mock.calls[mockLiveConnect.mock.calls.length - 1][0];
    expect(resumeCall.config.sessionResumption).toEqual({ handle: 'HANDLE-1' });
  });

  it('does not resume when onclose fires during an intentional stopSession', async () => {
    const { result } = renderSession();
    await startSession(result);

    await act(async () => {
      await result.current.stopSession();
    });
    const connectCallCount = mockLiveConnect.mock.calls.length;

    await act(async () => {
      capturedCallbacks.current.onclose?.({ code: 1000, wasClean: true });
    });

    expect(mockLiveConnect.mock.calls.length).toBe(connectCallCount);
  });

  it('halts and finalizes after repeated resume failures', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderSession();
      await startSession(result);

      // Every subsequent (resume) connect fails.
      mockLiveConnect.mockRejectedValue(new Error('connect failed'));

      await act(async () => {
        capturedCallbacks.current.onclose?.({ code: 1011, wasClean: true });
        await vi.advanceTimersByTimeAsync(0);
      });
      // Two retries are scheduled ~1s apart; advance past them.
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); });

      expect(result.current.connectionStatus).toBe(ConnectionStatus.ERROR);
      expect(result.current.error).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
describe('Gemini onerror callback', () => {
  it('sets status to ERROR when onerror fires', async () => {
    const { result } = renderSession();
    await startSession(result);

    await act(async () => {
      capturedCallbacks.current.onerror?.(new ErrorEvent('error', { message: 'WS error' }));
    });

    expect(result.current.connectionStatus).toBe(ConnectionStatus.ERROR);
  });

  it('sets error message when onerror fires', async () => {
    const { result } = renderSession();
    await startSession(result);

    await act(async () => {
      capturedCallbacks.current.onerror?.(new ErrorEvent('error', { message: 'WS error' }));
    });

    expect(result.current.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('tool call dispatch', () => {
  it('calls onToolCall with the correct name and args', async () => {
    const onToolCall = vi.fn().mockResolvedValue('Tool result');
    const { result } = renderSession({ onToolCall });
    await startSession(result);

    const toolCallMessage = {
      toolCall: {
        functionCalls: [
          { id: 'call-1', name: 'myTool', args: { key: 'value' } },
        ],
      },
    };

    await act(async () => {
      capturedCallbacks.current.onmessage?.(toolCallMessage);
      // Flush the microtask queue for the async handleToolCalls function
      await new Promise((res) => setTimeout(res, 10));
    });

    expect(onToolCall).toHaveBeenCalledWith('myTool', { key: 'value' });
  });

  it('sends sendToolResponse with the result from onToolCall', async () => {
    const onToolCall = vi.fn().mockResolvedValue('Custom tool result');
    const { result } = renderSession({ onToolCall });
    await startSession(result);

    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        toolCall: {
          functionCalls: [{ id: 'call-2', name: 'myTool', args: {} }],
        },
      });
      // Flush microtask queue for async tool handler
      await new Promise((res) => setTimeout(res, 10));
    });

    expect(mockLiveSession.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        {
          id: 'call-2',
          name: 'myTool',
          response: { result: 'Custom tool result' },
        },
      ],
    });
  });

  it('falls back to default result when onToolCall is not provided', async () => {
    const { result } = renderSession({ onToolCall: undefined });
    await startSession(result);

    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        toolCall: {
          functionCalls: [{ id: 'call-3', name: 'unknownTool', args: {} }],
        },
      });
      await new Promise((res) => setTimeout(res, 10));
    });

    expect(mockLiveSession.sendToolResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        functionResponses: [
          expect.objectContaining({ name: 'unknownTool' }),
        ],
      }),
    );
  });

  it('adds a tool message to the messages array', async () => {
    const onToolCall = vi.fn().mockResolvedValue('ok');
    const { result } = renderSession({ onToolCall });
    await startSession(result);

    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        toolCall: {
          functionCalls: [{ id: 'call-4', name: 'myTool', args: { x: 1 } }],
        },
      });
      await new Promise((res) => setTimeout(res, 10));
    });

    const toolMsg = result.current.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.toolName).toBe('myTool');
    expect(toolMsg?.toolResult).toBe('ok');
  });

  it('does not send sendToolResponse if user interrupts before tool call finishes', async () => {
    let resolveTool: (res: string) => void = () => {};
    const toolPromise = new Promise<string>((resolve) => {
      resolveTool = resolve;
    });
    const onToolCall = vi.fn().mockReturnValue(toolPromise);
    const { result } = renderSession({ onToolCall });
    await startSession(result);

    // 1. Dispatch the tool call
    act(() => {
      capturedCallbacks.current.onmessage?.({
        toolCall: {
          functionCalls: [{ id: 'call-5', name: 'slowTool', args: {} }],
        },
      });
    });

    // Verify onToolCall was initiated but hasn't resolved
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(mockLiveSession.sendToolResponse).not.toHaveBeenCalled();

    // 2. User interrupts while tool is in-flight
    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        serverContent: { interrupted: true },
      });
    });

    // 3. Resolve the tool call
    await act(async () => {
      resolveTool('tool result after interrupt');
      // Flush microtask queue
      await new Promise((res) => setTimeout(res, 10));
    });

    // 4. Verify sendToolResponse was NOT called
    expect(mockLiveSession.sendToolResponse).not.toHaveBeenCalled();

    // 5. Verify the tool message is still added to the messages array with the result
    const toolMsg = result.current.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.toolName).toBe('slowTool');
    expect(toolMsg?.toolResult).toBe('tool result after interrupt');
  });
});

// ---------------------------------------------------------------------------
describe('endSession tool', () => {
  it('sends sendToolResponse with result=ok before ending', async () => {
    const onSessionEndRequest = vi.fn();
    const { result } = renderSession({ onSessionEndRequest });
    await startSession(result);

    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        toolCall: {
          functionCalls: [{ id: 'end-call-1', name: 'endSession', args: {} }],
        },
      });
      await new Promise((res) => setTimeout(res, 10));
    });

    expect(mockLiveSession.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        { id: 'end-call-1', name: 'endSession', response: { result: 'ok' } },
      ],
    });
  });

  it('calls onSessionEndRequest after sending tool response', async () => {
    const onSessionEndRequest = vi.fn();
    const { result } = renderSession({ onSessionEndRequest });
    await startSession(result);

    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        toolCall: {
          functionCalls: [{ id: 'end-call-2', name: 'endSession', args: {} }],
        },
      });
      await new Promise((res) => setTimeout(res, 10));
    });

    expect(onSessionEndRequest).toHaveBeenCalledTimes(1);
  });

  it('does not call onToolCall for the endSession tool', async () => {
    const onToolCall = vi.fn().mockResolvedValue('unused');
    const onSessionEndRequest = vi.fn();
    const { result } = renderSession({ onToolCall, onSessionEndRequest });
    await startSession(result);

    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        toolCall: {
          functionCalls: [{ id: 'end-call-3', name: 'endSession', args: {} }],
        },
      });
      await new Promise((res) => setTimeout(res, 10));
    });

    expect(onToolCall).not.toHaveBeenCalled();
  });

  it("flushes the bot's in-progress goodbye to the transcript before ending", async () => {
    // Reproduces the bug where the bot's final reply was missing from the
    // raw transcript: Gemini delivers transcription chunks via
    // outputTranscription, then calls endSession before turnComplete fires.
    // Without explicit sealing, currentBotTurnRef.current is dropped.
    const onSessionEndRequest = vi.fn();
    const { result } = renderSession({ onSessionEndRequest });
    await startSession(result);

    await act(async () => {
      // Bot streams the goodbye in two chunks
      capturedCallbacks.current.onmessage?.({
        serverContent: { outputTranscription: { text: 'Talk to you' } },
      });
      capturedCallbacks.current.onmessage?.({
        serverContent: { outputTranscription: { text: ' next time!' } },
      });
      // Bot calls endSession BEFORE turnComplete arrives (the failure mode)
      capturedCallbacks.current.onmessage?.({
        toolCall: {
          functionCalls: [{ id: 'end-call-bye', name: 'endSession', args: {} }],
        },
      });
      await new Promise((res) => setTimeout(res, 10));
    });

    // syncTranscriptToFirestore should have been called with the bot's
    // accumulated text — this is what the user sees in the saved transcript.
    const calls = storageSpies.syncTranscriptToFirestore.mock.calls;
    const allEntries = calls.flatMap((c) => c[1] as Array<{ role: string; text: string }>);
    const botEntries = allEntries.filter((e) => e.role === 'bot');
    expect(botEntries.length).toBeGreaterThan(0);
    expect(botEntries[botEntries.length - 1].text).toBe('Talk to you next time!');
  });

  it("flushes the bot's in-progress turn when stopSession is called manually", async () => {
    // Defence-in-depth coverage: even if the bot is mid-sentence and the
    // user hits the manual stop button, whatever was already transcribed
    // should land in the persistent transcript.
    const { result } = renderSession({});
    await startSession(result);

    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        serverContent: { outputTranscription: { text: 'I was just about to' } },
      });
      await new Promise((res) => setTimeout(res, 10));
    });

    await act(async () => {
      await result.current.stopSession();
    });

    const calls = storageSpies.syncTranscriptToFirestore.mock.calls;
    const allEntries = calls.flatMap((c) => c[1] as Array<{ role: string; text: string }>);
    const botEntries = allEntries.filter((e) => e.role === 'bot');
    expect(botEntries.length).toBeGreaterThan(0);
    expect(botEntries[botEntries.length - 1].text).toBe('I was just about to');
  });
});

// ---------------------------------------------------------------------------
describe('speechConfig', () => {
  it('passes speechConfig to Gemini config when provided', async () => {
    const speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } };
    const { result } = renderSession({ speechConfig: speechConfig as any });
    await startSession(result);

    const callArgs = mockLiveConnect.mock.calls[0][0];
    expect(callArgs.config.speechConfig).toEqual(speechConfig);
  });

  it('does not include speechConfig in Gemini config when not provided', async () => {
    const { result } = renderSession({ speechConfig: undefined });
    await startSession(result);

    const callArgs = mockLiveConnect.mock.calls[0][0];
    expect(callArgs.config).not.toHaveProperty('speechConfig');
  });
});

// ---------------------------------------------------------------------------
describe('endOfSpeechSilenceMs', () => {
  it('sets silenceDurationMs on automaticActivityDetection when provided', async () => {
    const { result } = renderSession({ endOfSpeechSilenceMs: 2500 });
    await startSession(result);

    const callArgs = mockLiveConnect.mock.calls[0][0];
    expect(
      callArgs.config.realtimeInputConfig.automaticActivityDetection.silenceDurationMs,
    ).toBe(2500);
  });

  it('omits silenceDurationMs when not provided (uses API default)', async () => {
    const { result } = renderSession({ endOfSpeechSilenceMs: undefined });
    await startSession(result);

    const callArgs = mockLiveConnect.mock.calls[0][0];
    expect(
      callArgs.config.realtimeInputConfig.automaticActivityDetection,
    ).not.toHaveProperty('silenceDurationMs');
  });
});

// ---------------------------------------------------------------------------
describe('endOfSpeechSensitivity', () => {
  it('defaults to HIGH end-of-speech sensitivity', async () => {
    const { result } = renderSession({});
    await startSession(result);

    const callArgs = mockLiveConnect.mock.calls[0][0];
    expect(
      callArgs.config.realtimeInputConfig.automaticActivityDetection.endOfSpeechSensitivity,
    ).toBe('END_SENSITIVITY_HIGH');
  });

  it('uses LOW end-of-speech sensitivity when requested', async () => {
    const { result } = renderSession({ endOfSpeechSensitivity: 'LOW' });
    await startSession(result);

    const callArgs = mockLiveConnect.mock.calls[0][0];
    expect(
      callArgs.config.realtimeInputConfig.automaticActivityDetection.endOfSpeechSensitivity,
    ).toBe('END_SENSITIVITY_LOW');
  });
});

// ---------------------------------------------------------------------------
describe('manualTurnControl', () => {
  it('disables server automatic activity detection when enabled', async () => {
    const { result } = renderSession({ manualTurnControl: true });
    await startSession(result);

    const callArgs = mockLiveConnect.mock.calls[0][0];
    expect(callArgs.config.realtimeInputConfig.automaticActivityDetection).toEqual({
      disabled: true,
    });
  });

  it('uses server VAD (not disabled) when manualTurnControl is off', async () => {
    const { result } = renderSession({ manualTurnControl: false });
    await startSession(result);

    const callArgs = mockLiveConnect.mock.calls[0][0];
    expect(
      callArgs.config.realtimeInputConfig.automaticActivityDetection.disabled,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('sessionsCollection', () => {
  it('passes custom sessionsCollection to createSession', async () => {
    const { result } = renderSession({ sessionsCollection: 'families/fam-1/sessions' });
    await startSession(result);

    expect(storageSpies.createSession).toHaveBeenCalledWith(
      'user-123',
      'families/fam-1/sessions',
      undefined,
    );
  });

  it('passes custom sessionsCollection to finalizeSession on stop', async () => {
    const { result } = renderSession({ sessionsCollection: 'families/fam-1/sessions' });
    await startSession(result);
    await act(async () => {
      await result.current.stopSession();
    });

    expect(storageSpies.finalizeSession).toHaveBeenCalledWith(
      'session-abc',
      'completed',
      expect.any(Number),
      expect.anything(),
      'families/fam-1/sessions',
    );
  });

  it('passes custom sessionsCollection to finalizeSession on Gemini connect failure', async () => {
    mockLiveConnect.mockRejectedValueOnce(new Error('connect fail'));
    const { result } = renderSession({ sessionsCollection: 'orgs/org-1/sessions' });
    await startSession(result);

    expect(storageSpies.finalizeSession).toHaveBeenCalledWith(
      'session-abc',
      'interrupted',
      0,
      undefined,
      'orgs/org-1/sessions',
    );
  });

  it('uses default sessions collection when not specified', async () => {
    const { result } = renderSession();
    await startSession(result);

    expect(storageSpies.createSession).toHaveBeenCalledWith('user-123', 'sessions', undefined);
  });
});

// ---------------------------------------------------------------------------
describe('onBotSpeaking callback', () => {
  it('calls onBotSpeaking(true) when a bot audio chunk arrives', async () => {
    const onBotSpeaking = vi.fn();

    // Make createBufferSource return a controllable source
    const mockSource = {
      buffer: null as any,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    };
    mockPlaybackContext.createBufferSource.mockReturnValue(mockSource);

    const { result } = renderSession({ onBotSpeaking });
    await startSession(result);

    // Simulate Gemini sending a PCM audio chunk (base64-encoded silence)
    const silentPcm = btoa(String.fromCharCode(...new Uint8Array(48)));
    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        serverContent: {
          modelTurn: {
            parts: [
              { inlineData: { mimeType: 'audio/pcm;rate=24000', data: silentPcm } },
            ],
          },
        },
      });
    });

    expect(onBotSpeaking).toHaveBeenCalledWith(true);
  });

  it('calls onBotSpeaking(false) when the source ends and no more audio is scheduled', async () => {
    const onBotSpeaking = vi.fn();

    // Reset currentTime to 0 so scheduleTimeRef ends up at 0.1 (buffer.duration)
    mockPlaybackContext.currentTime = 0;

    let capturedOnEnded: (() => void) | null = null;
    const mockSource = {
      buffer: null as any,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      set onended(fn: (() => void) | null) { capturedOnEnded = fn; },
      get onended() { return capturedOnEnded; },
    };
    mockPlaybackContext.createBufferSource.mockReturnValue(mockSource);

    const { result } = renderSession({ onBotSpeaking });
    await startSession(result);

    const silentPcm = btoa(String.fromCharCode(...new Uint8Array(48)));
    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        serverContent: {
          modelTurn: {
            parts: [
              { inlineData: { mimeType: 'audio/pcm;rate=24000', data: silentPcm } },
            ],
          },
        },
      });
    });

    // scheduleTimeRef is now 0.1 (startAt=0 + buffer.duration=0.1).
    // Advance currentTime past the scheduled end so the check passes:
    //   scheduleTimeRef (0.1) <= currentTime (1.0) + 0.05 → true → fires false
    mockPlaybackContext.currentTime = 1.0;

    // Trigger the onended handler
    await act(async () => {
      capturedOnEnded?.();
    });

    expect(onBotSpeaking).toHaveBeenCalledWith(false);
  });
});

// ---------------------------------------------------------------------------
describe('transcript sync', () => {
  it('syncs transcript to Firestore when bot turn completes', async () => {
    const { result } = renderSession();
    await startSession(result);

    await act(async () => {
      // Bot transcription arrives
      capturedCallbacks.current.onmessage?.({
        serverContent: { outputTranscription: { text: 'Hello there.' } },
      });
      // Turn complete flushes to transcript
      capturedCallbacks.current.onmessage?.({
        serverContent: { turnComplete: true },
      });
    });

    expect(storageSpies.syncTranscriptToFirestore).toHaveBeenCalled();
  });

  it('syncs the user turn to Firestore once the bot begins responding', async () => {
    const { result } = renderSession();
    await startSession(result);

    // User speech alone accumulates a live bubble but is not yet persisted —
    // the turn is only written to the transcript when it seals.
    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        serverContent: { inputTranscription: { text: 'I said something.' } },
      });
    });
    expect(storageSpies.syncTranscriptToFirestore).not.toHaveBeenCalled();

    // The bot beginning its reply seals the user turn → one transcript entry.
    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        serverContent: { outputTranscription: { text: 'Thanks for sharing.' } },
      });
    });
    expect(storageSpies.syncTranscriptToFirestore).toHaveBeenCalled();
  });

  it('appends user transcription to messages', async () => {
    const { result } = renderSession();
    await startSession(result);

    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        serverContent: { inputTranscription: { text: 'User said this.' } },
      });
    });

    const userMsg = result.current.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg?.text).toBe('User said this.');
  });

  it('accumulates multiple input chunks into a single growing user bubble', async () => {
    const { result } = renderSession();
    await startSession(result);

    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        serverContent: { inputTranscription: { text: 'I grew up ' } },
      });
      capturedCallbacks.current.onmessage?.({
        serverContent: { inputTranscription: { text: 'on a farm ' } },
      });
      capturedCallbacks.current.onmessage?.({
        serverContent: { inputTranscription: { text: 'in Ohio.' } },
      });
    });

    const userMsgs = result.current.messages.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].text).toBe('I grew up on a farm in Ohio.');
  });

  it('starts a fresh user bubble after the bot has spoken', async () => {
    const { result } = renderSession();
    await startSession(result);

    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        serverContent: { inputTranscription: { text: 'First answer.' } },
      });
      // Bot replies — seals the first user turn.
      capturedCallbacks.current.onmessage?.({
        serverContent: { outputTranscription: { text: 'Interesting!' } },
      });
      // User speaks again — new bubble, not appended to the first.
      capturedCallbacks.current.onmessage?.({
        serverContent: { inputTranscription: { text: 'Second answer.' } },
      });
    });

    const userMsgs = result.current.messages.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(2);
    expect(userMsgs[0].text).toBe('First answer.');
    expect(userMsgs[1].text).toBe('Second answer.');
  });

  it('appends bot output transcription to messages', async () => {
    const { result } = renderSession();
    await startSession(result);

    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        serverContent: { outputTranscription: { text: 'Bot said this.' } },
      });
    });

    const botMsg = result.current.messages.find((m) => m.role === 'bot');
    expect(botMsg).toBeDefined();
    expect(botMsg?.text).toContain('Bot said this.');
  });
});

// ---------------------------------------------------------------------------
describe('messages cleared on new session', () => {
  it('resets messages to empty when startSession is called again', async () => {
    const { result } = renderSession();
    await startSession(result);

    // Add a message
    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        serverContent: { inputTranscription: { text: 'Hello.' } },
      });
    });
    expect(result.current.messages.length).toBeGreaterThan(0);

    // Stop and restart
    await act(async () => {
      await result.current.stopSession();
    });
    await startSession(result);

    expect(result.current.messages).toEqual([]);
  });
});
