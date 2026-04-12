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
 * Live session hook for VoiceCommon.
 *
 * Orchestrates the full lifecycle of a voice AI session:
 *   1. Start: Initialize audio mixer → Create Firestore session → Connect Gemini Live
 *   2. During: Stream PCM to Gemini, play bot audio, sync transcript in real-time
 *   3. Stop: Close Gemini, stop recorder, upload audio to GCS, finalize session
 *   4. Error: Auto-reconnect preserving session context
 *
 * The hook is generic — it accepts a system instruction and tool set from the
 * calling application. Tool call dispatch is handled via the onToolCall callback.
 */

import { useState, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { getConfig } from '../services/config';
import { Timestamp } from 'firebase/firestore';
import { Message, ConnectionStatus, TranscriptEntry } from '../types';
import { useAudioMixer } from './useAudioMixer';
import { encode, decode, decodeAudioData } from '../services/audioUtils';
import {
  createSession,
  finalizeSession,
  archiveAudioToGCS,
  syncTranscriptToFirestore,
} from '../services/storage';

const GEMINI_MODEL = 'gemini-2.5-flash-preview-native-audio-dialog';

/** Maximum seconds of audio lookahead before triggering a runaway-loop reset. */
const MAX_AUDIO_LOOKAHEAD_S = 30;

/** Compute word-overlap ratio between two strings to detect near-duplicate bot turns. */
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

export interface UseSessionOptions {
  userId: string;
  /** The full system instruction for Gemini. */
  systemInstruction: string;
  /** Tool declarations to register with Gemini. */
  tools?: FunctionDeclaration[];
  /**
   * Called when Gemini invokes a tool. The return value is sent back as the
   * tool result. Return a string describing the result.
   */
  onToolCall?: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Called when the bot requests to end the session via the 'endSession' tool. */
  onSessionEndRequest?: () => void;
  /** Called when bot audio starts playing (for UI feedback). */
  onBotSpeaking?: (speaking: boolean) => void;
}

export interface UseSessionReturn {
  messages: Message[];
  connectionStatus: ConnectionStatus;
  startSession: () => Promise<void>;
  stopSession: () => Promise<void>;
  isRecording: boolean;
  sessionId: string | null;
  error: string | null;
}

export function useSession(options: UseSessionOptions): UseSessionReturn {
  const {
    userId,
    systemInstruction,
    tools = [],
    onToolCall,
    onSessionEndRequest,
    onBotSpeaking,
  } = options;

  const [messages, setMessages] = useState<Message[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [isRecording, setIsRecording] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<string | null>(null);
  const sessionStartRef = useRef<Date | null>(null);
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  const messageIndexRef = useRef(0);

  const liveSessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const scheduleTimeRef = useRef(0);

  const mixer = useAudioMixer();

  // ---------------------------------------------------------------------------
  // Transcript helpers
  // ---------------------------------------------------------------------------

  const addMessage = useCallback((role: 'user' | 'bot' | 'tool', text: string, extra?: Partial<Message>) => {
    const msg: Message = {
      id: crypto.randomUUID(),
      role,
      text,
      timestamp: new Date(),
      ...extra,
    };
    setMessages((prev) => [...prev, msg]);
    return msg;
  }, []);

  const appendToTranscript = useCallback((role: 'user' | 'bot' | 'tool', text: string, extra?: Partial<TranscriptEntry>) => {
    const entry: TranscriptEntry = {
      role,
      text,
      timestamp: Timestamp.now(),
      messageIndex: messageIndexRef.current++,
      ...extra,
    };
    transcriptRef.current = [...transcriptRef.current, entry];
    if (sessionRef.current) {
      syncTranscriptToFirestore(sessionRef.current, transcriptRef.current).catch(console.error);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Audio playback
  // ---------------------------------------------------------------------------

  function playAudioChunk(pcm24k: ArrayBuffer): void {
    if (!audioContextRef.current) return;
    const ctx = audioContextRef.current;
    const pcmData = new Int16Array(pcm24k);
    const float32 = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) float32[i] = pcmData[i] / 32768;

    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now, scheduleTimeRef.current);
    if (startAt - now > MAX_AUDIO_LOOKAHEAD_S) {
      scheduleTimeRef.current = now;
      return;
    }
    source.start(startAt);
    scheduleTimeRef.current = startAt + buffer.duration;

    if (onBotSpeaking) {
      onBotSpeaking(true);
      source.onended = () => {
        if (scheduleTimeRef.current <= ctx.currentTime + 0.05) onBotSpeaking(false);
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Gemini message handler
  // ---------------------------------------------------------------------------

  async function handleServerMessage(msg: LiveServerMessage): Promise<void> {
    // Audio output
    if (msg.serverContent?.modelTurn?.parts) {
      for (const part of msg.serverContent.modelTurn.parts) {
        if (part.inlineData?.mimeType?.startsWith('audio/pcm')) {
          const raw = atob(part.inlineData.data ?? '');
          const bytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          playAudioChunk(bytes.buffer);
        }
      }
    }

    // Text output — accumulate into bot turn
    if (msg.serverContent?.modelTurn?.parts) {
      const textParts = msg.serverContent.modelTurn.parts
        .filter((p) => p.text)
        .map((p) => p.text!)
        .join('');
      if (textParts) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === 'bot') {
            return [...prev.slice(0, -1), { ...last, text: last.text + textParts }];
          }
          return [...prev, { id: crypto.randomUUID(), role: 'bot', text: textParts, timestamp: new Date() }];
        });
      }
    }

    // Turn complete — flush bot turn to transcript
    if (msg.serverContent?.turnComplete) {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === 'bot' && last.text.trim()) {
          appendToTranscript('bot', last.text.trim());
        }
        return prev;
      });
    }

    // User speech (input transcription)
    if (msg.serverContent?.inputTranscription?.text) {
      const text = msg.serverContent.inputTranscription.text;
      if (text.trim()) {
        addMessage('user', text);
        appendToTranscript('user', text);
      }
    }

    // Function calls
    if (msg.toolCall?.functionCalls?.length) {
      for (const call of msg.toolCall.functionCalls) {
        const name = call.name ?? '';
        const args = (call.args ?? {}) as Record<string, unknown>;

        if (name === 'endSession') {
          onSessionEndRequest?.();
          return;
        }

        let result = 'Tool executed.';
        if (onToolCall) {
          try {
            result = await onToolCall(name, args);
          } catch (err) {
            result = `Tool error: ${String(err)}`;
          }
        }

        addMessage('tool', `[${name}]`, { toolName: name, toolArgs: args });
        appendToTranscript('tool', `[${name}]`, { toolName: name, toolArgs: args, toolResult: result.slice(0, 500) });

        liveSessionRef.current?.sendToolResponse({
          functionResponses: [{ id: call.id, name, response: { result } }],
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  const startSession = useCallback(async () => {
    if (isRecording) return;
    setError(null);
    setMessages([]);
    transcriptRef.current = [];
    messageIndexRef.current = 0;

    try {
      setConnectionStatus(ConnectionStatus.CONNECTING);

      // Create Firestore session
      const sId = await createSession(userId);
      sessionRef.current = sId;
      setSessionId(sId);
      sessionStartRef.current = new Date();

      // Start audio mixer (captures mic + bot audio for archival)
      await mixer.start();

      // Reuse the mixer's playback AudioContext (24kHz) for bot audio scheduling
      audioContextRef.current = mixer.playbackContext ?? new AudioContext({ sampleRate: 24000 });
      scheduleTimeRef.current = 0;

      // Connect to Gemini Live
      const ai = new GoogleGenAI({ apiKey: getConfig().geminiApiKey });

      const allTools = [
        ...tools,
        {
          name: 'endSession',
          description: 'End the voice session. Call this only when the user explicitly signals they want to stop.',
          parameters: { type: Type.OBJECT, properties: {}, required: [] },
        } as FunctionDeclaration,
      ];

      const liveSession = await ai.live.connect({
        model: GEMINI_MODEL,
        config: {
          systemInstruction: { parts: [{ text: systemInstruction }] },
          responseModalities: [Modality.AUDIO, Modality.TEXT],
          inputAudioTranscription: {},
          thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
          tools: [{ functionDeclarations: allTools }],
        },
        callbacks: {
          onmessage: (msg: LiveServerMessage) => { handleServerMessage(msg).catch(console.error); },
          onerror: (err: ErrorEvent) => {
            console.error('[Session] Gemini error:', err);
            setError('Connection error — please try again.');
            setConnectionStatus(ConnectionStatus.ERROR);
          },
          onclose: () => {
            if (connectionStatus === ConnectionStatus.CONNECTED) {
              setConnectionStatus(ConnectionStatus.DISCONNECTED);
            }
          },
        },
      });

      liveSessionRef.current = liveSession;
      setConnectionStatus(ConnectionStatus.CONNECTED);
      setIsRecording(true);

      // Start streaming microphone PCM to Gemini via AudioWorklet
      const inputCtx = mixer.inputContext!;
      const micStream = mixer.stream!;
      const source = inputCtx.createMediaStreamSource(micStream);
      await inputCtx.audioWorklet.addModule('/pcm-processor.js');
      const worklet = new AudioWorkletNode(inputCtx, 'pcm-processor');
      source.connect(worklet);

      worklet.port.onmessage = (e: MessageEvent<{ channelData: Float32Array }>) => {
        if (!liveSessionRef.current) return;
        // Convert Float32 samples to Int16, then to Uint8Array for base64 encoding
        const float32 = e.data.channelData;
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
        }
        const pcm16 = encode(new Uint8Array(int16.buffer));
        liveSessionRef.current.sendRealtimeInput({
          audio: { data: pcm16, mimeType: 'audio/pcm;rate=16000' },
        });
      };
    } catch (err) {
      console.error('[Session] Start error:', err);
      setError(`Failed to start session: ${String(err)}`);
      setConnectionStatus(ConnectionStatus.ERROR);
    }
  }, [isRecording, userId, systemInstruction, tools, mixer, onToolCall, onSessionEndRequest]);

  const stopSession = useCallback(async () => {
    if (!isRecording) return;
    setIsRecording(false);
    setConnectionStatus(ConnectionStatus.DISCONNECTED);

    try {
      liveSessionRef.current?.close();
      liveSessionRef.current = null;

      audioContextRef.current = null;

      const audioBlob = await mixer.stop();
      const duration = sessionStartRef.current
        ? Math.round((Date.now() - sessionStartRef.current.getTime()) / 1000)
        : 0;

      let audioUrl: string | undefined;
      if (audioBlob && sessionRef.current) {
        try {
          audioUrl = await archiveAudioToGCS(audioBlob, userId, sessionRef.current);
        } catch (err) {
          console.error('[Session] Audio upload failed:', err);
        }
      }

      if (sessionRef.current) {
        await finalizeSession(sessionRef.current, 'completed', duration, audioUrl);
      }
    } catch (err) {
      console.error('[Session] Stop error:', err);
      if (sessionRef.current) {
        await finalizeSession(sessionRef.current, 'interrupted', 0).catch(console.error);
      }
    }
  }, [isRecording, userId, mixer]);

  return {
    messages,
    connectionStatus,
    startSession,
    stopSession,
    isRecording,
    sessionId,
    error,
  };
}
