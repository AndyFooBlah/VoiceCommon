/**
 * SessionView — the live recording session screen.
 *
 * This is the Storyteller-facing view. It prioritizes simplicity:
 *   - One large Start/Stop button
 *   - Visual waveform feedback
 *   - Live transcript feed
 *   - "Live Archival Vault Active" indicator when recording
 *
 * The Archivist panel (Dossier editor) is accessible via a floating
 * button but hidden by default to keep the Storyteller's view clean.
 *
 * Error handling:
 *   - Connection errors show a reassuring message (not a stack trace)
 *   - Partial session data is flushed on disconnect
 *   - A "Reconnect" button is offered for recovery
 *
 * References: product_requirements.md §4 | GitHub Issues #17, #19
 */

import React, { useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useFamily } from '../../hooks/useFamily';
import { useDossier } from '../../hooks/useDossier';
import { useSession } from '../../hooks/useSession';
import { Visualizer } from './Visualizer';
import { TranscriptFeed } from './TranscriptFeed';
import { ConnectionStatus } from '../../types';

export const SessionView: React.FC = () => {
  const { familyId, dossierId } = useParams<{ familyId: string; dossierId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { family } = useFamily(familyId);
  const {
    dossier,
    questions,
    loading: dossierLoading,
    updateQuestion,
  } = useDossier(familyId, dossierId);

  /** Handler for Gemini function-calling question updates during a session. */
  const handleQuestionUpdate = useCallback(
    (questionId: string, status: string, findings: string) => {
      updateQuestion(questionId, { status: status as any, findings });
    },
    [updateQuestion],
  );

  const {
    status,
    messages,
    isBotSpeaking,
    sessionId,
    deviceError,
    connectivityWarning,
    clearDeviceError,
    dismissConnectivityWarning,
    startSession,
    stopSession,
    flushPartialSession,
  } = useSession({
    familyId: familyId ?? '',
    dossierId: dossierId ?? '',
    storytellerUid: user?.uid ?? '',
    dossier: dossier!,
    questions,
    familyTree: family?.familyTree,
    onQuestionUpdate: handleQuestionUpdate,
  });

  if (dossierLoading || !dossier) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-slate-50 p-6 space-y-8">
      {/* Back to Dossier link (small, unobtrusive) */}
      <button
        onClick={() => navigate(`/family/${familyId}/dossier/${dossierId}`)}
        className="absolute top-4 left-4 text-sm text-slate-400 hover:text-slate-600 transition-colors"
      >
        &larr; Back to Dossier
      </button>

      {/* Header */}
      <div className="text-center space-y-2">
        <h1 className="text-5xl font-bold text-slate-800 tracking-tighter font-display">
          LegacyBot
        </h1>
        <p className="text-slate-400 font-medium italic">
          Session with {dossier.storytellerName}
        </p>
      </div>

      {/* Connectivity warning */}
      {connectivityWarning && (
        <div className="w-full max-w-2xl bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3">
          <svg className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <div className="flex-1">
            <p className="text-sm text-amber-800">{connectivityWarning}</p>
          </div>
          <button
            onClick={dismissConnectivityWarning}
            className="text-amber-600 hover:text-amber-800 text-sm font-medium shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main session card */}
      <div className="w-full max-w-2xl bg-white p-12 rounded-[3.5rem] shadow-2xl border border-slate-100 flex flex-col items-center space-y-12 relative overflow-hidden">
        {/* Live recording indicator */}
        {status === ConnectionStatus.CONNECTED && (
          <div className="absolute top-6 right-6 flex items-center gap-2 px-3 py-1 bg-rose-50 border border-rose-100 rounded-full animate-pulse">
            <div className="w-2 h-2 bg-rose-500 rounded-full" />
            <span className="text-[10px] font-bold text-rose-600 uppercase tracking-widest">
              Live Archival Vault Active
            </span>
          </div>
        )}

        <Visualizer
          isActive={status === ConnectionStatus.CONNECTED}
          isBotSpeaking={isBotSpeaking}
        />

        <div className="flex flex-col items-center gap-6 w-full">
          {/* Start / Stop button */}
          {status !== ConnectionStatus.CONNECTED ? (
            <button
              onClick={startSession}
              disabled={status === ConnectionStatus.CONNECTING}
              className="w-28 h-28 bg-indigo-600 rounded-full text-white shadow-2xl hover:scale-105 active:scale-95 transition-all flex items-center justify-center group disabled:opacity-50"
            >
              {status === ConnectionStatus.CONNECTING ? (
                <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-white" />
              ) : (
                <svg className="w-12 h-12 ml-1 group-hover:scale-110 transition-transform" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" />
                </svg>
              )}
            </button>
          ) : (
            <button
              onClick={stopSession}
              className="w-28 h-28 bg-slate-800 rounded-full text-white shadow-2xl hover:bg-slate-900 transition-all flex items-center justify-center"
            >
              <svg className="w-10 h-10" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" />
              </svg>
            </button>
          )}

          <div className="text-center space-y-1">
            <p className="text-xl font-bold text-slate-800">
              {status === ConnectionStatus.CONNECTED
                ? `Tell your story, ${dossier.storytellerName}...`
                : `Ready to begin, ${dossier.storytellerName}?`}
            </p>
            <p className="text-sm text-slate-400">
              {status === ConnectionStatus.CONNECTED
                ? 'Every word and sound is being preserved.'
                : 'Press the button above to start your oral history session.'}
            </p>
          </div>
        </div>
      </div>

      {/* Live transcript feed */}
      <TranscriptFeed messages={messages} sessionId={sessionId} />

      {/* Device error dialog (microphone issues) */}
      {status === ConnectionStatus.ERROR && deviceError && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/80 backdrop-blur-sm p-4 text-center">
          <div className="bg-white p-8 rounded-[2rem] shadow-2xl max-w-md space-y-6">
            <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto">
              <svg className="w-8 h-8 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-slate-800">
              Microphone Issue
            </h2>
            <p className="text-slate-500">
              {deviceError}
            </p>
            <div className="flex flex-col gap-3">
              <button
                onClick={() => {
                  clearDeviceError();
                  startSession();
                }}
                className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-bold hover:bg-indigo-700 transition-colors"
              >
                Try Again
              </button>
              <button
                onClick={() => navigate(`/family/${familyId}/dossier/${dossierId}`)}
                className="w-full py-3 text-slate-500 font-medium hover:text-slate-700 transition-colors"
              >
                Back to Dossier
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Connection error dialog (non-device errors) */}
      {status === ConnectionStatus.ERROR && !deviceError && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/80 backdrop-blur-sm p-4 text-center">
          <div className="bg-white p-8 rounded-[2rem] shadow-2xl max-w-md space-y-6">
            <h2 className="text-2xl font-bold text-slate-800">
              Connection Interrupted
            </h2>
            <p className="text-slate-500">
              Don&apos;t worry — everything you&apos;ve shared so far has been
              saved. You can reconnect to continue your session.
            </p>
            <div className="flex flex-col gap-3">
              <button
                onClick={async () => {
                  await flushPartialSession();
                  startSession();
                }}
                className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-bold hover:bg-indigo-700 transition-colors"
              >
                Reconnect
              </button>
              <button
                onClick={async () => {
                  await flushPartialSession();
                  navigate(`/family/${familyId}/dossier/${dossierId}`);
                }}
                className="w-full py-3 text-slate-500 font-medium hover:text-slate-700 transition-colors"
              >
                End Session
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
