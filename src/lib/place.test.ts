import { describe, expect, it } from "vitest";
import { coordsText, placeName } from "./place";

describe("place line", () => {
  it("names the place from most to least specific, without repeats", () => {
    expect(placeName({ locality: "Rajkot", city: "Rajkot", principalSubdivision: "Gujarat", countryName: "India" })).toBe("Rajkot, Gujarat");
    expect(placeName({ countryName: "India" })).toBe("India");
    expect(coordsText({ lat: 22.291581, lon: 70.780723 })).toBe("22.29158, 70.78072");
  });
});
