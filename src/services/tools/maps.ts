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
 * Maps tools for VoiceCommon.
 *
 * Provides place search and distance calculation using the Google Maps
 * Geocoding API. Results are returned as human-readable strings suitable
 * for use in voice conversation — no coordinates are exposed to the AI.
 *
 * Requires: VITE_GOOGLE_MAPS_API_KEY with Geocoding API enabled.
 */

import { FunctionDeclaration, Type } from '@google/genai';
import { getConfig } from '../config';

// ---------------------------------------------------------------------------
// Tool declarations
// ---------------------------------------------------------------------------

/** Gemini function declaration for place search. */
export const mapsTool: FunctionDeclaration = {
  name: 'searchPlace',
  description: 'Look up a location or address. Returns a description of where the place is. Use when the user mentions a specific location you want geographic context for.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'The place name or address to search for (e.g. "Eiffel Tower", "downtown Chicago", "Route 66").',
      },
    },
    required: ['query'],
  },
};

/** Gemini function declaration for distance calculation. */
export const distanceTool: FunctionDeclaration = {
  name: 'getDistanceBetweenPlaces',
  description: 'Calculate the straight-line distance between two places. Use when the user references how far apart two locations are.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      from: {
        type: Type.STRING,
        description: 'The starting location.',
      },
      to: {
        type: Type.STRING,
        description: 'The destination location.',
      },
    },
    required: ['from', 'to'],
  },
};

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

async function geocode(query: string): Promise<{ lat: number; lng: number; formatted: string } | null> {
  const MAPS_API_KEY = getConfig().mapsApiKey;
  if (!MAPS_API_KEY) return null;
  const res = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${MAPS_API_KEY}`,
  );
  const data = await res.json();
  if (data.status !== 'OK' || !data.results?.length) return null;
  const { lat, lng } = data.results[0].geometry.location;
  return { lat, lng, formatted: data.results[0].formatted_address };
}

/** Look up a place and return a human-readable description. */
export async function searchPlace(query: string): Promise<string> {
  if (!getConfig().mapsApiKey) return 'Maps information is not available (no API key configured).';
  try {
    const result = await geocode(query);
    if (!result) return `Could not find a location matching "${query}".`;
    return `"${query}" is located at ${result.formatted}.`;
  } catch (err) {
    return `Unable to look up that location: ${String(err)}`;
  }
}

/** Calculate the straight-line distance between two places. */
export async function getDistanceBetweenPlaces(from: string, to: string): Promise<string> {
  if (!getConfig().mapsApiKey) return 'Maps information is not available (no API key configured).';
  try {
    const [fromResult, toResult] = await Promise.all([geocode(from), geocode(to)]);
    if (!fromResult) return `Could not find a location matching "${from}".`;
    if (!toResult) return `Could not find a location matching "${to}".`;

    // Haversine formula for great-circle distance
    const R = 6371; // km
    const dLat = (toResult.lat - fromResult.lat) * Math.PI / 180;
    const dLng = (toResult.lng - fromResult.lng) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(fromResult.lat * Math.PI / 180) *
      Math.cos(toResult.lat * Math.PI / 180) *
      Math.sin(dLng / 2) ** 2;
    const distKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distMi = distKm * 0.621371;

    return (
      `${fromResult.formatted} to ${toResult.formatted} is approximately ` +
      `${Math.round(distMi)} miles (${Math.round(distKm)} km) in a straight line.`
    );
  } catch (err) {
    return `Unable to calculate distance: ${String(err)}`;
  }
}
