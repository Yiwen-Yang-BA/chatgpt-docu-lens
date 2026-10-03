# Docu Lens

把零散资料变成可追溯的问答。导入文档，提出问题，沿着引用找到答案的来处。

- 导入 TXT / Markdown，或直接粘贴文档
- 中文与英文关键词检索、重叠分块和原文位置
- 基于检索片段回答，返回可核对的引用
- 浏览器文档库、问答记录与 Markdown 导出

![Desktop preview](docs/preview.png)

## 快速开始

需要 Node.js 24 或更新版本；无第三方运行依赖，无需 npm install。

```sh
git clone https://github.com/Yiwen-Yang-BA/chatgpt-docu-lens.git
cd chatgpt-docu-lens
npm start
```

打开 http://127.0.0.1:3103 。默认进入**演示模式**，不调用 API，界面会明确标识规则生成的演示结果。

### 接入真实模型

复制 `.env.example` 为 `.env`，填写 `OPENAI_API_KEY`，按账号权限设置 `OPENAI_MODEL`，然后重启服务并切换界面中的「真实模型」。`OPENAI_BASE_URL` 必须支持 OpenAI Responses API；仅兼容 Chat Completions 的服务不适用。密钥只在服务端读取，不写入前端或仓库。

```sh
# Docker（可选；必须显式传入配置）
docker build -t chatgpt-docu-lens .
docker run --rm -p 127.0.0.1:3103:3103 --env-file .env chatgpt-docu-lens
```

## 使用方法

1. 导入最多 12 份 TXT / Markdown，或填写名称并粘贴文本。
2. 针对资料提问；先进行本地检索，再把相关片段交给模型。
3. 核对右侧来源卡片里的文件名、字符位置和原文。
4. 导出问答为 Markdown。无关问题会说明没有匹配资料。

## 验证

```sh
npm run check
npm test
```

测试覆盖业务规则以及本地 HTTP 服务、模拟模型接口、输入校验和错误处理。真实付费模型调用需要用户配置有效密钥，未将演示测试作为真实模型质量验证。GitHub Actions 在每次推送时运行检查。

## 参考与复刻范围

灵感来自 [arc53/DocsGPT](https://github.com/arc53/DocsGPT)（MIT）。查询快照：2026-10-04；18,306 stars；最近推送 2026-10-03。这是当前星标量与更新状态，**不是近一个月新增星标排名**。

本仓库是对其核心交互和用途的独立轻量实现，未复制上游源码、商标或静态资源，不声称实现上游的全部功能，也不属于上游官方产品。

复刻 DocsGPT 的导入→检索→引用问答路径。使用本地关键词检索，不使用向量数据库；不解析 PDF/图片，不支持 OCR、爬虫或云端知识库。中文单字/双字检索与英文词匹配不保证识别所有同义表达。

## 数据与部署边界

文档保存在当前浏览器本地存储。支持最多 12 份文档，单份 12 万字符、总计 24 万字符。 演示模式数据不离开本机；真实模式会将本次输入发送至所配置的模型服务。

默认只监听 127.0.0.1，适用于单人本地使用；没有多用户登录或持久数据库。如需公网部署，请先增加身份验证、配额和 HTTPS。服务限制请求大小、并发和超时，禁止从静态目录读取密钥文件。

接口实现依据 [OpenAI 官方文本生成文档](https://developers.openai.com/api/docs/guides/text)。

## License

MIT — independent implementation.
