
export interface Message {
  id: string;
  role: 'user' | 'bot';
  text: string;
  timestamp: Date;
}

export type QuestionStatus = 'Unasked' | 'InProgress' | 'Completed';

export interface InterviewQuestion {
  id: string;
  text: string;
  status: QuestionStatus;
  findings: string; // Summary of what has been learned so far
}

export interface FamilyMember {
  name: string;
  relation: string;
  notes?: string;
}

export type PersonalityMode = 'empathetic' | 'investigative' | 'casual';

export interface Dossier {
  familyTree: FamilyMember[];
  historicalContext: string;
  questions: InterviewQuestion[];
  selectedVoice: 'Kore' | 'Puck' | 'Charon' | 'Fenrir' | 'Zephyr';
  personality: PersonalityMode;
}

export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}

export interface SessionMetadata {
  id: string;
  startTime: Date;
  audioUrl?: string;
  transcriptId: string;
  storytellerName: string;
}
