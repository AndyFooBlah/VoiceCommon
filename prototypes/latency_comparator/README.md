# Conversational AI Latency Comparator

This prototype is a web application designed to compare the real-world performance of two different architectures for building a conversational AI. It provides a hands-on way to measure and feel the difference in latency and response quality between an integrated, all-in-one service and a hybrid, multi-component service.

Tracked by GitHub Issue: [#67](https://github.com/AndyFooBlah/LegacyBot/issues/67)

## Architectures

The prototype allows you to switch between two distinct architectures:

1.  **Integrated (e.g., Gemini Live):** A single service that handles Speech-to-Text (STT), Large Language Model (LLM) processing, and Text-to-Speech (TTS) in one package. This architecture is simpler to implement but may have higher latency due to its "black box" nature.

2.  **Hybrid (e.g., Gradium + Gemini):** A combination of specialized, best-in-class services.
    *   **STT:** A dedicated real-time transcription service (e.g., Gradium).
    *   **LLM:** A powerful text-based language model (e.g., Gemini API).
    *   **TTS:** A dedicated real-time speech synthesis service (e.g., Gradium).
    This architecture is more complex to orchestrate but offers greater control and potentially lower latency.

## Key Performance Metrics

The application measures and displays two key metrics:

*   **Primary Latency (Bot Response):** The time from when the user stops speaking until the first audio chunk of the bot's response is played. This measures the perceived "thinking time."
*   **Secondary Latency (Transcription):** The time from when a speaker finishes talking until their speech is fully transcribed on the screen.

## Getting Started

### 1. Installation

Navigate to the prototype directory and install the dependencies:

```bash
cd legacybot/prototypes/latency_comparator
npm install
```

### 2. Environment Variables

This prototype requires API keys for the services it uses. Create a `.env.local` file in the `legacybot/prototypes/latency_comparator` directory and add your keys:

```
# Example .env.local

# For the Hybrid Architecture
VITE_GRADIUM_API_KEY="your_gradium_api_key_here"

# For the LLM call in the Hybrid architecture and the Integrated architecture
VITE_GEMINI_API_KEY="your_google_ai_gemini_api_key_here"
```

**Note:** The current implementation uses placeholder services and does not actually make API calls. To build out the full prototype, you will need to replace the placeholder logic in `src/services/` with actual SDK integrations for these services.

### 3. Running the Prototype

This prototype now has a two-part startup process: a backend proxy server and the frontend client. You will need two terminals open.

**Terminal 1: Start the Proxy Server**

The proxy server is required to securely handle the Gradium API key.

```bash
# In legacybot/prototypes/latency_comparator
npm run start-server
```
You should see a message indicating the proxy server has started on port 3001.

**Terminal 2: Start the Frontend Client**

Once the proxy is running, start the Vite development server for the UI.

```bash
# In legacybot/prototypes/latency_comparator
npm run dev
```

Open your browser to the local address provided (usually `http://localhost:5173`).

### 4. How to Test

1.  Open the application in your browser. The app will request microphone permission. Please grant it.
2.  Select the architecture you want to test from the dropdown menu ("Hybrid" or "Integrated").
3.  Click the "Start Interview" button. The status will change to "listening...".
4.  Speak into your microphone as if you are the user, Dr. Eleanor Vance.
5.  When you are finished speaking, click the button again (which now says "Status: listening... (Click to Stop)").
6.  The application status will change to "thinking..." and then "speaking...".
7.  Observe the latency metrics displayed on the screen. The console will also log the flow of data through the placeholder services.
8.  To test again, wait for the bot to finish speaking and click the button to stop. Then you can start again.

