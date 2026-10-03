import {
  $,
  escape,
  uid,
  load,
  save,
  toast,
  download,
  markdown,
  init,
  run,
  busy,
  resultMeta,
  fileText,
} from "./ui.js";
const key = "docu-lens-v1";
let docs = load(key, []);
if (!Array.isArray(docs)) docs = [];
let history = [];
let pending = false;
function render() {
  $("#documents").innerHTML = docs
    .map(
      (d) =>
        `<article class="card"><div class="row between"><strong>${escape(d.name)}</strong><button class="small ghost danger" data-remove="${escape(d.id)}" ${pending ? "disabled" : ""}>移除</button></div><span class="hint">${d.text.length.toLocaleString()} 字符</span></article>`,
    )
    .join("");
  $("#doc-stats").textContent =
    `${docs.length} / 12 份文档 · 共 ${docs.reduce((n, d) => n + d.text.length, 0).toLocaleString()} 字符`;
  $("[id=ask]").disabled = pending || !docs.length;
}
function add(incoming) {
  if (pending) return false;
  if (incoming.some((d) => !d.name.trim())) throw Error("请输入文档名称");
  if (docs.length + incoming.length > 12) throw Error("最多添加 12 份文档");
  if (incoming.some((d) => !d.text.trim() || d.text.length > 120000))
    throw Error("文档不能为空，单份最多 12 万字符");
  const next = [...docs, ...incoming];
  if (next.reduce((n, d) => n + d.text.length, 0) > 240000)
    throw Error("文档总量最多 24 万字符");
  if (save(key, next)) {
    docs = next;
    render();
    toast("文档已加入资料库");
    return true;
  }
  return false;
}
$("#sample").onclick = () => {
  try {
    add([
      {
        id: uid(),
        name: "林间笔记 · 产品说明.md",
        text: "# 林间笔记\n林间笔记是一款面向独立研究者的本地知识工具。\n\n## 数据隐私\n所有笔记默认保存在用户设备中，不自动上传云端。用户开启 AI 问答后，仅将本次问题与检索到的相关段落发送给配置的模型服务。API 密钥保存在服务端环境变量中。\n\n## 导出与备份\n支持将笔记导出为 Markdown 和 JSON。建议每周建立一次离线备份。\n\n## 使用费用\n本地笔记和关键词检索免费；真实模型调用按所选服务商的定价计费。离线演示模式不会发出模型请求。",
      },
    ]);
    $("#question").value = "AI 问答会发送哪些数据？";
  } catch (e) {
    toast(e.message, true);
  }
};
$("#files").onchange = async (e) => {
  try {
    const incoming = [];
    for (const f of e.target.files) {
      if (!/\.(txt|md|markdown)$/i.test(f.name))
        throw Error("仅支持 TXT / Markdown 文件");
      incoming.push({
        id: uid(),
        name: f.name.slice(0, 100),
        text: await fileText(f),
      });
    }
    if (incoming.length) add(incoming);
  } catch (err) {
    toast(err.message, true);
  } finally {
    e.target.value = "";
  }
};
$("#add-form").onsubmit = (e) => {
  e.preventDefault();
  try {
    if (
      add([
        {
          id: uid(),
          name: $("#doc-name").value.trim(),
          text: $("#doc-text").value,
        },
      ])
    ) {
      $("#doc-name").value = "";
      $("#doc-text").value = "";
    }
  } catch (err) {
    toast(err.message, true);
  }
};
$("#documents").onclick = (e) => {
  const b = e.target.closest("[data-remove]");
  if (b && !pending) {
    const next = docs.filter((d) => d.id !== b.dataset.remove);
    if (save(key, next)) {
      docs = next;
      render();
    }
  }
};
$("#question-form").onsubmit = async (e) => {
  e.preventDefault();
  if (pending || !docs.length) return;
  pending = true;
  busy($("#ask"), true, "检索与整理中…");
  [
    "#files",
    "#sample",
    "#question",
    "#mode",
    "#doc-name",
    "#doc-text",
    "#add-form button",
  ].forEach((s) => ($(s).disabled = true));
  render();
  const question = $("#question").value;
  try {
    const r = await run({ question, documents: docs });
    history.push({ question, ...r.data, mode: r.meta.mode });
    let answerHtml = markdown(r.data.answer);
    for (const source of r.data.sources) {
      answerHtml = answerHtml.replaceAll(
        `[${source.id}]`,
        `<a href="#source-${escape(source.id)}">[${escape(source.id)}]</a>`,
      );
    }
    $("#answer").innerHTML =
      `<div class="meta">${resultMeta(r.meta)}</div>${answerHtml}`;
    $("#sources").innerHTML = r.data.sources.length
      ? r.data.sources
          .map(
            (s) =>
              `<article id="source-${escape(s.id)}" class="card"><div class="row between"><span class="pill">${escape(s.id)}</span><strong>${escape(s.name)}</strong></div><p class="hint">原文字符 ${s.start}–${s.end}</p><p class="source-text">${escape(s.text)}</p></article>`,
          )
          .join("")
      : '<p class="muted">没有匹配片段。尝试使用资料中出现的具体词语。</p>';
  } catch (err) {
    toast(err.message, true);
  } finally {
    pending = false;
    busy($("#ask"), false);
    [
      "#files",
      "#sample",
      "#question",
      "#mode",
      "#doc-name",
      "#doc-text",
      "#add-form button",
    ].forEach((s) => ($(s).disabled = false));
    render();
  }
};
$("#export").onclick = () => {
  if (!history.length) return toast("先完成一次问答", true);
  download(
    "docu-lens-answers.md",
    history
      .map(
        (h) =>
          `# ${h.question}\n\n模式：${h.mode}\n\n${h.answer}\n\n## 原文证据\n\n` +
          h.sources
            .map(
              (s) =>
                `### [${s.id}] ${s.name} (${s.start}–${s.end})\n\n${s.text}`,
            )
            .join("\n\n"),
      )
      .join("\n\n---\n\n"),
  );
};
await init();
render();
