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
          messages.map((m) => {
            if (m.role === 'tool') {
              return (
                <div key={m.id} className="flex justify-center">
                  <div className="flex items-center gap-1.5 px-3 py-1 bg-slate-100 rounded-full text-[10px] text-slate-400 font-mono">
                    <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    {m.text}
                  </div>
                </div>
              );
            }
            return (
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
            );
          })
        )}
      </div>
    </div>
  );
};
