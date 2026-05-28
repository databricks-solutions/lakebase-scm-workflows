// Spring Initializr client + the deploy orchestrator that ScaffoldService
// used internally. Two surfaces:
//
//   - SpringInitializrClient – HTTP client for start.spring.io's metadata
//     and starter.zip endpoints. Ported from src/services/springInitializrClient.ts.
//   - deploySpringStarter – orchestrates fetch + extract + overlay + pom
//     patch + fallback. Ported from ScaffoldService.deploySpringFromInitializr.
//
// Network-failure fallback uses templates/project/{java,kotlin}/fallback/
// (a bundled pom.xml + mvnw + minimal src tree). Set
// `LAKEBASE_SCAFFOLD_FALLBACK=1` in the environment to force the bundled
// path without trying start.spring.io.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeArtifactId } from "../util/maven-coords.js";
import { copyDirSubstituted } from "../util/copy-dir-substituted.js";
import { extractZipToDir } from "../util/zip-extract.js";
import { patchPomForLakebase } from "../util/pom-patch.js";
import { KIT_TIMEOUTS } from "./kit-config.js";

export type SpringJvmLanguage = "java" | "kotlin";

export interface InitializrMetadata {
  bootVersion: string;
  javaVersion: string;
}

export interface GenerateMavenProjectOptions {
  language: SpringJvmLanguage;
  artifactId: string;
  name?: string;
  groupId?: string;
  packageName?: string;
  description?: string;
}

export class InitializrNetworkError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "InitializrNetworkError";
    this.cause = cause;
  }
}

export class InitializrParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitializrParseError";
  }
}

type FetchFn = typeof fetch;

interface MetadataCache {
  metadata: InitializrMetadata;
  fetchedAt: number;
}

const METADATA_ACCEPT = "application/vnd.initializr.v2.3+json";
const CACHE_TTL_MS = KIT_TIMEOUTS.initializrCacheTtl;
const DEFAULT_BASE_URL = "https://start.spring.io";
const DEPENDENCIES = "web,data-jpa,postgresql,flyway";

/** SNAPSHOT, RC, milestone, alpha/beta versions are not GA. */
export function isPrereleaseBootVersion(version: string): boolean {
  const upper = version.toUpperCase();
  return (
    upper.includes("SNAPSHOT") ||
    /-(RC|M)\d/i.test(version) ||
    /-(ALPHA|BETA)\d/i.test(version)
  );
}

/** Pick the newest GA Spring Boot version from Initializr metadata. */
export function resolveLatestBootVersion(section: unknown): string {
  if (!section || typeof section !== "object") {
    throw new InitializrParseError("Missing bootVersion in Spring Initializr metadata");
  }
  const bootSection = section as { default?: unknown; values?: Array<{ id?: string }> };
  const values = bootSection.values || [];
  for (const entry of values) {
    if (typeof entry.id === "string" && entry.id && !isPrereleaseBootVersion(entry.id)) {
      return entry.id;
    }
  }
  if (typeof bootSection.default === "string" && bootSection.default) {
    return bootSection.default;
  }
  throw new InitializrParseError("No Spring Boot version found in Initializr metadata");
}

/** Java 8/11 and every fourth release from 17 (17, 21, 25, …) are LTS. */
export function isLtsJavaVersion(version: string): boolean {
  const n = Number.parseInt(version, 10);
  if (Number.isNaN(n)) return false;
  if (n === 8 || n === 11) return true;
  return n >= 17 && (n - 17) % 4 === 0;
}

/** Pick the newest LTS Java version that Initializr supports for this Boot release. */
export function resolveLatestLtsJavaVersion(section: unknown): string {
  if (!section || typeof section !== "object") {
    throw new InitializrParseError("Missing javaVersion in Spring Initializr metadata");
  }
  const javaSection = section as { default?: unknown; values?: Array<{ id?: string }> };
  const available = new Set<string>();
  if (typeof javaSection.default === "string" && javaSection.default) {
    available.add(javaSection.default);
  }
  for (const entry of javaSection.values || []) {
    if (typeof entry.id === "string" && entry.id) {
      available.add(entry.id);
    }
  }
  let latest = -1;
  let latestId = "";
  for (const id of available) {
    if (!isLtsJavaVersion(id)) continue;
    const n = Number.parseInt(id, 10);
    if (n > latest) {
      latest = n;
      latestId = id;
    }
  }
  if (latestId) return latestId;
  if (typeof javaSection.default === "string" && javaSection.default) {
    return javaSection.default;
  }
  throw new InitializrParseError("No Java version found in Initializr metadata");
}

