import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Secret storage.
 *
 * Three ways to supply a token, in the order an enterprise should prefer them:
 *
 *  1. **A secret manager**, `STRATA_GITHUB_TOKEN_FILE` points at a mounted file. This is
 *     how Google Secret Manager, Vault and Kubernetes secrets all present themselves,
 *     so one mechanism covers every one of them and the token never touches our disk.
 *  2. **An environment variable**, `GITHUB_TOKEN`. Fine for a small deployment.
 *  3. **Pasted into the UI**, stored here, encrypted at rest, for teams without either.
 *
 * The encryption is honest about what it is: it stops a token being readable in a
 * backup or a stray `cat`, and it is not a substitute for a real secret manager. The key
 * derives from a machine-local file, so copying the encrypted blob elsewhere is useless.
 */

const ALGORITHM = "aes-256-gcm";

export type SecretSource = "file" | "environment" | "stored" | "none";

export interface SecretStatus {
  configured: boolean;
  source: SecretSource;
  /** Last four characters, so someone can tell which token is in place. */
  hint?: string;
  /** True when the UI may replace it. A managed secret must be changed at its source. */
  editable: boolean;
}

interface SecretFile {
  version: 1;
  /** `<ivHex>.<authTagHex>.<cipherHex>` */
  githubToken?: string;
  githubTokenHint?: string;
  /**
   * Arbitrary named secrets, for integration providers.
   *
   * Kept beside `githubToken` rather than folding that into this map, because the GitHub token
   * has precedence rules this one does not, it can come from a mounted file or an environment
   * variable so a deployment can promote to a real secret manager. Integration credentials are
   * entered by an operator in the UI and only ever live here.
   */
  entries?: Record<string, { value: string; hint: string }>;
}

export class SecretStore {
  private cache: SecretFile | undefined;

  constructor(private readonly dataDir: string) {}

  private get path(): string {
    return join(this.dataDir, "secrets.json");
  }

  private get keyPath(): string {
    return join(this.dataDir, "secret.key");
  }

  /** A machine-local key, generated once. */
  private async key(): Promise<Buffer> {
    let material: string;
    try {
      material = await readFile(this.keyPath, "utf8");
    } catch {
      material = randomBytes(32).toString("hex");
      await mkdir(this.dataDir, { recursive: true });
      await writeFile(this.keyPath, material, { encoding: "utf8", mode: 0o600 });
    }
    return scryptSync(material, "strata-secret-store", 32);
  }

  private async load(): Promise<SecretFile> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.path, "utf8")) as SecretFile;
    } catch {
      this.cache = { version: 1 };
    }
    return this.cache;
  }

  /**
   * The token to use, honouring the precedence above.
   *
   * A file or environment variable always wins over a stored one, so promoting a
   * deployment to a real secret manager does not require clearing the UI first.
   */
  async githubToken(): Promise<string | undefined> {
    const fromFile = process.env.STRATA_GITHUB_TOKEN_FILE;
    if (fromFile) {
      try {
        const value = (await readFile(fromFile, "utf8")).trim();
        if (value) return value;
      } catch {
        // Mounted but unreadable: fall through rather than failing every git call.
      }
    }

    const fromEnv = process.env.GITHUB_TOKEN ?? process.env.STRATA_GITHUB_TOKEN;
    if (fromEnv) return fromEnv;

    const file = await this.load();
    if (!file.githubToken) return undefined;
    try {
      return await this.decrypt(file.githubToken);
    } catch {
      return undefined;
    }
  }

  async status(): Promise<SecretStatus> {
    if (process.env.STRATA_GITHUB_TOKEN_FILE) {
      const token = await this.githubToken();
      return {
        configured: Boolean(token),
        source: "file",
        ...(token ? { hint: token.slice(-4) } : {}),
        editable: false,
      };
    }

    const fromEnv = process.env.GITHUB_TOKEN ?? process.env.STRATA_GITHUB_TOKEN;
    if (fromEnv) {
      return { configured: true, source: "environment", hint: fromEnv.slice(-4), editable: false };
    }

    const file = await this.load();
    return file.githubToken
      ? {
          configured: true,
          source: "stored",
          ...(file.githubTokenHint ? { hint: file.githubTokenHint } : {}),
          editable: true,
        }
      : { configured: false, source: "none", editable: true };
  }

  async setGithubToken(token: string | undefined): Promise<void> {
    const file = await this.load();
    if (!token) {
      delete file.githubToken;
      delete file.githubTokenHint;
    } else {
      file.githubToken = await this.encrypt(token);
      file.githubTokenHint = token.slice(-4);
    }
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.path, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  /**
   * Read one named secret.
   *
   * Environment first, so a container can inject `STRATA_SECRET_JIRA_TOKEN` without anyone typing
   * a credential into a browser. The name is upper-cased and non-alphanumerics become
   * underscores, which is the only shape an environment variable can take.
   */
  async get(name: string): Promise<string | undefined> {
    const fromEnv = process.env[`STRATA_SECRET_${envName(name)}`];
    if (fromEnv) return fromEnv;

    const file = await this.load();
    const stored = file.entries?.[name];
    if (!stored) return undefined;
    try {
      return await this.decrypt(stored.value);
    } catch {
      // A secret encrypted with a key that has since been regenerated. Treat as absent rather
      // than throwing, so one unreadable credential does not break every other integration.
      return undefined;
    }
  }

  /** Which named secrets exist, and the last four characters of each. Never the value. */
  async listNames(): Promise<{ name: string; hint: string; source: "environment" | "stored" }[]> {
    const file = await this.load();
    const stored = Object.entries(file.entries ?? {}).map(([name, entry]) => ({
      name,
      hint: entry.hint,
      source: "stored" as const,
    }));

    /*
      Environment-provided secrets are listed too, and win.

      Without this the UI would show a provider as unconfigured while it was working perfectly
      from an injected variable, and the operator's fix would be to paste the credential in,
      creating a second copy of it.
    */
    const fromEnv = Object.keys(process.env)
      .filter((key) => key.startsWith("STRATA_SECRET_"))
      .map((key) => ({
        name: key.slice("STRATA_SECRET_".length).toLowerCase(),
        hint: (process.env[key] ?? "").slice(-4),
        source: "environment" as const,
      }));

    // Widened explicitly: inference from `stored` alone narrows `source` to `"stored"`, and the
    // environment entries then cannot be written into the same map.
    const byName = new Map<string, { name: string; hint: string; source: "environment" | "stored" }>(
      stored.map((entry) => [envName(entry.name), entry]),
    );
    for (const entry of fromEnv) byName.set(envName(entry.name), entry);
    return [...byName.values()];
  }

  async set(name: string, value: string | undefined): Promise<void> {
    const file = await this.load();
    file.entries ??= {};

    if (!value) delete file.entries[name];
    else file.entries[name] = { value: await this.encrypt(value), hint: value.slice(-4) };

    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.path, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  private async encrypt(value: string): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, await this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), encrypted.toString("hex")].join(".");
  }

  private async decrypt(blob: string): Promise<string> {
    const [ivHex, tagHex, dataHex] = blob.split(".");
    if (!ivHex || !tagHex || !dataHex) throw new Error("malformed secret");
    const decipher = createDecipheriv(ALGORITHM, await this.key(), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
  }
}

/** A secret name as an environment variable suffix: `jira.token` becomes `JIRA_TOKEN`. */
function envName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
}
