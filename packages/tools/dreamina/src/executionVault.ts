import { mkdir, lstat, realpath, readFile, writeAtomic } from "@toonflow/file";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { canonical, hash, fail } from "./store";
import { errorCode, type ExecutionVault, type Job, type Signer } from "./runtime";

function signerForKey(key: Buffer): Signer {
  const signature = (job: Job) => {
    const { integrity, ...body } = job;
    return createHmac("sha256", key).update(canonical(body)).digest("hex");
  };
  return {
    sign(job) { return { ...job, integrity: signature(job) }; },
    verify(job) {
      const expected = Buffer.from(signature(job));
      const actual = Buffer.from(typeof job.integrity === "string" ? job.integrity : "");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail("ledger_integrity_failed");
    },
  };
}

async function checkPermissions(path: string, directory = false) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (process.getuid && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & 0o077))) fail("execution_vault_permissions");
}

export async function openExecutionVault(cwd: string): Promise<ExecutionVault> {
  const dataDirectory = process.env.TOONFLOW_DATA_DIR;
  if (!dataDirectory || !isAbsolute(dataDirectory)) fail("data_directory_unavailable");
  let directory = join(dataDirectory, "dreamina");
  // 兼容旧集成签名和永久提交记录；只复用已经存在的旧目录，不新建旧命名目录。
  if (process.platform === "darwin") {
    const legacy = join(homedir(), "Library", "Application Support", "toonflow-local-integration");
    const exists = await lstat(legacy).catch(error => {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    });
    if (exists) directory = legacy;
  }
  const workspace = await realpath(cwd);
  const parent = await realpath(dirname(directory)).catch(error => {
    if (errorCode(error) === "ENOENT") fail("data_directory_unavailable");
    throw error;
  });
  const withinWorkspace = relative(workspace, join(parent, basename(directory)));
  if (!withinWorkspace || (withinWorkspace !== ".." && !withinWorkspace.startsWith(`..${sep}`) && !isAbsolute(withinWorkspace))) fail("execution_vault_inside_workspace");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await checkPermissions(directory, true);
  const keyPath = join(directory, "ledger.key");
  try { await writeAtomic(keyPath, randomBytes(32), { exclusive: true, mode: 0o600 }); }
  catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
  await checkPermissions(keyPath);
  const key = await readFile(keyPath);
  if (key.length !== 32) fail("execution_vault_corrupt");
  const claims = join(directory, "claims");
  await mkdir(claims, { recursive: true, mode: 0o700 });
  await checkPermissions(claims, true);
  const claimPath = (job: Job) => join(claims, `${hash({ projectKey: job.projectKey, jobKey: job.jobKey })}.json`);
  return {
    signer: signerForKey(key),
    async claim(job) {
      const identity = { projectKey: job.projectKey, jobKey: job.jobKey, submitId: job.submitId };
      try { await writeAtomic(claimPath(job), `${canonical(identity)}\n`, { exclusive: true, mode: 0o600 }); }
      catch (error) { if (errorCode(error) === "EEXIST") fail("submission_already_claimed"); throw error; }
    },
    async hasClaim(job) {
      try {
        await checkPermissions(claims, true);
        await checkPermissions(claimPath(job));
        const record = JSON.parse(await readFile(claimPath(job), "utf8"));
        if (record.projectKey !== job.projectKey || record.jobKey !== job.jobKey || record.submitId !== job.submitId) fail("execution_vault_claim_mismatch");
        return true;
      } catch (error) { if (errorCode(error) === "ENOENT") return false; throw error; }
    },
  };
}
