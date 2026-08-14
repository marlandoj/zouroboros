#!/usr/bin/env bun
/**
 * extract-plan.ts - turn a presenter transcript into a b-roll plan.
 *
 * Reads a word/line-level SRT (HeyGen caption output) or a plain transcript and
 * asks this same Zo (headless, via /zo/ask) to choose N b-roll moments: where to
 * cut away, what to show, and a cinematic prompt for the generate stage.
 *
 * Emits broll-plan.json:
 *   { base_video, fps, moments: [ {id,start,hold,source,mode,model,prompt,trigger_phrase} ] }
 *
 * /zo/ask discipline (learned in deep-research): do NOT send model_name in the
 * body (it blanks the response). This is a pure-reasoning turn (no tools), so the
 * synchronous `output` is reliable; we parse a fenced ```json block from it.
 */
type Cue = { i: number; start: number; end: number; text: string };

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
function die(m: string): never { console.error("❌ extract-plan: " + m); process.exit(1); }

function ts(t: string): number {
  const m = t.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

function parseSrt(raw: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of raw.split(/\n\s*\n/)) {
    const lines = block.trim().split(/\n/);
    if (lines.length < 2) continue;
    const idx = lines[0].match(/^\d+$/) ? 0 : -1;
    const timeLine = lines[idx + 1] || "";
    const tm = timeLine.match(/(.+)-->(.+)/);
    if (!tm) continue;
    cues.push({
      i: cues.length + 1,
      start: ts(tm[1]),
      end: ts(tm[2]),
      text: lines.slice(idx + 2).join(" ").trim(),
    });
  }
  return cues;
}

async function zoAsk(input: string): Promise<string> {
  const idToken = process.env.ZO_CLIENT_IDENTITY_TOKEN;
  const apiKey = process.env.ZO_API_KEY;
  const auth = idToken ? idToken : apiKey ? `Bearer ${apiKey}` : die("no ZO_CLIENT_IDENTITY_TOKEN / ZO_API_KEY");
  const resp = await fetch("https://api.zo.computer/zo/ask", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ input }), // NB: no model_name (blanks the response)
  });
  if (!resp.ok) die(`/zo/ask ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  const data = await resp.json();
  return typeof data.output === "string" ? data.output : JSON.stringify(data.output);
}

function extractJson(text: string): any {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const s = body.indexOf("["), e = body.lastIndexOf("]");
  if (s === -1 || e === -1) die("no JSON array in model output:\n" + text.slice(0, 800));
  return JSON.parse(body.slice(s, e + 1));
}

async function main() {
  const a = parseArgs(process.argv);
  const out = a.out || die("Missing --out");
  const base = a.base || "";
  const count = parseInt(a.count || "5", 10);
  const mode = a.mode || "fullframe";
  const source = a.source || "t2v";
  const model = a.model || (source === "still" ? "nano-banana-2" : "veo3.1-fast");

  let transcript: string;
  let duration = 0;
  if (a.srt) {
    const cues = parseSrt(await Bun.file(a.srt).text());
    if (!cues.length) die("no cues parsed from SRT");
    duration = cues[cues.length - 1].end;
    transcript = cues.map((c) => `[${c.start.toFixed(1)}s] ${c.text}`).join("\n");
  } else if (a.transcript) {
    transcript = await Bun.file(a.transcript).text();
  } else {
    die("provide --srt <file> or --transcript <file>");
  }

  const prompt = `You are a video editor planning b-roll cutaways over a talking-head presenter video.

Below is the timestamped transcript. Choose exactly ${count} of the strongest moments to cut to b-roll. For each moment pick a CONCRETE, literal, cinematic visual that illustrates what the presenter is saying at that timestamp.

Rules for each b-roll prompt:
- It feeds a text-to-video model, so describe a single vivid SHOT: subject, setting, lighting, camera move. No on-screen text, no captions, no talking people, no logos.
- Keep cutaways 3-5 seconds, spaced out across the runtime (total runtime ~${duration.toFixed(0)}s), never overlapping.
- "start" = seconds into the video to begin the cutaway (a beat after the triggering phrase starts).
- "hold" = cutaway duration in seconds (3-5).

Return ONLY a JSON array of ${count} objects, each:
{"start": number, "hold": number, "trigger_phrase": "short quote", "prompt": "cinematic shot description"}

Transcript:
${transcript}`;

  console.error(`extract-plan: asking /zo/ask for ${count} moments over ${duration.toFixed(0)}s …`);
  const raw = await zoAsk(prompt);
  const arr = extractJson(raw);

  const moments = arr.slice(0, count).map((m: any, i: number) => ({
    id: `m${i + 1}`,
    start: Math.max(0, Number(m.start) || 0),
    hold: Math.min(6, Math.max(2.5, Number(m.hold) || 4)),
    source,
    mode,
    model,
    trigger_phrase: String(m.trigger_phrase || ""),
    prompt: String(m.prompt || "").trim(),
  })).filter((m: any) => m.prompt);

  if (!moments.length) die("model returned no usable moments");
  const plan = { base_video: base, fps: 25, moments };
  await Bun.write(out, JSON.stringify(plan, null, 2));
  console.log(`extract-plan: ✅ ${moments.length} moments -> ${out}`);
  for (const m of moments) console.log(`  ${m.id} @ ${m.start}s (+${m.hold}s) "${m.trigger_phrase}"`);
}

main().catch((e) => die(String(e)));
