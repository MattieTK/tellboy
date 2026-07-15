import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { envFlag, type Plugin } from "./types";
import type { TellboyAgent } from "../agent";

// Open-Meteo is a free, key-less weather + geocoding API, so the weather
// plugin has no external credential and is on by default (force off with
// ENABLE_WEATHER=false). Docs:
//   geocoding: https://open-meteo.com/en/docs/geocoding-api
//   forecast:  https://open-meteo.com/en/docs (current weather)

const GEOCODE_ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast";

// A hanging external fetch would stall the chat turn (the stall watchdog
// would eventually recover it, but only after a long frozen-looking gap), so
// every outbound request here is bounded — fail fast and let the model reply.
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Durable-storage key for the user's saved location. Stored on the per-thread
 * sub-agent (so each chat can have its own place) and cached on the agent so
 * the synchronous `getSystemPrompt()` can surface it — see `agent.ts`.
 */
export const LOCATION_KEY = "location";

/**
 * A resolved, stored location: the place name the user gave, plus the
 * coordinates Open-Meteo geocoded it to (so `get_weather` can query the
 * forecast without re-geocoding every turn).
 */
export interface StoredLocation {
  name: string;
  latitude: number;
  longitude: number;
  /** ISO country code, when the geocoder returned one. */
  countryCode?: string;
  /** First administrative division (state/region), when the geocoder returned one. */
  admin1?: string;
}

interface GeocodeHit {
  name: string;
  latitude: number;
  longitude: number;
  country_code?: string;
  admin1?: string;
}
interface GeocodeResponse {
  results?: GeocodeHit[];
}

interface ForecastCurrent {
  time?: string;
  temperature_2m?: number;
  relative_humidity_2m?: number;
  apparent_temperature?: number;
  weather_code?: number;
  wind_speed_10m?: number;
  wind_direction_10m?: number;
  is_day?: number;
}
interface ForecastResponse {
  current?: ForecastCurrent;
}

/**
 * Map an Open-Meteo (WMO) weather code to a short human description. Pure so
 * it can be unit-tested without the network. Codes per the WMO interpretation
 * table used by Open-Meteo.
 */
export function describeWeatherCode(code: number): string {
  switch (code) {
    case 0:
      return "clear sky";
    case 1:
      return "mainly clear";
    case 2:
      return "partly cloudy";
    case 3:
      return "overcast";
    case 45:
      return "fog";
    case 48:
      return "depositing rime fog";
    case 51:
      return "light drizzle";
    case 53:
      return "moderate drizzle";
    case 55:
      return "dense drizzle";
    case 56:
      return "light freezing drizzle";
    case 57:
      return "dense freezing drizzle";
    case 61:
      return "slight rain";
    case 63:
      return "moderate rain";
    case 65:
      return "heavy rain";
    case 66:
      return "light freezing rain";
    case 67:
      return "heavy freezing rain";
    case 71:
      return "slight snowfall";
    case 73:
      return "moderate snowfall";
    case 75:
      return "heavy snowfall";
    case 77:
      return "snow grains";
    case 80:
      return "slight rain showers";
    case 81:
      return "moderate rain showers";
    case 82:
      return "violent rain showers";
    case 85:
      return "slight snow showers";
    case 86:
      return "heavy snow showers";
    case 95:
      return "thunderstorm";
    case 96:
      return "thunderstorm with slight hail";
    case 99:
      return "thunderstorm with heavy hail";
    default:
      return "unknown conditions";
  }
}

/**
 * Pick the best match from an Open-Meteo geocoding response and shape it into
 * a {@link StoredLocation}. Pure (no fetch) so it can be unit-tested: pass the
 * parsed JSON, get back a location or a clean `{ error }`.
 */
export function parseGeocodeResponse(
  data: GeocodeResponse,
  query: string,
): StoredLocation | { error: string } {
  const hit = data?.results?.[0];
  if (!hit) {
    return { error: `Could not find a place called "${query}".` };
  }
  return {
    name: hit.name,
    latitude: hit.latitude,
    longitude: hit.longitude,
    countryCode: hit.country_code,
    admin1: hit.admin1,
  };
}

/** A readable label for a stored location, e.g. "London, England, GB". */
export function locationLabel(loc: StoredLocation): string {
  return [loc.name, loc.admin1, loc.countryCode].filter(Boolean).join(", ");
}

/**
 * Format a current-weather observation into the structured object the
 * `get_weather` tool returns. Pure so the report shape can be unit-tested.
 */
export function formatWeatherReport(
  loc: StoredLocation,
  current: ForecastCurrent,
): {
  location: string;
  summary: string;
  temperatureC: number | undefined;
  feelsLikeC: number | undefined;
  humidity: number | undefined;
  windSpeed: number | undefined;
  conditions: string;
} {
  const conditions = describeWeatherCode(current.weather_code ?? -1);
  const label = locationLabel(loc);
  const parts: string[] = [`📍 ${label}`];
  if (current.temperature_2m !== undefined) {
    parts.push(`🌡️ ${Math.round(current.temperature_2m)}°C`);
  }
  if (current.apparent_temperature !== undefined) {
    parts.push(`feels like ${Math.round(current.apparent_temperature)}°C`);
  }
  parts.push(`${conditions}`);
  if (current.relative_humidity_2m !== undefined) {
    parts.push(`💧 ${current.relative_humidity_2m}%`);
  }
  if (current.wind_speed_10m !== undefined) {
    parts.push(`💨 ${Math.round(current.wind_speed_10m)} km/h`);
  }
  return {
    location: label,
    summary: parts.join(" · "),
    temperatureC: current.temperature_2m,
    feelsLikeC: current.apparent_temperature,
    humidity: current.relative_humidity_2m,
    windSpeed: current.wind_speed_10m,
    conditions,
  };
}

