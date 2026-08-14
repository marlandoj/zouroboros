#!/usr/bin/env bun
/**
 * fal-media.ts — Fal.ai image/video generator
 * Zero-dependency. Requires FAL_KEY env var.
 */

const API_BASE = "https://queue.fal.run";
const MODELS: Record<string, string> = {
  "gpt-image-2": "fal-ai/gpt-image-2",
  "nano-banana-2": "fal-ai/nano-banana-2",
  "nano-banana-pro": "fal-ai/nano-banana-pro",
  "flux-kontext": "fal-ai/flux-kontext",
};

const EDIT_MODELS: Record<string, string> = {
  "gpt-image-2": "openai/gpt-image-2/edit",
  "nano-banana-2": "fal-ai/nano-banana-2/edit",
  "nano-banana-pro": "fal-ai/nano-banana-pro/edit",
};

const T2V_MODELS: Record<string, string> = {
  "veo3-fast": "fal-ai/veo3/fast",
  "veo3.1-fast": "fal-ai/veo3/fast",
  "veo3.1": "fal-ai/veo3.1",
  "veo3": "fal-ai/veo3",
};

const ASPECT_MAP: Record<string, { width: number; height: number }> = {
  "21:9": { width: 2560, height: 1080 },
  "16:9": { width: 1536, height: 864 },
  "4:3": { width: 1280, height: 960 },
  "3:2": { width: 1280, height: 854 },
  "1:1": { width: 1024, height: 1024 },
  "2:3": { width: 854, height: 1280 },
  "3:4": { width: 960, height: 1280 },
  "9:16": { width: 576, height: 1024 },
};

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        out[key] = argv[i + 1];
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function die(msg: string): never {
  console.error("❌ " + msg);
  process.exit(1);
}

function log(msg: string) {
  console.log(msg);
}

type SubmitInfo = { requestId: string; statusUrl: string; responseUrl: string };

async function falQueueSubmit(endpoint: string, payload: object, token: string): Promise<SubmitInfo> {
  const resp = await fetch(`${API_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Submit failed (${resp.status}): ${body}`);
  }
  const data = await resp.json();
  const requestId = data?.request_id;
  if (!requestId) throw new Error("No request_id in submit response: " + JSON.stringify(data));
  const statusUrl = data?.status_url || `${API_BASE}/${endpoint}/requests/${requestId}/status`;
  const responseUrl = data?.response_url || `${API_BASE}/${endpoint}/requests/${requestId}`;
  return { requestId, statusUrl, responseUrl };
}

async function* falQueueStreamStatus(statusUrl: string, token: string) {
  while (true) {
    const resp = await fetch(statusUrl, {
      headers: { Authorization: `Key ${token}` },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Status check failed (${resp.status}): ${body}`);
    }
    const data = await resp.json();
    yield data;
    if (data.status === "COMPLETED" || data.status === "FAILED") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function falQueueResult(responseUrl: string, token: string): Promise<unknown> {
  const resp = await fetch(responseUrl, {
    headers: { Authorization: `Key ${token}` },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Result fetch failed (${resp.status}): ${body}`);
  }
  return resp.json();
}

async function cmdGenerate(args: Record<string, string>) {
  const token = process.env.FAL_KEY || die("FAL_KEY not set (add it in Settings > Advanced)");
  const prompt = args.prompt || die("Missing --prompt");
  const output = args.output || die("Missing --output");
  const modelSlug = args.model || "nano-banana-2";
  const endpoint = MODELS[modelSlug];
  if (!endpoint) die(`Unknown model: ${modelSlug}. Available: ${Object.keys(MODELS).join(", ")}`);

  const aspect = ASPECT_MAP[args["aspect-ratio"] || "1:1"] || ASPECT_MAP["1:1"];
  const quality = args.quality || "medium";

  const payload: Record<string, unknown> = {
    prompt,
    image_size: { width: aspect.width, height: aspect.height },
  };

  if (modelSlug === "gpt-image-2") {
    payload.quality = quality;
  }

  log(`📤 Submitting to ${endpoint} (${aspect.width}x${aspect.height})…`);
  const submit = await falQueueSubmit(endpoint, payload, token);
  log(`⏳ Queue request: ${submit.requestId}`);

  for await (const status of falQueueStreamStatus(submit.statusUrl, token)) {
    log(`   ${status.status}`);
    if (status.status === "FAILED") {
      die(`Generation failed: ${JSON.stringify(status)}`);
    }
    if (status.status === "COMPLETED") break;
  }

  const result = await falQueueResult(submit.responseUrl, token) as Record<string, unknown>;
  const images = Array.isArray(result.images) ? result.images : [];
  if (!images.length || !images[0].url) die("No image URL in result: " + JSON.stringify(result));

  const imageUrl = images[0].url as string;
  log(`⬇️  Downloading to ${output} …`);
  const imgResp = await fetch(imageUrl);
  if (!imgResp.ok) die(`Download failed: ${imgResp.status}`);

  await Bun.write(output, imgResp);
  log(`✅ Saved: ${output}`);
}

function mimeTypeForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}

