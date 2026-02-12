/**
 * ZtoApi - OpenAI兼容API代理服务器
 *
 * 功能概述：
 * - 为 Z.ai 的 GLM-4.5, GLM-4.5V, GLM-4.6 等模型提供 OpenAI 兼容的 API 接口
 * - 支持流式和非流式响应模式
 * - 提供实时监控 Dashboard 功能
 * - 支持匿名 token 自动获取
 * - 智能处理模型思考过程展示
 * - 完整的请求统计和错误处理
 *
 * 技术栈：
 * - Deno 原生 HTTP API
 * - TypeScript 类型安全
 * - Server-Sent Events (SSE) 流式传输
 * - 支持 Deno Deploy 和自托管部署
 *
 * @author ZtoApi Team
 * @version 2.0.0
 * @since 2024
 */
import { decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

declare namespace Deno {
  interface Conn {
    readonly rid: number;
    localAddr: Addr;
    remoteAddr: Addr;
    read(p: Uint8Array): Promise<number | null>;
    write(p: Uint8Array): Promise<number>;
    close(): void;
  }

  interface Addr {
    hostname: string;
    port: number;
    transport: string;
  }

  interface Listener extends AsyncIterable<Conn> {
    readonly addr: Addr;
    accept(): Promise<Conn>;
    close(): void;
    [Symbol.asyncIterator](): AsyncIterableIterator<Conn>;
  }

  interface HttpConn {
    nextRequest(): Promise<RequestEvent | null>;
    [Symbol.asyncIterator](): AsyncIterableIterator<RequestEvent>;
  }

  interface RequestEvent {
    request: Request;
    respondWith(r: Response | Promise<Response>): Promise<void>;
  }

  function listen(options: { port: number }): Listener;
  function serveHttp(conn: Conn): HttpConn;
  function serve(handler: (request: Request) => Promise<Response>): void;

  namespace env {
    function get(key: string): string | undefined;
  }
}

/**
 * 请求统计信息接口
 * 用于跟踪API调用的各项指标
 */
interface RequestStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  lastRequestTime: Date;
  averageResponseTime: number;
}

/**
 * 实时请求信息接口
 * 用于Dashboard显示最近的API请求记录
 */
interface LiveRequest {
  id: string;
  timestamp: Date;
  method: string;
  path: string;
  status: number;
  duration: number;
  userAgent: string;
  model?: string;
}

/**
 * OpenAI兼容请求结构
 * 标准的聊天完成API请求格式
 */
interface OpenAIRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  reasoning?: boolean;
}

/**
 * 聊天消息结构
 * 支持全方位多模态内容：文本、图像、视频、文档
 */
interface Message {
  role: string;
  content:
    | string
    | Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
        video_url?: { url: string };
        document_url?: { url: string };
        audio_url?: { url: string };
      }>;
}

/**
 * 文件上传结果结构
 */
interface UploadedFile {
  id: string;
  filename: string;
  size: number;
  type: string;
  url?: string;
}

/**
 * 上游服务请求结构
 * 向Z.ai服务发送的请求格式
 */
interface UpstreamRequest {
  stream: boolean;
  model: string;
  messages: Message[];
  params: Record<string, unknown>;
  features: Record<string, unknown>;
  background_tasks?: Record<string, boolean>;
  chat_id?: string;
  id?: string;
  mcp_servers?: string[];
  model_item?: {
    id: string;
    name: string;
    owned_by: string;
    openai?: any;
    urlIdx?: number;
    info?: any;
    actions?: any[];
    tags?: any[];
  };
  tool_servers?: string[];
  variables?: Record<string, string>;
  files?: UploadedFile[];
  signature_prompt?: string;
}

/**
 * OpenAI兼容响应结构
 */
interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
}

interface Choice {
  index: number;
  message?: Message;
  delta?: Delta;
  finish_reason?: string;
}

interface Delta {
  role?: string;
  content?: string;
}

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * 上游SSE数据结构
 */
interface UpstreamData {
  type: string;
  data: {
    delta_content: string;
    phase: string;
    done: boolean;
    usage?: Usage;
    error?: UpstreamError;
    inner?: {
      error?: UpstreamError;
    };
  };
  error?: UpstreamError;
}

interface UpstreamError {
  detail: string;
  code: number;
}

interface ModelsResponse {
  object: string;
  data: Model[];
}

interface Model {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

/**
 * MCP 服务器配置
 */
interface MCPServerConfig {
  name: string;
  description: string;
  enabled: boolean;
}

/**
 * 高级模式检测配置
 */
interface ModelCapabilities {
  thinking: boolean;
  search: boolean;
  advancedSearch: boolean;
  vision: boolean;
  mcp: boolean;
}

/**
 * 配置常量定义
 */

// 思考内容处理策略: strip-去除<details>标签, think-转为<thinking>标签, raw-保留原样
const THINK_TAGS_MODE = "strip";

// MCP 服务器配置
const MCP_SERVERS: Record<string, MCPServerConfig> = {
  "deep-web-search": {
    name: "Deep Web Search",
    description: "深度网络搜索功能",
    enabled: true,
  },
  "advanced-search": {
    name: "Advanced Search",
    description: "高级搜索功能",
    enabled: true,
  },
  "vibe-coding": {
    name: "Vibe Coding",
    description: "编程助手功能",
    enabled: true,
  },
  "ppt-maker": {
    name: "PPT Maker",
    description: "PPT 生成功能",
    enabled: true,
  },
  "image-search": {
    name: "Image Search",
    description: "图像搜索功能",
    enabled: true,
  },
  "deep-research": {
    name: "Deep Research",
    description: "深度研究功能",
    enabled: true,
  },
};

/**
 * 高级模式检测器
 */
class ModelCapabilityDetector {
  /**
   * 检测模型的高级能力
   */
  static detectCapabilities(modelId: string, reasoning?: boolean): ModelCapabilities {
    const normalizedModelId = modelId.toLowerCase();

    return {
      thinking: this.isThinkingModel(normalizedModelId, reasoning),
      search: this.isSearchModel(normalizedModelId),
      advancedSearch: this.isAdvancedSearchModel(normalizedModelId),
      vision: this.isVisionModel(normalizedModelId),
      mcp: this.supportsMCP(normalizedModelId),
    };
  }

  private static isThinkingModel(modelId: string, reasoning?: boolean): boolean {
    return modelId.includes("thinking") ||
           modelId.includes("4.6") ||
           reasoning === true ||
           modelId.includes("0727-360b-api");
  }

  private static isSearchModel(modelId: string): boolean {
    return modelId.includes("search") ||
           modelId.includes("web") ||
           modelId.includes("browser");
  }

  private static isAdvancedSearchModel(modelId: string): boolean {
    return modelId.includes("advanced-search") ||
           modelId.includes("advanced") ||
           modelId.includes("pro-search");
  }

  private static isVisionModel(modelId: string): boolean {
    return modelId.includes("4.5v") ||
           modelId.includes("vision") ||
           modelId.includes("image") ||
           modelId.includes("multimodal");
  }

  private static supportsMCP(modelId: string): boolean {
    // 大部分高级模型都支持 MCP
    return this.isThinkingModel(modelId) ||
           this.isSearchModel(modelId) ||
           this.isAdvancedSearchModel(modelId);
  }

  /**
   * 获取模型对应的 MCP 服务器列表
   */
  static getMCPServersForModel(capabilities: ModelCapabilities): string[] {
    const servers: string[] = [];

    if (capabilities.advancedSearch) {
      servers.push("advanced-search");
    } else if (capabilities.search) {
      servers.push("deep-web-search");
    }

    // 添加隐藏的 MCP 服务器特性
    if (capabilities.mcp) {
      // 这些服务器作为隐藏特性添加到 features 中
      debugLog("模型支持隐藏 MCP 特性: vibe-coding, ppt-maker, image-search, deep-research");
    }

    return servers;
  }

  /**
   * 获取隐藏的 MCP 特性列表
   */
  static getHiddenMCPFeatures(): Array<{ type: string; server: string; status: string }> {
    return [
      { type: "mcp", server: "vibe-coding", status: "hidden" },
      { type: "mcp", server: "ppt-maker", status: "hidden" },
      { type: "mcp", server: "image-search", status: "hidden" },
      { type: "mcp", server: "deep-research", status: "hidden" }
    ];
  }
}

/**
 * 智能 Header 生成器
 * 动态生成真实的浏览器请求头
 */
class SmartHeaderGenerator {
  private static cachedHeaders: Record<string, string> | null = null;
  private static cacheExpiry: number = 0;
  private static readonly CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

  /**
   * 生成智能浏览器头部
   */
  static async generateHeaders(chatId: string = ""): Promise<Record<string, string>> {
    // 检查缓存
    const now = Date.now();
    if (this.cachedHeaders && this.cacheExpiry > now) {
      const headers = { ...this.cachedHeaders };
      if (chatId) {
        headers["Referer"] = `${ORIGIN_BASE}/c/${chatId}`;
      }
      return headers;
    }

    // 生成新的头部
    const headers = await this.generateFreshHeaders();
    this.cachedHeaders = headers;
    this.cacheExpiry = now + this.CACHE_DURATION;

    debugLog("智能 Header 已生成并缓存");
    return headers;
  }

  private static async generateFreshHeaders(): Promise<Record<string, string>> {
    // 随机选择浏览器配置
    const browserConfigs = [
      {
        ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        secChUa: '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
        version: "140.0.0.0"
      },
      {
        ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
        secChUa: '"Chromium";v="139", "Not=A?Brand";v="24", "Google Chrome";v="139"',
        version: "139.0.0.0"
      },
      {
        ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
        secChUa: '"Not_A Brand";v="8", "Chromium";v="126", "Firefox";v="126"',
        version: "126.0"
      },
      {
        ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        secChUa: '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
        version: "140.0.0.0"
      }
    ];

    const config = browserConfigs[Math.floor(Math.random() * browserConfigs.length)];

    return {
      // 基础头部
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Content-Type": "application/json",
      "Pragma": "no-cache",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",

      // 浏览器特定头部
      "User-Agent": config.ua,
      "Sec-Ch-Ua": config.secChUa,
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',

      // Z.AI 特定头部
      "Origin": ORIGIN_BASE,
      "Referer": `${ORIGIN_BASE}/`,
      "X-Fe-Version": X_FE_VERSION,
    };
  }

