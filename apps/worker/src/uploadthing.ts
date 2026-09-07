import {
  createRouteHandler,
  createUploadthing,
  UploadThingError,
  UTFiles,
  type FileRouter,
} from "uploadthing/server";

import { createMediaUploadSchema, validateMedia } from "@scheduler/shared";

import {
  authenticateWorkspaceRequest,
  type WorkspaceAuthentication,
} from "./auth";
import { ownerDatabase, SupabaseRest } from "./database";
import type { Env } from "./env";
import {
  ReviewerDatabase,
  requireReviewerAuthorization,
} from "./review-authorization";
import {
  ACTIVE_MEDIA_LIMIT_BYTES,
  REVIEWER_MEDIA_LIMIT_BYTES,
  deleteUploadThingFile,
  validateUploadThingUrl,
} from "./storage";

interface UploadInput {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | undefined;
  height?: number | undefined;
  durationSeconds?: number | undefined;
}

interface UploadFileInput {
  name: string;
  size: number;
  type: string;
  lastModified?: number | undefined;
}

interface UploadedFile {
  key: string;
  customId: string | null;
  name: string;
  size: number;
  type: string;
  ufsUrl: string;
  fileHash: string;
}

export interface UploadThingRouteDependencies {
  authenticate(
    env: Env,
    request: Request,
  ): ReturnType<typeof authenticateWorkspaceRequest>;
  consumeRateLimit(
    env: Env,
    authentication: Extract<WorkspaceAuthentication, { authenticated: true }>,
  ): Promise<boolean>;
  reserve(
    env: Env,
    authentication: Extract<WorkspaceAuthentication, { authenticated: true }>,
    input: UploadInput,
  ): Promise<string>;
  finalize(
    env: Env,
    input: {
      mediaId: string;
      ownerId: string;
      providerFileKey: string;
      providerUrl: string;
      sizeBytes: number;
      mimeType: string;
      checksum: string;
      authorizationContext?: "owner" | "meta_review";
      authorizationGeneration?: string;
    },
  ): Promise<string>;
  deleteFile(env: Env, fileKey: string): Promise<unknown>;
}

const defaultDependencies: UploadThingRouteDependencies = {
  authenticate: authenticateWorkspaceRequest,
  consumeRateLimit: (env, authentication) =>
    authentication.accessRole === "owner"
      ? ownerDatabase(env, authentication.jwt).rpc<boolean>(
          "consume_rate_limit",
          {
            p_route: "upload_start",
            p_limit: 30,
            p_window_seconds: 60,
          },
        )
      : new ReviewerDatabase(
          env,
          authentication.user.id,
          authentication.reviewGeneration!,
        ).rpc<boolean>("consume_meta_review_rate_limit", {
          p_reviewer_id: authentication.user.id,
          p_route: "upload_start",
          p_limit: 30,
          p_window_seconds: 60,
        }),
  async reserve(env, authentication, input) {
    const parameters = {
      p_original_filename: input.filename,
      p_mime_type: input.mimeType,
      p_size_bytes: input.sizeBytes,
      p_width: input.width ?? null,
      p_height: input.height ?? null,
      p_duration_seconds: input.durationSeconds ?? null,
    };
    return authentication.accessRole === "owner"
      ? ownerDatabase(env, authentication.jwt).rpc<string>(
          "reserve_uploadthing_media",
          parameters,
        )
      : new ReviewerDatabase(
          env,
          authentication.user.id,
          authentication.reviewGeneration!,
        ).rpc<string>("reserve_meta_review_media", {
          p_reviewer_id: authentication.user.id,
          ...parameters,
        });
  },
  async finalize(env, input) {
    if (input.authorizationContext === "meta_review") {
      if (!input.authorizationGeneration)
        throw new Error("Upload authorization unavailable.");
      await requireReviewerAuthorization(
        env,
        input.ownerId,
        input.authorizationGeneration,
      );
    }
    return new SupabaseRest(env).rpc<string>("complete_uploadthing_media", {
      p_media_id: input.mediaId,
      p_owner_id: input.ownerId,
      p_provider_file_key: input.providerFileKey,
      p_provider_url: input.providerUrl,
      p_size_bytes: input.sizeBytes,
      p_mime_type: input.mimeType,
      p_checksum_sha256: input.checksum,
    });
  },
  deleteFile: (env, fileKey) => deleteUploadThingFile(env, fileKey),
};

