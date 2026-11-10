# Case 1 (release v2): model report

## Data check
- Training rows: 10,000. Test rows: 2,000.
- Duplicate rows: 0 in training, 0 in test. Duplicate test IDs: 0.
- Aircraft: 100 in training (each with 100 weekly records), 2000 in test (one record each).
- Target: 797 Yes and 9203 No (8.0% Yes). Other labels: 0.
- Missing values (the organisers say these are intentional): Ambient_Temperature_C 4.0% train / 4.6% test; Hydraulic_Pressure_PSI 4.2% train / 3.8% test; Pressure_Variation_PSI 3.7% train / 3.4% test; Hydraulic_Fluid_Temperature_C 4.1% train / 4.6% test; Internal_Leakage_Rate_mL_Min 3.9% train / 4.0% test; Actuation_Time_Seconds 4.2% train / 4.5% test.
- Cleaning: every value is inside its allowed range and every fluid grade is valid, so nothing had to be corrected.

## Model
- A weighted average of two models: 75% a logistic regression (with squared and pairwise terms) and 25% small gradient-boosted trees (LightGBM) that are not allowed to lower the risk when a wear reading rises.
- The key step is dividing the raw readings by their reference settings: actuation time by (reference time x load ratio), and leakage by reference flow. The reference settings change at every test.
- Not used: aircraft ID, actuator ID, date and case ID (the rules forbid them), and actuator age (it adds nothing once the readings are known, and it is distributed differently in the test set).
- Missing readings: the trees handle them directly; the logistic part uses the training median plus a flag.

## How good is it
All scores are on aircraft the model never saw during training.

| Check | F1 | Precision | Recall | Accuracy |
|---|---|---|---|---|
| Cross-validation, 5 folds x 4 repeats | **0.709** | 0.662 | 0.763 | 0.950 |
| Same cross-validation, replacement actuators only (the kind in the test set) | 0.740 | 0.696 | 0.791 | 0.963 |
| One split: train on 80 aircraft, test on 20 | 0.683 | 0.633 | 0.743 | 0.943 |

- F1 varies between repeats by ±0.002, and from fleet to fleet between 0.682 and 0.729 (5th to 95th percentile).
- Ranking quality: average precision 0.754, AUC 0.971.
- Per repeat at the chosen cut-off: about 608 failures caught, 189 missed, 310 false alarms, out of 797 Yes rows.
- The one split: 124 caught, 43 missed, 72 false alarms among 2000 rows.

## Yes/No cut-off
- A row is predicted Yes when its risk is at least **0.32**.
- How it was chosen: every training aircraft starts on an original actuator that was already part-worn, but the test set is recorded months later, when nearly every aircraft is on a replacement fitted new. So the cut-off is the one with the best average F1 over 300 resampled fleets on replacement actuators, weighted to the test set's fluid-grade mix. Cut-offs within 0.001 of the best count as tied, and the tie goes to the one that scores best on all rows.
- On all training rows the best cut-off is 0.29. There, 0.32 scores 0.708 against 0.709, so the choice costs almost nothing on the full data.
- F1 on replacement actuators near the cut-off: 0.26 gives 0.726, 0.28 gives 0.734, 0.30 gives 0.737, 0.32 gives 0.742, 0.34 gives 0.741, 0.36 gives 0.742, 0.38 gives 0.733.
- F1 on all rows near the cut-off: 0.26 gives 0.702, 0.28 gives 0.707, 0.30 gives 0.708, 0.32 gives 0.708, 0.34 gives 0.705, 0.36 gives 0.702, 0.38 gives 0.697.

## Test set predictions
- Predicted Yes: **203** of 2,000 (10.2%). In training, 8.0% of rows are Yes.
- The model's own estimate of the number of true Yes rows in the test set: about 176.
- F1 the model expects on the test set from its own probabilities: about 0.72.
- Cross-check of the cut-off: judged only by the test set's own probabilities, the best number to flag would be 192. The training-based cut-off flags 203.
- File: `submission/case_1_predictions.csv`. Format check: passed every rule.

## What drives the predictions
- Logistic part, largest standardised weights: log_t_norm +2.07, leak_norm +0.53, sqrt_leak_norm +0.47, pv +0.47, fc +0.44, amb -0.35.
- Tree part, share of total gain: t_norm 54%, leak_norm 27%, pv 3%, fc 2%, ft 2%, amb 2%.

## Limits
- Each test row is one snapshot. Readings four weeks before a failure look almost the same as readings six weeks before, so no model can separate them perfectly. Every method we tried stops near the same F1.
- The test set mixes fluid grades more evenly than training and has younger actuators. The readings themselves are distributed alike, and age is not used, so this should not hurt.
