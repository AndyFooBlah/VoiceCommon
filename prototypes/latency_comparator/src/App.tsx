import { useState, useEffect, useRef } from 'react';
import './App.css';
import { backstory } from './context/backstory';
import { conversationHistory as initialConversation } from './context/conversation_history';
import { interviewPlan } from './context/interview_plan';
import { HybridService } from './services/hybridService';

type Architecture = 'integrated' | 'hybrid';
type Status = 'idle' | 'listening' | 'thinking' | 'speaking';
type ConversationTurn = { speaker: 'user' | 'bot'; text: string };

function App() {
  const [architecture, setArchitecture] = useState<Architecture>('hybrid');
  const [status, setStatus] = useState<Status>('idle');
  const [transcript, setTranscript] = useState<ConversationTurn[]>([...initialConversation]);
  const [inProgressTranscript, setInProgressTranscript] = useState<string>('');
  const [latency, setLatency] = useState({ primary: 0, secondary: 0 });
  const [hasPermission, setHasPermission] = useState(false);

  const serviceRef = useRef<HybridService | null>(null);
  const latencyTimers = useRef<{ t_start: number, t_speech_end: number }>({ t_start: 0, t_speech_end: 0 });
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);

  const context = `
    ${backstory}
    **Interview Plan:**
    ${interviewPlan.map(item => `- ${item}`).join('\n')}
  `;

  useEffect(() => {
    const serviceConfig = {
      onTranscriptionUpdate: (text: string, isFinal: boolean) => {
        if (isFinal) {
          const t_transcript_ready = performance.now();
          if (latencyTimers.current.t_speech_end > 0) {
            setLatency(prev => ({
              ...prev,
              secondary: t_transcript_ready - latencyTimers.current.t_speech_end,
            }));
          }
          if (text) {
            setTranscript(prev => [...prev, { speaker: 'user', text: text }]);
          }
          setInProgressTranscript('');
        } else {
          setInProgressTranscript(text);
        }
      },
      onBotAudioResponse: (audio: Blob) => {
        const t_end = performance.now();
        if (latencyTimers.current.t_start > 0) {
          setLatency(prev => ({ ...prev, primary: t_end - latencyTimers.current.t_start }));
        }
        setStatus('speaking');
        
        const audioUrl = URL.createObjectURL(audio);
        const player = new Audio(audioUrl);
        audioPlayerRef.current = player;
        player.play();
        player.onended = () => {
          setStatus('listening');
          URL.revokeObjectURL(audioUrl);
        };
      },
      onBotThinking: () => {
        setStatus('thinking');
      },
      onBotFinishedSpeaking: () => {
        setStatus('listening');
      }
    };

    if (architecture === 'hybrid') {
      serviceRef.current = new HybridService(serviceConfig);
    } else {
      // Placeholder for IntegratedService
      serviceRef.current = null;
    }
  }, [architecture]);

  useEffect(() => {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        setHasPermission(true);
        stream.getTracks().forEach(track => track.stop());
      })
      .catch(() => setHasPermission(false));
  }, []);

  const handleStartStop = async () => {
    if (status === 'idle') {
      setStatus('listening');
      await serviceRef.current?.start();
    } else if (status === 'listening') {
      latencyTimers.current.t_start = performance.now();
      latencyTimers.current.t_speech_end = performance.now();
      await serviceRef.current?.stop(context, transcript);
    } else {
      if (audioPlayerRef.current) audioPlayerRef.current.pause();
      await serviceRef.current?.stop(context, transcript);
      setStatus('idle');
    }
  };

  return (
    <div className="container">
      <header>
        <h1>Conversational AI Latency Comparator</h1>
        <p>Interview with Dr. Eleanor Vance</p>
      </header>

      <div className="controls">
        <div className="control-group">
          <label htmlFor="architecture">Architecture:</label>
          <select
            id="architecture"
            value={architecture}
            onChange={(e) => setArchitecture(e.target.value as Architecture)}
            disabled={status !== 'idle'}
          >
            <option value="hybrid">Hybrid (Gradium + Gemini)</option>
            <option value="integrated" disabled>Integrated (Not Implemented)</option>
          </select>
        </div>
        <button onClick={handleStartStop} className={`status-${status}`} disabled={!hasPermission}>
          {status === 'idle' ? 'Start Interview' : `Status: ${status}... (Click to Stop)`}
        </button>
      </div>

      <div className="metrics">
        <h2>Performance Metrics</h2>
        <p>Primary Latency (Bot Response): <span>{latency.primary.toFixed(2)} ms</span></p>
        <p>Secondary Latency (Transcription): <span>{latency.secondary.toFixed(2)} ms</span></p>
      </div>

      <div className="transcript">
        <h2>Conversation Transcript</h2>
        <div className="transcript-log">
          {transcript.map((entry, index) => (
            <div key={index} className={`turn turn-${entry.speaker}`}>
              <strong>{entry.speaker === 'bot' ? 'Interviewer' : 'Eleanor'}:</strong>
              <p>{entry.text}</p>
            </div>
          ))}
          {inProgressTranscript && (
            <div className="turn turn-user-in-progress">
              <strong>Eleanor:</strong>
              <p><em>{inProgressTranscript}</em></p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