  /**
   * 清除缓存
   */
  static clearCache(): void {
    this.cachedHeaders = null;
    this.cacheExpiry = 0;
    debugLog("Header 缓存已清除");
  }
}

/**
 * 浏览器指纹参数生成器
 */
class BrowserFingerprintGenerator {
  /**
   * 生成完整的浏览器指纹参数
   */
  static generateFingerprintParams(
    timestamp: number,
    requestId: string,
    token: string,
    chatId: string = ""
  ): Record<string, string> {
    // 从 JWT token 提取用户 ID（多字段支持，与 Python 版本一致）
    let userId = "guest";
    try {
      const tokenParts = token.split(".");
      if (tokenParts.length === 3) {
        const payload = JSON.parse(atob(tokenParts[1]));

        // 尝试多个可能的 user_id 字段（与 Python 版本一致）
        for (const key of ["id", "user_id", "uid", "sub"]) {
          const val = payload[key];
          if (typeof val === "string" || typeof val === "number") {
            const strVal = String(val);
            if (strVal.length > 0) {
              userId = strVal;
              break;
            }
          }
        }
      }
    } catch (e) {
      debugLog("解析 JWT token 失败: %v", e);
    }

    const now = new Date(timestamp);
    const localTime = now.toISOString().replace('T', ' ').substring(0, 23) + 'Z';

    return {
      // 基础参数
      "timestamp": timestamp.toString(),
      "requestId": requestId,
      "user_id": userId,
      "version": "0.0.1",
      "platform": "web",
      "token": token,

      // 浏览器环境参数
      "user_agent": BROWSER_UA,
      "language": "zh-CN",
      "languages": "zh-CN,zh",
      "timezone": "Asia/Shanghai",
      "cookie_enabled": "true",

      // 屏幕参数
      "screen_width": "2048",
      "screen_height": "1152",
      "screen_resolution": "2048x1152",
      "viewport_height": "654",
      "viewport_width": "1038",
      "viewport_size": "1038x654",
      "color_depth": "24",
      "pixel_ratio": "1.25",

      // URL 参数
      "current_url": chatId ? `${ORIGIN_BASE}/c/${chatId}` : ORIGIN_BASE,
      "pathname": chatId ? `/c/${chatId}` : "/",
      "search": "",
      "hash": "",
      "host": "chat.z.ai",
      "hostname": "chat.z.ai",
      "protocol": "https:",
      "referrer": "",
      "title": "Z.ai Chat - Free AI powered by GLM-4.6 & GLM-4.5",

      // 时间参数
      "timezone_offset": "-480",
      "local_time": localTime,
      "utc_time": now.toUTCString(),

      // 设备参数
      "is_mobile": "false",
      "is_touch": "false",
      "max_touch_points": "10",
      "browser_name": "Chrome",
      "os_name": "Windows",

      // 签名参数
      "signature_timestamp": timestamp.toString(),
    };
  }
}

// 伪装前端头部（来自抓包分析）
const X_FE_VERSION = "prod-fe-1.0.103";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const SEC_CH_UA =
  '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"';
const SEC_CH_UA_MOB = "?0";
const SEC_CH_UA_PLAT = '"Windows"';
const ORIGIN_BASE = "https://chat.z.ai";

const ANON_TOKEN_ENABLED = true;

/**
 * 环境变量配置
 */
const UPSTREAM_URL =
  Deno.env.get("UPSTREAM_URL") || "https://chat.z.ai/api/v2/chat/completions";
const DEFAULT_KEY = Deno.env.get("DEFAULT_KEY") || "sk-your-key";
const ZAI_TOKEN = Deno.env.get("ZAI_TOKEN") || "";

/**
 * 支持的模型配置
 */
interface ModelConfig {
  id: string; // OpenAI API中的模型ID
  name: string; // 显示名称
  upstreamId: string; // Z.ai上游的模型ID
  capabilities: {
    vision: boolean;
    mcp: boolean;
    thinking: boolean;
  };
  defaultParams: {
    top_p: number;
    temperature: number;
    max_tokens?: number;
  };
}

const SUPPORTED_MODELS: ModelConfig[] = [
  {
    id: "0727-360B-API",
    name: "GLM-4.5",
    upstreamId: "0727-360B-API",
    capabilities: {
      vision: false,
      mcp: true,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 80000,
    },
  },
  {
    id: "glm-4.5v",
    name: "GLM-4.5V",
    upstreamId: "glm-4.5v",
    capabilities: {
      vision: true,
      mcp: false,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.6,
      temperature: 0.8,
    },
  },
  {
    id: "glm-4.6",
    name: "GLM-4.6",
    upstreamId: "GLM-4-6-API-V1",
    capabilities: {
      vision: false,
      mcp: true,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 80000,
    },
  },
  {
    id: "glm-4.6v",
    name: "GLM-4.6V",
    upstreamId: "glm-4.6v",
    capabilities: {
      vision: true,
      mcp: false,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.6,
      temperature: 0.8,
    },
  },
  {
    id: "glm-4.7",
    name: "GLM-4.7",
    upstreamId: "glm-4.7",
    capabilities: {
      vision: false,
      mcp: true,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 80000,
    },
  },
  {
    id: "glm-5",
    name: "GLM-5",
    upstreamId: "glm-5",
    capabilities: {
      vision: false,
      mcp: true,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 80000,
    },
  },
  {
    id: "0727-106B-API",
    name: "GLM-4.5-Air",
    upstreamId: "0727-106B-API",
    capabilities: {
      vision: false,
      mcp: true,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 80000,
    },
  },
  {
    id: "0808-360B-DR",
    name: "0808-360B-DR",
    upstreamId: "0808-360B-DR",
    capabilities: {
      vision: false,
      mcp: true,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 80000,
    },
  },
];

// 默认模型
const DEFAULT_MODEL = SUPPORTED_MODELS[0];

// 根据模型ID获取配置
function getModelConfig(modelId: string): ModelConfig {
  // 标准化模型ID，处理Cherry Studio等客户端的大小写差异
  const normalizedModelId = normalizeModelId(modelId);
  const found = SUPPORTED_MODELS.find((m) => m.id === normalizedModelId);

  if (!found) {
    debugLog(
      "⚠️ 未找到模型配置: %s (标准化后: %s)，使用默认模型: %s",
      modelId,
      normalizedModelId,
      DEFAULT_MODEL.name
    );
  }

  return found || DEFAULT_MODEL;
}

/**
 * 标准化模型ID，处理不同客户端的命名差异
 * Cherry Studio等客户端可能使用不同的大小写格式
 */
function normalizeModelId(modelId: string): string {
  const normalized = modelId.toLowerCase().trim();

  // 处理常见的模型ID映射
  const modelMappings: Record<string, string> = {
    "glm-4.5v": "glm-4.5v",
    "glm4.5v": "glm-4.5v",
    "glm_4.5v": "glm-4.5v",
    "gpt-4-vision-preview": "glm-4.5v", // 向后兼容
    "0727-360b-api": "0727-360B-API",
    "glm-4.5": "0727-360B-API",
    "glm4.5": "0727-360B-API",
    "glm_4.5": "0727-360B-API",
    "gpt-4": "0727-360B-API", // 向后兼容
    "glm-4.6": "glm-4.6",
    "glm4.6": "glm-4.6",
    "glm_4.6": "glm-4.6",
  };

  const mapped = modelMappings[normalized];
  if (mapped) {
    debugLog("🔄 模型ID映射: %s → %s", modelId, mapped);
    return mapped;
  }

  return normalized;
}

/**
 * 处理和验证全方位多模态消息
 * 支持图像、视频、文档、音频等多种媒体类型
 */
function processMessages(
  messages: Message[],
  modelConfig: ModelConfig
): Message[] {
  const processedMessages: Message[] = [];

  for (const message of messages) {
    const processedMessage: Message = { ...message };

    // 检查是否为多模态消息
    if (Array.isArray(message.content)) {
      debugLog("检测到多模态消息，内容块数量: %d", message.content.length);

      // 统计各种媒体类型
      const mediaStats = {
        text: 0,
        images: 0,
        videos: 0,
        documents: 0,
        audios: 0,
        others: 0,
      };

      // 验证模型是否支持多模态
      if (!modelConfig.capabilities.vision) {
        debugLog(
          "警告: 模型 %s 不支持多模态，但收到了多模态消息",
          modelConfig.name
        );
        // 只保留文本内容
        const textContent = message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        processedMessage.content = textContent;
      } else {
        // GLM-4.5V 支持全方位多模态，处理所有内容类型
        for (const block of message.content) {
          switch (block.type) {
            case "text":
              if (block.text) {
                mediaStats.text++;
                debugLog("📝 文本内容，长度: %d", block.text.length);
              }
              break;

            case "image_url":
              if (block.image_url?.url) {
                mediaStats.images++;
                const url = block.image_url.url;
                if (url.startsWith("data:image/")) {
                  const mimeMatch = url.match(/data:image\/([^;]+)/);
                  const format = mimeMatch ? mimeMatch[1] : "unknown";
                  debugLog(
                    "🖼️ 图像数据: %s格式, 大小: %d字符",
                    format,
                    url.length
                  );
                } else if (url.startsWith("http")) {
                  debugLog("🔗 图像URL: %s", url);
                } else {
                  debugLog("⚠️ 未知图像格式: %s", url.substring(0, 50));
                }
              }
              break;

            case "video_url":
              if (block.video_url?.url) {
                mediaStats.videos++;
                const url = block.video_url.url;
                if (url.startsWith("data:video/")) {
                  const mimeMatch = url.match(/data:video\/([^;]+)/);
                  const format = mimeMatch ? mimeMatch[1] : "unknown";
                  debugLog(
                    "🎥 视频数据: %s格式, 大小: %d字符",
                    format,
                    url.length
                  );
                } else if (url.startsWith("http")) {
                  debugLog("🔗 视频URL: %s", url);
                } else {
                  debugLog("⚠️ 未知视频格式: %s", url.substring(0, 50));
                }
              }
              break;

            case "document_url":
              if (block.document_url?.url) {
                mediaStats.documents++;
                const url = block.document_url.url;
                if (url.startsWith("data:application/")) {
                  const mimeMatch = url.match(/data:application\/([^;]+)/);
                  const format = mimeMatch ? mimeMatch[1] : "unknown";
                  debugLog(
                    "📄 文档数据: %s格式, 大小: %d字符",
                    format,
                    url.length
                  );
                } else if (url.startsWith("http")) {
                  debugLog("🔗 文档URL: %s", url);
                } else {
                  debugLog("⚠️ 未知文档格式: %s", url.substring(0, 50));
                }
              }
              break;

            case "audio_url":
              if (block.audio_url?.url) {
                mediaStats.audios++;
                const url = block.audio_url.url;
                if (url.startsWith("data:audio/")) {
                  const mimeMatch = url.match(/data:audio\/([^;]+)/);
                  const format = mimeMatch ? mimeMatch[1] : "unknown";
                  debugLog(
                    "🎵 音频数据: %s格式, 大小: %d字符",
                    format,
                    url.length
                  );
                } else if (url.startsWith("http")) {
                  debugLog("🔗 音频URL: %s", url);
                } else {
                  debugLog("⚠️ 未知音频格式: %s", url.substring(0, 50));
                }
              }
              break;

            default:
              mediaStats.others++;
              debugLog("❓ 未知内容类型: %s", block.type);
          }
        }

        // 输出统计信息
        const totalMedia =
          mediaStats.images +
          mediaStats.videos +
          mediaStats.documents +
          mediaStats.audios;
        if (totalMedia > 0) {
          debugLog(
            "🎯 多模态内容统计: 文本(%d) 图像(%d) 视频(%d) 文档(%d) 音频(%d)",
            mediaStats.text,
            mediaStats.images,
            mediaStats.videos,
            mediaStats.documents,
            mediaStats.audios
          );
        }
      }
    } else if (typeof message.content === "string") {
      debugLog("📝 纯文本消息，长度: %d", message.content.length);
    }

    processedMessages.push(processedMessage);
  }

  return processedMessages;
}

const DEBUG_MODE = Deno.env.get("DEBUG_MODE") !== "false"; // 默认为true
const DEFAULT_STREAM = Deno.env.get("DEFAULT_STREAM") !== "false"; // 默认为true
const DASHBOARD_ENABLED = Deno.env.get("DASHBOARD_ENABLED") !== "false"; // 默认为true

/**
 * Token 池管理系统
 * 支持多个 Token 轮换使用，自动切换失败的 Token
 */
interface TokenInfo {
  token: string;
  isValid: boolean;
  lastUsed: number;
  failureCount: number;
  isAnonymous?: boolean;
}

class TokenPool {
  private tokens: TokenInfo[] = [];
  private currentIndex: number = 0;
  private anonymousToken: string | null = null;
  private anonymousTokenExpiry: number = 0;

  constructor() {
    this.initializeTokens();
  }

  /**
   * 初始化 Token 池
   */
  private initializeTokens(): void {
    // 从环境变量读取多个 Token，用逗号分隔
    const tokenEnv = Deno.env.get("ZAI_TOKENS");
    if (tokenEnv) {
      const tokenList = tokenEnv.split(",").map(t => t.trim()).filter(t => t.length > 0);
      this.tokens = tokenList.map(token => ({
        token,
        isValid: true,
        lastUsed: 0,
        failureCount: 0
      }));
      debugLog("Token 池已初始化，包含 %d 个 Token", this.tokens.length);
    } else if (ZAI_TOKEN) {
      // 兼容单个 Token 配置
      this.tokens = [{
        token: ZAI_TOKEN,
        isValid: true,
        lastUsed: 0,
        failureCount: 0
      }];
      debugLog("使用单个 Token 配置");
    } else {
      debugLog("⚠️ 未配置 Token，将使用匿名 Token");
    }
  }

  /**
   * 获取下一个可用 Token
   */
  async getToken(): Promise<string> {
    // 如果有配置的 Token，尝试使用
    if (this.tokens.length > 0) {
      const token = this.getNextValidToken();
      if (token) {
        token.lastUsed = Date.now();
        return token.token;
      }
    }

    // 降级到匿名 Token
    return await this.getAnonymousToken();
  }

  /**
   * 获取下一个有效的配置 Token
   */
  private getNextValidToken(): TokenInfo | null {
    const startIndex = this.currentIndex;

    do {
      const tokenInfo = this.tokens[this.currentIndex];
      if (tokenInfo.isValid && tokenInfo.failureCount < 3) {
        return tokenInfo;
      }
      this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
    } while (this.currentIndex !== startIndex);

    return null; // 所有 Token 都不可用
  }

  /**
   * 切换到下一个 Token（当前 Token 失败时调用）
   */
  async switchToNext(): Promise<string | null> {
    if (this.tokens.length === 0) return null;

    // 标记当前 Token 为失败
    const currentToken = this.tokens[this.currentIndex];
    currentToken.failureCount++;
    if (currentToken.failureCount >= 3) {
      currentToken.isValid = false;
      debugLog("Token 已标记为无效: %s", currentToken.token.substring(0, 20));
    }

    // 切换到下一个
    this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
    const nextToken = this.tokens[this.currentIndex];

    if (nextToken && nextToken.isValid) {
      debugLog("切换到下一个 Token: %s", nextToken.token.substring(0, 20));
      nextToken.lastUsed = Date.now();
      return nextToken.token;
    }

    return null; // 所有配置 Token 都不可用
  }

  /**
   * 重置 Token 状态（成功调用后）
   */
  markSuccess(token: string): void {
    const tokenInfo = this.tokens.find(t => t.token === token);
    if (tokenInfo) {
      tokenInfo.failureCount = 0;
      tokenInfo.isValid = true;
    }
  }

  /**
   * 获取匿名 Token
   */
  private async getAnonymousToken(): Promise<string> {
    const now = Date.now();

    // 检查缓存是否有效
    if (this.anonymousToken && this.anonymousTokenExpiry > now) {
      return this.anonymousToken;
    }

    try {
      this.anonymousToken = await getAnonymousToken();
      this.anonymousTokenExpiry = now + (60 * 60 * 1000); // 1小时有效期
      debugLog("匿名 Token 已获取并缓存");
      return this.anonymousToken;
    } catch (error) {
      debugLog("获取匿名 Token 失败: %v", error);
      throw error;
    }
  }

  /**
   * 清除匿名 Token 缓存
   */
  clearAnonymousTokenCache(): void {
    this.anonymousToken = null;
    this.anonymousTokenExpiry = 0;
    debugLog("匿名 Token 缓存已清除");
  }

  /**
   * 获取 Token 池大小
   */
  getPoolSize(): number {
    return this.tokens.length;
  }

  /**
   * 检查是否为匿名 Token
   */
  isAnonymousToken(token: string): boolean {
    return this.anonymousToken === token;
  }
}

// 全局 Token 池实例
const tokenPool = new TokenPool();

/**
 * 全局状态变量
 */

let stats: RequestStats = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  lastRequestTime: new Date(),
  averageResponseTime: 0,
};

let liveRequests: LiveRequest[] = [];

/**
 * 图像处理工具类
 */
class ImageProcessor {
  /**
   * 检测消息中是否包含图像内容
   */
  static hasImageContent(messages: Message[]): boolean {
    for (const msg of messages) {
      if (msg.role === "user") {
        const content = msg.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === "image_url" && part.image_url?.url) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  /**
   * 上传图像到 Z.AI 服务器
   */
  static async uploadImage(imageUrl: string, token: string): Promise<UploadedFile | null> {
    try {
      debugLog("开始上传图像: %s", imageUrl.substring(0, 50) + "...");

      // 处理 base64 图像数据
      let imageData: Uint8Array;
      let filename: string;
      let mimeType: string;

      if (imageUrl.startsWith("data:image/")) {
        // 解析 base64 图像
        const matches = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!matches) {
          throw new Error("Invalid base64 image format");
        }

        mimeType = `image/${matches[1]}`;
        filename = `image.${matches[1]}`;
        const base64Data = matches[2];
        imageData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
      } else if (imageUrl.startsWith("http")) {
        // 下载远程图像
        const response = await fetch(imageUrl);
        if (!response.ok) {
          throw new Error(`Failed to download image: ${response.statusText}`);
        }

        const contentType = response.headers.get("content-type") || "image/jpeg";
        const extension = contentType.split("/")[1] || "jpg";
        filename = `image.${extension}`;

        const buffer = await response.arrayBuffer();
        imageData = new Uint8Array(buffer);
        mimeType = contentType;
      } else {
        throw new Error("Unsupported image URL format");
      }

      // 创建 FormData
      const formData = new FormData();
      const arrayBuffer = imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength) as ArrayBuffer;
      const blob = new Blob([arrayBuffer], { type: mimeType });
      formData.append("file", blob, filename);

      // 上传到 Z.AI
      const uploadResponse = await fetch("https://chat.z.ai/api/files", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Origin": ORIGIN_BASE,
          "Referer": `${ORIGIN_BASE}/`,
        },
        body: formData,
      });

      if (!uploadResponse.ok) {
        throw new Error(`Upload failed: ${uploadResponse.statusText}`);
      }

      const uploadResult = await uploadResponse.json() as any;
      debugLog("图像上传成功: %s", uploadResult.id);

      return {
        id: uploadResult.id,
        filename: uploadResult.filename || filename,
        size: imageData.length,
        type: mimeType,
        url: uploadResult.url,
      };
    } catch (error) {
      debugLog("图像上传失败: %v", error);
      return null;
    }
  }

  /**
   * 处理消息中的图像内容，返回处理后的消息和上传的文件列表
   */
  static async processImages(
    messages: Message[],
    token: string,
    isVisionModel: boolean = false
  ): Promise<{ processedMessages: Message[], uploadedFiles: UploadedFile[], uploadedFilesMap: Map<string, UploadedFile> }> {
    const processedMessages: Message[] = [];
    const uploadedFiles: UploadedFile[] = [];
    const uploadedFilesMap = new Map<string, UploadedFile>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const processedMsg: Message = { ...msg };

      if (msg.role === "user" && Array.isArray(msg.content)) {
        const newContent: any[] = [];

        for (const part of msg.content) {
          if (part.type === "image_url" && part.image_url?.url) {
            const imageUrl = part.image_url.url;

            // 上传图像
            const uploadedFile = await this.uploadImage(imageUrl, token);
            if (uploadedFile) {
              if (isVisionModel) {
                // GLM-4.5V: 保留在消息中，但转换 URL 格式
                const newUrl = `${uploadedFile.id}_${uploadedFile.filename}`;
                newContent.push({
                  type: "image_url",
                  image_url: { url: newUrl }
                });
                uploadedFilesMap.set(imageUrl, uploadedFile);
                debugLog("GLM-4.5V 图像 URL 已转换: %s -> %s", imageUrl.substring(0, 50), newUrl);
              } else {
                // 非视觉模型: 添加到文件列表，从消息中移除
                uploadedFiles.push(uploadedFile);
                debugLog("图像已添加到文件列表: %s", uploadedFile.id);
              }
            }
          } else if (part.type === "text") {
            newContent.push(part);
          }
        }

        // 如果只有文本内容，转换为字符串格式
        if (newContent.length === 1 && newContent[0].type === "text") {
          processedMsg.content = newContent[0].text;
        } else if (newContent.length > 0) {
          processedMsg.content = newContent;
        } else {
          processedMsg.content = "";
        }
      }

      processedMessages.push(processedMsg);
    }

    return {
      processedMessages,
      uploadedFiles,
      uploadedFilesMap
    };
  }

  /**
   * 提取最后一条用户消息的文本内容
   */
  static extractLastUserContent(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user") {
        const content = msg.content;
        if (typeof content === "string") {
          return content;
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === "text" && part.text) {
              return part.text;
            }
          }
        }
      }
    }
    return "";
  }
}

