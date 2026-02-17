/**
 * Core type definitions for LegacyBot.
 *
 * These interfaces mirror the Firestore data model defined in design.md §2.1.
 * Each top-level interface corresponds to a Firestore document/subcollection:
 *
 *   users/{uid}                                          → UserProfile
 *   users/{uid}/dossiers/{dossierId}                     → Dossier
 *   users/{uid}/dossiers/{dossierId}/questions/{qId}     → InterviewQuestion
 *   users/{uid}/dossiers/{dossierId}/sessions/{sId}      → SessionMetadata
 *   .../sessions/{sId}/transcript (single doc)           → TranscriptEntry[]
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
}

// ---------------------------------------------------------------------------
// Dossier & Storyteller
// ---------------------------------------------------------------------------

/** A single relative in the Storyteller's family tree. */
export interface FamilyMember {
  name: string;
  relation: string;
  notes?: string;
}

/** The three interviewer personality modes the Archivist can choose from. */
export type PersonalityMode = 'empathetic' | 'investigative' | 'casual';

/** Available Gemini voice presets. */
export type VoicePreset = 'Kore' | 'Puck' | 'Charon' | 'Fenrir' | 'Zephyr';

/**
 * Firestore document at users/{uid}/dossiers/{dossierId}.
 * Represents the complete context for interviewing one Storyteller.
 */
export interface Dossier {
  id?: string; // Firestore document ID (set on read, not stored in doc)
  storytellerName: string; // Required — the bot greets them by name
  storytellerContext: string; // Free-text bio, background, etc.
  historicalContext: string;
  familyTree: FamilyMember[];
  selectedVoice: VoicePreset;
  personality: PersonalityMode;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Story Queue (Questions)
// ---------------------------------------------------------------------------

/** Tracks whether a question has been asked, is being explored, or is done. */
export type QuestionStatus = 'Unasked' | 'InProgress' | 'Completed';

/**
 * Firestore document at users/{uid}/dossiers/{dossierId}/questions/{questionId}.
 * Each question represents a topic in the Archivist's "Story Queue."
 */
export interface InterviewQuestion {
  id?: string; // Firestore document ID
  text: string;
  status: QuestionStatus;
  findings: string; // AI-generated summary of what has been learned
  order: number; // Controls display order in the queue
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Sessions & Transcripts
// ---------------------------------------------------------------------------

/** The lifecycle status of a recording session. */
export type SessionStatus = 'active' | 'completed' | 'interrupted';

/**
 * Firestore document at users/{uid}/dossiers/{dossierId}/sessions/{sessionId}.
 * Tracks metadata for a single recording session.
 */
export interface SessionMetadata {
  id?: string; // Firestore document ID
  startTime: Timestamp;
  endTime: Timestamp | null;
  audioUrl: string; // GCS download URL, set after upload
  status: SessionStatus;
  durationSeconds: number;
}

/** A single turn in the conversation transcript. */
export interface TranscriptEntry {
  role: 'user' | 'bot';
  text: string;
  timestamp: Timestamp;
}

// ---------------------------------------------------------------------------
// Message (used by the live UI — not directly persisted as-is)
// ---------------------------------------------------------------------------

/** In-memory message for the live transcript feed during a session. */
export interface Message {
  id: string;
  role: 'user' | 'bot';
  text: string;
  timestamp: Date;
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
