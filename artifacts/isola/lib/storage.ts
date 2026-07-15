/**
 * Object Storage helpers for the Isola Next.js frontend.
 *
 * File uploads use the two-step presigned-URL flow via the Express API server:
 *
 *   Step 1 — request a presigned PUT URL:
 *     POST /api/storage/uploads/request-url  { name, size, contentType }
 *     → { uploadURL, objectPath }
 *
 *   Step 2 — upload the file directly to GCS:
 *     PUT <uploadURL>  (file bytes)
 *
 *   Serving:
 *     Public assets  → GET /api/storage/public-objects/<path>
 *     Private assets → GET /api/storage/objects/<path>
 *
 * The objectPath returned by step 1 is what you store in the database.
 * To construct the serving URL: /api/storage + objectPath
 *
 * Note: upload endpoints require an authenticated session (Replit Auth).
 */

export interface UploadRequest {
  name: string;
  size: number;
  contentType: string;
}

export interface UploadResponse {
  uploadURL: string;
  objectPath: string;
}

/**
 * Request a presigned upload URL from the API server.
 * Requires an authenticated session.
 */
export async function requestUploadUrl(
  req: UploadRequest,
): Promise<UploadResponse> {
  const res = await fetch('/api/storage/uploads/request-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error ?? 'Failed to request upload URL');
  }

  return res.json();
}

/**
 * Upload a file directly to GCS using a presigned URL.
 */
export async function uploadToPresignedUrl(
  presignedUrl: string,
  file: File,
): Promise<void> {
  const res = await fetch(presignedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });

  if (!res.ok) {
    throw new Error(`Upload failed with status ${res.status}`);
  }
}

/**
 * Construct the serving URL for an objectPath stored in the database.
 * objectPath example: /objects/uploads/some-uuid
 */
export function objectServingUrl(objectPath: string): string {
  return `/api/storage${objectPath}`;
}
