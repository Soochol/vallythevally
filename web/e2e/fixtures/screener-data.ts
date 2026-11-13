import type { Screen } from "../../src/api/generated/Screen";
import type { ScreenerResult } from "../../src/api/generated/ScreenerResult";
import type { ScreenerStatus } from "../../src/api/generated/ScreenerStatus";

type FixtureSet = { status: ScreenerStatus; results: Record<"all" | "high60" | "traded" | "current", { screen: Screen; result: ScreenerResult }> };

export const screenerFixtures = {
  "conditions": {
    "results": {
      "all": {
        "result": {
          "asOf": "2026-11-06",
          "collectionCompletedAt": 1793964618,
          "collectionStartedAt": 1793964617,
          "excluded": {
            "historyShort": 0,
            "listedTooShort": 0,
            "unconfirmed": 0
          },
          "missingSummary": 0,
          "rows": [
            {
              "changeRate": 0.25,
              "close": 61350.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상전자",
              "provisional": false,
              "symbol": "110010"
            },
            {
              "changeRate": 0.24,
              "close": 31650.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상화학",
              "provisional": false,
              "symbol": "110020"
            },
            {
              "changeRate": 0.23,
              "close": 54375.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상분할",
              "provisional": false,
              "symbol": "110030"
            },
            {
              "changeRate": 0.22,
              "close": 44800.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상전자우",
              "provisional": false,
              "symbol": "110035"
            },
            {
              "changeRate": 0.22,
              "close": 9020.0,
              "latestBarDate": "2026-10-23",
              "matchedDate": "2026-11-06",
              "name": "가상정지",
              "provisional": false,
              "symbol": "110040"
            },
            {
              "changeRate": -0.21,
              "close": 3322.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상관리",
              "provisional": false,
              "symbol": "110050"
            },
            {
              "changeRate": -0.23,
              "close": 37871.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상200",
              "provisional": false,
              "symbol": "110060"
            },
            {
              "changeRate": -0.23,
              "close": 5240.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상리츠",
              "provisional": false,
              "symbol": "110070"
            },
            {
              "changeRate": -0.25,
              "close": 2035.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상기업인수목적1호",
              "provisional": false,
              "symbol": "110080"
            },
            {
              "changeRate": 0.25,
              "close": 20300.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상신규",
              "provisional": false,
              "symbol": "110090"
            },
            {
              "changeRate": 0.0,
              "close": 11000.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상교차급증",
              "provisional": false,
              "symbol": "120010"
            },
            {
              "changeRate": 0.0,
              "close": 11000.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상코스닥교차",
              "provisional": false,
              "symbol": "120020"
            },
            {
              "changeRate": 0.0,
              "close": 10000.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상횡보",
              "provisional": false,
              "symbol": "120030"
            },
            {
              "changeRate": 0.0,
              "close": 11000.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상거래한산",
              "provisional": false,
              "symbol": "120040"
            },
            {
              "changeRate": 0.0,
              "close": 11000.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상전고점",
              "provisional": false,
              "symbol": "120050"
            },
            {
              "changeRate": 0.0,
              "close": 11000.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상시총미달",
              "provisional": false,
              "symbol": "120060"
            }
          ],
          "universe": 16
        },
        "screen": {
          "conditions": [],
          "exclude": [],
          "id": "all",
          "markets": [],
          "name": "all"
        }
      },
      "current": {
        "result": {
          "asOf": "2026-11-06",
          "collectionCompletedAt": 1793964618,
          "collectionStartedAt": 1793964618,
          "excluded": {
            "historyShort": 0,
            "listedTooShort": 0,
            "unconfirmed": 0
          },
          "missingSummary": 0,
          "rows": [
            {
              "changeRate": 0.25,
              "close": 61350.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상전자",
              "provisional": false,
              "symbol": "110010"
            },
            {
              "changeRate": 0.24,
              "close": 31650.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상화학",
              "provisional": false,
              "symbol": "110020"
            },
            {
              "changeRate": 0.23,
              "close": 54375.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상분할",
              "provisional": false,
              "symbol": "110030"
            },
            {
              "changeRate": 0.22,
              "close": 44800.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상전자우",
              "provisional": false,
              "symbol": "110035"
            },
            {
              "changeRate": -0.21,
              "close": 3322.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상관리",
              "provisional": false,
              "symbol": "110050"
            },
            {
              "changeRate": -0.23,
              "close": 37871.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상200",
              "provisional": false,
              "symbol": "110060"
            },
            {
              "changeRate": -0.23,
              "close": 5240.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상리츠",
              "provisional": false,
              "symbol": "110070"
            },
            {
              "changeRate": -0.25,
              "close": 2035.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상기업인수목적1호",
              "provisional": false,
              "symbol": "110080"
            },
            {
              "changeRate": 0.25,
              "close": 20300.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상신규",
              "provisional": false,
              "symbol": "110090"
            },
            {
              "changeRate": 0.0,
              "close": 11000.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상교차급증",
              "provisional": false,
              "symbol": "120010"
            },
            {
              "changeRate": 0.0,
              "close": 11000.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상코스닥교차",
              "provisional": false,
              "symbol": "120020"
            },
            {
              "changeRate": 0.0,
              "close": 10000.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상횡보",
              "provisional": false,
              "symbol": "120030"
            },
            {
              "changeRate": 0.0,
              "close": 11000.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상거래한산",
              "provisional": false,
              "symbol": "120040"
            },
            {
              "changeRate": 0.0,
              "close": 11000.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상전고점",
              "provisional": false,
              "symbol": "120050"
            },
            {
              "changeRate": 0.0,
              "close": 11000.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상시총미달",
              "provisional": false,
              "symbol": "120060"
            },
            {
              "changeRate": 0.22,
              "close": 9020.0,
              "latestBarDate": "2026-10-23",
              "matchedDate": "2026-10-23",
              "name": "가상정지",
              "provisional": false,
              "symbol": "110040"
            }
          ],
          "universe": 16
        },
        "screen": {
          "conditions": [
            {
              "field": "close",
              "kind": "new_high",
              "n": 1,
              "period": "D",
              "recentBars": 1
            }
          ],
          "exclude": [],
          "id": "current",
          "markets": [],
          "name": "current"
        }
      },
      "high60": {
        "result": {
          "asOf": "2026-11-06",
          "collectionCompletedAt": 1793964618,
          "collectionStartedAt": 1793964618,
          "excluded": {
            "historyShort": 0,
            "listedTooShort": 1,
            "unconfirmed": 0
          },
          "missingSummary": 0,
          "rows": [
            {
              "changeRate": 0.23,
              "close": 54375.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상분할",
              "provisional": false,
              "symbol": "110030"
            },
            {
              "changeRate": 0.22,
              "close": 44800.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상전자우",
              "provisional": false,
              "symbol": "110035"
            },
            {
              "changeRate": 0.0,
              "close": 11000.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상교차급증",
              "provisional": false,
              "symbol": "120010"
            },
            {
              "changeRate": 0.0,
              "close": 11000.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상코스닥교차",
              "provisional": false,
              "symbol": "120020"
            },
            {
              "changeRate": 0.0,
              "close": 10000.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상횡보",
              "provisional": false,
              "symbol": "120030"
            },
            {
              "changeRate": 0.0,
              "close": 11000.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상거래한산",
              "provisional": false,
              "symbol": "120040"
            },
            {
              "changeRate": 0.0,
              "close": 11000.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상전고점",
              "provisional": false,
              "symbol": "120050"
            },
            {
              "changeRate": 0.0,
              "close": 11000.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상시총미달",
              "provisional": false,
              "symbol": "120060"
            },
            {
              "changeRate": 0.22,
              "close": 9020.0,
              "latestBarDate": "2026-10-23",
              "matchedDate": "2026-10-23",
              "name": "가상정지",
              "provisional": false,
              "symbol": "110040"
            },
            {
              "changeRate": -0.21,
              "close": 3322.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-10-19",
              "name": "가상관리",
              "provisional": false,
              "symbol": "110050"
            }
          ],
          "universe": 15
        },
        "screen": {
          "conditions": [
            {
              "field": "high",
              "kind": "new_high",
              "n": 60,
              "period": "D",
              "recentBars": 20
            }
          ],
          "exclude": [
            "etf"
          ],
          "id": "high60",
          "markets": [],
          "name": "high60"
        }
      },
      "traded": {
        "result": {
          "asOf": "2026-11-06",
          "collectionCompletedAt": 1793964618,
          "collectionStartedAt": 1793964618,
          "excluded": {
            "historyShort": 0,
            "listedTooShort": 1,
            "unconfirmed": 0
          },
          "missingSummary": 0,
          "rows": [
            {
              "changeRate": 0.23,
              "close": 54375.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상분할",
              "provisional": false,
              "symbol": "110030"
            },
            {
              "changeRate": 0.22,
              "close": 44800.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상전자우",
              "provisional": false,
              "symbol": "110035"
            },
            {
              "changeRate": 0.0,
              "close": 11000.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상거래한산",
              "provisional": false,
              "symbol": "120040"
            }
          ],
          "universe": 16
        },
        "screen": {
          "conditions": [
            {
              "field": "traded_value",
              "kind": "new_high",
              "n": 60,
              "period": "D",
              "recentBars": 1
            }
          ],
          "exclude": [],
          "id": "traded",
          "markets": [],
          "name": "traded"
        }
      }
    },
    "status": {
      "fullHistory": {
        "done": 16,
        "total": 16
      },
      "lastDay": "2026-11-06",
      "needDay": "2026-11-05",
      "todayAvailable": false,
      "unconfirmed": 0,
      "update": null
    }
  },
  "sample": {
    "results": {
      "all": {
        "result": {
          "asOf": "2026-11-06",
          "collectionCompletedAt": 1793964609,
          "collectionStartedAt": 1793964609,
          "excluded": {
            "historyShort": 0,
            "listedTooShort": 0,
            "unconfirmed": 0
          },
          "missingSummary": 0,
          "rows": [
            {
              "changeRate": 0.25,
              "close": 61350.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상전자",
              "provisional": false,
              "symbol": "110010"
            },
            {
              "changeRate": 0.24,
              "close": 31650.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상화학",
              "provisional": false,
              "symbol": "110020"
            },
            {
              "changeRate": 0.23,
              "close": 54375.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상분할",
              "provisional": false,
              "symbol": "110030"
            },
            {
              "changeRate": 0.22,
              "close": 44800.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상전자우",
              "provisional": false,
              "symbol": "110035"
            },
            {
              "changeRate": 0.22,
              "close": 9020.0,
              "latestBarDate": "2026-10-23",
              "matchedDate": "2026-11-06",
              "name": "가상정지",
              "provisional": false,
              "symbol": "110040"
            },
            {
              "changeRate": -0.21,
              "close": 3322.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상관리",
              "provisional": false,
              "symbol": "110050"
            },
            {
              "changeRate": -0.23,
              "close": 37871.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상200",
              "provisional": false,
              "symbol": "110060"
            },
            {
              "changeRate": -0.23,
              "close": 5240.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상리츠",
              "provisional": false,
              "symbol": "110070"
            },
            {
              "changeRate": -0.25,
              "close": 2035.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상기업인수목적1호",
              "provisional": false,
              "symbol": "110080"
            },
            {
              "changeRate": 0.25,
              "close": 20300.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상신규",
              "provisional": false,
              "symbol": "110090"
            }
          ],
          "universe": 10
        },
        "screen": {
          "conditions": [],
          "exclude": [],
          "id": "all",
          "markets": [],
          "name": "all"
        }
      },
      "current": {
        "result": {
          "asOf": "2026-11-06",
          "collectionCompletedAt": 1793964610,
          "collectionStartedAt": 1793964610,
          "excluded": {
            "historyShort": 0,
            "listedTooShort": 0,
            "unconfirmed": 0
          },
          "missingSummary": 0,
          "rows": [
            {
              "changeRate": 0.25,
              "close": 61350.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상전자",
              "provisional": false,
              "symbol": "110010"
            },
            {
              "changeRate": 0.24,
              "close": 31650.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상화학",
              "provisional": false,
              "symbol": "110020"
            },
            {
              "changeRate": 0.23,
              "close": 54375.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상분할",
              "provisional": false,
              "symbol": "110030"
            },
            {
              "changeRate": 0.22,
              "close": 44800.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상전자우",
              "provisional": false,
              "symbol": "110035"
            },
            {
              "changeRate": -0.21,
              "close": 3322.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상관리",
              "provisional": false,
              "symbol": "110050"
            },
            {
              "changeRate": -0.23,
              "close": 37871.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상200",
              "provisional": false,
              "symbol": "110060"
            },
            {
              "changeRate": -0.23,
              "close": 5240.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상리츠",
              "provisional": false,
              "symbol": "110070"
            },
            {
              "changeRate": -0.25,
              "close": 2035.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상기업인수목적1호",
              "provisional": false,
              "symbol": "110080"
            },
            {
              "changeRate": 0.25,
              "close": 20300.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상신규",
              "provisional": false,
              "symbol": "110090"
            },
            {
              "changeRate": 0.22,
              "close": 9020.0,
              "latestBarDate": "2026-10-23",
              "matchedDate": "2026-10-23",
              "name": "가상정지",
              "provisional": false,
              "symbol": "110040"
            }
          ],
          "universe": 10
        },
        "screen": {
          "conditions": [
            {
              "field": "close",
              "kind": "new_high",
              "n": 1,
              "period": "D",
              "recentBars": 1
            }
          ],
          "exclude": [],
          "id": "current",
          "markets": [],
          "name": "current"
        }
      },
      "high60": {
        "result": {
          "asOf": "2026-11-06",
          "collectionCompletedAt": 1793964610,
          "collectionStartedAt": 1793964609,
          "excluded": {
            "historyShort": 0,
            "listedTooShort": 1,
            "unconfirmed": 0
          },
          "missingSummary": 0,
          "rows": [
            {
              "changeRate": 0.23,
              "close": 54375.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상분할",
              "provisional": false,
              "symbol": "110030"
            },
            {
              "changeRate": 0.22,
              "close": 44800.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상전자우",
              "provisional": false,
              "symbol": "110035"
            },
            {
              "changeRate": 0.22,
              "close": 9020.0,
              "latestBarDate": "2026-10-23",
              "matchedDate": "2026-10-23",
              "name": "가상정지",
              "provisional": false,
              "symbol": "110040"
            },
            {
              "changeRate": -0.21,
              "close": 3322.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-10-19",
              "name": "가상관리",
              "provisional": false,
              "symbol": "110050"
            }
          ],
          "universe": 9
        },
        "screen": {
          "conditions": [
            {
              "field": "high",
              "kind": "new_high",
              "n": 60,
              "period": "D",
              "recentBars": 20
            }
          ],
          "exclude": [
            "etf"
          ],
          "id": "high60",
          "markets": [],
          "name": "high60"
        }
      },
      "traded": {
        "result": {
          "asOf": "2026-11-06",
          "collectionCompletedAt": 1793964610,
          "collectionStartedAt": 1793964610,
          "excluded": {
            "historyShort": 0,
            "listedTooShort": 1,
            "unconfirmed": 0
          },
          "missingSummary": 0,
          "rows": [
            {
              "changeRate": 0.23,
              "close": 54375.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상분할",
              "provisional": false,
              "symbol": "110030"
            },
            {
              "changeRate": 0.22,
              "close": 44800.0,
              "latestBarDate": "2026-11-06",
              "matchedDate": "2026-11-06",
              "name": "가상전자우",
              "provisional": false,
              "symbol": "110035"
            }
          ],
          "universe": 10
        },
        "screen": {
          "conditions": [
            {
              "field": "traded_value",
              "kind": "new_high",
              "n": 60,
              "period": "D",
              "recentBars": 1
            }
          ],
          "exclude": [],
          "id": "traded",
          "markets": [],
          "name": "traded"
        }
      }
    },
    "status": {
      "fullHistory": {
        "done": 10,
        "total": 10
      },
      "lastDay": "2026-11-06",
      "needDay": "2026-11-05",
      "todayAvailable": false,
      "unconfirmed": 0,
      "update": null
    }
  }
} satisfies { sample: FixtureSet; conditions: FixtureSet };
