/**
 * Core type definitions for LegacyBot.
 *
 * These interfaces mirror the Firestore data model:
 *
 *   families/{familyId}                                        → Family
 *   families/{familyId}/members/{uid}                          → FamilyMemberRecord
 *   families/{familyId}/dossiers/{dossierId}                   → Dossier
 *   families/{familyId}/dossiers/{dossierId}/questions/{qId}   → InterviewQuestion
 *   families/{familyId}/dossiers/{dossierId}/sessions/{sId}    → SessionMetadata
 *   .../sessions/{sId}/transcript (single doc)                 → TranscriptEntry[]
 *   users/{uid}                                                → UserProfile
 *   invitations/{inviteId}                                     → Invitation
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
  familyIds: string[];
}

// ---------------------------------------------------------------------------
// Family & Roles
// ---------------------------------------------------------------------------

/** Valid roles within a family. A member can have both roles. */
export type UserRole = 'admin' | 'storyteller';

/** Firestore document at families/{familyId}. */
export interface Family {
  id?: string;
  name: string;
  createdAt: Timestamp;
  createdBy: string; // uid of the creator
}

/**
 * Firestore document at families/{familyId}/members/{uid}.
 * Named FamilyMemberRecord to avoid clash with the FamilyMember type (family tree).
 */
export interface FamilyMemberRecord {
  roles: UserRole[];
  email: string;
  displayName: string;
  joinedAt: Timestamp;
  invitedBy: string; // uid of who invited them
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export type InvitationStatus = 'pending' | 'accepted';

/** Firestore document at invitations/{inviteId}. */
export interface Invitation {
  id?: string;
  familyId: string;
  email: string; // lowercased
  roles: UserRole[];
  dossierIds: string[]; // dossiers to link if storyteller
  invitedBy: string; // uid
  status: InvitationStatus;
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
 * Firestore document at families/{familyId}/dossiers/{dossierId}.
 * Represents the complete context for interviewing one Storyteller.
 */
export interface Dossier {
  id?: string; // Firestore document ID (set on read, not stored in doc)
  storytellerUid: string | null; // linked family member uid, or null if unlinked
  storytellerName: string; // Required — the bot greets them by name
  storytellerContext: string; // Free-text bio, background, etc.
  historicalContext: string;
  familyTree: FamilyMember[];
  selectedVoice: VoicePreset;
  personality: PersonalityMode;
  interviewerNotes: string; // admin instructions for the AI interviewer
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
 * Firestore document at families/{familyId}/dossiers/{dossierId}/sessions/{sessionId}.
 * Tracks metadata for a single recording session.
 */
export interface SessionMetadata {
  id?: string; // Firestore document ID
  storytellerUid: string; // who conducted the session
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
