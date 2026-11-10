# Case 1, release v2: what we did, in plain words

Read this before the pitch. The full numbers are in `artifacts/case1_report.md`.

## What the organisers gave us
- **Training:** 10,000 labelled rows. 100 aircraft, each with 100 weekly records (Jan 2024 to Nov 2025).
- **Test:** 2,000 rows with no answers. Each one is a different aircraft seen once.
- **The task:** for every test row, say Yes or No: will this actuator fail in the next 30 days?
- **The score:** F1 on the Yes rows, from 0 to 100. Accuracy is reported but does not rank teams.
- **One submission only**, with no feedback before the deadline.

## What to submit
**`submission/case_1_predictions.csv`** and nothing else. It has the exact header, all 2,000 IDs, and only Yes or No. It passed every rule in the submission guidelines (filename, no extra columns, no blanks, plain UTF-8).

## What we found in the data
1. **The data is clean.** No duplicates, no impossible values, no bad labels. About 4% of each sensor reading is blank on purpose. We never drop a row.
2. **8% of rows are Yes.** Every Yes is one of the last 4 or 5 weekly records before an actuator fails.
3. **The raw readings are misleading.** Each diagnostic test uses different reference settings, and those settings scale the readings. Once we divide them out, the picture is clear:
   - actuation time ÷ (reference time × load ratio) is the strongest signal by far
   - leakage ÷ reference flow is the second
   - pressure variation is a weaker third
4. **Actuator age does not help**, and it looks different in the test set, so we leave it out.
5. **The test set looks like the training set** on the readings that matter.

## The model
A weighted average of two models:
- **75% logistic regression** with squared and pairwise terms. It is smooth and gave the best F1 on unseen aircraft.
- **25% gradient-boosted trees (LightGBM)**, not allowed to lower the risk when a wear reading rises.

A row is predicted **Yes when its risk is 0.29 or more**. We chose that cut-off because it gives the best average F1 over 300 resampled fleets, not one lucky split.

## How good is it
Always tested on aircraft the model never saw.

| Check | F1 | Precision | Recall | Accuracy |
|---|---|---|---|---|
| Cross-validation (5 folds × 4 repeats) | **0.71** | 0.64 | 0.79 | 0.95 |
| One split: train on 80 aircraft, test on 20 | 0.68 | 0.63 | 0.74 | 0.94 |

- Out of 797 real failures-within-30-days, it catches about 631 and misses 166, with about 351 false alarms.
- From fleet to fleet, F1 moves between 0.68 and 0.73.
- On the test set it predicts **214 Yes** out of 2,000.

## Why not higher?
Each test row is one snapshot. Readings four weeks before a failure look almost the same as readings six weeks before. We tried logistic regression, LightGBM, XGBoost, a remaining-life regressor, several blends and smarter handling of blanks. **They all stop near F1 0.70.** That is the limit of the information in one row.

What separates teams:
- Without dividing by the reference settings, the same models reach only about 0.65.
- Testing on random rows instead of whole aircraft gives numbers that look better than they are.
- Tuning for accuracy instead of F1 picks the wrong cut-off.

## Run it again
```
.venv\Scripts\python risk_model\stage2\case1.py
```
It checks the data, validates, trains, predicts the test set, writes the CSV and checks its format. It takes about a minute.

## Questions judges may ask
**"Which algorithm?"** A blend of logistic regression and gradient-boosted trees, on readings corrected for their reference settings.

**"How do you know it isn't overfitting?"** Every score comes from aircraft held out of training. The trees are small and constrained. We left out age because it behaves differently in the test set.

**"Why is F1 only about 0.7 when accuracy is 95%?"** Only 8% of rows are Yes, so accuracy is easy and says little. F1 only counts how well we find the Yes rows.

**"What matters most for predicting failure?"** How slow the actuator is for its reference time and load, then how much it leaks for its reference flow.
