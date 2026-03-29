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
import { Message, Dossier, InterviewQuestion, FamilyMember, PromptPhoto, ConnectionStatus, TranscriptEntry } from '../types';
import { useAudioMixer } from './useAudioMixer';
import { encode, decode, decodeAudioData } from '../services/audioUtils';
import { buildSystemInstruction } from '../services/gemini';
import {
  createSession,
  finalizeSession,
  archiveAudioToGCS,
  syncTranscriptToFirestore,
  updateQuestionStateInFirestore,
  getCompletedSessionCount,
  getPreviousSessionSummary,
  getLastSessionDate,
  logEmotionalObservation,
  saveExtractedEvents,
  saveFamilyEvents,
  saveEngagementAssessment,
  saveSuggestedQuestions,
  getEvents,
} from '../services/storage';
import { extractEvents, assessEngagement, suggestQuestions } from '../services/postSessionAnalysis';

interface UseSessionOptions {
  familyId: string;
  dossierId: string;
  storytellerUid: string;
  dossier: Dossier;
  questions: InterviewQuestion[];
  /** Family tree (shared across all dossiers in the family). */
  familyTree?: FamilyMember[];
  /** Prompt photos uploaded by admin for the bot to optionally show. */
  promptPhotos?: PromptPhoto[];
  /** Called when the bot updates a question's status via function calling. */
  onQuestionUpdate: (questionId: string, status: string, findings: string) => void;
  /** Called when the bot shows a prompt photo to the storyteller. */
  onShowPhoto?: (photoId: string) => void;
}

