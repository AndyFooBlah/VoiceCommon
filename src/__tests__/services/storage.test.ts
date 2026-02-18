/**
 * Tests for the storage service (Firestore + GCS operations).
 *
 * All Firebase calls are mocked — these tests verify that the correct
 * Firestore paths, document shapes, and Storage paths are used.
 *
 * References: design.md §5.3 (Priority 1) | src/services/storage.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mockFirestore, mockStorage } from '../../__mocks__/firebase';
import {
  createSession,
  finalizeSession,
  archiveAudioToGCS,
  syncTranscriptToFirestore,
  updateQuestionStateInFirestore,
} from '../../services/storage';

beforeEach(() => {
  // Reset all mocks between tests
  Object.values(mockFirestore).forEach((fn) => {
    if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
  });
  Object.values(mockStorage).forEach((fn) => {
    if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
  });
});

describe('createSession', () => {
  it('creates a session document and returns the ID', async () => {
    mockFirestore.addDoc.mockResolvedValueOnce({ id: 'session-123' });

    const id = await createSession('uid-1', 'dossier-1');

    expect(id).toBe('session-123');
    expect(mockFirestore.addDoc).toHaveBeenCalledTimes(1);
  });

  it('creates the session with status=active and no endTime', async () => {
    mockFirestore.addDoc.mockResolvedValueOnce({ id: 'session-123' });

    await createSession('uid-1', 'dossier-1');

    const sessionData = mockFirestore.addDoc.mock.calls[0][1];
    expect(sessionData.status).toBe('active');
    expect(sessionData.endTime).toBeNull();
    expect(sessionData.audioUrl).toBe('');
    expect(sessionData.durationSeconds).toBe(0);
  });

  it('sets a startTime timestamp', async () => {
    mockFirestore.addDoc.mockResolvedValueOnce({ id: 'session-123' });

    await createSession('uid-1', 'dossier-1');

    const sessionData = mockFirestore.addDoc.mock.calls[0][1];
    expect(sessionData.startTime).toBeDefined();
  });
});

describe('finalizeSession', () => {
  it('updates the session with completed status', async () => {
    await finalizeSession('uid-1', 'dossier-1', 'session-1', 'completed', 3600);

    expect(mockFirestore.updateDoc).toHaveBeenCalledTimes(1);
    const updateData = mockFirestore.updateDoc.mock.calls[0][1];
    expect(updateData.status).toBe('completed');
    expect(updateData.durationSeconds).toBe(3600);
    expect(updateData.endTime).toBeDefined();
  });

  it('updates the session with interrupted status', async () => {
    await finalizeSession('uid-1', 'dossier-1', 'session-1', 'interrupted', 120);

    const updateData = mockFirestore.updateDoc.mock.calls[0][1];
    expect(updateData.status).toBe('interrupted');
  });

  it('includes audioUrl when provided', async () => {
    await finalizeSession('uid-1', 'dossier-1', 'session-1', 'completed', 3600, 'https://audio.url');

    const updateData = mockFirestore.updateDoc.mock.calls[0][1];
    expect(updateData.audioUrl).toBe('https://audio.url');
  });

  it('omits audioUrl when not provided', async () => {
    await finalizeSession('uid-1', 'dossier-1', 'session-1', 'completed', 3600);

    const updateData = mockFirestore.updateDoc.mock.calls[0][1];
    expect(updateData).not.toHaveProperty('audioUrl');
  });
});

describe('archiveAudioToGCS', () => {
  it('uploads a blob and returns the download URL', async () => {
    mockStorage.getDownloadURL.mockResolvedValueOnce('https://storage.example.com/audio.webm');
    const blob = new Blob(['audio-data'], { type: 'audio/webm' });

    const url = await archiveAudioToGCS(blob, 'uid-1', 'dossier-1', 'session-1');

    expect(url).toBe('https://storage.example.com/audio.webm');
    expect(mockStorage.uploadBytes).toHaveBeenCalledTimes(1);
  });

  it('uses the correct GCS path convention: {uid}/{dossierId}/{sessionId}.webm', async () => {
    const blob = new Blob(['audio-data']);

    await archiveAudioToGCS(blob, 'uid-1', 'dossier-1', 'session-1');

    expect(mockStorage.ref).toHaveBeenCalledWith(
      expect.anything(),
      'uid-1/dossier-1/session-1.webm',
    );
  });

  it('sets the correct content type on upload', async () => {
    const blob = new Blob(['audio-data']);

    await archiveAudioToGCS(blob, 'uid-1', 'dossier-1', 'session-1');

    const uploadOptions = mockStorage.uploadBytes.mock.calls[0][2];
    expect(uploadOptions.contentType).toBe('audio/webm;codecs=opus');
  });
});

describe('syncTranscriptToFirestore', () => {
  it('writes transcript entries to the correct path', async () => {
    const entries = [
      { role: 'bot' as const, text: 'Hello!', timestamp: mockFirestore.Timestamp.now() },
      { role: 'user' as const, text: 'Hi there.', timestamp: mockFirestore.Timestamp.now() },
    ] as any;

    await syncTranscriptToFirestore('uid-1', 'dossier-1', 'session-1', entries);

    expect(mockFirestore.setDoc).toHaveBeenCalledTimes(1);
    const writtenData = mockFirestore.setDoc.mock.calls[0][1];
    expect(writtenData.entries).toHaveLength(2);
    expect(writtenData.entries[0].role).toBe('bot');
    expect(writtenData.entries[1].role).toBe('user');
  });

  it('overwrites previous entries (merge: false)', async () => {
    const entries = [{ role: 'bot' as const, text: 'Hello!', timestamp: mockFirestore.Timestamp.now() }] as any;

    await syncTranscriptToFirestore('uid-1', 'dossier-1', 'session-1', entries);

    const mergeOption = mockFirestore.setDoc.mock.calls[0][2];
    expect(mergeOption).toEqual({ merge: false });
  });
});

describe('updateQuestionStateInFirestore', () => {
  it('updates the question document with status and findings', async () => {
    await updateQuestionStateInFirestore('uid-1', 'dossier-1', 'q1', 'InProgress', 'User mentioned a farm.');

    expect(mockFirestore.updateDoc).toHaveBeenCalledTimes(1);
    const updateData = mockFirestore.updateDoc.mock.calls[0][1];
    expect(updateData.status).toBe('InProgress');
    expect(updateData.findings).toBe('User mentioned a farm.');
    expect(updateData.updatedAt).toBeDefined();
  });
});