/**
 * The system-prompt segment that tells the model the user's saved location,
 * so it can answer "what's the weather?" naturally and use the place for other
 * location-aware requests. Returns the empty string when no location is set,
 * so the prompt getter can include it conditionally without adding noise.
 */
export function locationPromptSegment(loc?: StoredLocation | null): string {
  if (!loc) return "";
  return `The user's saved location is ${locationLabel(loc)}. Use it for weather and other location-aware requests unless they name a different place.`;
}

/**
 * Current weather + saved location, via the key-less Open-Meteo APIs. The user
 * sets their place once with `set_location`; thereafter `get_weather` reports
 * it without being asked for a place. `get_weather` also accepts an ad-hoc
 * place name, so "what's the weather in Paris?" works even before a location is
 * saved. No external dependency, so enabled by default; disable with
 * `ENABLE_WEATHER=false`.
 */
export const weatherPlugin: Plugin = {
  name: "weather",

  isEnabled(env) {
    return envFlag(env, "weather") ?? true;
  },

  tools(agent: TellboyAgent): ToolSet {
    return {
      set_location: tool({
        description:
          "Save the user's location so the bot can answer weather and other " +
          "location-aware questions without asking each time. Give the place " +
          "name (e.g. 'London', 'San Francisco, CA'). The bot geocodes it to " +
          "coordinates and stores it per-chat. Use this when the user tells you " +
          "where they are or where they live.",
        inputSchema: z.object({
          location: z
            .string()
            .min(2)
            .describe("The place to save, e.g. a city name or 'City, Region'."),
        }),
        execute: async ({ location }) => {
          try {
            const url = new URL(GEOCODE_ENDPOINT);
            url.searchParams.set("name", location);
            url.searchParams.set("count", "1");
            url.searchParams.set("language", "en");
            url.searchParams.set("format", "json");

            const response = await fetch(url, {
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!response.ok) {
              return {
                error: `Location lookup failed (HTTP ${response.status}).`,
              };
            }
            const data = (await response.json()) as GeocodeResponse;
            const parsed = parseGeocodeResponse(data, location);
            if ("error" in parsed) return parsed;

            await agent.setLocation(parsed);
            return { ok: true, location: locationLabel(parsed) };
          } catch (err) {
            const aborted = err instanceof Error && err.name === "TimeoutError";
            return {
              error: aborted
                ? "Location lookup timed out."
                : `Location lookup failed: ${String(err instanceof Error ? err.message : err)}`,
            };
          }
        },
      }),

      get_weather: tool({
        description:
          "Get the current weather. By default uses the user's saved " +
          "location; pass `location` to check the weather somewhere else " +
          "(it is geocoded on the fly). If the user has no saved location and " +
          "you don't pass one, ask them to set one first.",
        inputSchema: z.object({
          location: z
            .string()
            .min(2)
            .optional()
            .describe(
              "Optional place to check instead of the saved location, " +
                "e.g. 'Paris' or 'Tokyo, Japan'.",
            ),
        }),
        execute: async ({ location }) => {
          try {
            // Resolve a location: an explicit override, otherwise the saved one.
            let loc: StoredLocation | undefined;
            if (location) {
              const url = new URL(GEOCODE_ENDPOINT);
              url.searchParams.set("name", location);
              url.searchParams.set("count", "1");
              url.searchParams.set("language", "en");
              url.searchParams.set("format", "json");
              const geoRes = await fetch(url, {
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
              });
              if (!geoRes.ok) {
                return {
                  error: `Location lookup failed (HTTP ${geoRes.status}).`,
                };
              }
              const geoData = (await geoRes.json()) as GeocodeResponse;
              const parsed = parseGeocodeResponse(geoData, location);
              if ("error" in parsed) return parsed;
              loc = parsed;
            } else {
              loc = await agent.getLocation();
              if (!loc) {
                return {
                  error:
                    "No saved location. Ask the user where they are (or pass a " +
                    "place to get_weather), then use set_location to save it.",
                };
              }
            }

            const url = new URL(FORECAST_ENDPOINT);
            url.searchParams.set("latitude", String(loc.latitude));
            url.searchParams.set("longitude", String(loc.longitude));
            url.searchParams.set(
              "current",
              [
                "temperature_2m",
                "relative_humidity_2m",
                "apparent_temperature",
                "weather_code",
                "wind_speed_10m",
                "wind_direction_10m",
                "is_day",
              ].join(","),
            );

            const res = await fetch(url, {
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!res.ok) {
              return { error: `Weather lookup failed (HTTP ${res.status}).` };
            }
            const data = (await res.json()) as ForecastResponse;
            if (!data.current) {
              return { error: "Weather service returned no current data." };
            }
            return formatWeatherReport(loc, data.current);
          } catch (err) {
            const aborted = err instanceof Error && err.name === "TimeoutError";
            return {
              error: aborted
                ? "Weather lookup timed out."
                : `Weather lookup failed: ${String(err instanceof Error ? err.message : err)}`,
            };
          }
        },
      }),
    };
  },
};
