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
 * Weather tool for VoiceCommon.
 *
 * Uses the Google Maps Geocoding API to resolve a location name to
 * coordinates, then the Google Maps Weather API to fetch current conditions.
 *
 * Requires: VITE_GOOGLE_MAPS_API_KEY with Geocoding API and Weather API enabled.
 */

import { FunctionDeclaration, Type } from '@google/genai';
import { getConfig } from '../config';

/** Gemini function declaration for the weather tool. */
export const weatherTool: FunctionDeclaration = {
  name: 'getWeather',
  description: 'Get the current weather for a location. Call this when the user asks about weather or mentions going somewhere.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      location: {
        type: Type.STRING,
        description: 'The city or place name to get weather for (e.g. "San Francisco", "Tokyo").',
      },
    },
    required: ['location'],
  },
};

/** Execute the weather tool. Returns a human-readable weather summary. */
export async function getWeather(location: string): Promise<string> {
  const MAPS_API_KEY = getConfig().mapsApiKey;
  if (!MAPS_API_KEY) return 'Weather information is not available (no API key configured).';

  try {
    // Geocode the location
    const geoRes = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${MAPS_API_KEY}`,
    );
    const geoData = await geoRes.json();
    if (geoData.status !== 'OK' || !geoData.results?.length) {
      return `Could not find the location "${location}".`;
    }
    const { lat, lng } = geoData.results[0].geometry.location;
    const formattedLocation = geoData.results[0].formatted_address;

    // Fetch weather using the Maps Weather API
    const weatherRes = await fetch(
      `https://weather.googleapis.com/v1/currentConditions:lookup?key=${MAPS_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location: { latitude: lat, longitude: lng } }),
      },
    );
    const weatherData = await weatherRes.json();
    if (!weatherRes.ok) {
      return `Could not retrieve weather for ${formattedLocation}.`;
    }

    const condition = weatherData.weatherCondition?.description?.text ?? 'Unknown conditions';
    const tempC = weatherData.temperature?.degrees;
    const tempF = tempC != null ? Math.round(tempC * 9 / 5 + 32) : null;
    const humidity = weatherData.relativeHumidity;
    const windKph = weatherData.wind?.speed?.value;

    const parts = [`Weather in ${formattedLocation}: ${condition}`];
    if (tempF != null) parts.push(`${tempF}°F (${Math.round(tempC!)}°C)`);
    if (humidity != null) parts.push(`humidity ${humidity}%`);
    if (windKph != null) parts.push(`wind ${Math.round(windKph)} km/h`);

    return parts.join(', ') + '.';
  } catch (err) {
    return `Unable to retrieve weather information: ${String(err)}`;
  }
}
