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
