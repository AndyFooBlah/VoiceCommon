import { GoogleGenerativeAI } from "@google/generative-ai";
import { convertFloat32ToInt16, Resampler, arrayBufferToBase64 } from "../utils/audioUtils";

interface HybridServiceConfig {
  onTranscriptionUpdate: (text: string, isFinal: boolean) => void;
  onBotAudioResponse: (audio: Blob) => void;
  onBotThinking: () => void;
  onBotFinishedSpeaking: () => void;
}

const TARGET_SAMPLE_RATE = 24000;
const AUDIO_BUFFER_SIZE = 4096;

export class HybridService {
  private config: HybridServiceConfig;
  private genAI: GoogleGenerativeAI;
  
  private sttSocket: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private audioProcessor: ScriptProcessorNode | null = null;

  private audioQueue: Blob[] = [];
  private isPlaying = false;
  private finalTranscript = '';
  private sttReadyPromise: Promise<void>;
  private sttReadyResolve: (() => void) | null = null;

  constructor(config: HybridServiceConfig) {
    this.config = config;

    const geminiApiKey = import.meta.env.VITE_GEMINI_API_KEY;
    if (!geminiApiKey) throw new Error("VITE_GEMINI_API_KEY is not set.");
    this.genAI = new GoogleGenerativeAI(geminiApiKey);

    this.sttReadyPromise = new Promise(resolve => { this.sttReadyResolve = resolve; });

    console.log("Hybrid Service Initialized");
  }

  public async start() {
    this.finalTranscript = '';
    await this.connectToStt();
    
    // Start processing audio and sending it only after STT is ready
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.processAudio();
  }

