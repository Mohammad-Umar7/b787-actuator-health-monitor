# AcuMain: B787 nose gear actuator failure risk

Case 1 of the AI for Smart Maintenance Hackathon (MoIAT × GAL, 10–12 Nov 2026).

## Run the dashboard
Double-click `run_dashboard.bat`. It opens http://127.0.0.1:8787/ in the browser.
The first run on a new laptop sets up Python and takes about a minute.

It shows the stage 2 fleet: 100 aircraft with 100 weekly records each, scored by the stage 2 model.
Every risk on the page comes from a model that never saw that aircraft during training.

After the model or the data changes, score the fleet again (about half a minute):
```
run_dashboard.bat --rebuild
```

Live copy: https://acumain.vercel.app

## What the dashboard shows
It is written for managers: what to expect, and what to decide.
- How many aircraft are High, Medium and Low risk. Click a tile to filter.
- An alert naming the aircraft that need action, and why.
- Fleet outlook: failures expected in the next 30 days if nothing is done, the share of the fleet at High risk, the change in four weeks, and the trend by month.
- Fleet priorities: every aircraft ranked by risk, with the reason in plain words, a decision, and the typical time left before failure. Click a column heading to sort.
- For the selected aircraft: its risk, the reasons behind it, how much each reading adds, its readings, and its risk week by week with every actuator replacement marked.
- A date slider to replay the fleet as it was in any week. For past weeks the page also shows what the data recorded in the following 30 days.

## Update the live copy
```
.venv\Scripts\python dashboard\server.py --export
cd dashboard\static
vercel deploy --prod --yes
```

## The model and the submission file
```
.venv\Scripts\python risk_model\stage2\case1.py
```
This trains the stage 2 model, checks it on aircraft it never saw, and writes `submission/case_1_predictions.csv`.
`risk_model/stage2/STAGE2.md` explains it in plain English. Run `run_dashboard.bat --rebuild` afterwards.

The first model, built on the 36-row sample from day 1, is still in `risk_model/risk_model.py`.

## Folders
| Path | Contents |
|---|---|
| `data/` | The datasets and presentation template from the organisers |
| `submission/` | `case_1_predictions.csv`, the file to upload for the leaderboard |
| `risk_model/stage2/` | The stage 2 model (`case1.py`), its report and scores, and `STAGE2.md` |
| `risk_model/` | The day 1 model, its tests, and `RISK_MODEL.md` |
| `dashboard/` | `server.py`, `build_state.py` (scores the fleet for the page) and the page in `static/` |
| `deliverables/` | The filled submission deck, the technical summary PDF, the scripts that build them, and screenshots |
| `demo/` | The narrated demo video and its subtitles |
