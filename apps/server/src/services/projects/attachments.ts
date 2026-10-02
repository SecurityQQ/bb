// oxlint-disable-next-line no-restricted-imports
import { renameSync } from "node:fs";
import { and, eq, isNull } from "drizzle-orm";
import {
  getProjectAttachment,
  recordProjectAttachment,
  projectAttachments,
  projectAttachmentBackfills,
  attachmentUnavailable,
  type DbConnection,
  type ProjectAttachmentRow,
} from "@bb/db";
import {
  canonicalProjectAttachmentPath,
  ProjectAttachmentError,
  promptInputSchema,
  runtimePromptInputSchema,
  pathLooksRuntimeReadable,
  PROMPT_ATTACHMENT_MAX_BYTES,
} from "@bb/domain";
// oxlint-disable-next-line no-restricted-imports
import {
  mkdir,
  opendir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { resolveContainedPath } from "@bb/process-utils";
import type {
  RuntimePromptInput,
  ReferencePromptHistoryEntry,
} from "@bb/domain";
import type {
  UploadedPromptAttachment,
  IncomingPromptInput,
} from "@bb/server-contract";
import mimeTypes from "mime-types";
import { ApiError } from "../../errors.js";
import { requirePublicProject } from "../lib/entity-lookup.js";

const HEIF_IMAGE_MIME_TYPES = new Set([
  "image/heic",
  "image/heic-sequence",
  "image/heif",
  "image/heif-sequence",
]);

interface ResolvePromptAttachmentReferencesArgs {
  db: DbConnection;
  dataDir: string;
  input: RuntimePromptInput[];
  projectId: string;
}

function sanitizeFilename(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]+/gu, "-");
  return base.length > 0 ? base : "attachment";
}

function buildStoredFilename(originalName: string): string {
  const sanitized = sanitizeFilename(originalName);
  const extension = extname(sanitized);
  const stem =
    extension.length > 0 ? sanitized.slice(0, -extension.length) : sanitized;
  return `${stem}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`;
}

function projectAttachmentDir(dataDir: string, projectId: string): string {
  return join(dataDir, "attachments", projectId);
}

function resolveAttachmentPath(
  attachmentDir: string,
  relativePath: string,
): string {
  let normalizedRelativePath: string;
  try {
    normalizedRelativePath = canonicalProjectAttachmentPath(relativePath);
  } catch (error) {
    throw new ApiError(
      400,
      "invalid_request",
      error instanceof Error ? error.message : "Invalid attachment path",
    );
  }
  const resolvedAttachmentDir = resolve(attachmentDir);
  const resolvedCandidatePath = resolve(
    resolvedAttachmentDir,
    normalizedRelativePath,
  );

  if (resolvedCandidatePath === resolvedAttachmentDir) {
    throw new ApiError(
      400,
      "invalid_request",
      "Attachment path must refer to a file inside the project directory",
    );
  }

  const resolvedPath = resolveContainedPath({
    rootPath: resolvedAttachmentDir,
    candidatePath: resolvedCandidatePath,
  });

  if (resolvedPath) {
    return resolvedPath;
  }

  throw new ApiError(
    400,
    "invalid_request",
    "Attachment path escapes project directory",
  );
}

function missingAttachmentReferenceError(attachmentPath: string): ApiError {
  return new ApiError(
    400,
    "invalid_request",
    `Attachment ${attachmentPath} was not uploaded for this project. Upload files with POST /api/v1/projects/:id/attachments and use the returned path in localFile/localImage prompt input; relative workspace file paths are not valid attachment references.`,
  );
}

