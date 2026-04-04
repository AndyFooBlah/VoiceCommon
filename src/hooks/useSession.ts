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
 * Live session hook for LegacyBot.
 *
 * Orchestrates the full lifecycle of a recording session:
 *   1. Start: Initialize audio mixer → Create Firestore session → Connect Gemini
 *   2. During: Stream PCM to Gemini, play bot audio, sync transcripts in real-time
 *   3. Stop: Close Gemini, stop recorder, upload audio to GCS, finalize session
 *   4. Error: Auto-reconnect preserving session context; flush/finalize only on give-up
 *
 * Reconnect strategy (see reconnectSession):
 *   On unexpected disconnect, reconnectSession() is called instead of startSession().
 *   It keeps the same Firestore session ID and in-memory transcript, restarts the
 *   audio pipeline, and primes Gemini with recent conversation context so the
 *   interview continues naturally without starting over.
 *
 * AI-driven session end (endSession tool):
 *   The AI can call the 'endSession' function tool when the storyteller signals they
 *   are done (e.g. "I'm tired", "let's stop"). The handler waits for closing audio
 *   to finish playing, then calls stopSession() programmatically.
 *
 * References: design.md §3.2, §3.3, §3.6 | GitHub Issues #9, #10, #11, #12, #17, #75, #76
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

