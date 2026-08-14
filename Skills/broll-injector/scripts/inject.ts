#!/usr/bin/env bun
/**
 * inject.ts - b-roll injector conductor.
 *
 * Resumable, file-based, fail-loud DAG that turns a talking-head "spine" video
 * into a visually rich cut with AI b-roll intercut over it:
 *
 *   plan        SRT/transcript -> 00-plan.json        (extract-plan.ts via /zo/ask)
 *   generate    00-plan.json   -> broll/<id>.mp4      (gen-broll.ts via fal-ai-media)
 *   compose     spine + clips  -> <name>-broll.mp4    (compose.py, proven ffmpeg)
 *
 * Each stage skips when its artifact already exists (per-clip caching in
 * generate); --force re-runs. --dry-run fabricates placeholder b-roll so the
 * whole pipeline is provable with zero fal.ai spend.
 *
 * Usage:
 *   bun inject.ts --base SPINE.mp4 --srt CAPTIONS.srt [--out FINAL.mp4]
 *   bun inject.ts --base SPINE.mp4 --plan my-plan.json          # skip extraction
 *   bun inject.ts --base SPINE.mp4 --srt CAPTIONS.srt --dry-run # no API spend
 */
const HERE = new URL(".", import.meta.url).pathname;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
      else out[k] = "true";
    }
  }
  return out;
}
function die(m: string): never { console.error("\n❌ inject: " + m); process.exit(1); }

async function stage(name: string, cmd: string[]) {
  console.log(`\n── stage: ${name} ──`);
  console.log("   " + cmd.join(" "));
  const p = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  const code = await p.exited;
  if (code !== 0) die(`stage '${name}' failed (exit ${code})`);
}

function basename(p: string): string {
  return (p.split("/").pop() || p).replace(/\.[^.]+$/, "");
}

async function main() {
  const a = parseArgs(process.argv);
  const base = a.base || die("Missing --base <spine.mp4>");
  if (!(await Bun.file(base).exists())) die(`base not found: ${base}`);

  const name = basename(base);
  const runDir = a["run-dir"] || `${base.replace(/\/[^/]+$/, "")}/broll-${name}`;
  const out = a.out || `${runDir}/${name}-broll.mp4`;
  const brollDir = `${runDir}/broll`;
  const planPath = `${runDir}/00-plan.json`;
  const force = a.force === "true";
  const dryRun = a["dry-run"] === "true";

  await Bun.spawn(["mkdir", "-p", brollDir]).exited;

  // ── stage 1: plan ──
  if (a.plan) {
    // user supplied a hand-authored plan; copy it in as the canonical artifact
    const planRaw = JSON.parse(await Bun.file(a.plan).text());
    if (!planRaw.base_video) planRaw.base_video = base;
    if (!planRaw.fps) planRaw.fps = 25;
    await Bun.write(planPath, JSON.stringify(planRaw, null, 2));
    console.log(`plan: using supplied --plan (${planRaw.moments?.length ?? 0} moments) -> ${planPath}`);
  } else if ((await Bun.file(planPath).exists()) && !force) {
    console.log(`plan: cached -> ${planPath}`);
  } else {
    const src = a.srt ? ["--srt", a.srt] : a.transcript ? ["--transcript", a.transcript]
      : die("provide --srt, --transcript, or --plan");
    await stage("plan", [
      "bun", `${HERE}extract-plan.ts`, ...src, "--out", planPath, "--base", base,
      "--count", a.count || "5", "--mode", a.mode || "fullframe",
      "--source", a.source || "t2v", ...(a.model ? ["--model", a.model] : []),
    ]);
  }

  // ── stage 2: generate ──
  await stage("generate", [
    "bun", `${HERE}gen-broll.ts`, "--plan", planPath, "--out-dir", brollDir,
    ...(dryRun ? ["--dry-run", "true"] : []), ...(force ? ["--force", "true"] : []),
  ]);

  // ── stage 3: compose ──
  if ((await Bun.file(out).exists()) && !force) {
    console.log(`\ncompose: output exists (use --force to rebuild) -> ${out}`);
  } else {
    await stage("compose", [
      "python3", `${HERE}compose.py`, "--base", base, "--plan", planPath,
      "--broll-dir", brollDir, "--out", out, "--mode", a.mode || "fullframe",
      ...(a.crossfade === "true" ? ["--crossfade"] : []),
      ...(a["pip-scale"] ? ["--pip-scale", a["pip-scale"]] : []),
      ...(a.margin ? ["--margin", a.margin] : []),
    ]);
  }

  console.log(`\n✅ inject: done -> ${out}`);
  console.log(`   run dir: ${runDir}`);
}

main().catch((e) => die(String(e)));
