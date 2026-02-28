import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { PDFDocument } from "pdf-lib";
import crypto from "crypto";
import pg from "pg";
import fs from "fs/promises";
import path from "path";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const PUBLIC_URL = process.env.PUBLIC_URL ?? "http://localhost:3002";
const PORT = parseInt(process.env.PORT ?? "3002", 10);
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads");
const API_KEY = process.env.API_KEY ?? ""; // Optional API key for auth

// Anthropic is preferred; OpenRouter is fallback
const AI_PROVIDER = ANTHROPIC_API_KEY ? "anthropic" : OPENROUTER_API_KEY ? "openrouter" : "none";

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
if (AI_PROVIDER === "none") {
  console.warn("No AI API key set (ANTHROPIC_API_KEY or OPENROUTER_API_KEY) — AI features disabled.");
} else {
  console.log(`AI provider: ${AI_PROVIDER}`);
}
if (!API_KEY) {
  console.warn("No API_KEY set — API is unauthenticated. Set API_KEY env var for security.");
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB max file size
const ALLOWED_DOC_TYPES = new Set([
  "application/pdf",
  "image/png", "image/jpeg", "image/gif", "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
]);

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("Unexpected PG pool error:", err);
});

async function query(text: string, params?: any[]) {
  return pool.query(text, params);
}

/** Run multiple queries in a transaction */
async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// File storage helpers
// ---------------------------------------------------------------------------

const DOCUMENTS_DIR = path.join(UPLOAD_DIR, "documents");
const IMAGES_DIR = path.join(UPLOAD_DIR, "images");

async function ensureUploadDirs() {
  await fs.mkdir(DOCUMENTS_DIR, { recursive: true });
  await fs.mkdir(IMAGES_DIR, { recursive: true });
  console.log(`Upload dirs ready: ${UPLOAD_DIR}`);
}

ensureUploadDirs();

function fileUrl(bucket: string, storagePath: string): string {
  return `${PUBLIC_URL}/files/${bucket}/${storagePath}`;
}

function localPath(bucket: string, storagePath: string): string {
  const base = bucket === "images" ? IMAGES_DIR : DOCUMENTS_DIR;
  return path.join(base, storagePath);
}

/** Validate that a resolved path is within the expected base directory */
function validatePath(fullPath: string): boolean {
  const resolved = path.resolve(fullPath);
  return resolved.startsWith(IMAGES_DIR) || resolved.startsWith(DOCUMENTS_DIR);
}

async function saveFile(bucket: string, storagePath: string, data: Buffer | Uint8Array): Promise<void> {
  const fullPath = localPath(bucket, storagePath);
  if (!validatePath(fullPath)) throw new Error("Invalid storage path");
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, data);
}

async function readFile(bucket: string, storagePath: string): Promise<Buffer> {
  const fullPath = localPath(bucket, storagePath);
  if (!validatePath(fullPath)) throw new Error("Invalid storage path");
  return fs.readFile(fullPath);
}

