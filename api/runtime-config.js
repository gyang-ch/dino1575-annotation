module.exports = function handler(_request, response) {
  const annotatorId = String(process.env.ANNOTATOR_ID || "").trim();
  if (!annotatorId) {
    return response.status(500).json({ error: "伺服器尚未設定 ANNOTATOR_ID。" });
  }
  response.setHeader("Cache-Control", "no-store");
  return response.status(200).json({ annotator_id: annotatorId });
};
