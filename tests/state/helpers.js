import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const root = fileURLToPath(new URL("../..", import.meta.url));
export const gitEnv = home => ({ ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file" });
export function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}
export function git(args, cwd, env) {
  const result = command("git", args, { cwd, env });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}
export function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "state-git-fixture-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  mkdirSync(home);
  const env = gitEnv(home);
  const bare = join(directory, "state.git");
  const seed = join(directory, "seed");
  const repo = join(directory, "writer");
  git(["init", "--bare", "--initial-branch=main", bare], directory, env);
  git(["init", "--initial-branch=main", seed], directory, env);
  git(["config", "user.name", "Fixture"], seed, env);
  git(["config", "user.email", "fixture@example.invalid"], seed, env);
  for (const path of ["config/stacks.yaml", "schemas/stacks.schema.json",
    "schemas/exceptions.schema.json", "schemas/environment-state.schema.json",
    "state/environments/dev.json", "state/environments/ste.json"]) {
    const destination = join(seed, path);
    mkdirSync(destination.slice(0, destination.lastIndexOf("/")), { recursive: true });
    cpSync(join(root, path), destination);
  }
  git(["add", "--", "config", "schemas", "state"], seed, env);
  git(["commit", "-m", "Seed fixture"], seed, env);
  git(["remote", "add", "origin", bare], seed, env);
  git(["push", "origin", "HEAD:main"], seed, env);
  git(["clone", bare, repo], directory, env);
  return { directory, home, env, bare, seed, repo };
}
export function observation(overrides = {}) {
  const component = { requested: true, status: "stopped", verified: true, reason: "Fixture" };
  return { stack: "STECCM43", stackComponents: ["AKS", "IaaS", "PaaS"],
    aggregateStatus: "stopped", observedAt: "2030-01-01T00:00:00.000Z",
    sourcePipeline: 404, sourceRunId: 123,
    components: { aks: component, iaas: component, paas: component }, ...overrides };
}
export function writeObservation(directory, folder, record) {
  const target = join(directory, folder, "observation.json");
  mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
  writeFileSync(target, typeof record === "string" ? record : JSON.stringify(record));
  return target;
}