/**
 * 工具函数
 */

function debugLog(format: string, ...args: unknown[]): void {
  if (DEBUG_MODE) {
    console.log(`[DEBUG] ${format}`, ...args);
  }
}

function recordRequestStats(
  startTime: number,
  path: string,
  status: number
): void {
  const duration = Date.now() - startTime;

  stats.totalRequests++;
  stats.lastRequestTime = new Date();

  if (status >= 200 && status < 300) {
    stats.successfulRequests++;
  } else {
    stats.failedRequests++;
  }

  // 更新平均响应时间
  if (stats.totalRequests > 0) {
    const totalDuration =
      stats.averageResponseTime * (stats.totalRequests - 1) + duration;
    stats.averageResponseTime = totalDuration / stats.totalRequests;
  } else {
    stats.averageResponseTime = duration;
  }
}

function addLiveRequest(
  method: string,
  path: string,
  status: number,
  duration: number,
  userAgent: string,
  model?: string
): void {
  const request: LiveRequest = {
    id: Date.now().toString(),
    timestamp: new Date(),
    method,
    path,
    status,
    duration,
    userAgent,
    model,
  };

  liveRequests.push(request);

  // 只保留最近的100条请求
  if (liveRequests.length > 100) {
    liveRequests = liveRequests.slice(1);
  }
}

function getLiveRequestsData(): string {
  try {
    // 确保liveRequests是数组
    if (!Array.isArray(liveRequests)) {
      debugLog("liveRequests不是数组，重置为空数组");
      liveRequests = [];
    }

    // 确保返回的数据格式与前端期望的一致
    const requestData = liveRequests.map((req) => ({
      id: req.id || "",
      timestamp: req.timestamp || new Date(),
      method: req.method || "",
      path: req.path || "",
      status: req.status || 0,
      duration: req.duration || 0,
      user_agent: req.userAgent || "",
    }));

    return JSON.stringify(requestData);
  } catch (error) {
    debugLog("获取实时请求数据失败: %v", error);
    return JSON.stringify([]);
  }
}

function getStatsData(): string {
  try {
    // 确保stats对象存在
    if (!stats) {
      debugLog("stats对象不存在，使用默认值");
      stats = {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        lastRequestTime: new Date(),
        averageResponseTime: 0,
      };
    }

    // 确保返回的数据格式与前端期望的一致
    const statsData = {
      totalRequests: stats.totalRequests || 0,
      successfulRequests: stats.successfulRequests || 0,
      failedRequests: stats.failedRequests || 0,
      averageResponseTime: stats.averageResponseTime || 0,
    };

    return JSON.stringify(statsData);
  } catch (error) {
    debugLog("获取统计数据失败: %v", error);
    return JSON.stringify({
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
    });
  }
}

function getClientIP(request: Request): string {
  // 检查X-Forwarded-For头
  const xff = request.headers.get("X-Forwarded-For");
  if (xff) {
    const ips = xff.split(",");
    if (ips.length > 0) {
      return ips[0].trim();
    }
  }

  // 检查X-Real-IP头
  const xri = request.headers.get("X-Real-IP");
  if (xri) {
    return xri;
  }

  // 对于Deno Deploy，我们无法直接获取RemoteAddr，返回一个默认值
  return "unknown";
}

function setCORSHeaders(headers: Headers): void {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Allow-Credentials", "true");
}

function validateApiKey(authHeader: string | null): boolean {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }

  const apiKey = authHeader.substring(7);
  return apiKey === DEFAULT_KEY;
}

async function getAnonymousToken(): Promise<string> {
  try {
    const response = await fetch(`${ORIGIN_BASE}/api/v1/auths/`, {
      method: "GET",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "X-FE-Version": X_FE_VERSION,
        "sec-ch-ua": SEC_CH_UA,
        "sec-ch-ua-mobile": SEC_CH_UA_MOB,
        "sec-ch-ua-platform": SEC_CH_UA_PLAT,
        Origin: ORIGIN_BASE,
        Referer: `${ORIGIN_BASE}/`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Anonymous token request failed with status ${response.status}`
      );
    }

    const data = (await response.json()) as { token: string };
    if (!data.token) {
      throw new Error("Anonymous token is empty");
    }

    return data.token;
  } catch (error) {
    debugLog("获取匿名token失败: %v", error);
    throw error;
  }
}

/**
 * 生成Z.ai API请求签名
 * @param e "requestId,request_id,timestamp,timestamp,user_id,user_id"
 * @param t 用户最新消息
 * @param timestamp 时间戳 (毫秒)
 * @returns { signature: string, timestamp: number }
 */
async function generateSignature(
  e: string,
  t: string,
  timestamp: number
): Promise<{ signature: string; timestamp: string }> {
  const timestampStr = String(timestamp);

  // 1. 对消息内容进行Base64编码
  const bodyEncoded = new TextEncoder().encode(t);
  const bodyBase64 = btoa(String.fromCharCode(...bodyEncoded));

  // 2. 构造待签名字符串
  const stringToSign = `${e}|${bodyBase64}|${timestampStr}`;

  // 3. 计算5分钟时间窗口
  const timeWindow = Math.floor(timestamp / (5 * 60 * 1000));

  // 4. 获取签名密钥
  const secretEnv = Deno.env.get("ZAI_SIGNING_SECRET");
  let rootKey: Uint8Array;

  if (secretEnv) {
    // 从环境变量读取密钥
    if (/^[0-9a-fA-F]+$/.test(secretEnv) && secretEnv.length % 2 === 0) {
      // HEX 格式
      rootKey = new Uint8Array(secretEnv.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    } else {
      // UTF-8 格式
      rootKey = new TextEncoder().encode(secretEnv);
    }
    debugLog("使用环境变量密钥: %s", secretEnv.substring(0, 10) + "...");
  } else {
    // 使用新的默认密钥（与 Python 版本一致）
    const defaultKeyHex = "6b65792d40404040292929282928283929292d787878782626262525252525";
    rootKey = new Uint8Array(defaultKeyHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    debugLog("使用默认密钥");
  }

  // 5. 第一层 HMAC，生成中间密钥
  const rootKeyBuffer = rootKey.buffer.slice(rootKey.byteOffset, rootKey.byteOffset + rootKey.byteLength) as ArrayBuffer;
  const firstHmacKey = await crypto.subtle.importKey(
    "raw",
    rootKeyBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const firstSignatureBuffer = await crypto.subtle.sign(
    "HMAC",
    firstHmacKey,
    new TextEncoder().encode(String(timeWindow))
  );
  const intermediateKey = Array.from(new Uint8Array(firstSignatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // 5. 第二层 HMAC，生成最终签名
  const secondKeyMaterial = new TextEncoder().encode(intermediateKey);
  const secondHmacKey = await crypto.subtle.importKey(
    "raw",
    secondKeyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const finalSignatureBuffer = await crypto.subtle.sign(
    "HMAC",
    secondHmacKey,
    new TextEncoder().encode(stringToSign)
  );
  const signature = Array.from(new Uint8Array(finalSignatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  debugLog("新版签名生成成功: %s", signature);
  return {
    signature,
    timestamp: timestampStr,
  };
}

async function callUpstreamWithHeaders(
  upstreamReq: UpstreamRequest,
  refererChatID: string,
  authToken: string
): Promise<Response> {
  try {
    debugLog("调用上游API: %s", UPSTREAM_URL);

    // 1. 解码JWT获取user_id（多字段支持，与 Python 版本一致）
    let userId = "unknown";
    try {
      const tokenParts = authToken.split(".");
      if (tokenParts.length === 3) {
        const payload = JSON.parse(
          new TextDecoder().decode(decodeBase64(tokenParts[1]))
        );

        // 尝试多个可能的 user_id 字段（与 Python 版本一致）
        for (const key of ["id", "user_id", "uid", "sub"]) {
          const val = payload[key];
          if (typeof val === "string" || typeof val === "number") {
            const strVal = String(val);
            if (strVal.length > 0) {
              userId = strVal;
              debugLog("从JWT解析到 user_id: %s (字段: %s)", userId, key);
              break;
            }
          }
        }
      }
    } catch (e) {
      debugLog("解析JWT失败: %v", e);
    }

    // 2. 准备签名所需参数
    const timestamp = Date.now();
    const requestId = crypto.randomUUID();
    const lastMessageContent = ImageProcessor.extractLastUserContent(upstreamReq.messages);

    if (!lastMessageContent) {
      throw new Error("无法获取用于签名的用户消息内容");
    }

    const e = `requestId,${requestId},timestamp,${timestamp},user_id,${userId}`;

    // 3. 生成新签名
    const { signature } = await generateSignature(
      e,
      lastMessageContent,
      timestamp
    );
    debugLog("生成新版签名: %s", signature);

    const reqBody = JSON.stringify(upstreamReq);
    debugLog("上游请求体: %s", reqBody);

    // 4. 生成智能浏览器头部
    const smartHeaders = await SmartHeaderGenerator.generateHeaders(refererChatID);

    // 5. 生成完整的浏览器指纹参数
    const fingerprintParams = BrowserFingerprintGenerator.generateFingerprintParams(
      timestamp,
      requestId,
      authToken,
      refererChatID
    );

    // 6. 构建完整的URL参数
    const allParams = {
      ...fingerprintParams,
      signature_timestamp: timestamp.toString(),
    };

    const params = new URLSearchParams(allParams);
    const fullURL = `${UPSTREAM_URL}?${params.toString()}`;

    // 7. 合并头部
    const finalHeaders = {
      ...smartHeaders,
      "Authorization": `Bearer ${authToken}`,
      "X-Signature": signature,
      "Accept": "application/json, text/event-stream",
    };

    const response = await fetch(fullURL, {
      method: "POST",
      headers: finalHeaders,
      body: reqBody,
    });

    debugLog("上游响应状态: %d %s", response.status, response.statusText);

    // 8. 成功时标记 Token 为有效
    tokenPool.markSuccess(authToken);

    return response;
  } catch (error) {
    debugLog("调用上游失败: %v", error);

    // 失败时尝试切换 Token
    try {
      const newToken = await tokenPool.switchToNext();
      if (newToken) {
        debugLog("切换到新 Token 重试: %s", newToken.substring(0, 20));
        // 递归重试一次，避免无限循环
        return callUpstreamWithHeaders(upstreamReq, refererChatID, newToken);
      }
    } catch (retryError) {
      debugLog("Token 切换重试失败: %v", retryError);
    }

    throw error;
  }
}

function transformThinking(content: string): string {
  // 去 <summary>…</summary>
  let result = content.replace(/<summary>.*?<\/summary>/gs, "");
  // 清理残留自定义标签，如 </thinking>、<Full> 等
  result = result.replace(/<\/thinking>/g, "");
  result = result.replace(/<Full>/g, "");
  result = result.replace(/<\/Full>/g, "");
  result = result.trim();

  switch (THINK_TAGS_MODE as "strip" | "think" | "raw") {
    case "think":
      result = result.replace(/<details[^>]*>/g, "<thinking>");
      result = result.replace(/<\/details>/g, "</thinking>");
      break;
    case "strip":
      result = result.replace(/<details[^>]*>/g, "");
      result = result.replace(/<\/details>/g, "");
      break;
  }

  // 处理每行前缀 "> "（包括起始位置）
  result = result.replace(/^> /, "");
  result = result.replace(/\n> /g, "\n");
  return result.trim();
}

async function processUpstreamStream(
  body: ReadableStream<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  modelName: string
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // 保留最后一个不完整的行

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const dataStr = line.substring(6);
          if (dataStr === "") continue;

          debugLog("收到SSE数据: %s", dataStr);

          try {
            const upstreamData = JSON.parse(dataStr) as UpstreamData;

            // 错误检测
            if (
              upstreamData.error ||
              upstreamData.data.error ||
              (upstreamData.data.inner && upstreamData.data.inner.error)
            ) {
              const errObj =
                upstreamData.error ||
                upstreamData.data.error ||
                (upstreamData.data.inner && upstreamData.data.inner.error);
              debugLog(
                "上游错误: code=%d, detail=%s",
                errObj?.code,
                errObj?.detail
              );

              // 分析错误类型，特别是多模态相关错误
              const errorDetail = (errObj?.detail || "").toLowerCase();
              if (
                errorDetail.includes("something went wrong") ||
                errorDetail.includes("try again later")
              ) {
                debugLog("🚨 Z.ai 服务器错误分析:");
                debugLog("   📋 错误详情: %s", errObj?.detail);
                debugLog("   🖼️  可能原因: 图片处理失败");
                debugLog("   💡 建议解决方案:");
                debugLog("      1. 使用更小的图片 (< 500KB)");
                debugLog("      2. 尝试不同的图片格式 (JPEG 而不是 PNG)");
                debugLog("      3. 稍后重试 (可能是服务器负载问题)");
                debugLog("      4. 检查图片是否损坏");
              }

              // 发送结束chunk
              const endChunk: OpenAIResponse = {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: modelName,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: "stop",
                  },
                ],
              };

              await writer.write(
                encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`)
              );
              await writer.write(encoder.encode("data: [DONE]\n\n"));
              return;
            }

            debugLog(
              "解析成功 - 类型: %s, 阶段: %s, 内容长度: %d, 完成: %v",
              upstreamData.type,
              upstreamData.data.phase,
              upstreamData.data.delta_content
                ? upstreamData.data.delta_content.length
                : 0,
              upstreamData.data.done
            );

            // 处理内容
            if (
              upstreamData.data.delta_content &&
              upstreamData.data.delta_content !== ""
            ) {
              let out = upstreamData.data.delta_content;
              if (upstreamData.data.phase === "thinking") {
                out = transformThinking(out);
              }

              if (out !== "") {
                debugLog("发送内容(%s): %s", upstreamData.data.phase, out);

                const chunk: OpenAIResponse = {
                  id: `chatcmpl-${Date.now()}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: modelName,
                  choices: [
                    {
                      index: 0,
                      delta: { content: out },
                    },
                  ],
                };

                await writer.write(
                  encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
                );
              }
            }

            // 检查是否结束
            if (upstreamData.data.done || upstreamData.data.phase === "done") {
              debugLog("检测到流结束信号");

              // 发送结束chunk
              const endChunk: OpenAIResponse = {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: modelName,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: "stop",
                  },
                ],
              };

              await writer.write(
                encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`)
              );
              await writer.write(encoder.encode("data: [DONE]\n\n"));
              return;
            }
          } catch (error) {
            debugLog("SSE数据解析失败: %v", error);
          }
        }
      }
    }
  } finally {
    writer.close();
  }
}

