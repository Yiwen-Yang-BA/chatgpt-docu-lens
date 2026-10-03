export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [
  ...root.querySelectorAll(selector),
];
export const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const uid = () => crypto.randomUUID();
export function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
export function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    toast("浏览器存储已满，请先导出数据。", true);
    return false;
  }
}
export function toast(message, error = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", error);
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.hidden = true;
  }, 4500);
}
export function download(name, text, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板");
  } catch {
    toast("无法访问剪贴板，请使用导出功能。", true);
  }
}
export function csv(rows) {
  return (
    "\ufeff" +
    rows
      .map((row) =>
        row
          .map((v) => {
            let s = String(v ?? "");
            if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
            return '"' + s.replaceAll('"', '""') + '"';
          })
          .join(","),
      )
      .join("\r\n")
  );
}
export function markdown(text) {
  return escape(text)
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h2>$1</h2>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
}
let config;
export async function init() {
  config = await fetch("/api/config").then((r) => r.json());
  $("#mode").innerHTML =
    '<option value="demo">演示模式 · 无需密钥</option><option value="live">真实模型 · 需要密钥</option>';
  $("#connection").textContent = config.canLive
    ? "模型接口已配置"
    : "本地运行 · 演示就绪";
  $("#mode").addEventListener("change", () => {
    $("#connection").textContent =
      $("#mode").value === "demo"
        ? "本地演示 · 不调用模型"
        : config.canLive
          ? "真实模型 · 输入将发送到 API"
          : "请在 .env 配置 API 密钥并重启";
  });
  return config;
}
export async function run(payload, { signal, model } = {}) {
  const r = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payload,
      mode: $("#mode").value,
      ...(model ? { model } : {}),
    }),
    signal,
  });
  let data;
  try {
    data = await r.json();
  } catch {
    throw new Error("服务返回了无法读取的内容。");
  }
  if (!r.ok) throw new Error(data.error || "请求失败，请稍后重试。");
  return data;
}
export function busy(button, on, label = "生成中…") {
  if (on) {
    button.dataset.original = button.textContent;
    button.textContent = label;
  } else button.textContent = button.dataset.original || button.textContent;
  button.disabled = on;
}
export function resultMeta(meta) {
  return `<span class="pill">${meta.mode === "demo" ? "演示结果 · 本地规则生成" : escape(meta.model)}</span><span class="muted">${(meta.durationMs / 1000).toFixed(1)} s</span>`;
}
export async function fileText(file, max = 500000) {
  if (!file) return "";
  if (file.size > max)
    throw new Error(`文件超过 ${Math.round(max / 1000)} KB 限制`);
  return file.text();
}
export function formData(form) {
  return Object.fromEntries(new FormData(form));
}
