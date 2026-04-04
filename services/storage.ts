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
 * NOTE: These services are placeholders for Firebase/GCS integration.
 * They simulate the "Never Delete" archival requirement.
 */

export const archiveAudioToGCS = async (audioBlob: Blob, sessionId: string): Promise<string> => {
  console.log(`[GCS] Archiving raw audio for session ${sessionId}...`);
  // In production: upload to 'gs://legacy-bot-archives/audio/{sessionId}.webm'
  // return await getDownloadURL(storageRef);
  return `gs://archive/audio/${sessionId}.webm`;
};

export const syncTranscriptToFirestore = async (transcript: any, sessionId: string) => {
  console.log(`[Firestore] Syncing transcript updates for ${sessionId}...`);
  // In production: setDoc(doc(db, "transcripts", sessionId), { ... })
};

export const updateQuestionStateInFirestore = async (questions: any[], sessionId: string) => {
  console.log(`[Firestore] Updating question progress for session ${sessionId}...`);
};
