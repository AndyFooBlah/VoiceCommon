/**
 * Tests for the StorytellerDashboard component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useParams: () => ({ familyId: 'family-1' }),
  useNavigate: () => mockNavigate,
}));

vi.mock('../../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { uid: 'uid-1' }, loading: false }),
}));

let mockDossiers: any[] = [];
let mockLoading = false;

vi.mock('../../../hooks/useDossier', () => ({
  useDossierList: () => ({
    dossiers: mockDossiers,
    loading: mockLoading,
  }),
}));

// Mock Firestore so DossierSessions' onSnapshot call is a no-op
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  query: vi.fn(),
  orderBy: vi.fn(),
  onSnapshot: vi.fn((_q, cb) => {
    cb({ docs: [] });
    return () => {};
  }),
}));

vi.mock('../../../services/firebase', () => ({
  db: {},
}));

import { StorytellerDashboard } from '../../../components/storyteller/StorytellerDashboard';

beforeEach(() => {
  mockNavigate.mockClear();
  mockDossiers = [];
  mockLoading = false;
});

describe('StorytellerDashboard — loading', () => {
  it('shows spinner when loading', () => {
    mockLoading = true;
    const { container } = render(<StorytellerDashboard />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });
});

describe('StorytellerDashboard — no dossiers', () => {
  it('shows welcome message when no dossiers assigned', () => {
    render(<StorytellerDashboard />);
    expect(screen.getByText('Welcome!')).toBeInTheDocument();
    expect(screen.getByText(/hasn't set things up/)).toBeInTheDocument();
  });
});

describe('StorytellerDashboard — with dossiers', () => {
  beforeEach(() => {
    mockDossiers = [
      { id: 'd1', storytellerName: 'Margaret', storytellerContext: 'Born in 1935' },
    ];
  });

  it('displays welcome with storyteller name', () => {
    render(<StorytellerDashboard />);
    expect(screen.getByText('Welcome, Margaret')).toBeInTheDocument();
  });

  it('does not display storyteller context', () => {
    render(<StorytellerDashboard />);
    expect(screen.queryByText('Born in 1935')).not.toBeInTheDocument();
  });

  it('shows Start New Interview button', () => {
    render(<StorytellerDashboard />);
    expect(screen.getByText('Start New Interview')).toBeInTheDocument();
  });

  it('shows Past Sessions section heading', () => {
    render(<StorytellerDashboard />);
    expect(screen.getByText('Past Sessions')).toBeInTheDocument();
  });

  it('navigates to session on Start New Interview click', () => {
    render(<StorytellerDashboard />);
    fireEvent.click(screen.getByText('Start New Interview'));
    expect(mockNavigate).toHaveBeenCalledWith('/family/family-1/dossier/d1/session');
  });
});