export async function ensureAttachmentReferenceExists(
  db: DbConnection,
  dataDir: string,
  projectId: string,
  attachmentPath: string,
): Promise<void> {
  const dir = projectAttachmentDir(dataDir, projectId);
  const resolved = resolveAttachmentPath(dir, attachmentPath);
  const storedPath = canonicalProjectAttachmentPath(attachmentPath);
  const existing = getProjectAttachment(db, projectId, storedPath);
  if (
    existing &&
    (existing.deletionClaimedAt !== null || existing.readyAt === null)
  )
    throw attachmentUnavailable(storedPath);
  if (!existing) {
    const backfill = db
      .select()
      .from(projectAttachmentBackfills)
      .where(eq(projectAttachmentBackfills.projectId, projectId))
      .get();
    if (backfill?.phase === "done")
      throw missingAttachmentReferenceError(storedPath);
  }
  const fileStat = await stat(resolved).catch(() => null);
  if (!fileStat || !fileStat.isFile())
    throw missingAttachmentReferenceError(attachmentPath);
  if (!existing) {
    recordProjectAttachment(db, {
      projectId,
      storedPath,
      originalName: basename(storedPath),
      mimeType: mimeTypes.lookup(storedPath) || null,
      sizeBytes: fileStat.size,
      createdAt: Math.floor(fileStat.mtimeMs),
      readyAt: Date.now(),
    });
  }
}

export async function inventoryAttachmentReference(
  db: DbConnection,
  dataDir: string,
  projectId: string,
  attachmentPath: string,
): Promise<void> {
  const storedPath = canonicalProjectAttachmentPath(attachmentPath);
  if (getProjectAttachment(db, projectId, storedPath)) return;
  const resolved = resolveAttachmentPath(
    projectAttachmentDir(dataDir, projectId),
    storedPath,
  );
  const fileStat = await stat(resolved).catch(() => null);
  if (!fileStat || !fileStat.isFile()) return;
  recordProjectAttachment(db, {
    projectId,
    storedPath,
    originalName: basename(storedPath),
    mimeType: mimeTypes.lookup(storedPath) || null,
    sizeBytes: fileStat.size,
    createdAt: Math.floor(fileStat.mtimeMs),
    readyAt: Date.now(),
  });
}

export async function inventoryAttachmentReferences(
  db: DbConnection,
  dataDir: string,
  projectId: string,
  paths: readonly string[],
): Promise<void> {
  for (const storedPath of paths) {
    await inventoryAttachmentReference(db, dataDir, projectId, storedPath);
  }
}

export async function referenceHistoryInput(
  db: DbConnection,
  dataDir: string,
  projectId: string,
  input: readonly RuntimePromptInput[],
): Promise<ReferencePromptHistoryEntry["input"]> {
  return Promise.all(
    input.map(
      async (item): Promise<ReferencePromptHistoryEntry["input"][number]> => {
        if (item.type !== "localFile" && item.type !== "localImage")
          return item;
        const visibility = item.visibility
          ? { visibility: item.visibility }
          : {};
        if (pathLooksRuntimeReadable(item.path)) {
          if (item.hostId)
            return {
              type: item.type,
              hostId: item.hostId,
              path: item.path,
              ...visibility,
            };
          return {
            type: "unavailableAttachment",
            path: item.path,
            reason:
              "The original host was not recorded. Upload the file again.",
          };
        }
        try {
          const attachment = await lookupAttachmentResource(
            db,
            dataDir,
            projectId,
            item.path,
          );
          return {
            type: "attachment",
            attachmentId: attachment.id,
            ...visibility,
          };
        } catch (error) {
          if (
            !(error instanceof ApiError) &&
            !(error instanceof ProjectAttachmentError)
          )
            throw error;
          return {
            type: "unavailableAttachment",
            path: item.path,
            reason: "The uploaded attachment is unavailable or has expired.",
          };
        }
      },
    ),
  );
}

export function resolvePromptHost(
  input: RuntimePromptInput[],
  hostId: string | null,
): RuntimePromptInput[] {
  return input.map((item) => {
    if (
      (item.type !== "localFile" && item.type !== "localImage") ||
      !pathLooksRuntimeReadable(item.path)
    )
      return item;
    if (item.unavailableReason)
      throw new ApiError(400, "attachment_unavailable", item.unavailableReason);
    if (
      hostId === null ||
      (item.hostId !== undefined && item.hostId !== hostId)
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "Local attachments require the destination host; upload the file to use it on another host",
      );
    }
    return { ...item, hostId };
  });
}

