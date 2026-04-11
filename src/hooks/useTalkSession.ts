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
 * Talk session hook for LegacyBot (#95 — Talk About My Family).
 *
 * A simplified version of useSession for free-form conversation.
 * Key differences from useSession:
 *   - No Firestore session document (nothing is archived)
 *   - No transcript sync to Firestore
 *   - No audio archival to GCS (blob is discarded on stop)
 *   - No story queue (updateQuestionStatus, reportEmotionalObservation)
 *   - Tools: recordFact, endTalk, setPreferredName
 *   - Fetches prior context (transcripts, events) for AI continuity
 *
 * The audio PCM pipeline is identical to useSession — we still need to
 * stream microphone audio to Gemini Live for real-time conversation.
 * We just don't record or upload it.
 *
 * References: design.md §3.7 | GitHub Issue #95
 */

import { useState, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration, ThinkingLevel } from '@google/genai';
import { Message, Dossier, FamilyMember, ConnectionStatus } from '../types';
import { useAudioMixer } from './useAudioMixer';
import { encode, decode, decodeAudioData } from '../services/audioUtils';
import { buildTalkSystemInstruction } from '../services/gemini';
import { getTalkContext, saveMiscFact, TalkContext } from '../services/storage';
import { searchWikipedia, searchPlace, getDistanceBetweenPlaces } from '../services/externalSearch';

const GEMINI_MODEL = 'gemini-3.1-flash-live-preview';

export interface UseTalkSessionOptions {
  familyId: string;
  dossierId: string;
  storytellerUid: string;
  dossier: Dossier;
  familyTree?: FamilyMember[];
  onPreferredNameUpdate?: (name: string) => void;
}

export function useTalkSession({
  familyId,
  dossierId,
  dossier,
  familyTree,
  onPreferredNameUpdate,
}: UseTalkSessionOptions) {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isBotSpeaking, setIsBotSpeaking] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [connectivityWarning, setConnectivityWarning] = useState<string | null>(null);

  const mixer = useAudioMixer();

  const currentInputRef = useRef('');
  const currentOutputRef = useRef('');
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const startTimeRef = useRef<number>(0);

  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const workletSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const pcmFrameCountRef = useRef(0);
  const pcmLogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  /** Add an in-memory message to the live transcript (not synced to Firestore). */
  const addMessage = useCallback((role: 'user' | 'bot', text: string) => {
    const newMsg: Message = {
      id: Math.random().toString(36).substr(2, 9),
      role,
      text,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, newMsg]);
  }, []);

  const formatToolCall = (name: string, args: Record<string, unknown>): string => {
    switch (name) {
      case 'searchWikipedia': return `Wikipedia: "${args.query}"`;
      case 'searchPlace': return `Place: "${args.query}"`;
      case 'getDistanceBetweenPlaces': return `Distance: "${args.placeA}" → "${args.placeB}"`;
      default: return `[${name}]`;
    }
  };

  /** Log a background tool call to the in-memory message feed. */
  const addToolEntry = useCallback((toolName: string, toolArgs: Record<string, unknown>) => {
    const newMsg: Message = {
      id: Math.random().toString(36).substr(2, 9),
      role: 'tool',
      text: formatToolCall(toolName, toolArgs),
      timestamp: new Date(),
      toolName,
      toolArgs,
    };
    setMessages((prev) => [...prev, newMsg]);
  }, []);

  const stopTalk = useCallback(async () => {
    console.log(`[Talk] Stopping at ${new Date().toISOString()}`);

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

    // Stop the mixer and discard the blob — talk sessions are not archived.
    await mixer.stop().catch(() => {});

    setStatus(ConnectionStatus.DISCONNECTED);
  }, [mixer, handleInterruption, disconnectWorklet, addMessage]);

  const buildTools = useCallback((): FunctionDeclaration[] => {
    const recordFactTool: FunctionDeclaration = {
      name: 'recordFact',
      parameters: {
        type: Type.OBJECT,
        description:
          'Save an interesting fact or correction mentioned during this conversation. ' +
          'Use this when the storyteller shares something new or corrects information from prior sessions. ' +
          'Do not record mundane conversational filler — only facts a biographer would find valuable.',
        properties: {
          text: {
            type: Type.STRING,
            description: 'The fact or correction, written as a clear, self-contained statement.',
          },
          isCorrection: {
            type: Type.BOOLEAN,
            description: 'Set to true if this fact corrects or updates something from a prior session.',
          },
          correctionNote: {
            type: Type.STRING,
            description:
              'If isCorrection is true, briefly describe what this corrects ' +
              '(e.g. "Prior sessions recorded birth year as 1936; storyteller clarified it was 1934").',
          },
        },
        required: ['text', 'isCorrection'],
      },
    };

    const endTalkTool: FunctionDeclaration = {
      name: 'endTalk',
      parameters: {
        type: Type.OBJECT,
        description:
          'End the talk conversation. Call this ONLY after you have spoken your closing words out loud. ' +
          'Use only when the storyteller clearly signals they are done.',
        properties: {},
        required: [],
      },
    };

    const setPreferredNameTool: FunctionDeclaration = {
      name: 'setPreferredName',
      parameters: {
        type: Type.OBJECT,
        description:
          'Record the name the storyteller prefers to be called. Call as soon as they tell you.',
        properties: {
          name: {
            type: Type.STRING,
            description: 'The name the storyteller wants to be addressed by.',
          },
        },
        required: ['name'],
      },
    };

    const searchWikipediaTool: FunctionDeclaration = {
      name: 'searchWikipedia',
      parameters: {
        type: Type.OBJECT,
        description:
          'Look up a topic, person, event, or place on Wikipedia silently. ' +
          'Use the result to enrich your responses — do not read the result aloud.',
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
          query: { type: Type.STRING, description: 'The place name or address to look up.' },
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

    return [recordFactTool, setPreferredNameTool, endTalkTool, searchWikipediaTool, searchPlaceTool, getDistanceTool];
  }, []);

  const makeMessageHandler = useCallback(
    () =>
      async (message: LiveServerMessage) => {
        if (message.toolCall?.functionCalls) {
          for (const fc of message.toolCall.functionCalls) {
            let toolResult: any = { result: 'ok' };

            if (fc.name === 'recordFact') {
              const { text, isCorrection, correctionNote } = fc.args as any;
              console.log(`[Talk] AI recording fact (isCorrection=${isCorrection}): ${text}`);
              saveMiscFact(familyId, dossierId, {
                text,
                isCorrection: Boolean(isCorrection),
                ...(correctionNote ? { correctionNote } : {}),
                source: 'talk',
              }).catch((err) => console.error('[Talk] saveMiscFact error:', err));
            } else if (fc.name === 'setPreferredName') {
              const { name } = fc.args as any;
              console.log(`[Talk] AI recorded preferred name: "${name}"`);
              if (onPreferredNameUpdate) onPreferredNameUpdate(name);
            } else if (fc.name === 'endTalk') {
              console.log('[Talk] AI called endTalk — waiting for closing audio');
              const maxWait = Date.now() + 30_000;
              const waitForAudioEnd = () => {
                if (sourcesRef.current.size === 0 || Date.now() > maxWait) {
                  stopTalk();
                } else {
                  setTimeout(waitForAudioEnd, 200);
                }
              };
              setTimeout(waitForAudioEnd, 500);
            } else if (fc.name === 'searchWikipedia') {
              const { query } = fc.args as any;
              console.log(`[Talk] AI searching Wikipedia: "${query}"`);
              addToolEntry('searchWikipedia', { query });
              try {
                toolResult = { result: await searchWikipedia(query) };
              } catch {
                toolResult = { result: 'Wikipedia search unavailable.' };
              }
            } else if (fc.name === 'searchPlace') {
              const { query } = fc.args as any;
              console.log(`[Talk] AI searching place: "${query}"`);
              addToolEntry('searchPlace', { query });
              try {
                toolResult = { result: await searchPlace(query) };
              } catch {
                toolResult = { result: 'Place search unavailable.' };
              }
            } else if (fc.name === 'getDistanceBetweenPlaces') {
              const { placeA, placeB } = fc.args as any;
              console.log(`[Talk] AI calculating distance: "${placeA}" → "${placeB}"`);
              addToolEntry('getDistanceBetweenPlaces', { placeA, placeB });
              try {
                toolResult = { result: await getDistanceBetweenPlaces(placeA, placeB) };
              } catch {
                toolResult = { result: 'Distance calculation unavailable.' };
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
            addMessage('bot', currentOutputRef.current);
            currentOutputRef.current = '';
          }
        }

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

        if (message.serverContent?.interrupted) handleInterruption();
      },
    [familyId, dossierId, mixer, addMessage, addToolEntry, handleInterruption, onPreferredNameUpdate, stopTalk],
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
        console.log(`[Talk PCM] ${pcmFrameCountRef.current} frames sent in last 10s`);
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
          .catch((err) => console.error('[Talk PCM] Send error:', err));
      };

      source.connect(workletNode);
      workletNode.connect(inputCtx.destination);
    },
    [mixer, createPCMData],
  );

  const startTalk = useCallback(async () => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      setMessages([]);
      setConnectivityWarning(null);
      console.log(`[Talk] Starting at ${new Date().toISOString()}`);

      // Compute current date/time from browser locale
      const currentDateTime = new Date().toLocaleString(navigator.language, {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        dateStyle: 'full',
        timeStyle: 'short',
      } as Intl.DateTimeFormatOptions);

      // Fetch prior context and check connectivity
      const emptyContext: TalkContext = { recentTranscripts: [], eventTitles: [], miscFactTexts: [] };
      let talkContext: TalkContext = emptyContext;
      try {
        const start = Date.now();
        talkContext = await Promise.race([
          getTalkContext(familyId, dossierId),
          new Promise<TalkContext>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 5000),
          ),
        ]).catch(() => emptyContext);
        const latency = Date.now() - start;
        console.log(`[Talk] Context fetch: ${latency}ms`);
        if (latency > 500) {
          setConnectivityWarning(
            `Your connection seems slow (${Math.round(latency)}ms latency). This conversation may experience interruptions.`,
          );
        }
      } catch {
        setConnectivityWarning('Network issue detected. Check your connection.');
      }

      await mixer.start();
      console.log(`[Talk] Audio mixer started`);

      startTimeRef.current = Date.now();
      await mixer.inputContext!.audioWorklet.addModule('/pcm-processor.js');

      const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });
      const systemInstruction = buildTalkSystemInstruction({
        dossier,
        familyTree,
        talkContext,
        preferredName: dossier.preferredName,
        currentDateTime,
      });

      const greetingTrigger = `[Begin the conversation. Greet ${dossier.preferredName ?? dossier.storytellerName} warmly and invite them to talk about anything on their mind — their family, a memory, someone they want to tell you about.]`;

      const sessionPromise = ai.live.connect({
        model: GEMINI_MODEL,
        callbacks: {
          onopen: () => {
            console.log(`[Talk] Gemini connection opened`);
            setStatus(ConnectionStatus.CONNECTED);
            wireWorklet(sessionPromise);
            sessionPromise.then((session) =>
              session.sendRealtimeInput({ text: greetingTrigger }),
            );
          },
          onmessage: makeMessageHandler(),
          onerror: (error: any) => {
            console.error('[Talk] Gemini error:', error);
            disconnectWorklet();
            sessionRef.current = null;
            setStatus(ConnectionStatus.ERROR);
          },
          onclose: (event?: any) => {
            const code = event?.code ?? 'unknown';
            console.log(`[Talk] Gemini closed — code=${code}`);
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
      console.log(`[Talk] Session ready`);
    } catch (err: any) {
      console.error('[Talk] Start error:', err);
      if (
        err.name === 'NoMicrophoneError' ||
        err.name === 'NotFoundError' ||
        err.name === 'NotAllowedError' ||
        err.message?.includes('microphone')
      ) {
        setDeviceError(err.message);
      }
      mixer.stop().catch(() => {});
      disconnectWorklet();
      setStatus(ConnectionStatus.ERROR);
    }
  }, [familyId, dossierId, dossier, familyTree, mixer, makeMessageHandler, wireWorklet, disconnectWorklet, buildTools, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearDeviceError = useCallback(() => setDeviceError(null), []);
  const dismissConnectivityWarning = useCallback(() => setConnectivityWarning(null), []);

  return {
    status,
    messages,
    isBotSpeaking,
    deviceError,
    connectivityWarning,
    clearDeviceError,
    dismissConnectivityWarning,
    startTalk,
    stopTalk,
  };
}