async function deleteFile(bucket: string, storagePath: string): Promise<void> {
  const fullPath = localPath(bucket, storagePath);
  if (!validatePath(fullPath)) return;
  try {
    await fs.unlink(fullPath);
  } catch (e: any) {
    if (e.code !== "ENOENT") {
      console.error(`Failed to delete file ${fullPath}:`, e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Text sanitization
// ---------------------------------------------------------------------------

function sanitizeText(text: string): string {
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[\uD800-\uDFFF]/g, "")
    .replace(/\uFFFD/g, "");
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono();

app.use("*", logger());

app.onError((err, c) => {
  console.error("Uncaught error:", err);
  return c.json({ error: "Internal Server Error" }, 500);
});

const ALLOWED_ORIGINS = [
  "https://homekey-salgsoppgave-v2.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
];

app.use(
  "/*",
  cors({
    origin: (origin) => {
      if (!origin) return ALLOWED_ORIGINS[0]; // Server-to-server requests
      return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    },
    allowHeaders: ["Content-Type", "Authorization", "X-API-Key", "X-Client-Info"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  })
);

app.options("/*", (c) => c.body(null, 204));

// ---------------------------------------------------------------------------
// Auth middleware — applied to all routes except health, root, and files
// ---------------------------------------------------------------------------

app.use("/*", async (c, next) => {
  // Skip auth for health check, root, OPTIONS, and file serving
  const reqPath = c.req.path;
  if (reqPath === "/" || reqPath === "/health" || reqPath.startsWith("/files/") || c.req.method === "OPTIONS") {
    return next();
  }

  // If API_KEY is set, require it
  if (API_KEY) {
    const providedKey = c.req.header("X-API-Key") || c.req.header("Authorization")?.replace("Bearer ", "");
    if (providedKey !== API_KEY) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  return next();
});

// ---------------------------------------------------------------------------
// Static file serving — /files/:bucket/*
// ---------------------------------------------------------------------------

app.get("/files/:bucket/*", async (c) => {
  const bucket = c.req.param("bucket");
  const filePath = c.req.path.replace(`/files/${bucket}/`, "");

  if (!filePath || filePath.includes("..")) {
    return c.json({ error: "Invalid path" }, 400);
  }

  const fullPath = localPath(bucket, filePath);

  // Path traversal protection
  if (!validatePath(fullPath)) {
    return c.json({ error: "Invalid path" }, 400);
  }

  try {
    const stat = await fs.stat(fullPath);
    const data = await fs.readFile(fullPath);

    // Guess content type from extension
    const ext = path.extname(fullPath).toLowerCase();
    const contentTypes: Record<string, string> = {
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".json": "application/json",
    };
    // SVGs served as download to prevent XSS
    const contentType = ext === ".svg" ? "application/octet-stream" : (contentTypes[ext] || "application/octet-stream");

    return new Response(data, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": stat.size.toString(),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return c.json({ error: "File not found" }, 404);
  }
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get("/health", async (c) => {
  try {
    await query("SELECT 1");
    return c.json({ status: "ok", service: "homekey-server", database: "connected" });
  } catch {
    return c.json({ status: "error", database: "unreachable" }, 500);
  }
});

app.get("/", (c) => {
  return c.json({ status: "ok", message: "HomeKey API is running." });
});

// ---------------------------------------------------------------------------
// SALGSOPPGAVE (project) routes
// ---------------------------------------------------------------------------

// List all
app.get("/salgsoppgave", async (c) => {
  try {
    const { rows } = await query(
      `SELECT id, fields, metadata FROM projects ORDER BY updated_at DESC`
    );

    const data = rows.map((row) => {
      // Compute fill progress from fields
      const fields = row.fields || {};
      const fieldKeys = Object.keys(fields);
      const totalFields = fieldKeys.length;
      const filledFields = fieldKeys.filter((k) => {
        const f = fields[k];
        return f && f.value !== undefined && f.value !== null && f.value !== "";
      }).length;

      return {
        id: row.id,
        metadata: row.metadata,
        fields: {
          adresse_full: fields.adresse_full,
          kommune: fields.kommune,
        },
        totalFields,
        filledFields,
      };
    });

    return c.json({ success: true, data });
  } catch (e: any) {
    console.error("Error listing salgsoppgaver:", e);
    return c.json({ error: "Failed to list projects" }, 500);
  }
});

// Get one
app.get("/salgsoppgave/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const { rows } = await query(
      `SELECT fields, metadata, source_confidence_meta, key_information, website, custom_categories
       FROM projects WHERE id = $1`,
      [id]
    );

    if (rows.length === 0) return c.json({ error: "Not found" }, 404);

    const row = rows[0];
    return c.json({
      success: true,
      data: {
        fields: row.fields,
        metadata: row.metadata,
        source_confidence_meta: row.source_confidence_meta,
        key_information: row.key_information,
        website: row.website,
        custom_categories: row.custom_categories,
      },
    });
  } catch (e: any) {
    console.error("Error getting salgsoppgave:", e);
    return c.json({ error: "Failed to get project" }, 500);
  }
});

// Save (create or update)
app.post("/salgsoppgave/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const data = await c.req.json();

    await query(
      `INSERT INTO projects (id, fields, metadata, source_confidence_meta, key_information, website, custom_categories, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (id) DO UPDATE SET
         fields = $2, metadata = $3, source_confidence_meta = $4,
         key_information = $5, website = $6, custom_categories = $7,
         updated_at = now()`,
      [
        id,
        JSON.stringify(data.fields ?? {}),
        JSON.stringify(data.metadata ?? {}),
        data.source_confidence_meta ? JSON.stringify(data.source_confidence_meta) : null,
        data.key_information ?? null,
        data.website ? JSON.stringify(data.website) : null,
        data.custom_categories ? JSON.stringify(data.custom_categories) : null,
      ]
    );

    return c.json({ success: true, id });
  } catch (e: any) {
    console.error("Error saving salgsoppgave:", e);
    return c.json({ error: "Failed to save project" }, 500);
  }
});

// Delete — also cleans up orphaned files
app.delete("/salgsoppgave/:id", async (c) => {
  const id = c.req.param("id");
  try {
    // Gather file paths before deleting (CASCADE will remove DB rows)
    const { rows: docRows } = await query(
      "SELECT storage_path FROM documents WHERE project_id = $1", [id]
    );
    const { rows: imgRows } = await query(
      "SELECT storage_path FROM images WHERE project_id = $1", [id]
    );

    await query("DELETE FROM projects WHERE id = $1", [id]);

    // Clean up files after successful DB delete
    for (const row of docRows) {
      deleteFile("documents", row.storage_path).catch((e) =>
        console.error("Failed to delete orphaned doc file:", e.message)
      );
    }
    for (const row of imgRows) {
      deleteFile("images", row.storage_path).catch((e) =>
        console.error("Failed to delete orphaned image file:", e.message)
      );
    }

    return c.json({ success: true });
  } catch (e: any) {
    console.error("Error deleting salgsoppgave:", e);
    return c.json({ error: "Failed to delete project" }, 500);
  }
});

// Cleanup duplicates — uses transaction
app.post("/salgsoppgave/cleanup-duplicates", async (c) => {
  try {
    const { rows } = await query(
      `SELECT id, fields, metadata FROM projects`
    );

    const byAddress = new Map<string, Array<{ id: string; date: Date }>>();

    for (const row of rows) {
      const address = (
        row.fields?.adresse_full?.value ||
        row.metadata?.title ||
        ""
      )
        .trim()
        .toLowerCase();
      if (!address || address === "ukjent prosjekt") continue;

      const date = new Date(row.metadata?.updatedAt || row.metadata?.createdAt || 0);
      const existing = byAddress.get(address) || [];
      existing.push({ id: row.id, date });
      byAddress.set(address, existing);
    }

    let duplicatesRemoved = 0;
    let duplicatesFound = 0;
    const idsToDelete: string[] = [];

    for (const [, entries] of byAddress) {
      if (entries.length <= 1) continue;
      duplicatesFound++;
      entries.sort((a, b) => b.date.getTime() - a.date.getTime());
      idsToDelete.push(...entries.slice(1).map((e) => e.id));
    }

    if (idsToDelete.length > 0) {
      await withTransaction(async (client) => {
        await client.query(
          "DELETE FROM projects WHERE id = ANY($1::text[])",
          [idsToDelete]
        );
      });
      duplicatesRemoved = idsToDelete.length;
    }

    return c.json({
      success: true,
      duplicatesFound,
      duplicatesRemoved,
      message: duplicatesRemoved
        ? `Removed ${duplicatesRemoved} duplicate(s).`
        : "No duplicates found.",
    });
  } catch (e: any) {
    console.error("Error cleaning up duplicates:", e);
    return c.json({ error: "Failed to cleanup duplicates" }, 500);
  }
});

// ---------------------------------------------------------------------------
// DOCUMENT UPLOAD & METADATA
// ---------------------------------------------------------------------------

// Upload documents
app.post("/upload/:id", async (c) => {
  const salgsoppgaveId = c.req.param("id");
  try {
    const formData = await c.req.formData();
    const uploaded: any[] = [];

    for (const [key, value] of formData.entries()) {
      if (key.startsWith("file_") && value instanceof File) {
        const file = value;

        // Validate file size
        if (file.size > MAX_UPLOAD_SIZE) {
          return c.json({ error: `File ${file.name} exceeds ${MAX_UPLOAD_SIZE / 1024 / 1024}MB limit` }, 400);
        }

        // Validate file type
        if (!ALLOWED_DOC_TYPES.has(file.type)) {
          return c.json({ error: `File type ${file.type} not allowed for ${file.name}` }, 400);
        }

        const documentId = `doc_${Date.now()}_${crypto.randomUUID().substring(0, 9)}`;
        const sanitizedFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const storagePath = `${salgsoppgaveId}/${documentId}_${sanitizedFilename}`;

        const arrayBuffer = await file.arrayBuffer();
        await saveFile("documents", storagePath, Buffer.from(arrayBuffer));

        // Insert into DB
        await query(
          `INSERT INTO documents (id, project_id, filename, content_type, file_size, storage_path, uploaded_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())`,
          [documentId, salgsoppgaveId, file.name, file.type, file.size, storagePath]
        );

        uploaded.push({
          id: documentId,
          filename: file.name,
          uploadedAt: new Date().toISOString(),
          fileSize: file.size,
          contentType: file.type,
          storageUrl: fileUrl("documents", storagePath),
          storagePath,
        });
      }
    }

    return c.json({ success: true, data: uploaded });
  } catch (e: any) {
    console.error("Error uploading documents:", e);
    return c.json({ error: "Failed to upload documents" }, 500);
  }
});

// Get document metadata
app.get("/documents-metadata/:id", async (c) => {
  const salgsoppgaveId = c.req.param("id");
  try {
    const { rows } = await query(
      `SELECT id, filename, content_type, file_size, storage_path, analysis, analyzed_at, model_used, uploaded_at
       FROM documents WHERE project_id = $1 ORDER BY uploaded_at`,
      [salgsoppgaveId]
    );

    const data = rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      uploadedAt: row.uploaded_at,
      fileSize: row.file_size,
      contentType: row.content_type,
      storageUrl: fileUrl("documents", row.storage_path),
      storagePath: row.storage_path,
      analysis: row.analysis,
      analyzedAt: row.analyzed_at,
      modelUsed: row.model_used,
    }));

    return c.json({ success: true, data });
  } catch (e: any) {
    console.error("Error getting document metadata:", e);
    return c.json({ error: "Failed to get document metadata" }, 500);
  }
});

// Delete a single document
app.delete("/document/:salgsoppgaveId/:documentId", async (c) => {
  const salgsoppgaveId = c.req.param("salgsoppgaveId");
  const documentId = c.req.param("documentId");
  try {
    const { rows } = await query(
      "SELECT storage_path FROM documents WHERE id = $1 AND project_id = $2",
      [documentId, salgsoppgaveId]
    );
    if (rows.length === 0) return c.json({ error: "Document not found" }, 404);

    const storagePath = rows[0].storage_path;

    // Delete DB record first, then file
    await query("DELETE FROM documents WHERE id = $1", [documentId]);
    await deleteFile("documents", storagePath);

    return c.json({ success: true });
  } catch (e: any) {
    console.error("Error deleting document:", e);
    return c.json({ error: "Failed to delete document" }, 500);
  }
});

// ---------------------------------------------------------------------------
// EXTRACTED DOCUMENTS (cached text)
// ---------------------------------------------------------------------------

// Save extracted documents
app.post("/documents/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const { documents } = await c.req.json();

    const sanitized = documents.map((doc: any) => ({
      ...doc,
      text: sanitizeText(doc.text || ""),
    }));

    await query(
      `INSERT INTO extracted_documents (project_id, documents, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (project_id) DO UPDATE SET documents = $2, updated_at = now()`,
      [id, JSON.stringify(sanitized)]
    );

    return c.json({ success: true, id, count: sanitized.length });
  } catch (e: any) {
    console.error("Error saving extracted documents:", e);
    return c.json({ error: "Failed to save extracted documents" }, 500);
  }
});

