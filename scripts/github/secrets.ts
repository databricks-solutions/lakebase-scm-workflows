// GitHub Actions repo secret writes. Encrypts plaintext via the repo's
// LibSodium public key (NaCl box seal) – same wire format as `gh secret
// set`. Ported from src/utils/githubSecrets.ts + src/services/githubService.ts.

import { Octokit, RequestError } from "octokit";
import sodium from "tweetsodium";
import { resolveGitHubToken } from "./auth.js";
import { parseOwnerRepo } from "../util/parse-owner-repo.js";

export class GitHubSecretsError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubSecretsError";
    this.status = status;
  }
}

async function getOctokit(): Promise<Octokit> {
  const token = await resolveGitHubToken();
  return new Octokit({ auth: token });
}

function wrap(err: unknown, context: string): never {
  if (err instanceof RequestError) {
    throw new GitHubSecretsError(`${context}: ${err.message}`, err.status);
  }
  if (err instanceof Error) {
    throw new GitHubSecretsError(`${context}: ${err.message}`);
  }
  throw new GitHubSecretsError(context);
}

function encryptSecret(publicKey: string, secretValue: string): string {
  const keyBytes = Buffer.from(publicKey, "base64");
  const messageBytes = Buffer.from(secretValue);
  const encryptedBytes = sodium.seal(messageBytes, keyBytes);
  return Buffer.from(encryptedBytes).toString("base64");
}

/** Create or update a single GitHub Actions repository secret. */
export async function setRepoSecret(
  ownerRepo: string,
  secretName: string,
  secretValue: string
): Promise<void> {
  try {
    const { owner, repo } = parseOwnerRepo(ownerRepo);
    const octokit = await getOctokit();
    const { data: keyData } = await octokit.rest.actions.getRepoPublicKey({ owner, repo });
    const encryptedValue = encryptSecret(keyData.key, secretValue);
    await octokit.rest.actions.createOrUpdateRepoSecret({
      owner,
      repo,
      secret_name: secretName,
      encrypted_value: encryptedValue,
      key_id: keyData.key_id,
    });
  } catch (err) {
    if (err instanceof GitHubSecretsError) throw err;
    wrap(err, `Failed to set secret ${secretName} on ${ownerRepo}`);
  }
}

/**
 * Set multiple repository secrets in sequence. Fail-fast: validates all
 * values are non-empty BEFORE making any API call (so a bad input doesn't
 * leave some secrets written and others not).
 */
export async function setRepoSecrets(
  ownerRepo: string,
  secrets: Record<string, string>
): Promise<void> {
  for (const [name, value] of Object.entries(secrets)) {
    if (!value) {
      throw new GitHubSecretsError(`Missing value for secret ${name}`);
    }
  }
  for (const [name, value] of Object.entries(secrets)) {
    await setRepoSecret(ownerRepo, name, value);
  }
}

/** List configured secret names (returns empty array on any error). */
export async function listSecretNames(ownerRepo: string): Promise<string[]> {
  try {
    const { owner, repo } = parseOwnerRepo(ownerRepo);
    const octokit = await getOctokit();
    const { data } = await octokit.rest.actions.listRepoSecrets({ owner, repo });
    return data.secrets.map((s) => s.name);
  } catch {
    return [];
  }
}
