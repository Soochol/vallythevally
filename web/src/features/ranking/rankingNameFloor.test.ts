import { expect, test } from "vitest";
import { LIST_COLUMN_GAP } from "../list/listRow";
import { columnsFor, fitRankingColumns, rankingFixedWidth } from "./rankingColumns";
import { startRanking } from "./rankingChoices";
import { RANKING_KINDS } from "./rankingKinds";

const common = { market: "all", venue: "combined", excludes: { etfEtn: true, preferred: false }, excludeManaged: false } as const;
const NAME_FLOOR = 64;
const NARROW_WIDTHS = [160, 200, 220, 241];

test("순위 창이 좁아도 이름 칸은 64px 아래로 줄지 않는다", () => {
  for (const kind of RANKING_KINDS) {
    for (const width of NARROW_WIDTHS) {
      const columns = fitRankingColumns(kind, columnsFor(startRanking(kind, common)), width);
      const nameRoom = width - rankingFixedWidth - columns.reduce((sum, column) => sum + LIST_COLUMN_GAP + column.width, 0);
      expect({ kind, width, nameRoom: nameRoom >= NAME_FLOOR }).toEqual({ kind, width, nameRoom: true });
    }
  }
});