// Get extracted documents
app.get("/documents/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const { rows } = await query(
      "SELECT documents FROM extracted_documents WHERE project_id = $1",
      [id]
    );

    if (rows.length === 0) return c.json({ error: "Documents not found" }, 404);

    return c.json({ success: true, data: rows[0].documents });
  } catch (e: any) {
    console.error("Error getting extracted documents:", e);
    return c.json({ error: "Failed to get extracted documents" }, 500);
  }
});

// ---------------------------------------------------------------------------
// AI ANALYSIS
// ---------------------------------------------------------------------------

const OCR_SYSTEM_PROMPT =
  "You are an advanced OCR and document analysis engine. Your task is to extract ALL text, data, and structural information from the provided document or image. Convert the content into clean, structured Markdown. Tables should be represented as Markdown tables. Headers, lists, and key-value pairs should be preserved. If it is a floor plan, describe the layout and list all room names and sizes found. Do not add conversational filler. Output ONLY the Markdown.";

// --- Anthropic provider ---
async function analyzeWithAnthropic(
  fileData: Buffer,
  contentType: string,
  filename: string,
  isTruncated: boolean
): Promise<{ markdown: string; model: string }> {
  const model = "claude-sonnet-4-20250514";
  const base64 = fileData.toString("base64");
  const prompt = OCR_SYSTEM_PROMPT + (isTruncated ? " NOTE: This document has been truncated to the first 10 pages due to size limits." : "");

  const isPdf = contentType === "application/pdf" || contentType.includes("pdf");

  const content: any[] = [{ type: "text", text: prompt }];

  if (isPdf) {
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: base64 },
    });
  } else {
    // Map content type to Anthropic media types
    const mediaType = contentType.startsWith("image/") ? contentType : "image/png";
    content.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: base64 },
    });
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      messages: [{ role: "user", content }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("Anthropic Error:", err);
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = await response.json();
  const markdown = data.content?.[0]?.text || "";
  return { markdown, model };
}

