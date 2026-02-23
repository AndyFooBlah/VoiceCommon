import { GoogleGenerativeAI } from "@google/generative-ai";
import { convertFloat32ToInt16, Resampler, arrayBufferToBase64 } from "../utils/audioUtils";

interface HybridServiceConfig {
  onTranscriptionUpdate: (text: string, isFinal: boolean) => void;
  onBotAudioResponse: (audio: Blob) => void;
  onBotThinking: () => void;
  onBotFinishedSpeaking: () => void;
}

const TARGET_SAMPLE_RATE = 24000; // Gradium STT requires 24 kHz PCM
const AUDIO_BUFFER_SIZE = 4096;

export class HybridService {
  private config: HybridServiceConfig;
  private genAI: GoogleGenerativeAI;

  private sttSocket: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private audioProcessor: ScriptProcessorNode | null = null;

  private finalTranscript = '';

  constructor(config: HybridServiceConfig) {
    this.config = config;

    const geminiApiKey = import.meta.env.VITE_GEMINI_API_KEY;
    if (!geminiApiKey) throw new Error("VITE_GEMINI_API_KEY is not set.");
    this.genAI = new GoogleGenerativeAI(geminiApiKey);

    console.log("[Hybrid] Service initialized.");
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  public async start(): Promise<void> {
    this.finalTranscript = '';
    await this.connectToStt();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.processAudio();
    console.log("[Hybrid] Listening.");
  }

  public async stop(context: string, history: { speaker: string; text: string }[]): Promise<void> {
    // Step 1: Stop capturing audio so we stop sending to STT.
    this.stopAudioCapture();

    // Step 2: Signal end of utterance to Gradium.
    if (this.sttSocket?.readyState === WebSocket.OPEN) {
      this.sttSocket.send(JSON.stringify({ type: "end_of_stream" }));
      console.log("[Hybrid] Sent end_of_stream.");
    }

    // Step 3: Allow time for Gradium to flush any final transcript segments
    // before we close the socket. Without this wait the last few words may
    // be cut off.
    await new Promise(resolve => setTimeout(resolve, 400));

    // Step 4: Close the socket.
    if (this.sttSocket) {
      this.sttSocket.close();
      this.sttSocket = null;
    }

    // Step 5: Commit the accumulated transcript and process it.
    const transcriptToProcess = this.finalTranscript.trim();
    if (transcriptToProcess) {
      this.config.onTranscriptionUpdate(transcriptToProcess, true);
      await this.processFinalTranscript(transcriptToProcess, context, history);
    } else {
      console.warn("[Hybrid] No transcript captured — nothing to process.");
      this.config.onBotFinishedSpeaking();
    }
  }

  public disconnect(): void {
    this.stopAudioCapture();
    if (this.sttSocket) {
      this.sttSocket.close();
      this.sttSocket = null;
    }
  }

  // ---------------------------------------------------------------------------
  // STT
  // ---------------------------------------------------------------------------

  private connectToStt(): Promise<void> {
    // Connects to the local Node.js proxy (server.ts on port 3001).
    // The proxy holds the Gradium API key and relays to wss://us.api.gradium.ai/api/speech/asr.
    this.sttSocket = new WebSocket('ws://localhost:3001');

    return new Promise<void>((resolve, reject) => {
      this.sttSocket!.onopen = () => {
        console.log("[STT] Connected to proxy. Sending setup…");
        this.sttSocket!.send(JSON.stringify({
          type: "setup",
          model_name: "default",
          input_format: "pcm",
        }));
        // Resolve immediately — audio streaming can begin. Any Gradium
        // 'ready' acknowledgment is handled in onmessage below.
        resolve();
      };

      this.sttSocket!.onmessage = (event) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(event.data as string);
        } catch {
          console.warn("[STT] Non-JSON message:", event.data);
          return;
        }

        if (data.type === 'text') {
          // Gradium sends {type:'text', text, start_s, stop_s} — no is_final flag.
          // Accumulate segments and show as in-progress for the live display.
          this.finalTranscript += (data.text as string) + ' ';
          this.config.onTranscriptionUpdate(this.finalTranscript.trim(), false);
        } else if (data.type === 'ready') {
          console.log("[STT] Gradium ready:", data);
        } else if (data.type === 'error') {
          console.error("[STT] Gradium error:", data.message);
        } else {
          console.log("[STT] Unhandled message:", data.type, data);
        }
      };

      this.sttSocket!.onclose = (event) => {
        console.log("[STT] Socket closed.", event.code, event.reason || '');
      };

      this.sttSocket!.onerror = (error) => {
        console.error("[STT] Socket error:", error);
        reject(new Error("STT WebSocket error — is the proxy server running? (npm run start-server)"));
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Audio capture
  // ---------------------------------------------------------------------------

  private processAudio(): void {
    if (!this.stream) return;

    this.audioContext = new window.AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.audioProcessor = this.audioContext.createScriptProcessor(AUDIO_BUFFER_SIZE, 1, 1);

    // ScriptProcessorNode must be connected to the destination graph to fire
    // onaudioprocess, but we don't want to hear the microphone — use a silent
    // gain node to keep the graph alive without playing audio back.
    const silentGain = this.audioContext.createGain();
    silentGain.gain.value = 0;

    const resampler = new Resampler(this.audioContext.sampleRate, TARGET_SAMPLE_RATE);

    this.audioProcessor.onaudioprocess = (event: AudioProcessingEvent) => {
      const inputData = event.inputBuffer.getChannelData(0);
      const resampledData = resampler.resample(inputData);
      const pcmData = convertFloat32ToInt16(resampledData);

      if (this.sttSocket?.readyState === WebSocket.OPEN) {
        // Gradium STT expects JSON-wrapped base64 PCM, not raw binary.
        const base64Audio = arrayBufferToBase64(pcmData.buffer);
        this.sttSocket.send(JSON.stringify({ type: "audio", audio: base64Audio }));
      }
    };

    source.connect(this.audioProcessor);
    this.audioProcessor.connect(silentGain);
    silentGain.connect(this.audioContext.destination);
  }

  private stopAudioCapture(): void {
    if (this.audioProcessor) {
      this.audioProcessor.disconnect();
      this.audioProcessor = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
  }

  // ---------------------------------------------------------------------------
  // LLM + TTS
  // ---------------------------------------------------------------------------

  private async processFinalTranscript(
    transcript: string,
    context: string,
    history: { speaker: string; text: string }[],
  ): Promise<void> {
    this.config.onBotThinking();
    const botText = await this.callLlm(transcript, context, history);
    if (botText) {
      await this.callTts(botText);
    } else {
      this.config.onBotFinishedSpeaking();
    }
  }

  private async callLlm(
    transcript: string,
    context: string,
    history: { speaker: string; text: string }[],
  ): Promise<string | null> {
    const model = this.genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `
${context}

Here is the conversation history so far (user = Eleanor, bot = you):
${history.map(h => `${h.speaker}: ${h.text}`).join('\n')}
user: ${transcript}
bot:`;

    try {
      console.log("[LLM] Calling Gemini 2.5 Flash…");
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      console.log("[LLM] Response:", text.slice(0, 80) + (text.length > 80 ? '…' : ''));
      return text;
    } catch (error) {
      console.error("[LLM] Error:", error);
      return "I'm sorry, I encountered an error while thinking.";
    }
  }

  private async callTts(text: string): Promise<void> {
    const gradiumApiKey = import.meta.env.VITE_GRADIUM_API_KEY;
    if (!gradiumApiKey) {
      console.error("[TTS] VITE_GRADIUM_API_KEY not set — skipping TTS.");
      this.config.onBotFinishedSpeaking();
      return;
    }

    // VITE_GRADIUM_VOICE_ID must be set to a voice ID from your Gradium account.
    // List available voices: GET https://us.api.gradium.ai/api/voices (x-api-key header)
    const voiceId = import.meta.env.VITE_GRADIUM_VOICE_ID ?? "default";

    try {
      console.log("[TTS] Requesting audio for", text.length, "chars…");
      const response = await fetch('https://us.api.gradium.ai/api/speech/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': gradiumApiKey,
        },
        body: JSON.stringify({
          setup: { voice_id: voiceId, output_format: "wav" },
          text,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`TTS HTTP ${response.status}: ${body}`);
      }

      const audioBlob = await response.blob();
      console.log("[TTS] Audio received:", audioBlob.size, "bytes.");
      // Hand the blob to App.tsx. The app plays it and calls setStatus('idle')
      // in audio.onended — no further signal needed from the service.
      this.config.onBotAudioResponse(audioBlob);
    } catch (error) {
      console.error("[TTS] Error:", error);
      this.config.onBotFinishedSpeaking();
    }
  }
}
