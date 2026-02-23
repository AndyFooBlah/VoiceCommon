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

  console.log(`Proxy attempting to connect to: ${gradiumUrl}`);
  const gradiumWs = new WebSocket(gradiumUrl, { headers });

  gradiumWs.on('open', () => {
    console.log('Proxy connected to Gradium');
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
    try {
      const parsedMessage = JSON.parse(messageStr);
      if (parsedMessage.type === 'setup') {
        console.log('Forwarding SETUP message to Gradium:', JSON.stringify(parsedMessage));
      } else if (parsedMessage.type === 'audio') {
        console.log('Forwarding AUDIO message to Gradium (data omitted)');
      } else if (parsedMessage.type === 'end_of_stream') {
        console.log('Forwarding END_OF_STREAM message to Gradium');
      } else {
        console.log('Forwarding other message to Gradium:', messageStr.substring(0, 200) + (messageStr.length > 200 ? '...' : ''));
      }
    } catch (e) {
      console.log('Forwarding non-JSON message to Gradium:', messageStr.substring(0, 200) + (messageStr.length > 200 ? '...' : ''));
    }

    // Forward message from client to Gradium
    if (gradiumWs.readyState === WebSocket.OPEN) {
      gradiumWs.send(messageStr);
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