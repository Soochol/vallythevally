import type { FinancialsPage } from "../../src/api/generated/FinancialsPage";

import type { FinancialUpdatePage } from "../../src/api/generated/FinancialUpdatePage";

export const readyData: Record<"Q" | "Y", FinancialsPage> = {
  "Q": {
    "symbol": "005930",
    "period": "Q",
    "status": "ready",
    "reason": null,
    "failure": null,
    "corpCode": "00126380",
    "fiscalMonth": 12,
    "shareClass": "보통주",
    "shareClassReason": null,
    "lastCheckedAt": 1514689212,
    "lastAttemptAt": 1514689212,
    "disclosureFailure": null,
    "refreshVersion": 1,
    "disclosureVersion": 1,
    "latestCorrections": true,
    "progress": {
      "total": 15,
      "completed": 15,
      "failed": 0,
      "pending": 0
    },
    "series": [
      {
        "metric": "revenue",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11013",
            "status": "available",
            "reason": null,
            "value": 100,
            "reportedValue": 100,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-03-31"
            },
            "priceBucket": 1420038000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11013",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "100",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150115000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689212,
                "lastSuccessAt": 1514689212,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11012",
            "status": "available",
            "reason": null,
            "value": 100,
            "reportedValue": 100,
            "period": {
              "kind": "duration",
              "start": "2015-04-01",
              "end": "2015-06-30"
            },
            "priceBucket": 1427814000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11012",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "100",
                "period": {
                  "kind": "duration",
                  "start": "2015-04-01",
                  "end": "2015-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150215000001",
                "disclosedAt": "2015-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689213,
                "lastSuccessAt": 1514689213,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11014",
            "status": "available",
            "reason": null,
            "value": 100,
            "reportedValue": 100,
            "period": {
              "kind": "duration",
              "start": "2015-07-01",
              "end": "2015-09-30"
            },
            "priceBucket": 1435676400,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "100",
                "period": {
                  "kind": "duration",
                  "start": "2015-07-01",
                  "end": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150315000001",
                "disclosedAt": "2015-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "available",
            "reason": null,
            "value": 700,
            "reportedValue": 700,
            "period": {
              "kind": "duration",
              "start": "2015-10-01",
              "end": "2015-12-31"
            },
            "priceBucket": 1443625200,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "1000",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150415000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "comparison",
                "status": "available",
                "reason": null,
                "role": "thstrm_add_amount",
                "amount": "300",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150315000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11013",
            "status": "available",
            "reason": null,
            "value": 100,
            "reportedValue": 100,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-03-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11013",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "100",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160115000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689216,
                "lastSuccessAt": 1514689216,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11013",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11013",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689239,
                "lastSuccessAt": 1514689239,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      },
      {
        "metric": "operating_income",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11013",
            "status": "available",
            "reason": null,
            "value": -10,
            "reportedValue": -10,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-03-31"
            },
            "priceBucket": 1420038000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11013",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-10",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150115000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "dart_OperatingIncomeLoss",
                  "account_id": "dart_OperatingIncomeLoss"
                },
                "checkedAt": 1514689212,
                "lastSuccessAt": 1514689212,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11012",
            "status": "available",
            "reason": null,
            "value": -10,
            "reportedValue": -10,
            "period": {
              "kind": "duration",
              "start": "2015-04-01",
              "end": "2015-06-30"
            },
            "priceBucket": 1427814000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11012",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-10",
                "period": {
                  "kind": "duration",
                  "start": "2015-04-01",
                  "end": "2015-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150215000001",
                "disclosedAt": "2015-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "dart_OperatingIncomeLoss",
                  "account_id": "dart_OperatingIncomeLoss"
                },
                "checkedAt": 1514689213,
                "lastSuccessAt": 1514689213,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11014",
            "status": "available",
            "reason": null,
            "value": -10,
            "reportedValue": -10,
            "period": {
              "kind": "duration",
              "start": "2015-07-01",
              "end": "2015-09-30"
            },
            "priceBucket": 1435676400,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-10",
                "period": {
                  "kind": "duration",
                  "start": "2015-07-01",
                  "end": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150315000001",
                "disclosedAt": "2015-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "dart_OperatingIncomeLoss",
                  "account_id": "dart_OperatingIncomeLoss"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "available",
            "reason": null,
            "value": -70,
            "reportedValue": -70,
            "period": {
              "kind": "duration",
              "start": "2015-10-01",
              "end": "2015-12-31"
            },
            "priceBucket": 1443625200,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-100",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150415000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "dart_OperatingIncomeLoss",
                  "account_id": "dart_OperatingIncomeLoss"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "comparison",
                "status": "available",
                "reason": null,
                "role": "thstrm_add_amount",
                "amount": "-30",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150315000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "dart_OperatingIncomeLoss",
                  "account_id": "dart_OperatingIncomeLoss"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11013",
            "status": "available",
            "reason": null,
            "value": -10,
            "reportedValue": -10,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-03-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11013",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-10",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160115000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "dart_OperatingIncomeLoss",
                  "account_id": "dart_OperatingIncomeLoss"
                },
                "checkedAt": 1514689216,
                "lastSuccessAt": 1514689216,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11013",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11013",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689239,
                "lastSuccessAt": 1514689239,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      },
      {
        "metric": "owner_roe",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11013",
            "status": "not_calculable",
            "reason": "missing_comparison",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-03-31"
            },
            "priceBucket": 1420038000,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11013",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "10",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150115000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689212,
                "lastSuccessAt": 1514689212,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11012",
            "status": "not_calculable",
            "reason": "missing_comparison",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-06-30"
            },
            "priceBucket": 1427814000,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11012",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "10",
                "period": {
                  "kind": "duration",
                  "start": "2015-04-01",
                  "end": "2015-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150215000001",
                "disclosedAt": "2015-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689213,
                "lastSuccessAt": 1514689213,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11013",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "10",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150115000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689212,
                "lastSuccessAt": 1514689212,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11014",
            "status": "not_calculable",
            "reason": "missing_comparison",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-09-30"
            },
            "priceBucket": 1435676400,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "10",
                "period": {
                  "kind": "duration",
                  "start": "2015-07-01",
                  "end": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150315000001",
                "disclosedAt": "2015-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11012",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "10",
                "period": {
                  "kind": "duration",
                  "start": "2015-04-01",
                  "end": "2015-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150215000001",
                "disclosedAt": "2015-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689213,
                "lastSuccessAt": 1514689213,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11013",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "10",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150115000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689212,
                "lastSuccessAt": 1514689212,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "missing_comparison",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-12-31"
            },
            "priceBucket": 1443625200,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "100",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150415000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "comparison",
                "status": "available",
                "reason": null,
                "role": "thstrm_add_amount",
                "amount": "30",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150315000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "10",
                "period": {
                  "kind": "duration",
                  "start": "2015-07-01",
                  "end": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150315000001",
                "disclosedAt": "2015-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11012",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "10",
                "period": {
                  "kind": "duration",
                  "start": "2015-04-01",
                  "end": "2015-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150215000001",
                "disclosedAt": "2015-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689213,
                "lastSuccessAt": 1514689213,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11013",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "10",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150115000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689212,
                "lastSuccessAt": 1514689212,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11013",
            "status": "available",
            "reason": null,
            "value": 20,
            "reportedValue": 20,
            "period": {
              "kind": "duration",
              "start": "2015-04-01",
              "end": "2016-03-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11013",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "10",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160115000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689216,
                "lastSuccessAt": 1514689216,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "100",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150415000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "comparison",
                "status": "available",
                "reason": null,
                "role": "thstrm_add_amount",
                "amount": "30",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150315000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "10",
                "period": {
                  "kind": "duration",
                  "start": "2015-07-01",
                  "end": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150315000001",
                "disclosedAt": "2015-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11012",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "10",
                "period": {
                  "kind": "duration",
                  "start": "2015-04-01",
                  "end": "2015-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150215000001",
                "disclosedAt": "2015-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689213,
                "lastSuccessAt": 1514689213,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11013",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "500",
                "period": {
                  "kind": "instant",
                  "date": "2015-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150115000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_EquityAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_EquityAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689212,
                "lastSuccessAt": 1514689212,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2016,
                "reportCode": "11013",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "500",
                "period": {
                  "kind": "instant",
                  "date": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160115000001",
                "disclosedAt": "2016-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_EquityAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_EquityAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689216,
                "lastSuccessAt": 1514689216,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11013",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11013",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689239,
                "lastSuccessAt": 1514689239,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      },
      {
        "metric": "investing_cash_flow",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11013",
            "status": "available",
            "reason": null,
            "value": -100,
            "reportedValue": -100,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-03-31"
            },
            "priceBucket": 1420038000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11013",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-100",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150115000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689212,
                "lastSuccessAt": 1514689212,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11012",
            "status": "available",
            "reason": null,
            "value": -100,
            "reportedValue": -100,
            "period": {
              "kind": "duration",
              "start": "2015-04-01",
              "end": "2015-06-30"
            },
            "priceBucket": 1427814000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11012",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-200",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150215000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689213,
                "lastSuccessAt": 1514689213,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11013",
                "usage": "comparison",
                "status": "available",
                "reason": null,
                "role": "thstrm_add_amount",
                "amount": "-100",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150115000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689212,
                "lastSuccessAt": 1514689212,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11014",
            "status": "available",
            "reason": null,
            "value": -100,
            "reportedValue": -100,
            "period": {
              "kind": "duration",
              "start": "2015-07-01",
              "end": "2015-09-30"
            },
            "priceBucket": 1435676400,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-300",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150315000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11012",
                "usage": "comparison",
                "status": "available",
                "reason": null,
                "role": "thstrm_add_amount",
                "amount": "-200",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150215000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689213,
                "lastSuccessAt": 1514689213,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "available",
            "reason": null,
            "value": -100,
            "reportedValue": -100,
            "period": {
              "kind": "duration",
              "start": "2015-10-01",
              "end": "2015-12-31"
            },
            "priceBucket": 1443625200,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-400",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150415000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "comparison",
                "status": "available",
                "reason": null,
                "role": "thstrm_add_amount",
                "amount": "-300",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150315000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11013",
            "status": "available",
            "reason": null,
            "value": -100,
            "reportedValue": -100,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-03-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11013",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-100",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160115000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689216,
                "lastSuccessAt": 1514689216,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11013",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11013",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689239,
                "lastSuccessAt": 1514689239,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      },
      {
        "metric": "dps",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11013",
            "status": "unsupported",
            "reason": "annual_only",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-03-31"
            },
            "priceBucket": 1420038000,
            "basis": "CFS",
            "currency": null,
            "inputs": []
          },
          {
            "businessYear": 2015,
            "reportCode": "11012",
            "status": "unsupported",
            "reason": "annual_only",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-06-30"
            },
            "priceBucket": 1427814000,
            "basis": "CFS",
            "currency": null,
            "inputs": []
          },
          {
            "businessYear": 2015,
            "reportCode": "11014",
            "status": "unsupported",
            "reason": "annual_only",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-09-30"
            },
            "priceBucket": 1435676400,
            "basis": "CFS",
            "currency": null,
            "inputs": []
          },
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "unsupported",
            "reason": "annual_only",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-12-31"
            },
            "priceBucket": 1443625200,
            "basis": "CFS",
            "currency": null,
            "inputs": []
          },
          {
            "businessYear": 2016,
            "reportCode": "11013",
            "status": "unsupported",
            "reason": "annual_only",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-03-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": null,
            "inputs": []
          },
          {
            "businessYear": 2017,
            "reportCode": "11013",
            "status": "unsupported",
            "reason": "annual_only",
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": []
          }
        ]
      },
      {
        "metric": "debt_ratio",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11013",
            "status": "available",
            "reason": null,
            "value": 50,
            "reportedValue": 50,
            "period": {
              "kind": "instant",
              "date": "2015-03-31"
            },
            "priceBucket": 1420038000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11013",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "200",
                "period": {
                  "kind": "instant",
                  "date": "2015-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150115000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "부채총계",
                  "account_id": "ifrs-full_Liabilities"
                },
                "checkedAt": 1514689212,
                "lastSuccessAt": 1514689212,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11013",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "400",
                "period": {
                  "kind": "instant",
                  "date": "2015-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150115000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "자본총계",
                  "account_id": "ifrs-full_Equity"
                },
                "checkedAt": 1514689212,
                "lastSuccessAt": 1514689212,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11012",
            "status": "available",
            "reason": null,
            "value": 50,
            "reportedValue": 50,
            "period": {
              "kind": "instant",
              "date": "2015-06-30"
            },
            "priceBucket": 1427814000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11012",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "200",
                "period": {
                  "kind": "instant",
                  "date": "2015-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150215000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "부채총계",
                  "account_id": "ifrs-full_Liabilities"
                },
                "checkedAt": 1514689213,
                "lastSuccessAt": 1514689213,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11012",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "400",
                "period": {
                  "kind": "instant",
                  "date": "2015-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150215000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "자본총계",
                  "account_id": "ifrs-full_Equity"
                },
                "checkedAt": 1514689213,
                "lastSuccessAt": 1514689213,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11014",
            "status": "available",
            "reason": null,
            "value": 50,
            "reportedValue": 50,
            "period": {
              "kind": "instant",
              "date": "2015-09-30"
            },
            "priceBucket": 1435676400,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "200",
                "period": {
                  "kind": "instant",
                  "date": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150315000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "부채총계",
                  "account_id": "ifrs-full_Liabilities"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "400",
                "period": {
                  "kind": "instant",
                  "date": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150315000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "자본총계",
                  "account_id": "ifrs-full_Equity"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "available",
            "reason": null,
            "value": 50,
            "reportedValue": 50,
            "period": {
              "kind": "instant",
              "date": "2015-12-31"
            },
            "priceBucket": 1443625200,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "200",
                "period": {
                  "kind": "instant",
                  "date": "2015-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150415000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "부채총계",
                  "account_id": "ifrs-full_Liabilities"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "400",
                "period": {
                  "kind": "instant",
                  "date": "2015-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150415000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "자본총계",
                  "account_id": "ifrs-full_Equity"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11013",
            "status": "available",
            "reason": null,
            "value": 50,
            "reportedValue": 50,
            "period": {
              "kind": "instant",
              "date": "2016-03-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11013",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "200",
                "period": {
                  "kind": "instant",
                  "date": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160115000001",
                "disclosedAt": "2016-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "부채총계",
                  "account_id": "ifrs-full_Liabilities"
                },
                "checkedAt": 1514689216,
                "lastSuccessAt": 1514689216,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2016,
                "reportCode": "11013",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "400",
                "period": {
                  "kind": "instant",
                  "date": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160115000001",
                "disclosedAt": "2016-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "자본총계",
                  "account_id": "ifrs-full_Equity"
                },
                "checkedAt": 1514689216,
                "lastSuccessAt": 1514689216,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11013",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11013",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689239,
                "lastSuccessAt": 1514689239,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      }
    ]
  },
  "Y": {
    "symbol": "005930",
    "period": "Y",
    "status": "ready",
    "reason": null,
    "failure": null,
    "corpCode": "00126380",
    "fiscalMonth": 12,
    "shareClass": "보통주",
    "shareClassReason": null,
    "lastCheckedAt": 1514689212,
    "lastAttemptAt": 1514689212,
    "disclosureFailure": null,
    "refreshVersion": 1,
    "disclosureVersion": 1,
    "latestCorrections": true,
    "progress": {
      "total": 15,
      "completed": 15,
      "failed": 0,
      "pending": 0
    },
    "series": [
      {
        "metric": "revenue",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "available",
            "reason": null,
            "value": 1000,
            "reportedValue": 1000,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-12-31"
            },
            "priceBucket": 1420038000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "1000",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150415000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11011",
            "status": "available",
            "reason": null,
            "value": 1000,
            "reportedValue": 1000,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-12-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "1000",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160415000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689234,
                "lastSuccessAt": 1514689234,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11011",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11011",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689241,
                "lastSuccessAt": 1514689241,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      },
      {
        "metric": "operating_income",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "available",
            "reason": null,
            "value": -100,
            "reportedValue": -100,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-12-31"
            },
            "priceBucket": 1420038000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-100",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150415000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "dart_OperatingIncomeLoss",
                  "account_id": "dart_OperatingIncomeLoss"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11011",
            "status": "available",
            "reason": null,
            "value": -100,
            "reportedValue": -100,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-12-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-100",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160415000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "dart_OperatingIncomeLoss",
                  "account_id": "dart_OperatingIncomeLoss"
                },
                "checkedAt": 1514689234,
                "lastSuccessAt": 1514689234,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11011",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11011",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689241,
                "lastSuccessAt": 1514689241,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      },
      {
        "metric": "owner_roe",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "missing_comparison",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-12-31"
            },
            "priceBucket": 1420038000,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "100",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150415000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11011",
            "status": "available",
            "reason": null,
            "value": 20,
            "reportedValue": 20,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-12-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "100",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160415000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689234,
                "lastSuccessAt": 1514689234,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "500",
                "period": {
                  "kind": "instant",
                  "date": "2015-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150415000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_EquityAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_EquityAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "500",
                "period": {
                  "kind": "instant",
                  "date": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160415000001",
                "disclosedAt": "2016-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_EquityAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_EquityAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689234,
                "lastSuccessAt": 1514689234,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11011",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11011",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689241,
                "lastSuccessAt": 1514689241,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      },
      {
        "metric": "investing_cash_flow",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "available",
            "reason": null,
            "value": -400,
            "reportedValue": -400,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-12-31"
            },
            "priceBucket": 1420038000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-400",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150415000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11011",
            "status": "available",
            "reason": null,
            "value": -400,
            "reportedValue": -400,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-12-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-400",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160415000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689234,
                "lastSuccessAt": 1514689234,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11011",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11011",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689241,
                "lastSuccessAt": 1514689241,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      },
      {
        "metric": "dps",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "available",
            "reason": null,
            "value": 0,
            "reportedValue": 0,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-12-31"
            },
            "priceBucket": 1420038000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm",
                "amount": "0",
                "period": {
                  "kind": "instant",
                  "date": "2015-12-31"
                },
                "verificationReason": null,
                "basis": null,
                "currency": "KRW",
                "receipt": "20150415000001",
                "disclosedAt": "2015-12-31",
                "contextId": null,
                "sourceFile": null,
                "fields": {
                  "se": "주당 현금배당금(원)"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm",
                "amount": "0",
                "period": {
                  "kind": "instant",
                  "date": "2015-12-31"
                },
                "verificationReason": null,
                "basis": null,
                "currency": "KRW",
                "receipt": "20150415000001",
                "disclosedAt": "2015-12-31",
                "contextId": null,
                "sourceFile": null,
                "fields": {
                  "se": "주당 현금배당금(원)"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "reporting_period",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "1000",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150415000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11011",
            "status": "available",
            "reason": null,
            "value": 0,
            "reportedValue": 0,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-12-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm",
                "amount": "0",
                "period": {
                  "kind": "instant",
                  "date": "2016-12-31"
                },
                "verificationReason": null,
                "basis": null,
                "currency": "KRW",
                "receipt": "20160415000001",
                "disclosedAt": "2016-12-31",
                "contextId": null,
                "sourceFile": null,
                "fields": {
                  "se": "주당 현금배당금(원)"
                },
                "checkedAt": 1514689237,
                "lastSuccessAt": 1514689237,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm",
                "amount": "0",
                "period": {
                  "kind": "instant",
                  "date": "2016-12-31"
                },
                "verificationReason": null,
                "basis": null,
                "currency": "KRW",
                "receipt": "20160415000001",
                "disclosedAt": "2016-12-31",
                "contextId": null,
                "sourceFile": null,
                "fields": {
                  "se": "주당 현금배당금(원)"
                },
                "checkedAt": 1514689237,
                "lastSuccessAt": 1514689237,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "reporting_period",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "1000",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160415000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689234,
                "lastSuccessAt": 1514689234,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11011",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11011",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "dividends",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689241,
                "lastSuccessAt": 1514689241,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      },
      {
        "metric": "debt_ratio",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "available",
            "reason": null,
            "value": 50,
            "reportedValue": 50,
            "period": {
              "kind": "instant",
              "date": "2015-12-31"
            },
            "priceBucket": 1420038000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "200",
                "period": {
                  "kind": "instant",
                  "date": "2015-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150415000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "부채총계",
                  "account_id": "ifrs-full_Liabilities"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "400",
                "period": {
                  "kind": "instant",
                  "date": "2015-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150415000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "자본총계",
                  "account_id": "ifrs-full_Equity"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11011",
            "status": "available",
            "reason": null,
            "value": 50,
            "reportedValue": 50,
            "period": {
              "kind": "instant",
              "date": "2016-12-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "200",
                "period": {
                  "kind": "instant",
                  "date": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160415000001",
                "disclosedAt": "2016-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "부채총계",
                  "account_id": "ifrs-full_Liabilities"
                },
                "checkedAt": 1514689234,
                "lastSuccessAt": 1514689234,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "400",
                "period": {
                  "kind": "instant",
                  "date": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160415000001",
                "disclosedAt": "2016-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "자본총계",
                  "account_id": "ifrs-full_Equity"
                },
                "checkedAt": 1514689234,
                "lastSuccessAt": 1514689234,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11011",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11011",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689241,
                "lastSuccessAt": 1514689241,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      }
    ]
  }
};

export const edgeData: Record<"Q" | "Y", FinancialsPage> = {
  "Q": {
    "symbol": "005930",
    "period": "Q",
    "status": "ready",
    "reason": null,
    "failure": null,
    "corpCode": "00126380",
    "fiscalMonth": 3,
    "shareClass": "보통주",
    "shareClassReason": null,
    "lastCheckedAt": 1514689213,
    "lastAttemptAt": 1514689213,
    "disclosureFailure": null,
    "refreshVersion": 1,
    "disclosureVersion": 1,
    "latestCorrections": true,
    "progress": {
      "total": 15,
      "completed": 15,
      "failed": 0,
      "pending": 0
    },
    "series": [
      {
        "metric": "revenue",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11012",
            "status": "not_calculable",
            "reason": "period_overlap",
            "value": null,
            "reportedValue": 100,
            "period": {
              "kind": "duration",
              "start": "2015-04-01",
              "end": "2015-06-30"
            },
            "priceBucket": 1427814000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11012",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "100",
                "period": {
                  "kind": "duration",
                  "start": "2015-04-01",
                  "end": "2015-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150216000001",
                "disclosedAt": "2015-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11014",
            "status": "available",
            "reason": null,
            "value": 100,
            "reportedValue": 100,
            "period": {
              "kind": "duration",
              "start": "2015-07-01",
              "end": "2015-09-30"
            },
            "priceBucket": 1435676400,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "100",
                "period": {
                  "kind": "duration",
                  "start": "2015-07-01",
                  "end": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150316000001",
                "disclosedAt": "2015-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "period_mismatch",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-04-01",
              "end": "2016-03-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "1000",
                "period": {
                  "kind": "duration",
                  "start": "2015-04-01",
                  "end": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150416000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "comparison",
                "status": "available",
                "reason": null,
                "role": "thstrm_add_amount",
                "amount": "300",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150316000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "basis_changed",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-12-31"
            },
            "priceBucket": 1475247600,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "1000",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160416000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2016,
                "reportCode": "11014",
                "usage": "comparison",
                "status": "available",
                "reason": null,
                "role": "thstrm_add_amount",
                "amount": "300",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-09-30"
                },
                "verificationReason": null,
                "basis": "OFS",
                "currency": "KRW",
                "receipt": "20160316000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11011",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11011",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689220,
                "lastSuccessAt": 1514689220,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      },
      {
        "metric": "operating_income",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11012",
            "status": "not_calculable",
            "reason": "period_overlap",
            "value": null,
            "reportedValue": -10,
            "period": {
              "kind": "duration",
              "start": "2015-04-01",
              "end": "2015-06-30"
            },
            "priceBucket": 1427814000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11012",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-10",
                "period": {
                  "kind": "duration",
                  "start": "2015-04-01",
                  "end": "2015-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150216000001",
                "disclosedAt": "2015-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "dart_OperatingIncomeLoss",
                  "account_id": "dart_OperatingIncomeLoss"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11014",
            "status": "available",
            "reason": null,
            "value": -10,
            "reportedValue": -10,
            "period": {
              "kind": "duration",
              "start": "2015-07-01",
              "end": "2015-09-30"
            },
            "priceBucket": 1435676400,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-10",
                "period": {
                  "kind": "duration",
                  "start": "2015-07-01",
                  "end": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150316000001",
                "disclosedAt": "2015-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "dart_OperatingIncomeLoss",
                  "account_id": "dart_OperatingIncomeLoss"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "period_mismatch",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-04-01",
              "end": "2016-03-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-100",
                "period": {
                  "kind": "duration",
                  "start": "2015-04-01",
                  "end": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150416000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "dart_OperatingIncomeLoss",
                  "account_id": "dart_OperatingIncomeLoss"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "comparison",
                "status": "available",
                "reason": null,
                "role": "thstrm_add_amount",
                "amount": "-30",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150316000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "dart_OperatingIncomeLoss",
                  "account_id": "dart_OperatingIncomeLoss"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "basis_changed",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-12-31"
            },
            "priceBucket": 1475247600,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-100",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160416000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "dart_OperatingIncomeLoss",
                  "account_id": "dart_OperatingIncomeLoss"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2016,
                "reportCode": "11014",
                "usage": "comparison",
                "status": "available",
                "reason": null,
                "role": "thstrm_add_amount",
                "amount": "-30",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-09-30"
                },
                "verificationReason": null,
                "basis": "OFS",
                "currency": "KRW",
                "receipt": "20160316000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "dart_OperatingIncomeLoss",
                  "account_id": "dart_OperatingIncomeLoss"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11011",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11011",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689220,
                "lastSuccessAt": 1514689220,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      },
      {
        "metric": "owner_roe",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11012",
            "status": "not_calculable",
            "reason": "period_overlap",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-06-30"
            },
            "priceBucket": 1427814000,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11012",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "10",
                "period": {
                  "kind": "duration",
                  "start": "2015-04-01",
                  "end": "2015-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150216000001",
                "disclosedAt": "2015-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11014",
            "status": "not_calculable",
            "reason": "missing_comparison",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-09-30"
            },
            "priceBucket": 1435676400,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "10",
                "period": {
                  "kind": "duration",
                  "start": "2015-07-01",
                  "end": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150316000001",
                "disclosedAt": "2015-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11012",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "10",
                "period": {
                  "kind": "duration",
                  "start": "2015-04-01",
                  "end": "2015-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150216000001",
                "disclosedAt": "2015-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "period_mismatch",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-04-01",
              "end": "2016-03-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "100",
                "period": {
                  "kind": "duration",
                  "start": "2015-04-01",
                  "end": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150416000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "comparison",
                "status": "available",
                "reason": null,
                "role": "thstrm_add_amount",
                "amount": "30",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150316000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11014",
            "status": "not_calculable",
            "reason": "basis_changed",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-09-30"
            },
            "priceBucket": 1467298800,
            "basis": "OFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11014",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "10",
                "period": {
                  "kind": "duration",
                  "start": "2016-07-01",
                  "end": "2016-09-30"
                },
                "verificationReason": null,
                "basis": "OFS",
                "currency": "KRW",
                "receipt": "20160316000001",
                "disclosedAt": "2016-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2016,
                "reportCode": "11012",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "10",
                "period": {
                  "kind": "duration",
                  "start": "2016-04-01",
                  "end": "2016-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160216000001",
                "disclosedAt": "2016-12-31",
                "contextId": "q",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689216,
                "lastSuccessAt": 1514689216,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "basis_changed",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-12-31"
            },
            "priceBucket": 1475247600,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "100",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160416000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2016,
                "reportCode": "11014",
                "usage": "comparison",
                "status": "available",
                "reason": null,
                "role": "thstrm_add_amount",
                "amount": "30",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-09-30"
                },
                "verificationReason": null,
                "basis": "OFS",
                "currency": "KRW",
                "receipt": "20160316000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11011",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11011",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689220,
                "lastSuccessAt": 1514689220,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      },
      {
        "metric": "investing_cash_flow",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11012",
            "status": "not_calculable",
            "reason": "period_overlap",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-06-30"
            },
            "priceBucket": 1427814000,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11012",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-200",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150216000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11013",
                "usage": "comparison",
                "status": "available",
                "reason": null,
                "role": "thstrm_add_amount",
                "amount": "-100",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-04-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150116000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689213,
                "lastSuccessAt": 1514689213,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11014",
            "status": "available",
            "reason": null,
            "value": -100,
            "reportedValue": -100,
            "period": {
              "kind": "duration",
              "start": "2015-07-01",
              "end": "2015-09-30"
            },
            "priceBucket": 1435676400,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-300",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150316000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11012",
                "usage": "comparison",
                "status": "available",
                "reason": null,
                "role": "thstrm_add_amount",
                "amount": "-200",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150216000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "period_mismatch",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-04-01",
              "end": "2016-03-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-400",
                "period": {
                  "kind": "duration",
                  "start": "2015-04-01",
                  "end": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150416000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "comparison",
                "status": "available",
                "reason": null,
                "role": "thstrm_add_amount",
                "amount": "-300",
                "period": {
                  "kind": "duration",
                  "start": "2015-01-01",
                  "end": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150316000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11014",
            "status": "not_calculable",
            "reason": "basis_changed",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-09-30"
            },
            "priceBucket": 1467298800,
            "basis": "OFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11014",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-300",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-09-30"
                },
                "verificationReason": null,
                "basis": "OFS",
                "currency": "KRW",
                "receipt": "20160316000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2016,
                "reportCode": "11012",
                "usage": "comparison",
                "status": "available",
                "reason": null,
                "role": "thstrm_add_amount",
                "amount": "-200",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160216000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689216,
                "lastSuccessAt": 1514689216,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "basis_changed",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-12-31"
            },
            "priceBucket": 1475247600,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-400",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160416000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2016,
                "reportCode": "11014",
                "usage": "comparison",
                "status": "available",
                "reason": null,
                "role": "thstrm_add_amount",
                "amount": "-300",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-09-30"
                },
                "verificationReason": null,
                "basis": "OFS",
                "currency": "KRW",
                "receipt": "20160316000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11011",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11011",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689220,
                "lastSuccessAt": 1514689220,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      },
      {
        "metric": "dps",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11012",
            "status": "unsupported",
            "reason": "annual_only",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-01-01",
              "end": "2015-06-30"
            },
            "priceBucket": 1427814000,
            "basis": "CFS",
            "currency": null,
            "inputs": []
          },
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "unsupported",
            "reason": "annual_only",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-04-01",
              "end": "2016-03-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": null,
            "inputs": []
          },
          {
            "businessYear": 2016,
            "reportCode": "11011",
            "status": "unsupported",
            "reason": "annual_only",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-12-31"
            },
            "priceBucket": 1475247600,
            "basis": "CFS",
            "currency": null,
            "inputs": []
          },
          {
            "businessYear": 2017,
            "reportCode": "11011",
            "status": "unsupported",
            "reason": "annual_only",
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": []
          }
        ]
      },
      {
        "metric": "debt_ratio",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11012",
            "status": "not_calculable",
            "reason": "period_overlap",
            "value": null,
            "reportedValue": 50,
            "period": {
              "kind": "instant",
              "date": "2015-06-30"
            },
            "priceBucket": 1427814000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11012",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "200",
                "period": {
                  "kind": "instant",
                  "date": "2015-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150216000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "부채총계",
                  "account_id": "ifrs-full_Liabilities"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11012",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "400",
                "period": {
                  "kind": "instant",
                  "date": "2015-06-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150216000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "자본총계",
                  "account_id": "ifrs-full_Equity"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11014",
            "status": "available",
            "reason": null,
            "value": 50,
            "reportedValue": 50,
            "period": {
              "kind": "instant",
              "date": "2015-09-30"
            },
            "priceBucket": 1435676400,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "200",
                "period": {
                  "kind": "instant",
                  "date": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150316000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "부채총계",
                  "account_id": "ifrs-full_Liabilities"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11014",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "400",
                "period": {
                  "kind": "instant",
                  "date": "2015-09-30"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150316000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "자본총계",
                  "account_id": "ifrs-full_Equity"
                },
                "checkedAt": 1514689214,
                "lastSuccessAt": 1514689214,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "available",
            "reason": null,
            "value": 50,
            "reportedValue": 50,
            "period": {
              "kind": "instant",
              "date": "2016-03-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "200",
                "period": {
                  "kind": "instant",
                  "date": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150416000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "부채총계",
                  "account_id": "ifrs-full_Liabilities"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "400",
                "period": {
                  "kind": "instant",
                  "date": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150416000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "자본총계",
                  "account_id": "ifrs-full_Equity"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11014",
            "status": "not_calculable",
            "reason": "non_positive_equity",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "instant",
              "date": "2016-09-30"
            },
            "priceBucket": 1467298800,
            "basis": "OFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11014",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "200",
                "period": {
                  "kind": "instant",
                  "date": "2016-09-30"
                },
                "verificationReason": null,
                "basis": "OFS",
                "currency": "KRW",
                "receipt": "20160316000001",
                "disclosedAt": "2016-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "부채총계",
                  "account_id": "ifrs-full_Liabilities"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2016,
                "reportCode": "11014",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "0",
                "period": {
                  "kind": "instant",
                  "date": "2016-09-30"
                },
                "verificationReason": null,
                "basis": "OFS",
                "currency": "KRW",
                "receipt": "20160316000001",
                "disclosedAt": "2016-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "자본총계",
                  "account_id": "ifrs-full_Equity"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "non_positive_equity",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "instant",
              "date": "2016-12-31"
            },
            "priceBucket": 1475247600,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "200",
                "period": {
                  "kind": "instant",
                  "date": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160416000001",
                "disclosedAt": "2016-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "부채총계",
                  "account_id": "ifrs-full_Liabilities"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "0",
                "period": {
                  "kind": "instant",
                  "date": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160416000001",
                "disclosedAt": "2016-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "자본총계",
                  "account_id": "ifrs-full_Equity"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11011",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11011",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689220,
                "lastSuccessAt": 1514689220,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      }
    ]
  },
  "Y": {
    "symbol": "005930",
    "period": "Y",
    "status": "ready",
    "reason": null,
    "failure": null,
    "corpCode": "00126380",
    "fiscalMonth": 3,
    "shareClass": "보통주",
    "shareClassReason": null,
    "lastCheckedAt": 1514689213,
    "lastAttemptAt": 1514689213,
    "disclosureFailure": null,
    "refreshVersion": 1,
    "disclosureVersion": 1,
    "latestCorrections": true,
    "progress": {
      "total": 15,
      "completed": 15,
      "failed": 0,
      "pending": 0
    },
    "series": [
      {
        "metric": "revenue",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "period_overlap",
            "value": null,
            "reportedValue": 1000,
            "period": {
              "kind": "duration",
              "start": "2015-04-01",
              "end": "2016-03-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "1000",
                "period": {
                  "kind": "duration",
                  "start": "2015-04-01",
                  "end": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150416000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "period_overlap",
            "value": null,
            "reportedValue": 1000,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-12-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "1000",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160416000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11011",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11011",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689220,
                "lastSuccessAt": 1514689220,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      },
      {
        "metric": "operating_income",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "period_overlap",
            "value": null,
            "reportedValue": -100,
            "period": {
              "kind": "duration",
              "start": "2015-04-01",
              "end": "2016-03-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-100",
                "period": {
                  "kind": "duration",
                  "start": "2015-04-01",
                  "end": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150416000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "dart_OperatingIncomeLoss",
                  "account_id": "dart_OperatingIncomeLoss"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "period_overlap",
            "value": null,
            "reportedValue": -100,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-12-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-100",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160416000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "dart_OperatingIncomeLoss",
                  "account_id": "dart_OperatingIncomeLoss"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11011",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11011",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689220,
                "lastSuccessAt": 1514689220,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      },
      {
        "metric": "owner_roe",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "period_overlap",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-04-01",
              "end": "2016-03-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "100",
                "period": {
                  "kind": "duration",
                  "start": "2015-04-01",
                  "end": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150416000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "period_overlap",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-12-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "100",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160416000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_ProfitLossAttributableToOwnersOfParent",
                  "account_id": "ifrs-full_ProfitLossAttributableToOwnersOfParent"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11011",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11011",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689220,
                "lastSuccessAt": 1514689220,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      },
      {
        "metric": "investing_cash_flow",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "period_overlap",
            "value": null,
            "reportedValue": -400,
            "period": {
              "kind": "duration",
              "start": "2015-04-01",
              "end": "2016-03-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-400",
                "period": {
                  "kind": "duration",
                  "start": "2015-04-01",
                  "end": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150416000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "period_overlap",
            "value": null,
            "reportedValue": -400,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-12-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "-400",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160416000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_CashFlowsFromUsedInInvestingActivities",
                  "account_id": "ifrs-full_CashFlowsFromUsedInInvestingActivities"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11011",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11011",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689220,
                "lastSuccessAt": 1514689220,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      },
      {
        "metric": "dps",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "period_overlap",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "duration",
              "start": "2015-04-01",
              "end": "2016-03-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm",
                "amount": "0",
                "period": {
                  "kind": "instant",
                  "date": "2015-12-31"
                },
                "verificationReason": null,
                "basis": null,
                "currency": "KRW",
                "receipt": "20150416000001",
                "disclosedAt": "2015-12-31",
                "contextId": null,
                "sourceFile": null,
                "fields": {
                  "se": "주당 현금배당금(원)"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm",
                "amount": "0",
                "period": {
                  "kind": "instant",
                  "date": "2015-12-31"
                },
                "verificationReason": null,
                "basis": null,
                "currency": "KRW",
                "receipt": "20150416000001",
                "disclosedAt": "2015-12-31",
                "contextId": null,
                "sourceFile": null,
                "fields": {
                  "se": "주당 현금배당금(원)"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "reporting_period",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "1000",
                "period": {
                  "kind": "duration",
                  "start": "2015-04-01",
                  "end": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150416000001",
                "disclosedAt": "2015-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "period_overlap",
            "value": null,
            "reportedValue": 0,
            "period": {
              "kind": "duration",
              "start": "2016-01-01",
              "end": "2016-12-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm",
                "amount": "0",
                "period": {
                  "kind": "instant",
                  "date": "2016-12-31"
                },
                "verificationReason": null,
                "basis": null,
                "currency": "KRW",
                "receipt": "20160416000001",
                "disclosedAt": "2016-12-31",
                "contextId": null,
                "sourceFile": null,
                "fields": {
                  "se": "주당 현금배당금(원)"
                },
                "checkedAt": 1514689218,
                "lastSuccessAt": 1514689218,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm",
                "amount": "0",
                "period": {
                  "kind": "instant",
                  "date": "2016-12-31"
                },
                "verificationReason": null,
                "basis": null,
                "currency": "KRW",
                "receipt": "20160416000001",
                "disclosedAt": "2016-12-31",
                "contextId": null,
                "sourceFile": null,
                "fields": {
                  "se": "주당 현금배당금(원)"
                },
                "checkedAt": 1514689218,
                "lastSuccessAt": 1514689218,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "reporting_period",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "1000",
                "period": {
                  "kind": "duration",
                  "start": "2016-01-01",
                  "end": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160416000001",
                "disclosedAt": "2016-12-31",
                "contextId": "cum",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "ifrs-full_Revenue",
                  "account_id": "ifrs-full_Revenue"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11011",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11011",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "dividends",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689220,
                "lastSuccessAt": 1514689220,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      },
      {
        "metric": "debt_ratio",
        "points": [
          {
            "businessYear": 2015,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "period_overlap",
            "value": null,
            "reportedValue": 50,
            "period": {
              "kind": "instant",
              "date": "2016-03-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": "KRW",
            "inputs": [
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "200",
                "period": {
                  "kind": "instant",
                  "date": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150416000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "부채총계",
                  "account_id": "ifrs-full_Liabilities"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2015,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "400",
                "period": {
                  "kind": "instant",
                  "date": "2016-03-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20150416000001",
                "disclosedAt": "2015-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "자본총계",
                  "account_id": "ifrs-full_Equity"
                },
                "checkedAt": 1514689215,
                "lastSuccessAt": 1514689215,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2016,
            "reportCode": "11011",
            "status": "not_calculable",
            "reason": "period_overlap",
            "value": null,
            "reportedValue": null,
            "period": {
              "kind": "instant",
              "date": "2016-12-31"
            },
            "priceBucket": 1451574000,
            "basis": "CFS",
            "currency": null,
            "inputs": [
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "200",
                "period": {
                  "kind": "instant",
                  "date": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160416000001",
                "disclosedAt": "2016-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "부채총계",
                  "account_id": "ifrs-full_Liabilities"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              },
              {
                "businessYear": 2016,
                "reportCode": "11011",
                "usage": "value",
                "status": "available",
                "reason": null,
                "role": "thstrm_amount",
                "amount": "0",
                "period": {
                  "kind": "instant",
                  "date": "2016-12-31"
                },
                "verificationReason": null,
                "basis": "CFS",
                "currency": "KRW",
                "receipt": "20160416000001",
                "disclosedAt": "2016-12-31",
                "contextId": "bs",
                "sourceFile": "synthetic.xbrl",
                "fields": {
                  "account_nm": "자본총계",
                  "account_id": "ifrs-full_Equity"
                },
                "checkedAt": 1514689217,
                "lastSuccessAt": 1514689217,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          },
          {
            "businessYear": 2017,
            "reportCode": "11011",
            "status": "unpublished",
            "reason": null,
            "value": null,
            "reportedValue": null,
            "period": null,
            "priceBucket": null,
            "basis": null,
            "currency": null,
            "inputs": [
              {
                "businessYear": 2017,
                "reportCode": "11011",
                "usage": "value",
                "status": "unpublished",
                "reason": null,
                "role": "statement",
                "amount": null,
                "period": null,
                "verificationReason": null,
                "basis": null,
                "currency": null,
                "receipt": null,
                "disclosedAt": null,
                "contextId": null,
                "sourceFile": null,
                "fields": {},
                "checkedAt": 1514689220,
                "lastSuccessAt": 1514689220,
                "failure": null,
                "refreshVersion": 1
              }
            ]
          }
        ]
      }
    ]
  }
};

export const preferredDps: FinancialsPage["series"][number]["points"] = [
  {
    "businessYear": 2015,
    "reportCode": "11011",
    "status": "not_calculable",
    "reason": "share_class_unverified",
    "value": null,
    "reportedValue": null,
    "period": {
      "kind": "duration",
      "start": "2015-01-01",
      "end": "2015-12-31"
    },
    "priceBucket": 1420038000,
    "basis": "CFS",
    "currency": null,
    "inputs": [
      {
        "businessYear": 2015,
        "reportCode": "11011",
        "usage": "value",
        "status": "available",
        "reason": null,
        "role": "thstrm",
        "amount": "0",
        "period": {
          "kind": "instant",
          "date": "2015-12-31"
        },
        "verificationReason": null,
        "basis": null,
        "currency": "KRW",
        "receipt": "20150415000001",
        "disclosedAt": "2015-12-31",
        "contextId": null,
        "sourceFile": null,
        "fields": {
          "se": "주당 현금배당금(원)"
        },
        "checkedAt": 1514689215,
        "lastSuccessAt": 1514689215,
        "failure": null,
        "refreshVersion": 1
      },
      {
        "businessYear": 2015,
        "reportCode": "11011",
        "usage": "value",
        "status": "available",
        "reason": null,
        "role": "thstrm",
        "amount": "0",
        "period": {
          "kind": "instant",
          "date": "2015-12-31"
        },
        "verificationReason": null,
        "basis": null,
        "currency": "KRW",
        "receipt": "20150415000001",
        "disclosedAt": "2015-12-31",
        "contextId": null,
        "sourceFile": null,
        "fields": {
          "se": "주당 현금배당금(원)"
        },
        "checkedAt": 1514689215,
        "lastSuccessAt": 1514689215,
        "failure": null,
        "refreshVersion": 1
      }
    ]
  },
  {
    "businessYear": 2016,
    "reportCode": "11011",
    "status": "not_calculable",
    "reason": "share_class_unverified",
    "value": null,
    "reportedValue": null,
    "period": {
      "kind": "duration",
      "start": "2016-01-01",
      "end": "2016-12-31"
    },
    "priceBucket": 1451574000,
    "basis": "CFS",
    "currency": null,
    "inputs": [
      {
        "businessYear": 2016,
        "reportCode": "11011",
        "usage": "value",
        "status": "available",
        "reason": null,
        "role": "thstrm",
        "amount": "0",
        "period": {
          "kind": "instant",
          "date": "2016-12-31"
        },
        "verificationReason": null,
        "basis": null,
        "currency": "KRW",
        "receipt": "20160415000001",
        "disclosedAt": "2016-12-31",
        "contextId": null,
        "sourceFile": null,
        "fields": {
          "se": "주당 현금배당금(원)"
        },
        "checkedAt": 1514689237,
        "lastSuccessAt": 1514689237,
        "failure": null,
        "refreshVersion": 1
      },
      {
        "businessYear": 2016,
        "reportCode": "11011",
        "usage": "value",
        "status": "available",
        "reason": null,
        "role": "thstrm",
        "amount": "0",
        "period": {
          "kind": "instant",
          "date": "2016-12-31"
        },
        "verificationReason": null,
        "basis": null,
        "currency": "KRW",
        "receipt": "20160415000001",
        "disclosedAt": "2016-12-31",
        "contextId": null,
        "sourceFile": null,
        "fields": {
          "se": "주당 현금배당금(원)"
        },
        "checkedAt": 1514689237,
        "lastSuccessAt": 1514689237,
        "failure": null,
        "refreshVersion": 1
      }
    ]
  },
  {
    "businessYear": 2017,
    "reportCode": "11011",
    "status": "unpublished",
    "reason": null,
    "value": null,
    "reportedValue": null,
    "period": null,
    "priceBucket": null,
    "basis": null,
    "currency": null,
    "inputs": [
      {
        "businessYear": 2017,
        "reportCode": "11011",
        "usage": "value",
        "status": "unpublished",
        "reason": null,
        "role": "dividends",
        "amount": null,
        "period": null,
        "verificationReason": null,
        "basis": null,
        "currency": null,
        "receipt": null,
        "disclosedAt": null,
        "contextId": null,
        "sourceFile": null,
        "fields": {},
        "checkedAt": 1514689241,
        "lastSuccessAt": 1514689241,
        "failure": null,
        "refreshVersion": 1
      }
    ]
  }
];

export const readyJob: FinancialUpdatePage = {
  "id": 1,
  "status": "ready",
  "phase": "complete",
  "stopReason": null,
  "nextCheckAt": null,
  "canResume": false,
  "automatic": false,
  "latestCheckPending": false,
  "historyCompletedCompanies": 2,
  "historyFailedCompanies": 0,
  "recentFailedCompanies": 0,
  "historyComplete": true,
  "fromYear": 2015,
  "throughYear": 2017,
  "totalSymbols": 7,
  "processedSymbols": 7,
  "unsupportedSymbols": 3,
  "unverifiedSymbols": 0,
  "unverifiedDividends": 1,
  "totalCompanies": 2,
  "completedCompanies": 2,
  "failedCompanies": 0,
  "startedAt": 1514689203,
  "lastCheckedAt": 1514689241,
  "failure": null,
  "failures": []
};
