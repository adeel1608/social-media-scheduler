import type { Session } from "@supabase/supabase-js";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8787";

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
): Promise<{ mediaId: string; objectKey: string }> {
  const metadata = await inspectMedia(file);
  const descriptor = await apiRequest<any>("/api/uploads", session, {
    method: "POST",
    body: JSON.stringify({
      filename: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      ...metadata,
    }),
  });
  if (descriptor.mode === "single") {
    await xhrPut(descriptor.uploadUrl, file, file.type, onProgress);
    await apiRequest(`/api/uploads/${descriptor.mediaId}/complete`, session, {
      method: "POST",
      body: JSON.stringify({ parts: [] }),
    });
    return descriptor;
  }
  const parts: Array<{ partNumber: number; etag: string }> = [];
  const partSize = descriptor.partSize as number;
  for (
    let offset = 0, partNumber = 1;
    offset < file.size;
    offset += partSize, partNumber += 1
  ) {
    const part = file.slice(offset, Math.min(offset + partSize, file.size));
    const signed = await apiRequest<{ uploadUrl: string }>(
      `/api/uploads/${descriptor.mediaId}/part`,
      session,
      {
        method: "POST",
        body: JSON.stringify({ partNumber }),
      },
    );
    const etag = await xhrPut(
      signed.uploadUrl,
      part,
      file.type,
      (partPercent) =>
        onProgress(
          Math.round(
            ((offset + (partPercent / 100) * part.size) / file.size) * 100,
          ),
        ),
    );
    parts.push({ partNumber, etag });
  }
  await apiRequest(`/api/uploads/${descriptor.mediaId}/complete`, session, {
    method: "POST",
    body: JSON.stringify({ parts }),
  });
  return descriptor;
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

function xhrPut(
  url: string,
  body: Blob,
  contentType: string,
  onProgress: (percent: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("Content-Type", contentType);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () => reject(new Error("Upload failed"));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300)
        resolve(request.getResponseHeader("ETag") ?? "");
      else reject(new Error(`Upload failed (${request.status})`));
    };
    request.send(body);
  });
}
