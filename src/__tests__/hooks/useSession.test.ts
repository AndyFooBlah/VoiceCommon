/**
 * Tests for the useSession hook — the core session lifecycle engine.
 *
 * Covers:
 *   - Initial state
 *   - startSession: Firestore session creation, Gemini connection, status transitions
 *   - startSession failure paths: mixer error (no orphaned session), Gemini error
 *   - stopSession: finalizes with 'completed', archives audio
 *   - flushPartialSession: finalizes with 'interrupted'
 *   - Gemini callbacks: onopen (CONNECTED), onerror (ERROR)
 *   - Function call handler: updateQuestionStatus
 *
 * External dependencies are fully mocked — no real network, Firestore, or audio.
 *
 * Known issue documented: if mixer.start() succeeds but Gemini connect() fails,
 * a Firestore session doc is created but never finalized (orphaned). See design.md §5.5 #5.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ConnectionStatus } from '../../types';
import { useSession } from '../../hooks/useSession';

// ---------------------------------------------------------------------------
// Hoisted mocks (must be defined before vi.mock() calls are hoisted)
// ---------------------------------------------------------------------------

const {
  capturedCallbacks,
  mockLiveSession,
  mockLiveConnect,
  mockMixerStart,
  mockMixerStop,
  mockMixerFlush,
  storageSpies,
  mockInputContext,
  mockWorkletNode,
} = vi.hoisted(() => {
  const capturedCallbacks: { current: Record<string, Function> } = { current: {} };

  const mockWorkletNode = {
    port: { onmessage: null as any },
    connect: vi.fn(),
  };

  const mockInputContext = {
    destination: {},
    createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
  };

  const mockLiveSession = {
    close: vi.fn(),
    sendRealtimeInput: vi.fn().mockResolvedValue(undefined),
    sendClientContent: vi.fn().mockResolvedValue(undefined),
    sendToolResponse: vi.fn().mockResolvedValue(undefined),
  };

  const mockLiveConnect = vi.fn(async ({ callbacks }: any) => {
    capturedCallbacks.current = callbacks;
    return mockLiveSession;
  });

  const mockMixerStart = vi.fn().mockResolvedValue(undefined);
  const mockMixerStop = vi.fn().mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));
  const mockMixerFlush = vi.fn().mockReturnValue(new Blob(['partial'], { type: 'audio/webm' }));

  const storageSpies = {
    createSession: vi.fn().mockResolvedValue('session-123'),
    finalizeSession: vi.fn().mockResolvedValue(undefined),
    archiveAudioToGCS: vi.fn().mockResolvedValue('https://storage.example.com/audio.webm'),
    syncTranscriptToFirestore: vi.fn().mockResolvedValue(undefined),
    updateQuestionStateInFirestore: vi.fn().mockResolvedValue(undefined),
    getCompletedSessionCount: vi.fn().mockResolvedValue(0),
    getPreviousSessionSummary: vi.fn().mockResolvedValue(undefined),
    getLastSessionDate: vi.fn().mockResolvedValue(undefined),
    logEmotionalObservation: vi.fn().mockResolvedValue(undefined),
    saveExtractedEvents: vi.fn().mockResolvedValue([]),
    saveFamilyEvents: vi.fn().mockResolvedValue(undefined),
    saveEngagementAssessment: vi.fn().mockResolvedValue(undefined),
    saveSuggestedQuestions: vi.fn().mockResolvedValue(undefined),
    getEvents: vi.fn().mockResolvedValue([]),
  };

  return {
    capturedCallbacks,
    mockLiveSession,
    mockLiveConnect,
    mockMixerStart,
    mockMixerStop,
    mockMixerFlush,
    storageSpies,
    mockInputContext,
    mockWorkletNode,
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
  FunctionDeclaration: {},
  LiveServerMessage: {},
}));

vi.mock('../../hooks/useAudioMixer', () => ({
  useAudioMixer: () => ({
    stream: { getTracks: () => [], getAudioTracks: () => [] },
    playbackContext: new AudioContext(),
    inputContext: mockInputContext,
    mixedDest: { stream: { getTracks: () => [] } },
    start: mockMixerStart,
    stop: mockMixerStop,
    flush: mockMixerFlush,
  }),
}));

// AudioWorkletNode is not available in jsdom — stub it globally.
// Must use a regular function (not arrow) so it can be called with `new`.
vi.stubGlobal(
  'AudioWorkletNode',
  vi.fn().mockImplementation(function (this: any) {
    this.port = mockWorkletNode.port;
    this.connect = mockWorkletNode.connect;
  }),
);

vi.mock('../../services/storage', () => storageSpies);

vi.mock('../../services/postSessionAnalysis', () => ({
  extractEvents: vi.fn().mockResolvedValue([]),
  assessEngagement: vi.fn().mockResolvedValue({
    sentiment: 'neutral',
    comfortScore: 50,
    speakingRatio: 0.5,
    avgResponseLength: 10,
    topicEngagement: {},
    flags: [],
  }),
  suggestQuestions: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../services/gemini', () => ({
  buildSystemInstruction: vi.fn().mockReturnValue('mock system instruction'),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeTimestamp = () => ({ seconds: 0, nanoseconds: 0, toDate: () => new Date() } as any);

const defaultDossier = {
  id: 'dossier-1',
  storytellerUid: 'storyteller-uid',
  storytellerName: 'Margaret',
  adminName: 'Andy',
  storytellerContext: 'Grew up in Ohio.',
  historicalContext: '1950s rural America.',
  familyTree: [],
  selectedVoice: 'Zephyr' as const,
  personality: 'empathetic' as const,
  interviewerNotes: '',
  createdAt: makeTimestamp(),
  updatedAt: makeTimestamp(),
};

const defaultOptions = {
  familyId: 'family-1',
  dossierId: 'dossier-1',
  storytellerUid: 'storyteller-uid',
  dossier: defaultDossier,
  questions: [],
  onQuestionUpdate: vi.fn(),
  onShowPhoto: vi.fn(),
};

function renderSession(overrides: Partial<typeof defaultOptions> = {}) {
  return renderHook(() => useSession({ ...defaultOptions, ...overrides }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  capturedCallbacks.current = {};
  // Re-apply default resolved values after clearAllMocks
  storageSpies.createSession.mockResolvedValue('session-123');
  storageSpies.finalizeSession.mockResolvedValue(undefined);
  storageSpies.archiveAudioToGCS.mockResolvedValue('https://storage.example.com/audio.webm');
  storageSpies.syncTranscriptToFirestore.mockResolvedValue(undefined);
  storageSpies.updateQuestionStateInFirestore.mockResolvedValue(undefined);
  storageSpies.getCompletedSessionCount.mockResolvedValue(0);
  storageSpies.getPreviousSessionSummary.mockResolvedValue(undefined);
  storageSpies.getLastSessionDate.mockResolvedValue(undefined);
  storageSpies.getEvents.mockResolvedValue([]);
  storageSpies.saveExtractedEvents.mockResolvedValue([]);
  storageSpies.saveFamilyEvents.mockResolvedValue(undefined);
  storageSpies.saveEngagementAssessment.mockResolvedValue(undefined);
  storageSpies.saveSuggestedQuestions.mockResolvedValue(undefined);
  storageSpies.logEmotionalObservation.mockResolvedValue(undefined);
  mockMixerStart.mockResolvedValue(undefined);
  mockMixerStop.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));
  mockMixerFlush.mockReturnValue(new Blob(['partial'], { type: 'audio/webm' }));
  mockInputContext.audioWorklet.addModule.mockResolvedValue(undefined);
  mockInputContext.createMediaStreamSource.mockReturnValue({ connect: vi.fn() });
  mockWorkletNode.connect.mockReset();
  mockWorkletNode.port.onmessage = null;
  mockLiveConnect.mockImplementation(async ({ callbacks }: any) => {
    capturedCallbacks.current = callbacks;
    return mockLiveSession;
  });
  mockLiveSession.close.mockReset();
  mockLiveSession.sendRealtimeInput.mockResolvedValue(undefined);
  mockLiveSession.sendClientContent.mockResolvedValue(undefined);
  mockLiveSession.sendToolResponse.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
describe('initial state', () => {
  it('starts DISCONNECTED with no messages', () => {
    const { result } = renderSession();
    expect(result.current.status).toBe(ConnectionStatus.DISCONNECTED);
    expect(result.current.messages).toEqual([]);
    expect(result.current.sessionId).toBeNull();
    expect(result.current.deviceError).toBeNull();
    expect(result.current.connectivityWarning).toBeNull();
    expect(result.current.isBotSpeaking).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('startSession', () => {
  it('sets status to CONNECTING immediately', async () => {
    const { result } = renderSession();

    // Don't await — check intermediate state
    let startPromise: Promise<void>;
    act(() => {
      startPromise = result.current.startSession();
    });
    expect(result.current.status).toBe(ConnectionStatus.CONNECTING);
    await act(async () => { await startPromise!; });
  });

  it('starts the audio mixer', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });
    expect(mockMixerStart).toHaveBeenCalledTimes(1);
  });

  it('creates a Firestore session document', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });

    expect(storageSpies.createSession).toHaveBeenCalledWith('family-1', 'dossier-1', 'storyteller-uid');
    expect(result.current.sessionId).toBe('session-123');
  });

  it('registers the PCM AudioWorklet module before connecting to Gemini (#76)', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });
    expect(mockInputContext.audioWorklet.addModule).toHaveBeenCalledWith('/pcm-processor.js');
    // addModule must be called before ai.live.connect
    const addModuleOrder = mockInputContext.audioWorklet.addModule.mock.invocationCallOrder[0];
    const connectOrder = mockLiveConnect.mock.invocationCallOrder[0];
    expect(addModuleOrder).toBeLessThan(connectOrder);
  });

  it('connects to Gemini Live API', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });

    expect(mockLiveConnect).toHaveBeenCalledTimes(1);
    const connectArgs = mockLiveConnect.mock.calls[0][0];
    expect(connectArgs.model).toMatch(/gemini/);
    expect(typeof connectArgs.callbacks.onopen).toBe('function');
    expect(typeof connectArgs.callbacks.onmessage).toBe('function');
    expect(typeof connectArgs.callbacks.onerror).toBe('function');
    expect(typeof connectArgs.callbacks.onclose).toBe('function');
  });

  it('fetches session history for context before connecting', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });

    expect(storageSpies.getCompletedSessionCount).toHaveBeenCalledWith('family-1', 'dossier-1');
    expect(storageSpies.getPreviousSessionSummary).toHaveBeenCalledWith('family-1', 'dossier-1');
  });

  it('sets a connectivity warning when latency is high', async () => {
    // Simulate slow getCompletedSessionCount
    storageSpies.getCompletedSessionCount.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(0), 600)),
    );

    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });

    expect(result.current.connectivityWarning).toBeTruthy();
    expect(result.current.connectivityWarning).toContain('slow');
  });

  it('does NOT create an orphaned Firestore session if mixer.start() fails', async () => {
    mockMixerStart.mockRejectedValueOnce(new Error('NotAllowedError: microphone access denied'));

    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });

    // No session should be created since mixer failed before createSession()
    expect(storageSpies.createSession).not.toHaveBeenCalled();
    expect(result.current.status).toBe(ConnectionStatus.ERROR);
  });

  it('sets deviceError on microphone permission denial', async () => {
    const err = new Error('microphone access denied');
    err.name = 'NotAllowedError';
    mockMixerStart.mockRejectedValueOnce(err);

    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });

    expect(result.current.deviceError).toBeTruthy();
    expect(result.current.status).toBe(ConnectionStatus.ERROR);
  });

  it('finalizes session as interrupted when Gemini connect() rejects (fixes #69)', async () => {
    // mixer succeeds → createSession() is called → then Gemini fails
    mockLiveConnect.mockRejectedValueOnce(new Error('Gemini connection failed'));

    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });

    // Session doc was created then finalized as 'interrupted' (not left orphaned)
    expect(storageSpies.createSession).toHaveBeenCalledTimes(1);
    expect(storageSpies.finalizeSession).toHaveBeenCalledWith(
      'family-1', 'dossier-1', 'session-123', 'interrupted', 0,
    );
    expect(result.current.status).toBe(ConnectionStatus.ERROR);
  });
});

// ---------------------------------------------------------------------------
describe('Gemini callbacks', () => {
  async function startAndGetCallbacks() {
    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });
    return { result, callbacks: capturedCallbacks.current };
  }

  it('sets status to CONNECTED when onopen fires', async () => {
    const { result, callbacks } = await startAndGetCallbacks();
    await act(async () => { callbacks.onopen?.(); });
    expect(result.current.status).toBe(ConnectionStatus.CONNECTED);
  });

  it('sets status to ERROR when onerror fires', async () => {
    const { result, callbacks } = await startAndGetCallbacks();
    await act(async () => {
      callbacks.onerror?.(new Error('Connection error'));
    });
    expect(result.current.status).toBe(ConnectionStatus.ERROR);
  });

  it('does not attempt to close session after onerror (session ref nulled immediately)', async () => {
    const { result, callbacks } = await startAndGetCallbacks();
    await act(async () => {
      callbacks.onerror?.(new Error('Connection error'));
    });
    // stopSession should not call session.close() since ref was already nulled by onerror
    await act(async () => { await result.current.stopSession(); });
    expect(mockLiveSession.close).not.toHaveBeenCalled();
  });

  it('sets status to ERROR on unexpected onclose (no prior user stop)', async () => {
    const { result, callbacks } = await startAndGetCallbacks();
    await act(async () => { callbacks.onclose?.(); });
    expect(result.current.status).toBe(ConnectionStatus.ERROR);
  });

  it('does not set ERROR on onclose after clean stopSession', async () => {
    const { result, callbacks } = await startAndGetCallbacks();
    await act(async () => { await result.current.stopSession(); });
    // onclose fires after stopSession clears the ref — should not re-set ERROR
    await act(async () => { callbacks.onclose?.(); });
    expect(result.current.status).toBe(ConnectionStatus.DISCONNECTED);
  });
});

// ---------------------------------------------------------------------------
describe('stopSession', () => {
  it('calls mixer.stop() and archives audio to GCS', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });
    await act(async () => { await result.current.stopSession(); });

    expect(mockMixerStop).toHaveBeenCalledTimes(1);
    expect(storageSpies.archiveAudioToGCS).toHaveBeenCalledTimes(1);
  });

  it('finalizes session with completed status', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });
    await act(async () => { await result.current.stopSession(); });

    expect(storageSpies.finalizeSession).toHaveBeenCalledWith(
      'family-1',
      'dossier-1',
      'session-123',
      'completed',
      expect.any(Number),
      'https://storage.example.com/audio.webm',
    );
  });

  it('finalizes with completed (no url) when audio upload fails', async () => {
    storageSpies.archiveAudioToGCS.mockRejectedValueOnce(new Error('upload failed'));

    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });
    await act(async () => { await result.current.stopSession(); });

    // finalizeSession still called, but without audioUrl
    const call = storageSpies.finalizeSession.mock.calls[0];
    expect(call[3]).toBe('completed');
    expect(call[5]).toBeUndefined();
  });

  it('closes the Gemini session', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });
    await act(async () => { await result.current.stopSession(); });

    expect(mockLiveSession.close).toHaveBeenCalledTimes(1);
  });

  it('sets status to DISCONNECTED after stop', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });
    await act(async () => { await result.current.stopSession(); });

    expect(result.current.status).toBe(ConnectionStatus.DISCONNECTED);
  });

  it('clears sessionId after stop', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });
    expect(result.current.sessionId).toBe('session-123');

    await act(async () => { await result.current.stopSession(); });
    expect(result.current.sessionId).toBeNull();
  });

  it('does not call finalizeSession if no session was started', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.stopSession(); });
    expect(storageSpies.finalizeSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('flushPartialSession', () => {
  it('finalizes session with interrupted status', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });
    await act(async () => { await result.current.flushPartialSession(); });

    expect(storageSpies.finalizeSession).toHaveBeenCalledWith(
      'family-1',
      'dossier-1',
      'session-123',
      'interrupted',
      expect.any(Number),
      'https://storage.example.com/audio.webm',
    );
  });

  it('uses mixer.flush() (not stop()) for partial audio', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });
    await act(async () => { await result.current.flushPartialSession(); });

    expect(mockMixerFlush).toHaveBeenCalledTimes(1);
    expect(mockMixerStop).not.toHaveBeenCalled();
  });

  it('archives partial audio when flush returns a blob', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });
    await act(async () => { await result.current.flushPartialSession(); });

    expect(storageSpies.archiveAudioToGCS).toHaveBeenCalledTimes(1);
  });

  it('does not call finalizeSession if no session was started', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.flushPartialSession(); });
    expect(storageSpies.finalizeSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('messageIndex tracking', () => {
  it('assigns sequential messageIndex to each transcript entry', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });

    // Simulate two turn-complete messages to add a bot + user entry each
    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        serverContent: { outputTranscription: { text: 'Hello, Margaret.' }, turnComplete: false },
      });
      capturedCallbacks.current.onmessage?.({
        serverContent: { turnComplete: true },
      });
    });

    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        serverContent: { inputTranscription: { text: 'I grew up in Ohio.' }, turnComplete: false },
      });
      capturedCallbacks.current.onmessage?.({
        serverContent: { turnComplete: true },
      });
    });

    // Check the transcript entries passed to syncTranscriptToFirestore
    const lastCall = storageSpies.syncTranscriptToFirestore.mock.calls.at(-1);
    const entries = lastCall?.[3] ?? [];
    expect(entries.length).toBeGreaterThanOrEqual(2);
    // Each entry should have a sequential messageIndex
    entries.forEach((entry: any, i: number) => {
      expect(entry.messageIndex).toBe(i);
    });
  });
});

// ---------------------------------------------------------------------------
describe('function call handlers', () => {
  it('calls onQuestionUpdate and updateQuestionStateInFirestore on updateQuestionStatus tool call', async () => {
    const onQuestionUpdate = vi.fn();
    const { result } = renderSession({ onQuestionUpdate });

    await act(async () => { await result.current.startSession(); });

    // Simulate Gemini sending an updateQuestionStatus function call
    const toolCallMessage = {
      toolCall: {
        functionCalls: [{
          name: 'updateQuestionStatus',
          id: 'call-1',
          args: { id: 'q-1', status: 'Completed', findings: 'Story about Ohio farm.' },
        }],
      },
    };

    await act(async () => {
      capturedCallbacks.current.onmessage?.(toolCallMessage);
      // Allow microtasks to flush
      await Promise.resolve();
    });

    expect(onQuestionUpdate).toHaveBeenCalledWith('q-1', 'Completed', 'Story about Ohio farm.');
    expect(storageSpies.updateQuestionStateInFirestore).toHaveBeenCalledWith(
      'family-1',
      'dossier-1',
      'q-1',
      'Completed',
      'Story about Ohio farm.',
    );
  });

  it('calls onShowPhoto on showPhoto tool call', async () => {
    const onShowPhoto = vi.fn();
    const promptPhotos = [{ id: 'photo-abc', caption: 'Old farmhouse', url: 'https://example.com/photo.jpg', storagePath: 'path/photo.jpg', uploadedAt: { seconds: 0, nanoseconds: 0, toDate: () => new Date() } as any }];
    const { result } = renderSession({ onShowPhoto, promptPhotos } as any);

    await act(async () => { await result.current.startSession(); });

    const toolCallMessage = {
      toolCall: {
        functionCalls: [{
          name: 'showPhoto',
          id: 'call-2',
          args: { photoId: 'photo-abc' },
        }],
      },
    };

    await act(async () => {
      capturedCallbacks.current.onmessage?.(toolCallMessage);
      await Promise.resolve();
    });

    expect(onShowPhoto).toHaveBeenCalledWith('photo-abc');
  });
});

// ---------------------------------------------------------------------------
describe('reconnectSession', () => {
  it('does NOT create a new Firestore session (reuses existing sessionId)', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });
    expect(result.current.sessionId).toBe('session-123');

    // Simulate unexpected disconnect
    await act(async () => { capturedCallbacks.current.onclose?.(); });

    storageSpies.createSession.mockClear();
    await act(async () => { await result.current.reconnectSession(); });

    // createSession must NOT be called on reconnect
    expect(storageSpies.createSession).not.toHaveBeenCalled();
  });

  it('preserves the in-memory messages on reconnect', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });

    // Add a message via onmessage
    await act(async () => {
      capturedCallbacks.current.onmessage?.({
        serverContent: { outputTranscription: { text: 'Hello, tell me about your childhood.' }, turnComplete: false },
      });
      capturedCallbacks.current.onmessage?.({ serverContent: { turnComplete: true } });
    });
    expect(result.current.messages.length).toBe(1);

    // Simulate disconnect and reconnect
    await act(async () => { capturedCallbacks.current.onclose?.(); });
    await act(async () => { await result.current.reconnectSession(); });

    // Messages must still be present (not reset)
    expect(result.current.messages.length).toBe(1);
  });

  it('reconnects to Gemini and transitions to CONNECTING then CONNECTED', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });
    await act(async () => { capturedCallbacks.current.onclose?.(); });

    expect(result.current.status).toBe(ConnectionStatus.ERROR);
    await act(async () => { await result.current.reconnectSession(); });

    // After reconnect resolves (onopen fires in mockLiveConnect), status is CONNECTED
    await act(async () => { capturedCallbacks.current.onopen?.(); });
    expect(result.current.status).toBe(ConnectionStatus.CONNECTED);
  });

  it('restarts the audio mixer (stop + start) on reconnect', async () => {
    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });
    mockMixerStop.mockClear();
    mockMixerStart.mockClear();

    await act(async () => { await result.current.reconnectSession(); });

    expect(mockMixerStop).toHaveBeenCalledTimes(1);
    expect(mockMixerStart).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe('clearDeviceError / dismissConnectivityWarning', () => {
  it('clears device error', async () => {
    const err = new Error('microphone access denied');
    err.name = 'NotAllowedError';
    mockMixerStart.mockRejectedValueOnce(err);

    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });
    expect(result.current.deviceError).toBeTruthy();

    act(() => { result.current.clearDeviceError(); });
    expect(result.current.deviceError).toBeNull();
  });

  it('dismisses connectivity warning', async () => {
    storageSpies.getCompletedSessionCount.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(0), 600)),
    );

    const { result } = renderSession();
    await act(async () => { await result.current.startSession(); });
    expect(result.current.connectivityWarning).toBeTruthy();

    act(() => { result.current.dismissConnectivityWarning(); });
    expect(result.current.connectivityWarning).toBeNull();
  });
});
