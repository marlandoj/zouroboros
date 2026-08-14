import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

type Status = "pass" | "warn" | "fail";

interface Finding {
  id: string;
  status: Status;
  detail: string;
}

interface AuditReport {
  project: string;
  filesScanned: number;
  findings: Finding[];
  assets: { models: number; images: number; audio: number };
  hooks: string[];
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".html"]);
const MODEL_EXTENSIONS = new Set([".glb", ".gltf", ".fbx", ".obj"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".ktx2", ".avif"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a"]);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".vite"]);

function walk(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else files.push(path);
    }
  };
  visit(root);
  return files;
}

function has(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

export function auditProject(projectPath: string): AuditReport {
  const project = resolve(projectPath);
  const packagePath = join(project, "package.json");
  if (!existsSync(project) || !existsSync(packagePath)) throw new Error(`Expected a project with package.json: ${project}`);

  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const files = walk(project);
  const sourceFiles = files.filter((file) => SOURCE_EXTENSIONS.has(extname(file).toLowerCase()));
  const productionFiles = sourceFiles.filter((file) => !/[\\/](?:tests?|evaluations?|coverage)[\\/]/.test(file));
  const runtimeFiles = files.filter((file) => !/[\\/](?:tests?|evaluations?|coverage)[\\/]/.test(file));
  const source = productionFiles.map((file) => readFileSync(file, "utf8")).join("\n");
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts ?? {};
  const hookMatches = [...source.matchAll(/\b(__[A-Za-z][A-Za-z0-9_]+)\b/g)].map((match) => match[1]);
  const hooks = [...new Set(hookMatches)].filter((hook) => !["__dirname", "__filename"].includes(hook)).sort();
  const findings: Finding[] = [];
  const add = (id: string, condition: boolean, pass: string, warning: string, fail = false) => {
    findings.push({ id, status: condition ? "pass" : fail ? "fail" : "warn", detail: condition ? pass : warning });
  };

  add("threejs", Boolean(dependencies.three) || has(source, /from\s+["']three(?:\/|["'])|THREE\./), "Three.js dependency or imports detected", "No Three.js dependency or import detected", true);
  add("renderer", has(source, /WebGLRenderer|WebGPURenderer/), "Three.js renderer detected", "No WebGLRenderer/WebGPURenderer construction detected");
  add("typecheck", Boolean(scripts.typecheck) || /tsc\b/.test(scripts.build ?? ""), "TypeScript gate is scripted", "No typecheck script or tsc build gate detected");
  add("unit-tests", Boolean(scripts.test), "Unit test command is scripted", "No test script detected");
  add("production-build", Boolean(scripts.build), "Production build command is scripted", "No build script detected");
  add("browser-tests", Boolean(scripts["test:e2e"] || scripts.e2e || dependencies["@playwright/test"]) || files.some((file) => /playwright\.config\./.test(file)), "Browser test surface detected", "No Playwright/browser test surface detected");
  add("runtime-hooks", hooks.length > 0, `Runtime hooks detected: ${hooks.join(", ")}`, "No stable window/globalThis test hook detected");
  add("renderer-metrics", has(source, /renderer\.info\.(?:render|memory)/), "Renderer metrics are read from renderer.info", "No renderer.info metrics detected");
  add("resize", has(source, /ResizeObserver|addEventListener\(["']resize["']/), "Resize handling detected", "No resize handling detected");
  add("mobile-input", has(source, /pointerdown|pointermove|touchstart|touchmove/), "Pointer or touch input detected", "No pointer/touch input detected");
  add("asset-loading", has(source, /GLTFLoader|FBXLoader|TextureLoader|AudioLoader/), "Runtime asset loader detected", "No Three.js asset loader detected");

  const count = (extensions: Set<string>) => runtimeFiles.filter((file) => extensions.has(extname(file).toLowerCase())).length;
  return {
    project,
    filesScanned: files.length,
    findings,
    assets: { models: count(MODEL_EXTENSIONS), images: count(IMAGE_EXTENSIONS), audio: count(AUDIO_EXTENSIONS) },
    hooks,
  };
}

function parseArgs(args: string[]): { project?: string; json: boolean } {
  let project: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--project") project = args[index + 1];
    if (args[index] === "--json") json = true;
  }
  return { project, json };
}

if (import.meta.main) {
  const { project, json } = parseArgs(process.argv.slice(2));
  if (!project) {
    console.error("Usage: bun audit-project.ts --project /absolute/path/to/game [--json]");
    process.exit(1);
  }
  try {
    const report = auditProject(project);
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`PROJECT=${report.project}`);
      console.log(`FILES_SCANNED=${report.filesScanned}`);
      for (const finding of report.findings) console.log(`${finding.status.toUpperCase()} ${finding.id}: ${finding.detail}`);
      console.log(`ASSETS models=${report.assets.models} images=${report.assets.images} audio=${report.assets.audio}`);
    }
    if (report.findings.some((finding) => finding.status === "fail")) process.exit(2);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