// --- OpenRouter provider ---
async function getBestOCRModel(contentType: string): Promise<string> {
  const { rows } = await query("SELECT models, cached_at FROM model_cache WHERE id = 1");
  let modelIds: string[] = [];

  if (rows.length > 0) {
    const cacheAge = Date.now() - new Date(rows[0].cached_at).getTime();
    if (cacheAge < 24 * 3600 * 1000) modelIds = rows[0].models || [];
  }

  if (modelIds.length === 0 && OPENROUTER_API_KEY) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
      });
      if (response.ok) {
        const data = await response.json();
        modelIds = data.data.map((m: any) => m.id);
        await query(
          `INSERT INTO model_cache (id, models, cached_at) VALUES (1, $1, now())
           ON CONFLICT (id) DO UPDATE SET models = $1, cached_at = now()`,
          [JSON.stringify(modelIds)]
        );
      }
    } catch (e) {
      console.error("Failed to fetch OpenRouter models:", e);
    }
  }

  const models = new Set(modelIds);

  if (contentType === "application/pdf" || contentType.includes("pdf")) {
    if (models.has("google/gemini-2.0-flash-001")) return "google/gemini-2.0-flash-001";
    if (models.has("google/gemini-flash-1.5")) return "google/gemini-flash-1.5";
    if (models.has("anthropic/claude-3.5-sonnet")) return "anthropic/claude-3.5-sonnet";
    return "google/gemini-2.0-flash-001";
  }

  if (contentType.startsWith("image/")) {
    if (models.has("mistralai/pixtral-12b")) return "mistralai/pixtral-12b";
    return "google/gemini-2.0-flash-001";
  }

  return "google/gemini-2.0-flash-001";
}

async function analyzeWithOpenRouter(
  analysisUrl: string,
  contentType: string,
  filename: string,
  isTruncated: boolean,
  requestedModel?: string
): Promise<{ markdown: string; model: string }> {
  let model = requestedModel || (await getBestOCRModel(contentType));
  let plugins: any = undefined;

  if (model === "mistralai/mistral-ocr") {
    model = "google/gemini-2.0-flash-001";
    plugins = [{ id: "file-parser", pdf: { engine: "mistral-ocr" } }];
  }

  const prompt = OCR_SYSTEM_PROMPT + (isTruncated ? " NOTE: This document has been truncated to the first 10 pages due to size limits." : "");
  const isPdf = contentType === "application/pdf" || contentType.includes("pdf");

  const content: any[] = [{ type: "text", text: prompt }];

  if (isPdf) {
    content.push({ type: "file", file: { filename, file_data: analysisUrl } });
  } else {
    content.push({ type: "image_url", image_url: { url: analysisUrl } });
  }

  const payload: any = { model, messages: [{ role: "user", content }] };
  if (plugins) payload.plugins = plugins;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://homekey.aikemist.com",
      "X-Title": "HomeKey AI Salgsoppgave",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("OpenRouter Error:", err);
    throw new Error(`OpenRouter API error: ${response.status}`);
  }

  const data = await response.json();
  const markdown = data.choices?.[0]?.message?.content || "";
  return { markdown, model };
}

