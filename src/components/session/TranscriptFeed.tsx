/**
 * TranscriptFeed — real-time message display during a live session.
 *
 * Shows the conversation as it happens, with user messages on the right
 * (indigo) and bot messages on the left (white with border). Each message
 * includes a timestamp. The feed auto-scrolls to the latest message.
 *
 * When empty, shows a placeholder message reminding the user that
 * transcripts stream in real-time and no data is ever deleted.
 *
 * References: product_requirements.md §3.2 | GitHub Issue #19
 */

import React, { useEffect, useRef } from 'react';
import { Message } from '../../types';

interface TranscriptFeedProps {
  messages: Message[];
  sessionId: string | null;
}

export const TranscriptFeed: React.FC<TranscriptFeedProps> = ({ messages, sessionId }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="w-full max-w-2xl space-y-4">
      <div className="flex justify-between items-center px-4">
        <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">
          Real-time Archive
        </h3>
        <span className="text-[10px] text-slate-300 font-mono">
          Session: {sessionId || '---'}
        </span>
      </div>
      <div
        ref={scrollRef}
        className="bg-white/40 backdrop-blur-sm border border-slate-100 rounded-[2.5rem] p-8 h-56 overflow-y-auto space-y-6 shadow-inner scroll-smooth"
      >
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-300 gap-4 opacity-50 text-center">
            <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
              />
            </svg>
            <p className="italic font-medium">
              Transcripts stream here as you speak. No data is ever deleted.
            </p>
          </div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] px-5 py-3 rounded-3xl text-sm leading-relaxed ${
                  m.role === 'user'
                    ? 'bg-indigo-600 text-white shadow-lg rounded-br-none'
                    : 'bg-white text-slate-700 border border-slate-200 rounded-bl-none shadow-sm'
                }`}
              >
                {m.text}
                <div
                  className={`text-[9px] mt-1 opacity-50 ${
                    m.role === 'user' ? 'text-white' : 'text-slate-400'
                  }`}
                >
                  {m.timestamp.toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
