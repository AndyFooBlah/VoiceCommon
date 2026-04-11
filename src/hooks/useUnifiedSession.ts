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
 * Unified session hook (#103 — combined interview + talk session).
 *
 * Replaces the separate useSession (interview) and useTalkSession (talk) hooks
 * with a single hook that does everything:
 *   - Full Firestore archival + GCS audio upload (same as useSession)
 *   - Auto-reconnect on unexpected disconnect (same as useSession)
 *   - recordFact tool for capturing facts during casual conversation (from useTalkSession)
 *   - All tools: updateQuestionStatus, reportEmotionalObservation, setPreferredName,
 *     endSession, showPhoto, searchWikipedia, searchPlace, getDistanceBetweenPlaces,
 *     getJoke, getWeather, recordFact
 *
 * The AI dynamically decides whether to interview or chat based on the storyteller's
 * cues. Both modes are seamlessly interleaved in a single archived session.
 *
 * References: design.md §3.2, §3.7 | GitHub Issue #103
 */

import { useState, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration, ThinkingLevel } from '@google/genai';
import { Timestamp } from 'firebase/firestore';
import { Message, Dossier, InterviewQuestion, FamilyMember, PromptPhoto, ConnectionStatus, TranscriptEntry } from '../types';
import { useAudioMixer } from './useAudioMixer';
import { encode, decode, decodeAudioData } from '../services/audioUtils';
import { buildSessionInstruction } from '../services/gemini';
import {
  createSession,
  finalizeSession,
  archiveAudioToGCS,
  syncTranscriptToFirestore,
  updateQuestionStateInFirestore,
  getCompletedSessionCount,
  getPreviousSessionSummary,
  getLastSessionDate,
  getRecentSessionDates,
  logEmotionalObservation,
  saveExtractedEvents,
  saveFamilyEvents,
  saveEngagementAssessment,
  saveSuggestedQuestions,
  getEvents,
  getTalkContext,
  saveMiscFact,
  TalkContext,
} from '../services/storage';
import { extractEvents, assessEngagement, suggestQuestions, cleanTranscriptText } from '../services/postSessionAnalysis';
import { searchWikipedia, searchPlace, getDistanceBetweenPlaces, getJoke, getWeather } from '../services/externalSearch';

const GEMINI_MODEL = 'gemini-3.1-flash-live-preview';

const MAX_AUDIO_LOOKAHEAD_S = 30;

function wordOverlapRatio(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const wa = tokenize(a);
  const wb = tokenize(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) { if (wb.has(w)) shared++; }
  return shared / Math.min(wa.size, wb.size);
}

interface UseUnifiedSessionOptions {
  familyId: string;
  dossierId: string;
  storytellerUid: string;
  dossier: Dossier;
  questions: InterviewQuestion[];
  familyTree?: FamilyMember[];
  promptPhotos?: PromptPhoto[];
  onQuestionUpdate: (questionId: string, status: string, findings: string) => void;
  onShowPhoto?: (photoId: string) => void;
  onPreferredNameUpdate?: (name: string) => void;
}

export function useUnifiedSession({
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
}: UseUnifiedSessionOptions) {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isBotSpeaking, setIsBotSpeaking] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [connectivityWarning, setConnectivityWarning] = useState<string | null>(null);

  const mixer = useAudioMixer();

  const currentInputRef = useRef('');
  const currentOutputRef = useRef('');
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const sessionStartTimeRef = useRef<number>(0);
  const transcriptEntriesRef = useRef<TranscriptEntry[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const workletSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const pcmFrameCountRef = useRef(0);
  const pcmLogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastBotOutputRef = useRef<string>('');

  const createPCMData = useCallback((data: Float32Array) => {
    const int16 = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767)));
    }
    return { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
  }, []);

  const handleInterruption = useCallback(() => {
    for (const source of sourcesRef.current.values()) {
      try { source.stop(); } catch (_) { /* already stopped */ }
      sourcesRef.current.delete(source);
    }
    nextStartTimeRef.current = 0;
    setIsBotSpeaking(false);
  }, []);

  const disconnectWorklet = useCallback(() => {
    if (pcmLogTimerRef.current) {
      clearInterval(pcmLogTimerRef.current);
      pcmLogTimerRef.current = null;
    }
    if (workletNodeRef.current) {
      try { workletNodeRef.current.port.onmessage = null; } catch { /* ignore */ }
      try { workletNodeRef.current.disconnect(); } catch { /* ignore */ }
      workletNodeRef.current = null;
    }
    if (workletSourceRef.current) {
      try { workletSourceRef.current.disconnect(); } catch { /* ignore */ }
      workletSourceRef.current = null;
    }
  }, []);

  const formatToolCall = (name: string, args: Record<string, unknown>): string => {
    switch (name) {
      case 'searchWikipedia': return `Wikipedia: "${args.query}"`;
      case 'searchPlace': return `Place: "${args.query}"`;
      case 'getDistanceBetweenPlaces': return `Distance: "${args.placeA}" → "${args.placeB}"`;
      case 'getJoke': return `Joke`;
      case 'getWeather': return `Weather: "${args.location}"`;
      case 'recordFact': return `Fact recorded`;
      default: return `[${name}]`;
    }
  };

  const addToolEntry = useCallback(
    (toolName: string, toolArgs: Record<string, unknown>, toolResult: string) => {
      const text = formatToolCall(toolName, toolArgs);
      const newMsg: Message = {
        id: Math.random().toString(36).substr(2, 9),
        role: 'tool',
        text,
        timestamp: new Date(),
        toolName,
        toolArgs,
      };
      setMessages((prev) => [...prev, newMsg]);

      const entryIndex = transcriptEntriesRef.current.length;
      transcriptEntriesRef.current.push({
        role: 'tool',
        text,
        toolName,
        toolArgs,
        toolResult: toolResult.slice(0, 500),
        timestamp: Timestamp.now(),
        messageIndex: entryIndex,
      });

      const currentSessionId = sessionIdRef.current;
      if (currentSessionId) {
        syncTranscriptToFirestore(familyId, dossierId, currentSessionId, [...transcriptEntriesRef.current]).catch(
          (err) => console.error('[Firestore] Tool entry sync error:', err),
        );
      }
    },
    [familyId, dossierId],
  );

  const addMessage = useCallback(
    (role: 'user' | 'bot', text: string) => {
      const newMsg: Message = {
        id: Math.random().toString(36).substr(2, 9),
        role,
        text,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, newMsg]);

      const entryIndex = transcriptEntriesRef.current.length;
      transcriptEntriesRef.current.push({
        role,
        text,
        timestamp: Timestamp.now(),
        messageIndex: entryIndex,
      });

      const currentSessionId = sessionIdRef.current;
      if (currentSessionId) {
        syncTranscriptToFirestore(familyId, dossierId, currentSessionId, [...transcriptEntriesRef.current]).catch(
          (err) => console.error('[Firestore] Transcript sync error:', err),
        );

        cleanTranscriptText(text).then((cleanText) => {
          if (cleanText && cleanText !== text && transcriptEntriesRef.current[entryIndex]) {
            transcriptEntriesRef.current[entryIndex] = {
              ...transcriptEntriesRef.current[entryIndex],
              cleanText,
            };
            const sid = sessionIdRef.current;
            if (sid) {
              syncTranscriptToFirestore(familyId, dossierId, sid, [...transcriptEntriesRef.current]).catch(() => {});
            }
          }
        }).catch(() => {});
      }
    },
    [familyId, dossierId],
  );

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
        description: 'Log a significant emotional observation about the storyteller.',
        properties: {
          mood: {
            type: Type.STRING,
            enum: ['engaged', 'neutral', 'hesitant', 'emotional', 'distressed', 'joyful'],
            description: 'The observed emotional state.',
          },
          confidence: { type: Type.NUMBER, description: 'Confidence in this observation (0.0 to 1.0).' },
          trigger: { type: Type.STRING, description: 'What caused this emotional shift.' },
          recommendation: { type: Type.STRING, description: 'What you plan to do in response.' },
        },
        required: ['mood', 'confidence', 'trigger', 'recommendation'],
      },
    };

    const showPhotoTool: FunctionDeclaration = {
      name: 'showPhoto',
      parameters: {
        type: Type.OBJECT,
        description: 'Display a prompt photo to the storyteller.',
        properties: {
          photoId: { type: Type.STRING, description: 'The unique ID of the prompt photo.' },
        },
        required: ['photoId'],
      },
    };

    const setPreferredNameTool: FunctionDeclaration = {
      name: 'setPreferredName',
      parameters: {
        type: Type.OBJECT,
        description: 'Record the name the storyteller prefers to be called.',
        properties: {
          name: { type: Type.STRING, description: 'The name the storyteller wants to be addressed by.' },
        },
        required: ['name'],
      },
    };

    const endSessionTool: FunctionDeclaration = {
      name: 'endSession',
      parameters: {
        type: Type.OBJECT,
        description:
          'End the session. Call ONLY after speaking your warm closing words out loud. ' +
          'Use when the storyteller clearly signals they are done.',
        properties: {},
        required: [],
      },
    };

    const recordFactTool: FunctionDeclaration = {
      name: 'recordFact',
      parameters: {
        type: Type.OBJECT,
        description:
          'Save an interesting fact or correction mentioned during the conversation. ' +
          'Use when the storyteller shares something new or corrects information from prior sessions. ' +
          'Do not record mundane filler — only facts a biographer would find valuable.',
        properties: {
          text: {
            type: Type.STRING,
            description: 'The fact or correction, as a clear self-contained statement.',
          },
          isCorrection: {
            type: Type.BOOLEAN,
            description: 'True if this fact corrects or updates something from a prior session.',
          },
          correctionNote: {
            type: Type.STRING,
            description: 'If isCorrection is true, briefly describe what this corrects.',
          },
        },
        required: ['text', 'isCorrection'],
      },
    };

    const searchWikipediaTool: FunctionDeclaration = {
      name: 'searchWikipedia',
      parameters: {
        type: Type.OBJECT,
        description: 'Look up a topic, person, event, or place on Wikipedia silently. Use the result to ask better follow-up questions — do not read the result aloud.',
        properties: {
          query: { type: Type.STRING, description: 'The search term.' },
        },
        required: ['query'],
      },
    };

    const searchPlaceTool: FunctionDeclaration = {
      name: 'searchPlace',
      parameters: {
        type: Type.OBJECT,
        description: 'Look up a geographic location by name. Use the result naturally — do not recite coordinates.',
        properties: {
          query: { type: Type.STRING, description: 'The place name or address.' },
        },
        required: ['query'],
      },
    };

    const getDistanceTool: FunctionDeclaration = {
      name: 'getDistanceBetweenPlaces',
      parameters: {
        type: Type.OBJECT,
        description: 'Calculate the approximate straight-line distance between two named places.',
        properties: {
          placeA: { type: Type.STRING, description: 'The first place name or address.' },
          placeB: { type: Type.STRING, description: 'The second place name or address.' },
        },
        required: ['placeA', 'placeB'],
      },
    };

    const getJokeTool: FunctionDeclaration = {
      name: 'getJoke',
      parameters: {
        type: Type.OBJECT,
        description: 'Fetch a random joke to share when the moment calls for levity.',
        properties: {},
        required: [],
      },
    };

    const getWeatherTool: FunctionDeclaration = {
      name: 'getWeather',
      parameters: {
        type: Type.OBJECT,
        description: 'Get the current weather and a 3-day forecast for a given location.',
        properties: {
          location: { type: Type.STRING, description: 'City, address, or place name.' },
        },
        required: ['location'],
      },
    };

    return [
      updateQuestionStatusTool,
      reportEmotionalObservationTool,
      setPreferredNameTool,
      endSessionTool,
      recordFactTool,
      searchWikipediaTool,
      searchPlaceTool,
      getDistanceTool,
      getJokeTool,
      getWeatherTool,
      ...(promptPhotos && promptPhotos.length > 0 ? [showPhotoTool] : []),
    ];
  }, [promptPhotos]);

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
            extractEvents(entriesCopy, sid, existingEvents).catch(() => []),
            assessEngagement(entriesCopy, questionsCopy).catch(() => null),
            suggestQuestions(entriesCopy, questionsCopy, dossier).catch(() => []),
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

  const makeMessageHandler = useCallback(
    () =>
      async (message: LiveServerMessage) => {
        if (message.toolCall?.functionCalls) {
          for (const fc of message.toolCall.functionCalls) {
            let toolResult: any = { result: 'ok' };

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
            } else if (fc.name === 'recordFact') {
              const { text, isCorrection, correctionNote } = fc.args as any;
              console.log(`[Session] AI recording fact (isCorrection=${isCorrection}): ${text}`);
              addToolEntry('recordFact', { isCorrection: Boolean(isCorrection) }, text);
              saveMiscFact(familyId, dossierId, {
                text,
                isCorrection: Boolean(isCorrection),
                ...(correctionNote ? { correctionNote } : {}),
                source: 'talk',
              }).catch((err) => console.error('[Session] saveMiscFact error:', err));
            } else if (fc.name === 'endSession') {
              console.log('[Session] AI called endSession — waiting for closing audio');
              const maxWait = Date.now() + 30_000;
              const waitForAudioEnd = () => {
                if (sourcesRef.current.size === 0 || Date.now() > maxWait) {
                  stopSession();
                } else {
                  setTimeout(waitForAudioEnd, 200);
                }
              };
              setTimeout(waitForAudioEnd, 500);
            } else if (fc.name === 'searchWikipedia') {
              const { query } = fc.args as any;
              console.log(`[Session] AI searching Wikipedia: "${query}"`);
              try {
                const result = await searchWikipedia(query);
                toolResult = { result };
                addToolEntry('searchWikipedia', { query }, result);
              } catch {
                toolResult = { result: 'Wikipedia search unavailable.' };
                addToolEntry('searchWikipedia', { query }, 'Search unavailable.');
              }
            } else if (fc.name === 'searchPlace') {
              const { query } = fc.args as any;
              console.log(`[Session] AI searching place: "${query}"`);
              try {
                const result = await searchPlace(query);
                toolResult = { result };
                addToolEntry('searchPlace', { query }, result);
              } catch {
                toolResult = { result: 'Place search unavailable.' };
                addToolEntry('searchPlace', { query }, 'Search unavailable.');
              }
            } else if (fc.name === 'getDistanceBetweenPlaces') {
              const { placeA, placeB } = fc.args as any;
              console.log(`[Session] AI calculating distance: "${placeA}" → "${placeB}"`);
              try {
                const result = await getDistanceBetweenPlaces(placeA, placeB);
                toolResult = { result };
                addToolEntry('getDistanceBetweenPlaces', { placeA, placeB }, result);
              } catch {
                toolResult = { result: 'Distance calculation unavailable.' };
                addToolEntry('getDistanceBetweenPlaces', { placeA, placeB }, 'Unavailable.');
              }
            } else if (fc.name === 'getJoke') {
              console.log(`[Session] AI fetching joke`);
              try {
                const result = await getJoke();
                toolResult = { result };
                addToolEntry('getJoke', {}, result);
              } catch {
                toolResult = { result: 'Joke unavailable.' };
                addToolEntry('getJoke', {}, 'Unavailable.');
              }
            } else if (fc.name === 'getWeather') {
              const { location } = fc.args as any;
              console.log(`[Session] AI checking weather for: "${location}"`);
              try {
                const result = await getWeather(location);
                toolResult = { result };
                addToolEntry('getWeather', { location }, result);
              } catch {
                toolResult = { result: 'Weather lookup unavailable.' };
                addToolEntry('getWeather', { location }, 'Unavailable.');
              }
            }

            const session = sessionRef.current;
            if (session) {
              session.sendToolResponse({
                functionResponses: [{ id: fc.id, name: fc.name, response: toolResult }],
              });
            }
          }
        }

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
            const outputText = currentOutputRef.current.trim();
            currentOutputRef.current = '';

            const wordCount = outputText.split(/\s+/).length;
            const overlap = wordOverlapRatio(outputText, lastBotOutputRef.current);
            if (wordCount > 12 && overlap > 0.85) {
              console.warn(
                `[Session] Repetition loop detected — ${Math.round(overlap * 100)}% word overlap. Interrupting.`,
              );
              handleInterruption();
              const session = sessionRef.current;
              if (session) {
                try {
                  session.sendRealtimeInput({
                    text: '[Internal system note — not for the storyteller: the previous response was an exact repeat. Resume the conversation naturally from where you left off without acknowledging this note.]',
                  });
                } catch (e) {
                  console.warn('[Session] Could not send repetition-recovery prompt:', e);
                }
              }
            } else {
              addMessage('bot', outputText);
              lastBotOutputRef.current = outputText;
            }
          }
        }

        for (const part of message.serverContent?.modelTurn?.parts ?? []) {
          const audioData = part?.inlineData?.data;
          if (audioData && mixer.playbackContext) {
            const ctx = mixer.playbackContext;

            if (nextStartTimeRef.current - ctx.currentTime > MAX_AUDIO_LOOKAHEAD_S) {
              console.warn(`[Session] Audio backlog exceeded ${MAX_AUDIO_LOOKAHEAD_S}s — skipping chunk.`);
              handleInterruption();
              nextStartTimeRef.current = ctx.currentTime;
              continue; // eslint-disable-line no-continue
            }

            setIsBotSpeaking(true);
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

        if (message.serverContent?.interrupted) handleInterruption();
      },
    [familyId, dossierId, promptPhotos, mixer, addMessage, addToolEntry, handleInterruption, onQuestionUpdate, onShowPhoto, onPreferredNameUpdate, stopSession],
  );

  const wireWorklet = useCallback(
    (sessionPromise: Promise<any>) => {
      const inputCtx = mixer.inputContext!;
      const source = inputCtx.createMediaStreamSource(mixer.stream!);
      workletSourceRef.current = source;

      const workletNode = new AudioWorkletNode(inputCtx, 'pcm-processor');
      workletNodeRef.current = workletNode;

      pcmFrameCountRef.current = 0;
      pcmLogTimerRef.current = setInterval(() => {
        console.log(`[PCM] ${pcmFrameCountRef.current} frames sent in last 10s`);
        pcmFrameCountRef.current = 0;
      }, 10_000);

      workletNode.port.onmessage = (e: MessageEvent) => {
        if (!sessionRef.current) return;
        pcmFrameCountRef.current++;
        const channelData = new Float32Array(e.data.channelData);
        const pcmBlob = createPCMData(channelData);
        sessionPromise
          .then((session) => {
            if (!sessionRef.current) return;
            session.sendRealtimeInput({ audio: pcmBlob });
          })
          .catch((err) => console.error('[PCM] Send error:', err));
      };

      source.connect(workletNode);
      workletNode.connect(inputCtx.destination);
    },
    [mixer, createPCMData],
  );

  const startSession = useCallback(async () => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      setMessages([]);
      transcriptEntriesRef.current = [];
      lastBotOutputRef.current = '';
      setConnectivityWarning(null);
      console.log(`[Session] Starting new session at ${new Date().toISOString()}`);

      const currentDateTime = new Date().toLocaleString(navigator.language, {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        dateStyle: 'full',
        timeStyle: 'short',
      } as Intl.DateTimeFormatOptions);

      let completedSessionCount = 0;
      let previousSessionSummary: string | undefined;
      let lastSessionDate: Date | undefined;
      let recentSessionDates: Date[] = [];
      let talkContext: TalkContext = { recentTranscripts: [], eventTitles: [], miscFactTexts: [] };

      try {
        const start = Date.now();
        [completedSessionCount, previousSessionSummary, lastSessionDate, recentSessionDates, talkContext] =
          await Promise.all([
            Promise.race([
              getCompletedSessionCount(familyId, dossierId),
              new Promise<number>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
            ]).catch(() => 0),
            getPreviousSessionSummary(familyId, dossierId).catch(() => undefined),
            getLastSessionDate(familyId, dossierId).catch(() => undefined),
            getRecentSessionDates(familyId, dossierId).catch(() => [] as Date[]),
            getTalkContext(familyId, dossierId).catch(() => ({ recentTranscripts: [], eventTitles: [], miscFactTexts: [] })),
          ]);
        const latency = Date.now() - start;
        console.log(`[Session] Firestore context fetch: ${latency}ms`);
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

      await mixer.start();
      console.log(`[Session] Audio mixer started`);

      const sId = await createSession(familyId, dossierId, storytellerUid);
      setSessionId(sId);
      sessionIdRef.current = sId;
      sessionStartTimeRef.current = Date.now();
      console.log(`[Session] Firestore session created: ${sId}`);

      await mixer.inputContext!.audioWorklet.addModule('/pcm-processor.js');
      console.log(`[Session] PCM AudioWorklet registered`);

      const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });
      const systemInstruction = buildSessionInstruction({
        dossier,
        questions,
        familyTree,
        promptPhotos,
        completedSessionCount,
        previousSessionSummary,
        lastSessionDate,
        preferredName: dossier.preferredName,
        currentDateTime,
        recentSessionDates,
        talkContext,
      });

      const greetingTrigger = completedSessionCount === 0
        ? `[First session with ${dossier.storytellerName}. Introduce yourself and begin as instructed.]`
        : `[Returning session #${completedSessionCount + 1} with ${dossier.storytellerName}. Welcome them back as instructed and continue their story.]`;

      const sessionPromise = ai.live.connect({
        model: GEMINI_MODEL,
        callbacks: {
          onopen: () => {
            console.log(`[Session] Gemini connection opened at ${new Date().toISOString()}`);
            setStatus(ConnectionStatus.CONNECTED);
            wireWorklet(sessionPromise);
            sessionPromise.then((session) =>
              session.sendRealtimeInput({ text: greetingTrigger }),
            );
          },
          onmessage: makeMessageHandler(),
          onerror: (error: any) => {
            console.error(`[Session] Gemini error:`, error);
            disconnectWorklet();
            sessionRef.current = null;
            setStatus(ConnectionStatus.ERROR);
          },
          onclose: (event?: any) => {
            const code = event?.code ?? 'unknown';
            console.log(`[Session] Gemini closed — code=${code}`);
            disconnectWorklet();
            if (sessionRef.current !== null) {
              sessionRef.current = null;
              setStatus(ConnectionStatus.ERROR);
            }
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
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
      console.log(`[Session] Session ready`);
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
  }, [familyId, dossierId, storytellerUid, dossier, questions, familyTree, promptPhotos, mixer, makeMessageHandler, wireWorklet, disconnectWorklet, buildTools, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const reconnectSession = useCallback(async () => {
    const existingSessionId = sessionIdRef.current;
    const duration = Math.round((Date.now() - sessionStartTimeRef.current) / 1000);
    console.log(`[Session] Reconnecting — reusing session ${existingSessionId}, ${transcriptEntriesRef.current.length} entries, ${duration}s elapsed`);

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

      const partialBlob = await mixer.stop().catch(() => null);
      if (partialBlob && existingSessionId) {
        archiveAudioToGCS(partialBlob, familyId, dossierId, existingSessionId)
          .catch((err) => console.error('[Session] Partial audio upload error during reconnect:', err));
      }

      await mixer.start();
      await mixer.inputContext!.audioWorklet.addModule('/pcm-processor.js');

      const recentEntries = transcriptEntriesRef.current.slice(-20);
      const recentContext = recentEntries
        .map((e) => `${e.role === 'user' ? dossier.storytellerName : 'Interviewer'}: ${e.text}`)
        .join('\n');
      const resumePrompt = recentContext
        ? `[Technical note: a brief network interruption occurred. In your next response: (1) briefly and warmly acknowledge the glitch in one casual sentence, (2) recap the specific moment you were discussing, (3) continue naturally. Recent context:\n${recentContext}]`
        : `[Technical note: a brief network interruption occurred. Briefly and warmly acknowledge it, then invite ${dossier.storytellerName} to continue.]`;

      const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });
      const systemInstruction = buildSessionInstruction({
        dossier,
        questions,
        familyTree,
        promptPhotos,
        completedSessionCount: 0,
        preferredName: dossier.preferredName,
      });

      const sessionPromise = ai.live.connect({
        model: GEMINI_MODEL,
        callbacks: {
          onopen: () => {
            console.log(`[Session] Reconnected to Gemini`);
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
            console.error('[Session] Reconnect error:', error);
            disconnectWorklet();
            sessionRef.current = null;
            setStatus(ConnectionStatus.ERROR);
          },
          onclose: (event?: any) => {
            const code = event?.code ?? 'unknown';
            console.log(`[Session] Reconnect connection closed — code=${code}`);
            disconnectWorklet();
            if (sessionRef.current !== null) {
              sessionRef.current = null;
              setStatus(ConnectionStatus.ERROR);
            }
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
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
      console.log(`[Session] Reconnect complete`);
    } catch (err) {
      console.error('[Session] Reconnect failed:', err);
      setStatus(ConnectionStatus.ERROR);
    }
  }, [familyId, dossierId, dossier, questions, familyTree, promptPhotos, mixer, addMessage, makeMessageHandler, wireWorklet, disconnectWorklet, buildTools]);

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

  const dismissConnectivityWarning = useCallback(() => setConnectivityWarning(null), []);

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