// Get available models
app.get("/models", async (c) => {
  try {
    const models: string[] = [];

    // Always include Anthropic models if key is set
    if (ANTHROPIC_API_KEY) {
      models.push("claude-sonnet-4-20250514", "claude-haiku-4-20250414");
    }

    if (OPENROUTER_API_KEY) {
      // Check cache (1 hour TTL)
      const { rows } = await query("SELECT models, cached_at FROM model_cache WHERE id = 1");

      let cachedModels: string[] = [];
      if (rows.length > 0 && Date.now() - new Date(rows[0].cached_at).getTime() < 3600000) {
        cachedModels = rows[0].models || [];
      } else {
        const response = await fetch("https://openrouter.ai/api/v1/models", {
          headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
        });
        if (response.ok) {
          const data = await response.json();
          cachedModels = data.data.map((m: any) => m.id);
          await query(
            `INSERT INTO model_cache (id, models, cached_at) VALUES (1, $1, now())
             ON CONFLICT (id) DO UPDATE SET models = $1, cached_at = now()`,
            [JSON.stringify(cachedModels)]
          );
        }
      }
      models.push(...cachedModels);
    }

    if (models.length === 0) {
      return c.json({ models: [], error: "No AI API keys configured" });
    }

    return c.json({ models });
  } catch (e: any) {
    console.error("Failed to fetch models:", e);
    return c.json({ error: "Failed to fetch models", models: [] }, 500);
  }
});

