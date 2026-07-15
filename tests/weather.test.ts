import { describe, it, expect } from "vitest";
import {
  describeWeatherCode,
  parseGeocodeResponse,
  locationLabel,
  formatWeatherReport,
  locationPromptSegment,
  type StoredLocation,
} from "../src/plugins/weather";

// Guards the pure helpers behind the weather plugin: WMO code mapping, the
// geocode parser, the report formatter, and the system-prompt segment. The
// plugin's tool wiring (enablement + tool names) is covered in
// tests/plugins.test.ts; the outbound fetch lives in the tool and is not
// exercised here (no network in the unit run).

describe("describeWeatherCode", () => {
  it("maps well-known WMO codes to readable text", () => {
    expect(describeWeatherCode(0)).toBe("clear sky");
    expect(describeWeatherCode(2)).toBe("partly cloudy");
    expect(describeWeatherCode(63)).toBe("moderate rain");
    expect(describeWeatherCode(95)).toBe("thunderstorm");
    expect(describeWeatherCode(99)).toBe("thunderstorm with heavy hail");
  });

  it("falls back for an unknown code rather than throwing", () => {
    expect(describeWeatherCode(1234)).toBe("unknown conditions");
    expect(describeWeatherCode(-1)).toBe("unknown conditions");
  });
});

describe("parseGeocodeResponse", () => {
  const hit = {
    name: "London",
    latitude: 51.5074,
    longitude: -0.1278,
    country_code: "GB",
    admin1: "England",
  };

  it("shapes the first geocode hit into a StoredLocation", () => {
    const out = parseGeocodeResponse({ results: [hit] }, "London");
    expect("error" in out).toBe(false);
    expect(out).toEqual({
      name: "London",
      latitude: 51.5074,
      longitude: -0.1278,
      countryCode: "GB",
      admin1: "England",
    });
  });

  it("tolerates missing admin/country fields", () => {
    const out = parseGeocodeResponse(
      {
        results: [
          { name: "Tokyo", latitude: 35.68, longitude: 139.69 },
        ],
      },
      "Tokyo",
    );
    expect("error" in out).toBe(false);
    expect((out as StoredLocation).countryCode).toBeUndefined();
    expect((out as StoredLocation).admin1).toBeUndefined();
  });

  it("returns a clean error when no results match", () => {
    const out = parseGeocodeResponse({ results: [] }, "zzznotaplace");
    expect("error" in out).toBe(true);
    expect((out as { error: string }).error).toContain("zzznotaplace");
  });

  it("returns a clean error on a missing/empty response", () => {
    expect("error" in parseGeocodeResponse({}, "x")).toBe(true);
    expect("error" in parseGeocodeResponse({ results: undefined }, "x")).toBe(
      true,
    );
  });
});

describe("locationLabel", () => {
  it("joins name, admin1 and country, dropping empties", () => {
    expect(
      locationLabel({
        name: "London",
        latitude: 0,
        longitude: 0,
        admin1: "England",
        countryCode: "GB",
      }),
    ).toBe("London, England, GB");
  });

  it("omits the empty segments", () => {
    expect(
      locationLabel({ name: "Tokyo", latitude: 0, longitude: 0 }),
    ).toBe("Tokyo");
  });
});

describe("formatWeatherReport", () => {
  const loc: StoredLocation = {
    name: "London",
    latitude: 51.5,
    longitude: -0.12,
    countryCode: "GB",
    admin1: "England",
  };

  it("builds a one-line summary and structured fields from current data", () => {
    const report = formatWeatherReport(loc, {
      temperature_2m: 14.4,
      apparent_temperature: 13.1,
      relative_humidity_2m: 70,
      weather_code: 2,
      wind_speed_10m: 18.7,
      is_day: 1,
    });
    expect(report.location).toBe("London, England, GB");
    expect(report.conditions).toBe("partly cloudy");
    expect(report.temperatureC).toBe(14.4);
    expect(report.feelsLikeC).toBe(13.1);
    expect(report.humidity).toBe(70);
    expect(report.windSpeed).toBe(18.7);
    // summary contains the rounded temperature and conditions
    expect(report.summary).toContain("14°C");
    expect(report.summary).toContain("partly cloudy");
    expect(report.summary).toContain("London, England, GB");
  });

  it("does not throw when fields are missing", () => {
    const report = formatWeatherReport(loc, { weather_code: 0 });
    expect(report.conditions).toBe("clear sky");
    expect(report.temperatureC).toBeUndefined();
    expect(report.summary).toContain("clear sky");
  });
});

describe("locationPromptSegment", () => {
  it("is empty when no location is set", () => {
    expect(locationPromptSegment(undefined)).toBe("");
    expect(locationPromptSegment(null)).toBe("");
  });

  it("names the saved location for the model", () => {
    const seg = locationPromptSegment({
      name: "London",
      latitude: 51.5,
      longitude: -0.12,
      countryCode: "GB",
      admin1: "England",
    });
    expect(seg).toContain("London, England, GB");
    expect(seg).toContain("saved location");
  });
});
