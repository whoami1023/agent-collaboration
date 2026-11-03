import { useEffect, useMemo, useState } from "react";
import type {
  MaskedProvider,
  MaskedSettings,
  ModelPatch,
  ProbeResult,
  ProviderPatch,
  UsageSnapshotView,
} from "./api";
import {
  deleteProvider,
  deleteProviderKey,
  fetchCatalogSuggestions,
  fetchModelUsage,
  probeModel,
  saveSettings,
} from "./api";
import type { CatalogSuggestion } from "./api";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const API_LABELS: Record<string, string> = {
  mock: "演示桩（不联网）",
  "openai-completions": "OpenAI 兼容 /chat/completions",
  "openai-responses": "OpenAI Responses /responses",
};

const MODEL_STATUSES = ["available", "deprecated", "disabled"];

/** 表单里的草稿：数字统一用字符串存，提交时再解析，输入过程不会被四舍五入打断。 */
interface ModelDraft {
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
  status: string;
  costInput: string;
  costOutput: string;
}

interface ProviderDraft {
  id: string;
  api: string;
  baseUrl: string;
  auth: "api-key" | "none";
  apiKey: string;
  timeoutSeconds: string;
  maxTokens: string;
  models: ModelDraft[];
}

function modelToDraft(model: MaskedProvider["models"][number]): ModelDraft {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow ? String(model.contextWindow) : "",
    maxTokens: model.maxTokens ? String(model.maxTokens) : "",
    reasoning: model.reasoning,
    status: model.status,
    costInput: model.cost.input ? String(model.cost.input) : "",
    costOutput: model.cost.output ? String(model.cost.output) : "",
  };
}

function providerToDraft(provider: MaskedProvider): ProviderDraft {
  return {
    id: provider.id,
    api: provider.api,
    baseUrl: provider.baseUrl ?? "",
    auth: provider.auth,
    apiKey: "",
    timeoutSeconds: provider.timeoutSeconds ? String(provider.timeoutSeconds) : "",
    maxTokens: provider.maxTokens ? String(provider.maxTokens) : "",
    models: provider.models.map(modelToDraft),
  };
}

/**
 * 表单里的数字一律用字符串承载，解析不出合法值就返回 undefined：
 * JSON 序列化会丢掉 undefined 字段，服务端按「未提供」处理，沿用内置目录默认值。
 */
