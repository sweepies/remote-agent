import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * remote-agent: Zach's agent box on Railway, deployed with alchemy.
 *
 * - Railway.Project "remote-agent": parent container for everything.
 * - Railway.Service "remote-agent": the box itself. Built from ./Dockerfile
 *   via a local Docker context upload (the alchemy equivalent of
 *   `railway up`). No public domain: T3 Connect reaches the phone over an
 *   outbound tunnel, so the box needs no ingress.
 * - Railway.Volume "remote-agent-data": persistent disk mounted at /data
 *   (codex login, t3 link state, agent workdirs survive restarts).
 *
 * State lives in Cloudflare.state() (alchemy's Cloudflare-backed state
 * store) so CI deploys share state with local runs. The first run
 * bootstraps the state-store Worker into the Cloudflare account (one-time
 * prompt); afterwards CI resolves credentials from the Secrets Store.
 *
 * Required env:
 * - RAILWAY_API_TOKEN: account-level Railway token (workspace operations;
 *   project tokens cannot create projects). In CI this comes from the token
 *   broker (GitHub OIDC -> Pocket ID -> broker.ops.sweepy.dev).
 * - FNOX_AGE_KEY: age key for fnox.toml, injected as a Railway variable.
 * - CLOUDFLARE_API_TOKEN: for the state store (from the broker in CI).
 *   NOTE: CLOUDFLARE_ACCOUNT_ID was removed from fnox.toml (Sep 28 2026);
 *   alchemy runs need it in the environment again if revived.
 * - CI=true on CI runners.
 */
const FNOX_AGE_KEY = Redacted.make(Bun.env.FNOX_AGE_KEY ?? "");

export default Alchemy.Stack(
  "remote-agent",
  {
    providers: Railway.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const project = yield* Railway.Project("remote-agent", {
      name: "remote-agent",
      description:
        "Zach's agent box: t3 + codex, phone-reachable dev environment",
    });

    const service = yield* Railway.Service("remote-agent-service", {
      project,
      name: "remote-agent",
      context: ".",
      dockerfilePath: "Dockerfile",
      port: 3773,
      publicDomain: false,
      restartPolicyType: "ALWAYS",
      env: {
        PORT: "3773",
        FNOX_AGE_KEY,
      },
    });

    const data = yield* Railway.Volume("remote-agent-data", {
      project,
      service,
      mountPath: "/data",
    });

    return {
      projectId: project.projectId,
      serviceId: service.serviceId,
      deploymentId: service.deploymentId,
      volumeId: data.volumeId,
    };
  }),
);
