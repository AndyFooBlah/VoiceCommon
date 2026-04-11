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
 * External search helpers for BiographyBot.
 *
 * Provides client-side search functions that the AI can call during live
 * sessions to look up contextual information:
 *   - searchWikipedia: Wikipedia REST API (no key required)
 *   - searchPlace: Google Geocoding API
 *   - getDistanceBetweenPlaces: straight-line distance via Haversine
 *
 * GitHub Issues: #101 (Wikipedia), #102 (Google Maps)
 */

// ---------------------------------------------------------------------------
// Wikipedia (#101)
// ---------------------------------------------------------------------------

/**
 * Look up a Wikipedia article summary by search query.
 * Returns a short paragraph suitable for inclusion in a tool response.
 */
export async function searchWikipedia(query: string): Promise<string> {
  try {
    // Try direct page summary first (fastest path — works when query matches a title)
    const encoded = encodeURIComponent(query.trim());
    const summaryResp = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`,
      { headers: { Accept: 'application/json' } },
    );
    if (summaryResp.ok) {
      const data = await summaryResp.json();
      if (data.extract) {
        // Truncate to ~500 chars to keep the tool response concise
        const excerpt = data.extract.length > 500
          ? `${data.extract.slice(0, 500).trimEnd()}…`
          : data.extract;
        return `${data.title}: ${excerpt}`;
      }
    }

    // Fall back to full-text search
    const searchResp = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encoded}&format=json&origin=*&srlimit=1`,
    );
    if (!searchResp.ok) return `No Wikipedia results found for "${query}".`;
    const searchData = await searchResp.json();
    const firstHit = searchData.query?.search?.[0];
    if (!firstHit) return `No Wikipedia article found for "${query}".`;

    // Fetch the summary of the top search result
    const titleEncoded = encodeURIComponent(firstHit.title);
    const topSummaryResp = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${titleEncoded}`,
      { headers: { Accept: 'application/json' } },
    );
    if (topSummaryResp.ok) {
      const data = await topSummaryResp.json();
      if (data.extract) {
        const excerpt = data.extract.length > 500
          ? `${data.extract.slice(0, 500).trimEnd()}…`
          : data.extract;
        return `${data.title}: ${excerpt}`;
      }
    }

    // Last resort: return the search snippet (HTML-stripped)
    return firstHit.snippet.replace(/<[^>]+>/g, '');
  } catch (err) {
    console.warn('[Wikipedia] Search error:', err);
    return `Wikipedia search unavailable at this time.`;
  }
}

// ---------------------------------------------------------------------------
// Google Maps — Geocoding + distance (#102)
// ---------------------------------------------------------------------------

interface GeoResult {
  formattedAddress: string;
  lat: number;
  lng: number;
}

async function geocode(query: string): Promise<GeoResult | null> {
  const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!key) return null;

  const encoded = encodeURIComponent(query.trim());
  const resp = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encoded}&key=${key}`,
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  if (data.status !== 'OK' || !data.results?.length) return null;

  const result = data.results[0];
  return {
    formattedAddress: result.formatted_address,
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
  };
}

/** Haversine great-circle distance in miles. */
function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

/**
 * Look up a place by name and return its formatted address and coordinates.
 */
export async function searchPlace(query: string): Promise<string> {
  if (!import.meta.env.VITE_GOOGLE_MAPS_API_KEY) {
    return `Maps search is not configured (no API key). Cannot look up "${query}".`;
  }
  try {
    const result = await geocode(query);
    if (!result) return `No location found for "${query}".`;
    return `${result.formattedAddress} (coordinates: ${result.lat.toFixed(4)}, ${result.lng.toFixed(4)})`;
  } catch (err) {
    console.warn('[Maps] searchPlace error:', err);
    return `Maps search unavailable at this time.`;
  }
}

/**
 * Calculate the straight-line distance between two named places.
 */
export async function getDistanceBetweenPlaces(placeA: string, placeB: string): Promise<string> {
  if (!import.meta.env.VITE_GOOGLE_MAPS_API_KEY) {
    return `Maps search is not configured (no API key). Cannot calculate distance between "${placeA}" and "${placeB}".`;
  }
  try {
    const [geoA, geoB] = await Promise.all([geocode(placeA), geocode(placeB)]);
    if (!geoA) return `Could not find location for "${placeA}".`;
    if (!geoB) return `Could not find location for "${placeB}".`;

    const miles = haversineDistance(geoA.lat, geoA.lng, geoB.lat, geoB.lng);
    const km = miles * 1.60934;
    return `${geoA.formattedAddress} to ${geoB.formattedAddress}: approximately ${Math.round(miles)} miles (${Math.round(km)} km) as the crow flies.`;
  } catch (err) {
    console.warn('[Maps] getDistanceBetweenPlaces error:', err);
    return `Maps distance lookup unavailable at this time.`;
  }
}