function optionalNumber(value: string, label: string): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label}必须是数字`);
  return parsed;
}

function draftToPatch(draft: ProviderDraft): ProviderPatch {
  const models: ModelPatch[] = draft.models.map((model) => ({
    id: model.id.trim(),
    name: model.name.trim() || model.id.trim(),
    reasoning: model.reasoning,
    status: model.status,
    contextWindow: optionalNumber(model.contextWindow, "上下文窗口"),
    maxTokens: optionalNumber(model.maxTokens, "最大输出"),
    cost: {
      input: optionalNumber(model.costInput, "输入单价"),
      output: optionalNumber(model.costOutput, "输出单价"),
    },
  }));
  return {
    id: draft.id.trim(),
    api: draft.api as ProviderPatch["api"],
    baseUrl: draft.baseUrl.trim(),
    auth: draft.auth,
    apiKey: draft.apiKey.trim() || undefined,
    timeoutSeconds: optionalNumber(draft.timeoutSeconds, "超时秒数"),
    maxTokens: optionalNumber(draft.maxTokens, "最大输出"),
    models,
  };
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value > 0) return `$${value.toFixed(4)}`;
  return "$0";
}

const PROBE_LABELS: Record<ProbeResult["status"], string> = {
  ok: "连通",
  auth: "密钥无效",
  rate_limit: "限流",
  billing: "欠费",
  timeout: "超时",
  format: "响应格式不符",
  unknown: "失败",
  no_model: "模型不可用",
};

export function ModelSettings({
  settings,
  onSaved,
}: {
  settings: MaskedSettings;
  onSaved: (next: MaskedSettings) => void;
}) {
  const [selectedId, setSelectedId] = useState(settings.providers[0]?.id ?? "");
  const provider =
    settings.providers.find((item) => item.id === selectedId) ?? settings.providers[0];
  const [draft, setDraft] = useState<ProviderDraft | null>(
    provider ? providerToDraft(provider) : null,
  );
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [newProviderId, setNewProviderId] = useState("");
  const [suggestion, setSuggestion] = useState("");
  const [suggestions, setSuggestions] = useState<CatalogSuggestion[]>([]);

  // 切换供应商或保存后回到服务端快照，避免草稿停留在旧值上。
  useEffect(() => {
    const current = settings.providers.find((item) => item.id === selectedId);
    setDraft(current ? providerToDraft(current) : null);
    setProbe(null);
    setNote(null);
  }, [selectedId, settings]);

  useEffect(() => {
    if (!provider || provider.api === "mock") {
      setSuggestions([]);
      return;
    }
    let active = true;
    fetchCatalogSuggestions(provider.id)
      .then((list) => {
        if (active) setSuggestions(list);
      })
      .catch(() => {
        if (active) setSuggestions([]);
      });
    return () => {
      active = false;
    };
  }, [provider?.id, provider?.api, settings]);

  const allRefs = useMemo(() => {
    const refs: string[] = [];
    for (const item of settings.providers) {
      for (const model of item.models) refs.push(`${item.id}/${model.id}`);
    }
    return refs;
  }, [settings.providers]);

  if (!provider || !draft) {
    return (
      <div className="settings-form">
        <div className="section-label">模型服务</div>
        <p className="hint">还没有供应商。填一个 id（如 <code>deepseek</code>）新建一个。</p>
        <div className="field-row">
          <input
            value={newProviderId}
            placeholder="新供应商 id（字母、数字、点、下划线、连字符）"
            onChange={(event) => setNewProviderId(event.target.value)}
          />
          <button
            className="btn primary"
            type="button"
            onClick={() => void handleCreate()}
          >
            新建供应商
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
      </div>
    );

    async function handleCreate() {
      const id = newProviderId.trim();
      if (!id) {
        setError("请填写供应商 id");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        onSaved(await saveSettings({ providers: [{ id, api: "openai-completions", models: [] }] }));
        setSelectedId(id);
        setNewProviderId("");
      } catch (err) {
        setError(messageOf(err));
      } finally {
        setBusy(false);
      }
    }
  }

  const editorDraft = draft;
  const patched = settings.providers.find((item) => item.id === editorDraft.id) ?? provider;

  function updateModel(index: number, patch: Partial<ModelDraft>): void {
    setDraft((current) =>
      current
        ? {
            ...current,
            models: current.models.map((model, i) => (i === index ? { ...model, ...patch } : model)),
          }
        : current,
    );
  }

  async function handleSave(): Promise<void> {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      onSaved(await saveSettings({ providers: [draftToPatch(editorDraft)] }));
      setDraft((current) => (current ? { ...current, apiKey: "" } : current));
      setNote("已保存，下一条消息生效");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleProbe(): Promise<void> {
    setBusy(true);
    setError(null);
    setProbe(null);
    try {
      setProbe(await probeModel({ provider: draftToPatch(editorDraft) }));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleClearKey(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onSaved(await deleteProviderKey(provider.id));
      setNote("已清除保存的密钥");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteProvider(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const next = await deleteProvider(provider.id);
      onSaved(next);
      setSelectedId(next.providers[0]?.id ?? "");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  function addModelFromCatalog(ref: string): void {
    const hit = suggestions.find((item) => item.ref === ref);
    if (!hit) return;
    setDraft((current) =>
      current
        ? {
            ...current,
            models: [
              ...current.models,
              {
                id: hit.modelId,
                name: hit.name ?? hit.modelId,
                contextWindow: hit.contextWindow ? String(hit.contextWindow) : "",
                maxTokens: hit.maxTokens ? String(hit.maxTokens) : "",
                reasoning: hit.reasoning === true,
                status: "available",
                costInput: hit.cost?.input ? String(hit.cost.input) : "",
                costOutput: hit.cost?.output ? String(hit.cost.output) : "",
              },
            ],
          }
        : current,
    );
    setSuggestion("");
  }

  return (
    <div className="settings-form model-settings">
      <div className="section-label">模型服务</div>
      <div className="model-provider-tabs">
        {settings.providers.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`chip${item.id === draft.id ? " active" : ""}`}
            onClick={() => setSelectedId(item.id)}
          >
            {item.id}
            {item.models.length === 0 ? "（无模型）" : ""}
          </button>
        ))}
        <input
          className="model-new-provider"
          value={newProviderId}
          placeholder="新建供应商 id"
          onChange={(event) => setNewProviderId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              const id = newProviderId.trim();
              if (!id) return;
              void saveSettings({ providers: [{ id, api: "openai-completions", models: [] }] })
                .then((next) => {
                  onSaved(next);
                  setSelectedId(id);
                  setNewProviderId("");
                })
                .catch((err) => setError(messageOf(err)));
            }
          }}
        />
        <button
          type="button"
          className="btn sm"
          disabled={busy || !newProviderId.trim()}
          onClick={() => {
            const id = newProviderId.trim();
            if (!id) return;
            void saveSettings({ providers: [{ id, api: "openai-completions", models: [] }] })
              .then((next) => {
                onSaved(next);
                setSelectedId(id);
                setNewProviderId("");
              })
              .catch((err) => setError(messageOf(err)));
          }}
        >
          新建
        </button>
      </div>

      <div className="field-row">
        <label className="field">
          <span>供应商 id</span>
          <input value={draft.id} disabled />
        </label>
        <label className="field">
          <span>接口类型</span>
          <select
            value={draft.api}
            onChange={(event) => setDraft({ ...draft, api: event.target.value })}
          >
            {Object.entries(API_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {draft.api !== "mock" && (
        <>
          <div className="field-row">
            <label className="field">
              <span>Base URL</span>
              <input
                value={draft.baseUrl}
                placeholder="https://api.deepseek.com/v1"
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              />
            </label>
            <label className="field">
              <span>鉴权方式</span>
              <select
                value={draft.auth}
                onChange={(event) =>
                  setDraft({ ...draft, auth: event.target.value as "api-key" | "none" })
                }
              >
                <option value="api-key">API Key</option>
                <option value="none">无需鉴权（本地服务）</option>
              </select>
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>
                超时（秒）
                <em>1-3600，留空用默认</em>
              </span>
              <input
                value={draft.timeoutSeconds}
                inputMode="numeric"
                onChange={(event) => setDraft({ ...draft, timeoutSeconds: event.target.value })}
              />
            </label>
            <label className="field">
              <span>
                最大输出 tokens
                <em>供应商级上限</em>
              </span>
              <input
                value={draft.maxTokens}
                inputMode="numeric"
                onChange={(event) => setDraft({ ...draft, maxTokens: event.target.value })}
              />
            </label>
          </div>
          {draft.auth === "api-key" && (
            <label className="field">
              <span>
                API Key
                <em>
                  {patched.hasApiKey
                    ? `已保存：${patched.apiKeyHint ?? "自定义密钥"}；留空保持不变`
                    : "支持明文、env:变量名、file:相对路径"}
                </em>
              </span>
              <input
                value={draft.apiKey}
                placeholder="sk-… 或 env:DEEPSEEK_API_KEY"
                onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              />
            </label>
          )}
          {draft.auth === "api-key" && patched.hasApiKey && (
            <button type="button" className="btn sm ghost danger" disabled={busy} onClick={() => void handleClearKey()}>
              清除已保存密钥
            </button>
          )}
        </>
      )}

      <div className="section-label">模型目录</div>
      <p className="hint">
        留空窗口/输出/价格时按内置目录取值（DeepSeek、GPT、Qwen 等已收录），目录里没有才需要手填。
      </p>
      {suggestions.length > 0 && (
        <div className="field-row">
          <select value={suggestion} onChange={(event) => setSuggestion(event.target.value)}>
            <option value="">从内置目录添加模型…</option>
            {suggestions.map((item) => (
              <option key={item.ref} value={item.ref}>
                {item.ref}
                {item.contextWindow ? `（${formatTokens(item.contextWindow)}）` : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn sm"
            disabled={!suggestion || draft.models.some((model) => model.id === suggestion.split("/").slice(1).join("/"))}
            onClick={() => addModelFromCatalog(suggestion)}
          >
            添加
          </button>
        </div>
      )}
      <table className="model-table">
        <thead>
          <tr>
            <th>模型 id</th>
            <th>名称</th>
            <th>上下文</th>
            <th>最大输出</th>
            <th>推理</th>
            <th>输入价 $/M</th>
            <th>输出价 $/M</th>
            <th>状态</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {draft.models.map((model, index) => (
            <tr key={`${model.id}-${index}`}>
              <td>
                <input
                  value={model.id}
                  onChange={(event) => updateModel(index, { id: event.target.value })}
                />
              </td>
              <td>
                <input
                  value={model.name}
                  placeholder={model.id}
                  onChange={(event) => updateModel(index, { name: event.target.value })}
                />
              </td>
              <td>
                <input
                  value={model.contextWindow}
                  inputMode="numeric"
                  placeholder="目录默认"
                  onChange={(event) => updateModel(index, { contextWindow: event.target.value })}
                />
              </td>
              <td>
                <input
                  value={model.maxTokens}
                  inputMode="numeric"
                  placeholder="目录默认"
                  onChange={(event) => updateModel(index, { maxTokens: event.target.value })}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={model.reasoning}
                  onChange={(event) => updateModel(index, { reasoning: event.target.checked })}
                />
              </td>
              <td>
                <input
                  value={model.costInput}
                  inputMode="decimal"
                  placeholder="0"
                  onChange={(event) => updateModel(index, { costInput: event.target.value })}
                />
              </td>
              <td>
                <input
                  value={model.costOutput}
                  inputMode="decimal"
                  placeholder="0"
                  onChange={(event) => updateModel(index, { costOutput: event.target.value })}
                />
              </td>
              <td>
                <select
                  value={model.status}
                  onChange={(event) => updateModel(index, { status: event.target.value })}
                >
                  {MODEL_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <button
                  type="button"
                  className="btn sm ghost danger"
                  onClick={() =>
                    setDraft({ ...draft, models: draft.models.filter((_, i) => i !== index) })
                  }
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        className="btn sm"
        onClick={() =>
          setDraft({
            ...draft,
            models: [
              ...draft.models,
              {
                id: "",
                name: "",
                contextWindow: "",
                maxTokens: "",
                reasoning: false,
                status: "available",
                costInput: "",
                costOutput: "",
              },
            ],
          })
        }
      >
        添加空模型
      </button>

      <div className="modal-actions">
        <button className="btn primary" disabled={busy} type="button" onClick={() => void handleSave()}>
          {busy ? "处理中…" : "保存供应商"}
        </button>
        <button className="btn" disabled={busy} type="button" onClick={() => void handleProbe()}>
          测试连接
        </button>
        <button className="btn ghost danger" disabled={busy} type="button" onClick={() => void handleDeleteProvider()}>
          删除供应商
        </button>
      </div>
      {probe && (
        <p className={probe.status === "ok" ? "form-note" : "form-error"}>
          {PROBE_LABELS[probe.status]}
          {probe.ref ? ` · ${probe.ref}` : ""}
          {probe.latencyMs !== undefined ? ` · ${Math.round(probe.latencyMs)} ms` : ""}
          {probe.error ? ` · ${probe.error}` : ""}
        </p>
      )}
      {note && <p className="form-note">{note}</p>}
      {error && <p className="form-error">{error}</p>}

      <SelectionSection
        settings={settings}
        refs={allRefs}
        onSaved={onSaved}
        busy={busy}
        setBusy={setBusy}
      />
      <UsageSection />
    </div>
  );
}

function SelectionSection({
  settings,
  refs,
  onSaved,
  busy,
  setBusy,
}: {
  settings: MaskedSettings;
  refs: string[];
  onSaved: (next: MaskedSettings) => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
}) {
  const selection = settings.selection;
  const [defaultModel, setDefaultModel] = useState(selection.defaultModel);
  const [fallbacks, setFallbacks] = useState(selection.fallbacks.join(", "));
  const [allow, setAllow] = useState(selection.allow.join(", "));
  const [aliases, setAliases] = useState<Array<{ key: string; value: string }>>(
    Object.entries(selection.aliases).map(([key, value]) => ({ key, value })),
  );
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDefaultModel(selection.defaultModel);
    setFallbacks(selection.fallbacks.join(", "));
    setAllow(selection.allow.join(", "));
    setAliases(Object.entries(selection.aliases).map(([key, value]) => ({ key, value })));
  }, [selection]);

  async function handleSave(): Promise<void> {
    setBusy(true);
    setError(null);
    setNote(null);
    const split = (value: string) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    const patch: { selection: Parameters<typeof saveSettings>[0]["selection"] } = {
      selection: {
        defaultModel: defaultModel.trim(),
        fallbacks: split(fallbacks),
        allow: split(allow),
        aliases: Object.fromEntries(
          aliases.filter((alias) => alias.key.trim()).map((alias) => [alias.key.trim(), alias.value.trim()]),
        ),
      },
    };
    try {
      onSaved(await saveSettings(patch));
      setNote("已保存默认模型与别名");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="section-label">默认模型与别名</div>
      <label className="field">
        <span>
          默认模型
          <em>成员选择「跟随默认」时使用；也可用 /model 命令临时改</em>
        </span>
        <select value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)}>
          {refs.length === 0 && <option value={defaultModel}>{defaultModel}</option>}
          {refs.map((ref) => (
            <option key={ref} value={ref}>
              {ref}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>
          备用模型
          <em>主模型调用失败时按顺序切换，逗号分隔</em>
        </span>
        <input
          value={fallbacks}
          placeholder="deepseek/deepseek-chat, openai/gpt-4o-mini"
          onChange={(event) => setFallbacks(event.target.value)}
        />
      </label>
      <label className="field">
        <span>
          允许列表
          <em>留空表示全部允许；支持 deepseek/* 这类通配</em>
        </span>
        <input value={allow} onChange={(event) => setAllow(event.target.value)} />
      </label>
      <div className="field-label">别名</div>
      {aliases.map((alias, index) => (
        <div className="field-row" key={`${alias.key}-${index}`}>
          <input
            value={alias.key}
            placeholder="别名，如 think"
            onChange={(event) =>
              setAliases((current) =>
                current.map((item, i) => (i === index ? { ...item, key: event.target.value } : item)),
              )
            }
          />
          <input
            value={alias.value}
            placeholder="目标模型引用"
            onChange={(event) =>
              setAliases((current) =>
                current.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)),
              )
            }
          />
          <button
            type="button"
            className="btn sm ghost danger"
            onClick={() => setAliases((current) => current.filter((_, i) => i !== index))}
          >
            移除
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn sm"
        onClick={() => setAliases((current) => [...current, { key: "", value: "" }])}
      >
        添加别名
      </button>
      <p className="hint">
        内置别名：{["deepseek", "deepseek-think", "gpt", "o", "qwen"].join("、")} 已预置，自定义别名会覆盖它们。
      </p>
      <div className="modal-actions">
        <button className="btn primary" disabled={busy} type="button" onClick={() => void handleSave()}>
          保存选择
        </button>
        {note && <span className="form-note">{note}</span>}
        {error && <span className="form-error">{error}</span>}
      </div>
    </>
  );
}

function UsageSection() {
  const [days, setDays] = useState(7);
  const [usage, setUsage] = useState<UsageSnapshotView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchModelUsage(days)
      .then((snapshot) => {
        if (active) {
          setUsage(snapshot);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) setError(messageOf(err));
      });
    return () => {
      active = false;
    };
  }, [days]);

  return (
    <>
      <div className="section-label">用量与成本</div>
      <div className="field-row">
        <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
          <option value={7}>最近 7 天</option>
          <option value={30}>最近 30 天</option>
          <option value={90}>最近 90 天</option>
        </select>
        {usage && (
          <span className="hint">
            {usage.runs} 次调用 · 输入 {formatTokens(usage.usage.input)} · 输出{" "}
            {formatTokens(usage.usage.output)} · 缓存命中 {formatTokens(usage.usage.cacheRead)} ·{" "}
            {formatUsd(usage.costUsd)}
          </span>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}
      {usage && usage.byRef.length > 0 && (
        <table className="model-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>次数</th>
              <th>输入</th>
              <th>输出</th>
              <th>缓存命中</th>
              <th>成本</th>
            </tr>
          </thead>
          <tbody>
            {usage.byRef.map((entry) => (
              <tr key={entry.ref}>
                <td>{entry.ref}</td>
                <td>{entry.runs}</td>
                <td>{formatTokens(entry.usage.input)}</td>
                <td>{formatTokens(entry.usage.output)}</td>
                <td>{formatTokens(entry.usage.cacheRead)}</td>
                <td>{formatUsd(entry.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {usage && usage.byRef.length === 0 && (
        <p className="hint">这段时间还没有模型调用记录；产生用量后这里会按模型汇总。</p>
      )}
    </>
  );
}
