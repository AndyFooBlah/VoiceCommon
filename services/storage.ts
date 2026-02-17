
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
