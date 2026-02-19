/**
 * FamilyPage — unified admin view for managing family members and information.
 *
 * Combines:
 *   - Member management (from MemberManagement)
 *   - Storyteller cards/bios (from DossierList)
 *   - Family tree (moved from DossierEditor)
 *
 * This is the main landing page for admins within a family.
 *
 * References: GitHub Issue #60 (Phase 1)
 */

import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useFamily, useFamilyMembers, updateFamilyTree } from '../../hooks/useFamily';
import { useFamilyInvitations } from '../../hooks/useInvitations';
import { useDossierList } from '../../hooks/useDossier';
import { updateMemberEmail, resetMemberPassword } from '../../services/adminActions';
import { InviteMember } from './InviteMember';
import { FamilyMember, RelationType, MemberType } from '../../types';

export const FamilyPage: React.FC = () => {
  const { familyId } = useParams<{ familyId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { family, loading: familyLoading } = useFamily(familyId);
  const { members, loading: membersLoading } = useFamilyMembers(familyId);
  const { invitations, loading: invitesLoading, createInvite, cancelInvite } = useFamilyInvitations(familyId);
  const { dossiers, loading: dossiersLoading, createDossier, deleteDossier } = useDossierList(familyId);

  const [showInviteForm, setShowInviteForm] = useState(false);

  // Edit email state
  const [editingUid, setEditingUid] = useState<string | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset password state
  const [resetLink, setResetLink] = useState<string | null>(null);
  const [resetForName, setResetForName] = useState('');
  const [resetting, setResetting] = useState<string | null>(null);

  // Create storyteller state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  // Reissue invite state
  const [reissueLink, setReissueLink] = useState<string | null>(null);
  const [reissueForName, setReissueForName] = useState('');
  const [reissuing, setReissuing] = useState<string | null>(null);

  async function handleSaveEmail(targetUid: string) {
    if (!familyId || !editEmail.trim()) return;
    setSaving(true);
    try {
      await updateMemberEmail(familyId, targetUid, editEmail.trim());
      setEditingUid(null);
      setEditEmail('');
    } catch (err: any) {
      console.error('[FamilyPage] Update email error:', err);
      alert(err.message || 'Failed to update email');
    } finally {
      setSaving(false);
    }
  }

  async function handleResetPassword(targetUid: string, displayName: string) {
    if (!familyId) return;
    setResetting(targetUid);
    try {
      const link = await resetMemberPassword(familyId, targetUid);
      setResetLink(link);
      setResetForName(displayName);
    } catch (err: any) {
      console.error('[FamilyPage] Reset password error:', err);
      alert(err.message || 'Failed to generate reset link');
    } finally {
      setResetting(null);
    }
  }

  async function handleReissueInvite(memberUid: string, memberEmail: string, displayName: string) {
    if (!familyId || !user) return;
    setReissuing(memberUid);
    try {
      const linkedDossierIds = dossiers
        .filter((d) => d.storytellerUid === memberUid)
        .map((d) => d.id!);
      const inviteId = await createInvite(memberEmail, ['storyteller'], linkedDossierIds, user.uid);
      const link = `${window.location.origin}/invite?token=${inviteId}&email=${encodeURIComponent(memberEmail)}`;
      setReissueLink(link);
      setReissueForName(displayName);
    } catch (err: any) {
      console.error('[FamilyPage] Reissue invite error:', err);
      alert(err.message || 'Failed to create invitation');
    } finally {
      setReissuing(null);
    }
  }

  async function handleCreateStoryteller() {
    if (!newName.trim()) return;
    const dossierId = await createDossier(newName.trim());

    if (newEmail.trim() && user) {
      try {
        const inviteId = await createInvite(newEmail.trim(), ['storyteller'], [dossierId], user.uid);
        const link = `${window.location.origin}/invite?token=${inviteId}&email=${encodeURIComponent(newEmail.trim())}`;
        setInviteLink(link);
        setShowCreateForm(false);
        return;
      } catch (err) {
        console.error('[FamilyPage] Failed to create invitation:', err);
      }
    }

    setNewName('');
    setNewEmail('');
    setShowCreateForm(false);
    navigate(`/family/${familyId}/dossier/${dossierId}`);
  }

  // Family Tree handlers (relational model)
  function handleAddFamilyMember(memberType: MemberType) {
    if (!familyId || !family) return;
    const newMember: FamilyMember = {
      id: `member-${Date.now()}`, // simple ID generation
      name: '',
      relations: [],
      memberType,
    };
    updateFamilyTree(familyId, [...(family.familyTree ?? []), newMember]);
  }

  function handleFamilyMemberChange(memberId: string, updates: Partial<FamilyMember>) {
    if (!familyId || !family) return;
    const updated = (family.familyTree ?? []).map((m) =>
      m.id === memberId ? { ...m, ...updates } : m
    );
    updateFamilyTree(familyId, updated);
  }

  function handleRemoveFamilyMember(memberId: string) {
    if (!familyId || !family) return;
    const updated = (family.familyTree ?? []).filter((m) => m.id !== memberId);
    updateFamilyTree(familyId, updated);
  }

  function handleAddRelation(memberId: string) {
    if (!familyId || !family) return;
    const member = (family.familyTree ?? []).find((m) => m.id === memberId);
    if (!member) return;
    const updatedMember = {
      ...member,
      relations: [...member.relations, { type: 'Parent' as RelationType, toMemberId: '' }],
    };
    handleFamilyMemberChange(memberId, updatedMember);
  }

  function handleRemoveRelation(memberId: string, relationIndex: number) {
    if (!familyId || !family) return;
    const member = (family.familyTree ?? []).find((m) => m.id === memberId);
    if (!member) return;
    const updatedRelations = member.relations.filter((_, i) => i !== relationIndex);
    handleFamilyMemberChange(memberId, { relations: updatedRelations });
  }

  function handleUpdateRelation(
    memberId: string,
    relationIndex: number,
    updates: { type?: RelationType; toMemberId?: string }
  ) {
    if (!familyId || !family) return;
    const member = (family.familyTree ?? []).find((m) => m.id === memberId);
    if (!member) return;
    const updatedRelations = member.relations.map((r, i) =>
      i === relationIndex ? { ...r, ...updates } : r
    );
    handleFamilyMemberChange(memberId, { relations: updatedRelations });
  }

  if (familyLoading || membersLoading || invitesLoading || dossiersLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  const familyTree = family?.familyTree ?? [];

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-8">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold text-slate-800 tracking-tight">
          {family?.name || 'Family'}
        </h2>
        <p className="text-slate-400 mt-1">
          Manage family members, storytellers, and family tree information.
        </p>
      </div>

      {/* Members Section */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-bold text-slate-700">Family Members</h3>
          <div className="flex gap-2">
            <button
              onClick={() => setShowCreateForm(true)}
              className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors"
            >
              + New Storyteller
            </button>
            <button
              onClick={() => setShowInviteForm(true)}
              className="px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-semibold hover:bg-slate-50 transition-colors"
            >
              + Invite Member
            </button>
          </div>
        </div>

        {/* New Storyteller Form */}
        {showCreateForm && (
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-4">
            <h3 className="font-bold text-slate-800">Create New Storyteller</h3>
            <div className="space-y-3">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Storyteller name (e.g., Margaret)"
                className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="Email (optional — invite will be generated)"
                className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCreateStoryteller}
                disabled={!newName.trim()}
                className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors disabled:opacity-50"
              >
                Create
              </button>
              <button
                onClick={() => {
                  setShowCreateForm(false);
                  setNewName('');
                  setNewEmail('');
                }}
                className="px-4 py-2 text-slate-500 font-medium hover:text-slate-700 transition-colors text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Invite Link Display */}
        {inviteLink && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 shadow-sm space-y-3">
            <p className="text-sm font-semibold text-emerald-800">Invitation Created!</p>
            <p className="text-xs text-emerald-600">Share this link with the storyteller:</p>
            <div className="bg-white rounded-lg p-3 border border-emerald-200 break-all text-xs font-mono text-slate-700">
              {inviteLink}
            </div>
            <button
              onClick={() => {
                navigator.clipboard.writeText(inviteLink);
                alert('Link copied to clipboard!');
              }}
              className="text-sm text-emerald-600 font-medium hover:underline"
            >
              Copy to Clipboard
            </button>
            <button
              onClick={() => setInviteLink(null)}
              className="ml-4 text-sm text-slate-400 hover:text-slate-600"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Invite Form */}
        {showInviteForm && (
          <InviteMember onClose={() => setShowInviteForm(false)} />
        )}

        {/* Members List */}
        <div className="space-y-3">
          {members.map((member) => {
            const dossier = dossiers.find((d) => d.storytellerUid === member.uid);
            const isStoryteller = member.roles.includes('storyteller');
            const isAdmin = member.roles.includes('admin');
            const isEditing = editingUid === member.uid;

            return (
              <div
                key={member.uid}
                className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-3"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="font-semibold text-slate-800">{member.displayName}</p>
                      {isAdmin && (
                        <span className="text-[10px] font-bold px-2 py-0.5 bg-indigo-100 text-indigo-600 rounded-full uppercase tracking-wider">
                          Admin
                        </span>
                      )}
                      {isStoryteller && (
                        <span className="text-[10px] font-bold px-2 py-0.5 bg-emerald-100 text-emerald-600 rounded-full uppercase tracking-wider">
                          Storyteller
                        </span>
                      )}
                    </div>

                    {isEditing ? (
                      <div className="flex items-center gap-2 mt-2">
                        <input
                          type="email"
                          value={editEmail}
                          onChange={(e) => setEditEmail(e.target.value)}
                          className="flex-1 p-2 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                        <button
                          onClick={() => handleSaveEmail(member.uid)}
                          disabled={saving}
                          className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-xs font-semibold hover:bg-indigo-700 transition-colors disabled:opacity-50"
                        >
                          {saving ? 'Saving...' : 'Save'}
                        </button>
                        <button
                          onClick={() => {
                            setEditingUid(null);
                            setEditEmail('');
                          }}
                          className="text-xs text-slate-500 hover:text-slate-700"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <p className="text-sm text-slate-400">{member.email}</p>
                    )}

                    {/* Storyteller bio */}
                    {dossier?.storytellerContext && (
                      <p className="text-sm text-slate-600 mt-2 italic">
                        {dossier.storytellerContext}
                      </p>
                    )}
                  </div>

                  {/* Action buttons */}
                  <div className="flex flex-col gap-1 text-xs">
                    {dossier && (
                      <button
                        onClick={() => navigate(`/family/${familyId}/dossier/${dossier.id}`)}
                        className="text-indigo-600 hover:underline font-medium text-left"
                      >
                        Edit Dossier
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setEditingUid(member.uid);
                        setEditEmail(member.email);
                      }}
                      className="text-slate-500 hover:underline text-left"
                    >
                      Edit Email
                    </button>
                    <button
                      onClick={() => handleResetPassword(member.uid, member.displayName)}
                      disabled={resetting === member.uid}
                      className="text-slate-500 hover:underline text-left disabled:opacity-50"
                    >
                      {resetting === member.uid ? 'Generating...' : 'Reset Password'}
                    </button>
                    {isStoryteller && !dossier?.storytellerUid && (
                      <button
                        onClick={() => handleReissueInvite(member.uid, member.email, member.displayName)}
                        disabled={reissuing === member.uid}
                        className="text-slate-500 hover:underline text-left disabled:opacity-50"
                      >
                        {reissuing === member.uid ? 'Generating...' : 'Reissue Invite'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Reset Password Link */}
        {resetLink && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 shadow-sm space-y-3">
            <p className="text-sm font-semibold text-amber-800">Password Reset Link Generated for {resetForName}</p>
            <p className="text-xs text-amber-600">Share this link with them:</p>
            <div className="bg-white rounded-lg p-3 border border-amber-200 break-all text-xs font-mono text-slate-700">
              {resetLink}
            </div>
            <button
              onClick={() => {
                navigator.clipboard.writeText(resetLink);
                alert('Link copied to clipboard!');
              }}
              className="text-sm text-amber-600 font-medium hover:underline"
            >
              Copy to Clipboard
            </button>
            <button
              onClick={() => setResetLink(null)}
              className="ml-4 text-sm text-slate-400 hover:text-slate-600"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Reissue Invite Link */}
        {reissueLink && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 shadow-sm space-y-3">
            <p className="text-sm font-semibold text-emerald-800">Invitation Reissued for {reissueForName}</p>
            <p className="text-xs text-emerald-600">Share this link with them:</p>
            <div className="bg-white rounded-lg p-3 border border-emerald-200 break-all text-xs font-mono text-slate-700">
              {reissueLink}
            </div>
            <button
              onClick={() => {
                navigator.clipboard.writeText(reissueLink);
                alert('Link copied to clipboard!');
              }}
              className="text-sm text-emerald-600 font-medium hover:underline"
            >
              Copy to Clipboard
            </button>
            <button
              onClick={() => setReissueLink(null)}
              className="ml-4 text-sm text-slate-400 hover:text-slate-600"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Pending Invitations */}
        {invitations.filter((inv) => inv.status === 'pending').length > 0 && (
          <div className="bg-slate-50 rounded-2xl border border-slate-200 p-6 shadow-sm space-y-3">
            <h4 className="text-sm font-bold text-slate-600 uppercase tracking-wider">Pending Invitations</h4>
            <div className="space-y-2">
              {invitations
                .filter((inv) => inv.status === 'pending')
                .map((inv) => (
                  <div key={inv.id} className="flex items-center justify-between text-sm">
                    <span className="text-slate-700">{inv.email}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-400">
                        {inv.roles.join(', ')}
                      </span>
                      <button
                        onClick={() => cancelInvite(inv.id!)}
                        className="text-xs text-rose-500 hover:underline"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}
      </section>

      {/* Family Tree Section (Relational Model) */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-bold text-slate-700">Family Tree</h3>
          <div className="flex gap-2">
            <button
              onClick={() => handleAddFamilyMember('person')}
              className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors"
            >
              + Add Person
            </button>
            <button
              onClick={() => handleAddFamilyMember('pet')}
              className="px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-semibold hover:bg-slate-50 transition-colors"
            >
              + Add Pet
            </button>
          </div>
        </div>

        {familyTree.length === 0 ? (
          <div className="bg-slate-50 rounded-2xl border border-slate-200 p-8 text-center text-slate-400">
            No family members added yet. Add people, pets, and friends to build your family tree.
          </div>
        ) : (
          <div className="space-y-4">
            {familyTree.map((member) => (
              <div
                key={member.id}
                className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4"
              >
                {/* Member header */}
                <div className="flex items-start justify-between">
                  <div className="flex-1 space-y-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={member.name}
                        onChange={(e) => handleFamilyMemberChange(member.id, { name: e.target.value })}
                        placeholder={member.memberType === 'pet' ? 'Pet name' : 'Person name'}
                        className="flex-1 p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:ring-1 focus:ring-indigo-500"
                      />
                      <span className="text-xs px-2 py-1 bg-slate-100 text-slate-600 rounded-full font-medium">
                        {member.memberType === 'pet' ? '🐾 Pet' : '👤 Person'}
                      </span>
                    </div>

                    <textarea
                      value={member.notes || ''}
                      onChange={(e) => handleFamilyMemberChange(member.id, { notes: e.target.value })}
                      placeholder="Notes (optional)"
                      rows={2}
                      className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
                    />
                  </div>

                  <button
                    onClick={() => handleRemoveFamilyMember(member.id)}
                    className="text-slate-300 hover:text-rose-500 transition-colors text-xl ml-4"
                    title="Remove member"
                  >
                    &times;
                  </button>
                </div>

                {/* Relationships */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Relationships</p>
                    <button
                      onClick={() => handleAddRelation(member.id)}
                      className="text-xs text-indigo-600 font-medium hover:underline"
                    >
                      + Add Relationship
                    </button>
                  </div>

                  {member.relations.length === 0 ? (
                    <p className="text-xs text-slate-400 italic">No relationships defined yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {member.relations.map((relation, relationIdx) => (
                        <div key={relationIdx} className="flex items-center gap-2 bg-slate-50 rounded-lg p-2">
                          <select
                            value={relation.type}
                            onChange={(e) =>
                              handleUpdateRelation(member.id, relationIdx, {
                                type: e.target.value as RelationType,
                              })
                            }
                            className="p-1.5 bg-white border border-slate-200 rounded text-xs outline-none focus:ring-1 focus:ring-indigo-500"
                          >
                            <option value="Parent">Parent</option>
                            <option value="Spouse">Spouse</option>
                            <option value="Child">Child</option>
                            <option value="Sibling">Sibling</option>
                            <option value="Friend">Friend</option>
                            <option value="Pet Owner">Pet Owner</option>
                            <option value="Pet">Pet</option>
                          </select>

                          <span className="text-xs text-slate-400">of</span>

                          <select
                            value={relation.toMemberId}
                            onChange={(e) =>
                              handleUpdateRelation(member.id, relationIdx, {
                                toMemberId: e.target.value,
                              })
                            }
                            className="flex-1 p-1.5 bg-white border border-slate-200 rounded text-xs outline-none focus:ring-1 focus:ring-indigo-500"
                          >
                            <option value="">Select a member...</option>
                            {familyTree
                              .filter((m) => m.id !== member.id)
                              .map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.name || 'Unnamed'} ({m.memberType === 'pet' ? 'Pet' : 'Person'})
                                </option>
                              ))}
                          </select>

                          <button
                            onClick={() => handleRemoveRelation(member.id, relationIdx)}
                            className="text-slate-300 hover:text-rose-500 transition-colors text-lg"
                            title="Remove relationship"
                          >
                            &times;
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
