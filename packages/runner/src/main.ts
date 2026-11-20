import { createRunnerServer, runnerOptionsFromEnv } from "./server.js";

const port = Number(process.env.RUNNER_PORT ?? 4100);
const opts = await runnerOptionsFromEnv();
// Loopback only: the API is the runner's only client.
createRunnerServer(opts).listen(port, "127.0.0.1", () => {
  console.error(
    `@abm/runner listening on http://127.0.0.1:${port} (backend: ${opts.backend}, runner signer ${opts.runnerSigner.address}, reviewer ${(opts.reviewerSigner ?? opts.runnerSigner).address})`,
  );
});
