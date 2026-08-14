/**
 * Domain 12: File Upload Safety
 *
 *  - Size limits
 *  - Type validation (content-sniffing, not just extension)
 *  - Ownership / signed URLs
 *  - Storage isolation (not in /public)
 */

import type { CheckModule, AuditConfig, CheckResult, Finding } from "../lib/types.ts";
import { walkRepo, grepFiles, isSource, safeRead } from "../lib/runners.ts";

export const fileUploadsCheck: CheckModule = {
  domain: "file-uploads",
  description: "Audit file upload safety — size, type, ownership, isolation.",
  async run(config: AuditConfig): Promise<CheckResult> {
    const startedAt = Date.now();
    const findings: Finding[] = [];

    if (!config.repoPath) return empty("file-uploads", startedAt);
    const repo = config.repoPath;
    const sourceFiles = walkRepo(repo, (rel) => isSource(rel), { maxFiles: 4000 });

    // Detect upload code path
    const uploadHits = grepFiles(
      sourceFiles,
      /(multer|formidable|busboy|@aws-sdk\/client-s3.{0,40}PutObject|put_object|upload\.single|upload\.array|multipart\/form-data|createReadStream)/i,
      { maxMatches: 10 },
    );
    if (uploadHits.length === 0 && !config.surfaces?.uploads) {
      return {
        domain: "file-uploads",
        ranAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        toolsUsed: [],
        toolsMissing: [],
        findings: [],
        manualChecklist: [{ item: "No upload code detected — confirm app does not accept user uploads.", rationale: "Re-run when uploads are added." }],
      };
    }

    // Size limits
    const limitHits = grepFiles(sourceFiles, /(limits?:\s*\{\s*fileSize|maxFileSize|MAX_(FILE|UPLOAD)_SIZE|max_length|maxBytes)/i, { maxMatches: 5 });
    if (uploadHits.length > 0 && limitHits.length === 0) {
      findings.push({
        id: "uploads.no-size-limit",
        domain: "file-uploads",
        severity: "high",
        title: "Upload handler without explicit size limit",
        description: "Upload code found but no `fileSize` / `maxFileSize` limit detected. Unbounded uploads exhaust disk and bandwidth.",
        evidence: uploadHits.slice(0, 3).map((h) => ({ file: rel(h.file, repo), line: h.line, snippet: h.snippet })),
        remediation: "Set strict per-file and per-request size limits in your upload middleware. Reject early before buffering to disk.",
        source: "production-ready:upload-grep",
      });
    }

    // Type validation
    const typeHits = grepFiles(
      sourceFiles,
      /(mimetype|content-type|file-type|magic[_-]?bytes|file-signatures|fileTypeFromBuffer)/i,
      { maxMatches: 5 },
    );
    if (uploadHits.length > 0 && typeHits.length === 0) {
      findings.push({
        id: "uploads.no-type-validation",
        domain: "file-uploads",
        severity: "high",
        title: "Upload handler without content-type validation",
        description: "No detected content-type/MIME validation on uploads. Attackers upload polyglot files (e.g., a .png that's actually JS) for stored XSS or RCE.",
        remediation: "Validate by **magic bytes** (using `file-type` / `python-magic`), not by client-provided extension or content-type header. Reject any file whose sniffed type isn't on the allowlist.",
        source: "production-ready:upload-grep",
        references: ["https://owasp.org/www-community/vulnerabilities/Unrestricted_File_Upload"],
      });
    }

    // Files served from /public directly with user uploads
    const publicUploadHits = grepFiles(sourceFiles, /(public\/uploads|static\/uploads|uploads\/|writeFile.{0,40}public\/|fs\.copyFile.{0,40}public\/)/i, { maxMatches: 5 });
    if (publicUploadHits.length > 0) {
      findings.push({
        id: "uploads.served-from-public",
        domain: "file-uploads",
        severity: "high",
        title: "Uploaded files served from a public directory",
        description: "Writing user uploads into `/public` or `/static` exposes them at predictable URLs and may bypass auth checks.",
        evidence: publicUploadHits.slice(0, 3).map((h) => ({ file: rel(h.file, repo), line: h.line, snippet: h.snippet })),
        remediation: "Store uploads in object storage (S3/R2/GCS) under a non-guessable key. Serve via signed URLs that expire. Apply per-user authorization on the URL-signing endpoint.",
        source: "production-ready:upload-grep",
      });
    }

    return {
      domain: "file-uploads",
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      toolsUsed: ["production-ready:upload-grep"],
      toolsMissing: [],
      findings,
      manualChecklist: [
        { item: "Per-user/tenant storage quota enforced", rationale: "Otherwise one user can fill your bucket and your bill." },
        { item: "Image-processing pipeline does not run untrusted ImageMagick (RCE history)", rationale: "Prefer sharp / pillow over ImageMagick if possible." },
        { item: "Antivirus or sandboxed scanning for executable / archive uploads", rationale: "Stored files become attack surface for downloaders." },
      ],
    };
  },
};

function rel(full: string, root: string): string { return full.startsWith(root) ? full.slice(root.length + 1) : full; }
function empty(domain: any, startedAt: number): CheckResult { return { domain, ranAt: new Date().toISOString(), durationMs: Date.now() - startedAt, toolsUsed: [], toolsMissing: [], findings: [], manualChecklist: [{ item: "Provide --repo to run.", rationale: "Source access required." }] }; }
