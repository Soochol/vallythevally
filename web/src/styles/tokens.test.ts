import { describe, expect, it } from "vitest";
import { THEMES } from "../persist/theme";
import tokensCss from "./tokens.css?raw";
import { contrastRatio, deltaE2000, over, parseColor, parseThemeProperties, type Rgba } from "./colorMath";

const MIN_TEXT_CONTRAST = 4.5;
const MIN_SERIES_DISTANCE = 14;

const TEXT_TOKENS = ["--text", "--text-name", "--text-price", "--text-2", "--up", "--down", "--danger", "--warning", "--success", "--accent"] as const;

const CHIP_TEXT_PAIRS = [
  ["--on-data", "--up"],
  ["--on-data", "--down"],
  ["--on-data", "--accent"],
  ["--on-data", "--draw"],
  ["--accent-ink", "--accent"],
] as const;

const SERIES = Array.from({ length: 10 }, (_, index) => `--series-${index + 1}`);
const SERIES_NEIGHBOURS = ["--up", "--down", "--danger", "--warning", "--success", "--accent"] as const;

for (const theme of THEMES) {
  const tokens = parseThemeProperties(tokensCss, theme);

  const token = (name: string): string => {
    const value = tokens.get(name);
    if (value === undefined) throw new Error(`${name}이 tokens.css(${theme})에 없다`);
    return value;
  };

  const color = (name: string): Rgba => parseColor(token(name));

  const surfaces = {
    "--bg": color("--bg"),
    "--surface": color("--surface"),
    "--raised": color("--raised"),
    "--glass-solid": color("--glass-solid"),
    "--glass(--bg 위)": over(color("--glass"), color("--bg")),
  } as const;

  const windowAndPickedSurfaces = Object.entries(surfaces) as [string, Rgba][];
  const ratio = (foreground: string, background: Rgba): number => contrastRatio(color(foreground), background);

  describe(`[${theme}] 글자·바탕 대비`, () => {
    it("흐린 글자가 창 바탕과 고른 면 위에서 4.5:1 이상이다", () => {
      for (const [surface, background] of windowAndPickedSurfaces) {
        expect(ratio("--text-3", background), `${theme} --text-3 × ${surface}`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      }
    });

    it("본문·강조·방향·상태 글자가 창 바탕, 올린 면, 고른 면, 유리 면 위에서 4.5:1 이상이다", () => {
      for (const name of TEXT_TOKENS) {
        for (const [surface, background] of windowAndPickedSurfaces) {
          expect(ratio(name, background), `${theme} ${name} × ${surface}`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        }
      }
    });

    it("색 칩 위 글자가 4.5:1 이상이다", () => {
      for (const [foreground, background] of CHIP_TEXT_PAIRS) {
        expect(contrastRatio(color(foreground), color(background)), `${theme} ${foreground} × ${background}`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      }
    });

    it("흐린 글자는 --overlay와 고른 줄(--accent-soft) 위에서 4.5:1 미만이라 쌍에 넣지 않고 --text-2를 쓴다", () => {
      const picked = over(color("--accent-soft"), color("--surface"));
      for (const [surface, background] of [["--overlay", color("--overlay")], ["--accent-soft(--surface 위)", picked]] as const) {
        expect(ratio("--text-3", background), `${theme} --text-3 × ${surface}`).toBeLessThan(MIN_TEXT_CONTRAST);
        expect(ratio("--text-2", background), `${theme} --text-2 × ${surface}`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      }
    });
  });

  describe(`[${theme}] 범주색 열 --series-1~10`, () => {
    it("열 개가 모두 정의돼 있다", () => {
      for (const name of SERIES) expect(tokens.has(name), `${theme} ${name}`).toBe(true);
    });

    it("서로 ΔE00 14 이상 떨어진다", () => {
      for (const [index, first] of SERIES.entries()) {
        for (const second of SERIES.slice(index + 1)) {
          expect(deltaE2000(color(first), color(second)), `${theme} ${first} × ${second}`).toBeGreaterThanOrEqual(MIN_SERIES_DISTANCE);
        }
      }
    });

    it("--up·--down·--danger·--warning·--success·--accent와 ΔE00 14 이상 떨어진다", () => {
      for (const name of SERIES) {
        for (const neighbour of SERIES_NEIGHBOURS) {
          expect(deltaE2000(color(name), color(neighbour)), `${theme} ${name} × ${neighbour}`).toBeGreaterThanOrEqual(MIN_SERIES_DISTANCE);
        }
      }
    });

    it("창 바탕 --bg 위에서 4.5:1 이상이다", () => {
      for (const name of SERIES) expect(ratio(name, surfaces["--bg"]), `${theme} ${name}`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    });
  });

  describe(`[${theme}] 드로잉 기본색 --draw`, () => {
    const neighbours = ["--accent", "--up", "--down", ...[..."abcdefghij"].map((letter) => `--link-${letter}`), ...[1, 2, 3, 4, 5].map((index) => `--ind-${index}`)];

    it("창 바탕 --bg 위에서 7:1 이상이다", () => {
      expect(ratio("--draw", surfaces["--bg"]), theme).toBeGreaterThanOrEqual(7);
    });

    it("강조색·방향색·연동색·지표색과 ΔE00 14 이상 떨어진다", () => {
      for (const neighbour of neighbours) {
        expect(deltaE2000(color("--draw"), color(neighbour)), `${theme} --draw × ${neighbour}`).toBeGreaterThanOrEqual(MIN_SERIES_DISTANCE);
      }
    });

    it("강조색과 같은 값이 아니다", () => {
      expect(token("--draw").toLowerCase()).not.toBe(token("--accent").toLowerCase());
    });
  });

  describe(`[${theme}] 고른 면`, () => {
    const MIN_PICKED_SURFACE_CONTRAST = 1.2;
    const hoverOnSurface = over(color("--hover"), surfaces["--surface"]);

    it("고른 면 --raised가 --surface 위에서 1.2:1 이상으로 드러난다", () => {
      expect(contrastRatio(surfaces["--raised"], surfaces["--surface"]), theme).toBeGreaterThanOrEqual(MIN_PICKED_SURFACE_CONTRAST);
    });

    it("--surface 위 --hover 면의 대비가 고른 면 --raised의 대비보다 낮아 가리킨 줄이 고른 줄보다 먼저 드러나지 않는다", () => {
      expect(contrastRatio(hoverOnSurface, surfaces["--surface"]), theme).toBeLessThan(contrastRatio(surfaces["--raised"], surfaces["--surface"]));
    });

    it("오류색 --danger가 상승색 --up과 ΔE00 14 이상 떨어진다", () => {
      expect(deltaE2000(color("--danger"), color("--up")), theme).toBeGreaterThanOrEqual(MIN_SERIES_DISTANCE);
    });
  });
}

describe("공통 치수 토큰", () => {
  const rootTokens = parseThemeProperties(tokensCss, "dark");
  const token = (name: string): string => {
    const value = rootTokens.get(name);
    if (value === undefined) throw new Error(`${name}이 tokens.css에 없다`);
    return value;
  };

  it("조밀 밀도에서 --row-h가 28px이고 기본은 34px이다", () => {
    expect(token("--row-h")).toBe("34px");
    expect(tokensCss).toMatch(/\[data-density="compact"\]\s*\{[^}]*--row-h:\s*28px/);
  });

  it("스위스 에디토리얼 모서리와 간격·조작부 높이가 규격과 일치한다", () => {
    expect(["--r-s", "--r-m", "--r-l", "--r-pill"].map(token)).toEqual(["2px", "2px", "0px", "2px"]);
    expect(["--s1", "--s2", "--island-gap"].map(token)).toEqual(["2px", "4px", "6px"]);
    expect(["--ctl-xs", "--ctl-s", "--ctl-m", "--ctl-l"].map(token)).toEqual(["22px", "26px", "30px", "36px"]);
  });

  it("소프트 벤토와 플로팅 글래스 조형·강조 토큰이 규격과 일치한다", () => {
    const bento = parseThemeProperties(tokensCss, "bento");
    expect(["--r-l", "--r-pill", "--island-gap", "--accent"].map((name) => bento.get(name))).toEqual(["16px", "999px", "10px", "#42E3A8"]);
    const glass = parseThemeProperties(tokensCss, "glass");
    expect(["--r-l", "--r-pill", "--glass-blur", "--accent"].map((name) => glass.get(name))).toEqual(["12px", "999px", "blur(22px)", "#B49BFF"]);
  });
});
