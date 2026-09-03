import type { Session } from "@supabase/supabase-js";
import { genUploader } from "uploadthing/client";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8787";

export interface UploadThingClient {
  uploadFiles(
    endpoint: "media",
    options: {
      files: File[];
      input: {
        filename: string;
        mimeType: string;
        sizeBytes: number;
        width?: number;
        height?: number;
        durationSeconds?: number;
      };
      headers: HeadersInit;
      onUploadProgress: (event: { progress: number }) => void;
    },
  ): Promise<unknown[]>;
}

const uploadThing = genUploader<any>({
  url: new URL("/api/uploadthing", apiUrl),
}) as unknown as UploadThingClient;

export async function apiRequest<T>(
  path: string,
  session: Session | null,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...init.headers,
    },
  });
  const body = (await response.json()) as T & { message?: string };
  if (!response.ok)
    throw new Error(body.message ?? `Request failed (${response.status})`);
  return body;
}

export async function uploadDirect(
  file: File,
  session: Session,
  onProgress: (percent: number) => void,
  uploader: UploadThingClient = uploadThing,
): Promise<{ mediaId: string; objectKey: string }> {
  const metadata = await inspectMedia(file);
  const mimeType = file.type || "application/octet-stream";
  const result = await uploader.uploadFiles("media", {
    files: [file],
    input: {
      filename: file.name,
      mimeType,
      sizeBytes: file.size,
      ...metadata,
    },
    headers: { Authorization: `Bearer ${session.access_token}` },
    onUploadProgress: ({ progress }: { progress: number }) =>
      onProgress(progress),
  });
  const uploaded = result[0] as
    | {
        key: string | null;
        serverData?: {
          mediaId?: string;
          objectKey?: string;
          uploadStatus?: string;
        } | null;
      }
    | undefined;
  if (
    !uploaded?.key ||
    !uploaded.serverData?.mediaId ||
    uploaded.serverData.uploadStatus !== "complete"
  ) {
    throw new Error(
      "UploadThing finished transferring the file, but the server did not confirm it for scheduling.",
    );
  }
  return {
    mediaId: uploaded.serverData.mediaId,
    objectKey: uploaded.serverData.objectKey ?? uploaded.key,
  };
}

async function inspectMedia(file: File): Promise<{
  width?: number;
  height?: number;
  durationSeconds?: number;
}> {
  if (file.type.startsWith("image/")) {
    try {
      const bitmap = await createImageBitmap(file);
      const dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return dimensions;
    } catch {
      throw new Error("The browser could not read this image’s dimensions.");
    }
  }
  if (file.type.startsWith("video/")) {
    const source = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        const video = document.createElement("video");
        const timeout = window.setTimeout(
          () => reject(new Error("Video metadata inspection timed out.")),
          10_000,
        );
        video.preload = "metadata";
        video.onloadedmetadata = () => {
          window.clearTimeout(timeout);
          resolve({
            width: video.videoWidth,
            height: video.videoHeight,
            durationSeconds: video.duration,
          });
        };
        video.onerror = () => {
          window.clearTimeout(timeout);
          reject(
            new Error("The browser could not read this video’s metadata."),
          );
        };
        video.src = source;
      });
    } finally {
      URL.revokeObjectURL(source);
    }
  }
  return {};
}