// 收集完整响应（用于非流式响应）
async function collectFullResponse(
  body: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // 保留最后一个不完整的行

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const dataStr = line.substring(6);
          if (dataStr === "") continue;

          try {
            const upstreamData = JSON.parse(dataStr) as UpstreamData;

            if (upstreamData.data.delta_content !== "") {
              let out = upstreamData.data.delta_content;
              if (upstreamData.data.phase === "thinking") {
                out = transformThinking(out);
              }

              if (out !== "") {
                fullContent += out;
              }
            }

            // 检查是否结束
            if (upstreamData.data.done || upstreamData.data.phase === "done") {
              debugLog("检测到完成信号，停止收集");
              return fullContent;
            }
          } catch (error) {
            // 忽略解析错误
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullContent;
}

/**
 * HTTP服务器和路由处理
 */

function getIndexHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ZtoApi - Next-Gen AI Gateway</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Space+Grotesk:wght@300;500;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-primary: #0a0a0f;
            --bg-secondary: #13131a;
            --bg-card: rgba(19, 19, 26, 0.8);
            --bg-card-hover: rgba(19, 19, 26, 0.95);
            --accent-cyan: #00fff5;
            --accent-purple: #b94fff;
            --accent-pink: #ff00aa;
            --accent-green: #00ff88;
            --text-primary: #ffffff;
            --text-secondary: #a0a0c0;
            --text-muted: #6b7280;
            --border-glow: rgba(0, 255, 245, 0.3);
            --border-subtle: rgba(255, 255, 255, 0.1);
            --shadow-glow: 0 20px 40px rgba(0, 255, 245, 0.15);
        }

        [data-theme="light"] {
            --bg-primary: #f8f9fc;
            --bg-secondary: #ffffff;
            --bg-card: rgba(255, 255, 255, 0.9);
            --bg-card-hover: rgba(255, 255, 255, 0.98);
            --text-primary: #1a1a2e;
            --text-secondary: #4b5563;
            --text-muted: #9ca3af;
            --border-glow: rgba(0, 255, 245, 0.15);
            --border-subtle: rgba(0, 0, 0, 0.06);
            --shadow-glow: 0 10px 30px rgba(185, 79, 255, 0.1);
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            overflow-x: hidden;
            min-height: 100vh;
            transition: background 0.5s ease, color 0.5s ease;
        }

        /* Animated Particle Background */
        .particles {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 0;
            opacity: 0.3;
            transition: opacity 0.5s ease;
        }

        [data-theme="light"] .particles {
            opacity: 0.15;
        }

        .particle {
            position: absolute;
            width: 2px;
            height: 2px;
            background: var(--accent-cyan);
            border-radius: 50%;
            animation: float 15s infinite;
            box-shadow: 0 0 10px var(--accent-cyan);
        }

        [data-theme="light"] .particle {
            box-shadow: 0 0 8px var(--accent-cyan);
        }

        @keyframes float {
            0%, 100% {
                transform: translateY(100vh) scale(0);
                opacity: 0;
            }
            10% {
                opacity: 1;
            }
            90% {
                transform: translateY(-10vh) scale(1);
            }
        }

        .container {
            position: relative;
            z-index: 1;
            max-width: 1400px;
            margin: 0 auto;
            padding: 60px 40px;
        }

        /* Top Bar with Controls */
        .top-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 50px;
            animation: fadeInUp 0.8s ease-out;
        }

        .controls {
            display: flex;
            gap: 12px;
            align-items: center;
        }

        .control-btn {
            background: var(--bg-secondary);
            border: 1px solid var(--border-subtle);
            border-radius: 50px;
            padding: 10px 18px;
            cursor: pointer;
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.85rem;
            font-weight: 500;
            color: var(--text-secondary);
            display: flex;
            align-items: center;
            gap: 8px;
            transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }

        .control-btn:hover {
            background: var(--bg-card);
            border-color: var(--border-glow);
            color: var(--text-primary);
            transform: translateY(-2px);
            box-shadow: 0 8px 16px rgba(0, 0, 0, 0.1);
        }

        .control-btn.active {
            background: var(--accent-cyan);
            color: var(--bg-primary);
            border-color: var(--accent-cyan);
        }

        [data-theme="light"] .control-btn.active {
            background: var(--accent-purple);
            color: #ffffff;
        }

        .control-icon {
            font-size: 1.1rem;
        }

        /* Header Section */
        .hero {
            text-align: center;
            margin-bottom: 80px;
            animation: fadeInUp 1s ease-out;
        }

        @keyframes fadeInUp {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .brand {
            display: inline-block;
            font-family: 'JetBrains Mono', monospace;
            font-size: 1rem;
            font-weight: 700;
            letter-spacing: 4px;
            margin-bottom: 20px;
            padding: 12px 24px;
            background: linear-gradient(135deg, var(--accent-purple), var(--accent-pink));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            animation: glow 3s ease-in-out infinite alternate;
        }

        @keyframes glow {
            from {
                filter: drop-shadow(0 0 8px var(--accent-purple));
            }
            to {
                filter: drop-shadow(0 0 16px var(--accent-cyan));
            }
        }

        [data-theme="light"] .brand {
            background: linear-gradient(135deg, #8b5cf6, #06b6d4);
        }

        h1 {
            font-size: clamp(3rem, 8vw, 6rem);
            font-weight: 700;
            line-height: 1.1;
            margin-bottom: 20px;
            background: linear-gradient(135deg, var(--text-primary) 0%, var(--accent-cyan) 50%, var(--accent-purple) 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            letter-spacing: -2px;
        }

        [data-theme="light"] h1 {
            background: linear-gradient(135deg, #1a1a2e 0%, #0066ff 50%, #8b5cf6 100%);
        }

        .subtitle {
            font-size: 1.25rem;
            color: var(--text-secondary);
            font-weight: 300;
            margin-bottom: 30px;
            letter-spacing: 1px;
        }

        .model-counter {
            display: inline-flex;
            align-items: center;
            gap: 12px;
            padding: 10px 20px;
            background: var(--bg-secondary);
            border: 1px solid var(--border-glow);
            border-radius: 50px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.9rem;
        }

        [data-theme="light"] .model-counter {
            border-color: var(--border-subtle);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
        }

        .counter {
            font-size: 1.5rem;
            font-weight: 700;
            color: var(--accent-cyan);
        }

        [data-theme="light"] .counter {
            color: #0066ff;
        }

        .status-dot {
            width: 8px;
            height: 8px;
            background: var(--accent-green);
            border-radius: 50%;
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0%, 100% {
                opacity: 1;
                transform: scale(1);
            }
            50% {
                opacity: 0.5;
                transform: scale(1.2);
            }
        }

        /* Stats Grid */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 30px;
            margin-bottom: 60px;
            animation: fadeInUp 1s ease-out 0.2s both;
        }

        .stat-card {
            background: var(--bg-card);
            border: 1px solid var(--border-subtle);
            border-radius: 16px;
            padding: 30px;
            position: relative;
            overflow: hidden;
            transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }

        [data-theme="light"] .stat-card {
            border-color: var(--border-subtle);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
        }

        .stat-card::before {
            content: '';
            position: absolute;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background: radial-gradient(circle, var(--accent-cyan) 0%, transparent 70%);
            opacity: 0;
            transition: opacity 0.4s;
            pointer-events: none;
        }

        [data-theme="light"] .stat-card::before {
            background: radial-gradient(circle, #0066ff 0%, transparent 70%);
        }

        .stat-card:hover::before {
            opacity: 0.1;
        }

        .stat-card:hover {
            transform: translateY(-8px) scale(1.02);
            border-color: var(--border-glow);
            box-shadow: var(--shadow-glow);
        }

        [data-theme="light"] .stat-card:hover {
            box-shadow: 0 15px 30px rgba(0, 102, 255, 0.15);
        }

        .stat-number {
            font-size: 3rem;
            font-weight: 700;
            font-family: 'JetBrains Mono', monospace;
            background: linear-gradient(135deg, var(--accent-cyan), var(--accent-purple));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 8px;
        }

        [data-theme="light"] .stat-number {
            background: linear-gradient(135deg, #0066ff, #8b5cf6);
        }

        .stat-label {
            font-size: 0.9rem;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 2px;
        }

        /* Links Section */
        .links-section {
            margin-bottom: 60px;
        }

        .section-title {
            font-size: 0.85rem;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 3px;
            margin-bottom: 25px;
            display: flex;
            align-items: center;
            gap: 15px;
        }

        .section-title::after {
            content: '';
            flex: 1;
            height: 1px;
            background: linear-gradient(90deg, transparent, var(--border-glow), transparent);
        }

        .links-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 25px;
        }

        .link-card {
            background: var(--bg-card);
            border: 1px solid var(--border-subtle);
            border-radius: 16px;
            padding: 35px;
            position: relative;
            overflow: hidden;
            cursor: pointer;
            transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            text-decoration: none;
            color: var(--text-primary);
            display: block;
        }

        [data-theme="light"] .link-card {
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
        }

        .link-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(0, 255, 245, 0.1), transparent);
            transition: left 0.5s;
        }

        [data-theme="light"] .link-card::before {
            background: linear-gradient(90deg, transparent, rgba(0, 102, 255, 0.15), transparent);
        }

        .link-card:hover::before {
            left: 100%;
        }

        .link-card:hover {
            transform: translateY(-5px);
            border-color: var(--border-glow);
            box-shadow: var(--shadow-glow);
        }

        [data-theme="light"] .link-card:hover {
            box-shadow: 0 15px 30px rgba(0, 102, 255, 0.2);
        }

        .link-icon {
            font-size: 2.5rem;
            margin-bottom: 15px;
            display: block;
        }

        .link-title {
            font-size: 1.3rem;
            font-weight: 700;
            margin-bottom: 10px;
            letter-spacing: -0.5px;
        }

        .link-desc {
            font-size: 0.95rem;
            color: var(--text-secondary);
            line-height: 1.6;
            margin-bottom: 20px;
        }

        .link-arrow {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-size: 0.9rem;
            font-weight: 500;
            color: var(--accent-cyan);
            transition: gap 0.3s;
        }

        [data-theme="light"] .link-arrow {
            color: #0066ff;
        }

        .link-card:hover .link-arrow {
            gap: 12px;
        }

        /* Highlight Card (Quick Test) */
        .link-card.highlight {
            background: linear-gradient(135deg, rgba(185, 79, 255, 0.15), rgba(185, 79, 255, 0.05));
            border-color: rgba(255, 0, 170, 0.3);
        }

        [data-theme="light"] .link-card.highlight {
            background: linear-gradient(135deg, rgba(255, 0, 170, 0.2), rgba(255, 0, 170, 0.08));
            border-color: rgba(255, 0, 170, 0.4);
        }

        /* Features Section */
        .features-section {
            position: relative;
        }

        .features-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
        }

        .feature-item {
            padding: 25px;
            border-radius: 12px;
            background: var(--bg-card);
            border: 1px solid var(--border-subtle);
            transition: all 0.3s ease;
        }

        [data-theme="light"] .feature-item {
            background: rgba(255, 255, 255, 0.6);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
        }

        .feature-item:hover {
            background: var(--bg-card-hover);
            border-color: var(--border-glow);
        }

        [data-theme="light"] .feature-item:hover {
            box-shadow: 0 8px 16px rgba(0, 102, 255, 0.12);
        }

        .feature-icon {
            font-size: 1.8rem;
            margin-bottom: 12px;
            display: block;
        }

        .feature-title {
            font-size: 1.1rem;
            font-weight: 500;
            margin-bottom: 8px;
        }

        .feature-desc {
            font-size: 0.9rem;
            color: var(--text-secondary);
            line-height: 1.5;
        }

        /* Footer */
        footer {
            text-align: center;
            padding: 40px 0;
            border-top: 1px solid var(--border-subtle);
            margin-top: 80px;
        }

        .footer-text {
            color: var(--text-secondary);
            font-size: 0.9rem;
            letter-spacing: 1px;
        }

        .footer-link {
            color: var(--accent-purple);
            text-decoration: none;
            font-weight: 500;
            transition: color 0.3s;
        }

        [data-theme="light"] .footer-link {
            color: #8b5cf6;
        }

        .footer-link:hover {
            color: var(--accent-cyan);
        }

        [data-theme="light"] .footer-link:hover {
            color: #0066ff;
        }

        /* Responsive */
        @media (max-width: 768px) {
            .container {
                padding: 40px 20px;
            }

            .stats-grid {
                grid-template-columns: 1fr;
            }

            h1 {
                font-size: 2.5rem;
            }

            .controls {
                gap: 8px;
            }

            .control-btn {
                padding: 8px 14px;
                font-size: 0.8rem;
            }

            .control-btn span {
                display: none;
            }
        }
    </style>
</head>
<body>
    <!-- Animated Particles Background -->
    <div class="particles" id="particles"></div>

    <div class="container">
        <!-- Hero Section -->
        <div class="hero">
            <div class="brand">ZtoApi</div>
            <h1>AI GATEWAY</h1>
            <div class="subtitle">
                OpenAI 兼容的下一代 GLM 模型代理服务
            </div>
            <div class="model-counter">
                <span class="status-dot"></span>
                <span class="counter">8</span>
                <span>个 AI 模型在线</span>
            </div>
        </div>

        <!-- Stats Section -->
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-number">v2.1</div>
                <div class="stat-label">API 版本</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">100%</div>
                <div class="stat-label">OpenAI 兼容</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">&lt;50ms</div>
                <div class="stat-label">平均延迟</div>
            </div>
        </div>

        <!-- Quick Links -->
        <div class="links-section">
            <div class="section-title">快速访问</div>
            <div class="links-grid">
                <a href="/v1/models" class="link-card">
                    <span class="link-icon">🤖</span>
                    <div class="link-title">模型列表</div>
                    <div class="link-desc">探索全部8个GLM系列AI模型及其能力</div>
                    <span class="link-arrow">查看模型 →</span>
                </a>

                <a href="/docs" class="link-card">
                    <span class="link-icon">📚</span>
                    <div class="link-title">API 文档</div>
                    <div class="link-desc">完整的集成指南、代码示例和最佳实践</div>
                    <span class="link-arrow">阅读文档 →</span>
                </a>

                <a href="/dashboard" class="link-card">
                    <span class="link-icon">📊</span>
                    <div class="link-title">监控看板</div>
                    <div class="link-desc">实时API调用统计、性能指标和错误追踪</div>
                    <span class="link-arrow">打开看板 →</span>
                </a>

                <a href="/v1/chat/completions" class="link-card highlight">
                    <span class="link-icon">⚡</span>
                    <div class="link-title">快速测试</div>
                    <div class="link-desc">直接在浏览器中体验AI对话能力</div>
                    <span class="link-arrow" style="color: var(--accent-pink);">立即试用 →</span>
                </a>
            </div>
        </div>

        <!-- Features Section -->
        <div class="features-section">
            <div class="section-title">核心能力</div>
            <div class="features-grid">
                <div class="feature-item">
                    <span class="feature-icon">🔄</span>
                    <div class="feature-title">Token 池管理</div>
                    <div class="feature-desc">多Token轮换，自动故障切换，99.9%可用性</div>
                </div>

                <div class="feature-item">
                    <span class="feature-icon">🌊</span>
                    <div class="feature-title">SSE 流式传输</div>
                    <div class="feature-desc">实时逐token输出，毫秒级首字节响应</div>
                </div>

                <div class="feature-item">
                    <span class="feature-icon">🔐</span>
                    <div class="feature-title">双层HMAC签名</div>
                    <div class="feature-desc">企业级安全，时间窗口验证，密钥可配置</div>
                </div>

                <div class="feature-item">
                    <span class="feature-icon">🎯</span>
                    <div class="feature-title">全方位多模态</div>
                    <div class="feature-desc">图像、视频、文档、音频，GLM-4.5V/4.6V支持</div>
                </div>

                <div class="feature-item">
                    <span class="feature-icon">🧠</span>
                    <div class="feature-title">智能思考展示</div>
                    <div class="feature-desc">完整展现AI推理过程，支持GLM-4.6/4.7/5系列</div>
                </div>

                <div class="feature-item">
                    <span class="feature-icon">🔍</span>
                    <div class="feature-title">MCP 工具调用</div>
                    <div class="feature-desc">深度搜索、编程助手、PPT生成等高级功能</div>
                </div>
            </div>
        </div>

        <!-- Footer -->
        <footer>
            <div class="footer-text">
                Powered by <a href="https://deno.land" class="footer-link">Deno</a> &
                <a href="https://chat.z.ai" class="footer-link">Z.ai GLM</a> •
                v2.1 Enterprise Edition
            </div>
        </footer>
    </div>

    <script>
        // Generate floating particles
        function generateParticles() {
            const particlesContainer = document.getElementById('particles');
            if (!particlesContainer) return;
            particlesContainer.innerHTML = '';
            const particleCount = 30;

            for (let i = 0; i < particleCount; i++) {
                const particle = document.createElement('div');
                particle.className = 'particle';
                particle.style.left = Math.random() * 100 + '%';
                particle.style.animationDelay = Math.random() * 15 + 's';
                particle.style.animationDuration = (10 + Math.random() * 10) + 's';
                particlesContainer.appendChild(particle);
            }
        }

        // Typing effect for subtitle
        function animateSubtitle() {
            const subtitle = document.querySelector('.subtitle');
            if (!subtitle) return;
            const text = subtitle.textContent;
            subtitle.textContent = '';
            let i = 0;

            function typeWriter() {
                if (i < text.length) {
                    subtitle.textContent += text.charAt(i);
                    i++;
                    setTimeout(typeWriter, 50);
                }
            }

            setTimeout(typeWriter, 500);
        }

        // Counter animation
        function animateCounter() {
            const counter = document.querySelector('.counter');
            if (!counter) return;
            let count = 0;
            const target = 8;

            function animate() {
                if (count < target) {
                    count++;
                    counter.textContent = count;
                    setTimeout(animate, 100);
                }
            }

            setTimeout(animate, 1000);
        }

        // Scroll reveal animation
        function observeScrollReveal() {
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        entry.target.style.opacity = '1';
                        entry.target.style.transform = 'translateY(0)';
                    }
                });
            }, { threshold: 0.1 });

            document.querySelectorAll('.feature-item').forEach(item => {
                item.style.opacity = '0';
                item.style.transform = 'translateY(20px)';
                item.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
                observer.observe(item);
            });
        }

        // Initialize
        function init() {
            generateParticles();
            animateCounter();
            animateSubtitle();
            observeScrollReveal();
        }

        // Start everything
        init();
    </script>
            zh: {
                brand: 'ZtoApi',
                hero_title: 'AI GATEWAY',
                hero_subtitle: 'OpenAI 兼容的下一代 GLM 模型代理服务',
                models_available: '个 AI 模型在线',
                stat_api_version: 'API 版本',
                stat_compatibility: 'OpenAI 兼容',
                stat_latency: '平均延迟',
                section_quick_access: '快速访问',
                link_models: '模型列表',
                link_models_desc: '探索全部8个GLM系列AI模型及其能力',
                view_models: '查看模型 →',
                link_docs: 'API 文档',
                link_docs_desc: '完整的集成指南、代码示例和最佳实践',
                read_docs: '阅读文档 →',
                link_dashboard: '监控看板',
                link_dashboard_desc: '实时API调用统计、性能指标和错误追踪',
                open_dashboard: '打开看板 →',
                link_quick_test: '快速测试',
                link_quick_test_desc: '直接在浏览器中体验AI对话能力',
                try_now: '立即试用 →',
                section_core_features: '核心能力',
                feature_token_pool: 'Token 池管理',
                feature_token_pool_desc: '多Token轮换，自动故障切换，99.9%可用性',
                feature_sse: 'SSE 流式传输',
                feature_sse_desc: '实时逐token输出，毫秒级首字节响应',
                feature_hmac: '双层HMAC签名',
                feature_hmac_desc: '企业级安全，时间窗口验证，密钥可配置',
                feature_multimodal: '全方位多模态',
                feature_multimodal_desc: '图像、视频、文档、音频，GLM-4.5V/4.6V支持',
                feature_thinking: '智能思考展示',
                feature_thinking_desc: '完整展现AI推理过程，支持GLM-4.6/4.7/5系列',
                feature_mcp: 'MCP 工具调用',
                feature_mcp_desc: '深度搜索、编程助手、PPT生成等高级功能',
                theme_dark: '暗黑',
                theme_light: '白天'
            },
            en: {
                brand: 'ZtoApi',
                hero_title: 'AI GATEWAY',
                hero_subtitle: 'OpenAI-compatible next-gen GLM model proxy service',
                models_available: ' AI models online',
                stat_api_version: 'API Version',
                stat_compatibility: 'OpenAI Compatible',
                stat_latency: 'Avg Latency',
                section_quick_access: 'Quick Access',
                link_models: 'Models',
                link_models_desc: 'Explore all 8 GLM series AI models and capabilities',
                view_models: 'View Models →',
                link_docs: 'API Docs',
                link_docs_desc: 'Complete integration guides, code examples, and best practices',
                read_docs: 'Read Docs →',
                link_dashboard: 'Dashboard',
                link_dashboard_desc: 'Real-time API call statistics, performance metrics, and error tracking',
                open_dashboard: 'Open Dashboard →',
                link_quick_test: 'Quick Test',
                link_quick_test_desc: 'Experience AI conversational capabilities directly in your browser',
                try_now: 'Try Now →',
                section_core_features: 'Core Features',
                feature_token_pool: 'Token Pool',
                feature_token_pool_desc: 'Multi-token rotation with automatic failover, 99.9% availability',
                feature_sse: 'SSE Streaming',
                feature_sse_desc: 'Real-time token-by-token output with millisecond first-byte response',
                feature_hmac: 'Dual-layer HMAC',
                feature_hmac_desc: 'Enterprise-grade security with time-window verification and configurable keys',
                feature_multimodal: 'Multimodal Support',
                feature_multimodal_desc: 'Images, videos, documents, and audio with GLM-4.5V/4.6V support',
                feature_thinking: 'Thinking Display',
                feature_thinking_desc: 'Full AI reasoning process display for GLM-4.6/4.7/5 series',
                feature_mcp: 'MCP Tools',
                feature_mcp_desc: 'Deep search, coding assistant, PPT generation, and more advanced features',
                theme_dark: 'Dark',
                theme_light: 'Light'
            }
        };

        // State
        let currentTheme = localStorage.getItem('theme') || 'dark';
        let currentLang = localStorage.getItem('lang') || 'zh';

        // Initialize
        function init() {
            applyTheme(currentTheme);
            applyLanguage(currentLang);
            updateControls();
            generateParticles();
            animateCounter();
            animateSubtitle();
            observeScrollReveal();
        }

        // Theme Toggle
        function toggleTheme() {
            currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
            localStorage.setItem('theme', currentTheme);
            applyTheme(currentTheme);
            updateControls();
        }

        function applyTheme(theme) {
            document.documentElement.setAttribute('data-theme', theme);
            const themeIcon = document.getElementById('theme-icon');
            const themeText = document.querySelector('#theme-toggle .control-text');
            themeIcon.textContent = theme === 'dark' ? '🌙' : '☀️';
            themeText.textContent = translations[currentLang][theme === 'dark' ? 'theme_dark' : 'theme_light'];
        }

        // Language Toggle
        function toggleLanguage() {
            currentLang = currentLang === 'zh' ? 'en' : 'zh';
            localStorage.setItem('lang', currentLang);
            applyLanguage(currentLang);
        }

        function applyLanguage(lang) {
            const langText = document.querySelector('#lang-toggle .control-text');
            langText.textContent = lang === 'zh' ? 'EN' : '中文';

            // Update all text elements
            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                if (translations[lang] && translations[lang][key])) {
                    el.textContent = translations[lang][key];
                }
            });

            // Update html lang attribute
            document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
        }

        function updateControls() {
            const themeText = document.querySelector('#theme-toggle .control-text');
            themeText.textContent = translations[currentLang][currentTheme === 'dark' ? 'theme_dark' : 'theme_light'];
        }

        // Generate floating particles
        function generateParticles() {
            const particlesContainer = document.getElementById('particles');
            if (!particlesContainer) return;
            particlesContainer.innerHTML = '';
            const particleCount = 30;

            for (let i = 0; i < particleCount; i++) {
                const particle = document.createElement('div');
                particle.className = 'particle';
                particle.style.left = Math.random() * 100 + '%';
                particle.style.animationDelay = Math.random() * 15 + 's';
                particle.style.animationDuration = (10 + Math.random() * 10) + 's';
                particlesContainer.appendChild(particle);
            }
        }

        // Typing effect for subtitle
        function animateSubtitle() {
            const subtitle = document.querySelector('.subtitle');
            if (!subtitle) return;
            const text = subtitle.textContent;
            subtitle.textContent = '';
            let i = 0;

            function typeWriter() {
                if (i < text.length) {
                    subtitle.textContent += text.charAt(i);
                    i++;
                    setTimeout(typeWriter, 50);
                }
            }

            setTimeout(typeWriter, 500);
        }

        // Counter animation
        function animateCounter() {
            const counter = document.querySelector('.counter');
            if (!counter) return;
            let count = 0;
            const target = 8;

            function animate() {
                if (count < target) {
                    count++;
                    counter.textContent = count;
                    setTimeout(animate, 100);
                }
            }

            setTimeout(animate, 1000);
        }

        // Scroll reveal animation
        function observeScrollReveal() {
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        entry.target.style.opacity = '1';
                        entry.target.style.transform = 'translateY(0)';
                    }
                });
            }, { threshold: 0.1 });

            document.querySelectorAll('.feature-item').forEach(item => {
                item.style.opacity = '0';
                item.style.transform = 'translateY(20px)';
                item.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
                observer.observe(item);
            });
        }

        // Start everything
        init();

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Ctrl/Cmd + K for theme toggle
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                toggleTheme();
            }
            // Ctrl/Cmd + L for language toggle
            if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
                e.preventDefault();
                toggleLanguage();
            }
        });
    </script>