async function cmdEdit(args: Record<string, string>) {
  const token = process.env.FAL_KEY || die("FAL_KEY not set (add it in Settings > Advanced)");
  const prompt = args.prompt || die("Missing --prompt");
  const imagePath = args.image || die("Missing --image");
  const output = args.output || die("Missing --output");
  const modelSlug = args.model || "nano-banana-2";
  const endpoint = EDIT_MODELS[modelSlug];
  if (!endpoint) die(`Unknown/unsupported edit model: ${modelSlug}. Available: ${Object.keys(EDIT_MODELS).join(", ")}`);

  const file = Bun.file(imagePath);
  if (!(await file.exists())) die(`Image not found: ${imagePath}`);
  const bytes = await file.arrayBuffer();
  const b64 = Buffer.from(bytes).toString("base64");
  const dataUri = `data:${mimeTypeForPath(imagePath)};base64,${b64}`;

  const payload: Record<string, unknown> = {
    prompt,
    image_urls: [dataUri],
  };
  if (modelSlug === "gpt-image-2") {
    payload.quality = args.quality || "medium";
  }

  log(`📤 Submitting to ${endpoint}…`);
  const submit = await falQueueSubmit(endpoint, payload, token);
  log(`⏳ Queue request: ${submit.requestId}`);

  for await (const status of falQueueStreamStatus(submit.statusUrl, token)) {
    log(`   ${status.status}`);
    if (status.status === "FAILED") {
      die(`Edit failed: ${JSON.stringify(status)}`);
    }
    if (status.status === "COMPLETED") break;
  }

  const result = await falQueueResult(submit.responseUrl, token) as Record<string, unknown>;
  const images = Array.isArray(result.images) ? result.images : [];
  if (!images.length || !images[0].url) die("No image URL in result: " + JSON.stringify(result));

  const imageUrl = images[0].url as string;
  log(`⬇️  Downloading to ${output} …`);
  const imgResp = await fetch(imageUrl);
  if (!imgResp.ok) die(`Download failed: ${imgResp.status}`);

  await Bun.write(output, imgResp);
  log(`✅ Saved: ${output}`);
}

async function cmdT2V(args: Record<string, string>) {
  const token = process.env.FAL_KEY || die("FAL_KEY not set (add it in Settings > Advanced)");
  const prompt = args.prompt || die("Missing --prompt");
  const output = args.output || die("Missing --output");
  const modelSlug = args.model || "veo3.1-fast";
  const endpoint = T2V_MODELS[modelSlug];
  if (!endpoint) die(`Unknown t2v model: ${modelSlug}. Available: ${Object.keys(T2V_MODELS).join(", ")}`);

  const aspect = args["aspect-ratio"] || "16:9";
  const duration = args.duration || "8s";
  const resolution = args.resolution || "720p";

  const payload: Record<string, unknown> = {
    prompt,
    aspect_ratio: aspect,
    duration,
    resolution,
    generate_audio: args["no-audio"] === "true" ? false : true,
  };

  if (args["negative-prompt"]) payload.negative_prompt = args["negative-prompt"];
  if (args.seed) payload.seed = parseInt(args.seed, 10);

  log(`📤 Submitting to ${endpoint} (${aspect}, ${duration}, ${resolution})…`);
  const submit = await falQueueSubmit(endpoint, payload, token);
  log(`⏳ Queue request: ${submit.requestId}`);

  let lastStatus = "";
  for await (const status of falQueueStreamStatus(submit.statusUrl, token)) {
    if (status.status !== lastStatus) {
      log(`   ${status.status}`);
      lastStatus = status.status;
    }
    if (status.status === "FAILED") {
      die(`Generation failed: ${JSON.stringify(status)}`);
    }
    if (status.status === "COMPLETED") break;
  }

  const result = await falQueueResult(submit.responseUrl, token) as Record<string, unknown>;
  const video = result.video as Record<string, unknown> | undefined;
  const videoUrl = (video?.url || (result as { video_url?: string }).video_url) as string | undefined;
  if (!videoUrl) die("No video URL in result: " + JSON.stringify(result));

  log(`⬇️  Downloading to ${output} …`);
  const vResp = await fetch(videoUrl);
  if (!vResp.ok) die(`Download failed: ${vResp.status}`);
  await Bun.write(output, vResp);
  log(`✅ Saved: ${output}`);
}

async function cmdModels() {
  log("Available models:");
  for (const [k, v] of Object.entries(MODELS)) {
    log(`  ${k.padEnd(20)} → ${v}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const cmd = process.argv[2];
  switch (cmd) {
    case "generate":
    case "gen":
      await cmdGenerate(args);
      break;
    case "edit":
      await cmdEdit(args);
      break;
    case "t2v":
      await cmdT2V(args);
      break;
    case "models":
      await cmdModels();
      break;
    default:
      console.log(`Usage: bun fal-media.ts <command> [options]

Commands:
  generate  Text-to-image generation
  edit      Image editing (image-to-image)
  models    List available models

Generate options:
  --prompt          "Image description"
  --output          /path/to/out.png
  --model           Model slug (default: nano-banana-2)
  --aspect-ratio    One of: 21:9, 16:9, 4:3, 3:2, 1:1, 2:3, 3:4, 9:16
  --quality         gpt-image-2 only: low | medium | high (default: medium)

Edit options:
  --prompt          "Edit instruction"
  --image           /path/to/input.png (local file)
  --output          /path/to/out.png
  --model           gpt-image-2 | nano-banana-2 | nano-banana-pro (default: nano-banana-2)
  --quality         gpt-image-2 only: low | medium | high (default: medium)

Examples:
  bun fal-media.ts generate --prompt "A cat" --output ./cat.png
  bun fal-media.ts generate --model gpt-image-2 --quality high --prompt "Photo of..." --output ./photo.png
  bun fal-media.ts edit --model gpt-image-2 --prompt "Add a red hat" --image ./cat.png --output ./cat-hat.png
`);
      process.exit(0);
  }
}

main().catch((e) => die(String(e)));
