import { describe, expect, it } from "vitest";
import { isoSeconds } from "../../scripts/duration";

describe("YouTube video lengths", () => {
  it("reads hours, minutes and seconds", () => {
    expect(isoSeconds("PT42M10S")).toBe(2530);
    expect(isoSeconds("PT1H2M3S")).toBe(3723);
    expect(isoSeconds("PT45S")).toBe(45);
    expect(isoSeconds("PT2H")).toBe(7200);
  });
  it("reads days, and gives 0 for live streams and nonsense", () => {
    expect(isoSeconds("P1DT1H")).toBe(90000);
    expect(isoSeconds("P0D")).toBe(0);
    expect(isoSeconds("")).toBe(0);
    expect(isoSeconds(undefined)).toBe(0);
    expect(isoSeconds("soon")).toBe(0);
  });
});
