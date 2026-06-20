import type { Readable } from "node:stream";

export async function readNodeStreamToBuffer(stream: Readable, maxBytes: number) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      stream.destroy();
      throw new Error(`图片过大：最大支持 ${formatBytes(maxBytes)}`);
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

export async function readWebStreamToBuffer(stream: ReadableStream<Uint8Array> | null, maxBytes: number) {
  if (!stream) throw new Error("图片下载响应没有可读取内容");

  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const buffer = Buffer.from(value);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`图片过大：最大支持 ${formatBytes(maxBytes)}`);
      }

      chunks.push(buffer);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

export function inferImageMimeType(header: unknown, buffer: Buffer) {
  const contentType = Array.isArray(header) ? header[0] : header;
  if (typeof contentType === "string") {
    const mimeType = contentType.split(";")[0]?.trim().toLowerCase();
    if (mimeType?.startsWith("image/")) return mimeType;
  }

  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";

  return "image/jpeg";
}

export function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${Math.floor(bytes / 1024 / 1024)}MB`;
  if (bytes >= 1024) return `${Math.floor(bytes / 1024)}KB`;
  return `${bytes}B`;
}