export class SpringInitializrClient {
  private metadataCache?: MetadataCache;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(baseUrl: string = DEFAULT_BASE_URL, fetchFn: FetchFn = globalThis.fetch.bind(globalThis)) {
    this.baseUrl = baseUrl;
    this.fetchFn = fetchFn;
  }

  async getMetadata(forceRefresh = false): Promise<InitializrMetadata> {
    if (!forceRefresh && this.metadataCache && Date.now() - this.metadataCache.fetchedAt < CACHE_TTL_MS) {
      return this.metadataCache.metadata;
    }
    const url = this.baseUrl.replace(/\/$/, "") + "/";
    let response: Response;
    try {
      response = await this.fetchFn(url, { headers: { Accept: METADATA_ACCEPT } });
    } catch (err) {
      throw new InitializrNetworkError(`Failed to reach Spring Initializr at ${this.baseUrl}`, err);
    }
    if (!response.ok) {
      throw new InitializrNetworkError(`Spring Initializr metadata request failed (${response.status})`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new InitializrParseError("Spring Initializr metadata response was not valid JSON");
    }
    const metadata = parseMetadata(body);
    this.metadataCache = { metadata, fetchedAt: Date.now() };
    return metadata;
  }

  async generateMavenProject(opts: GenerateMavenProjectOptions): Promise<Buffer> {
    const metadata = await this.getMetadata(true);
    const artifactId = sanitizeArtifactId(opts.artifactId);
    const params = new URLSearchParams({
      type: "maven-project",
      language: opts.language,
      bootVersion: metadata.bootVersion,
      javaVersion: metadata.javaVersion,
      packaging: "jar",
      dependencies: DEPENDENCIES,
      groupId: opts.groupId || "com.example",
      artifactId,
      name: opts.name || artifactId,
      packageName: opts.packageName || "com.example.demo",
      description:
        opts.description || "Spring Boot + JPA + PostgreSQL with Flyway; database branches via Lakebase.",
      version: "1.0.0-SNAPSHOT",
    });
    const url = `${this.baseUrl.replace(/\/$/, "")}/starter.zip?${params.toString()}`;
    let response: Response;
    try {
      response = await this.fetchFn(url);
    } catch (err) {
      throw new InitializrNetworkError("Failed to download project from Spring Initializr", err);
    }
    if (!response.ok) {
      throw new InitializrNetworkError(`Spring Initializr project generation failed (${response.status})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

function parseMetadata(body: unknown): InitializrMetadata {
  if (!body || typeof body !== "object") {
    throw new InitializrParseError("Spring Initializr metadata response was empty");
  }
  const doc = body as Record<string, unknown>;
  return {
    bootVersion: resolveLatestBootVersion(doc.bootVersion),
    javaVersion: resolveLatestLtsJavaVersion(doc.javaVersion),
  };
}

// ── Templates dir resolution (mirrors scaffold.ts) ──────────────

let cachedTemplatesDir: string | undefined;
function findTemplatesDir(): string {
  if (cachedTemplatesDir) return cachedTemplatesDir;
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "templates", "project");
    if (fs.existsSync(path.join(candidate, "common", ".gitignore.base"))) {
      cachedTemplatesDir = candidate;
      return cachedTemplatesDir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate templates/project tree");
}

// ── Deploy orchestrator ─────────────────────────────────────────

import type { ScaffoldReportFn } from "./scaffold.js";
export type { ScaffoldReportFn };

export interface DeploySpringStarterArgs {
  targetDir: string;
  language: SpringJvmLanguage;
  projectName?: string;
  /** Override templates dir (tests). */
  templatesDir?: string;
  /** Override Initializr client (tests). */
  initializrClient?: SpringInitializrClient;
  report?: ScaffoldReportFn;
}

/**
 * Mirror of ScaffoldService.deploySpringFromInitializr.
 *
 *   1. If LAKEBASE_SCAFFOLD_FALLBACK=1, skip the network entirely and use
 *      the bundled fallback (templates/.../fallback/).
 *   2. Otherwise: fetch metadata + starter zip from start.spring.io,
 *      extract, apply Spring overlay (templates/project/spring/), patch
 *      pom.xml for Lakebase (flyway-pg dep + flyway/surefire plugins).
 *   3. If anything fails BEFORE extraction succeeds, fall back to the
 *      bundled template. If failure happens AFTER extraction, surface the
 *      error (the user has partial state on disk that they may want to keep).
 */
export async function deploySpringStarter(args: DeploySpringStarterArgs): Promise<void> {
  const language = args.language;
  const label = language === "kotlin" ? "Kotlin" : "Java";
  const report = args.report ?? (() => {});
  const templatesDir = args.templatesDir ?? findTemplatesDir();
  const useFallback = process.env.LAKEBASE_SCAFFOLD_FALLBACK === "1";

  if (useFallback) {
    report(`Using bundled ${label} template (LAKEBASE_SCAFFOLD_FALLBACK).`);
    deploySpringFallback(args.targetDir, language, args.projectName, templatesDir);
    deploySpringOverlays(args.targetDir, templatesDir);
    return;
  }

  report(`Fetching Spring Boot project from start.spring.io (${label}).`);
  let initializrExtracted = false;
  try {
    const client = args.initializrClient ?? new SpringInitializrClient();
    const metadata = await client.getMetadata();
    report(
      `Scaffolding Spring Boot ${metadata.bootVersion} (JVM ${metadata.javaVersion}, ${label}).`,
      `bootVersion=${metadata.bootVersion}`
    );

    const zip = await client.generateMavenProject({
      language,
      artifactId: args.projectName || "demo",
      name: args.projectName,
    });
    extractZipToDir(zip, args.targetDir);
    initializrExtracted = true;

    const pomPath = path.join(args.targetDir, "pom.xml");
    if (!fs.existsSync(pomPath)) {
      throw new Error("Spring Initializr did not produce a Maven project (missing pom.xml)");
    }

    const mvnw = path.join(args.targetDir, "mvnw");
    if (fs.existsSync(mvnw)) fs.chmodSync(mvnw, 0o755);

    deploySpringOverlays(args.targetDir, templatesDir);
    patchPomForLakebase(pomPath);
  } catch (err) {
    if (initializrExtracted) {
      throw new Error(
        `Spring Initializr project was extracted but post-processing failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const reason = err instanceof InitializrNetworkError ? err.message : String(err);
    report(`Spring Initializr unavailable; using bundled ${label} template.`, reason);
    clearScaffoldArtifacts(args.targetDir);
    deploySpringFallback(args.targetDir, language, args.projectName, templatesDir);
    deploySpringOverlays(args.targetDir, templatesDir);
  }
}

function deploySpringFallback(
  targetDir: string,
  language: SpringJvmLanguage,
  projectName: string | undefined,
  templatesDir: string
): void {
  const fallbackDir = path.join(templatesDir, language, "fallback");
  if (!fs.existsSync(fallbackDir)) {
    throw new Error(`No fallback template found for language: ${language}`);
  }
  copyDirSubstituted(fallbackDir, targetDir, { projectName });
  const mvnw = path.join(targetDir, "mvnw");
  if (fs.existsSync(mvnw)) fs.chmodSync(mvnw, 0o755);
}

function deploySpringOverlays(targetDir: string, templatesDir: string): void {
  const overlayDir = path.join(templatesDir, "spring");
  if (!fs.existsSync(overlayDir)) {
    throw new Error(`Spring overlay template not found at ${overlayDir}`);
  }
  copyDirSubstituted(overlayDir, targetDir);
}

/** Remove scaffold output while preserving an existing .git directory. */
function clearScaffoldArtifacts(targetDir: string): void {
  if (!fs.existsSync(targetDir)) return;
  for (const entry of fs.readdirSync(targetDir)) {
    if (entry === ".git") continue;
    fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
  }
}
