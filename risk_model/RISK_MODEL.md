# The risk model, explained for the team

Everyone on the team should be able to answer questions about this. Read it once before the pitch.

## What it does
For each aircraft record it gives:
- the **chance the nose gear actuator fails in the next 30 days** (a percentage)
- a **range** around that percentage, showing how sure we are
- a **level**: Low, Medium or High
- the **main factors** behind the number

## The algorithm
It is a **logistic regression**: a scoring formula. Each warning sign adds points, and the total is turned into a percentage.

We added two safety rules:
1. **Warning signs can only raise the risk, never lower it.** Worse leakage can never produce a lower score.
2. **A penalty stops any single column from dominating.** We fixed its strength in advance using a standard default from statistics (Gelman et al., 2008). We did not tune it to our 36 rows, and it relaxes by itself as more data arrives.

### The actual formula
| Reading | Points |
|---|---|
| Starting point | −6.29 |
| Each step up in leakage (Normal → Slightly High → High → Very High) | +0.92 |
| Each step up in operation time (Normal → Slightly High → High) | +2.64 |
| Actuator age | +0.00 (see below) |

Risk = 1 / (1 + e^(−points))

**Worked example, B787-008 in March:** leakage Very High (3 steps), operation time High (2 steps).
Points = −6.29 + 3 × 0.92 + 2 × 2.64 = 1.73, which gives **85%**.

### Levels
- **High: 50% or more.** More likely than not to fail within 30 days.
- **Medium: 5% to 50%.** Worth an inspection if a failure costs at least 20 times an inspection. That ratio is our assumption. Ask a GAL mentor for the real one and we change one number.
- **Low: under 5%.**

## How we tested it
The data has only 36 rows, 10 aircraft and 6 failures, so the testing matters more than the model.

| Test | Result |
|---|---|
| **Unseen aircraft.** Hide one aircraft, train on the other nine, score the hidden one. Repeat for all ten. | Caught **6 of 6** failures, **1 false alarm** in 30 healthy records |
| **The future.** Train on January to March only, then score April. | Caught **2 of 2**, no false alarms |
| **Penalty setting.** Repeat the first test with the penalty anywhere from much stronger to much weaker. | Same result (6 of 6, 1 false alarm) across the range 0.75 to 3.0 |

The one false alarm is B787-008 in February. It was High/High and did not fail within 30 days, but it failed the month after. So it was an early warning.

## Why not a fancier model?
We tested decision tree, random forest, gradient boosting and a monotone gradient boosting. On the unseen-aircraft test they all score about the same as ours (5 or 6 of 6 caught).

The difference shows on readings the data never contained:

| Situation | Ours | Decision tree | Gradient boosting |
|---|---|---|---|
| Leakage Very High, operation only Slightly High | 29% | 0% | 0% |
| Leakage Normal, operation High | 26% | 100% | 100% |
| Leakage Slightly High, operation Slightly High | 6% | 0% | 0% |

The tree models learned one rule: "operation time High means failure, anything else is safe". Ours gives a graded answer. With 6 failures, a complex model has nothing extra to learn, only more ways to be wrong on new data.

## When they give us more data
The model was built for this.

**Score a new file with the model as it is:**
```
.venv\Scripts\python risk_model\risk_model.py predict "path\to\new file.xlsx"
```
- Works with Excel or CSV.
- Copes with different capital letters, extra columns, columns in a different order, new aircraft and new months.
- Reads labels like "slightly-high" or "VERY HIGH". If it can't read a value, it uses a typical value and says so in the `Data_Notes` column.
- If the file includes the Yes/No answers, it prints how many failures it caught and missed.

**Retrain on the old and new data together** (only if the new file has the answers):
```
.venv\Scripts\python risk_model\risk_model.py train "data\Cases Data.xlsx" "path\to\new file.xlsx"
```
This rewrites the model and the validation report, and reruns every test above.

**Rehearsal:** we made up a fleet of 60 aircraft (303 rows) to practise the handover. The model trained on the 36 real rows, left unchanged, caught 30 of 34 failures in it. After retraining on both, the penalty dropped from 0.018 to 0.002 by itself. That fleet is simulated, so don't quote those numbers as results.

## What's in the folder
| File | What it is |
|---|---|
| `risk_model.py` | All the code: cleaning, model, tests, scoring |
| `artifacts/model.json` | The trained model (the weights above, plus 500 refits for the ranges) |
| `artifacts/validation_report.md` | Full test results, regenerated on every training run |
| `artifacts/fleet_risk.csv` | Latest risk per aircraft |
| `artifacts/training_scores.csv` | Every row with its risk, including the unseen-aircraft score |
| `tests/test_risk_model.py` | Checks for messy labels, unseen readings, bigger data |

First-time setup on a new laptop:
```
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

## Questions judges may ask
**"Why such a simple model?"**
Six failures can't support a complex one. We tested four others. They tie on accuracy and break on readings they haven't seen. Ours stays sensible.

**"How do you know it isn't overfitting?"**
It is always tested on aircraft it never saw. It also predicted April from January to March. The penalty was fixed in advance, not tuned. And the result doesn't change across a wide range of penalty settings.

**"What does 69% mean?"**
In the data, 5 of 6 actuators with High leakage and High operation time failed within 30 days. That would be 83%. Our model is deliberately more cautious because it's only 6 cases: 69%, with a range of 53% to 86%.

**"Why is B787-007 only 6%?"**
The score covers the next 30 days only. No actuator in that state failed within 30 days. It's still flagged Medium because both readings have started to rise.

**"Why does actuator age have no weight?"**
Once we know leakage and operation time, age adds nothing in this data. The condition of the part tells us more than its age. If new data shows age matters, retraining will pick it up.

**"What are the ranges?"**
We retrained the model 500 times, each time on a different random mix of the aircraft. The range is where the middle 80% of those answers fall.

## Limits (say these before a judge does)
- Six failures is very little evidence.
- Leakage and operation time arrive as labels, so we treat each step up as the same size. Real sensor numbers would be better.
- The score covers 30 days only.
- Almost all the signal comes from one column, operation time. Without it the model catches 1 of 6.
