#!/usr/bin/env bun
/**
 * gen-broll.ts - generate one silent b-roll clip per plan moment.
 *
 * Routes through the existing fal-ai-media skill (FAL_KEY, no extra credit
 * surface) and normalizes every output to a silent 25fps yuv420p mp4 so the
 * compositor only ever deals with clean, concat-compatible video:
 *   - source "t2v"   -> fal-media.ts t2v (veo3.1-fast, --no-audio)        -> normalize
 *   - source "still" -> fal-media.ts generate (nano-banana-2 / gpt-image-2) -> Ken Burns
 *
 * Caching: a moment whose <id>.mp4 already exists is skipped unless --force.
 * --dry-run fabricates a labeled colour-card placeholder clip per moment with
 * zero API spend, so the full DAG can be validated end to end before paying fal.
 */
const FAL = "/home/workspace/Skills/fal-ai-media/scripts/fal-media.ts";

type Moment = {
  id: string;
  start: number;
  hold?: number;
  source?: "t2v" | "still";
  model?: string;
  prompt: string;
  trigger_phrase?: string;
  aspect_ratio?: string;
};

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { out[k] = argv[++i]; }
      else out[k] = "true";
    }
  }
  return out;
}

async function run(cmd: string[], label: string): Promise<void> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) {
    const err = await new Response(p.stderr).text();
    throw new Error(`${label} failed (exit ${code}): ${err.slice(-1500)}`);
  }
}

// Stable pastel-ish colour from an id, for dry-run cards.
function colorFor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) & 0xffffff;
  const r = 40 + (h & 0x7f), g = 40 + ((h >> 8) & 0x7f), b = 40 + ((h >> 16) & 0x7f);
  return `0x${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

async function placeholder(m: Moment, dur: number, out: string) {
  const color = colorFor(m.id);
  // Use drawtext textfile= to sidestep filtergraph escaping (commas/colons in
  // prompts otherwise break the graph). expansion=none keeps text literal.
  const label = `[B-ROLL ${m.id}]\n${m.trigger_phrase || ""}\n${m.prompt}`.slice(0, 160);
  const txt = `${out}.label.txt`;
  await Bun.write(txt, label);
  const vf =
    `drawbox=x=0:y=0:w=iw:h=ih:color=${color}@1:t=fill,` +
    `drawtext=textfile='${txt}':expansion=none:fontcolor=white:fontsize=34:` +
    `line_spacing=14:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.4:boxborderw=20`;
  await run(
    ["ffmpeg", "-y", "-f", "lavfi", "-i", `color=c=black:s=1280x720:r=25:d=${dur}`,
     "-vf", vf, "-an", "-r", "25", "-pix_fmt", "yuv420p",
     "-c:v", "libx264", "-preset", "fast", "-crf", "20", out],
    `placeholder ${m.id}`);
}

async function normalizeVideo(src: string, out: string) {
  await run(
    ["ffmpeg", "-y", "-i", src, "-an", "-r", "25", "-pix_fmt", "yuv420p",
     "-c:v", "libx264", "-preset", "fast", "-crf", "18", out],
    `normalize ${out}`);
}

async function kenBurns(png: string, dur: number, out: string) {
  const frames = Math.max(25, Math.round(dur * 25));
  const vf =
    `scale=2400:-1,` +
    `zoompan=z='min(zoom+0.0012,1.18)':d=${frames}:` +
    `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=25,` +
    `format=yuv420p`;
  await run(
    ["ffmpeg", "-y", "-loop", "1", "-i", png, "-t", String(dur),
     "-vf", vf, "-an", "-r", "25", "-c:v", "libx264", "-preset", "fast", "-crf", "18", out],
    `kenburns ${out}`);
}

async function main() {
  const a = parseArgs(process.argv);
  const planPath = a.plan || die("Missing --plan");
  const outDir = a["out-dir"] || die("Missing --out-dir");
  const dryRun = a["dry-run"] === "true";
  const force = a.force === "true";

  const plan = JSON.parse(await Bun.file(planPath).text());
  const moments: Moment[] = plan.moments || [];
  if (!moments.length) die("plan has no moments");

  await run(["mkdir", "-p", outDir], "mkdir");
  const tmp = `${outDir}/.tmp`;
  await run(["mkdir", "-p", tmp], "mkdir tmp");

  let made = 0, skipped = 0;
  for (const m of moments) {
    const finalClip = `${outDir}/${m.id}.mp4`;
    if (await Bun.file(finalClip).exists() && !force) {
      console.log(`  ⏭  ${m.id} cached`);
      skipped++;
      continue;
    }
    const hold = m.hold ?? 4.0;
    const dur = Math.round((hold + 0.6) * 100) / 100;

    if (dryRun) {
      await placeholder(m, dur, finalClip);
      console.log(`  🎨 ${m.id} placeholder (${dur}s)`);
      made++;
      continue;
    }

    const source = m.source || "t2v";
    const aspect = m.aspect_ratio || "16:9";
    if (source === "still") {
      const png = `${tmp}/${m.id}.png`;
      await run(
        ["bun", FAL, "generate", "--prompt", m.prompt,
         "--model", m.model || "nano-banana-2", "--aspect-ratio", aspect, "--output", png],
        `fal generate ${m.id}`);
      await kenBurns(png, dur, finalClip);
      console.log(`  🖼  ${m.id} still→kenburns (${dur}s)`);
    } else {
      const raw = `${tmp}/${m.id}-raw.mp4`;
      await run(
        ["bun", FAL, "t2v", "--prompt", m.prompt,
         "--model", m.model || "veo3.1-fast", "--aspect-ratio", aspect,
         "--no-audio", "true", "--output", raw],
        `fal t2v ${m.id}`);
      await normalizeVideo(raw, finalClip);
      console.log(`  🎬 ${m.id} t2v (${dur}s)`);
    }
    made++;
  }
  console.log(`gen-broll: ${made} generated, ${skipped} cached -> ${outDir}`);
}

function die(msg: string): never {
  console.error("❌ gen-broll: " + msg);
  process.exit(1);
}

main().catch((e) => die(String(e)));
