import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { BoxApi, type BoxApiOptions, BoxApiError } from "./box-api.ts";

export type Size = "small" | "medium" | "large";
export type Runtime = "node" | "python" | "golang" | "ruby" | "rust" | "node-alpine" | "python-alpine" | "golang-alpine" | "ruby-alpine" | "rust-alpine";
export type NetworkPolicy = { mode: "allow-all" | "deny-all" } | {
  mode: "custom";
  allowedDomains?: string[];
  allowedCidrs?: string[];
  deniedCidrs?: string[];
};
export interface BoxProps {
  name: string;
  /** Exact identity label; API constraint: 1–20 letters/digits/._-: characters. */
  label: string;
  size?: Size;
  runtime?: Runtime;
  initCommand?: string;
  networkPolicy?: NetworkPolicy;
  /** Allowlist of ports managed by separate BoxPreview resources. Does not create previews. */
  previewPorts?: number[];
  allowReplace?: boolean;
  destroyOnDelete?: boolean;
}

/** Provider-issued deletion consent, persisted with outputs rather than reconstructed from props. */
export interface BoxTombstone {
  provider: "Upstash.Box";
  version: 1;
  boxId: string;
  label: string;
  destroyOnDelete: boolean;
}
export interface BoxAttributes {
  boxId: string;
  name: string;
  label: string;
  size: Size;
  runtime: string;
  status: string;
  tombstone?: BoxTombstone;
}
export type Box = Resource<"Upstash.Box", BoxProps, BoxAttributes>;
export const Box = Resource<Box>("Upstash.Box");

export interface BoxPreviewProps {
  boxId: string;
  port?: number;
  /** Bump this nonce to explicitly delete/recreate a preview and update its consumers. */
  rotate?: string;
}
export interface BoxPreviewAttributes {
  boxId: string;
  port: number;
  url: string;
  // Optional only for discovery: listing cannot recover the creation-time secret.
  token?: Redacted.Redacted<string>;
  /** Last completed explicit rotation generation. */
  rotate?: string;
}
export type BoxPreview = Resource<"Upstash.BoxPreview", BoxPreviewProps, BoxPreviewAttributes>;
export const BoxPreview = Resource<BoxPreview>("Upstash.BoxPreview");

interface LiveBox {
  id: string;
  name?: string;
  labels?: string[];
  size?: Size;
  runtime?: string;
  status: string;
  network_policy?: WirePolicy;
  env_vars?: Record<string, string>;
}
interface WirePolicy {
  mode: string;
  allowed_domains?: string[];
  allowed_cidrs?: string[];
  denied_cidrs?: string[];
}
interface LivePreview {
  id: string;
  port: number;
  url: string;
  bearer_token: boolean;
  basic_auth: boolean;
}
export interface ProviderOptions extends BoxApiOptions {
  /** Injectable only to keep bounded observation fast in offline tests. */
  pollIntervalMs?: number;
  observeAttempts?: number;
}
const attempt = <T>(f: () => Promise<T>) => Effect.tryPromise({
  try: f,
  catch: (error) => error instanceof Error ? error : new Error("Upstash operation failed"),
});
const pathFor = (id: string) => `/v2/box/${encodeURIComponent(id)}`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function validateLabel(label: string) {
  if (!/^[A-Za-z0-9._:-]{1,20}$/.test(label)) throw new Error("Box label must contain 1–20 letters, digits, '.', '_', '-', or ':'");
}
function validatePort(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Preview port must be an integer between 1 and 65535");
}
function wirePolicy(policy: NetworkPolicy = { mode: "allow-all" }): WirePolicy {
  return policy.mode === "custom" ? {
    mode: policy.mode,
    allowed_domains: policy.allowedDomains,
    allowed_cidrs: policy.allowedCidrs,
    denied_cidrs: policy.deniedCidrs,
  } : { mode: policy.mode };
}
function policyKey(policy: WirePolicy = { mode: "allow-all" }) {
  return JSON.stringify([policy.mode, ...(policy.mode === "custom" ? [
    [...(policy.allowed_domains ?? [])].sort(), [...(policy.allowed_cidrs ?? [])].sort(), [...(policy.denied_cidrs ?? [])].sort(),
  ] : [])]);
}
function consent(output: BoxAttributes): BoxTombstone {
  const t = output.tombstone;
  if (!t || t.provider !== "Upstash.Box" || t.version !== 1 || t.boxId !== output.boxId || t.label !== output.label) {
    throw new Error("Refusing Box destruction: missing or inconsistent provider tombstone; reconcile with explicit consent first");
  }
  return t;
}
function attributes(live: LiveBox, label: string, tombstone?: BoxTombstone): BoxAttributes {
  return { boxId: live.id, name: live.name ?? "", label, size: live.size ?? "small", runtime: live.runtime ?? "node", status: live.status, ...(tombstone ? { tombstone } : {}) };
}
function single(boxes: LiveBox[]): LiveBox | undefined {
  if (boxes.length > 1) throw new Error(`Ambiguous Box identity: matching ids ${boxes.map((b) => b.id).sort().join(", ")}`);
  return boxes[0];
}

