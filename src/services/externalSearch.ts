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
 *   - getJoke: JokeAPI v2 (no key required)
 *   - getWeather: Google Maps Platform Weather API
 *
 * GitHub Issues: #101 (Wikipedia), #102 (Google Maps), #105 (Jokes), #106 (Weather)
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
 * @public
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

// ---------------------------------------------------------------------------
// JokeAPI (#105)
// ---------------------------------------------------------------------------

/**
 * Fetch a random joke from JokeAPI v2.
 * Categories: Programming, Miscellaneous, Pun — all harmful content blacklisted.
 * Returns the joke as plain text (single line or two-liner joined by newline).
 */
export async function getJoke(): Promise<string> {
  try {
    const url =
      'https://v2.jokeapi.dev/joke/Programming,Miscellaneous,Pun' +
      '?blacklistFlags=nsfw,religious,political,racist,sexist,explicit&format=txt';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`JokeAPI responded with ${res.status}`);
    const text = await res.text();
    return text.trim() || 'Sorry, I couldn\'t think of a joke right now.';
  } catch (err) {
    console.warn('[JokeAPI] Error:', err);
    return `Joke unavailable at this time.`;
  }
}

// ---------------------------------------------------------------------------
// Google Maps Weather API (#106)
// ---------------------------------------------------------------------------

/**
 * Get current weather conditions and a 3-day forecast for a location.
 * Geocodes the location string, then queries the Google Maps Platform Weather API.
 */
export async function getWeather(location: string): Promise<string> {
  const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!key) {
    return `Weather lookup is not configured (no API key). Cannot check weather for "${location}".`;
  }
  try {
    const geo = await geocode(location);
    if (!geo) return `Could not find location "${location}" for weather lookup.`;

    const body = { location: { latitude: geo.lat, longitude: geo.lng } };

    const [currentRes, forecastRes] = await Promise.all([
      fetch(`https://weather.googleapis.com/v1/currentConditions:lookup?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      fetch(`https://weather.googleapis.com/v1/forecast/days:lookup?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, days: 3 }),
      }),
    ]);

    if (!currentRes.ok && !forecastRes.ok) {
      return `Weather data unavailable for "${location}" at this time.`;
    }

    let summary = `Weather for ${geo.formattedAddress}:`;

    if (currentRes.ok) {
      const current = await currentRes.json();
      const tempF = current.temperature?.degrees;
      const feelsF = current.feelsLikeTemperature?.degrees;
      const condition = current.weatherCondition?.description?.text ?? '';
      if (tempF != null) {
        const tempC = Math.round((tempF - 32) * 5 / 9);
        const feelsC = feelsF != null ? Math.round((feelsF - 32) * 5 / 9) : null;
        summary += ` Currently ${Math.round(tempF)}°F (${tempC}°C)`;
        if (feelsC != null && Math.abs(feelsF! - tempF) >= 3) {
          summary += `, feels like ${Math.round(feelsF!)}°F (${feelsC}°C)`;
        }
        if (condition) summary += `, ${condition.toLowerCase()}`;
        summary += '.';
      }
    }

    if (forecastRes.ok) {
      const forecast = await forecastRes.json();
      const days: any[] = forecast.forecastDays ?? [];
      if (days.length > 0) {
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const dayParts = days.slice(0, 3).map((d: any) => {
          const date = d.interval?.startTime ? new Date(d.interval.startTime) : null;
          const label = date ? dayNames[date.getDay()] : '?';
          const hi = d.maxTemperature?.degrees;
          const lo = d.minTemperature?.degrees;
          const cond = d.daytimeForecast?.weatherCondition?.description?.text ?? '';
          let part = label;
          if (hi != null && lo != null) part += ` ${Math.round(hi)}/${Math.round(lo)}°F`;
          if (cond) part += ` ${cond.toLowerCase()}`;
          return part;
        });
        summary += ` Next 3 days: ${dayParts.join(', ')}.`;
      }
    }

    return summary;
  } catch (err) {
    console.warn('[Weather] Error:', err);
    return `Weather lookup unavailable at this time.`;
  }
}