export function requireAttachmentById(
  db: DbConnection,
  id: string,
): ProjectAttachmentRow {
  const row = db
    .select()
    .from(projectAttachments)
    .where(eq(projectAttachments.id, id))
    .get();
  if (!row || row.readyAt === null || row.deletionClaimedAt !== null) {
    throw new ApiError(
      400,
      "attachment_unavailable",
      "Attachment is unavailable or has expired",
    );
  }
  requirePublicProject(db, row.projectId);
  return row;
}

export function attachmentResource(
  row: ProjectAttachmentRow,
): UploadedPromptAttachment {
  return {
    id: row.id,
    type: row.mimeType?.startsWith("image/") ? "localImage" : "localFile",
    path: row.storedPath,
    experimental_sourceProjectId: row.projectId,
    name: row.originalName,
    mimeType: row.mimeType ?? "application/octet-stream",
    sizeBytes: row.sizeBytes,
  };
}

export async function lookupAttachmentResource(
  db: DbConnection,
  dataDir: string,
  projectId: string,
  path: string,
): Promise<UploadedPromptAttachment> {
  requirePublicProject(db, projectId);
  await ensureAttachmentReferenceExists(db, dataDir, projectId, path);
  const row = getProjectAttachment(
    db,
    projectId,
    canonicalProjectAttachmentPath(path),
  );
  if (!row) throw missingAttachmentReferenceError(path);
  return attachmentResource(requireAttachmentById(db, row.id));
}

export function normalizeIncomingPromptInput(
  db: DbConnection,
  input: readonly IncomingPromptInput[],
): RuntimePromptInput[] {
  return input.map((item) => {
    if (item.type !== "attachment") {
      if (item.type !== "localFile" && item.type !== "localImage") return item;
      if (
        item.hostId !== undefined &&
        !promptInputSchema.safeParse(item).success
      ) {
        throw new ApiError(
          400,
          "invalid_request",
          "Host file references require an absolute path",
        );
      }
      const {
        attachmentId: _attachmentId,
        unavailableReason: _unavailableReason,
        ...legacy
      } = runtimePromptInputSchema.options[
        item.type === "localImage" ? 2 : 3
      ].parse(item);
      return legacy;
    }
    const row = requireAttachmentById(db, item.attachmentId);
    const { type: _type, attachmentId: _attachmentId, ...visibility } = item;
    return {
      ...visibility,
      type: row.mimeType?.startsWith("image/") ? "localImage" : "localFile",
      path: row.storedPath,
      experimental_sourceProjectId: row.projectId,
      attachmentId: row.id,
      name: row.originalName,
      sizeBytes: row.sizeBytes,
      mimeType: row.mimeType ?? "application/octet-stream",
    };
  });
}

