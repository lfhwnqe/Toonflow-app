import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getConfiguredModel } from "@/utils/ai";
import { streamCodex } from "@/utils/ai/codexStream";

export async function createAgentModel(providerId: string, modelId: string, thinkingLevel = "off") {
  const configured = getConfiguredModel(providerId, modelId);
  providerId = configured.providerId;
  const { provider, model, baseUrl } = configured;
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider(providerId, {
    api: provider.protocol,
    baseUrl,
    ...(providerId === "codex" ? { streamSimple: streamCodex } : {}),
    models: [{
      id: model.id, name: model.label, reasoning: thinkingLevel !== "off",
      // ACT: 保留图片输入，由实际供应方判断该模型是否支持。
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens,
    }],
  });
  // Pi 的自定义 Provider 需要非空就绪标记；Codex 适配不读取或发送该值，认证完全由官方 CLI 管理。
  await runtime.setRuntimeApiKey(providerId, providerId === "codex" ? "nativeCodexCli" : provider.apiKey);
  return { ...configured, runtime };
}