</body>
</html>`;
}

async function handleIndex(request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  return new Response(getIndexHTML(), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

async function handleOptions(request: Request): Promise<Response> {
  const headers = new Headers();
  setCORSHeaders(headers);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  return new Response("Not Found", { status: 404, headers });
}

async function handleModels(request: Request): Promise<Response> {
  const headers = new Headers();
  setCORSHeaders(headers);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  // 支持的模型
  const models = SUPPORTED_MODELS.map((model) => ({
    id: model.name,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "z.ai",
  }));

  const response: ModelsResponse = {
    object: "list",
    data: models,
  };

  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(response), {
    status: 200,
    headers,
  });
}

async function handleChatCompletions(request: Request): Promise<Response> {
  const startTime = Date.now();
  const url = new URL(request.url);
  const path = url.pathname;
  const userAgent = request.headers.get("User-Agent") || "";

  debugLog("收到chat completions请求");
  debugLog("🌐 User-Agent: %s", userAgent);

  // Cherry Studio 检测
  const isCherryStudio =
    userAgent.toLowerCase().includes("cherry") ||
    userAgent.toLowerCase().includes("studio");
  if (isCherryStudio) {
    debugLog(
      "🍒 检测到 Cherry Studio 客户端版本: %s",
      userAgent.match(/CherryStudio\/([^\s]+)/)?.[1] || "unknown"
    );
  }

  const headers = new Headers();
  setCORSHeaders(headers);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  // 验证API Key
  const authHeader = request.headers.get("Authorization");
  if (!validateApiKey(authHeader)) {
    debugLog("缺少或无效的Authorization头");
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 401);
    addLiveRequest(request.method, path, 401, duration, userAgent);
    return new Response("Missing or invalid Authorization header", {
      status: 401,
      headers,
    });
  }

  debugLog("API key验证通过");

  // 读取请求体
  let body: string;
  try {
    body = await request.text();
    debugLog("📥 收到请求体长度: %d 字符", body.length);

    // 为Cherry Studio调试：记录原始请求体（截取前1000字符避免日志过长）
    const bodyPreview =
      body.length > 1000 ? body.substring(0, 1000) + "..." : body;
    debugLog("📄 请求体预览: %s", bodyPreview);
  } catch (error) {
    debugLog("读取请求体失败: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 400);
    addLiveRequest(request.method, path, 400, duration, userAgent);
    return new Response("Failed to read request body", {
      status: 400,
      headers,
    });
  }

  // 解析请求
  let req: OpenAIRequest;
  try {
    req = JSON.parse(body) as OpenAIRequest;
    debugLog("✅ JSON解析成功");
  } catch (error) {
    debugLog("JSON解析失败: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 400);
    addLiveRequest(request.method, path, 400, duration, userAgent);
    return new Response("Invalid JSON", {
      status: 400,
      headers,
    });
  }

  // 如果客户端没有明确指定stream参数，使用默认值
  if (!body.includes('"stream"')) {
    req.stream = DEFAULT_STREAM;
    debugLog("客户端未指定stream参数，使用默认值: %v", DEFAULT_STREAM);
  }

  // 获取模型配置
  const modelConfig = getModelConfig(req.model);
  debugLog(
    "请求解析成功 - 模型: %s (%s), 流式: %v, 消息数: %d",
    req.model,
    modelConfig.name,
    req.stream,
    req.messages.length
  );

  // Cherry Studio 调试：详细检查每条消息
  debugLog("🔍 Cherry Studio 调试 - 检查原始消息:");
  for (let i = 0; i < req.messages.length; i++) {
    const msg = req.messages[i];
    debugLog("  消息[%d] role: %s", i, msg.role);

    if (typeof msg.content === "string") {
      debugLog(
        "  消息[%d] content: 字符串类型, 长度: %d",
        i,
        msg.content.length
      );
      if (msg.content.length === 0) {
        debugLog("  ⚠️  消息[%d] 内容为空字符串!", i);
      } else {
        debugLog("  消息[%d] 内容预览: %s", i, msg.content.substring(0, 100));
      }
    } else if (Array.isArray(msg.content)) {
      debugLog("  消息[%d] content: 数组类型, 块数: %d", i, msg.content.length);
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        debugLog("    块[%d] type: %s", j, block.type);
        if (block.type === "text" && block.text) {
          debugLog("    块[%d] text: %s", j, block.text.substring(0, 50));
        } else if (block.type === "image_url" && block.image_url?.url) {
          debugLog(
            "    块[%d] image_url: %s格式, 长度: %d",
            j,
            block.image_url.url.startsWith("data:") ? "base64" : "url",
            block.image_url.url.length
          );
        }
      }
    } else {
      debugLog("  ⚠️  消息[%d] content 类型异常: %s", i, typeof msg.content);
    }
  }

  // 检测模型高级能力
  const capabilities = ModelCapabilityDetector.detectCapabilities(
    req.model,
    req.reasoning
  );
  debugLog("模型能力检测: 思考=%s, 搜索=%s, 高级搜索=%s, 视觉=%s, MCP=%s",
    capabilities.thinking, capabilities.search, capabilities.advancedSearch,
    capabilities.vision, capabilities.mcp);

  // 处理和验证消息（特别是多模态内容）
  const processedMessages = processMessages(req.messages, modelConfig);
  debugLog("消息处理完成，处理后消息数: %d", processedMessages.length);

  // 使用 Token 池获取 token
  let authToken: string;
  try {
    authToken = await tokenPool.getToken();
    debugLog("Token 获取成功: %s...", authToken.substring(0, 10));
  } catch (error) {
    debugLog("Token 获取失败: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 500);
    addLiveRequest(request.method, path, 500, duration, userAgent);
    return new Response("Failed to get authentication token", {
      status: 500,
      headers,
    });
  }

  // 检查是否包含多模态内容并使用新的图像处理器
  const hasMultimodal = ImageProcessor.hasImageContent(req.messages);
  let finalMessages = processedMessages;
  let uploadedFiles: UploadedFile[] = [];

  if (hasMultimodal) {
    debugLog("🎯 检测到图像内容，开始处理，模型: %s", modelConfig.name);

    // 检查匿名 Token 限制
    if (tokenPool.isAnonymousToken(authToken)) {
      debugLog("❌ 匿名 Token 不支持图像处理功能");
      const duration = Date.now() - startTime;
      recordRequestStats(startTime, path, 400);
      addLiveRequest(request.method, path, 400, duration, userAgent);
      return new Response("匿名Token不支持图像处理功能，请配置ZAI_TOKEN环境变量", {
        status: 400,
        headers,
      });
    }

    if (!capabilities.vision) {
      debugLog("❌ 严重错误: 模型不支持多模态，但收到了图像内容！");
      debugLog(
        "💡 Cherry Studio用户请检查: 确认选择了 'glm-4.5v' 而不是 'GLM-4.5'"
      );
      debugLog(
        "🔧 模型映射状态: %s → %s (vision: %s)",
        req.model,
        modelConfig.upstreamId,
        capabilities.vision
      );
    } else {
      debugLog("✅ 使用高级图像处理器处理图像内容");

      try {
        // 使用新的图像处理器
        const imageProcessResult = await ImageProcessor.processImages(
          req.messages,
          authToken,
          capabilities.vision
        );

        finalMessages = imageProcessResult.processedMessages;
        uploadedFiles = imageProcessResult.uploadedFiles;

        debugLog("图像处理完成: 处理后消息数=%d, 上传文件数=%d",
          finalMessages.length, uploadedFiles.length);

      } catch (error) {
        debugLog("图像处理失败: %v", error);
        const duration = Date.now() - startTime;
        recordRequestStats(startTime, path, 500);
        addLiveRequest(request.method, path, 500, duration, userAgent);
        return new Response("图像处理失败", {
          status: 500,
          headers,
        });
      }
    }
  } else if (capabilities.vision && modelConfig.id === "glm-4.5v") {
    debugLog("ℹ️ 使用GLM-4.5V模型但未检测到图像数据，仅处理文本内容");
  }

  // 生成会话相关ID
  const chatID = `${Date.now()}-${Math.floor(Date.now() / 1000)}`;
  const msgID = Date.now().toString();

  // 获取模型对应的 MCP 服务器列表
  const mcpServers = ModelCapabilityDetector.getMCPServersForModel(capabilities);
  const hiddenMcpFeatures = ModelCapabilityDetector.getHiddenMCPFeatures();

  // 提取用户最后消息内容（用于签名）
  const lastUserContent = ImageProcessor.extractLastUserContent(req.messages);

  // 构造上游请求（增强版）
  const upstreamReq: UpstreamRequest = {
    stream: true, // 总是使用流式从上游获取
    chat_id: chatID,
    id: msgID,
    model: modelConfig.upstreamId,
    messages: finalMessages,
    params: modelConfig.defaultParams,
    features: {
      image_generation: false,
      web_search: capabilities.search || capabilities.advancedSearch,
      auto_web_search: capabilities.search || capabilities.advancedSearch,
      preview_mode: capabilities.search || capabilities.advancedSearch,
      flags: [],
      features: hiddenMcpFeatures,
      enable_thinking: capabilities.thinking,
    },
    background_tasks: {
      title_generation: false,
      tags_generation: false,
    },
    mcp_servers: mcpServers,
    model_item: {
      id: modelConfig.upstreamId,
      name: req.model, // 使用原始请求的模型名
      owned_by: "openai",
      openai: {
        id: modelConfig.upstreamId,
        name: modelConfig.upstreamId,
        owned_by: "openai",
        openai: {
          id: modelConfig.upstreamId,
        },
        urlIdx: 1,
      },
      urlIdx: 1,
      info: {
        id: modelConfig.upstreamId,
        user_id: "api-user",
        base_model_id: null,
        name: modelConfig.name,
        params: modelConfig.defaultParams,
        meta: {
          profile_image_url: "/static/favicon.png",
          description: capabilities.vision
            ? "Advanced visual understanding and analysis"
            : capabilities.thinking
            ? "Advanced reasoning and thinking model"
            : capabilities.search
            ? "Web search enhanced model"
            : "Most advanced model, proficient in coding and tool use",
          capabilities: {
            vision: capabilities.vision,
            citations: false,
            preview_mode: capabilities.search || capabilities.advancedSearch,
            web_search: capabilities.search || capabilities.advancedSearch,
            language_detection: false,
            restore_n_source: false,
            mcp: capabilities.mcp,
            file_qa: capabilities.mcp,
            returnFc: true,
            returnThink: capabilities.thinking,
            think: capabilities.thinking,
          },
        },
      },
    },
    tool_servers: [],
    variables: {
      "{{USER_NAME}}": `Guest-${Date.now()}`,
      "{{USER_LOCATION}}": "Unknown",
      "{{CURRENT_DATETIME}}": new Date().toLocaleString("zh-CN"),
      "{{CURRENT_DATE}}": new Date().toLocaleDateString("zh-CN"),
      "{{CURRENT_TIME}}": new Date().toLocaleTimeString("zh-CN"),
      "{{CURRENT_WEEKDAY}}": new Date().toLocaleDateString("zh-CN", {
        weekday: "long",
      }),
      "{{CURRENT_TIMEZONE}}": "Asia/Shanghai",
      "{{USER_LANGUAGE}}": "zh-CN",
    },
    // 添加文件列表（如果有上传的图像）
    ...(uploadedFiles.length > 0 && !capabilities.vision ? { files: uploadedFiles } : {}),
    // 添加签名提示
    signature_prompt: lastUserContent,
  };

  // 调用上游API
  try {
    if (req.stream) {
      return await handleStreamResponse(
        upstreamReq,
        chatID,
        authToken,
        startTime,
        path,
        userAgent,
        req,
        modelConfig
      );
    } else {
      return await handleNonStreamResponse(
        upstreamReq,
        chatID,
        authToken,
        startTime,
        path,
        userAgent,
        req,
        modelConfig
      );
    }
  } catch (error) {
    debugLog("调用上游失败: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 502);
    addLiveRequest(request.method, path, 502, duration, userAgent);
    return new Response("Failed to call upstream", {
      status: 502,
      headers,
    });
  }
}

async function handleStreamResponse(
  upstreamReq: UpstreamRequest,
  chatID: string,
  authToken: string,
  startTime: number,
  path: string,
  userAgent: string,
  req: OpenAIRequest,
  modelConfig: ModelConfig
): Promise<Response> {
  debugLog("开始处理流式响应 (chat_id=%s)", chatID);

  try {
    const response = await callUpstreamWithHeaders(
      upstreamReq,
      chatID,
      authToken
    );

    if (!response.ok) {
      debugLog("上游返回错误状态: %d", response.status);
      const duration = Date.now() - startTime;
      recordRequestStats(startTime, path, 502);
      addLiveRequest("POST", path, 502, duration, userAgent);
      return new Response("Upstream error", { status: 502 });
    }

    if (!response.body) {
      debugLog("上游响应体为空");
      const duration = Date.now() - startTime;
      recordRequestStats(startTime, path, 502);
      addLiveRequest("POST", path, 502, duration, userAgent);
      return new Response("Upstream response body is empty", { status: 502 });
    }

    // 创建可读流
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // 发送第一个chunk（role）
    const firstChunk: OpenAIResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant" },
        },
      ],
    };

    // 写入第一个chunk
    writer.write(encoder.encode(`data: ${JSON.stringify(firstChunk)}\n\n`));

    // 处理上游SSE流
    processUpstreamStream(response.body, writer, encoder, req.model).catch(
      (error) => {
        debugLog("处理上游流时出错: %v", error);
      }
    );

    // 记录成功请求统计
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 200);
    addLiveRequest("POST", path, 200, duration, userAgent, modelConfig.name);

    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Credentials": "true",
      },
    });
  } catch (error) {
    debugLog("处理流式响应时出错: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 502);
    addLiveRequest("POST", path, 502, duration, userAgent);
    return new Response("Failed to process stream response", { status: 502 });
  }
}

async function handleNonStreamResponse(
  upstreamReq: UpstreamRequest,
  chatID: string,
  authToken: string,
  startTime: number,
  path: string,
  userAgent: string,
  req: OpenAIRequest,
  modelConfig: ModelConfig
): Promise<Response> {
  debugLog("开始处理非流式响应 (chat_id=%s)", chatID);

  try {
    const response = await callUpstreamWithHeaders(
      upstreamReq,
      chatID,
      authToken
    );

    if (!response.ok) {
      debugLog("上游返回错误状态: %d", response.status);
      const duration = Date.now() - startTime;
      recordRequestStats(startTime, path, 502);
      addLiveRequest("POST", path, 502, duration, userAgent);
      return new Response("Upstream error", { status: 502 });
    }

    if (!response.body) {
      debugLog("上游响应体为空");
      const duration = Date.now() - startTime;
      recordRequestStats(startTime, path, 502);
      addLiveRequest("POST", path, 502, duration, userAgent);
      return new Response("Upstream response body is empty", { status: 502 });
    }

    // 收集完整响应
    const finalContent = await collectFullResponse(response.body);
    debugLog("内容收集完成，最终长度: %d", finalContent.length);

    // 构造完整响应
    const openAIResponse: OpenAIResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: finalContent,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };

    // 记录成功请求统计
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 200);
    addLiveRequest("POST", path, 200, duration, userAgent, modelConfig.name);

    return new Response(JSON.stringify(openAIResponse), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Credentials": "true",
      },
    });
  } catch (error) {
    debugLog("处理非流式响应时出错: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 502);
    addLiveRequest("POST", path, 502, duration, userAgent);
    return new Response("Failed to process non-stream response", {
      status: 502,
    });
  }
}

/**
 * 生成 Dashboard 监控页面HTML模板
 * 提供实时API调用监控和统计信息展示
 * @returns string 完整的HTML页面内容
 */
function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API调用看板</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Space+Grotesk:wght@300;500;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-primary: #0a0a0f;
            --bg-secondary: #13131a;
            --bg-card: rgba(19, 19, 26, 0.8);
            --bg-card-hover: rgba(19, 19, 26, 0.95);
            --accent-cyan: #00fff5;
            --accent-purple: #b94fff;
            --accent-pink: #ff00aa;
            --accent-green: #00ff88;
            --text-primary: #ffffff;
            --text-secondary: #a0a0c0;
            --text-muted: #6b7280;
            --border-glow: rgba(0, 255, 245, 0.3);
            --border-subtle: rgba(255, 255, 255, 0.1);
            --shadow-glow: 0 20px 40px rgba(0, 255, 245, 0.15);
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            overflow-x: hidden;
            min-height: 100vh;
            transition: background 0.5s ease, color 0.5s ease;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 60px 40px;
        }

        h1 {
            font-size: clamp(2.5rem, 5vw, 4rem);
            font-weight: 700;
            line-height: 1.1;
            margin-bottom: 40px;
            text-align: center;
            background: linear-gradient(135deg, var(--text-primary) 0%, var(--accent-cyan) 50%, var(--accent-purple) 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            letter-spacing: -2px;
        }
        .stats-container {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 30px;
            margin-bottom: 60px;
        }

        .stat-card {
            background: var(--bg-card);
            border: 1px solid var(--border-subtle);
            border-radius: 16px;
            padding: 30px;
            text-align: center;
            position: relative;
            overflow: hidden;
            transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }

        .stat-card::before {
            content: '';
            position: absolute;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background: radial-gradient(circle, var(--accent-cyan) 0%, transparent 70%);
            opacity: 0;
            transition: opacity 0.4s;
            pointer-events: none;
        }

        .stat-card:hover::before {
            opacity: 0.1;
        }

        .stat-card:hover {
            transform: translateY(-8px) scale(1.02);
            border-color: var(--border-glow);
            box-shadow: var(--shadow-glow);
        }

        .stat-value {
            font-size: 3rem;
            font-weight: 700;
            font-family: 'JetBrains Mono', monospace;
            background: linear-gradient(135deg, var(--accent-cyan), var(--accent-purple));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 8px;
        }

        .stat-label {
            font-size: 0.9rem;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 2px;
        }

        .chart-container {
            margin-top: 30px;
            height: 350px;
            background: var(--bg-card);
            border: 1px solid var(--border-subtle);
            border-radius: 16px;
            padding: 25px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
        }

        .chart-container h2 {
            color: var(--accent-cyan);
            font-size: 1.2rem;
            margin-bottom: 20px;
        }

        .requests-container {
            margin-top: 60px;
        }

        .requests-container h2 {
            color: var(--text-primary);
            font-size: 1.8rem;
            margin-bottom: 25px;
        }

        .requests-table {
            width: 100%;
            border-collapse: collapse;
            background: var(--bg-card);
            border-radius: 12px;
            overflow: hidden;
        }

        .requests-table th {
            background: var(--bg-secondary);
            color: var(--accent-cyan);
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
            font-size: 0.85rem;
        }

        .requests-table th, .requests-table td {
            padding: 16px 12px;
            text-align: left;
            border-bottom: 1px solid var(--border-subtle);
        }

        .requests-table tr:hover {
            background: var(--bg-card-hover);
        }

        .status-success {
            color: var(--accent-green);
            font-weight: 600;
        }

        .status-error {
            color: var(--accent-pink);
            font-weight: 600;
        }

        .pagination-container {
            display: flex;
            justify-content: center;
            align-items: center;
            margin-top: 30px;
            gap: 15px;
        }

        .pagination-container button {
            padding: 10px 20px;
            background: var(--accent-cyan);
            color: var(--bg-primary);
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            transition: all 0.3s ease;
        }

        .pagination-container button:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: 0 8px 16px rgba(0, 255, 245, 0.3);
        }

        .pagination-container button:disabled {
            background: var(--bg-secondary);
            color: var(--text-muted);
            cursor: not-allowed;
            opacity: 0.5;
        }

        #page-info {
            color: var(--text-secondary);
            font-size: 0.95rem;
        }

        .refresh-info {
            text-align: center;
            margin-top: 40px;
            padding: 20px;
            color: var(--text-muted);
            font-size: 0.9rem;
            border-top: 1px solid var(--border-subtle);
        }

        /* Responsive */
        @media (max-width: 768px) {
            .container {
                padding: 40px 20px;
            }

            .stats-container {
                grid-template-columns: 1fr;
            }

            h1 {
                font-size: 2.5rem;
            }

            .requests-table {
                font-size: 0.85rem;
            }

            .pagination-container {
                gap: 8px;
            }

            .pagination-container button {
                padding: 8px 14px;
                font-size: 0.85rem;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>API 调用看板</h1>
        
        <div class="stats-container">
            <div class="stat-card">
                <div class="stat-value" id="total-requests">0</div>
                <div class="stat-label">总请求数</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="successful-requests">0</div>
                <div class="stat-label">成功请求</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="failed-requests">0</div>
                <div class="stat-label">失败请求</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="avg-response-time">0s</div>
                <div class="stat-label">平均响应时间</div>
            </div>
        </div>
        
        <div class="chart-container">
            <h2>请求统计图表</h2>
            <canvas id="requestsChart"></canvas>
        </div>
        
        <div class="requests-container">
            <h2>实时请求</h2>
            <table class="requests-table">
                <thead>
                    <tr>
                        <th>时间</th>
                        <th>模型</th>
                        <th>方法</th>
                        <th>状态</th>
                        <th>耗时</th>
                        <th>User Agent</th>
                    </tr>
                </thead>
                <tbody id="requests-tbody">
                    <!-- 请求记录将通过JavaScript动态添加 -->
                </tbody>
            </table>
            <div class="pagination-container">
                <button id="prev-page" disabled>上一页</button>
                <span id="page-info">第 1 页，共 1 页</span>
                <button id="next-page" disabled>下一页</button>
            </div>
        </div>
        
        <div class="refresh-info">
            数据每5秒自动刷新一次
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script>
        // 全局变量
        let allRequests = [];
        let currentPage = 1;
        const itemsPerPage = 10;
        let requestsChart = null;
        
        // 更新统计数据
        function updateStats() {
            fetch('/dashboard/stats')
                .then(response => response.json())
                .then(data => {
                    document.getElementById('total-requests').textContent = data.totalRequests || 0;
                    document.getElementById('successful-requests').textContent = data.successfulRequests || 0;
                    document.getElementById('failed-requests').textContent = data.failedRequests || 0;
                    document.getElementById('avg-response-time').textContent = ((data.averageResponseTime || 0) / 1000).toFixed(2) + 's';
                })
                .catch(error => console.error('Error fetching stats:', error));
        }
        
        // 更新请求列表
        function updateRequests() {
            fetch('/dashboard/requests')
                .then(response => response.json())
                .then(data => {
                    // 检查数据是否为数组
                    if (!Array.isArray(data)) {
                        console.error('返回的数据不是数组:', data);
                        return;
                    }
                    
                    // 保存所有请求数据
                    allRequests = data;
                    
                    // 按时间倒序排列
                    allRequests.sort((a, b) => {
                        const timeA = new Date(a.timestamp);
                        const timeB = new Date(b.timestamp);
                        return timeB - timeA;
                    });
                    
                    // 更新表格
                    updateTable();
                    
                    // 更新图表
                    updateChart();
                    
                    // 更新分页信息
                    updatePagination();
                })
                .catch(error => console.error('Error fetching requests:', error));
        }
        
        // 更新表格显示
        function updateTable() {
            const tbody = document.getElementById('requests-tbody');
            tbody.innerHTML = '';
            
            // 计算当前页的数据范围
            const startIndex = (currentPage - 1) * itemsPerPage;
            const endIndex = startIndex + itemsPerPage;
            const currentRequests = allRequests.slice(startIndex, endIndex);
            
            currentRequests.forEach(request => {
                const row = document.createElement('tr');
                
                // 格式化时间 - 检查时间戳是否有效
                let timeStr = "Invalid Date";
                if (request.timestamp) {
                    try {
                        const time = new Date(request.timestamp);
                        if (!isNaN(time.getTime())) {
                            timeStr = time.toLocaleTimeString();
                        }
                    } catch (e) {
                        console.error("时间格式化错误:", e);
                    }
                }
                
                // 判断模型名称
                let modelName = "GLM-4.5";
                if (request.path && request.path.includes('glm-4.5v')) {
                    modelName = "GLM-4.5V";
                } else if (request.model) {
                    modelName = request.model;
                }
                
                // 状态样式
                const statusClass = request.status >= 200 && request.status < 300 ? 'status-success' : 'status-error';
                const status = request.status || "undefined";
                
                // 截断 User Agent，避免过长
                let userAgent = request.user_agent || "undefined";
                if (userAgent.length > 30) {
                    userAgent = userAgent.substring(0, 30) + "...";
                }
                
                row.innerHTML = "<td>" + timeStr + "</td>" + "<td>" + modelName + "</td>" + "<td>" + (request.method || "undefined") + "</td>" + "<td class='" + statusClass + "'>" + status + "</td>" + "<td>" + ((request.duration / 1000).toFixed(2) || "undefined") + "s</td>" + "<td title='" + (request.user_agent || "") + "'>" + userAgent + "</td>";
                
                tbody.appendChild(row);
            });
        }
        
        // 更新分页信息
        function updatePagination() {
            const totalPages = Math.ceil(allRequests.length / itemsPerPage);
            document.getElementById('page-info').textContent = "第 " + currentPage + " 页，共 " + totalPages + " 页";
            
            document.getElementById('prev-page').disabled = currentPage <= 1;
            document.getElementById('next-page').disabled = currentPage >= totalPages;
        }
        
        // 更新图表
        function updateChart() {
            const ctx = document.getElementById('requestsChart').getContext('2d');
            
            // 准备图表数据 - 最近20条请求的响应时间
            const chartData = allRequests.slice(0, 20).reverse();
            const labels = chartData.map(req => {
                const time = new Date(req.timestamp);
                return time.toLocaleTimeString();
            });
            const responseTimes = chartData.map(req => req.duration);
            
            // 如果图表已存在，先销毁
            if (requestsChart) {
                requestsChart.destroy();
            }
            
            // 创建新图表
            requestsChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: '响应时间 (s)',
                        data: responseTimes.map(time => time / 1000),
                        borderColor: '#00fff5',
                        backgroundColor: 'rgba(0, 255, 245, 0.1)',
                        tension: 0.1,
                        fill: true
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            grid: {
                                color: 'rgba(255, 255, 255, 0.1)',
                                drawBorder: false
                            },
                            ticks: {
                                color: '#a0a0c0',
                                font: {
                                    family: 'JetBrains Mono'
                                }
                            },
                            title: {
                                display: true,
                                text: '响应时间 (s)',
                                color: '#00fff5',
                                font: {
                                    family: 'Space Grotesk',
                                    weight: '500'
                                }
                            }
                        },
                        x: {
                            grid: {
                                color: 'rgba(255, 255, 255, 0.05)',
                                drawBorder: false
                            },
                            ticks: {
                                color: '#a0a0c0',
                                font: {
                                    family: 'JetBrains Mono'
                                }
                            },
                            title: {
                                display: true,
                                text: '时间',
                                color: '#00fff5',
                                font: {
                                    family: 'Space Grotesk',
                                    weight: '500'
                                }
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            display: false
                        },
                        title: {
                            display: true,
                            text: '最近20条请求的响应时间趋势',
                            color: '#ffffff',
                            font: {
                                family: 'Space Grotesk',
                                size: 14,
                                weight: '700'
                            },
                            padding: {
                                bottom: 20
                            }
                        }
                    }
                }
            });
        }
        
        // 分页按钮事件
        document.getElementById('prev-page').addEventListener('click', function() {
            if (currentPage > 1) {
                currentPage--;
                updateTable();
                updatePagination();
            }
        });
        
        document.getElementById('next-page').addEventListener('click', function() {
            const totalPages = Math.ceil(allRequests.length / itemsPerPage);
            if (currentPage < totalPages) {
                currentPage++;
                updateTable();
                updatePagination();
            }
        });
        
        // 初始加载
        updateStats();
        updateRequests();
        
        // 定时刷新
        setInterval(updateStats, 5000);
        setInterval(updateRequests, 5000);
    </script>
</body>
</html>`;
}

