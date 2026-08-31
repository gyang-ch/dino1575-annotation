const { Readable } = require("node:stream");

function allowedPath(blobPath) {
  const configured = String(process.env.AZURE_ALLOWED_PREFIXES || "")
    .split(",")
    .map((value) => value.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  return configured.length > 0 && configured.some(
    (prefix) => blobPath === prefix || blobPath.startsWith(`${prefix}/`),
  );
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const containerUrl = String(process.env.AZURE_CONTAINER_URL || "").replace(/\/$/, "");
  const sas = String(process.env.AZURE_SAS_TOKEN || "").replace(/^\?/, "");
  const blobPath = String(request.query.path || "").replace(/^\/+/, "");
  if (!containerUrl || !sas) return response.status(500).json({ error: "Azure storage is not configured" });
  if (!blobPath || blobPath.includes("..") || !allowedPath(blobPath)) {
    return response.status(403).json({ error: "Blob path is not permitted" });
  }

  const encodedPath = blobPath.split("/").map(encodeURIComponent).join("/");
  const upstream = await fetch(`${containerUrl}/${encodedPath}?${sas}`, {
    method: request.method,
    signal: AbortSignal.timeout(30000),
  });
  if (!upstream.ok) return response.status(upstream.status).json({ error: `Azure returned ${upstream.status}` });

  response.status(upstream.status);
  response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
  response.setHeader("Cache-Control", "private, max-age=300");
  const length = upstream.headers.get("content-length");
  if (length) response.setHeader("Content-Length", length);
  if (request.method === "HEAD" || !upstream.body) return response.end();
  return Readable.fromWeb(upstream.body).pipe(response);
};