const GEMINI_MODEL = 'gemini-3.1-flash-live-preview';

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
  /** Called when the bot records the storyteller's preferred name. */
  onPreferredNameUpdate?: (name: string) => void;
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
  onPreferredNameUpdate,
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
  const sessionIdRef = useRef<string | null>(null);

  // AudioWorklet node refs — stored so the worklet can be disconnected on error/reconnect
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const workletSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // PCM debug counters — track send rate to detect runaway audio pipelines
  const pcmFrameCountRef = useRef(0);
  const pcmLogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  /**
   * Disconnect the AudioWorklet node and mic source from the audio graph.
   * Called on session stop, error, or before reconnect to prevent a ghost
   * pipeline from sending PCM to a dead WebSocket connection.
   */
  const disconnectWorklet = useCallback(() => {
    if (pcmLogTimerRef.current) {
      clearInterval(pcmLogTimerRef.current);
      pcmLogTimerRef.current = null;
    }
    if (workletNodeRef.current) {
      try { workletNodeRef.current.port.onmessage = null; } catch { /* node may already be GC'd */ }
      try { workletNodeRef.current.disconnect(); } catch { /* ignore disconnect errors on cleanup */ }
      workletNodeRef.current = null;
    }
    if (workletSourceRef.current) {
      try { workletSourceRef.current.disconnect(); } catch { /* ignore disconnect errors on cleanup */ }
      workletSourceRef.current = null;
    }
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

      const messageIndex = transcriptEntriesRef.current.length;
      transcriptEntriesRef.current.push({
        role,
        text,
        timestamp: Timestamp.now(),
        messageIndex,
      });

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
   * Build the shared Gemini tool declarations.
   * Extracted so both startSession and reconnectSession use identical config.
   */
  const buildTools = useCallback((): FunctionDeclaration[] => {
    const updateQuestionStatusTool: FunctionDeclaration = {
      name: 'updateQuestionStatus',
      parameters: {
        type: Type.OBJECT,
        description: 'Update the archival progress of a specific life story question.',
        properties: {
          id: { type: Type.STRING, description: 'The unique ID of the question.' },
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
        description: 'Log a significant emotional observation about the storyteller during the interview.',
        properties: {
          mood: {
            type: Type.STRING,
            enum: ['engaged', 'neutral', 'hesitant', 'emotional', 'distressed', 'joyful'],
            description: 'The observed emotional state of the storyteller.',
          },
          confidence: { type: Type.NUMBER, description: 'How confident you are in this observation (0.0 to 1.0).' },
          trigger: { type: Type.STRING, description: 'What caused or is associated with this emotional shift.' },
          recommendation: { type: Type.STRING, description: 'What you plan to do in response.' },
        },
        required: ['mood', 'confidence', 'trigger', 'recommendation'],
      },
    };

    const showPhotoTool: FunctionDeclaration = {
      name: 'showPhoto',
      parameters: {
        type: Type.OBJECT,
        description: 'Display a prompt photo to the storyteller during the interview.',
        properties: {
          photoId: { type: Type.STRING, description: 'The unique ID of the prompt photo to display.' },
        },
        required: ['photoId'],
      },
    };

    const setPreferredNameTool: FunctionDeclaration = {
      name: 'setPreferredName',
      parameters: {
        type: Type.OBJECT,
        description:
          'Record the name the storyteller prefers to be called. Call this as soon as the storyteller tells you their preferred name.',
        properties: {
          name: {
            type: Type.STRING,
            description: 'The name the storyteller wants to be addressed by (e.g. "Bob", "Mr. Smith", "Grandma Rose").',
          },
        },
        required: ['name'],
      },
    };

    const endSessionTool: FunctionDeclaration = {
      name: 'endSession',
      parameters: {
        type: Type.OBJECT,
        description:
          'End the interview session programmatically. Call this ONLY after you have spoken your warm closing remarks out loud. ' +
          'Use this when the storyteller clearly signals they are done (e.g. "I\'m tired", "let\'s stop", "I think that\'s enough for today") ' +
          'or when you sense genuine fatigue and have offered to wrap up. Never call this mid-conversation.',
        properties: {},
        required: [],
      },
    };

    return [
      updateQuestionStatusTool,
      reportEmotionalObservationTool,
      setPreferredNameTool,
      endSessionTool,
      ...(promptPhotos && promptPhotos.length > 0 ? [showPhotoTool] : []),
    ];
  }, [promptPhotos]);

  /**
   * Gracefully stop the current session.
   *
   * Sequence:
   *   1. Close the Gemini connection
   *   2. Stop the MediaRecorder and get the recorded blob
   *   3. Upload the audio blob to GCS
   *   4. Finalize the session document in Firestore
   *
   * Defined BEFORE makeMessageHandler so the endSession tool handler can call it.
   */
  const stopSession = useCallback(async () => {
    console.log(`[Session] Stopping session ${sessionIdRef.current} at ${new Date().toISOString()}`);

    if (currentInputRef.current) {
      addMessage('user', currentInputRef.current);
      currentInputRef.current = '';
    }
    if (currentOutputRef.current) {
      addMessage('bot', currentOutputRef.current);
      currentOutputRef.current = '';
    }

    disconnectWorklet();

    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }

    handleInterruption();

    const audioBlob = await mixer.stop();
    const durationSeconds = Math.round((Date.now() - sessionStartTimeRef.current) / 1000);

    const currentSessionId = sessionIdRef.current;
    if (currentSessionId) {
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
            ...(e.date != null && { date: e.date }),
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
            events.length > 0 ? saveExtractedEvents(familyId, dossierId, events) : Promise.resolve(),
            familyEvents.length > 0 ? saveFamilyEvents(familyId, familyEvents) : Promise.resolve(),
            engagement ? saveEngagementAssessment(familyId, dossierId, sid, engagement) : Promise.resolve(),
            suggestions.length > 0 ? saveSuggestedQuestions(familyId, dossierId, sid, suggestions) : Promise.resolve(),
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
  }, [familyId, dossierId, dossier, questions, mixer, handleInterruption, disconnectWorklet, addMessage, storytellerUid]);

  /**
   * Build the onmessage handler for a Gemini session.
   *
   * NOTE: must NOT accept sessionPromise as a parameter. The callbacks object is
   * constructed synchronously inside `const sessionPromise = ai.live.connect({...})`
   * so accessing `sessionPromise` at that point is a temporal dead zone ReferenceError.
   * Tool responses use sessionRef.current which is always set before any tool call can
   * arrive (Gemini can't call a tool before the session is established).
   *
   * stopSession is defined before this function so the endSession handler can call it.
   */
  const makeMessageHandler = useCallback(
    () =>
      async (message: LiveServerMessage) => {
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
              const photo = promptPhotos?.find((p) => p.id === photoId);
              if (photo) {
                if (onShowPhoto) onShowPhoto(photoId);
                addMessage('bot', `[Showed photo: ${photo.caption}]`);
              } else {
                console.warn(`[Session] showPhoto: unknown photoId "${photoId}"`);
              }
            } else if (fc.name === 'setPreferredName') {
              const { name } = fc.args as any;
              console.log(`[Session] AI recorded preferred name: "${name}"`);
              if (onPreferredNameUpdate) onPreferredNameUpdate(name);
            } else if (fc.name === 'reportEmotionalObservation') {
              const { mood, confidence, trigger, recommendation } = fc.args as any;
              const currentSid = sessionIdRef.current;
              if (currentSid) {
                logEmotionalObservation(familyId, dossierId, currentSid, {
                  mood, confidence, trigger, recommendation,
                }).catch((err) => console.error('[Firestore] Emotion log error:', err));
              }
            } else if (fc.name === 'endSession') {
              console.log('[Session] AI called endSession — waiting for closing audio to finish');
              // Poll until all queued bot audio finishes playing, then stop.
              // The AI has already spoken its closing; we just need to let the audio drain.
              const maxWait = Date.now() + 30_000;
              const waitForAudioEnd = () => {
                if (sourcesRef.current.size === 0 || Date.now() > maxWait) {
                  console.log('[Session] Closing audio finished — stopping session');
                  stopSession();
                } else {
                  setTimeout(waitForAudioEnd, 200);
                }
              };
              // Small initial delay to let any final audio chunk start playing
              setTimeout(waitForAudioEnd, 500);
            }

            // Respond to every tool call so the model can continue
            const session = sessionRef.current;
            if (session) {
              session.sendToolResponse({
                functionResponses: [{
                  id: fc.id,
                  name: fc.name,
                  response: { result: 'ok' },
                }],
              });
            }
          }
        }

        // --- Handle Transcriptions ---
        // Strip ASCII control characters (except tab/newline) that Gemini occasionally
        // emits — they corrupt the transcript display.
        // Strip ASCII control chars that Gemini occasionally emits (corrupts transcript display)
        const sanitize = (text: string) =>
          text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // eslint-disable-line no-control-regex

        if (message.serverContent?.inputTranscription?.text) {
          currentInputRef.current += sanitize(message.serverContent.inputTranscription.text);
        }
        if (message.serverContent?.outputTranscription?.text) {
          if (currentInputRef.current) {
            addMessage('user', currentInputRef.current);
            currentInputRef.current = '';
          }
          currentOutputRef.current += sanitize(message.serverContent.outputTranscription.text);
        }

        if (message.serverContent?.turnComplete) {
          if (currentInputRef.current.trim()) {
            addMessage('user', currentInputRef.current);
            currentInputRef.current = '';
          }
          if (currentOutputRef.current.trim()) {
            addMessage('bot', currentOutputRef.current);
            currentOutputRef.current = '';
          }
        }

        // --- Handle Bot Audio Playback ---
        // Gemini 3.1 can pack multiple content parts in a single serverContent message,
        // so we iterate over all parts rather than assuming a single parts[0].
        for (const part of message.serverContent?.modelTurn?.parts ?? []) {
          const audioData = part?.inlineData?.data;
          if (audioData && mixer.playbackContext) {
            setIsBotSpeaking(true);
            const ctx = mixer.playbackContext;
            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);

            const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
            const audioSource = ctx.createBufferSource();
            audioSource.buffer = buffer;
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
        }

        // --- Handle Interruption ---
        if (message.serverContent?.interrupted) handleInterruption();
      },
    [familyId, dossierId, promptPhotos, mixer, addMessage, handleInterruption, onQuestionUpdate, onShowPhoto, onPreferredNameUpdate, stopSession],
  );

  /**
   * Wire the AudioWorklet mic pipeline into a running AudioContext.
   * Stores the node/source in refs so disconnectWorklet() can clean them up later.
   */
  const wireWorklet = useCallback(
    (sessionPromise: Promise<any>) => {
      const inputCtx = mixer.inputContext!;
      const source = inputCtx.createMediaStreamSource(mixer.stream!);
      workletSourceRef.current = source;

      const workletNode = new AudioWorkletNode(inputCtx, 'pcm-processor');
      workletNodeRef.current = workletNode;

      pcmFrameCountRef.current = 0;
      pcmLogTimerRef.current = setInterval(() => {
        console.log(`[PCM] ${pcmFrameCountRef.current} frames sent in last 10s (expected ~1250 at 16kHz/128-sample)`);
        pcmFrameCountRef.current = 0;
      }, 10_000);

      workletNode.port.onmessage = (e: MessageEvent) => {
        if (!sessionRef.current) return;
        pcmFrameCountRef.current++;
        const channelData = new Float32Array(e.data.channelData);
        const pcmBlob = createPCMData(channelData);
        sessionPromise
          .then((session) => {
            if (!sessionRef.current) return; // session may have closed during the await
            session.sendRealtimeInput({ audio: pcmBlob });
          })
          .catch((err) => console.error('[PCM] Send error:', err));
      };

      source.connect(workletNode);
      workletNode.connect(inputCtx.destination);
    },
    [mixer, createPCMData],
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
      console.log(`[Session] Starting new session at ${new Date().toISOString()}`);

      // 0. Connectivity check + session history fetch
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
        console.log(`[Session] Firestore connectivity check: ${latency}ms`);
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
      console.log(`[Session] Audio mixer started`);

      // 2. Create Firestore session
      const sId = await createSession(familyId, dossierId, storytellerUid);
      setSessionId(sId);
      sessionIdRef.current = sId;
      sessionStartTimeRef.current = Date.now();
      console.log(`[Session] Firestore session created: ${sId}`);

      // 3. Register PCM audio worklet
      await mixer.inputContext!.audioWorklet.addModule('/pcm-processor.js');
      console.log(`[Session] PCM AudioWorklet registered`);

      // 4. Connect to Gemini Live API
      const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });
      const systemInstruction = buildSystemInstruction({
        dossier,
        questions,
        familyTree,
        promptPhotos,
        completedSessionCount,
        previousSessionSummary,
        lastSessionDate,
        preferredName: dossier.preferredName,
      });

      const greetingTrigger = completedSessionCount === 0
        ? `[First session with ${dossier.storytellerName}. Introduce yourself and begin the interview as instructed.]`
        : `[Returning session #${completedSessionCount + 1} with ${dossier.storytellerName}. Welcome them back as instructed and continue the interview.]`;

      const sessionPromise = ai.live.connect({
        model: GEMINI_MODEL,
        callbacks: {
          onopen: () => {
            console.log(`[Session] Gemini connection opened at ${new Date().toISOString()}`);
            setStatus(ConnectionStatus.CONNECTED);
            wireWorklet(sessionPromise);
            // Gemini 3.1: use sendRealtimeInput for in-session text
            // (sendClientContent is restricted to initial history seeding only)
            sessionPromise.then((session) =>
              session.sendRealtimeInput({ text: greetingTrigger }),
            );
          },
          onmessage: makeMessageHandler(),
          onerror: (error: any) => {
            const duration = Math.round((Date.now() - sessionStartTimeRef.current) / 1000);
            console.error(`[Session] Gemini connection error at ${new Date().toISOString()} (${duration}s into session):`, {
              type: (error as any)?.type,
              message: error?.message ?? String(error),
              error,
            });
            disconnectWorklet();
            sessionRef.current = null;
            setStatus(ConnectionStatus.ERROR);
          },
          onclose: (event?: any) => {
            const duration = Math.round((Date.now() - sessionStartTimeRef.current) / 1000);
            const code = event?.code ?? 'unknown';
            const reason = event?.reason ? `"${event.reason}"` : '(no reason)';
            const wasClean = event?.wasClean ?? 'unknown';
            console.log(`[Session] Gemini connection closed at ${new Date().toISOString()} — code=${code} reason=${reason} wasClean=${wasClean} duration=${duration}s`);
            disconnectWorklet();
            if (sessionRef.current !== null) {
              sessionRef.current = null;
              setStatus(ConnectionStatus.ERROR);
            }
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          thinkingConfig: { thinkingLevel: 'minimal' },
          systemInstruction,
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: dossier.selectedVoice },
            },
          },
          tools: [{ functionDeclarations: buildTools() }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      });

      sessionRef.current = await sessionPromise;
      console.log(`[Session] Session ready, sessionRef set`);
    } catch (err: any) {
      console.error('[Session] Start error:', err);
      if (err.name === 'NoMicrophoneError' || err.name === 'NotFoundError' || err.name === 'NotAllowedError' || err.message?.includes('microphone')) {
        setDeviceError(err.message);
      }

      const orphanedSid = sessionIdRef.current;
      if (orphanedSid) {
        finalizeSession(familyId, dossierId, orphanedSid, 'interrupted', 0).catch(() => {});
        sessionIdRef.current = null;
        setSessionId(null);
      }

      mixer.stop().catch(() => {});
      disconnectWorklet();
      setStatus(ConnectionStatus.ERROR);
    }
  }, [familyId, dossierId, storytellerUid, dossier, questions, familyTree, promptPhotos, mixer, makeMessageHandler, wireWorklet, disconnectWorklet, buildTools, onQuestionUpdate, onShowPhoto, status]);

  /**
   * Reconnect to Gemini after an unexpected disconnect WITHOUT starting a new session.
   *
   * Unlike startSession, this function:
   *   - Keeps the existing Firestore session ID (no new doc created)
   *   - Preserves the in-memory transcript (messages state not reset)
   *   - Restarts the audio pipeline (fresh AudioContexts to avoid stale state)
   *   - Primes Gemini with the recent conversation so the interview continues naturally
   */
  const reconnectSession = useCallback(async () => {
    const existingSessionId = sessionIdRef.current;
    const duration = Math.round((Date.now() - sessionStartTimeRef.current) / 1000);
    console.log(`[Session] Reconnecting at ${new Date().toISOString()} — reusing session ${existingSessionId}, ${transcriptEntriesRef.current.length} transcript entries, session was ${duration}s old`);

    disconnectWorklet();

    try {
      setStatus(ConnectionStatus.CONNECTING);

      if (currentInputRef.current.trim()) {
        addMessage('user', currentInputRef.current);
        currentInputRef.current = '';
      }
      if (currentOutputRef.current.trim()) {
        addMessage('bot', currentOutputRef.current);
        currentOutputRef.current = '';
      }

      // Stop old audio contexts and start fresh ones.
      const partialBlob = await mixer.stop().catch((err) => {
        console.warn('[Session] Mixer stop error during reconnect:', err);
        return null;
      });
      if (partialBlob && existingSessionId) {
        console.log(`[Session] Uploading partial audio before reconnect (${partialBlob.size} bytes)`);
        archiveAudioToGCS(partialBlob, familyId, dossierId, existingSessionId)
          .catch((err) => console.error('[Session] Partial audio upload error during reconnect:', err));
      }

      await mixer.start();
      await mixer.inputContext!.audioWorklet.addModule('/pcm-processor.js');
      console.log(`[Session] Audio pipeline restarted for reconnect`);

      // Build context for Gemini: recent transcript + instruction to acknowledge the
      // interruption briefly before recapping, so the conversation sounds natural.
      const recentEntries = transcriptEntriesRef.current.slice(-20);
      const recentContext = recentEntries
        .map((e) => `${e.role === 'user' ? dossier.storytellerName : 'Interviewer'}: ${e.text}`)
        .join('\n');
      const resumePrompt = recentContext
        ? `[Technical note for the AI: a brief network interruption occurred and the connection has been restored.

IMPORTANT — do the following in your very next spoken response:
1. Briefly and warmly acknowledge the glitch in one short, casual sentence (e.g. "Oops — looks like we had a little connection hiccup there!" or "Oh, pardon the brief interruption!").
2. Immediately recap the specific topic or moment you were discussing just before it cut out, so ${dossier.storytellerName} knows you're right back where you left off (e.g. "We were just talking about…").
3. Then continue the interview naturally.

Keep the acknowledgement light — do not dwell on it.

Here is the conversation just before the interruption for context:
${recentContext}]`
        : `[Technical note for the AI: a brief network interruption occurred and the connection has been restored. Briefly and warmly acknowledge the glitch in one casual sentence, then invite ${dossier.storytellerName} to continue sharing their story.]`;

      const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });
      const systemInstruction = buildSystemInstruction({
        dossier,
        questions,
        familyTree,
        promptPhotos,
        completedSessionCount: 0, // Not fetching history on reconnect — transcript context is provided instead
        preferredName: dossier.preferredName,
      });

      const sessionPromise = ai.live.connect({
        model: GEMINI_MODEL,
        callbacks: {
          onopen: () => {
            console.log(`[Session] Reconnected to Gemini at ${new Date().toISOString()}`);
            setStatus(ConnectionStatus.CONNECTED);
            wireWorklet(sessionPromise);
            if (existingSessionId) {
              sessionIdRef.current = existingSessionId;
              setSessionId(existingSessionId);
            }
            sessionPromise.then((session) =>
              session.sendRealtimeInput({ text: resumePrompt }),
            );
          },
          onmessage: makeMessageHandler(),
          onerror: (error: any) => {
            const elapsed = Math.round((Date.now() - sessionStartTimeRef.current) / 1000);
            console.error(`[Session] Connection error during reconnect at ${new Date().toISOString()} (${elapsed}s):`, {
              type: (error as any)?.type,
              message: error?.message ?? String(error),
              error,
            });
            disconnectWorklet();
            sessionRef.current = null;
            setStatus(ConnectionStatus.ERROR);
          },
          onclose: (event?: any) => {
            const elapsed = Math.round((Date.now() - sessionStartTimeRef.current) / 1000);
            const code = event?.code ?? 'unknown';
            const reason = event?.reason ? `"${event.reason}"` : '(no reason)';
            const wasClean = event?.wasClean ?? 'unknown';
            console.log(`[Session] Reconnect connection closed — code=${code} reason=${reason} wasClean=${wasClean} elapsed=${elapsed}s`);
            disconnectWorklet();
            if (sessionRef.current !== null) {
              sessionRef.current = null;
              setStatus(ConnectionStatus.ERROR);
            }
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          thinkingConfig: { thinkingLevel: 'minimal' },
          systemInstruction,
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: dossier.selectedVoice },
            },
          },
          tools: [{ functionDeclarations: buildTools() }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      });

      sessionRef.current = await sessionPromise;
      console.log(`[Session] Reconnect complete, session ready`);
    } catch (err) {
      console.error('[Session] Reconnect failed:', err);
      setStatus(ConnectionStatus.ERROR);
    }
  }, [familyId, dossierId, dossier, questions, familyTree, promptPhotos, mixer, addMessage, makeMessageHandler, wireWorklet, disconnectWorklet, buildTools]);

  /**
   * Flush partial session data on error (for explicit give-up, not auto-reconnect).
   * Marks the session as 'interrupted' in Firestore and archives whatever audio
   * was captured. Call this when the user chooses to end a failed session.
   */
  const flushPartialSession = useCallback(async () => {
    console.log(`[Session] Flushing partial session ${sessionIdRef.current}`);

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
      if (transcriptEntriesRef.current.length > 0) {
        try {
          await syncTranscriptToFirestore(familyId, dossierId, currentSessionId, [...transcriptEntriesRef.current]);
        } catch (err) {
          console.error('[Firestore] Final transcript sync error:', err);
        }
      }

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
    reconnectSession,
    stopSession,
    flushPartialSession,
  };
}
