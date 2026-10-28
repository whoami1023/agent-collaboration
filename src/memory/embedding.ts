/**
 * 移植自 OpenClaw（MIT License, Copyright (c) 2026 OpenClaw Foundation）：
 * packages/memory-host-sdk/src/host/embedding-vector.ts —— encode/decode 逐字移植。
 * 适配：OpenClaw 的本地向量来自可插拔 GGUF 插件、远程向量来自 embedding 提供商；
 * 本项目默认使用确定性的 token 哈希投影（离线可用、无需密钥），并保留可选的
 * OpenAI 兼容 /embeddings 远程通道。语义相近不等于模型级嵌入，已在检索层注明降级。
 */

import { createHash } from "node:crypto";
import { tokenize } from "./tokenize";

export function encodeMemoryEmbedding(embedding: readonly number[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(embedding.length * 8);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < embedding.length; index += 1) {
    const coordinate = embedding[index];
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
      throw new Error("Memory embeddings require finite numeric coordinates");
    }
    view.setFloat64(index * 8, coordinate, true);
  }
  return bytes;
}

/** Invalid derived vectors stay unusable; cache and indexing owners repair them. */
export function decodeMemoryEmbedding(bytes: Uint8Array): number[] {
  if (bytes.byteLength % 8 !== 0) {
    return [];
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const embedding: number[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 8) {
    const coordinate = view.getFloat64(offset, true);
    if (!Number.isFinite(coordinate)) {
      return [];
    }
    embedding.push(coordinate);
  }
  return embedding;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += (a[index] ?? 0) * (b[index] ?? 0);
    normA += (a[index] ?? 0) ** 2;
    normB += (b[index] ?? 0) ** 2;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface MemoryEmbeddingProvider {
  id: string;
  model: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

const HASH_EMBEDDING_DIMENSIONS = 256;

function fnvSign(token: string, salt: number): { index: number; sign: number } {
  const digest = createHash("sha256")
    .update(`${salt}:${token}`, "utf8")
    .digest();
  const index = digest.readUInt32BE(0) % HASH_EMBEDDING_DIMENSIONS;
  const sign = (digest[4] ?? 0) % 2 === 0 ? 1 : -1;
  return { index, sign };
}

/** 确定性哈希投影：token 集 → 256 维 L2 归一向量；共享 token 越多余弦越接近 1。 */
export class HashProjectionEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly id = "local-hash";
  readonly model = "hash-projection-256";
  readonly dimensions = HASH_EMBEDDING_DIMENSIONS;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Float64Array(HASH_EMBEDDING_DIMENSIONS);
      for (const token of tokenize(text)) {
        for (const salt of [0, 1]) {
          const { index, sign } = fnvSign(token, salt);
          vector[index] += sign;
        }
      }
      let norm = 0;
      for (const value of vector) norm += value * value;
      norm = Math.sqrt(norm);
      return norm === 0 ? [] : Array.from(vector, (value) => value / norm);
    });
  }
}

export interface RemoteEmbeddingOptions {
  id?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions?: number;
}

/** OpenAI 兼容 /embeddings 通道（适配自 memory-host-sdk 远程栈的调用形态）。 */
export class OpenAiCompatibleEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;

  constructor(private readonly options: RemoteEmbeddingOptions) {
    this.id = options.id ?? "remote";
    this.model = options.model;
    this.dimensions = options.dimensions ?? 0;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/embeddings`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        ...(this.dimensions > 0 ? { dimensions: this.dimensions } : {}),
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`embedding 接口 ${response.status}：${detail.slice(0, 200)}`);
    }
    const payload = (await response.json()) as {
      data?: Array<{ index?: number; embedding?: number[] }>;
    };
    const rows = payload.data ?? [];
    const byIndex = new Map<number, number[]>();
    rows.forEach((row, fallbackIndex) => {
      if (Array.isArray(row.embedding)) {
        byIndex.set(row.index ?? fallbackIndex, row.embedding);
      }
    });
    return texts.map((_, index) => byIndex.get(index) ?? []);
  }
}
