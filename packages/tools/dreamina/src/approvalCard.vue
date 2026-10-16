<template>
  <section class="approvalCard" role="group" :aria-label="tool.question?.title || '即梦操作记录'" @keydown.stop @keyup.stop>
    <template v-if="tool.question">
      <strong>{{ tool.question.title }}</strong>
      <p>{{ tool.question.question }}</p>
      <div v-if="waiting" class="approvalActions">
        <button v-for="option in tool.question.options" :key="option" type="button" :disabled="busy || !canAnswer" @click="answer(option)">{{ option }}</button>
        <button type="button" :disabled="busy || !canAnswer" @click="answer('', true)">跳过，不执行</button>
      </div>
      <p v-else>{{ submitted ? '回答已提交，正在核验…' : '此确认已结束；执行情况以工具结果为准。' }}</p>
    </template>
    <p v-if="error" role="alert">{{ error }}</p>
    <pre v-if="tool.result">{{ tool.result }}</pre>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import axios from "axios";
import type { ToolCall } from "@toonflow/tools-scaffold/runtime";

const props = defineProps<{ tool: ToolCall; directory?: string; toolSessionId?: string }>();
const busy = ref(false);
const error = ref("");
const submitted = ref(false);
const canAnswer = computed(() => !!props.directory || !!props.toolSessionId);
const waiting = computed(() => props.tool.status === "running" && !!props.tool.question?.callId && !submitted.value);
watch(() => props.tool.question?.callId, () => { error.value = ""; submitted.value = false; });

async function answer(value: string, skipped = false) {
  const callId = props.tool.question?.callId;
  if (!callId || busy.value || !waiting.value || !canAnswer.value) return;
  busy.value = true;
  error.value = "";
  try {
    const response = await axios.post(props.toolSessionId ? "/api/singleAgent/answer" : "/api/agent/answer", {
      ...(props.toolSessionId ? { sessionId: props.toolSessionId } : { directory: props.directory }), callId,
      ...(skipped ? { skipped: true } : { answer: value }),
    }, { headers: { "x-toonflow-workspace": "1" } });
    if (response.data.code !== 200) throw new Error("answer_failed");
    submitted.value = true;
  } catch {
    error.value = "回答未送达，尚未视为批准。请重试或停止本次操作。";
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped lang="scss">
.approvalCard {
  p,
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .approvalActions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;

    button {
      padding: 6px 10px;
      color: var(--el-text-color-primary);
      background: var(--el-fill-color-light);
      border: 1px solid var(--el-border-color);
      border-radius: 4px;
      cursor: pointer;

      &:disabled {
        cursor: default;
        opacity: 0.6;
      }
    }
  }
}
</style>
