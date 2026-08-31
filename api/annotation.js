const crypto = require("node:crypto");

const CROP_ID = /^d1575_[0-9a-f]{24}$/;
const VALID_STATUS = new Set(["draft", "verified", "skipped"]);

function encodeBlobPath(blobPath) {
  return blobPath.split("/").map(encodeURIComponent).join("/");
}

function safeSegment(value) {
  return String(value).trim().replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

function validateRecord(record, annotatorId) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return "標註內容不是有效物件。";
  if (record.schema_version !== "dino1575_human_annotation_v1") return "標註格式版本不受支援。";
  if (!CROP_ID.test(String(record.crop_id || ""))) return "crop_id 格式不正確。";
  if (!Number.isInteger(record.row_index) || record.row_index < 0) return "row_index 格式不正確。";
  if (record.annotator_id !== annotatorId) return "標註者 ID 與伺服器設定不符。";
  if (!VALID_STATUS.has(record.review_status)) return "review_status 不受支援。";
  for (const key of ["subject_form_labels", "domain_labels", "quality_flags", "proposed_labels"]) {
    if (!Array.isArray(record[key])) return `${key} 必須是陣列。`;
  }
  return "";
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const containerUrl = String(process.env.AZURE_CONTAINER_URL || "").replace(/\/$/, "");
  const sas = String(process.env.AZURE_SAS_TOKEN || "").replace(/^\?/, "");
  const annotatorId = String(process.env.ANNOTATOR_ID || "").trim();
  const prefix = String(process.env.ANNOTATION_BLOB_PREFIX || "")
    .trim().replace(/^\/+|\/+$/g, "");
  if (!containerUrl || !sas || !annotatorId || !prefix) {
    return response.status(500).json({ error: "Azure 標註儲存尚未完整設定。" });
  }

  const record = request.body;
  const error = validateRecord(record, annotatorId);
  if (error) return response.status(400).json({ error });

  const body = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(body) > 256 * 1024) {
    return response.status(413).json({ error: "標註紀錄過大。" });
  }

  const suffix = record.crop_id.replace(/^d1575_/, "").slice(0, 2);
  const blobName = `${prefix}/by_annotator/${safeSegment(annotatorId)}/by_prefix/${suffix}/${record.crop_id}.json`;
  const upstream = await fetch(`${containerUrl}/${encodeBlobPath(blobName)}?${sas}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "x-ms-blob-type": "BlockBlob",
      "x-ms-version": "2023-11-03",
      "x-ms-meta-schema-version": record.schema_version,
      "x-ms-meta-record-sha256": crypto.createHash("sha256").update(body).digest("hex"),
    },
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (!upstream.ok) {
    const azureCode = upstream.headers.get("x-ms-error-code") || `HTTP ${upstream.status}`;
    return response.status(502).json({ error: `Azure 寫入失敗：${azureCode}` });
  }

  response.setHeader("Cache-Control", "no-store");
  return response.status(200).json({ status: "stored", blob_name: blobName });
};
