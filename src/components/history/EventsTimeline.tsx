/**
 * EventsTimeline — displays extracted life events for a dossier.
 * Shows events in chronological order with themes, people, and source links.
 */

import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { StoryEvent } from '../../types';
import { getEvents } from '../../services/storage';

export const EventsTimeline: React.FC = () => {
  const { familyId, dossierId } = useParams<{ familyId: string; dossierId: string }>();
  const navigate = useNavigate();
  const [events, setEvents] = useState<StoryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterTheme, setFilterTheme] = useState<string | null>(null);

  useEffect(() => {
    if (!familyId || !dossierId) return;
    getEvents(familyId, dossierId)
      .then((evts) => {
        // Sort by date (events with dates first, then undated)
        evts.sort((a, b) => {
          if (!a.date && !b.date) return 0;
          if (!a.date) return 1;
          if (!b.date) return -1;
          return a.date.localeCompare(b.date);
        });
        setEvents(evts);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [familyId, dossierId]);

  // Collect all unique themes
  const allThemes = [...new Set(events.flatMap((e) => e.themes))].sort();

  const filteredEvents = filterTheme
    ? events.filter((e) => e.themes.includes(filterTheme))
    : events;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-8 space-y-6">
      <div>
        <button
          onClick={() => navigate(`/family/${familyId}/dossier/${dossierId}`)}
          className="text-sm text-indigo-600 font-medium hover:underline mb-1"
        >
          &larr; Back to Dossier
        </button>
        <h2 className="text-2xl font-bold text-slate-800">Life Events Timeline</h2>
        <p className="text-sm text-slate-400 mt-1">
          {events.length} event{events.length !== 1 ? 's' : ''} extracted from interview sessions
        </p>
      </div>

      {/* Theme filter */}
      {allThemes.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setFilterTheme(null)}
            className={`text-xs px-3 py-1 rounded-full font-medium transition-colors ${
              !filterTheme ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            All
          </button>
          {allThemes.map((theme) => (
            <button
              key={theme}
              onClick={() => setFilterTheme(theme === filterTheme ? null : theme)}
              className={`text-xs px-3 py-1 rounded-full font-medium transition-colors ${
                filterTheme === theme ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {theme}
            </button>
          ))}
        </div>
      )}

      {filteredEvents.length === 0 ? (
        <div className="text-center py-16 space-y-3">
          <p className="text-slate-400 text-lg">
            {events.length === 0
              ? 'No events extracted yet. Complete a session to generate events.'
              : 'No events match the selected filter.'}
          </p>
        </div>
      ) : (
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-slate-200" />

          <div className="space-y-6">
            {filteredEvents.map((event) => (
              <div key={event.id} className="relative pl-12">
                {/* Timeline dot */}
                <div className="absolute left-2.5 top-2 w-3 h-3 bg-indigo-600 rounded-full border-2 border-white" />

                <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-semibold text-slate-800">{event.title}</h3>
                    {event.date && (
                      <span className="text-xs font-medium text-slate-400 whitespace-nowrap">
                        {event.date}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-slate-600 leading-relaxed">{event.description}</p>

                  <div className="flex flex-wrap gap-2">
                    {event.themes.map((theme) => (
                      <span key={theme} className="text-[10px] font-medium bg-indigo-50 text-indigo-600 rounded-full px-2 py-0.5">
                        {theme}
                      </span>
                    ))}
                    {event.people.map((person) => (
                      <span key={person} className="text-[10px] font-medium bg-emerald-50 text-emerald-600 rounded-full px-2 py-0.5">
                        {person}
                      </span>
                    ))}
                    {event.location && (
                      <span className="text-[10px] font-medium bg-amber-50 text-amber-600 rounded-full px-2 py-0.5">
                        {event.location}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
