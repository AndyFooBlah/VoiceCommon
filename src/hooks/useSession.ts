/**
 * Live session hook for LegacyBot.
 *
 * Orchestrates the full lifecycle of a recording session:
 *   1. Start: Initialize audio mixer → Create Firestore session → Connect Gemini
 *   2. During: Stream PCM to Gemini, play bot audio, sync transcripts in real-time
 *   3. Stop: Close Gemini, stop recorder, upload audio to GCS, finalize session
 *   4. Error: Flush partial data, mark session as interrupted, offer reconnect
 *
 * This hook is the core "engine" of the app. It was extracted from the original
 * monolithic App.tsx to separate concerns and make the session logic testable
 * independently of the UI.
 *
 * Audio pipeline (see useAudioMixer for details):
 *   User mic → PCM → Gemini API → PCM → AudioBuffer → speakers + mixed archive
 *
 * References: design.md §3.2, §3.3, §3.6 | GitHub Issues #9, #10, #11, #12, #17
 */

import { useState, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { Timestamp } from 'firebase/firestore';
import { Message, Dossier, InterviewQuestion, ConnectionStatus, TranscriptEntry } from '../types';
import { useAudioMixer } from './useAudioMixer';
import { encode, decode, decodeAudioData } from '../services/audioUtils';
import { buildSystemInstruction } from '../services/gemini';
import {
  createSession,
  finalizeSession,
  archiveAudioToGCS,
  syncTranscriptToFirestore,
  updateQuestionStateInFirestore,
} from '../services/storage';

interface UseSessionOptions {
  familyId: string;
  dossierId: string;
  storytellerUid: string;
  dossier: Dossier;
  questions: InterviewQuestion[];
  /** Called when the bot updates a question's status via function calling. */
  onQuestionUpdate: (questionId: string, status: string, findings: string) => void;
}

export function useSession({
  familyId,
  dossierId,
  storytellerUid,
  dossier,
  questions,
  onQuestionUpdate,
}: UseSessionOptions) {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isBotSpeaking, setIsBotSpeaking] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  const mixer = useAudioMixer();

  // Refs for managing audio playback scheduling and interruption
  const currentInputRef = useRef('');
  const currentOutputRef = useRef('');
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const sessionStartTimeRef = useRef<number>(0);
  // Keep a ref copy of transcript entries for Firestore sync
  const transcriptEntriesRef = useRef<TranscriptEntry[]>([]);
  // Ref for sessionId so Gemini callbacks always have the current value
  // (state-based sessionId creates stale closures in the onmessage handler)
  const sessionIdRef = useRef<string | null>(null);

  /** Convert Float32 audio samples to PCM Int16 and base64-encode for Gemini. */
  const createPCMData = useCallback((data: Float32Array) => {
    const int16 = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) {
      int16[i] = data[i] * 32768;
    }
    return { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
  }, []);

  /** Stop all currently playing bot audio (used on interruption or session end). */
  const handleInterruption = useCallback(() => {
    for (const source of sourcesRef.current.values()) {
      try { source.stop(); } catch (_) { /* already stopped */ }
      sourcesRef.current.delete(source);
    }
    nextStartTimeRef.current = 0;
    setIsBotSpeaking(false);
  }, []);

  /** Add a message to the live transcript and sync to Firestore. */
  const addMessage = useCallback(
    (role: 'user' | 'bot', text: string) => {
      const newMsg: Message = {
        id: Math.random().toString(36).substr(2, 9),
        role,
        text,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, newMsg]);

      // Also append to the Firestore transcript
      transcriptEntriesRef.current.push({
        role,
        text,
        timestamp: Timestamp.now(),
      });

      // Sync to Firestore (fire-and-forget — errors are logged, not thrown)
      const currentSessionId = sessionIdRef.current;
      if (currentSessionId) {
        syncTranscriptToFirestore(familyId, dossierId, currentSessionId, [...transcriptEntriesRef.current]).catch(
          (err) => console.error('[Firestore] Transcript sync error:', err),
        );
      }
    },
    [familyId, dossierId],
  );

  /**
   * Start a new live session.
   *
   * Sequence:
   *   1. Start the audio mixer (mic + MediaRecorder)
   *   2. Create a session document in Firestore
   *   3. Connect to the Gemini Live API with the system instruction
   *   4. Wire up audio streaming (mic → Gemini → speakers + archive)
   */
  const startSession = useCallback(async () => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      setMessages([]);
      transcriptEntriesRef.current = [];

      // 1. Start audio mixer
      await mixer.start();

      // 2. Create Firestore session
      const sId = await createSession(familyId, dossierId, storytellerUid);
      setSessionId(sId);
      sessionIdRef.current = sId;
      sessionStartTimeRef.current = Date.now();

      // 3. Set up the Gemini function-calling tool for question tracking
      const updateQuestionStatusTool: FunctionDeclaration = {
        name: 'updateQuestionStatus',
        parameters: {
          type: Type.OBJECT,
          description: 'Update the archival progress of a specific life story question.',
          properties: {
            id: {
              type: Type.STRING,
              description: 'The unique ID of the question.',
            },
            status: {
              type: Type.STRING,
              enum: ['Unasked', 'InProgress', 'Completed'],
              description: 'The current status of the storytelling for this topic.',
            },
            findings: {
              type: Type.STRING,
              description: 'A brief summary of the key facts/stories uncovered for this question so far.',
            },
          },
          required: ['id', 'status', 'findings'],
        },
      };

      // 4. Connect to Gemini Live API
      const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });
      const systemInstruction = buildSystemInstruction(dossier, questions);

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);

            // Wire mic audio to Gemini input (PCM at 16kHz)
            const inputCtx = mixer.inputContext!;
            const source = inputCtx.createMediaStreamSource(mixer.stream!);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPCMData(inputData);
              sessionPromise.then((session) =>
                session.sendRealtimeInput({ media: pcmBlob }),
              );
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);

            // Send a text prompt to trigger the bot's first greeting immediately
            sessionPromise.then((session) =>
              session.sendClientContent({
                turns: [
                  {
                    role: 'user',
                    parts: [{ text: `[Session started. Greet ${dossier.storytellerName} now.]` }],
                  },
                ],
                turnComplete: true,
              }),
            );
          },

          onmessage: async (message: LiveServerMessage) => {
            // --- Handle Function Calls (question status updates) ---
            if (message.toolCall?.functionCalls) {
              for (const fc of message.toolCall.functionCalls) {
                if (fc.name === 'updateQuestionStatus') {
                  const { id, status, findings } = fc.args as any;
                  // Update local state + Firestore
                  onQuestionUpdate(id, status, findings);
                  updateQuestionStateInFirestore(familyId, dossierId, id, status, findings).catch(
                    (err) => console.error('[Firestore] Question update error:', err),
                  );
                  // Respond to the tool call so the model can continue
                  sessionPromise.then((s) =>
                    s.sendToolResponse({
                      functionResponses: {
                        id: fc.id,
                        name: fc.name,
                        response: { result: 'ok' },
                      },
                    }),
                  );
                }
              }
            }

            // --- Handle Transcriptions ---
            if (message.serverContent?.outputTranscription) {
              currentOutputRef.current += message.serverContent.outputTranscription.text;
            } else if (message.serverContent?.inputTranscription) {
              currentInputRef.current += message.serverContent.inputTranscription.text;
            }

            // When a turn is complete, commit the accumulated text as messages
            if (message.serverContent?.turnComplete) {
              if (currentInputRef.current) addMessage('user', currentInputRef.current);
              if (currentOutputRef.current) addMessage('bot', currentOutputRef.current);
              currentInputRef.current = '';
              currentOutputRef.current = '';
            }

            // --- Handle Bot Audio Playback ---
            const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData && mixer.playbackContext) {
              setIsBotSpeaking(true);
              const ctx = mixer.playbackContext;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);

              const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
              const audioSource = ctx.createBufferSource();
              audioSource.buffer = buffer;
              // Connect to both speakers and the mixed archive destination
              audioSource.connect(ctx.destination);
              if (mixer.mixedDest) audioSource.connect(mixer.mixedDest);

              audioSource.addEventListener('ended', () => {
                sourcesRef.current.delete(audioSource);
                if (sourcesRef.current.size === 0) setIsBotSpeaking(false);
              });
              audioSource.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(audioSource);
            }

            // --- Handle Interruption (user spoke over the bot) ---
            if (message.serverContent?.interrupted) handleInterruption();
          },

          onerror: (error) => {
            console.error('[Gemini] Connection error:', error);
            setStatus(ConnectionStatus.ERROR);
            // Flush partial data on error (see error recovery in stopSession)
          },

          onclose: () => {
            // If we didn't explicitly stop, this is an unexpected disconnect
            if (status !== ConnectionStatus.DISCONNECTED) {
              setStatus(ConnectionStatus.ERROR);
            }
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction,
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: dossier.selectedVoice },
            },
          },
          tools: [{ functionDeclarations: [updateQuestionStatusTool] }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error('[Session] Start error:', err);
      if (err.name === 'NoMicrophoneError' || err.name === 'NotFoundError' || err.name === 'NotAllowedError' || err.message?.includes('microphone')) {
        setDeviceError(err.message);
      }
      setStatus(ConnectionStatus.ERROR);
    }
  }, [familyId, dossierId, storytellerUid, dossier, questions, mixer, addMessage, createPCMData, handleInterruption, onQuestionUpdate, status]);

  /**
   * Gracefully stop the current session.
   *
   * Sequence:
   *   1. Close the Gemini connection
   *   2. Stop the MediaRecorder and get the recorded blob
   *   3. Upload the audio blob to GCS
   *   4. Finalize the session document in Firestore
   */
  const stopSession = useCallback(async () => {
    // Close Gemini connection
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }

    handleInterruption();

    // Stop mixer and get the recorded audio
    const audioBlob = await mixer.stop();

    const durationSeconds = Math.round((Date.now() - sessionStartTimeRef.current) / 1000);

    // Upload audio and finalize session
    const currentSessionId = sessionIdRef.current;
    if (currentSessionId) {
      // Final transcript sync — ensure all entries are persisted
      if (transcriptEntriesRef.current.length > 0) {
        try {
          await syncTranscriptToFirestore(familyId, dossierId, currentSessionId, [...transcriptEntriesRef.current]);
        } catch (err) {
          console.error('[Session] Final transcript sync error:', err);
        }
      }

      if (audioBlob) {
        try {
          const audioUrl = await archiveAudioToGCS(audioBlob, familyId, dossierId, currentSessionId);
          await finalizeSession(familyId, dossierId, currentSessionId, 'completed', durationSeconds, audioUrl);
        } catch (err) {
          console.error('[Session] Archive error:', err);
          // Still mark session as completed even if upload fails
          await finalizeSession(familyId, dossierId, currentSessionId, 'completed', durationSeconds).catch(() => {});
        }
      } else {
        await finalizeSession(familyId, dossierId, currentSessionId, 'completed', durationSeconds).catch(() => {});
      }
    }

    sessionIdRef.current = null;
    setStatus(ConnectionStatus.DISCONNECTED);
  }, [familyId, dossierId, mixer, handleInterruption]);

  /**
   * Flush partial session data on error (for partial recovery).
   * Called when the Gemini connection drops unexpectedly.
   */
  const flushPartialSession = useCallback(async () => {
    const partialBlob = mixer.flush();
    const durationSeconds = Math.round((Date.now() - sessionStartTimeRef.current) / 1000);
    const currentSessionId = sessionIdRef.current;

    if (currentSessionId) {
      // Ensure transcript is synced first
      if (transcriptEntriesRef.current.length > 0) {
        try {
          await syncTranscriptToFirestore(familyId, dossierId, currentSessionId, [...transcriptEntriesRef.current]);
        } catch (err) {
          console.error('[Firestore] Final transcript sync error:', err);
        }
      }

      // Upload whatever audio we have
      if (partialBlob) {
        try {
          const audioUrl = await archiveAudioToGCS(partialBlob, familyId, dossierId, currentSessionId);
          await finalizeSession(familyId, dossierId, currentSessionId, 'interrupted', durationSeconds, audioUrl);
        } catch (err) {
          console.error('[Session] Partial archive error:', err);
          await finalizeSession(familyId, dossierId, currentSessionId, 'interrupted', durationSeconds).catch(() => {});
        }
      } else {
        await finalizeSession(familyId, dossierId, currentSessionId, 'interrupted', durationSeconds).catch(() => {});
      }
    }
  }, [familyId, dossierId, mixer]);

  const clearDeviceError = useCallback(() => {
    setDeviceError(null);
    setStatus(ConnectionStatus.DISCONNECTED);
  }, []);

  return {
    status,
    messages,
    isBotSpeaking,
    sessionId,
    deviceError,
    clearDeviceError,
    startSession,
    stopSession,
    flushPartialSession,
  };
}
