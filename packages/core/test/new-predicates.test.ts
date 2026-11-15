import { describe, expect, it } from "vitest";
import { compileQuery } from "../src/query/compile";
import { parseDsl } from "../src/query/parser";
import { registry } from "../src/registry";

const ctx = { orWindows: [1, 5, 10, 15, 30, 60], ibWindow: 60 };

describe("new predicates and features registry", () => {
  it("registers orgInto30m and orgAway30m", () => {
    const intoDef = registry.all.get("orgInto30m");
    expect(intoDef).toBeDefined();
    expect(intoDef?.kind).toBe("predicate");

    const awayDef = registry.all.get("orgAway30m");
    expect(awayDef).toBeDefined();
    expect(awayDef?.kind).toBe("predicate");

    const sqlInto = compileQuery(parseDsl("gapFill WHERE orgInto30m"), ctx);
    expect(sqlInto.whereSql).toContain("f.org_into_30m");

    const sqlAway = compileQuery(parseDsl("gapHold WHERE orgAway30m"), ctx);
    expect(sqlAway.whereSql).toContain("f.org_away_30m");
  });

  it("registers lunch sweep predicates", () => {
    const swH = registry.all.get("lunchSweptAmHigh");
    expect(swH).toBeDefined();
    expect(swH?.kind).toBe("predicate");

    const swL = registry.all.get("lunchSweptAmLow");
    expect(swL).toBeDefined();
    expect(swL?.kind).toBe("predicate");

    const swAny = registry.all.get("lunchSweptAm");
    expect(swAny).toBeDefined();
    expect(swAny?.kind).toBe("predicate");

    const q1 = compileQuery(parseDsl("closeGreen WHERE lunchSweptAmHigh"), ctx);
    expect(q1.whereSql).toContain("f.lunch_swept_am_high");

    const q2 = compileQuery(parseDsl("closeGreen WHERE lunchSweptAmLow"), ctx);
    expect(q2.whereSql).toContain("f.lunch_swept_am_low");

    const q3 = compileQuery(parseDsl("closeGreen WHERE lunchSweptAm"), ctx);
    expect(q3.whereSql).toContain("f.lunch_swept_am");
  });

  it("registers PM OR break predicates", () => {
    const single = registry.all.get("pmOrSingleBreak");
    expect(single).toBeDefined();
    expect(single?.kind).toBe("predicate");

    const dbl = registry.all.get("pmOrDoubleBreak");
    expect(dbl).toBeDefined();
    expect(dbl?.kind).toBe("predicate");

    const q1 = compileQuery(parseDsl("closeGreen WHERE pmOrSingleBreak"), ctx);
    expect(q1.whereSql).toContain("f.pm_or_single_break");

    const q2 = compileQuery(parseDsl("closeGreen WHERE pmOrSingleBreak('up')"), ctx);
    expect(q2.whereSql).toContain("f.or30_first_break = 'up'");

    const q3 = compileQuery(parseDsl("closeGreen WHERE pmOrDoubleBreak"), ctx);
    expect(q3.whereSql).toContain("f.pm_or_double_break");
  });

  it("registers newsWickBothSides predicate and numeric fields", () => {
    const news = registry.all.get("newsWickBothSides");
    expect(news).toBeDefined();
    expect(news?.kind).toBe("predicate");

    const q = compileQuery(parseDsl("closeGreen WHERE newsWickBothSides"), ctx);
    expect(q.whereSql).toContain("f.news_wick_both_sides");

    const fHigh = registry.all.get("news830High");
    expect(fHigh).toBeDefined();
    expect(fHigh?.kind).toBe("field");

    const fLow = registry.all.get("news830Low");
    expect(fLow).toBeDefined();
    expect(fLow?.kind).toBe("field");
  });

  it("supports 1m opening range window in compile context", () => {
    const q = compileQuery(parseDsl("orbBreak(1m, up) WHERE orbBroke(1m, down)"), ctx);
    expect(q.successSql).toContain("f.or1_first_break = 'up'");
    expect(q.whereSql).toContain("f.or1_first_break = 'down'");
  });

  it("registers new outcomes for PM break, news wick, and ORG", () => {
    const pmSingle = registry.all.get("pmBreakSingle");
    expect(pmSingle?.kind).toBe("outcome");
    const q1 = compileQuery(parseDsl("pmBreakSingle WHERE lunchSweptAm"), ctx);
    expect(q1.successSql).toContain("f.pm_or_single_break");
    expect(q1.whereSql).toContain("f.lunch_swept_am");

    const pmDouble = registry.all.get("pmBreakDouble");
    expect(pmDouble?.kind).toBe("outcome");
    const q2 = compileQuery(parseDsl("pmBreakDouble WHERE lunchSweptAm"), ctx);
    expect(q2.successSql).toContain("f.pm_or_double_break");

    const newsSwept = registry.all.get("newsSweptBothSides");
    expect(newsSwept?.kind).toBe("outcome");
    const q3 = compileQuery(parseDsl("newsSweptBothSides WHERE gapUp"), ctx);
    expect(q3.successSql).toContain("f.news_wick_both_sides");

    const orgRetr = registry.all.get("orgRetraced30m");
    expect(orgRetr?.kind).toBe("outcome");
    const q4 = compileQuery(parseDsl("orgRetraced30m WHERE gapUp"), ctx);
    expect(q4.successSql).toContain("f.org_into_30m");
  });
});
