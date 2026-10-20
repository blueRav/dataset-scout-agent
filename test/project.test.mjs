import test from "node:test";
import assert from "node:assert/strict";
import { createProject, fixture, splitRows, fit, mean } from "../src/project.mjs";
test("selection uses validation data and evaluates the held-out set once", async () => {
  const p = createProject(); const s = await p.createAgent().run({ goal: p.goal });
  assert.equal(s.status, "complete"); assert.equal(p.world.selection, "linear");
  assert.ok(p.world.models.linear.validationMse < p.world.models.mean.validationMse);
  assert.equal(p.world.testEvaluations, 1); assert.equal(p.world.testResult.rows, 6);
});
test("post-outcome features are rejected", () => {
  assert.throws(() => createProject().tools.fit_model.execute({ type: "linear", feature: "future_revenue" }), /prediction time/);
});
test("imputation statistics use only training rows", () => {
  const train = splitRows(fixture.rows).train;
  const model = fit(train, "linear", "campaign_spend");
  const trainingMean = mean(train.map(row => row.campaign_spend).filter(value => typeof value === "number"));
  const fullMean = mean(fixture.rows.map(row => row.campaign_spend).filter(value => typeof value === "number"));
  assert.equal(model.imputationMean, trainingMean); assert.notEqual(model.imputationMean, fullMean);
});
test("the test set cannot be evaluated before model selection", () => {
  assert.throws(() => createProject().tools.evaluate_test.execute({}), /Select a model/);
});
test("selection freezes refitting", async () => {
  const p = createProject(); await p.createAgent().run({ goal: p.goal });
  assert.throws(() => p.tools.fit_model.execute({ type: "mean", feature: "campaign_spend" }), /frozen/);
});
test("repeated test reads do not create new evaluations", async () => {
  const p = createProject(); await p.createAgent().run({ goal: p.goal }); p.tools.evaluate_test.execute({});
  assert.equal(p.world.testEvaluations, 1);
});
test("undersized datasets fail clearly", () => {
  assert.throws(() => splitRows(fixture.rows.slice(0, 5)), /at least 15/);
});
