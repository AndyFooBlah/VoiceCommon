/**
 * Tests for the FamilySelector component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

const mockUser = { uid: 'uid-1', email: 'test@test.com', displayName: 'Test' };
vi.mock('../../../hooks/useAuth', () => ({
  useAuth: () => ({ user: mockUser, loading: false }),
}));

let mockFamilyIds: string[] = [];
vi.mock('../../../hooks/useFamily', () => ({
  getUserFamilyIds: () => Promise.resolve(mockFamilyIds),
}));

import { FamilySelector } from '../../../components/family/FamilySelector';

beforeEach(() => {
  mockNavigate.mockClear();
  mockFamilyIds = [];
});

describe('FamilySelector — no families', () => {
  it('shows Create a Family button when user has no families', async () => {
    render(<FamilySelector />);

    await waitFor(() => {
      expect(screen.getByText('Create a Family')).toBeInTheDocument();
    });
  });

  it('shows I Have an Invite Link button', async () => {
    render(<FamilySelector />);

    await waitFor(() => {
      expect(screen.getByText('I Have an Invite Link')).toBeInTheDocument();
    });
  });

  it('navigates to create-family on button click', async () => {
    render(<FamilySelector />);

    await waitFor(() => {
      expect(screen.getByText('Create a Family')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create a Family'));
    expect(mockNavigate).toHaveBeenCalledWith('/create-family');
  });
});

describe('FamilySelector — single family', () => {
  it('auto-redirects to the family', async () => {
    mockFamilyIds = ['family-1'];
    render(<FamilySelector />);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/family/family-1', { replace: true });
    });
  });
});

describe('FamilySelector — multiple families', () => {
  it('shows family list', async () => {
    mockFamilyIds = ['family-1', 'family-2'];
    render(<FamilySelector />);

    await waitFor(() => {
      expect(screen.getByText('Your Families')).toBeInTheDocument();
    });
  });
});
