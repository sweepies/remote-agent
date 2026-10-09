import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Upstash from "./infra/Upstash.ts";
import * as RemoteAgent from "./infra/Bootstrap.ts";
import { BOX_LABEL, commitPin, dotfilesPin, serviceFingerprints } from "./infra/inputs.ts";

export const GATEWAY_HOST = "agent.ops.sweepy.dev";
// Change deliberately to rotate the preview and its Worker secret together.
export const PREVIEW_ROTATION = "";

export default Alchemy.Stack(
  "remote-agent",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Upstash.providers(), RemoteAgent.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const box = yield* Upstash.Box("remote-agent", {
      name: "remote-agent",
      label: BOX_LABEL,
      size: "large",
      runtime: "node",
      initCommand: '[ ! -x /home/boxuser/.local/bin/remote-agent-start ] || exec /home/boxuser/.local/bin/remote-agent-start',
      networkPolicy: { mode: "allow-all" },
      previewPorts: [3774],
      allowReplace: false,
      destroyOnDelete: false,
    });
    const bootstrap = yield* RemoteAgent.Bootstrap("bootstrap", {
      boxId: box.boxId,
      commit: commitPin(),
      dotfilesPin: dotfilesPin(),
      miseVersion: RemoteAgent.MISE_VERSION,
      miseSha256: RemoteAgent.MISE_ARM64_SHA256,
      opToken: Redacted.make(Bun.env.OP_SERVICE_ACCOUNT_TOKEN ?? ""),
      fingerprints: serviceFingerprints(),
    });
    const preview = yield* Upstash.BoxPreview("relay-preview", { boxId: box.boxId, port: 3774, rotate: PREVIEW_ROTATION });
    yield* Cloudflare.Worker("gateway", {
      main: "./gateway/worker.mjs",
      domain: { name: GATEWAY_HOST, zoneId: "2803e6c8461db5e84f23e71024dff6d6" },
      workersDev: false,
      env: {
        PREVIEW_URL: preview.url,
        PREVIEW_TOKEN: Output.map(preview.token, token => {
          if (!token) throw new Error("Preview did not produce its required bearer token");
          return token;
        }),
      },
    });
    return { boxId: box.boxId, url: `https://${GATEWAY_HOST}`, restart: bootstrap.restart };
  }),
);