  private connectToStt = () => {
    // Connect to the local Node.js proxy (server.ts runs on port 3001)
    const sttUrl = 'ws://localhost:3001';

    this.sttSocket = new WebSocket(sttUrl);
    
    return new Promise<void>((resolve, reject) => {
      this.sttSocket!.onopen = () => {
        console.log("STT WebSocket connected to proxy. Sending setup message...");

        const setupMessage = {
          type: "setup",
          model_name: "default",
          input_format: "pcm"
        };
        this.sttSocket!.send(JSON.stringify(setupMessage));

        // Resolve immediately after sending setup — audio streaming can begin.
        // Handle the 'ready' acknowledgment in onmessage if Gradium sends one.
        console.log("Setup sent. Ready to stream audio.");
        resolve();
      };

      this.sttSocket!.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'text') {
          // Gradium STT sends {type:'text', text, start_s, stop_s} — no is_final flag.
          // Accumulate segments into a running transcript and surface as in-progress.
          this.finalTranscript += data.text + ' ';
          this.config.onTranscriptionUpdate(this.finalTranscript.trim(), false);
        } else if (data.type === 'ready') {
          console.log('Gradium STT ready:', data);
        } else if (data.type === 'error') {
          console.error('Gradium STT error:', data.message);
          reject(new Error(data.message));
        } else {
          console.log('Received message from Gradium STT:', data);
        }
      };

      this.sttSocket!.onclose = (event) => {
        console.log("STT WebSocket closed.", event);
        this.cleanup();
      };
      this.sttSocket!.onerror = (error) => {
        console.error("STT WebSocket error:", error);
        this.cleanup();
        reject(error);
      };
    });
  }

  private processAudio() {
    if (!this.stream) return;
    this.audioContext = new window.AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.audioProcessor = this.audioContext.createScriptProcessor(AUDIO_BUFFER_SIZE, 1, 1);

    const resampler = new Resampler(this.audioContext.sampleRate, TARGET_SAMPLE_RATE);

    this.audioProcessor.onaudioprocess = (event: AudioProcessingEvent) => {
      const inputData = event.inputBuffer.getChannelData(0);
      const resampledData = resampler.resample(inputData);
      const pcmData = convertFloat32ToInt16(resampledData);

      if (this.sttSocket && this.sttSocket.readyState === WebSocket.OPEN) {
        // Gradium expects JSON with base64-encoded PCM — not raw binary.
        const base64Audio = arrayBufferToBase64(pcmData.buffer);
        this.sttSocket.send(JSON.stringify({ type: "audio", audio: base64Audio }));
      }
    };

    source.connect(this.audioProcessor);
    this.audioProcessor.connect(this.audioContext.destination);
  }

  // Moved into connectToStt to ensure listener is active before ready message
  private listenForTranscription() {}

  public async stop(context: string, history: any[]) {
    // Signal end of stream to Gradium BEFORE cleanup
    if (this.sttSocket && this.sttSocket.readyState === WebSocket.OPEN) {
      this.sttSocket.send(JSON.stringify({ type: "end_of_stream" }));
    }
    
    this.cleanup(); // Clean up local resources

    // Mark the accumulated user transcript as final in the UI, then process it.
    const transcriptToProcess = this.finalTranscript.trim();
    if (transcriptToProcess) {
      this.config.onTranscriptionUpdate(transcriptToProcess, true);
      this.processFinalTranscript(transcriptToProcess, context, history);
    }
  }

  private cleanup = async () => {
    // Stop sending audio
    if (this.audioProcessor) {
      this.audioProcessor.disconnect();
      this.audioProcessor = null;
    }
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
    if(this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    // Close the socket here, it will trigger onclose naturally.
    if (this.sttSocket) {
        this.sttSocket.close();
        this.sttSocket = null;
    }
  }

  private async processFinalTranscript(transcript: string, context: string, history: any[]) {
    this.config.onBotThinking();
    const botResponseText = await this.callLlm(transcript, context, history);
    if (botResponseText) {
      // Bot text is surfaced via audio playback — onTranscriptionUpdate is for user turns only.
      await this.callTts(botResponseText);
    }
  }

  private async callLlm(transcript: string, context: string, history: any[]): Promise<string | null> {
    const model = this.genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const prompt = `
      ${context}
      Here is the conversation history. The user is "user" and you are "bot".
      ${history.map(h => `${h.speaker}: ${h.text}`).join('\n')}
      user: ${transcript}
      bot:
    `;
    try {
      const result = await model.generateContent(prompt);
      const response = result.response;
      return response.text();
    } catch (error) {
      console.error("Error calling LLM:", error);
      return "I'm sorry, an error occurred while I was thinking.";
    }
  }

  private async callTts(text: string) {
    const gradiumApiKey = import.meta.env.VITE_GRADIUM_API_KEY;
    if (!gradiumApiKey) {
      console.error("VITE_GRADIUM_API_KEY is not set — TTS skipped.");
      this.config.onBotFinishedSpeaking();
      return;
    }
    const ttsUrl = 'https://us.api.gradium.ai/api/speech/tts';
    try {
      // Gradium TTS HTTP POST requires a 'setup' object with voice_id and output_format.
      // Set VITE_GRADIUM_VOICE_ID in .env.local to match a voice from your Gradium dashboard.
      const voiceId = import.meta.env.VITE_GRADIUM_VOICE_ID ?? "default";
      const response = await fetch(ttsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': gradiumApiKey,
        },
        body: JSON.stringify({
          setup: {
            voice_id: voiceId,
            output_format: "wav",
          },
          text,
        }),
      });
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`TTS API failed with status: ${response.status}. Body: ${errorBody}`);
      }
      
      const audioBlob = await response.blob();
      this.audioQueue.push(audioBlob);
      if (!this.isPlaying) this.playQueue();
    } catch (error) {
      console.error("Error calling TTS:", error);
    }
  }
  
  private playQueue = () => {
    if (this.audioQueue.length === 0) {
      this.isPlaying = false;
      this.config.onBotFinishedSpeaking();
      return;
    }
    this.isPlaying = true;
    const audioBlob = this.audioQueue.shift();
    if (audioBlob) this.config.onBotAudioResponse(audioBlob);
  }

  public disconnect = () => {
    this.cleanup();
  }
}