export function useSession({
  familyId,
  dossierId,
  storytellerUid,
  dossier,
  questions,
  familyTree,
  promptPhotos,
  onQuestionUpdate,
  onShowPhoto,
}: UseSessionOptions) {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isBotSpeaking, setIsBotSpeaking] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [connectivityWarning, setConnectivityWarning] = useState<string | null>(null);

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
      int16[i] = Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767)));
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

      // Also append to the Firestore transcript (messageIndex = position before push)
      const messageIndex = transcriptEntriesRef.current.length;
      transcriptEntriesRef.current.push({
        role,
        text,
        timestamp: Timestamp.now(),
        messageIndex,
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
      setConnectivityWarning(null);

      // 0. Connectivity check + session history fetch (combined to avoid duplicate call)
      let completedSessionCount = 0;
      let previousSessionSummary: string | undefined;
      let lastSessionDate: Date | undefined;
      try {
        const start = Date.now();
        [completedSessionCount, previousSessionSummary, lastSessionDate] = await Promise.all([
          Promise.race([
            getCompletedSessionCount(familyId, dossierId),
            new Promise<number>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
          ]).catch(() => 0),
          getPreviousSessionSummary(familyId, dossierId).catch(() => undefined),
          getLastSessionDate(familyId, dossierId).catch(() => undefined),
        ]);
        const latency = Date.now() - start;
        if (latency > 500) {
          setConnectivityWarning(
            `Your connection seems slow (${Math.round(latency)}ms latency). The session may experience interruptions.`,
          );
        }
      } catch {
        setConnectivityWarning(
          'Network connectivity issue detected. The session may be unreliable — check your internet connection.',
        );
      }

      // 1. Start audio mixer
      await mixer.start();

      // 2. Create Firestore session
      const sId = await createSession(familyId, dossierId, storytellerUid);
      setSessionId(sId);
      sessionIdRef.current = sId;
      sessionStartTimeRef.current = Date.now();

      // 4. Set up Gemini function-calling tools
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

      const reportEmotionalObservationTool: FunctionDeclaration = {
        name: 'reportEmotionalObservation',
        parameters: {
          type: Type.OBJECT,
          description: 'Log a significant emotional observation about the storyteller during the interview. Call this when you notice meaningful shifts in mood, comfort, or engagement.',
          properties: {
            mood: {
              type: Type.STRING,
              enum: ['engaged', 'neutral', 'hesitant', 'emotional', 'distressed', 'joyful'],
              description: 'The observed emotional state of the storyteller.',
            },
            confidence: {
              type: Type.NUMBER,
              description: 'How confident you are in this observation (0.0 to 1.0).',
            },
            trigger: {
              type: Type.STRING,
              description: 'What caused or is associated with this emotional shift (e.g. "mention of father", "war stories", "childhood home").',
            },
            recommendation: {
              type: Type.STRING,
              description: 'What you plan to do in response (e.g. "switching to lighter topic", "giving space", "exploring further").',
            },
          },
          required: ['mood', 'confidence', 'trigger', 'recommendation'],
        },
      };

      const showPhotoTool: FunctionDeclaration = {
        name: 'showPhoto',
        parameters: {
          type: Type.OBJECT,
          description: 'Display a prompt photo to the storyteller during the interview. Use this when a photo is relevant to the current conversation topic.',
          properties: {
            photoId: {
              type: Type.STRING,
              description: 'The unique ID of the prompt photo to display.',
            },
          },
          required: ['photoId'],
        },
      };

      // 5. Connect to Gemini Live API
      const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });
      const systemInstruction = buildSystemInstruction({
        dossier,
        questions,
        familyTree,
        promptPhotos,
        completedSessionCount,
        previousSessionSummary,
        lastSessionDate,
      });

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
              sessionPromise
                .then((session) => session.sendRealtimeInput({ media: pcmBlob }))
                .catch((err) => console.error('[PCM] Send error:', err));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);

            // Send a text prompt to trigger the bot's first greeting immediately
            const greetingTrigger = completedSessionCount === 0
              ? `[First session with ${dossier.storytellerName}. Introduce yourself and begin the interview as instructed.]`
              : `[Returning session #${completedSessionCount + 1} with ${dossier.storytellerName}. Welcome them back as instructed and continue the interview.]`;
            sessionPromise.then((session) =>
              session.sendClientContent({
                turns: [{ role: 'user', parts: [{ text: greetingTrigger }] }],
                turnComplete: true,
              }),
            );
          },

          onmessage: async (message: LiveServerMessage) => {
            // --- Handle Function Calls ---
            if (message.toolCall?.functionCalls) {
              for (const fc of message.toolCall.functionCalls) {
                if (fc.name === 'updateQuestionStatus') {
                  const { id, status, findings } = fc.args as any;
                  onQuestionUpdate(id, status, findings);
                  updateQuestionStateInFirestore(familyId, dossierId, id, status, findings).catch(
                    (err) => console.error('[Firestore] Question update error:', err),
                  );
                } else if (fc.name === 'showPhoto') {
                  const { photoId } = fc.args as any;
                  // Validate photo exists before invoking the UI callback
                  const photo = promptPhotos?.find((p) => p.id === photoId);
                  if (photo) {
                    if (onShowPhoto) onShowPhoto(photoId);
                    addMessage('bot', `[Showed photo: ${photo.caption}]`);
                  } else {
                    console.warn(`[Session] showPhoto: unknown photoId "${photoId}"`);
                  }
                } else if (fc.name === 'reportEmotionalObservation') {
                  const { mood, confidence, trigger, recommendation } = fc.args as any;
                  const currentSid = sessionIdRef.current;
                  if (currentSid) {
                    logEmotionalObservation(familyId, dossierId, currentSid, {
                      mood, confidence, trigger, recommendation,
                    }).catch((err) => console.error('[Firestore] Emotion log error:', err));
                  }
                }

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

            // --- Handle Transcriptions ---
            if (message.serverContent?.inputTranscription) {
              currentInputRef.current += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              // When the bot starts speaking, flush any accumulated user input first
              if (currentInputRef.current) {
                addMessage('user', currentInputRef.current);
                currentInputRef.current = '';
              }
              currentOutputRef.current += message.serverContent.outputTranscription.text;
            }

            // When a turn is complete, commit any remaining accumulated text
            if (message.serverContent?.turnComplete) {
              if (currentInputRef.current) {
                addMessage('user', currentInputRef.current);
                currentInputRef.current = '';
              }
              if (currentOutputRef.current) {
                addMessage('bot', currentOutputRef.current);
                currentOutputRef.current = '';
              }
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
          tools: [{ functionDeclarations: [
            updateQuestionStatusTool,
            reportEmotionalObservationTool,
            ...(promptPhotos && promptPhotos.length > 0 ? [showPhotoTool] : []),
          ] }],
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

      // Clean up the Firestore session doc if it was created before the failure
      const orphanedSid = sessionIdRef.current;
      if (orphanedSid) {
        finalizeSession(familyId, dossierId, orphanedSid, 'interrupted', 0).catch(() => {});
        sessionIdRef.current = null;
        setSessionId(null);
      }

      // Stop the audio mixer if it was started before the failure
      mixer.stop().catch(() => {});

      setStatus(ConnectionStatus.ERROR);
    }
  }, [familyId, dossierId, storytellerUid, dossier, questions, promptPhotos, mixer, addMessage, createPCMData, handleInterruption, onQuestionUpdate, onShowPhoto, status]);

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
    // Flush any accumulated user/bot text that hasn't been committed yet
    if (currentInputRef.current) {
      addMessage('user', currentInputRef.current);
      currentInputRef.current = '';
    }
    if (currentOutputRef.current) {
      addMessage('bot', currentOutputRef.current);
      currentOutputRef.current = '';
    }

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

    // Run post-session analysis in the background (non-blocking)
    if (currentSessionId && transcriptEntriesRef.current.length > 0) {
      const entriesCopy = [...transcriptEntriesRef.current];
      const questionsCopy = [...questions];
      const sid = currentSessionId;
      (async () => {
        try {
          const existingEvents = await getEvents(familyId, dossierId).catch(() => []);
          const [events, engagement, suggestions] = await Promise.all([
            extractEvents(entriesCopy, sid, existingEvents).catch((err) => {
              console.error('[PostSession] Event extraction error:', err);
              return [];
            }),
            assessEngagement(entriesCopy, questionsCopy).catch((err) => {
              console.error('[PostSession] Engagement assessment error:', err);
              return null;
            }),
            suggestQuestions(entriesCopy, questionsCopy, dossier).catch((err) => {
              console.error('[PostSession] Question suggestion error:', err);
              return [];
            }),
          ]);
          const familyEvents = events.map((e) => ({
            familyId,
            title: e.title,
            date: e.date ?? undefined,
            description: e.description,
            storytellerUids: [storytellerUid],
            sessionIds: [sid],
            createdBy: storytellerUid,
            messageReferences: (e.sources?.[0]?.entryIndices ?? []).map((idx) => ({
              sessionId: sid,
              dossierId,
              messageIndex: idx,
            })),
          }));
          await Promise.all([
            events.length > 0
              ? saveExtractedEvents(familyId, dossierId, events)
              : Promise.resolve(),
            familyEvents.length > 0
              ? saveFamilyEvents(familyId, familyEvents)
              : Promise.resolve(),
            engagement
              ? saveEngagementAssessment(familyId, dossierId, sid, engagement)
              : Promise.resolve(),
            suggestions.length > 0
              ? saveSuggestedQuestions(familyId, dossierId, sid, suggestions)
              : Promise.resolve(),
          ]);
          console.log(`[PostSession] Analysis complete: ${events.length} events, ${suggestions.length} suggestions`);
        } catch (err) {
          console.error('[PostSession] Analysis failed:', err);
        }
      })();
    }

    sessionIdRef.current = null;
    setSessionId(null);
    setStatus(ConnectionStatus.DISCONNECTED);
  }, [familyId, dossierId, dossier, questions, mixer, handleInterruption]);

  /**
   * Flush partial session data on error (for partial recovery).
   * Called when the Gemini connection drops unexpectedly.
   */
  const flushPartialSession = useCallback(async () => {
    // Flush any accumulated text before saving
    if (currentInputRef.current) {
      addMessage('user', currentInputRef.current);
      currentInputRef.current = '';
    }
    if (currentOutputRef.current) {
      addMessage('bot', currentOutputRef.current);
      currentOutputRef.current = '';
    }

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
  }, [familyId, dossierId, mixer, addMessage]);

  const clearDeviceError = useCallback(() => {
    setDeviceError(null);
    setStatus(ConnectionStatus.DISCONNECTED);
  }, []);

  const dismissConnectivityWarning = useCallback(() => {
    setConnectivityWarning(null);
  }, []);

  return {
    status,
    messages,
    isBotSpeaking,
    sessionId,
    deviceError,
    connectivityWarning,
    clearDeviceError,
    dismissConnectivityWarning,
    startSession,
    stopSession,
    flushPartialSession,
  };
}