export async function observeBox(api: Pick<BoxApi, "request">, label: string) {
  validateLabel(label);
  const boxes = await api.request<LiveBox[]>("GET", `/v2/box?label=${encodeURIComponent(label)}`);
  if (!Array.isArray(boxes)) throw new Error("Box list returned an invalid result");
  return single(boxes.filter((b) => b.status !== "deleted"));
}

/** Exported typed services permit focused offline lifecycle probes without a cloud stack. */
export function boxProviderService(options: ProviderOptions = {}) {
  const api = new BoxApi(options);
  const attempts = Math.max(1, Math.min(150, options.observeAttempts ?? 150));
  const interval = options.pollIntervalMs ?? 2000;
  // A lost create response is NOT permission to POST again in this provider instance.
  // There is no server-side idempotency/unique-label guarantee in SDK 0.7.9.
  const uncertain = new Set<string>();
  async function observe(label: string) {
    return observeBox(api, label);
  }
  async function get(id: string): Promise<LiveBox | undefined> {
    try {
      const box = await api.request<LiveBox>("GET", pathFor(id));
      return box.status === "deleted" ? undefined : box;
    } catch (error) {
      if (error instanceof BoxApiError && error.status === 404) return undefined;
      throw error;
    }
  }
  async function ready(box: LiveBox) {
    for (let i = 0; box.status === "creating" && i < attempts; i++) {
      await sleep(interval);
      const next = await get(box.id);
      if (!next) throw new Error("Box disappeared during creation; inspect identity before retrying");
      box = next;
    }
    if (box.status === "creating" || box.status === "error") throw new Error("Box did not become ready; inspect it before retrying");
    return box;
  }
  async function previews(id: string) {
    return (await api.request<{ previews: LivePreview[] }>("GET", `${pathFor(id)}/preview`)).previews;
  }
  return Box.Provider.of({
    // Never skip reconcile merely because props match: live startup/preview drift matters.
    diff: ({ news, olds, output }) => attempt(async () => {
      if (!isResolved(news)) return undefined;
      if (news.label !== olds.label) throw new Error("Box identity label is immutable; use a new resource identity instead");
      if (news.name !== olds.name) throw new Error("Box rename is not supported by API 0.7.9; keep name unchanged");
      if ((news.size ?? "small") !== (olds.size ?? "small") || (news.runtime ?? "node") !== (olds.runtime ?? "node")) {
        if (!news.allowReplace) throw new Error("Box size/runtime replacement destroys the filesystem; set allowReplace explicitly");
        if (!news.destroyOnDelete || !olds.destroyOnDelete || !output || !consent(output).destroyOnDelete) {
          throw new Error("Box replacement requires destroyOnDelete and an already-persisted destructive tombstone; deploy consent before replacing");
        }
        return { action: "replace", deleteFirst: true } as const;
      }
      return { action: "update" } as const;
    }),
    read: ({ olds, output }) => attempt(async () => {
      const live = await observe(olds.label);
      if (!live) return undefined;
      const attrs = attributes(live, olds.label, output?.boxId === live.id && output.label === olds.label ? output.tombstone : undefined);
      return output?.boxId === live.id && output.label === olds.label ? attrs : Unowned(attrs);
    }),
    reconcile: ({ news, output }) => attempt(async () => {
      validateLabel(news.label);
      for (const port of news.previewPorts ?? []) validatePort(port);
      let live = await observe(news.label);
      if (output && (!live || live.id !== output.boxId || output.label !== news.label)) {
        throw new Error("Box label moved or persisted Box is absent; ownership recovery requires explicit adoption. Refusing mutations or creation");
      }
      if (!live) {
        if (!uncertain.has(news.label)) {
          uncertain.add(news.label);
          try {
            // Label is attached atomically in the sole creation request, never added after create.
            live = await api.request<LiveBox>("POST", "/v2/box", {
              name: news.name, labels: [news.label], size: news.size ?? "small", runtime: news.runtime ?? "node",
              init_command: news.initCommand ?? "", network_policy: wirePolicy(news.networkPolicy),
            });
          } catch {
            // Uncertain response: observe only. Do not retry the POST (including 5xx/timeout).
          }
        }
        if (!live) {
          for (let i = 0; i < attempts && !live; i++) {
            await sleep(interval);
            live = await observe(news.label);
          }
        }
        if (!live) throw new Error("Box create outcome uncertain; no second POST issued. Inspect boxes by label before retrying in a new process");
      }
      live = await ready(live);
      // Re-observe identity even after a successful create and GET the actual live box.
      const matched = await observe(news.label);
      if (!matched || matched.id !== live.id) throw new Error("Box label identity changed during reconciliation; refusing mutations");
      const actual = await get(matched.id);
      if (!actual || !actual.labels?.includes(news.label)) throw new Error("Box identity is no longer present; refusing mutations");
      live = actual;
      uncertain.delete(news.label);
      if (live.env_vars && Object.keys(live.env_vars).length > 0) {
        throw new Error("Box has nonempty env_vars. API 0.7.9 has no documented per-box clear operation; remove persisted environment in the console (and account defaults), then reconcile. Secret values were not logged");
      }
      if ((live.size ?? "small") !== (news.size ?? "small") || (live.runtime ?? "node") !== (news.runtime ?? "node")) {
        throw new Error("Observed Box size/runtime differs; refusing in-place filesystem destruction. Resolve drift or perform an explicitly consented replacement");
      }
      if (live.name !== news.name) throw new Error("Observed Box name differs; API 0.7.9 has no rename operation. Resolve name drift in the console");
      const startup = await api.request<{ init_command?: string }>("GET", `${pathFor(live.id)}/startup`);
      if ((startup.init_command ?? "") !== (news.initCommand ?? "")) {
        if (news.initCommand) await api.request("PUT", `${pathFor(live.id)}/startup`, { init_command: news.initCommand });
        else await api.request("DELETE", `${pathFor(live.id)}/startup`);
      }
      if (policyKey(live.network_policy) !== policyKey(wirePolicy(news.networkPolicy))) {
        await api.request("PUT", `${pathFor(live.id)}/config/network-policy`, wirePolicy(news.networkPolicy));
      }
      for (const label of live.labels ?? []) {
        if (label !== news.label) await api.request("DELETE", `${pathFor(live.id)}/config/labels/${encodeURIComponent(label)}`);
      }
      for (const preview of await previews(live.id)) {
        if (!(news.previewPorts ?? []).includes(preview.port)) await api.request("DELETE", `${pathFor(live.id)}/preview/${preview.port}`);
      }
      return attributes(live, news.label, {
        provider: "Upstash.Box", version: 1, boxId: live.id, label: news.label, destroyOnDelete: news.destroyOnDelete ?? false,
      });
    }),
    delete: ({ olds, output }) => attempt(async () => {
      if (!olds?.destroyOnDelete) return;
      if (!consent(output).destroyOnDelete) throw new Error("Refusing Box destruction: persisted tombstone does not authorize deletion");
      const matching = await observe(output.label);
      if (matching && matching.id !== output.boxId) throw new Error("Refusing Box destruction: label now identifies a different box");
      const live = await get(output.boxId);
      if (!live) return;
      if (!matching || !live.labels?.includes(output.label)) throw new Error("Refusing Box destruction: live label does not match provider tombstone");
      try { await api.request("DELETE", pathFor(output.boxId)); }
      catch (error) { if (!(error instanceof BoxApiError && error.status === 404)) throw error; }
    }),
    // Account enumeration cannot manufacture consent for nuke/delete.
    list: () => attempt(async () => (await api.request<LiveBox[]>("GET", "/v2/box")).map((live) => attributes(live, live.labels?.[0] ?? ""))),
  });
}

