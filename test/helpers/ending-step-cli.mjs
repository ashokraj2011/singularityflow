/**
 * The CLI, run in this process with one change: the decision list reads the current step as the one
 * that ends the Story, so it lists the Story's open upstream issues for that step's approvers to
 * decide. Only a Story's last step lists them, and reaching one in a fixture means implementing and
 * verifying it; test/oap-m4-one-ceremony.test.mjs uses this to record such a decision with a
 * planning approval. Everything else, the approval and its commit included, is the real CLI.
 *
 *   node --experimental-test-module-mocks test/helpers/ending-step-cli.mjs <CLI ARGUMENTS>
 */
import { mock } from 'node:test';

const source = new URL('../../src/', import.meta.url);
const real = await import(new URL('decision-list-reads.mjs?real', source).href);
mock.module(new URL('decision-list-reads.mjs', source).href, {
  namedExports: {
    ...real,
    async readPendingList(root, config, workflow, { phaseId = null, at = new Date().toISOString(), requestedPhase = phaseId, offline: ignored, ...known } = {}) {
      const [{ decisionPacket }, { actionActor }] = await Promise.all([
        import(new URL('decision-list.mjs', source).href), import(new URL('commands/kernel.mjs', source).href)]);
      const facts = await real.decisionListFacts(root, config, workflow, { phaseId: phaseId ?? workflow.currentPhase, at, ...known });
      return decisionPacket(workflow, { ...facts, endsStory: true }, {
        authorities: workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities, actor: actionActor(root), at, requestedPhase
      });
    }
  }
});
const { main } = await import(new URL('cli-entry.mjs', source).href);
await main(process.argv.slice(2)).catch(async (error) => {
  const { reportCliFailure } = await import(new URL('cli-failure.mjs', source).href);
  await reportCliFailure(error, process.argv.slice(2));
});
