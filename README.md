# B787 nose gear actuator: failure risk model and dashboard

Case 1 of the AI for Smart Maintenance Hackathon (MoIAT × GAL, 10–12 Nov 2026).

## Run the dashboard
Double-click `run_dashboard.bat`. It opens http://127.0.0.1:8787/ in the browser.
The first run on a new laptop sets up Python and takes about a minute.

To show a different data file with the same model:
```
run_dashboard.bat --data "path\to\new file.xlsx"
```
The file needs the columns `Leakage_Level`, `Operation_Time` and `Actuator_Age_Months`. Excel and CSV both work.

## What the dashboard shows
- How many aircraft are High, Medium and Low risk. Click a tile to filter.
- An alert naming the aircraft that need action.
- The fleet ranked by risk, with the likely range and the action for each level. Click a column heading to sort.
- For the selected aircraft: its risk, the reasons behind it, its readings, and its risk month by month.
- A month selector to see the fleet as it was in any month.

## Train or retrain the model
```
.venv\Scripts\python risk_model\risk_model.py train "data\Cases Data.xlsx"
.venv\Scripts\python risk_model\risk_model.py train "data\Cases Data.xlsx" "path\to\new labelled file.xlsx"
```
Restart the dashboard afterwards so it loads the new model.

## Folders
| Path | Contents |
|---|---|
| `data/` | The dataset and presentation template from the organisers |
| `risk_model/` | The model code, its tests, and `RISK_MODEL.md`, a plain-English explanation |
| `risk_model/artifacts/` | The trained model, validation report and scores |
| `dashboard/` | `server.py` and the page in `static/` |
