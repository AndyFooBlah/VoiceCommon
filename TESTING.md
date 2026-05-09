# Voice Testing and Simulation in VoiceCommon

VoiceCommon provides a `VoiceSimulator` utility to enable automated, end-to-end testing of Gemini Live voice applications. This tool emulates a real user by "listening" to the bot's audio, deciding what to say using a persona-driven LLM "Actor," and "speaking" back via TTS.

## Architecture

The `VoiceSimulator` operates as a headless WebSocket client that connects to the same Gemini Live endpoint as your application.

1.  **The Actor (LLM):** A dedicated Gemini 1.5 Flash instance configured with a specific persona (e.g., "Ralph, a retired sailor").
2.  **The Ear (STT):** Transcribes bot audio chunks back into text so the Actor can "understand" the conversation.
3.  **The Voice (TTS):** Converts Actor text responses into 16kHz PCM audio chunks to stream back to the bot.

## Setup

### 1. Requirements
- A valid `GEMINI_API_KEY` for the Actor LLM.
- A Google Cloud project with the **Text-to-Speech API** enabled (optional, for realistic audio simulation).

### 2. Configuration
The simulator requires a configuration object:

```ts
import { VoiceSimulator } from '@andyfooblah/voice-common/testing';

const sim = new VoiceSimulator({
  apiKey: process.env.GEMINI_API_KEY,
  persona: "You are a 75-year-old grandmother who loves gardening.",
  debug: true
});
```

## Running a Simulation

You can run a simulation in your integration tests (e.g., using `vitest`).

```ts
import { describe, it, expect } from 'vitest';
import { VoiceSimulator } from '@andyfooblah/voice-common/testing';

describe('End-to-End Voice Simulation', () => {
  it('should complete a 3-turn interview about gardening', async () => {
    const sim = new VoiceSimulator({
      apiKey: process.env.GEMINI_API_KEY,
      persona: "Martha, a gardener from Vermont."
    });

    // Obtain an ephemeral token from your app's broker
    const token = await myApp.mintToken();
    
    // Run the simulation
    const result = await sim.simulate("wss://...", token);

    // Assertions
    expect(result.transcript.length).toBeGreaterThan(4);
    expect(result.avgLatencyMs).toBeLessThan(2000);
    expect(result.transcript.some(m => m.text.includes("tomatoes"))).toBe(true);
  });
});
```

## Security Considerations

- **API Keys:** Never commit your `GEMINI_API_KEY` to source control. Always load it from environment variables (e.g., `process.env.GEMINI_API_KEY`).
- **Headless Access:** Ensure your Firestore security rules and App Check configuration allow connections from your CI/testing environment.
- **Quota Management:** Each simulation uses Gemini API quota for both the bot and the Actor. Use a dedicated test project/key to avoid impacting production quotas.