/**
 * 处理 Dashboard 监控页面请求
 * 返回实时监控面板的HTML页面
 * @param request HTTP请求对象
 * @returns Promise<Response> HTML响应
 */
async function handleDashboard(request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  return new Response(getDashboardHTML(), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

// 处理Dashboard统计数据
async function handleDashboardStats(_request: Request): Promise<Response> {
  return new Response(getStatsData(), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

async function handleDashboardRequests(_request: Request): Promise<Response> {
  return new Response(getLiveRequestsData(), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function getDocsHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ZtoApi 文档</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Space+Grotesk:wght@300;500;700&display=swap" rel="stylesheet">
<style>
    :root {
        --bg-primary: #0a0a0f;
        --bg-secondary: #13131a;
        --bg-card: rgba(19, 19, 26, 0.8);
        --bg-card-hover: rgba(19, 19, 26, 0.95);
        --accent-cyan: #00fff5;
        --accent-purple: #b94fff;
        --accent-pink: #ff00aa;
        --accent-green: #00ff88;
        --text-primary: #ffffff;
        --text-secondary: #a0a0c0;
        --text-muted: #6b7280;
        --border-glow: rgba(0, 255, 245, 0.3);
        --border-subtle: rgba(255, 255, 255, 0.1);
        --shadow-glow: 0 20px 40px rgba(0, 255, 245, 0.15);
    }

    * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
    }

    body {
        font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif;
        background: var(--bg-primary);
        color: var(--text-primary);
        line-height: 1.7;
        padding: 40px 20px;
        min-height: 100vh;
    }

    .container {
        max-width: 1200px;
        margin: 0 auto;
        background: var(--bg-card);
        border-radius: 16px;
        box-shadow: var(--shadow-glow);
        padding: 50px;
        border: 1px solid var(--border-subtle);
    }

    h1 {
        font-size: clamp(2.5rem, 6vw, 4rem);
        font-weight: 700;
        line-height: 1.1;
        margin-bottom: 40px;
        text-align: center;
        background: linear-gradient(135deg, var(--text-primary) 0%, var(--accent-cyan) 50%, var(--accent-purple) 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
        letter-spacing: -2px;
    }

    h2 {
        color: var(--accent-cyan);
        margin-top: 50px;
        margin-bottom: 25px;
        font-size: 1.8rem;
        font-weight: 600;
        letter-spacing: 1px;
        text-transform: uppercase;
    }

    h3 {
        color: var(--text-primary);
        margin-top: 30px;
        margin-bottom: 15px;
        font-size: 1.3rem;
        font-weight: 500;
    }

    .endpoint {
        background: var(--bg-secondary);
        border-radius: 12px;
        padding: 25px;
        margin-bottom: 30px;
        border-left: 4px solid var(--accent-cyan);
        transition: all 0.3s ease;
    }

    .endpoint:hover {
        transform: translateX(5px);
        box-shadow: -5px 5px 20px rgba(0, 255, 245, 0.15);
    }

    .method {
        display: inline-block;
        padding: 6px 12px;
        border-radius: 6px;
        color: white;
        font-weight: 700;
        margin-right: 15px;
        font-size: 0.85rem;
        letter-spacing: 1px;
        text-transform: uppercase;
    }

    .get { background-color: var(--accent-green); }
    .post { background-color: var(--accent-cyan); }

    .path {
        font-family: 'JetBrains Mono', monospace;
        background: var(--bg-card);
        padding: 6px 12px;
        border-radius: 6px;
        font-size: 0.95rem;
        color: var(--accent-purple);
        border: 1px solid var(--border-subtle);
    }

    .description {
        margin: 20px 0;
        color: var(--text-secondary);
        font-size: 1.05rem;
        line-height: 1.6;
    }

    .parameters {
        margin: 25px 0;
    }

    table {
        width: 100%;
        border-collapse: collapse;
        margin: 20px 0;
        background: var(--bg-card);
        border-radius: 12px;
        overflow: hidden;
    }

    th, td {
        padding: 16px;
        text-align: left;
        border-bottom: 1px solid var(--border-subtle);
    }

    th {
        background: var(--bg-secondary);
        color: var(--accent-cyan);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 1px;
        font-size: 0.85rem;
    }

    tr:hover {
        background: var(--bg-card-hover);
    }

    .example {
        background: var(--bg-secondary);
        border-radius: 12px;
        padding: 20px;
        margin: 20px 0;
        font-family: 'JetBrains Mono', monospace;
        white-space: pre-wrap;
        overflow-x: auto;
        border: 1px solid var(--border-subtle);
        color: var(--text-primary);
        font-size: 0.9rem;
        line-height: 1.5;
    }

    code {
        font-family: 'JetBrains Mono', monospace;
        background: rgba(0, 255, 245, 0.1);
        padding: 3px 8px;
        border-radius: 4px;
        color: var(--accent-cyan);
        font-size: 0.9em;
    }

    .note {
        background: rgba(255, 0, 170, 0.1);
        border-left: 4px solid var(--accent-pink);
        padding: 15px 20px;
        margin: 20px 0;
        border-radius: 0 8px 8px 0;
        color: var(--text-primary);
    }

    .response {
        background: var(--bg-secondary);
        border-radius: 12px;
        padding: 20px;
        margin: 20px 0;
        font-family: 'JetBrains Mono', monospace;
        white-space: pre-wrap;
        overflow-x: auto;
        border: 1px solid var(--border-subtle);
        color: var(--accent-green);
        font-size: 0.9rem;
    }

    .tab {
        overflow: hidden;
        border: 1px solid var(--border-subtle);
        background: var(--bg-secondary);
        border-radius: 8px 8px 0 0;
        margin-bottom: 25px;
    }

    .tab button {
        background-color: inherit;
        float: left;
        border: none;
        outline: none;
        cursor: pointer;
        padding: 14px 20px;
        transition: 0.3s;
        font-size: 0.95rem;
        font-weight: 500;
        color: var(--text-secondary);
    }

    .tab button:hover {
        background: var(--bg-card-hover);
        color: var(--accent-cyan);
    }

    .tab button.active {
        background: var(--accent-cyan);
        color: var(--bg-primary);
        font-weight: 600;
    }

    .tabcontent {
        display: none;
        padding: 25px;
        border: 1px solid var(--border-subtle);
        border-top: none;
        border-radius: 0 0 8px 8px;
        background: var(--bg-card);
    }

    .toc {
        background: var(--bg-secondary);
        border-radius: 12px;
        padding: 25px;
        margin-bottom: 40px;
        border: 1px solid var(--border-subtle);
    }

    .toc h2 {
        margin-top: 0;
        color: var(--accent-purple);
        font-size: 1.3rem;
    }

    .toc ul {
        padding-left: 25px;
        list-style: none;
    }

    .toc li {
        margin: 12px 0;
    }

    .toc a {
        color: var(--accent-cyan);
        text-decoration: none;
        font-size: 1.05rem;
        transition: color 0.3s ease;
    }

    .toc a:hover {
        color: var(--accent-purple);
        text-decoration: underline;
    }

    /* Responsive */
    @media (max-width: 768px) {
        body {
            padding: 20px 10px;
        }

        .container {
            padding: 30px 20px;
        }

        h1 {
            font-size: 2rem;
        }

        .endpoint {
            padding: 20px;
        }

        table {
            font-size: 0.85rem;
        }

        .tab button {
            padding: 12px 16px;
            font-size: 0.85rem;
        }
    }
</style>
</head>
<body>
<div class="container">
    <h1>ZtoApi 文档</h1>

    <div class="toc">
        <h2>目录</h2>
        <ul>
            <li><a href="#overview">概述</a></li>
            <li><a href="#models">支持的模型</a></li>
            <li><a href="#authentication">身份验证</a></li>
            <li><a href="#endpoints">API端点</a>
                <ul>
                    <li><a href="#models-list">获取模型列表</a></li>
                    <li><a href="#chat-completions">聊天完成</a></li>
                </ul>
            </li>
            <li><a href="#examples">使用示例</a></li>
            <li><a href="#error-handling">错误处理</a></li>
        </ul>
    </div>

    <section id="overview">
        <h2>概述</h2>
        <p>ZtoApi 是一个高性能的 OpenAI 兼容 API 代理服务器，为 Z.ai 的 GLM 系列模型提供标准化的访问接口。支持流式和非流式响应，提供实时监控面板，并具备企业级的可用性和安全性。</p>
        <p><strong>基础URL:</strong> <code>http://localhost:9090/v1</code></p>
        <div class="note">
            <strong>注意:</strong> 默认端口为9090，可以通过环境变量 PORT 进行修改。
        </div>
    </section>

    <section id="models">
        <h2>支持的模型</h2>
        <p>ZtoApi 支持 Z.ai 的多个先进 AI 模型：</p>
        <table>
            <thead>
                <tr>
                    <th>模型 ID</th>
                    <th>模型名称</th>
                    <th>特性</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><code>0727-360B-API</code></td>
                    <td>GLM-4.5</td>
                    <td>通用对话、代码生成、工具调用、思考过程</td>
                </tr>
                <tr>
                    <td><code>glm-4.6</code></td>
                    <td>GLM-4.6</td>
                    <td>🚀 增强推理、高级代码生成、深度搜索</td>
                </tr>
                <tr>
                    <td><code>glm-4.7</code></td>
                    <td>GLM-4.7</td>
                    <td>🆕 最新推理、更强思考能力、卓越编程</td>
                </tr>
                <tr>
                    <td><code>glm-5</code></td>
                    <td>GLM-5</td>
                    <td>🚀 旗舰模型、全方位能力提升</td>
                </tr>
                <tr>
                    <td><code>glm-4.5v</code></td>
                    <td>GLM-4.5V</td>
                    <td>🎯 全方位多模态：图像、视频、文档、音频</td>
                </tr>
                <tr>
                    <td><code>glm-4.6v</code></td>
                    <td>GLM-4.6V</td>
                    <td>🚀 增强多模态：高级视觉理解</td>
                </tr>
                <tr>
                    <td><code>0727-106B-API</code></td>
                    <td>GLM-4.5-Air</td>
                    <td>⚡ 轻量快速、低延迟响应</td>
                </tr>
                <tr>
                    <td><code>0808-360B-DR</code></td>
                    <td>0808-360B-DR</td>
                    <td>🔬 深度研究专用、长文本分析</td>
                </tr>
            </tbody>
        </table>
        <div class="note">
            <strong>模型说明:</strong> 多模态模型（4.5V、4.6V）支持图像、视频、文档和音频内容处理。其他模型专注于文本对话和推理能力。
        </div>
    </section>

    <section id="authentication">
        <h2>身份验证</h2>
        <p>所有API请求都需要在请求头中包含有效的API密钥进行身份验证：</p>
        <div class="example">
Authorization: Bearer your-api-key</div>
        <p>默认的API密钥为 <code>sk-your-key</code>，可以通过环境变量 <code>DEFAULT_KEY</code> 进行修改。</p>
    </section>
    
    <section id="endpoints">
        <h2>API端点</h2>
        
        <div class="endpoint" id="models-list">
            <h3>获取模型列表</h3>
            <div>
                <span class="method get">GET</span>
                <span class="path">/v1/models</span>
            </div>
            <div class="description">
                <p>获取可用模型列表。</p>
            </div>
            <div class="parameters">
                <h4>请求参数</h4>
                <p>无</p>
            </div>
            <div class="response">
{
  "object": "list",
  "data": [
    {
      "id": "GLM-4.5",
      "object": "model",
      "created": 1756788845,
      "owned_by": "z.ai"
    },
    {
      "id": "GLM-4.5V",
      "object": "model",
      "created": 1756788845,
      "owned_by": "z.ai"
    },
    {
      "id": "GLM-4.6",
      "object": "model",
      "created": 1756788845,
      "owned_by": "z.ai"
    },
    {
      "id": "GLM-4.6V",
      "object": "model",
      "created": 1756788845,
      "owned_by": "z.ai"
    },
    {
      "id": "GLM-4.7",
      "object": "model",
      "created": 1756788845,
      "owned_by": "z.ai"
    },
    {
      "id": "GLM-5",
      "object": "model",
      "created": 1756788845,
      "owned_by": "z.ai"
    },
    {
      "id": "GLM-4.5-Air",
      "object": "model",
      "created": 1756788845,
      "owned_by": "z.ai"
    },
    {
      "id": "GLM-DR",
      "object": "model",
      "created": 1756788845,
      "owned_by": "z.ai"
    }
  ]
}</div>
        </div>
        
        <div class="endpoint" id="chat-completions">
            <h3>聊天完成</h3>
            <div>
                <span class="method post">POST</span>
                <span class="path">/v1/chat/completions</span>
            </div>
            <div class="description">
                <p>基于消息列表生成模型响应。支持流式和非流式两种模式。</p>
            </div>
            <div class="parameters">
                <h4>请求参数</h4>
                <table>
                    <thead>
                        <tr>
                            <th>参数名</th>
                            <th>类型</th>
                            <th>必需</th>
                            <th>说明</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>model</td>
                            <td>string</td>
                            <td>是</td>
                            <td>要使用的模型ID，例如 "GLM-4.5"</td>
                        </tr>
                        <tr>
                            <td>messages</td>
                            <td>array</td>
                            <td>是</td>
                            <td>消息列表，包含角色和内容</td>
                        </tr>
                        <tr>
                            <td>stream</td>
                            <td>boolean</td>
                            <td>否</td>
                            <td>是否使用流式响应，默认为true</td>
                        </tr>
                        <tr>
                            <td>temperature</td>
                            <td>number</td>
                            <td>否</td>
                            <td>采样温度，控制随机性</td>
                        </tr>
                        <tr>
                            <td>max_tokens</td>
                            <td>integer</td>
                            <td>否</td>
                            <td>生成的最大令牌数</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div class="parameters">
                <h4>消息格式</h4>
                <table>
                    <thead>
                        <tr>
                            <th>字段</th>
                            <th>类型</th>
                            <th>说明</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>role</td>
                            <td>string</td>
                            <td>消息角色，可选值：system、user、assistant</td>
                        </tr>
                        <tr>
                            <td>content</td>
                            <td>string</td>
                            <td>消息内容</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    </section>
    
    <section id="examples">
        <h2>使用示例</h2>
        
        <div class="tab">
            <button class="tablinks active" onclick="openTab(event, 'python-tab')">Python</button>
            <button class="tablinks" onclick="openTab(event, 'curl-tab')">cURL</button>
            <button class="tablinks" onclick="openTab(event, 'javascript-tab')">JavaScript</button>
        </div>
        
        <div id="python-tab" class="tabcontent" style="display: block;">
            <h3>Python示例</h3>
            <div class="example">
import openai

# 配置客户端
client = openai.OpenAI(
  api_key="your-api-key",  # 对应 DEFAULT_KEY
  base_url="http://localhost:9090/v1"
)

# 示例 1: 使用旗舰模型 GLM-5 进行复杂推理
response = client.chat.completions.create(
  model="GLM-5",
  messages=[{"role": "user", "content": "分析并优化这段代码的时间复杂度"}]
)
print(response.choices[0].message.content)

# 示例 2: 使用 GLM-4.5-Air 快速响应（适合简单对话）
response = client.chat.completions.create(
  model="GLM-4.5-Air",
  messages=[{"role": "user", "content": "今天天气怎么样？"}]
)
print(response.choices[0].message.content)

# 示例 3: 流式请求 - 使用 GLM-4.7
response = client.chat.completions.create(
  model="GLM-4.7",
  messages=[{"role": "user", "content": "请写一首关于春天的诗"}],
  stream=True
)

for chunk in response:
  if chunk.choices[0].delta.content:
    print(chunk.choices[0].delta.content, end="")

# 示例 4: 使用多模态模型 GLM-4.6V（支持图像）
# response = client.chat.completions.create(
#   model="GLM-4.6V",
#   messages=[{
#     "role": "user",
#     "content": [
#       {"type": "text", "text": "描述这张图片"},
#       {"type": "image_url", "image_url": {"url": "https://example.com/image.jpg"}}
#     ]
#   }]
# )</div>
        </div>
        
        <div id="curl-tab" class="tabcontent">
            <h3>cURL示例</h3>
            <div class="example">
# 示例 1: 使用旗舰模型 GLM-5（复杂任务）
curl -X POST http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "GLM-5",
    "messages": [{"role": "user", "content": "请分析这段代码的性能瓶颈"}],
    "stream": false
  }'

# 示例 2: 使用 GLM-4.5-Air 快速响应（简单对话）
curl -X POST http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "GLM-4.5-Air",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'

# 示例 3: 流式请求 - 使用 GLM-4.7
curl -X POST http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "GLM-4.7",
    "messages": [{"role": "user", "content": "讲一个有趣的故事"}],
    "stream": true
  }'

# 示例 4: 多模态请求 - 使用 GLM-4.6V（支持图像）
# curl -X POST http://localhost:9090/v1/chat/completions \
#   -H "Content-Type: application/json" \
#   -H "Authorization: Bearer your-api-key" \
#   -d '{
#     "model": "GLM-4.6V",
#     "messages": [{
#       "role": "user",
#       "content": [
#         {"type": "text", "text": "这张图片里有什么？"},
#         {"type": "image_url", "image_url": {"url": "https://example.com/image.jpg"}}
#       ]
#     }],
#     "stream": false
#   }'</div>
        </div>
        
        <div id="javascript-tab" class="tabcontent">
            <h3>JavaScript示例</h3>
            <div class="example">
const fetch = require('node-fetch');

async function chatWithGLM(model, message, stream = false) {
  const response = await fetch('http://localhost:9090/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer your-api-key'
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: message }],
      stream: stream
    })
  });

  if (stream) {
    // 处理流式响应
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            console.log('\n流式响应完成');
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices[0]?.delta?.content;
            if (content) {
              process.stdout.write(content);
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    }
  } else {
    // 处理非流式响应
    const data = await response.json();
    console.log(data.choices[0].message.content);
  }
}

