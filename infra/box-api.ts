import * as Redacted from "effect/Redacted";

export interface BoxApiOptions {
  apiKey?: Redacted.Redacted<string>;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/** Deliberately carries no response body, command, URL, or underlying cause. */
export class BoxApiError extends Error {
  readonly name = "BoxApiError";
  constructor(readonly operation: string, readonly status?: number) {
    super(`Box API ${operation} failed${status === undefined ? "" : ` (HTTP ${status})`}`);
  }
}

// Leave room for base64 expansion and JSON overhead under the 512 KiB limit.
export const FILE_CHUNK_BYTES = 256 * 1024;
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * Small, non-logging adapter for the Box wire protocol.
 * Intentionally uses the user-verified Authorization: Bearer authentication,
 * diverging from @upstash/box 0.7.9's X-Box-Api-Key header.
 */
export class BoxApi {
  constructor(private readonly options: BoxApiOptions = {}) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // Credentials are resolved only when an operation actually runs, never at import/layer construction.
    const key = this.options.apiKey === undefined
      ? Bun.env.UPSTASH_BOX_API_KEY
      : Redacted.value(this.options.apiKey);
    if (!key) throw new Error("Set UPSTASH_BOX_API_KEY before running Upstash operations");
    if (!path.startsWith("/v2/box") || path.includes("#")) {
      throw new BoxApiError("invalid path");
    }
    const baseUrl = (this.options.baseUrl ?? "https://us-east-1.box.upstash.com").replace(/\/$/, "");
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
        redirect: "error",
      });
    } catch {
      throw new BoxApiError(method);
    }
    if (!response.ok) {
      // Never read an error body: GET box and exec errors can contain plaintext environment secrets.
      await response.body?.cancel().catch(() => {});
      throw new BoxApiError(method, response.status);
    }
    if (response.status === 204) return undefined as T;
    try {
      const text = await response.text();
      return (text === "" ? undefined : JSON.parse(text)) as T;
    } catch {
      throw new BoxApiError(`${method} invalid JSON`, response.status);
    }
  }

  async exec(boxId: string, cmd: string): Promise<string> {
    const result = await this.request<{ exit_code: number; output?: string; stdout?: string }>(
      "POST", `/v2/box/${encodeURIComponent(boxId)}/exec`,
      { command: ["sh", "-c", cmd] },
    );
    if (!Number.isInteger(result?.exit_code)) throw new BoxApiError("exec invalid result");
    if (result.exit_code !== 0) throw new BoxApiError(`exec exit ${result.exit_code}`);
    const output = typeof result.output === "string" ? result.output : result.stdout;
    if (typeof output !== "string") throw new BoxApiError("exec invalid output");
    return output;
  }

  /**
   * files/write has no append/offset API. Write bounded binary chunks to temporary
   * siblings and concatenate via exec, then rename on success. Never interpolate
   * file bytes into shell or diagnostics. Empty files use the same binary endpoint.
   * Secret payloads must be ciphertext before calling this adapter. Each uploaded
   * chunk is chmod 600 before assembly; the destination is atomically replaced
   * with a mode-600 file created under umask 077.
   */
  async write(boxId: string, path: string, bytes: Uint8Array): Promise<void> {
    const resolved = path.startsWith("/") ? path : `/workspace/home/${path}`;
    if (resolved.includes("\0")) throw new BoxApiError("write invalid path");
    const root = `${resolved}.alchemy-${crypto.randomUUID()}`;
    const parts: string[] = [];
    const assembled = `${root}.assembled`;
    try {
      for (let offset = 0; offset < Math.max(1, bytes.byteLength); offset += FILE_CHUNK_BYTES) {
        const part = `${root}.${parts.length}`;
        parts.push(part);
        await this.request("POST", `/v2/box/${encodeURIComponent(boxId)}/files/write`, {
          path: part,
          content: Buffer.from(bytes.subarray(offset, offset + FILE_CHUNK_BYTES)).toString("base64"),
          encoding: "base64",
        });
        await this.exec(boxId, `chmod 600 -- ${quote(part)}`);
      }
      await this.exec(boxId, `umask 077 && cat -- ${parts.map(quote).join(" ")} > ${quote(assembled)} && chmod 600 -- ${quote(assembled)} && mv -- ${quote(assembled)} ${quote(resolved)}`);
    } finally {
      // Cleanup must not shadow a safe primary error (and may be retried by Bootstrap).
      await this.exec(boxId, `rm -f -- ${[...parts, assembled].map(quote).join(" ")}`).catch(() => {});
    }
  }
}