export async function resolvePromptAttachmentReferences(
  args: ResolvePromptAttachmentReferencesArgs,
): Promise<RuntimePromptInput[]> {
  const resolved: RuntimePromptInput[] = [];
  const copies = new Map<string, Set<string>>();
  for (const input of args.input) {
    if (input.type !== "localFile" && input.type !== "localImage") {
      resolved.push(input);
      continue;
    }
    if (pathLooksRuntimeReadable(input.path)) {
      if (input.experimental_sourceProjectId !== undefined) {
        throw new ApiError(
          400,
          "invalid_request",
          "A source project can only be specified for an uploaded attachment",
        );
      }
      resolved.push(input);
      continue;
    }
    const {
      experimental_sourceProjectId: sourceProjectId = args.projectId,
      ...attachment
    } = input;
    requirePublicProject(args.db, sourceProjectId);
    await ensureAttachmentReferenceExists(
      args.db,
      args.dataDir,
      sourceProjectId,
      input.path,
    );
    if (sourceProjectId !== args.projectId) {
      const paths = copies.get(sourceProjectId) ?? new Set<string>();
      paths.add(input.path);
      copies.set(sourceProjectId, paths);
    }
    resolved.push(attachment);
  }
  for (const [sourceProjectId, paths] of copies) {
    await copyProjectAttachments(
      args.db,
      args.dataDir,
      sourceProjectId,
      args.projectId,
      [...paths],
    );
  }
  return resolved.map((item) => {
    if (
      (item.type !== "localFile" && item.type !== "localImage") ||
      pathLooksRuntimeReadable(item.path)
    )
      return item;
    const row = getProjectAttachment(
      args.db,
      args.projectId,
      canonicalProjectAttachmentPath(item.path),
    );
    if (!row) throw missingAttachmentReferenceError(item.path);
    return {
      ...item,
      attachmentId: row.id,
      ...(item.type === "localFile"
        ? {
            name: row.originalName,
            sizeBytes: row.sizeBytes,
            mimeType: row.mimeType ?? "application/octet-stream",
          }
        : {}),
    };
  });
}

function formatMegabytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return Number.isInteger(megabytes) ? String(megabytes) : megabytes.toFixed(1);
}

function isHeifImageUpload(file: File): boolean {
  const mimeType = (file.type.split(";")[0] ?? "").trim().toLowerCase();
  return HEIF_IMAGE_MIME_TYPES.has(mimeType);
}

export async function storeAttachment(
  db: DbConnection,
  dataDir: string,
  projectId: string,
  file: File,
): Promise<UploadedPromptAttachment> {
  if (isHeifImageUpload(file)) {
    throw new ApiError(
      400,
      "invalid_request",
      "HEIC images are not supported. Convert the image to JPEG or PNG before attaching it.",
    );
  }
  const isImage = (file.type || "").startsWith("image/");
  if (file.size > PROMPT_ATTACHMENT_MAX_BYTES) {
    throw new ApiError(
      400,
      "invalid_request",
      `${file.name} is ${formatMegabytes(file.size)}MB, over the ${formatMegabytes(
        PROMPT_ATTACHMENT_MAX_BYTES,
      )}MB attachment limit`,
    );
  }

  const dir = projectAttachmentDir(dataDir, projectId);
  await mkdir(dir, { recursive: true });

  const storedName = buildStoredFilename(file.name);
  const bytes = Buffer.from(await file.arrayBuffer());
  await writeInventoriedAttachment(
    db,
    dataDir,
    projectId,
    storedName,
    bytes,
    file.name,
    file.type || null,
  );

  return {
    id: getProjectAttachment(db, projectId, storedName)!.id,
    type: isImage ? "localImage" : "localFile",
    experimental_sourceProjectId: projectId,
    path: storedName,
    name: file.name,
    mimeType: file.type || undefined,
    sizeBytes: file.size,
  };
}

interface StoredAttachmentContent {
  content: Buffer;
  etag: string;
  mimeType?: string;
}

export async function readAttachment(
  dataDir: string,
  projectId: string,
  relativePath: string,
): Promise<StoredAttachmentContent> {
  const dir = projectAttachmentDir(dataDir, projectId);
  const resolved = resolveAttachmentPath(dir, relativePath);

  const fileStat = await stat(resolved).catch(() => null);
  if (!fileStat || !fileStat.isFile()) {
    throw new ApiError(404, "invalid_request", "Attachment not found");
  }

  return {
    content: await readFile(resolved),
    etag: `"${fileStat.size.toString(16)}-${Math.floor(fileStat.mtimeMs).toString(16)}"`,
    mimeType: mimeTypes.lookup(resolved) || undefined,
  };
}