// 使用示例 1: 旗舰模型 GLM-5（复杂任务）
chatWithGLM('GLM-5', '请分析并优化这段算法的时间复杂度', false);

// 使用示例 2: GLM-4.5-Air（快速响应）
chatWithGLM('GLM-4.5-Air', '你好', false);

// 使用示例 3: GLM-4.7 流式响应
chatWithGLM('GLM-4.7', '写一个关于未来的短篇故事', true);

// 使用示例 4: 多模态模型 GLM-4.6V（支持图像）
// chatWithGLM('GLM-4.6V', [
//   { type: 'text', text: '描述这张图片' },
//   { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } }
// ], false);</div>
        </div>
    </section>
    
    <section id="error-handling">
        <h2>错误处理</h2>
        <p>API使用标准HTTP状态码来表示请求的成功或失败：</p>
        <table>
            <thead>
                <tr>
                    <th>状态码</th>
                    <th>说明</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>200 OK</td>
                    <td>请求成功</td>
                </tr>
                <tr>
                    <td>400 Bad Request</td>
                    <td>请求格式错误或参数无效</td>
                </tr>
                <tr>
                    <td>401 Unauthorized</td>
                    <td>API密钥无效或缺失</td>
                </tr>
                <tr>
                    <td>502 Bad Gateway</td>
                    <td>上游服务错误</td>
                </tr>
            </tbody>
        </table>
        <div class="note">
            <strong>注意:</strong> 在调试模式下，服务器会输出详细的日志信息，可以通过设置环境变量 DEBUG_MODE=true 来启用。
        </div>
    </section>
