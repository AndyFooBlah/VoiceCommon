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


import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { Message, Dossier, ConnectionStatus, InterviewQuestion } from './types';
import { encode, decode, decodeAudioData } from './services/audioUtils';
import { Visualizer } from './components/Visualizer';
import { DossierEditor } from './components/DossierEditor';
import { archiveAudioToGCS, syncTranscriptToFirestore, updateQuestionStateInFirestore } from './services/storage';

const PERSONALITY_TRAITS = {
  empathetic: "You are a warm, gentle biographer. Focus on emotions and deep connection. Speak slowly and reassuringly.",
  investigative: "You are a professional oral historian. Focus on dates, names, places, and precise details. Build a clear timeline and probe for specifics.",
  casual: "You are like a curious, respectful grandchild. Use informal language, be expressive, and show genuine excitement for the stories."
};

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isBotSpeaking, setIsBotSpeaking] = useState(false);
  const [showArchivist, setShowArchivist] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const [dossier, setDossier] = useState<Dossier>({
    familyTree: [{ name: 'Arthur', relation: 'Father' }, { name: 'Eleanor', relation: 'Mother' }],
    historicalContext: 'Grandma grew up in coastal Maine during the post-war era.',
    questions: [
      { id: '1', text: 'Tell me about the place you explored most as a child.', status: 'Unasked', findings: '' },
      { id: '2', text: 'What did you think your life would look like when you were 18?', status: 'Unasked', findings: '' }
    ],
    selectedVoice: 'Zephyr',
    personality: 'investigative'
  });

  // Refs for audio and connection
  const currentInputRef = useRef('');
  const currentOutputRef = useRef('');
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);
  
  // Recording Refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Function to update question status (called by the model)
  const updateQuestionStatusLocal = (id: string, status: any, findings: string) => {
    setDossier(prev => ({
      ...prev,
      questions: prev.questions.map(q => q.id === id ? { ...q, status, findings } : q)
    }));
  };

  const addMessage = (role: 'user' | 'bot', text: string) => {
    const newMsg: Message = { id: Math.random().toString(36).substr(2, 9), role, text, timestamp: new Date() };
    setMessages(prev => {
      const next = [...prev, newMsg];
      if (sessionId) syncTranscriptToFirestore(next, sessionId);
      return next;
    });
  };

  const createPCMData = (data: Float32Array) => {
    const l = data.length;
    const int16 = new Int16Array(l);
    for (let i = 0; i < l; i++) int16[i] = data[i] * 32768;
    return { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
  };

  const handleInterruption = () => {
    for (const source of sourcesRef.current.values()) {
      try { source.stop(); } catch(e) {}
      sourcesRef.current.delete(source);
    }
    nextStartTimeRef.current = 0;
    setIsBotSpeaking(false);
  };

  const startSession = async () => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      const sId = `session_${Date.now()}`;
      setSessionId(sId);
      audioChunksRef.current = [];

      const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });
      
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Audio Archiving Setup
      const mixedDest = audioContextRef.current.createMediaStreamDestination();
      const userSource = audioContextRef.current.createMediaStreamSource(stream);
      userSource.connect(mixedDest);
      
      const mediaRecorder = new MediaRecorder(mixedDest.stream);
      mediaRecorder.ondataavailable = (e) => audioChunksRef.current.push(e.data);
      mediaRecorder.onstop = () => {
        const fullBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        archiveAudioToGCS(fullBlob, sId);
      };
      mediaRecorder.start();
      mediaRecorderRef.current = mediaRecorder;

      const updateQuestionStatusTool: FunctionDeclaration = {
        name: 'updateQuestionStatus',
        parameters: {
          type: Type.OBJECT,
          description: 'Update the archival progress of a specific life story question.',
          properties: {
            id: { type: Type.STRING, description: 'The unique ID of the question.' },
            status: { type: Type.STRING, enum: ['Unasked', 'InProgress', 'Completed'], description: 'The current status of the storytelling for this topic.' },
            findings: { type: Type.STRING, description: 'A brief summary of the key facts/stories uncovered for this question so far.' }
          },
          required: ['id', 'status', 'findings']
        }
      };

      const systemInstruction = `
        ${PERSONALITY_TRAITS[dossier.personality]}
        
        YOU ARE THE LEAD INTERVIEWER for a high-fidelity oral history project. 
        Your goal is to elicit deep, rich stories that can be archived forever.

        INTERVIEWING RULES:
        1. NEVER INTERRUPT: If the storyteller is speaking, let them speak. Even long pauses can be meaningful.
        2. HANDLE PAUSES:
           - If it seems they are searching for a word or continuing a thought, wait or say "Please continue..." or "I'm listening..."
           - If they finish a story, ask a follow-up about a specific detail: "You mentioned riding your bike to the lake. What was the lake like? Who was with you?"
           - If a topic feels fully explored, smoothly transition to the next "Unasked" question from the Story Queue.
        3. MAP STORIES TO QUESTIONS: Use the 'updateQuestionStatus' tool to track your progress.
           - When you start asking about a topic, mark it 'InProgress'.
           - Periodically update 'findings' as they share details.
           - Mark it 'Completed' only when you feel the story is rich and captured.

        KNOWLEDGE BASE:
        - Story Queue: ${JSON.stringify(dossier.questions)}
        - Family Tree: ${JSON.stringify(dossier.familyTree)}
        - Historical Context: ${dossier.historicalContext}

        MANDATORY START:
        You must speak first. Greet them warmly and start with a warm-up question like "How are you feeling today?" or "What's the weather like there?" 
        Build rapport before diving into the Story Queue.
      `;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const source = inputAudioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioContextRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPCMData(inputData);
              sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContextRef.current!.destination);
            
            // Proactively trigger the first turn (Greeting)
            sessionPromise.then(session => session.sendRealtimeInput({ media: { data: '', mimeType: 'audio/pcm;rate=16000' }}));
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Tool Calls
            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                if (fc.name === 'updateQuestionStatus') {
                  const { id, status, findings } = fc.args as any;
                  updateQuestionStatusLocal(id, status, findings);
                  sessionPromise.then(s => s.sendToolResponse({
                    functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } }
                  }));
                }
              }
            }

            // Handle Transcriptions
            if (message.serverContent?.outputTranscription) {
              currentOutputRef.current += message.serverContent.outputTranscription.text;
            } else if (message.serverContent?.inputTranscription) {
              currentInputRef.current += message.serverContent.inputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              if (currentInputRef.current) addMessage('user', currentInputRef.current);
              if (currentOutputRef.current) addMessage('bot', currentOutputRef.current);
              currentInputRef.current = '';
              currentOutputRef.current = '';
            }

            // Handle Audio
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && audioContextRef.current) {
              setIsBotSpeaking(true);
              const ctx = audioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.connect(mixedDest); // Mix into archive

              source.addEventListener('ended', () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) setIsBotSpeaking(false);
              });
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) handleInterruption();
          },
          onerror: () => setStatus(ConnectionStatus.ERROR),
          onclose: () => setStatus(ConnectionStatus.DISCONNECTED)
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: dossier.selectedVoice } },
          },
          tools: [{ functionDeclarations: [updateQuestionStatusTool] }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) {
      setStatus(ConnectionStatus.ERROR);
    }
  };

  const stopSession = () => {
    if (mediaRecorderRef.current) mediaRecorderRef.current.stop();
    if (sessionRef.current) sessionRef.current.close();
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (sessionId) updateQuestionStateInFirestore(dossier.questions, sessionId);
    handleInterruption();
    setStatus(ConnectionStatus.DISCONNECTED);
  };

  return (
    <div className="flex flex-col lg:flex-row h-screen bg-slate-50 overflow-hidden text-slate-900">
      <main className="flex-1 flex flex-col items-center justify-center p-6 lg:p-12 space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-6xl font-display font-bold text-slate-800 tracking-tighter">LegacyBot</h1>
          <p className="text-slate-400 font-medium italic">"Always archival, never forgotten."</p>
        </div>

        <div className="w-full max-w-2xl bg-white p-12 rounded-[3.5rem] shadow-2xl border border-slate-100 flex flex-col items-center space-y-12 relative overflow-hidden">
          {status === ConnectionStatus.CONNECTED && (
            <div className="absolute top-6 right-6 flex items-center gap-2 px-3 py-1 bg-rose-50 border border-rose-100 rounded-full animate-pulse">
              <div className="w-2 h-2 bg-rose-500 rounded-full" />
              <span className="text-[10px] font-bold text-rose-600 uppercase tracking-widest">Live Archival Vault Active</span>
            </div>
          )}

          <Visualizer isActive={status === ConnectionStatus.CONNECTED} isBotSpeaking={isBotSpeaking} />
          
          <div className="flex flex-col items-center gap-6 w-full">
            {status !== ConnectionStatus.CONNECTED ? (
              <button 
                onClick={startSession} 
                className="w-28 h-28 bg-indigo-600 rounded-full text-white shadow-2xl hover:scale-105 active:scale-95 transition-all flex items-center justify-center group"
              >
                <svg className="w-12 h-12 ml-1 group-hover:scale-110 transition-transform" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" />
                </svg>
              </button>
            ) : (
              <button 
                onClick={stopSession} 
                className="w-28 h-28 bg-slate-800 rounded-full text-white shadow-2xl hover:bg-slate-900 transition-all flex items-center justify-center"
              >
                <svg className="w-10 h-10" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" />
                </svg>
              </button>
            )}
            <div className="text-center space-y-1">
              <p className="text-xl font-bold text-slate-800">
                {status === ConnectionStatus.CONNECTED ? "Tell your story, we're listening..." : "Ready to begin your oral history?"}
              </p>
              <p className="text-sm text-slate-400">
                {status === ConnectionStatus.CONNECTED ? "Every word and sound is being preserved to Firestore and GCS." : "The Archivist has set up the storytelling queue."}
              </p>
            </div>
          </div>
        </div>

        <div className="w-full max-w-2xl space-y-4">
          <div className="flex justify-between items-center px-4">
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Real-time Archive</h3>
            <span className="text-[10px] text-slate-300 font-mono">Vault Session ID: {sessionId || '---'}</span>
          </div>
          <div className="bg-white/40 backdrop-blur-sm border border-slate-100 rounded-[2.5rem] p-8 h-56 overflow-y-auto space-y-6 shadow-inner scroll-smooth">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-slate-300 gap-4 opacity-50 text-center">
                <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                <p className="italic font-medium">Transcripts stream here as you speak. No data is ever deleted.</p>
              </div>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-2`}>
                  <div className={`max-w-[85%] px-5 py-3 rounded-3xl text-sm leading-relaxed ${
                    m.role === 'user' 
                      ? 'bg-indigo-600 text-white shadow-lg rounded-br-none' 
                      : 'bg-white text-slate-700 border border-slate-200 rounded-bl-none shadow-sm'
                  }`}>
                    {m.text}
                    <div className={`text-[9px] mt-1 opacity-50 ${m.role === 'user' ? 'text-white' : 'text-slate-400'}`}>
                      {m.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </main>

      <button 
        onClick={() => setShowArchivist(!showArchivist)} 
        className={`fixed bottom-8 right-8 p-5 rounded-full shadow-2xl transition-all z-50 flex items-center gap-3 font-bold border ${
          showArchivist ? 'bg-indigo-600 text-white border-indigo-500' : 'bg-white text-slate-600 border-slate-200 hover:scale-105'
        }`}
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /></svg>
        {showArchivist ? 'Close Settings' : 'Archivist Tools'}
      </button>

      {showArchivist && (
        <aside className="w-full lg:w-[32rem] border-l border-slate-200 bg-slate-50 shadow-2xl overflow-hidden animate-in slide-in-from-right duration-500">
          <DossierEditor dossier={dossier} onChange={setDossier} />
        </aside>
      )}

      {status === ConnectionStatus.ERROR && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/80 backdrop-blur-sm p-4 text-center">
          <div className="bg-white p-8 rounded-[2rem] shadow-2xl max-w-md space-y-6">
            <h2 className="text-2xl font-bold text-slate-800">Connection Failed</h2>
            <p className="text-slate-500">We couldn't connect to the archiving server. Please check your network and API key.</p>
            <button onClick={() => window.location.reload()} className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-bold">Retry Vault Connection</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