export async function copyProjectAttachments(
  db: DbConnection,
  dataDir: string,
  sourceProjectId: string,
  targetProjectId: string,
  attachmentPaths: readonly string[],
): Promise<void> {
  if (sourceProjectId === targetProjectId || attachmentPaths.length === 0) {
    return;
  }

  const uniquePaths = [
    ...new Set(attachmentPaths.map(canonicalProjectAttachmentPath)),
  ];
  const attachments = [];
  for (const path of uniquePaths) {
    const { content } = await readAttachment(dataDir, sourceProjectId, path);
    attachments.push({ path, content });
  }
  for (const { path, content } of attachments) {
    await writeInventoriedAttachment(
      db,
      dataDir,
      targetProjectId,
      path,
      content,
      basename(path),
      mimeTypes.lookup(path) || null,
    );
  }
}

export async function deleteProjectAttachments(
  dataDir: string,
  projectId: string,
): Promise<void> {
  await rm(projectAttachmentDir(dataDir, projectId), {
    force: true,
    recursive: true,
  });
}

export function pendingAttachmentPath(
  dataDir: string,
  projectId: string,
  id: string,
): string {
  return join(projectAttachmentDir(dataDir, projectId), ".pending", id);
}

async function writeInventoriedAttachment(
  db: DbConnection,
  dataDir: string,
  projectId: string,
  storedPath: string,
  content: Buffer,
  originalName: string,
  mimeType: string | null,
): Promise<void> {
  const existing = getProjectAttachment(db, projectId, storedPath);
  if (existing) {
    await ensureAttachmentReferenceExists(db, dataDir, projectId, storedPath);
    return;
  }
  const now = Date.now();
  const row = recordProjectAttachment(db, {
    projectId,
    storedPath,
    originalName,
    mimeType,
    sizeBytes: content.length,
    createdAt: now,
    readyAt: null,
  });
  const pendingPath = pendingAttachmentPath(dataDir, projectId, row.id);
  const outputPath = resolveAttachmentPath(
    projectAttachmentDir(dataDir, projectId),
    storedPath,
  );
  try {
    await mkdir(dirname(pendingPath), { recursive: true });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(pendingPath, content, { flag: "wx" });
    db.transaction(
      (tx) => {
        const current = getProjectAttachment(tx, projectId, storedPath);
        if (
          !current ||
          current.id !== row.id ||
          current.deletionClaimedAt !== null ||
          current.readyAt !== null
        )
          throw attachmentUnavailable(storedPath);
        renameSync(pendingPath, outputPath);
        tx.update(projectAttachments)
          .set({ readyAt: Date.now() })
          .where(eq(projectAttachments.id, row.id))
          .run();
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    await rm(pendingPath, { force: true });
    db.update(projectAttachments)
      .set({ deletionClaimedAt: Date.now() })
      .where(
        and(
          eq(projectAttachments.id, row.id),
          isNull(projectAttachments.readyAt),
        ),
      )
      .run();
    throw error;
  }
}

async function* walkFiles(root: string, prefix = ""): AsyncGenerator<string> {
  const dir = await opendir(join(root, prefix)).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });
  if (!dir) return;
  for await (const entry of dir) {
    if (prefix === "" && entry.name === ".pending") continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walkFiles(root, path);
    else if (entry.isFile()) yield path;
    else throw new Error(`Attachment inventory cannot inspect ${path}`);
  }
}

export function walkProjectAttachmentFiles(
  dataDir: string,
  projectId: string,
): AsyncGenerator<string> {
  return walkFiles(projectAttachmentDir(dataDir, projectId));
}

export async function deleteInventoriedAttachmentFiles(
  dataDir: string,
  attachment: ProjectAttachmentRow,
): Promise<void> {
  await rm(
    resolveAttachmentPath(
      projectAttachmentDir(dataDir, attachment.projectId),
      attachment.storedPath,
    ),
    { force: true },
  );
  await rm(
    pendingAttachmentPath(dataDir, attachment.projectId, attachment.id),
    { force: true },
  );
}
