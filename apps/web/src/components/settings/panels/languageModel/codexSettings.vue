<template>
  <el-card class="codexSettings" shadow="never">
    <el-space wrap>
      <strong>Codex（本机登录）</strong>
      <el-tag>{{ status?.authenticated ? "已登录" : "待检查" }}</el-tag>
      <el-button :loading="loading" @click="refresh">刷新状态与模型</el-button>
    </el-space>
    <el-form labelPosition="top">
      <el-form-item label="官方 Codex CLI 路径（留空自动查找）">
        <el-input v-model="executable" :placeholder="status?.executable || '自动查找本机 Codex CLI'" aria-label="Codex CLI 路径" />
      </el-form-item>
      <el-button :loading="saving" @click="save">保存 CLI 路径</el-button>
      <el-form-item label="新对话与未指定模型的文本任务默认模型">
        <el-select :modelValue="defaultTextModel" filterable aria-label="默认文本模型" @change="setDefault">
          <el-option v-for="model in modelChoices" :key="model.value" :value="model.value" :label="model.label" />
        </el-select>
      </el-form-item>
    </el-form>
    <p v-if="status">文本：{{ status.text }}；图片：{{ status.image }}</p>
    <p v-if="status">{{ status.message }}</p>
    <p>沿用官方 CLI 当前登录，无需 OpenAI API Key。模型推理在云端运行，Codex 额度以官方账户为准；TF-Router 余额属于另一供应商。</p>
    <p>旧对话与节点保留原供应商，可在对应模型菜单明确切换。图片首期仅支持单张文生图，按 9:16 构图，实际像素尺寸以产物为准。</p>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { defaultTextModel, modelChoices, refreshCodexStatus, saveSettings, settings } from "@/stores/settings";

const executable = ref((settings.value.codex as { executable?: string } | undefined)?.executable ?? "");
const status = ref<Awaited<ReturnType<typeof refreshCodexStatus>>>();
const loading = ref(false);
const saving = ref(false);

async function refresh() {
  if (loading.value) return;
  loading.value = true;
  try { status.value = await refreshCodexStatus(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "读取 Codex 状态失败"); }
  finally { loading.value = false; }
}

async function save() {
  saving.value = true;
  try {
    await saveSettings(() => ({ codex: { executable: executable.value.trim() } }));
    await refresh();
  } catch { ElMessage.error("保存 Codex 路径失败，请确认使用绝对路径"); }
  finally { saving.value = false; }
}

async function setDefault(value: string) {
  const model = modelChoices.value.find(item => item.value === value);
  if (!model) return;
  try { await saveSettings(() => ({ defaultTextModel: { providerId: model.providerId, modelId: model.modelId } })); }
  catch { ElMessage.error("保存默认文本模型失败"); }
}
onMounted(refresh);
</script>

<style lang="scss" scoped>
.codexSettings {
  margin-bottom: 16px;
  .el-form { margin-top: 16px; }
  .el-select { width: 100%; }
  p { color: var(--el-text-color-secondary); line-height: 1.6; }
}
</style>
