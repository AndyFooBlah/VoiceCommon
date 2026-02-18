/**
 * Tests for the AcceptInvite component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockNavigate = vi.fn();
let mockSearchParams = new URLSearchParams('token=inv-123');
vi.mock('react-router-dom', () => ({
  useSearchParams: () => [mockSearchParams],
  useNavigate: () => mockNavigate,
}));

const mockUser = { uid: 'uid-1', email: 'test@test.com', displayName: 'Test User' };
vi.mock('../../../hooks/useAuth', () => ({
  useAuth: () => ({ user: mockUser, loading: false }),
}));

let mockInvitation: any = null;
let mockLoading = false;
let mockError: string | null = null;
const mockLoadInvitation = vi.fn();
const mockAccept = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../hooks/useInvitations', () => ({
  useAcceptInvitation: () => ({
    invitation: mockInvitation,
    loading: mockLoading,
    error: mockError,
    loadInvitation: mockLoadInvitation,
    accept: mockAccept,
  }),
}));

import { AcceptInvite } from '../../../components/auth/AcceptInvite';

beforeEach(() => {
  mockNavigate.mockClear();
  mockLoadInvitation.mockClear();
  mockAccept.mockClear();
  mockInvitation = null;
  mockLoading = false;
  mockError = null;
  mockSearchParams = new URLSearchParams('token=inv-123');
});

describe('AcceptInvite — no token', () => {
  it('shows invalid link when no token in URL', () => {
    mockSearchParams = new URLSearchParams('');
    render(<AcceptInvite />);
    expect(screen.getByText('Invalid Invite Link')).toBeInTheDocument();
  });
});

describe('AcceptInvite — loading', () => {
  it('shows spinner when loading', () => {
    mockLoading = true;
    const { container } = render(<AcceptInvite />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });
});

describe('AcceptInvite — error', () => {
  it('shows error message', () => {
    mockError = 'Invitation not found.';
    render(<AcceptInvite />);
    expect(screen.getByText('Invitation Error')).toBeInTheDocument();
  });
});

describe('AcceptInvite — valid invitation', () => {
  beforeEach(() => {
    mockInvitation = {
      id: 'inv-123',
      familyId: 'family-1',
      email: 'test@test.com',
      roles: ['storyteller'],
      status: 'pending',
    };
  });

  it('shows invitation details', () => {
    render(<AcceptInvite />);
    expect(screen.getByText("You're Invited!")).toBeInTheDocument();
    expect(screen.getByText('storyteller')).toBeInTheDocument();
  });

  it('shows Accept Invitation button', () => {
    render(<AcceptInvite />);
    expect(screen.getByText('Accept Invitation')).toBeInTheDocument();
  });

  it('calls loadInvitation on mount', () => {
    render(<AcceptInvite />);
    expect(mockLoadInvitation).toHaveBeenCalledWith('inv-123');
  });

  it('accepts and navigates on button click', async () => {
    render(<AcceptInvite />);
    fireEvent.click(screen.getByText('Accept Invitation'));

    await waitFor(() => {
      expect(mockAccept).toHaveBeenCalledWith('inv-123', 'uid-1', 'Test User', 'test@test.com');
    });
  });
});

describe('AcceptInvite — already accepted', () => {
  it('shows already accepted message', () => {
    mockInvitation = {
      id: 'inv-123',
      familyId: 'family-1',
      email: 'test@test.com',
      roles: ['storyteller'],
      status: 'accepted',
    };

    render(<AcceptInvite />);
    expect(screen.getByText('Already Accepted')).toBeInTheDocument();
  });
});
