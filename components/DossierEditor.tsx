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


import React from 'react';
import { Dossier, FamilyMember, PersonalityMode, InterviewQuestion } from '../types';

interface DossierEditorProps {
  dossier: Dossier;
  onChange: (dossier: Dossier) => void;
}

export const DossierEditor: React.FC<DossierEditorProps> = ({ dossier, onChange }) => {
  const addQuestion = () => {
    const newQ: InterviewQuestion = {
      id: Math.random().toString(36).substr(2, 9),
      text: '',
      status: 'Unasked',
      findings: ''
    };
    onChange({ ...dossier, questions: [...dossier.questions, newQ] });
  };

  const updateQuestion = (id: string, updates: Partial<InterviewQuestion>) => {
    onChange({
      ...dossier,
      questions: dossier.questions.map(q => q.id === id ? { ...q, ...updates } : q)
    });
  };

  const removeQuestion = (id: string) => {
    onChange({ ...dossier, questions: dossier.questions.filter(q => q.id !== id) });
  };

  const addMember = () => {
    onChange({ ...dossier, familyTree: [...dossier.familyTree, { name: '', relation: '' }] });
  };

  return (
    <div className="bg-white p-6 rounded-3xl h-full overflow-y-auto space-y-8 pb-24">
      <header className="border-b border-slate-100 pb-4">
        <h2 className="text-xl font-bold text-slate-800 flex items-center">
          <svg className="w-6 h-6 mr-2 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          Archivist Master Console
        </h2>
      </header>

      {/* Voice & Personality */}
      <section className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Interview Voice</label>
          <select 
            value={dossier.selectedVoice}
            onChange={(e) => onChange({...dossier, selectedVoice: e.target.value as any})}
            className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-sm"
          >
            <option value="Kore">Kore (Warm)</option>
            <option value="Zephyr">Zephyr (Bright)</option>
            <option value="Puck">Puck (Friendly)</option>
            <option value="Charon">Charon (Deep)</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Interviewer Style</label>
          <select 
            value={dossier.personality}
            onChange={(e) => onChange({...dossier, personality: e.target.value as PersonalityMode})}
            className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-sm"
          >
            <option value="empathetic">Empathetic Biographer</option>
            <option value="investigative">Oral Historian</option>
            <option value="casual">Close Grandchild</option>
          </select>
        </div>
      </section>

      {/* Question Queue */}
      <section className="space-y-4">
        <div className="flex justify-between items-center">
          <h3 className="font-bold text-slate-700">The Story Queue</h3>
          <button onClick={addQuestion} className="bg-indigo-600 text-white p-1.5 rounded-full hover:bg-indigo-700 shadow-sm">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
          </button>
        </div>
        
        <div className="space-y-4">
          {dossier.questions.map((q) => (
            <div key={q.id} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-3 relative group">
              <button onClick={() => removeQuestion(q.id)} className="absolute top-2 right-2 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">×</button>
              
              <div className="flex gap-2">
                <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full uppercase ${
                  q.status === 'Completed' ? 'bg-green-100 text-green-600' : 
                  q.status === 'InProgress' ? 'bg-amber-100 text-amber-600' : 'bg-slate-200 text-slate-500'
                }`}>
                  {q.status}
                </span>
                <select 
                  value={q.status}
                  onChange={(e) => updateQuestion(q.id, { status: e.target.value as any })}
                  className="bg-transparent text-[9px] text-slate-400 font-bold border-none p-0 outline-none"
                >
                  <option value="Unasked">Reset to Unasked</option>
                  <option value="InProgress">Mark In Progress</option>
                  <option value="Completed">Mark Completed</option>
                </select>
              </div>

              <textarea
                className="w-full bg-white p-2 border border-slate-200 rounded-xl text-sm outline-none focus:ring-1 focus:ring-indigo-500"
                placeholder="Story prompt (e.g. Tell me about your first job...)"
                rows={2}
                value={q.text}
                onChange={(e) => updateQuestion(q.id, { text: e.target.value })}
              />
              
              {q.findings && (
                <div className="bg-indigo-50/50 p-2 rounded-lg border border-indigo-100/50">
                  <p className="text-[10px] text-indigo-700 italic">Finding: {q.findings}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Family Tree */}
      <section className="space-y-4 border-t border-slate-50 pt-4">
        <div className="flex justify-between items-center">
          <h3 className="font-bold text-slate-700">Family Tree Context</h3>
          <button onClick={addMember} className="text-xs text-indigo-600 font-bold">+ Add Relative</button>
        </div>
        <div className="grid grid-cols-1 gap-2">
          {dossier.familyTree.map((member, idx) => (
            <div key={idx} className="flex gap-2">
              <input 
                className="flex-1 p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs"
                placeholder="Name" value={member.name}
                onChange={(e) => {
                  const nt = [...dossier.familyTree];
                  nt[idx].name = e.target.value;
                  onChange({...dossier, familyTree: nt});
                }}
              />
              <input 
                className="w-24 p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs"
                placeholder="Relation" value={member.relation}
                onChange={(e) => {
                  const nt = [...dossier.familyTree];
                  nt[idx].relation = e.target.value;
                  onChange({...dossier, familyTree: nt});
                }}
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
