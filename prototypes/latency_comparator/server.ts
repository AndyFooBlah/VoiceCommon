// Need to load .env variables FIRST
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';

const PORT = 3001;
const app = express();
const server = http.createServer(app);

const wss = new WebSocketServer({ server });

wss.on('connection', (clientWs) => {
  console.log('Client connected to proxy');

  const gradiumApiKey = process.env.VITE_GRADIUM_API_KEY;
  if (!gradiumApiKey) {
    console.error("VITE_GRADIUM_API_KEY not found in environment variables.");
    clientWs.close(1011, "Server configuration error: API key not found.");
    return;
  }

  const gradiumUrl = 'wss://us.api.gradium.ai/api/speech/asr';
  const headers = { 'x-api-key': gradiumApiKey };

  // Messages that arrive from the client before Gradium's WebSocket is open
  // are queued here and flushed in order once the connection is established.
  // Without this, the setup message is silently dropped (it arrives while
  // Gradium is still connecting) and Gradium later rejects audio with
  // "Session not found. Send setup first."
  const pendingMessages: string[] = [];

  console.log(`Proxy connecting to: ${gradiumUrl}`);
  const gradiumWs = new WebSocket(gradiumUrl, { headers });

  gradiumWs.on('open', () => {
    console.log('Proxy connected to Gradium. Flushing', pendingMessages.length, 'queued message(s).');
    for (const msg of pendingMessages) {
      gradiumWs.send(msg);
    }
    pendingMessages.length = 0;
  });

  gradiumWs.on('message', (message) => {
    // Log all messages received from Gradium
    console.log('Received from Gradium:', message.toString().substring(0, 200) + (message.toString().length > 200 ? '...' : ''));
    // Forward message from Gradium to the client
    clientWs.send(message.toString());
  });

  gradiumWs.on('close', (code, reason) => {
    console.log('Gradium connection closed:', code, reason.toString());
    clientWs.close(code, "Upstream connection closed");
  });

  gradiumWs.on('error', (error) => {
    console.error('Gradium connection error:', error);
    clientWs.close(1011, 'Proxy connection error.');
  });

  clientWs.on('message', (message) => {
    const messageStr = message.toString();
    // Log specific messages being sent to Gradium
    const action = gradiumWs.readyState === WebSocket.OPEN ? 'Sending' : 'Queuing';
    try {
      const parsedMessage = JSON.parse(messageStr);
      if (parsedMessage.type === 'setup') {
        console.log(`${action} SETUP to Gradium:`, JSON.stringify(parsedMessage));
      } else if (parsedMessage.type === 'audio') {
        console.log(`${action} AUDIO to Gradium (data omitted)`);
      } else if (parsedMessage.type === 'end_of_stream') {
        console.log(`${action} END_OF_STREAM to Gradium`);
      } else {
        console.log(`${action} message to Gradium:`, messageStr.substring(0, 200));
      }
    } catch (e) {
      console.log(`${action} non-JSON to Gradium:`, messageStr.substring(0, 200));
    }

    // Forward to Gradium, or queue if the upstream connection isn't open yet.
    if (gradiumWs.readyState === WebSocket.OPEN) {
      gradiumWs.send(messageStr);
    } else {
      pendingMessages.push(messageStr);
    }
  });

  clientWs.on('close', (code, reason) => {
    console.log('Client connection closed:', code, reason.toString());
    if (gradiumWs.readyState === WebSocket.OPEN || gradiumWs.readyState === WebSocket.CONNECTING) {
      gradiumWs.close();
    }
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket proxy server started on port ${PORT}`);
});