export async function authorizeUploadInitiation(
  env: Env,
  request: Request,
  files: readonly UploadFileInput[],
  input: UploadInput,
  dependencies: UploadThingRouteDependencies = defaultDependencies,
) {
  const authentication = await dependencies.authenticate(env, request);
  if (!authentication.authenticated) {
    throw new UploadThingError({
      code: "FORBIDDEN",
      message: "Workspace authentication is required to upload media.",
    });
  }
  if (files.length !== 1) {
    throw new UploadThingError({
      code: "BAD_REQUEST",
      message: "Upload one media file at a time.",
    });
  }
  const file = files[0]!;
  const effectiveMimeType = file.type || "application/octet-stream";
  if (
    file.name !== input.filename ||
    file.size !== input.sizeBytes ||
    effectiveMimeType !== input.mimeType
  ) {
    throw new UploadThingError({
      code: "BAD_REQUEST",
      message: "Upload metadata does not match the selected file.",
    });
  }
  const issues = validateMedia({
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    ...(input.width ? { width: input.width } : {}),
    ...(input.height ? { height: input.height } : {}),
  });
  if (issues.length) {
    throw new UploadThingError({
      code: "BAD_REQUEST",
      message: issues.map((issue) => issue.message).join(" "),
    });
  }
  if (
    input.sizeBytes >
    (authentication.accessRole === "meta_reviewer"
      ? REVIEWER_MEDIA_LIMIT_BYTES
      : ACTIVE_MEDIA_LIMIT_BYTES)
  ) {
    throw new UploadThingError({
      code: "TOO_LARGE",
      message: "This file exceeds the workspace media allocation.",
    });
  }
  const allowed = await dependencies.consumeRateLimit(env, authentication);
  if (!allowed) {
    throw new UploadThingError({
      code: "TOO_MANY_FILES",
      message: "Upload rate limit exceeded. Try again in one minute.",
    });
  }
  let mediaId: string;
  try {
    mediaId = await dependencies.reserve(env, authentication, input);
  } catch (error) {
    const safeBody =
      typeof error === "object" && error && "body" in error
        ? String((error as { body: unknown }).body)
        : "";
    if (safeBody.includes("UPLOADTHING_ACTIVE_MEDIA_LIMIT")) {
      throw new UploadThingError({
        code: "FILE_LIMIT_EXCEEDED",
        message:
          "Upload rejected: the media allocation would be exceeded. Delete unused media or wait for eligible cleanup.",
      });
    }
    throw new UploadThingError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The upload reservation could not be created.",
    });
  }
  return {
    ownerId: authentication.user.id,
    authorizationContext:
      authentication.accessRole === "meta_reviewer"
        ? ("meta_review" as const)
        : ("owner" as const),
    ...(authentication.reviewGeneration
      ? { authorizationGeneration: authentication.reviewGeneration }
      : {}),
    mediaId,
    [UTFiles]: [{ ...file, customId: mediaId }],
  };
}

export async function completeUploadThingCallback(
  env: Env,
  metadata: {
    ownerId: string;
    mediaId: string;
    authorizationContext?: "owner" | "meta_review";
    authorizationGeneration?: string;
  },
  file: UploadedFile,
  dependencies: UploadThingRouteDependencies = defaultDependencies,
) {
  const providerUrl = validateUploadThingUrl(env, file.ufsUrl, [
    file.key,
    metadata.mediaId,
  ]).toString();
  const result = await dependencies.finalize(env, {
    mediaId: metadata.mediaId,
    ownerId: metadata.ownerId,
    providerFileKey: file.key,
    providerUrl,
    sizeBytes: file.size,
    mimeType: file.type || "application/octet-stream",
    checksum: file.fileHash,
    ...(metadata.authorizationContext
      ? { authorizationContext: metadata.authorizationContext }
      : {}),
    ...(metadata.authorizationGeneration
      ? { authorizationGeneration: metadata.authorizationGeneration }
      : {}),
  });
  if (result === "completed" || result === "already_complete") {
    return {
      mediaId: metadata.mediaId,
      objectKey: file.key,
      uploadStatus: "complete" as const,
    };
  }
  await dependencies.deleteFile(env, file.key);
  throw new UploadThingError({
    code: result === "expired" ? "UPLOAD_FAILED" : "BAD_REQUEST",
    message:
      result === "expired"
        ? "The upload reservation expired before completion. Please upload again."
        : "Upload completion did not match its reservation.",
  });
}

export function createUploadThingRouter(
  env: Env,
  dependencies: UploadThingRouteDependencies = defaultDependencies,
) {
  const upload = createUploadthing({
    errorFormatter(error) {
      return { code: error.code, message: error.message };
    },
  });
  return {
    media: upload(
      { blob: { maxFileSize: "2GB", maxFileCount: 1 } },
      { awaitServerData: true },
    )
      .input(createMediaUploadSchema)
      .middleware(({ req, files, input }) =>
        authorizeUploadInitiation(env, req, files, input, dependencies),
      )
      .onUploadError(() => {
        // Reservations are released only after their bounded expiry so a late
        // provider callback cannot let parallel uploads bypass the quota.
      })
      .onUploadComplete(({ metadata, file }) =>
        completeUploadThingCallback(env, metadata, file, dependencies),
      ),
  } satisfies FileRouter;
}

export type UploadThingRouter = ReturnType<typeof createUploadThingRouter>;

export function handleUploadThingRequest(env: Env, request: Request) {
  const callbackUrl = new URL("/api/uploadthing", env.WORKER_PUBLIC_URL);
  return createRouteHandler({
    router: createUploadThingRouter(env),
    config: {
      token: env.UPLOADTHING_TOKEN,
      callbackUrl: callbackUrl.toString(),
      isDev: env.ENVIRONMENT !== "production",
      handleDaemonPromise: env.ENVIRONMENT === "production" ? "await" : "void",
      logLevel: env.ENVIRONMENT === "production" ? "Error" : "Warning",
    },
  })(request);
}
