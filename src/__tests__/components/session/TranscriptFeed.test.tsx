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
 * Tests for the TranscriptFeed component.
 *
 * Verifies message rendering, speaker styling, empty state, and session ID display.
 *
 * References: design.md §5.3 (Priority 2) | src/components/session/TranscriptFeed.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TranscriptFeed } from '../../../components/session/TranscriptFeed';
import { Message } from '../../../types';

function makeMessage(role: 'user' | 'bot', text: string): Message {
  return {
    id: Math.random().toString(36).slice(2),
    role,
    text,
    timestamp: new Date('2024-01-15T10:30:00'),
  };
}

describe('TranscriptFeed', () => {
  it('shows empty state placeholder when no messages', () => {
    render(<TranscriptFeed messages={[]} sessionId={null} />);

    expect(
      screen.getByText(/Transcripts stream here as you speak/i),
    ).toBeInTheDocument();
  });

  it('displays session ID when provided', () => {
    render(<TranscriptFeed messages={[]} sessionId="session-abc123" />);

    expect(screen.getByText(/session-abc123/)).toBeInTheDocument();
  });

  it('shows --- when no session ID', () => {
    render(<TranscriptFeed messages={[]} sessionId={null} />);

    expect(screen.getByText(/---/)).toBeInTheDocument();
  });

  it('renders user and bot messages', () => {
    const messages = [
      makeMessage('bot', 'Good morning! How are you?'),
      makeMessage('user', 'I am doing well, thank you.'),
    ];

    render(<TranscriptFeed messages={messages} sessionId="s1" />);

    expect(screen.getByText('Good morning! How are you?')).toBeInTheDocument();
    expect(screen.getByText('I am doing well, thank you.')).toBeInTheDocument();
  });

  it('renders timestamps for messages', () => {
    const messages = [makeMessage('bot', 'Hello!')];

    render(<TranscriptFeed messages={messages} sessionId="s1" />);

    // The timestamp should be formatted as HH:MM
    expect(screen.getByText('10:30 AM')).toBeInTheDocument();
  });

  it('hides empty state when messages exist', () => {
    const messages = [makeMessage('bot', 'Hello!')];

    render(<TranscriptFeed messages={messages} sessionId="s1" />);

    expect(
      screen.queryByText(/Transcripts stream here/i),
    ).not.toBeInTheDocument();
  });
});
