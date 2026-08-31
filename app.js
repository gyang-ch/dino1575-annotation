const state = {
  config: null,
  runtime: null,
  taxonomy: null,
  datasetIndex: null,
  items: null,
  itemCache: new Map(),
  neighbourCache: new Map(),
  suggestionCache: new Map(),
  position: 0,
  currentItem: null,
  currentAnnotation: null,
  proposals: [],
  dirty: false,
  gemmaVisible: false,
  neighbourModel: "dinov2",
  db: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const formatInt = (value) => new Intl.NumberFormat().format(value);
const sourceNames = {
  bodleian_new: "博德利數位圖書館",
  gallica: "法國國家圖書館 Gallica",
  harvard_yenching: "哈佛燕京圖書館",
  mdz: "慕尼黑數位化中心（MDZ）",
  ndl: "日本國立國會圖書館",
  pul: "普林斯頓大學圖書館",
  rmda: "丹麥皇家圖書館",
  wellcome: "惠康典藏（Wellcome Collection）",
};

function showMessage(message, error = true) {
  const element = $("#app-message");
  element.hidden = !message;
  element.textContent = message || "";
  element.style.borderColor = error ? "var(--warning)" : "var(--success)";
}

function blobPathFromAzureUrl(url) {
  const parsed = new URL(url);
  if (!/\.blob\.core\.windows\.net$/i.test(parsed.hostname)) return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  return parts.slice(1).map(decodeURIComponent).join("/");
}

function blobProxyUrl(blobPath) {
  return `/api/blob?path=${encodeURIComponent(blobPath)}`;
}

function dataAccessUrl(url) {
  try {
    const blobPath = blobPathFromAzureUrl(url);
    return blobPath ? blobProxyUrl(blobPath) : url;
  } catch {
    return url;
  }
}

async function fetchJson(url) {
  const accessedUrl = dataAccessUrl(url);
  const response = await fetch(accessedUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`無法載入 ${url}（狀態碼 ${response.status}）`);
  return response.json();
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("dino1575-annotation-studio", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("annotations")) {
        db.createObjectStore("annotations", { keyPath: "crop_id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbRequest(mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction("annotations", mode);
    const store = transaction.objectStore("annotations");
    const request = operation(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const getAnnotation = (cropId) => dbRequest("readonly", (store) => store.get(cropId));
const putAnnotation = (record) => dbRequest("readwrite", (store) => store.put(record));
const allAnnotations = () => dbRequest("readonly", (store) => store.getAll());

function taxonomyLabels(axis) {
  return state.taxonomy.axes[axis].groups.flatMap((group) => group.labels);
}

function validLabelSets() {
  return {
    subject_form: new Set(taxonomyLabels("subject_form").map((label) => label.id)),
    domain: new Set(taxonomyLabels("domain").map((label) => label.id)),
    quality: new Set(state.taxonomy.quality_flags.labels.map((label) => label.id)),
    disposition: new Set(state.taxonomy.disposition.labels.map((label) => label.id)),
  };
}

function bilingualLabel(label) {
  return label.name_zh_hant ? `${label.name}（${label.name_zh_hant}）` : label.name;
}

function renderChoice(container, name, label, type) {
  const wrapper = document.createElement("div");
  wrapper.className = "option";
  const input = document.createElement("input");
  input.type = type;
  input.name = name;
  input.id = `${name}-${label.id}`;
  input.value = label.id;
  const text = document.createElement("label");
  text.htmlFor = input.id;
  text.textContent = name === "subject_form" || name === "domain"
    ? bilingualLabel(label)
    : (label.name_zh_hant || label.name);
  wrapper.append(input, text);
  container.append(wrapper);
}

function renderTaxonomy() {
  const disposition = $("#disposition-options");
  state.taxonomy.disposition.labels.forEach((label) => renderChoice(disposition, "disposition", label, "radio"));

  for (const [axis, selector] of [["subject_form", "#subject-options"], ["domain", "#domain-options"]]) {
    const container = $(selector);
    taxonomyLabels(axis).forEach((label) => renderChoice(container, axis, label, "checkbox"));
  }

  state.taxonomy.quality_flags.labels.forEach((label) => {
    renderChoice($("#quality-options"), "quality_flags", label, "checkbox");
  });
}

function itemCount() {
  return state.items ? state.items.length : state.datasetIndex.crop_count;
}

function shardFor(shards, rowIndex) {
  return shards.find((shard) => rowIndex >= shard.first_row && rowIndex <= shard.last_row);
}

async function getItem(rowIndex) {
  if (rowIndex < 0 || rowIndex >= itemCount()) throw new Error("輸入的項目編號超出資料集範圍。");
  if (state.items) return state.items[rowIndex];
  if (state.itemCache.has(rowIndex)) return state.itemCache.get(rowIndex);
  const shard = shardFor(state.datasetIndex.item_shards, rowIndex);
  if (!shard) throw new Error(`找不到包含資料列 ${rowIndex} 的項目分片。`);
  const base = state.datasetIndex.data_base_url || state.config.dataset_index_url;
  const records = await fetchJson(new URL(shard.url, base).href);
  records.forEach((record) => state.itemCache.set(record.row_index, record));
  return state.itemCache.get(rowIndex);
}

async function getAuxiliaryRecord(kind, rowIndex, model = null) {
  if (!state.datasetIndex) return null;
  const shards = model
    ? state.datasetIndex.neighbour_shards?.[model]
    : state.datasetIndex.suggestion_shards;
  if (!shards?.length) return null;
  const cache = model ? state.neighbourCache : state.suggestionCache;
  const key = `${model || kind}:${rowIndex}`;
  if (cache.has(key)) return cache.get(key);
  const shard = shardFor(shards, rowIndex);
  if (!shard) return null;
  const base = state.datasetIndex.data_base_url || state.config.dataset_index_url;
  const records = await fetchJson(new URL(shard.url, base).href);
  records.forEach((record) => cache.set(`${model || kind}:${record.row_index}`, record));
  return cache.get(key) || null;
}

function azureImageUrl(item) {
  if (item.crop_blob_name) return blobProxyUrl(item.crop_blob_name);
  if (item.image_url) return dataAccessUrl(item.image_url);
  return "";
}

function emptyAnnotation(item) {
  const now = new Date().toISOString();
  return {
    schema_version: "dino1575_human_annotation_v1",
    annotation_id: crypto.randomUUID(),
    crop_id: item.crop_id,
    row_index: item.row_index,
    taxonomy_version: state.taxonomy.version,
    annotator_id: state.runtime?.annotator_id || "",
    review_status: "draft",
    disposition: "uncertain_disposition",
    subject_form_labels: [],
    domain_labels: [],
    quality_flags: [],
    description: "",
    description_language: "zh-Hant",
    annotator_note: "",
    proposed_labels: [],
    assistance: {
      gemma_suggestion_visible: false,
      neighbour_panels_opened: [],
      neighbour_crop_ids_opened: [],
    },
    created_at: now,
    updated_at: now,
  };
}

function selectedValues(name) {
  return $$(`input[name="${name}"]:checked`).map((input) => input.value);
}

function collectForm(status) {
  const previous = state.currentAnnotation || emptyAnnotation(state.currentItem);
  return {
    ...previous,
    annotator_id: state.runtime?.annotator_id || previous.annotator_id,
    review_status: status,
    disposition: selectedValues("disposition")[0] || "uncertain_disposition",
    subject_form_labels: selectedValues("subject_form"),
    domain_labels: selectedValues("domain"),
    quality_flags: selectedValues("quality_flags"),
    description: $("#description").value.trim(),
    description_language: "zh-Hant",
    annotator_note: $("#annotator-note").value.trim(),
    proposed_labels: [...state.proposals],
    updated_at: new Date().toISOString(),
  };
}

function validateRecord(record, final = false) {
  const valid = validLabelSets();
  if (!record.annotator_id) return "伺服器尚未設定標註者 ID，請聯絡研究負責人。";
  if (!valid.disposition.has(record.disposition)) return "請選擇有效的處理決定。";
  if (record.subject_form_labels.some((id) => !valid.subject_form.has(id))) return "已選取未知的主題／形式標籤。";
  if (record.domain_labels.some((id) => !valid.domain.has(id))) return "已選取未知的領域標籤。";
  if (record.quality_flags.some((id) => !valid.quality.has(id))) return "已選取未知的品質標記。";
  if (final && record.disposition === "include") {
    if (!record.subject_form_labels.length) return "確認納入的裁切圖至少需要一個主題／形式標籤。";
    if (!record.domain_labels.length) return "確認納入的裁切圖至少需要一個領域標籤；如有需要可選擇不確定。";
    if (!record.description) return "確認納入的裁切圖需要一則簡短描述。";
  }
  return "";
}

function updateRecordState(status) {
  const label = $("#record-state");
  const display = { draft: "草稿", verified: "已確認", skipped: "已略過" }[status] || "尚未開始";
  label.textContent = display;
  label.dataset.state = status || "new";
}

async function saveRecord(status, moveNext = false) {
  const record = collectForm(status);
  const error = validateRecord(record, status === "verified");
  if (error) {
    showMessage(error);
    return false;
  }
  await putAnnotation(record);
  state.currentAnnotation = record;
  state.dirty = false;
  updateRecordState(status);
  showMessage(status === "verified" ? "人工標註已確認並儲存。" : "草稿已儲存在本機。", false);
  await updateProgress();
  if (moveNext && state.position < itemCount() - 1) await showItem(state.position + 1);
  return true;
}

function setChecked(name, values) {
  const set = new Set(values || []);
  $$(`input[name="${name}"]`).forEach((input) => { input.checked = set.has(input.value); });
}

function renderProposals() {
  const list = $("#proposal-list");
  list.replaceChildren();
  state.proposals.forEach((proposal, index) => {
    const item = document.createElement("li");
    item.textContent = `${proposal.axis === "domain" ? "Domain（領域）" : "Subject / form（主題／形式）"}：${proposal.name}，${proposal.reason}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "移除";
    remove.addEventListener("click", () => {
      state.proposals.splice(index, 1);
      state.dirty = true;
      renderProposals();
    });
    item.append(remove);
    list.append(item);
  });
}

function fillForm(record) {
  setChecked("disposition", [record.disposition]);
  setChecked("subject_form", record.subject_form_labels);
  setChecked("domain", record.domain_labels);
  setChecked("quality_flags", record.quality_flags);
  $("#description").value = record.description || "";
  $("#annotator-note").value = record.annotator_note || "";
  state.proposals = [...(record.proposed_labels || [])];
  renderProposals();
  updateRecordState(record.review_status);
}

function renderItemMeta(item) {
  $("#source-label").textContent = sourceNames[item.source] || item.source;
  $("#crop-heading").textContent = item.crop_id;
  $("#confidence-value").textContent = Number(item.confidence).toFixed(3);
  $("#row-value").textContent = formatInt(item.row_index);
  $("#book-value").textContent = item.item_id;
  $("#position-count").textContent = `${formatInt(state.position + 1)} / ${formatInt(itemCount())}`;
  $("#jump-input").value = state.position + 1;
  $("#jump-input").max = itemCount();
  $("#previous-item").disabled = state.position === 0;
  $("#next-item").disabled = state.position === itemCount() - 1;
}

function renderImage(item) {
  const image = $("#crop-image");
  const placeholder = $("#image-placeholder");
  const url = azureImageUrl(item);
  if (!url) {
    image.removeAttribute("src");
    image.hidden = true;
    placeholder.hidden = false;
    return;
  }
  placeholder.hidden = true;
  image.hidden = false;
  image.alt = `來自${sourceNames[item.source] || item.source}的歷史書籍插圖裁切圖 ${item.crop_id}`;
  image.src = url;
  image.onerror = () => {
    image.hidden = true;
    placeholder.hidden = false;
    placeholder.querySelector("p").textContent = "無法載入裁切圖，請聯絡研究負責人。";
  };
}

async function loadSuggestion(item) {
  state.gemmaVisible = false;
  $("#gemma-content").hidden = true;
  $("#gemma-hidden").hidden = false;
  let suggestion = item.gemma_suggestion || await getAuxiliaryRecord("suggestion", item.row_index);
  if (!suggestion && state.config.suggestion_url_template) {
    const prefix = item.crop_id.replace(/^d1575_/, "").slice(0, 2);
    const url = state.config.suggestion_url_template
      .replace("{prefix}", prefix)
      .replace("{crop_id}", item.crop_id);
    try { suggestion = await fetchJson(url); } catch (error) {
      if (!String(error.message).includes("(404)")) console.warn(error);
    }
  }
  state.currentSuggestion = suggestion;
  $("#gemma-availability").textContent = suggestion ? "已有建議" : "尚無建議";
  $("#reveal-gemma").disabled = !suggestion;
  $("#gemma-hidden p").textContent = suggestion ? "預設隱藏，以減少先入為主的影響。" : "目前尚未上傳此裁切圖的 Gemma 建議。";
}

async function showItem(position) {
  showMessage("");
  const bounded = Math.max(0, Math.min(itemCount() - 1, position));
  state.position = bounded;
  const item = await getItem(bounded);
  state.currentItem = item;
  state.currentAnnotation = await getAnnotation(item.crop_id) || emptyAnnotation(item);
  state.dirty = false;
  renderItemMeta(item);
  renderImage(item);
  fillForm(state.currentAnnotation);
  await loadSuggestion(item);
  history.replaceState(null, "", `#item=${bounded + 1}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function updateProgress() {
  const records = await allAnnotations();
  const verified = records.filter((record) => record.review_status === "verified").length;
  const started = records.filter((record) => record.review_status !== "skipped").length;
  $("#progress-count").textContent = `已確認 ${formatInt(verified)} 筆 · 已開始 ${formatInt(started)} 筆`;
  $("#progress-bar").style.width = `${itemCount() ? (verified / itemCount()) * 100 : 0}%`;
}

function openSettings() {
  $("#settings").hidden = false;
  $("#settings-button").setAttribute("aria-expanded", "true");
  $("#settings-close").focus();
}

function closeSettings() {
  $("#settings").hidden = true;
  $("#settings-button").setAttribute("aria-expanded", "false");
  $("#settings-button").focus();
}

function revealGemma() {
  const record = state.currentSuggestion;
  if (!record) return;
  const prediction = record.prediction || record;
  state.gemmaVisible = true;
  state.currentAnnotation.assistance.gemma_suggestion_visible = true;
  state.dirty = true;
  $("#gemma-hidden").hidden = true;
  const content = $("#gemma-content");
  content.hidden = false;
  content.replaceChildren();
  const definition = document.createElement("dl");
  definition.className = "suggestion-detail";
  const subjectNames = (prediction.subject_form_labels || []).map((id) => {
    const label = taxonomyLabels("subject_form").find((candidate) => candidate.id === id);
    return label ? bilingualLabel(label) : id;
  });
  const domainNames = (prediction.domain_labels || []).map((id) => {
    const label = taxonomyLabels("domain").find((candidate) => candidate.id === id);
    return label ? bilingualLabel(label) : id;
  });
  const disposition = state.taxonomy.disposition.labels.find((label) => label.id === prediction.disposition);
  const uncertainty = { low: "低", medium: "中", high: "高" }[prediction.uncertainty] || "未知";
  const entries = [
    ["描述", prediction.description || "沒有描述"],
    ["Subject / form（主題／形式）", subjectNames.join("、") || "無"],
    ["Domain（領域）", domainNames.join("、") || "無"],
    ["處理建議", disposition?.name_zh_hant || "未知"],
    ["不確定程度", uncertainty],
    ["注意事項", prediction.attention_reason || (prediction.needs_human_attention ? "需要人工特別留意" : "沒有特別警示")],
  ];
  entries.forEach(([term, value]) => {
    const dt = document.createElement("dt"); dt.textContent = term;
    const dd = document.createElement("dd"); dd.textContent = value;
    definition.append(dt, dd);
  });
  content.append(definition);
}

function neighbourArrays(record, setName) {
  const names = {
    unrestricted: ["top_200_indices", "top_200_scores", 50],
    candidate_pool: ["top_200_indices", "top_200_scores", 200],
    cross_book: ["cross_book_top_50_indices", "cross_book_top_50_scores", 50],
    cross_source: ["cross_source_top_50_indices", "cross_source_top_50_scores", 50],
  }[setName];
  if (!names) return [[], []];
  return [(record[names[0]] || []).slice(0, names[2]), (record[names[1]] || []).slice(0, names[2])];
}

async function renderNeighbours() {
  const message = $("#neighbour-message");
  const results = $("#neighbour-results");
  message.textContent = "正在載入近鄰紀錄…";
  results.replaceChildren();
  const inline = state.currentItem.neighbours?.[state.neighbourModel];
  const record = inline || await getAuxiliaryRecord("neighbours", state.currentItem.row_index, state.neighbourModel);
  if (!record) {
    message.textContent = "此預覽尚未設定近鄰網頁資料分片。請使用套件內的準備程式產生並上傳資料。";
    return;
  }
  const setName = $("#neighbour-set").value;
  const limit = Number($("#neighbour-limit").value);
  const [indices, scores] = neighbourArrays(record, setName);
  if (!indices.length) {
    message.textContent = "此匯出資料不包含所選的近鄰集合。";
    return;
  }
  const count = Math.min(limit, indices.length);
  message.textContent = `正在顯示 ${count} 筆 ${state.neighbourModel === "dinov2" ? "DINOv2" : "OpenCLIP"} 近鄰圖像。`;
  const neighbours = await Promise.all(indices.slice(0, count).map((row) => getItem(Number(row))));
  neighbours.forEach((item, index) => {
    const figure = document.createElement("figure");
    figure.className = "neighbour-item";
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", `開啟第 ${index + 1} 筆近鄰圖像，相似度 ${Number(scores[index]).toFixed(3)}`);
    const image = document.createElement("img");
    image.loading = "lazy";
    image.src = azureImageUrl(item);
    image.alt = `近鄰插圖 ${item.crop_id}`;
    button.append(image);
    button.addEventListener("click", async () => {
      const opened = state.currentAnnotation.assistance.neighbour_crop_ids_opened;
      if (!opened.includes(item.crop_id)) opened.push(item.crop_id);
      state.dirty = true;
      $("#neighbour-dialog").close();
      await showItem(item.row_index);
    });
    const caption = document.createElement("figcaption");
    caption.innerHTML = `<strong>${index + 1}. ${Number(scores[index]).toFixed(3)}</strong><br>${sourceNames[item.source] || item.source}<br>${item.crop_id}`;
    figure.append(button, caption);
    results.append(figure);
  });
}

async function openNeighbours() {
  if (!state.currentAnnotation.assistance.neighbour_panels_opened.includes(state.neighbourModel)) {
    state.currentAnnotation.assistance.neighbour_panels_opened.push(state.neighbourModel);
  }
  state.dirty = true;
  $("#neighbour-dialog").showModal();
  await renderNeighbours();
}

async function exportAnnotations() {
  const records = (await allAnnotations()).sort((a, b) => a.row_index - b.row_index);
  const body = records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
  const blob = new Blob([body], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const stamp = new Date().toISOString().replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");
  link.href = url;
  link.download = `human_annotations_${state.config.run_id}_${stamp}.jsonl`;
  link.click();
  URL.revokeObjectURL(url);
  $("#storage-status").textContent = `已匯出 ${formatInt(records.length)} 筆本機儲存的紀錄。`;
}

async function importAnnotations(file) {
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  let imported = 0;
  for (const [index, line] of lines.entries()) {
    let record;
    try { record = JSON.parse(line); } catch { throw new Error(`匯入檔案第 ${index + 1} 行不是有效的 JSON。`); }
    if (record.schema_version !== "dino1575_human_annotation_v1" || !record.crop_id) {
      throw new Error(`匯入檔案第 ${index + 1} 行的標註紀錄格式不受支援。`);
    }
    const error = validateRecord(record, record.review_status === "verified");
    if (error) throw new Error(`匯入檔案第 ${index + 1} 行：${error}`);
    await putAnnotation(record);
    imported += 1;
  }
  $("#storage-status").textContent = `已匯入 ${formatInt(imported)} 筆紀錄。`;
  await updateProgress();
  await showItem(state.position);
}

function bindEvents() {
  $("#settings-button").addEventListener("click", openSettings);
  $("#settings-close").addEventListener("click", async () => {
    closeSettings();
    if (!state.currentItem && (state.items || state.datasetIndex)) {
      try { await showItem(state.position); } catch (error) { showMessage(error.message); openSettings(); }
    }
  });
  $("#previous-item").addEventListener("click", () => showItem(state.position - 1));
  $("#next-item").addEventListener("click", () => showItem(state.position + 1));
  $("#jump-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const requested = Math.trunc(Number($("#jump-input").value));
    if (Number.isFinite(requested)) showItem(requested - 1);
  });
  $("#annotation-form").addEventListener("input", () => { state.dirty = true; showMessage(""); });
  $("#save-draft").addEventListener("click", () => saveRecord("draft"));
  $("#skip-record").addEventListener("click", () => saveRecord("skipped", true));
  $("#verify-record").addEventListener("click", () => saveRecord("verified", true));
  $("#add-proposal").addEventListener("click", () => {
    const proposal = {
      axis: $("#proposal-axis").value,
      name: $("#proposal-name").value.trim(),
      reason: $("#proposal-reason").value.trim(),
    };
    if (!proposal.name || !proposal.reason) {
      showMessage("建議新增的標籤必須同時填寫名稱和理由。 ");
      return;
    }
    state.proposals.push(proposal);
    $("#proposal-name").value = "";
    $("#proposal-reason").value = "";
    state.dirty = true;
    renderProposals();
  });
  $("#reveal-gemma").addEventListener("click", revealGemma);
  $("#load-neighbours").addEventListener("click", openNeighbours);
  $("#close-neighbours").addEventListener("click", () => $("#neighbour-dialog").close());
  $$(".model-tabs button").forEach((button) => button.addEventListener("click", async () => {
    state.neighbourModel = button.dataset.model;
    $$(".model-tabs button").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
    if (!state.currentAnnotation.assistance.neighbour_panels_opened.includes(state.neighbourModel)) {
      state.currentAnnotation.assistance.neighbour_panels_opened.push(state.neighbourModel);
    }
    await renderNeighbours();
  }));
  $("#neighbour-set").addEventListener("change", renderNeighbours);
  $("#neighbour-limit").addEventListener("change", renderNeighbours);
  $("#export-button").addEventListener("click", exportAnnotations);
  $("#import-file").addEventListener("change", async (event) => {
    try { if (event.target.files[0]) await importAnnotations(event.target.files[0]); }
    catch (error) { $("#storage-status").textContent = error.message; }
    event.target.value = "";
  });
  window.addEventListener("beforeunload", (event) => {
    if (state.dirty) { event.preventDefault(); event.returnValue = ""; }
  });
  document.addEventListener("keydown", (event) => {
    if (event.target.matches("input, textarea, select") || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowLeft") showItem(state.position - 1);
    if (event.key === "ArrowRight") showItem(state.position + 1);
  });
}

async function initialise() {
  try {
    state.config = await fetchJson("config.json");
    state.runtime = await fetchJson("/api/runtime-config");
    state.taxonomy = await fetchJson(state.config.taxonomy_url);
    if (state.config.items_url) {
      state.items = await fetchJson(state.config.items_url);
    } else {
      state.datasetIndex = await fetchJson(state.config.dataset_index_url);
    }
    state.db = await openDatabase();
    renderTaxonomy();
    bindEvents();
    await updateProgress();
    const match = location.hash.match(/^#item=(\d+)$/);
    await showItem(match ? Number(match[1]) - 1 : 0);
  } catch (error) {
    showMessage(error.message);
    console.error(error);
  }
}

initialise();