</div>

<script>
    function openTab(evt, tabName) {
        var i, tabcontent, tablinks;
        tabcontent = document.getElementsByClassName("tabcontent");
        for (i = 0; i < tabcontent.length; i++) {
            tabcontent[i].style.display = "none";
        }
        tablinks = document.getElementsByClassName("tablinks");
        for (i = 0; i < tablinks.length; i++) {
            tablinks[i].className = tablinks[i].className.replace(" active", "");
        }
        document.getElementById(tabName).style.display = "block";
        evt.currentTarget.className += " active";
    }
</script>
</body>
</html>`;
}

// 处理API文档页面
async function handleDocs(request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  return new Response(getDocsHTML(), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

// 主HTTP服务器
async function main() {
  console.log(`OpenAI兼容API服务器启动`);
  console.log(
    `支持的模型: ${SUPPORTED_MODELS.map((m) => `${m.id} (${m.name})`).join(
      ", "
    )}`
  );
  console.log(`上游: ${UPSTREAM_URL}`);
  console.log(`Debug模式: ${DEBUG_MODE}`);
  console.log(`默认流式响应: ${DEFAULT_STREAM}`);
  console.log(`Dashboard启用: ${DASHBOARD_ENABLED}`);

  // 检测是否在Deno Deploy上运行
  const isDenoDeploy = Deno.env.get("DENO_DEPLOYMENT_ID") !== undefined;

  if (isDenoDeploy) {
    // Deno Deploy环境
    console.log("运行在Deno Deploy环境中");
    Deno.serve(handleRequest);
  } else {
    // 本地或自托管环境
    const port = parseInt(Deno.env.get("PORT") || "9090");
    console.log(`运行在本地环境中，端口: ${port}`);

    if (DASHBOARD_ENABLED) {
      console.log(
        `Dashboard已启用，访问地址: http://localhost:${port}/dashboard`
      );
    }

    const server = Deno.listen({ port });

    for await (const conn of server) {
      handleHttp(conn);
    }
  }
}

// 处理HTTP连接（用于本地环境）
async function handleHttp(conn: Deno.Conn) {
  const httpConn = Deno.serveHttp(conn);

  while (true) {
    const requestEvent = await httpConn.nextRequest();
    if (!requestEvent) break;

    const { request, respondWith } = requestEvent;
    const url = new URL(request.url);
    const startTime = Date.now();
    const userAgent = request.headers.get("User-Agent") || "";

    try {
      // 路由分发
      if (url.pathname === "/") {
        const response = await handleIndex(request);
        await respondWith(response);
        recordRequestStats(startTime, url.pathname, response.status);
        addLiveRequest(
          request.method,
          url.pathname,
          response.status,
          Date.now() - startTime,
          userAgent
        );
      } else if (url.pathname === "/v1/models") {
        const response = await handleModels(request);
        await respondWith(response);
        recordRequestStats(startTime, url.pathname, response.status);
        addLiveRequest(
          request.method,
          url.pathname,
          response.status,
          Date.now() - startTime,
          userAgent
        );
      } else if (url.pathname === "/v1/chat/completions") {
        const response = await handleChatCompletions(request);
        await respondWith(response);
        // 请求统计已在handleChatCompletions中记录
      } else if (url.pathname === "/docs") {
        const response = await handleDocs(request);
        await respondWith(response);
        recordRequestStats(startTime, url.pathname, response.status);
        addLiveRequest(
          request.method,
          url.pathname,
          response.status,
          Date.now() - startTime,
          userAgent
        );
      } else if (url.pathname === "/dashboard" && DASHBOARD_ENABLED) {
        const response = await handleDashboard(request);
        await respondWith(response);
        recordRequestStats(startTime, url.pathname, response.status);
        addLiveRequest(
          request.method,
          url.pathname,
          response.status,
          Date.now() - startTime,
          userAgent
        );
      } else if (url.pathname === "/dashboard/stats" && DASHBOARD_ENABLED) {
        const response = await handleDashboardStats(request);
        await respondWith(response);
        recordRequestStats(startTime, url.pathname, response.status);
        addLiveRequest(
          request.method,
          url.pathname,
          response.status,
          Date.now() - startTime,
          userAgent
        );
      } else if (url.pathname === "/dashboard/requests" && DASHBOARD_ENABLED) {
        const response = await handleDashboardRequests(request);
        await respondWith(response);
        recordRequestStats(startTime, url.pathname, response.status);
        addLiveRequest(
          request.method,
          url.pathname,
          response.status,
          Date.now() - startTime,
          userAgent
        );
      } else {
        const response = await handleOptions(request);
        await respondWith(response);
        recordRequestStats(startTime, url.pathname, response.status);
        addLiveRequest(
          request.method,
          url.pathname,
          response.status,
          Date.now() - startTime,
          userAgent
        );
      }
    } catch (error) {
      debugLog("处理请求时出错: %v", error);
      const response = new Response("Internal Server Error", { status: 500 });
      await respondWith(response);
      recordRequestStats(startTime, url.pathname, 500);
      addLiveRequest(
        request.method,
        url.pathname,
        500,
        Date.now() - startTime,
        userAgent
      );
    }
  }
}

// 处理HTTP请求（用于Deno Deploy环境）
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const startTime = Date.now();
  const userAgent = request.headers.get("User-Agent") || "";

  try {
    // 路由分发
    if (url.pathname === "/") {
      const response = await handleIndex(request);
      recordRequestStats(startTime, url.pathname, response.status);
      addLiveRequest(
        request.method,
        url.pathname,
        response.status,
        Date.now() - startTime,
        userAgent
      );
      return response;
    } else if (url.pathname === "/v1/models") {
      const response = await handleModels(request);
      recordRequestStats(startTime, url.pathname, response.status);
      addLiveRequest(
        request.method,
        url.pathname,
        response.status,
        Date.now() - startTime,
        userAgent
      );
      return response;
    } else if (url.pathname === "/v1/chat/completions") {
      const response = await handleChatCompletions(request);
      // 请求统计已在handleChatCompletions中记录
      return response;
    } else if (url.pathname === "/docs") {
      const response = await handleDocs(request);
      recordRequestStats(startTime, url.pathname, response.status);
      addLiveRequest(
        request.method,
        url.pathname,
        response.status,
        Date.now() - startTime,
        userAgent
      );
      return response;
    } else if (url.pathname === "/dashboard" && DASHBOARD_ENABLED) {
      const response = await handleDashboard(request);
      recordRequestStats(startTime, url.pathname, response.status);
      addLiveRequest(
        request.method,
        url.pathname,
        response.status,
        Date.now() - startTime,
        userAgent
      );
      return response;
    } else if (url.pathname === "/dashboard/stats" && DASHBOARD_ENABLED) {
      const response = await handleDashboardStats(request);
      recordRequestStats(startTime, url.pathname, response.status);
      addLiveRequest(
        request.method,
        url.pathname,
        response.status,
        Date.now() - startTime,
        userAgent
      );
      return response;
    } else if (url.pathname === "/dashboard/requests" && DASHBOARD_ENABLED) {
      const response = await handleDashboardRequests(request);
      recordRequestStats(startTime, url.pathname, response.status);
      addLiveRequest(
        request.method,
        url.pathname,
        response.status,
        Date.now() - startTime,
        userAgent
      );
      return response;
    } else {
      const response = await handleOptions(request);
      recordRequestStats(startTime, url.pathname, response.status);
      addLiveRequest(
        request.method,
        url.pathname,
        response.status,
        Date.now() - startTime,
        userAgent
      );
      return response;
    }
  } catch (error) {
    debugLog("处理请求时出错: %v", error);
    recordRequestStats(startTime, url.pathname, 500);
    addLiveRequest(
      request.method,
      url.pathname,
      500,
      Date.now() - startTime,
      userAgent
    );
    return new Response("Internal Server Error", { status: 500 });
  }
}

// 启动服务器
main();
