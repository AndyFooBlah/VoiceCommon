/**
 * Tests for the useDossierList and useDossier hooks.
 *
 * Verifies Firestore CRUD, debounce behavior, cleanup on unmount,
 * question management, and reordering.
 *
 * References: design.md §5.3 (Priority 1) | src/hooks/useDossier.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { mockFirestore } from '../../__mocks__/firebase';
import { useDossierList, useDossier } from '../../hooks/useDossier';

beforeEach(() => {
  Object.values(mockFirestore).forEach((fn) => {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as any).mockClear();
  });

  // Default onSnapshot: empty collection
  mockFirestore.onSnapshot.mockImplementation((_query: any, cb: any) => {
    cb({ docs: [] });
    return vi.fn();
  });

  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// -------------------------------------------------------------------------
// useDossierList
// -------------------------------------------------------------------------

describe('useDossierList', () => {
  it('starts in loading state', () => {
    // Never call the snapshot callback
    mockFirestore.onSnapshot.mockImplementation(() => vi.fn());

    const { result } = renderHook(() => useDossierList('uid-1'));
    expect(result.current.loading).toBe(true);
    expect(result.current.dossiers).toEqual([]);
  });

  it('returns dossiers from Firestore snapshot', () => {
    mockFirestore.onSnapshot.mockImplementation((_q: any, cb: any) => {
      cb({
        docs: [
          { id: 'd1', data: () => ({ storytellerName: 'Margaret' }) },
          { id: 'd2', data: () => ({ storytellerName: 'Arthur' }) },
        ],
      });
      return vi.fn();
    });

    const { result } = renderHook(() => useDossierList('uid-1'));

    // onSnapshot fires synchronously in our mock, so state is updated immediately
    expect(result.current.loading).toBe(false);
    expect(result.current.dossiers).toHaveLength(2);
    expect(result.current.dossiers[0].storytellerName).toBe('Margaret');
    expect(result.current.dossiers[0].id).toBe('d1');
  });

  it('does not subscribe when uid is undefined', () => {
    renderHook(() => useDossierList(undefined));
    expect(mockFirestore.onSnapshot).not.toHaveBeenCalled();
  });

  it('unsubscribes on unmount', () => {
    const unsub = vi.fn();
    mockFirestore.onSnapshot.mockImplementation((_q: any, cb: any) => {
      cb({ docs: [] });
      return unsub;
    });

    const { unmount } = renderHook(() => useDossierList('uid-1'));
    unmount();

    expect(unsub).toHaveBeenCalled();
  });

  it('createDossier adds a document and returns the ID', async () => {
    mockFirestore.addDoc.mockResolvedValueOnce({ id: 'new-dossier-id' });

    const { result } = renderHook(() => useDossierList('uid-1'));

    let id: string = '';
    await act(async () => {
      id = await result.current.createDossier('Eleanor');
    });

    expect(id).toBe('new-dossier-id');
    expect(mockFirestore.addDoc).toHaveBeenCalledTimes(1);
    const docData = mockFirestore.addDoc.mock.calls[0][1];
    expect(docData.storytellerName).toBe('Eleanor');
    expect(docData.personality).toBe('empathetic');
    expect(docData.selectedVoice).toBe('Zephyr');
  });

  it('createDossier throws when not authenticated', async () => {
    const { result } = renderHook(() => useDossierList(undefined));

    await expect(
      act(async () => {
        await result.current.createDossier('Test');
      }),
    ).rejects.toThrow('Not authenticated');
  });

  it('deleteDossier calls deleteDoc', async () => {
    const { result } = renderHook(() => useDossierList('uid-1'));

    await act(async () => {
      await result.current.deleteDossier('d1');
    });

    expect(mockFirestore.deleteDoc).toHaveBeenCalledTimes(1);
  });
});

// -------------------------------------------------------------------------
// useDossier (single dossier + questions)
// -------------------------------------------------------------------------

describe('useDossier', () => {
  let snapshotCallbacks: any[];

  beforeEach(() => {
    snapshotCallbacks = [];
    // Capture snapshot callbacks so we can invoke them manually
    mockFirestore.onSnapshot.mockImplementation((_q: any, cb: any) => {
      snapshotCallbacks.push(cb);
      return vi.fn();
    });
  });

  it('subscribes to both dossier doc and questions collection', () => {
    renderHook(() => useDossier('uid-1', 'dossier-1'));

    // Two onSnapshot subscriptions: one for dossier doc, one for questions
    expect(mockFirestore.onSnapshot).toHaveBeenCalledTimes(2);
  });

  it('does not subscribe when uid or dossierId is undefined', () => {
    renderHook(() => useDossier(undefined, 'dossier-1'));
    expect(mockFirestore.onSnapshot).not.toHaveBeenCalled();

    mockFirestore.onSnapshot.mockClear();
    renderHook(() => useDossier('uid-1', undefined));
    expect(mockFirestore.onSnapshot).not.toHaveBeenCalled();
  });

  it('sets dossier data from snapshot', async () => {
    const { result } = renderHook(() => useDossier('uid-1', 'dossier-1'));

    // Invoke the dossier doc snapshot (first subscription)
    act(() => {
      snapshotCallbacks[0]({
        exists: () => true,
        id: 'dossier-1',
        data: () => ({ storytellerName: 'Margaret', personality: 'empathetic' }),
      });
    });

    expect(result.current.dossier).not.toBeNull();
    expect(result.current.dossier?.storytellerName).toBe('Margaret');
    expect(result.current.loading).toBe(false);
  });

  it('sets dossier to null when document does not exist', async () => {
    const { result } = renderHook(() => useDossier('uid-1', 'dossier-1'));

    act(() => {
      snapshotCallbacks[0]({ exists: () => false, id: 'dossier-1', data: () => null });
    });

    expect(result.current.dossier).toBeNull();
  });

  it('sets questions from snapshot', () => {
    const { result } = renderHook(() => useDossier('uid-1', 'dossier-1'));

    act(() => {
      snapshotCallbacks[1]({
        docs: [
          { id: 'q1', data: () => ({ text: 'Childhood?', status: 'Unasked', order: 0 }) },
          { id: 'q2', data: () => ({ text: 'First job?', status: 'InProgress', order: 1 }) },
        ],
      });
    });

    expect(result.current.questions).toHaveLength(2);
    expect(result.current.questions[0].text).toBe('Childhood?');
    expect(result.current.questions[1].id).toBe('q2');
  });
});

describe('useDossier — updateDossier debounce', () => {
  beforeEach(() => {
    // Fire snapshot callbacks immediately so the hook is ready
    mockFirestore.onSnapshot.mockImplementation((_q: any, cb: any) => {
      // Simulate an existing dossier for the first sub, empty questions for the second
      if (!mockFirestore.onSnapshot.mock.calls.length || mockFirestore.onSnapshot.mock.calls.length % 2 !== 0) {
        cb({ exists: () => true, id: 'dossier-1', data: () => ({ storytellerName: 'Margaret' }) });
      } else {
        cb({ docs: [] });
      }
      return vi.fn();
    });
  });

  it('debounces Firestore writes by 500ms', () => {
    const { result } = renderHook(() => useDossier('uid-1', 'dossier-1'));

    act(() => {
      result.current.updateDossier({ storytellerContext: 'Draft 1' });
    });

    // No Firestore write yet
    expect(mockFirestore.updateDoc).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(mockFirestore.updateDoc).toHaveBeenCalledTimes(1);
  });

  it('resets debounce timer on rapid updates', () => {
    const { result } = renderHook(() => useDossier('uid-1', 'dossier-1'));

    act(() => {
      result.current.updateDossier({ storytellerContext: 'Draft 1' });
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    act(() => {
      result.current.updateDossier({ storytellerContext: 'Draft 2' });
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    // Still no write — timer was reset
    expect(mockFirestore.updateDoc).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(200);
    });

    // Now it fires (500ms after the second update)
    expect(mockFirestore.updateDoc).toHaveBeenCalledTimes(1);
  });

  it('updates local state immediately', () => {
    const { result } = renderHook(() => useDossier('uid-1', 'dossier-1'));

    act(() => {
      result.current.updateDossier({ storytellerContext: 'Immediate update' });
    });

    // Local state is updated immediately, even though Firestore write is debounced
    expect(result.current.dossier?.storytellerContext).toBe('Immediate update');
  });

  it('cleans up debounce timer on unmount', () => {
    const { result, unmount } = renderHook(() => useDossier('uid-1', 'dossier-1'));

    act(() => {
      result.current.updateDossier({ storytellerContext: 'Will unmount' });
    });

    unmount();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    // Timer was cleared on unmount, so the write should not happen
    expect(mockFirestore.updateDoc).not.toHaveBeenCalled();
  });
});

describe('useDossier — question CRUD', () => {
  beforeEach(() => {
    let callCount = 0;
    mockFirestore.onSnapshot.mockImplementation((_q: any, cb: any) => {
      callCount++;
      if (callCount % 2 === 1) {
        cb({ exists: () => true, id: 'dossier-1', data: () => ({ storytellerName: 'Margaret' }) });
      } else {
        cb({ docs: [] });
      }
      return vi.fn();
    });
  });

  it('addQuestion creates a document with Unasked status', async () => {
    const { result } = renderHook(() => useDossier('uid-1', 'dossier-1'));

    await act(async () => {
      await result.current.addQuestion('Tell me about your childhood.');
    });

    expect(mockFirestore.addDoc).toHaveBeenCalledTimes(1);
    const docData = mockFirestore.addDoc.mock.calls[0][1];
    expect(docData.text).toBe('Tell me about your childhood.');
    expect(docData.status).toBe('Unasked');
    expect(docData.findings).toBe('');
  });

  it('removeQuestion deletes the document', async () => {
    const { result } = renderHook(() => useDossier('uid-1', 'dossier-1'));

    await act(async () => {
      await result.current.removeQuestion('q1');
    });

    expect(mockFirestore.deleteDoc).toHaveBeenCalledTimes(1);
  });

  it('updateQuestion writes immediately (no debounce)', async () => {
    const { result } = renderHook(() => useDossier('uid-1', 'dossier-1'));

    await act(async () => {
      await result.current.updateQuestion('q1', { status: 'InProgress', findings: 'Mentioned a farm.' });
    });

    expect(mockFirestore.updateDoc).toHaveBeenCalledTimes(1);
    const updateData = mockFirestore.updateDoc.mock.calls[0][1];
    expect(updateData.status).toBe('InProgress');
    expect(updateData.findings).toBe('Mentioned a farm.');
    expect(updateData.updatedAt).toBeDefined();
  });

  it('reorderQuestions uses a batch write', async () => {
    const mockBatch = { update: vi.fn(), commit: vi.fn().mockResolvedValue(undefined) };
    mockFirestore.writeBatch.mockReturnValueOnce(mockBatch);

    const { result } = renderHook(() => useDossier('uid-1', 'dossier-1'));

    await act(async () => {
      await result.current.reorderQuestions(['q3', 'q1', 'q2']);
    });

    expect(mockFirestore.writeBatch).toHaveBeenCalledTimes(1);
    expect(mockBatch.update).toHaveBeenCalledTimes(3);
    expect(mockBatch.commit).toHaveBeenCalledTimes(1);

    // Verify order values
    const firstCall = mockBatch.update.mock.calls[0][1];
    expect(firstCall.order).toBe(0);
    const secondCall = mockBatch.update.mock.calls[1][1];
    expect(secondCall.order).toBe(1);
    const thirdCall = mockBatch.update.mock.calls[2][1];
    expect(thirdCall.order).toBe(2);
  });

  it('addQuestion/removeQuestion/updateQuestion are no-ops without uid', async () => {
    const { result } = renderHook(() => useDossier(undefined, 'dossier-1'));

    await act(async () => {
      await result.current.addQuestion('Test');
      await result.current.removeQuestion('q1');
      await result.current.updateQuestion('q1', { status: 'Completed' });
      await result.current.reorderQuestions(['q1']);
    });

    expect(mockFirestore.addDoc).not.toHaveBeenCalled();
    expect(mockFirestore.deleteDoc).not.toHaveBeenCalled();
    expect(mockFirestore.updateDoc).not.toHaveBeenCalled();
    expect(mockFirestore.writeBatch).not.toHaveBeenCalled();
  });
});