export function previewProviderService(options: ProviderOptions = {}) {
  const api = new BoxApi(options);
  async function observe(boxId: string, port: number) {
    validatePort(port);
    try {
      const result = await api.request<{ previews: LivePreview[] }>("GET", `${pathFor(boxId)}/preview`);
      const matching = result.previews.filter((p) => p.port === port);
      if (matching.length > 1) throw new Error("Ambiguous Preview identity");
      return matching[0];
    } catch (error) {
      if (error instanceof BoxApiError && error.status === 404) return undefined;
      throw error;
    }
  }
  function attrs(boxId: string, live: LivePreview, prior?: BoxPreviewAttributes): BoxPreviewAttributes {
    return {
      boxId, port: live.port, url: live.url, rotate: prior?.rotate ?? "",
      // A changed URL/auth mode invalidates the saved token; don't claim it still works.
      ...(live.bearer_token && !live.basic_auth && prior?.boxId === boxId && prior.port === live.port && prior.url === live.url && prior.token && Redacted.value(prior.token).length > 0
        ? { token: prior.token } : {}),
    };
  }
  return BoxPreview.Provider.of({
    diff: ({ news, olds }) => {
      if (!isResolved(news)) return Effect.succeed(undefined);
      if (news.boxId !== olds.boxId || (news.port ?? 3774) !== (olds.port ?? 3774)) {
        return Effect.succeed({ action: "replace", deleteFirst: true } as const);
      }
      return Effect.succeed({ action: "update" } as const);
    },
    read: ({ olds, output }) => attempt(async () => {
      const live = await observe(olds.boxId, olds.port ?? 3774);
      if (!live) return undefined;
      const result = attrs(olds.boxId, live, output);
      return output?.boxId === olds.boxId && output.port === live.port ? result : Unowned(result);
    }),
    reconcile: ({ news, output }) => attempt(async () => {
      const port = news.port ?? 3774;
      let live = await observe(news.boxId, port);
      const rotate = news.rotate ?? "";
      if (live && rotate !== (output?.rotate ?? "")) {
        // Explicit rotation is destructive, never an incidental token-recovery operation.
        await api.request("DELETE", `${pathFor(news.boxId)}/preview/${port}`);
        live = await observe(news.boxId, port);
        if (live) throw new Error("Preview still present after explicit rotation deletion; refusing POST");
      }
      if (live) {
        const result = attrs(news.boxId, live, output);
        if (result.token) return result;
        throw new Error("Existing Preview has no usable saved bearer token; explicitly bump Upstash.BoxPreview rotate to delete/recreate it and update Worker bindings in the same deploy");
      }
      // POST only after observing the port missing.
      const created = await api.request<{ url: string; port: number; token?: string }>("POST", `${pathFor(news.boxId)}/preview`, { port, bearer_token: true, basic_auth: false });
      if (!created.token || typeof created.url !== "string" || created.port !== port) throw new Error("Preview API did not return a bearer token for the requested port; no plaintext response was logged");
      return { boxId: news.boxId, port, url: created.url, token: Redacted.make(created.token), rotate };
    }),
    delete: ({ output }) => attempt(async () => {
      if (!(await observe(output.boxId, output.port))) return;
      try { await api.request("DELETE", `${pathFor(output.boxId)}/preview/${output.port}`); }
      catch (error) { if (!(error instanceof BoxApiError && error.status === 404)) throw error; }
    }),
    // Preview has no account-wide enumeration endpoint.
    list: () => Effect.succeed([]),
  });
}

export const BoxProvider = (options: ProviderOptions = {}) => Provider.succeed(Box, boxProviderService(options));
export const BoxPreviewProvider = (options: ProviderOptions = {}) => Provider.succeed(BoxPreview, previewProviderService(options));
export class Providers extends Provider.ProviderCollection<Providers>()("Upstash") {}
export const providers = (options: ProviderOptions = {}) => Layer.effect(Providers, Provider.collection([Box, BoxPreview])).pipe(
  Layer.provideMerge(Layer.mergeAll(BoxProvider(options), BoxPreviewProvider(options))),
);
