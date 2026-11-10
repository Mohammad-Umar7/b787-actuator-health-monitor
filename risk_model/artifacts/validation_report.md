# Risk model validation report

Trained 2026-11-10T11:42:29 on Cases Data.xlsx: 36 rows, 10 aircraft, 6 failures.

## The model
- Type: monotone regularised logistic regression.
- Inputs: Leakage_Level, Operation_Time, Actuator_Age_Months.
- Each input can only raise the risk, never lower it.
- Penalty: fixed in advance (prior scale 1.25 per standard deviation of an input), not tuned to this data. It weakens automatically as more rows arrive.
- Risk levels: Low below 5%, Medium from 5%, High from 50%.

| Input | Weight per step or unit |
|---|---|
| Leakage_Level | 0.917 |
| Operation_Time | 2.637 |
| Actuator_Age_Months | 0.000 |
| (starting point) | -6.293 |

## Test on aircraft the model never saw
Each aircraft is held out in turn. The model is rebuilt from the other aircraft and then scores the held-out one.

- Failures caught: **6 of 6**. Missed: 0. False alarms: 1 of 30 healthy records.
- Brier score 0.040, log loss 0.144, AUC 0.97.

## Test on the future
Trained only on the months before Apr, then scored Apr: caught **2 of 2** failures with 0 false alarms across 6 records.

## Compared with other models (same unseen-aircraft test)

| Model | Caught | False alarms | Brier | Log loss |
|---|---|---|---|---|
| Risk scorecard (ours): leakage, operation time, age | 6/6 | 1 | 0.040 | 0.144 |
| Risk scorecard with all six columns | 6/6 | 1 | 0.045 | 0.156 |
| Decision tree | 6/6 | 1 | 0.035 | 0.403 |
| Random forest | 5/6 | 1 | 0.044 | 0.155 |
| Gradient boosting | 5/6 | 1 | 0.056 | 0.616 |
| Monotone gradient boosting | 6/6 | 1 | 0.032 | 0.263 |
| One rule: operation time High | 6/6 | 1 | n/a | n/a |
| Scorecard without operation time | 1/6 | 2 | 0.092 | 0.268 |
| No model: fleet average for everyone | 0/6 | 0 | 0.144 | 0.470 |

## Readings the data never contained
Predicted failure risk from each model after training on all rows.

| Situation | Ours | Decision tree | Random forest | Gradient boosting | Monotone gradient boosting |
|---|---|---|---|---|---|
| Leakage Very High, operation only Slightly High | 29% | 0% | 14% | 0% | 0% |
| Leakage Normal, operation High | 26% | 100% | 42% | 100% | 86% |
| Leakage High, operation Slightly High, age 40 | 14% | 0% | 20% | 0% | 0% |
| Leakage Slightly High, operation Slightly High | 6% | 0% | 0% | 0% | 0% |
| Everything Normal, age 40 | 0% | 0% | 11% | 0% | 0% |
| Leakage Very High, operation High, age 10 | 85% | 100% | 74% | 100% | 86% |

## Does the result depend on the penalty setting?
We use 1.25. The same unseen-aircraft test at other settings:

| Prior scale | Caught | False alarms | Brier | Log loss |
|---|---|---|---|---|
| 0.5 | 2/6 | 1 | 0.064 | 0.216 |
| 0.75 | 6/6 | 1 | 0.052 | 0.178 |
| 1.0 | 6/6 | 1 | 0.045 | 0.157 |
| 1.25 (ours) | 6/6 | 1 | 0.040 | 0.144 |
| 1.5 | 6/6 | 1 | 0.037 | 0.136 |
| 2.0 | 6/6 | 1 | 0.035 | 0.130 |
| 3.0 | 6/6 | 1 | 0.033 | 0.130 |

## Current fleet (latest record per aircraft)

| Aircraft | Month | Leakage | Operation time | Age | Risk | Range | Level | Main factors |
|---|---|---|---|---|---|---|---|---|
| B787-008 | Mar | Very High | High | 27 | 85% | 79-94% | High | operation time High (66%), leakage Very High (34%) |
| B787-004 | Mar | High | High | 26 | 69% | 53-86% | High | operation time High (74%), leakage High (26%) |
| B787-006 | Mar | High | High | 23 | 69% | 53-84% | High | operation time High (74%), leakage High (26%) |
| B787-010 | Mar | High | High | 20 | 69% | 53-81% | High | operation time High (74%), leakage High (26%) |
| B787-002 | Apr | High | High | 19 | 69% | 53-80% | High | operation time High (74%), leakage High (26%) |
| B787-003 | Apr | High | High | 23 | 69% | 53-84% | High | operation time High (74%), leakage High (26%) |
| B787-007 | Apr | Slightly High | Slightly High | 16 | 6% | 4-7% | Medium | operation time Slightly High (74%), leakage Slightly High (26%) |
| B787-001 | Apr | Slightly High | Normal | 15 | 0% | 0-1% | Low | leakage Slightly High (100%) |
| B787-005 | Apr | Slightly High | Normal | 11 | 0% | 0-1% | Low | leakage Slightly High (100%) |
| B787-009 | Apr | Slightly High | Normal | 13 | 0% | 0-1% | Low | leakage Slightly High (100%) |

## Limits
- 6 failures is very little evidence. The ranges above show how much the answer moves when the fleet is resampled.
- Leakage and operation time arrive as labels, so the model treats each step up as the same size.
- The risk is for the next 30 days only. A low score with rising readings still needs watching.
- A more complex model: not justified by this much data.
