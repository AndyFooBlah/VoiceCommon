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
 * SessionView — the live voice session page.
 *
 * Connects to Gemini Live, streams microphone audio, displays a real-time
 * transcript, and archives the mixed audio to GCS when the session ends.
 *
 * The system instruction and tools are assembled here from the VoiceCommon
 * framework defaults. Applications built on VoiceCommon can replace or extend
 * this component with their own instruction and tool registrations.
 */

import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useSession } from '../../hooks/useSession';
import { buildSessionInstruction, allTools } from '../../services/gemini';
import { getWeather } from '../../services/tools/weather';
import { searchPlace, getDistanceBetweenPlaces } from '../../services/tools/maps';
import { getJoke } from '../../services/tools/jokes';
import { searchWikipedia } from '../../services/tools/wikipedia';
import { ConnectionStatus } from '../../types';
import { Visualizer } from './Visualizer';
import { TranscriptFeed } from './TranscriptFeed';

export const SessionView: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [isBotSpeaking, setIsBotSpeaking] = useState(false);

  // Build a generic system instruction for this example app
  const systemInstruction = buildSessionInstruction({
    assistantName: 'Aria',
    currentDateTime: new Date().toLocaleString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }),
    appContext: 'You are a helpful voice assistant. Be concise, warm, and natural.',
  });

  // Tool dispatcher — routes Gemini tool calls to implementations
  const handleToolCall = useCallback(async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    switch (name) {
      case 'getWeather':
        return getWeather(args.location as string);
      case 'searchPlace':
        return searchPlace(args.query as string);
      case 'getDistanceBetweenPlaces':
        return getDistanceBetweenPlaces(args.from as string, args.to as string);
      case 'getJoke':
        return getJoke(args.category as string | undefined);
      case 'searchWikipedia':
        return searchWikipedia({
          question: args.question as string,
          maxChunks: args.maxChunks as number | undefined,
          maxAgeDays: args.maxAgeDays as number | undefined,
        });
      default:
        return `Unknown tool: ${name}`;
    }
  }, []);

  const { messages, connectionStatus, startSession, stopSession, isRecording, sessionId, error } =
    useSession({
      userId: user?.uid ?? '',
      systemInstruction,
      tools: allTools,
      onToolCall: handleToolCall,
      onSessionEndRequest: () => stopSession(),
      onBotSpeaking: setIsBotSpeaking,
    });

  async function handleEndSession() {
    await stopSession();
    navigate('/sessions');
  }

  const isConnected = connectionStatus === ConnectionStatus.CONNECTED;
  const isConnecting = connectionStatus === ConnectionStatus.CONNECTING;

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6 gap-8">
      {/* Header */}
      <div className="text-center space-y-1">
        <h1 className="text-2xl font-bold text-white tracking-tight">Voice Session</h1>
        <p className="text-slate-400 text-sm">
          {isConnected ? 'Connected — speak naturally' : isConnecting ? 'Connecting...' : 'Ready to start'}
        </p>
      </div>

      {/* Waveform visualizer */}
      <div className="w-full max-w-2xl">
        <Visualizer isActive={isConnected} isBotSpeaking={isBotSpeaking} />
      </div>

      {/* Real-time transcript */}
      <TranscriptFeed messages={messages} sessionId={sessionId} />

      {/* Error display */}
      {error && (
        <div className="w-full max-w-md bg-red-900/30 border border-red-700 rounded-2xl px-5 py-3 text-center">
          <p className="text-red-300 text-sm">{error}</p>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center gap-4">
        {!isRecording ? (
          <button
            onClick={() => startSession()}
            disabled={isConnecting || !user}
            className="px-10 py-4 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-2xl text-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-indigo-900/40"
          >
            {isConnecting ? 'Starting...' : 'Start Session'}
          </button>
        ) : (
          <button
            onClick={handleEndSession}
            className="px-10 py-4 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-2xl text-lg transition-colors shadow-lg shadow-rose-900/40"
          >
            End Session
          </button>
        )}

        {!isRecording && (
          <button
            onClick={() => navigate('/sessions')}
            className="px-6 py-4 bg-slate-700 hover:bg-slate-600 text-slate-300 font-medium rounded-2xl text-sm transition-colors"
          >
            Cancel
          </button>
        )}
      </div>

      {/* Connection status indicator */}
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${
          isConnected ? 'bg-emerald-400 animate-pulse' :
          isConnecting ? 'bg-amber-400 animate-pulse' :
          'bg-slate-600'
        }`} />
        <span className="text-xs text-slate-500 font-mono uppercase tracking-wider">
          {connectionStatus}
        </span>
      </div>
    </div>
  );
};
