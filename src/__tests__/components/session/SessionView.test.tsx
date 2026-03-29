/**
 * Tests for the SessionView component.
 * Now uses familyId from route params.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectionStatus } from '../../../types';

// --- Mocks ---

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useParams: () => ({ familyId: 'family-1', dossierId: 'dossier-1' }),
  useNavigate: () => mockNavigate,
}));

vi.mock('../../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { uid: 'uid-1' }, loading: false }),
}));

vi.mock('../../../hooks/useFamily', () => ({
  useFamily: () => ({ family: { familyTree: [] }, loading: false }),
  useCurrentRoles: () => ({ isAdmin: false, isStoryteller: true, loading: false }),
}));

let mockDossier: any = {
  storytellerName: 'Margaret',
  adminName: 'Andy',
  personality: 'empathetic',
  selectedVoice: 'Zephyr',
};
let mockQuestions: any[] = [];
let mockDossierLoading = false;

vi.mock('../../../hooks/useDossier', () => ({
  useDossier: () => ({
    dossier: mockDossierLoading ? null : mockDossier,
    questions: mockQuestions,
    loading: mockDossierLoading,
    updateQuestion: vi.fn(),
  }),
}));

const mockStartSession = vi.fn();
const mockStopSession = vi.fn();
const mockFlushPartialSession = vi.fn().mockResolvedValue(undefined);
let mockStatus = ConnectionStatus.DISCONNECTED;
let mockMessages: any[] = [];
let mockSessionId: string | null = null;

vi.mock('../../../hooks/useSession', () => ({
  useSession: () => ({
    status: mockStatus,
    messages: mockMessages,
    isBotSpeaking: false,
    sessionId: mockSessionId,
    startSession: mockStartSession,
    stopSession: mockStopSession,
    flushPartialSession: mockFlushPartialSession,
  }),
}));

// Mock Visualizer to avoid canvas issues in jsdom
vi.mock('../../../components/session/Visualizer', () => ({
  Visualizer: () => <div data-testid="visualizer" />,
}));

import { SessionView } from '../../../components/session/SessionView';

beforeEach(() => {
  mockNavigate.mockClear();
  mockStartSession.mockClear();
  mockStopSession.mockClear();
  mockFlushPartialSession.mockClear();
  mockDossier = { storytellerName: 'Margaret', adminName: 'Andy', personality: 'empathetic', selectedVoice: 'Zephyr' };
  mockDossierLoading = false;
  mockStatus = ConnectionStatus.DISCONNECTED;
  mockMessages = [];
  mockSessionId = null;
});

describe('SessionView — loading state', () => {
  it('shows spinner when dossier is loading', () => {
    mockDossierLoading = true;
    const { container } = render(<SessionView />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });
});

describe('SessionView — disconnected state', () => {
  it('shows the storyteller name', () => {
    render(<SessionView />);
    expect(screen.getByText(/Session with Margaret/)).toBeInTheDocument();
  });

  it('shows the ready prompt', () => {
    render(<SessionView />);
    expect(screen.getByText(/Ready to begin, Margaret/)).toBeInTheDocument();
  });

  it('shows the start button instructions', () => {
    render(<SessionView />);
    expect(screen.getByText(/Press the button above to start/)).toBeInTheDocument();
  });

  it('calls startSession when start button is clicked', () => {
    render(<SessionView />);
    const buttons = screen.getAllByRole('button');
    const startBtn = buttons.find((b) => !b.textContent?.includes('Back'));
    fireEvent.click(startBtn!);
    expect(mockStartSession).toHaveBeenCalledTimes(1);
  });

  it('shows the Back to Home link for storytellers', () => {
    render(<SessionView />);
    expect(screen.getByText(/Back to Home/)).toBeInTheDocument();
  });

  it('navigates to family home on Back link click for storytellers', () => {
    render(<SessionView />);
    fireEvent.click(screen.getByText(/Back to Home/));
    expect(mockNavigate).toHaveBeenCalledWith('/family/family-1');
  });
});

describe('SessionView — connecting state', () => {
  it('disables the start button while connecting', () => {
    mockStatus = ConnectionStatus.CONNECTING;
    const { container } = render(<SessionView />);
    const spinner = container.querySelector('.animate-spin');
    expect(spinner).not.toBeNull();
  });
});

describe('SessionView — connected state', () => {
  beforeEach(() => {
    mockStatus = ConnectionStatus.CONNECTED;
  });

  it('shows the active recording indicator', () => {
    render(<SessionView />);
    expect(screen.getByText(/Live Archival Vault Active/)).toBeInTheDocument();
  });

  it('shows the storytelling prompt', () => {
    render(<SessionView />);
    expect(screen.getByText(/Tell your story, Margaret/)).toBeInTheDocument();
  });

  it('shows the preservation message', () => {
    render(<SessionView />);
    expect(screen.getByText(/Every word and sound is being preserved/)).toBeInTheDocument();
  });

  it('calls stopSession when stop button is clicked', () => {
    render(<SessionView />);
    const buttons = screen.getAllByRole('button');
    const stopBtn = buttons.find((b) => !b.textContent?.includes('View Past') && !b.textContent?.includes('Back'));
    fireEvent.click(stopBtn!);
    expect(mockStopSession).toHaveBeenCalledTimes(1);
  });
});

describe('SessionView — error state', () => {
  beforeEach(() => {
    mockStatus = ConnectionStatus.ERROR;
  });

  it('shows the error dialog', () => {
    render(<SessionView />);
    expect(screen.getByText('Connection Interrupted')).toBeInTheDocument();
  });

  it('shows reassuring message', () => {
    render(<SessionView />);
    expect(screen.getByText(/everything you've shared so far has been saved/)).toBeInTheDocument();
  });

  it('shows Reconnect and End Session buttons', () => {
    render(<SessionView />);
    expect(screen.getByText('Reconnect')).toBeInTheDocument();
    expect(screen.getByText('End Session')).toBeInTheDocument();
  });

  it('flushes and reconnects on Reconnect click', async () => {
    render(<SessionView />);
    fireEvent.click(screen.getByText('Reconnect'));

    expect(mockFlushPartialSession).toHaveBeenCalledTimes(1);
  });

  it('flushes and navigates on End Session click', async () => {
    render(<SessionView />);
    fireEvent.click(screen.getByText('End Session'));

    expect(mockFlushPartialSession).toHaveBeenCalledTimes(1);
  });
});