// Analyze document
app.post("/analyze-document/:salgsoppgaveId/:documentId", async (c) => {
  const salgsoppgaveId = c.req.param("salgsoppgaveId");
  const documentId = c.req.param("documentId");

  try {
    const body = await c.req.json().catch(() => ({}));
    const requestedModel = body.model;

    if (AI_PROVIDER === "none") throw new Error("No AI API key configured");

    // 1. Get document from DB
    const { rows } = await query(
      "SELECT id, filename, content_type, file_size, storage_path FROM documents WHERE id = $1 AND project_id = $2",
      [documentId, salgsoppgaveId]
    );
    if (rows.length === 0) return c.json({ error: "Document not found" }, 404);

    const doc = rows[0];
    const MAX_SIZE_BYTES = 5 * 1024 * 1024;
    let fileData: Buffer | null = null;
    let analysisUrl = "";
    let isTruncated = false;
    let tempPath: string | null = null;

    const isPdf = doc.content_type === "application/pdf" || doc.content_type?.includes("pdf");

    // 2. Handle large PDFs — truncate to first 10 pages
    if (doc.file_size > MAX_SIZE_BYTES && isPdf) {
      console.log(`Document ${doc.filename} is too large (${doc.file_size}). Truncating...`);
      try {
        const origData = await readFile("documents", doc.storage_path);
        const srcDoc = await PDFDocument.load(origData);
        const dstDoc = await PDFDocument.create();

        const pageCount = srcDoc.getPageCount();
        const pagesToCopy = Math.min(pageCount, 10);
        const pageIndices = Array.from({ length: pagesToCopy }, (_, i) => i);

        const copiedPages = await dstDoc.copyPages(srcDoc, pageIndices);
        copiedPages.forEach((page) => dstDoc.addPage(page));

        const truncatedBytes = await dstDoc.save();
        fileData = Buffer.from(truncatedBytes);

        // Also save truncated version for OpenRouter URL access
        tempPath = `temp/truncated_${Date.now()}_${doc.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        await saveFile("documents", tempPath, fileData);
        analysisUrl = fileUrl("documents", tempPath);
        isTruncated = true;
      } catch (truncError) {
        console.error("Failed to truncate PDF:", truncError);
      }
    }

    // 3. Read file if not already loaded (for Anthropic base64)
    if (!fileData) {
      fileData = await readFile("documents", doc.storage_path);
    }
    if (!analysisUrl) {
      analysisUrl = fileUrl("documents", doc.storage_path);
    }

    // 4. Determine which provider to use
    const useAnthropic =
      ANTHROPIC_API_KEY &&
      (!requestedModel || requestedModel.startsWith("claude-"));

    let markdown: string;
    let model: string;

    if (useAnthropic) {
      console.log(`Analyzing ${doc.filename} with Anthropic (Claude)`);
      ({ markdown, model } = await analyzeWithAnthropic(fileData, doc.content_type, doc.filename, isTruncated));
    } else if (OPENROUTER_API_KEY) {
      console.log(`Analyzing ${doc.filename} with OpenRouter`);
      ({ markdown, model } = await analyzeWithOpenRouter(analysisUrl, doc.content_type, doc.filename, isTruncated, requestedModel));
    } else {
      throw new Error("No suitable AI provider for requested model");
    }

    // 5. Save analysis result to document row
    await query(
      "UPDATE documents SET analysis = $1, analyzed_at = now(), model_used = $2 WHERE id = $3",
      [markdown, model, documentId]
    );

    // 6. Clean up temp file if created
    if (tempPath) {
      deleteFile("documents", tempPath).catch(() => {});
    }

    return c.json({ success: true, analysis: markdown, model });
  } catch (e: any) {
    console.error("Analysis failed:", e);
    return c.json({ error: "Analysis failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// IMAGE UPLOAD & MANAGEMENT
// ---------------------------------------------------------------------------

// Upload images
app.post("/upload-images/:id", async (c) => {
  const salgsoppgaveId = c.req.param("id");
  try {
    const formData = await c.req.formData();
    const uploaded: any[] = [];

    // Get current max sort_order
    const { rows: orderRows } = await query(
      "SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM images WHERE project_id = $1",
      [salgsoppgaveId]
    );
    let nextOrder = (orderRows[0]?.max_order ?? -1) + 1;

    for (const [key, value] of formData.entries()) {
      if (key.startsWith("image_") && value instanceof File) {
        const file = value;

        // Validate file size
        if (file.size > MAX_UPLOAD_SIZE) {
          return c.json({ error: `Image ${file.name} exceeds ${MAX_UPLOAD_SIZE / 1024 / 1024}MB limit` }, 400);
        }

        // Validate file type
        if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
          return c.json({ error: `File type ${file.type} not allowed for ${file.name}. Only images are accepted.` }, 400);
        }

        const imageId = `img_${Date.now()}_${crypto.randomUUID().substring(0, 9)}`;
        const sanitizedFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const storagePath = `${salgsoppgaveId}/${imageId}_${sanitizedFilename}`;

        const arrayBuffer = await file.arrayBuffer();
        await saveFile("images", storagePath, Buffer.from(arrayBuffer));

        await query(
          `INSERT INTO images (id, project_id, filename, file_size, storage_path, sort_order, uploaded_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())`,
          [imageId, salgsoppgaveId, file.name, file.size, storagePath, nextOrder++]
        );

        uploaded.push({
          id: imageId,
          filename: file.name,
          uploadedAt: new Date().toISOString(),
          fileSize: file.size,
          storageUrl: fileUrl("images", storagePath),
          storagePath,
          caption: "",
        });
      }
    }

    return c.json({ success: true, data: uploaded });
  } catch (e: any) {
    console.error("Error uploading images:", e);
    return c.json({ error: "Failed to upload images" }, 500);
  }
});

// Get image metadata
app.get("/images-metadata/:id", async (c) => {
  const salgsoppgaveId = c.req.param("id");
  try {
    const { rows } = await query(
      `SELECT id, filename, file_size, storage_path, caption, title, category, is_main_image, sort_order, uploaded_at
       FROM images WHERE project_id = $1 ORDER BY sort_order, uploaded_at`,
      [salgsoppgaveId]
    );

    const data = rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      uploadedAt: row.uploaded_at,
      fileSize: row.file_size,
      storageUrl: fileUrl("images", row.storage_path),
      storagePath: row.storage_path,
      caption: row.caption ?? "",
      title: row.title,
      category: row.category,
      isMainImage: row.is_main_image ?? false,
    }));

    return c.json({ success: true, data });
  } catch (e: any) {
    console.error("Error getting image metadata:", e);
    return c.json({ error: "Failed to get image metadata" }, 500);
  }
});

// Update image caption
app.put("/image-caption/:salgsoppgaveId/:imageId", async (c) => {
  const { salgsoppgaveId, imageId } = c.req.param() as any;
  try {
    const { caption } = await c.req.json();
    const { rowCount } = await query(
      "UPDATE images SET caption = $1 WHERE id = $2 AND project_id = $3",
      [caption, imageId, salgsoppgaveId]
    );
    if (rowCount === 0) return c.json({ error: "Image not found" }, 404);
    return c.json({ success: true });
  } catch (e: any) {
    console.error("Error updating image caption:", e);
    return c.json({ error: "Failed to update image caption" }, 500);
  }
});

// Update image title
app.put("/image-title/:salgsoppgaveId/:imageId", async (c) => {
  const { salgsoppgaveId, imageId } = c.req.param() as any;
  try {
    const { title } = await c.req.json();
    const { rowCount } = await query(
      "UPDATE images SET title = $1 WHERE id = $2 AND project_id = $3",
      [title, imageId, salgsoppgaveId]
    );
    if (rowCount === 0) return c.json({ error: "Image not found" }, 404);
    return c.json({ success: true });
  } catch (e: any) {
    console.error("Error updating image title:", e);
    return c.json({ error: "Failed to update image title" }, 500);
  }
});

// Update image category
app.put("/image-category/:salgsoppgaveId/:imageId", async (c) => {
  const { salgsoppgaveId, imageId } = c.req.param() as any;
  try {
    const { category } = await c.req.json();
    const { rowCount } = await query(
      "UPDATE images SET category = $1 WHERE id = $2 AND project_id = $3",
      [category, imageId, salgsoppgaveId]
    );
    if (rowCount === 0) return c.json({ error: "Image not found" }, 404);
    return c.json({ success: true });
  } catch (e: any) {
    console.error("Error updating image category:", e);
    return c.json({ error: "Failed to update image category" }, 500);
  }
});

// Update main image status — uses transaction
app.put("/image-main/:salgsoppgaveId/:imageId", async (c) => {
  const { salgsoppgaveId, imageId } = c.req.param() as any;
  try {
    const { isMainImage } = await c.req.json();

    await withTransaction(async (client) => {
      // If setting as main, unset all others first
      if (isMainImage) {
        await client.query(
          "UPDATE images SET is_main_image = false WHERE project_id = $1",
          [salgsoppgaveId]
        );
      }

      const { rowCount } = await client.query(
        "UPDATE images SET is_main_image = $1 WHERE id = $2 AND project_id = $3",
        [isMainImage, imageId, salgsoppgaveId]
      );
      if (rowCount === 0) throw new Error("Image not found");
    });

    return c.json({ success: true });
  } catch (e: any) {
    if (e.message === "Image not found") return c.json({ error: "Image not found" }, 404);
    console.error("Error updating main image:", e);
    return c.json({ error: "Failed to update main image" }, 500);
  }
});

// Update image order — single query instead of N+1
app.put("/images-order/:salgsoppgaveId", async (c) => {
  const salgsoppgaveId = c.req.param("salgsoppgaveId");
  try {
    const { imageIds } = await c.req.json();
    if (!Array.isArray(imageIds)) return c.json({ error: "imageIds must be array" }, 400);

    // Single query with unnest instead of N separate UPDATEs
    await withTransaction(async (client) => {
      const sortOrders = imageIds.map((_: string, i: number) => i);
      await client.query(
        `UPDATE images SET sort_order = v.sort_order
         FROM (SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS sort_order) v
         WHERE images.id = v.id AND images.project_id = $3`,
        [imageIds, sortOrders, salgsoppgaveId]
      );
    });

    return c.json({ success: true });
  } catch (e: any) {
    console.error("Error reordering images:", e);
    return c.json({ error: "Failed to reorder images" }, 500);
  }
});

// Delete image — delete DB first, then file
app.delete("/image/:salgsoppgaveId/:imageId", async (c) => {
  const { salgsoppgaveId, imageId } = c.req.param() as any;
  try {
    const { rows } = await query(
      "SELECT storage_path FROM images WHERE id = $1 AND project_id = $2",
      [imageId, salgsoppgaveId]
    );
    if (rows.length === 0) return c.json({ error: "Image not found" }, 404);

    const storagePath = rows[0].storage_path;

    // Delete DB record first, then file
    await query("DELETE FROM images WHERE id = $1", [imageId]);
    await deleteFile("images", storagePath);

    return c.json({ success: true });
  } catch (e: any) {
    console.error("Error deleting image:", e);
    return c.json({ error: "Failed to delete image" }, 500);
  }
});

// ---------------------------------------------------------------------------
// IMAGE CAPTION GENERATION — uses Anthropic (primary) or OpenRouter (fallback)
// ---------------------------------------------------------------------------

app.post("/generate-caption", async (c) => {
  try {
    if (AI_PROVIDER === "none") {
      return c.json({ error: "No AI provider configured on server" }, 500);
    }

    const { imageUrl, prompt } = await c.req.json();
    if (!imageUrl) {
      return c.json({ error: "imageUrl is required" }, 400);
    }

    const systemPrompt = "Du er en profesjonell eiendomsmegler som skriver bildetekster for boligannonser. Skriv korte, presise og tiltalende bildetekster i typisk meglerstil. Fokuser på romtype, stil, lysinfall og kvalitetsfølelse. Maks 15-20 ord.";
    const userPrompt = prompt || "Analyser dette bildet og skriv en kort, profesjonell bildetekst i meglerstil som beskriver hva som vises. Bruk norsk språk.";

    let caption = "";

    // --- Try Anthropic first ---
    if (ANTHROPIC_API_KEY) {
      try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 150,
            system: systemPrompt,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: { type: "url", url: imageUrl },
                  },
                  {
                    type: "text",
                    text: userPrompt,
                  },
                ],
              },
            ],
          }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          console.error("Anthropic caption error:", err);
          throw new Error(err.error?.message || `Anthropic API error: ${response.status}`);
        }

        const data = await response.json();
        caption = data.content?.[0]?.text?.trim() || "";
      } catch (anthropicErr: any) {
        console.error("Anthropic caption failed, trying OpenRouter fallback:", anthropicErr.message);
        if (!OPENROUTER_API_KEY) throw anthropicErr;
        // Fall through to OpenRouter
      }
    }

    // --- OpenRouter (fallback or primary) ---
    if (!caption && OPENROUTER_API_KEY) {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://homekey.aikemist.com",
          "X-Title": "HomeKey AI Salgsoppgave",
        },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4",
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                { type: "text", text: userPrompt },
                { type: "image_url", image_url: { url: imageUrl } },
              ],
            },
          ],
          max_tokens: 150,
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        console.error("OpenRouter caption error:", err);
        throw new Error(err.error?.message || `OpenRouter API error: ${response.status}`);
      }

      const data = await response.json();
      caption = data.choices?.[0]?.message?.content?.trim() || "";
    }

    if (!caption) {
      return c.json({ error: "No caption generated" }, 500);
    }

    return c.json({ caption });
  } catch (e: any) {
    console.error("Caption generation error:", e);
    return c.json({ error: "Failed to generate caption" }, 500);
  }
});

// ---------------------------------------------------------------------------
// AI CHAT PROXY  (OpenAI-compatible → Anthropic / OpenRouter)
// ---------------------------------------------------------------------------

const ANTHROPIC_MODEL_MAP: Record<string, string> = {
  "claude-sonnet-4": "claude-sonnet-4-20250514",
  "claude-haiku-4": "claude-haiku-4-5-20241022",
};
const OPENROUTER_MODEL_MAP: Record<string, string> = {
  "claude-sonnet-4": "anthropic/claude-sonnet-4",
  "claude-haiku-4": "anthropic/claude-haiku-4.5",
};

app.post("/ai/chat", async (c) => {
  try {
    if (AI_PROVIDER === "none") {
      return c.json({ error: "No AI provider configured on server" }, 503);
    }

    const body = await c.req.json();
    const {
      messages = [],
      model = "claude-sonnet-4",
      max_tokens = 4096,
      temperature,
      response_format,
    } = body;

    // --- Try Anthropic first ---
    if (ANTHROPIC_API_KEY) {
      try {
        // Extract system messages
        const systemParts: string[] = [];
        const nonSystemMessages: Array<{ role: string; content: string }> = [];
        for (const msg of messages) {
          if (msg.role === "system") {
            systemParts.push(msg.content);
          } else {
            nonSystemMessages.push({ role: msg.role, content: msg.content });
          }
        }

        // If JSON mode requested, append instruction
        let systemText = systemParts.join("\n\n");
        if (response_format?.type === "json_object") {
          systemText += "\n\nIMPORTANT: You MUST respond with valid JSON only. No markdown, no explanation, just a JSON object.";
        }

        const anthropicModel = ANTHROPIC_MODEL_MAP[model] || model;

        const anthropicBody: any = {
          model: anthropicModel,
          max_tokens,
          messages: nonSystemMessages,
        };
        if (systemText) anthropicBody.system = systemText;
        if (temperature !== undefined) anthropicBody.temperature = temperature;

        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(anthropicBody),
        });

        if (!response.ok) {
          const errText = await response.text();
          console.error("Anthropic API error:", response.status, errText);
          throw new Error(`Anthropic error ${response.status}: ${errText}`);
        }

        const data: any = await response.json();

        // Normalize to OpenAI-compatible shape
        const textContent = data.content?.find((b: any) => b.type === "text")?.text || "";
        const finishReason = data.stop_reason === "end_turn" ? "stop" : data.stop_reason === "max_tokens" ? "length" : "stop";

        return c.json({
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: textContent },
              finish_reason: finishReason,
            },
          ],
          usage: {
            prompt_tokens: data.usage?.input_tokens || 0,
            completion_tokens: data.usage?.output_tokens || 0,
            total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
          },
          model: data.model || anthropicModel,
        });
      } catch (anthropicErr: any) {
        console.error("Anthropic failed, trying OpenRouter fallback:", anthropicErr.message);
        if (!OPENROUTER_API_KEY) throw anthropicErr;
        // Fall through to OpenRouter
      }
    }

    // --- OpenRouter (fallback or primary) ---
    if (OPENROUTER_API_KEY) {
      const openRouterModel = OPENROUTER_MODEL_MAP[model] || model;

      const orBody: any = {
        model: openRouterModel,
        messages,
        max_tokens,
      };
      if (temperature !== undefined) orBody.temperature = temperature;
      if (response_format) orBody.response_format = response_format;

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify(orBody),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error("OpenRouter API error:", response.status, errText);
        return c.json({ error: `AI provider error: ${response.status}` }, 502);
      }

      // OpenRouter already returns OpenAI-compatible format
      const data = await response.json();
      return c.json(data);
    }

    return c.json({ error: "No AI provider available" }, 503);
  } catch (e: any) {
    console.error("AI chat proxy error:", e);
    return c.json({ error: e.message || "AI processing failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// SYSTEM PROMPTS
// ---------------------------------------------------------------------------

app.post("/system-prompts", async (c) => {
  try {
    const data = await c.req.json();
    await query(
      `INSERT INTO system_prompts (id, global_prompt, category_prompts, field_prompts, field_web_search_enabled, updated_at)
       VALUES (1, $1, $2, $3, $4, now())
       ON CONFLICT (id) DO UPDATE SET
         global_prompt = $1, category_prompts = $2, field_prompts = $3,
         field_web_search_enabled = $4, updated_at = now()`,
      [
        data.globalPrompt ?? "",
        JSON.stringify(data.categoryPrompts ?? {}),
        JSON.stringify(data.fieldPrompts ?? {}),
        JSON.stringify(data.fieldWebSearchEnabled ?? {}),
      ]
    );
    return c.json({ success: true });
  } catch (e: any) {
    console.error("Error saving system prompts:", e);
    return c.json({ error: "Failed to save system prompts" }, 500);
  }
});

app.get("/system-prompts", async (c) => {
  try {
    const { rows } = await query(
      "SELECT global_prompt, category_prompts, field_prompts, field_web_search_enabled FROM system_prompts WHERE id = 1"
    );

    if (rows.length === 0) return c.json({ error: "Not found" }, 404);

    const row = rows[0];
    return c.json({
      success: true,
      data: {
        globalPrompt: row.global_prompt,
        categoryPrompts: row.category_prompts,
        fieldPrompts: row.field_prompts,
        fieldWebSearchEnabled: row.field_web_search_enabled,
      },
    });
  } catch (e: any) {
    console.error("Error getting system prompts:", e);
    return c.json({ error: "Failed to get system prompts" }, 500);
  }
});

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------

app.notFound((c) => {
  console.log(`404: ${c.req.method} ${c.req.path}`);
  return c.json({ error: "Not Found" }, 404);
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

console.log(`Starting HomeKey server on port ${PORT}...`);

serve({
  fetch: app.fetch,
  port: PORT,
});

console.log(`HomeKey server running at http://localhost:${PORT}`);
