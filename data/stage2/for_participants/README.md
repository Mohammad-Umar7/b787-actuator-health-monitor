# Ministry Hackathon - participant data, release v2

Each case folder contains a problem-description PDF, a training workbook with 10,000 labeled rows and a data dictionary, an unlabeled test CSV with 2,000 rows, and a submission_guidelines folder with the exact rules and an ID-filled prediction template.

Read the problem description, data dictionary and submission guidelines before starting. Use all v2 files together; do not mix them with an earlier release. Case 2 and Case 3 identifiers include a V2 prefix. Use the supplied identifiers exactly.

Select targets by their names; do not assume that they are the final columns. Train and validate using the labeled training data. Fit imputation, encoding and other preprocessing on training data. Missing input measurements are intentional; every test row still requires a prediction. Each test row is a single prediction case. No additional observation sequences are required. Construct test predictions from each row and parameters learned from training; do not join later test rows to create earlier prediction features. Case 3 duty summaries describe independent synthetic screening scenarios, not a continuous shared aircraft operating history.

The primary score is positive-class F1 on a 0-100 scale. For Case 2, Maintenance_Delay, Delay_Hours and Main_Delay_Factor are three targets: exclude all three from input features. Duration and factor metrics are also reported as described in the guidelines.

Submit one completed CSV per entered case, using the required filename, exact header and all 2,000 supplied IDs. Invalid files are discarded without scoring. Remove _template from the template filename after filling every output. Do not add explanations, probabilities, extra columns or extra rows to the scored CSV.

All identifiers and records are synthetic educational data. Ranges are illustrative assumptions, not certified aircraft maintenance limits. Hidden-test answers and organizer generation materials are not part of this participant package.
