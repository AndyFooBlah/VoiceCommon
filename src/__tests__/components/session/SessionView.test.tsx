/**
 * Tests for the SessionView component.
 * Now uses familyId from route params.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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
const mockReconnectSession = vi.fn().mockResolvedValue(undefined);
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
    reconnectSession: mockReconnectSession,
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
  mockReconnectSession.mockClear();
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
    const stopBtn = buttons.find((b) => !b.textContent?.includes('Back'));
    fireEvent.click(stopBtn!);
    expect(mockStopSession).toHaveBeenCalledTimes(1);
  });
});

describe('SessionView — error state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockStatus = ConnectionStatus.ERROR;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows reconnecting banner immediately (no modal yet)', () => {
    render(<SessionView />);
    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument();
    expect(screen.queryByText('Connection Interrupted')).not.toBeInTheDocument();
  });

  it('auto-reconnects (calls reconnectSession) after delay without starting a new session', async () => {
    render(<SessionView />);
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(mockReconnectSession).toHaveBeenCalledTimes(1);
    expect(mockStartSession).not.toHaveBeenCalled();
    expect(mockFlushPartialSession).not.toHaveBeenCalled();
  });

  it('shows error modal after auto-reconnect attempt fails', async () => {
    // mockReconnectSession is a no-op so status stays ERROR — simulating reconnect failure
    render(<SessionView />);
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(screen.getByText('Connection Interrupted')).toBeInTheDocument();
    expect(screen.getByText(/everything you've shared so far has been saved/)).toBeInTheDocument();
    expect(screen.getByText('Try Again')).toBeInTheDocument();
    expect(screen.getByText('End Session')).toBeInTheDocument();
  });

  it('calls reconnectSession (not startSession) when Try Again is clicked', async () => {
    render(<SessionView />);
    await act(async () => { vi.advanceTimersByTime(600); });
    mockReconnectSession.mockClear();
    await act(async () => { fireEvent.click(screen.getByText('Try Again')); });
    expect(mockReconnectSession).toHaveBeenCalledTimes(1);
    expect(mockStartSession).not.toHaveBeenCalled();
  });

  it('flushes and navigates to home on End Session click', async () => {
    render(<SessionView />);
    await act(async () => { vi.advanceTimersByTime(600); });
    await act(async () => { fireEvent.click(screen.getByText('End Session')); });
    expect(mockFlushPartialSession).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/family/family-1');
  });
});
