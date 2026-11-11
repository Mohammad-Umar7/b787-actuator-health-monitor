# AcuMain: Case 1 model (Team Maze, Al Ain University)

| File | What it is |
|---|---|
| `predict.py` | The script. It loads the model, scores a file and writes the Yes/No predictions |
| `case1_model.joblib` | The trained model with its fitted preprocessing and the Yes/No cut-off (0.32) |
| `case_1_predictions.csv` | Our predictions for the 2,000 official test records (203 Yes) |
| `case_1_test_inputs.csv` | The official Stage 2 test inputs, so the test runs straight away |

## How to test

1. Install Python 3.11, then the exact library versions the model was saved with:

   ```
   pip install joblib==1.6.0 lightgbm==4.7.0 numpy==2.4.6 openpyxl==3.1.5 pandas==3.1.1 scikit-learn==1.9.1 scipy==1.17.1
   ```

2. Open a terminal in this folder (the test file is already here) and run:

   ```
   python predict.py case_1_test_inputs.csv
   ```

   This writes `predictions.csv`. On the official test file it is exactly our `case_1_predictions.csv`.
   Excel works too: `python predict.py your_file.xlsx -o my_predictions.csv`.

**Input:** a CSV or Excel file with the same columns as `case_1_test_inputs.csv`. Blank readings are
allowed. Aircraft, actuator, date and age columns are ignored.

**Output:** `Case_ID,Failure_Next_30_Days`, with Yes or No for each record. Yes means the model's risk of
failure within 30 days is 0.32 or more. Add `--with-risk` to also get `Risk_Percent` and `Risk_Level`.

**To get the score:** add a `Failure_Next_30_Days` column with the real Yes/No answers to the input. The
script then prints the F1, precision, recall and accuracy.
