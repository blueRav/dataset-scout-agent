import { Agent, copy, objectSchema, str } from "./agent.mjs";
export const fixture = {
  rows: Array.from({ length: 30 }, (_, i) => {
    const spend = 10 + i * 2;
    const units = 20 + spend * 1.7 + [0, 1, -1][i % 3];
    return { day: i + 1, campaign_spend: i % 11 === 0 ? null : spend, units, future_revenue: units * 12 };
  }),
  models: {}, selection: null, testResult: null, testEvaluations: 0, report: null
};
export const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const present = value => typeof value === "number" && Number.isFinite(value);
export function splitRows(rows) {
  if (rows.length < 15 || rows.some(row => !present(row.units))) throw Error("Need at least 15 rows with finite targets");
  const trainEnd = Math.floor(rows.length * 0.6), validationEnd = Math.floor(rows.length * 0.8);
  return { train: rows.slice(0, trainEnd), validation: rows.slice(trainEnd, validationEnd), test: rows.slice(validationEnd) };
}
export function fit(rows, type, feature) {
  if (!["mean", "linear"].includes(type)) throw Error("Unsupported model");
  if (feature !== "campaign_spend") throw Error("Feature unavailable at prediction time");
  const observed = rows.map(row => row[feature]).filter(present);
  if (!observed.length) throw Error("Feature is entirely missing in training");
  const imputationMean = mean(observed), xs = rows.map(row => present(row[feature]) ? row[feature] : imputationMean);
  const ys = rows.map(row => row.units), xMean = mean(xs), yMean = mean(ys);
  const variance = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
  const covariance = xs.reduce((sum, x, i) => sum + (x - xMean) * (ys[i] - yMean), 0);
  const slope = type === "linear" && variance > 0 ? covariance / variance : 0;
  return { type, feature, imputationMean, slope, intercept: yMean - slope * xMean, trainedOn: rows.length };
}
export function predict(model, row) {
  const x = present(row[model.feature]) ? row[model.feature] : model.imputationMean;
  return model.intercept + model.slope * x;
}
export const mse = (model, rows) => mean(rows.map(row => (predict(model, row) - row.units) ** 2));
export function createProject(world = copy(fixture)) {
  const split = splitRows(world.rows);
  const tools = {
    profile_data: {
      description: "Inspect row counts, missing feature counts, the chronological split, and forbidden post-outcome columns.",
      parameters: objectSchema({}),
      execute: () => ({
        rows: world.rows.length, target: "units", allowedFeatures: ["campaign_spend"], forbiddenFeatures: ["future_revenue"],
        missingCampaignSpend: world.rows.filter(row => !present(row.campaign_spend)).length,
        split: { train: split.train.length, validation: split.validation.length, test: split.test.length },
        warning: "future_revenue is measured after the target and would leak the outcome"
      })
    },
    fit_model: {
      description: "Fit an allowed baseline on training rows; score on validation rows. Imputation learns only from training data.",
      parameters: objectSchema({ type: str({ enum: ["mean", "linear"] }), feature: str() }),
      execute: ({ type, feature }) => {
        if (world.selection) throw Error("Selection is frozen; refitting after selection is forbidden");
        const model = fit(split.train, type, feature);
        const validationMse = mse(model, split.validation);
        world.models[type] = { ...model, validationMse };
        return { type, trainedOn: model.trainedOn, imputationMean: model.imputationMean, validationMse };
      },
      write: true
    },
    select_model: {
      description: "Freeze the model with the lowest validation MSE; test rows are not used for selection.",
      parameters: objectSchema({}),
      execute: () => {
        if (!world.models.mean || !world.models.linear) throw Error("Compare mean and linear baselines before selection");
        if (!world.selection) world.selection = Object.values(world.models).sort((a, b) => a.validationMse - b.validationMse || a.type.localeCompare(b.type))[0].type;
        return { selected: world.selection, validationMse: world.models[world.selection].validationMse };
      },
      write: true
    },
    evaluate_test: {
      description: "Evaluate the frozen model on the held-out test rows once. This locks model selection.",
      parameters: objectSchema({}),
      execute: () => {
        if (!world.selection) throw Error("Select a model before opening the test set");
        if (!world.testResult) {
          world.testResult = { model: world.selection, mse: mse(world.models[world.selection], split.test), rows: split.test.length };
          world.testEvaluations++;
        }
        return world.testResult;
      },
      write: true
    },
    submit_report: {
      description: "Build a report directly from validated experiment results, including leakage controls and limitations.",
      parameters: objectSchema({}),
      execute: () => {
        if (!world.testResult) throw Error("Held-out evaluation is required");
        world.report = {
          selected: world.selection,
          validation: Object.values(world.models).map(model => ({ model: model.type, mse: model.validationMse })),
          test: world.testResult, trainingRows: split.train.length,
          controls: ["chronological 60/20/20 split", "training-only mean imputation", "post-outcome feature blocked", "selection frozen before test"],
          limitations: ["Small synthetic dataset", "No causal claims", "Uncertainty intervals are not estimated"]
        };
        return world.report;
      },
      write: true
    }
  };
  const planner = async ({ observations }) => {
    const did = name => observations.some(o => o.tool === name && o.ok);
    if (observations.some(o => !o.ok)) return { type: "final", text: "Experiment stopped after a validation error." };
    if (!did("profile_data")) return { type: "tool", name: "profile_data", args: {} };
    for (const type of ["mean", "linear"]) {
      if (!observations.some(o => o.tool === "fit_model" && o.ok && o.result.type === type)) return { type: "tool", name: "fit_model", args: { type, feature: "campaign_spend" } };
    }
    for (const name of ["select_model", "evaluate_test", "submit_report"]) if (!did(name)) return { type: "tool", name, args: {} };
    return { type: "final", text: "Selected " + world.selection + " using validation data; held-out MSE " + world.testResult.mse.toFixed(3) + ". See the submitted report for limitations." };
  };
  const validateFinal = () => { if (!world.report || world.testEvaluations !== 1) throw Error("A single held-out evaluation and submitted report are required"); };
  const instructions = "Profile the dataset, compare mean and linear models using only campaign_spend, freeze selection by validation MSE, evaluate the test set once, and submit_report. Never use future_revenue.";
  return {
    world, tools, planner, validateFinal,
    instructions,
    goal: "Analyze campaign spend versus units while preventing target leakage and test-set-driven model selection.",
    createAgent: livePlanner => new Agent({ planner: livePlanner || planner, tools, validateFinal, instructions })
  };
}
