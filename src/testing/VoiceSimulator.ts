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

import { GoogleGenAI } from '@google/genai';

/**
 * Configuration for the VoiceSimulator.
 */
export interface VoiceSimulatorConfig {
  /** 
   * The API key for the "Actor" Gemini instance. 
   * This should be a full GEMINI_API_KEY, not an ephemeral token.
   */
  apiKey: string;
  /**
   * The persona for the user being simulated.
   * e.g., "You are a 75-year-old grandmother named Martha."
   */
  persona: string;
  /**
   * The model to use for the Actor.
   */
  actorModel?: string;
  /**
   * Optional goals for the simulation to track.
   */
  goals?: string[];
  /**
   * Debug mode for verbose logging.
   */
  debug?: boolean;
}

/**
 * Result of a simulated conversation session.
 */
export interface SimulationResult {
  transcript: Array<{ role: 'user' | 'bot'; text: string }>;
  durationMs: number;
  avgLatencyMs: number;
  goalsMet: string[];
  interruptionCount: number;
}

/**
 * VoiceSimulator is intended to act as a headless participant in a Gemini
 * Live session, emulating a user by "listening" to bot audio and "speaking"
 * back using a second Gemini instance (the Actor) to generate responses.
 *
 * ⚠️ EXPERIMENTAL, UNIMPLEMENTED STUB. `simulate()` does NOT open a WebSocket
 * or talk to Gemini Live — it returns mock data (see the body). Only
 * `generateUserResponse()` performs a real Gemini call. Do not build tests
 * that rely on `simulate()` exercising a live session. See TESTING.md.
 */
export class VoiceSimulator {
  private config: VoiceSimulatorConfig;
  private actorAI: GoogleGenAI;
  
  constructor(config: VoiceSimulatorConfig) {
    this.config = {
      actorModel: 'gemini-3-flash-preview',
      ...config
    };
    this.actorAI = new GoogleGenAI({ apiKey: this.config.apiKey });
  }

  /**
   * Run a simulated session against a target Gemini Live WebSocket.
   *
   * ⚠️ STUB: no WebSocket connection is made. Returns mock data only.
   *
   * @param targetUrl The Gemini Live WebSocket URL to connect to.
   * @param targetToken The ephemeral token or API key for the target session.
   */
  public async simulate(targetUrl: string, targetToken: string): Promise<SimulationResult> {
    if (this.config.debug) {
      console.log(`[VoiceSimulator] Starting simulation for persona: "${this.config.persona}" (Target: ${targetUrl})`);
    }

    const startTime = Date.now();
    const transcript: Array<{ role: 'user' | 'bot'; text: string }> = [];
    
    // In a real implementation, we would use a WebSocket client here.
    // For now, we simulate the interface.
    if (targetToken === 'mock-token') {
       transcript.push({ role: 'bot', text: 'MOCK BOT RESPONSE' });
    }
    
    return {
      transcript,
      durationMs: Date.now() - startTime,
      avgLatencyMs: 0,
      goalsMet: [],
      interruptionCount: 0
    };
  }

  /**
   * Generates a user response based on the bot's current transcript.
   * In a full implementation, this would take bot audio as input.
   */
  public async generateUserResponse(botText: string): Promise<string> {
    const prompt = `
PERSONA: ${this.config.persona}
THE BOT JUST SAID: "${botText}"

RESPOND AS YOUR PERSONA. 
Keep it concise and conversational.
Do not include any metadata or explanations.
`;
    const result = await this.actorAI.models.generateContent({
      model: this.config.actorModel!,
      contents: prompt
    });
    return result.text || '';
  }
}
