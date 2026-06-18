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
 * Core type definitions for VoiceCommon.
 *
 * Firestore data model:
 *   users/{uid}                                     → UserProfile
 *   sessions/{sessionId}                            → SessionMetadata
 *   sessions/{sessionId}/transcript/entries         → { entries: TranscriptEntry[] }
 */

import { Timestamp } from 'firebase/firestore';

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

/** Firestore document at users/{uid}. Created on first login. */
export interface UserProfile {
  email: string;
  displayName: string;
  createdAt: Timestamp;
  timezone?: string;
}

// ---------------------------------------------------------------------------
// Sessions & Transcripts
// ---------------------------------------------------------------------------

/** The lifecycle status of a recording session. */
export type SessionStatus = 'active' | 'completed' | 'interrupted';

/**
 * Firestore document at sessions/{sessionId}.
 * Tracks metadata for a single voice session.
 */
export interface SessionMetadata {
  id?: string;
  userId: string;
  title?: string;            // Optional user-provided or auto-generated title
  startTime: Timestamp;
  endTime: Timestamp | null;
  audioUrl: string;          // GCS download URL, set after upload
  status: SessionStatus;
  durationSeconds: number;
}

/** A single turn in the conversation transcript. */
export interface TranscriptEntry {
  role: 'user' | 'bot' | 'tool';
  text: string;
  timestamp: Timestamp;
  messageIndex?: number;     // 0-based position in the session transcript
  /** Tool call metadata — present when role === 'tool'. */
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;       // truncated result for audit purposes
}

// ---------------------------------------------------------------------------
// In-memory message (live session UI)
// ---------------------------------------------------------------------------

/** In-memory message for the live transcript feed during a session. */
export interface Message {
  id: string;
  role: 'user' | 'bot' | 'tool';
  text: string;
  timestamp: Date;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
}

// ---------------------------------------------------------------------------
// Connection State
// ---------------------------------------------------------------------------

/** Tracks the Gemini Live API connection lifecycle. */
export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR',
}
