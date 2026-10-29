import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import {
  createSkill,
  deleteSkill,
  fetchSkills,
  importSkills,
  updateSkill,
  type SkillImportResult,
  type SkillScope,
  type SkillSnapshot,
  type SkillView,
} from "./api";
import { Icon } from "./icons";

type SkillTab = "shared" | "personal";

type SkillMode =
  | { kind: "list" }
  | { kind: "view"; skill: SkillView }
  | { kind: "create"; scope: SkillScope }
  | { kind: "edit"; skill: SkillView }
  | { kind: "import" };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function scopeLabel(scope: SkillScope): string {
  return scope === "shared" ? "共享" : "个人";
}

export default function SkillLibraryPanel({ onClose }: { onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<SkillSnapshot | null>(null);
  const [tab, setTab] = useState<SkillTab>("shared");
  const [mode, setMode] = useState<SkillMode>({ kind: "list" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await fetchSkills());
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function backToList() {
    setMode({ kind: "list" });
    setConfirmingId(null);
    setError(null);
  }

  async function handleDelete(skill: SkillView) {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    setNotice(null);
    try {
      await deleteSkill(skill.id);
      setNotice(`已删除技能 ${skill.name}`);
      setConfirmingId(null);
      setMode({ kind: "list" });
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setDeleting(false);
    }
  }

  const shared = snapshot?.shared ?? [];
  const personal = snapshot?.personal ?? [];
  const canManageShared = snapshot?.canManageShared ?? false;
  const skills = tab === "shared" ? shared : personal;
  const canManage = (skill: SkillView) => skill.scope === "personal" || canManageShared;

  const hint =
    tab === "shared"
      ? canManageShared
        ? "共享技能对全部账号的智能体可见，只有管理员可以新建、编辑或删除。"
        : "共享技能由管理员维护；你和你的智能体都可以直接使用。"
      : "个人技能只有你自己的主智能体与子成员能用，其他账号看不到。";

  return (
    <div className="board-sheet skills-sheet">
      <div className="board-head">
        <span className="section-label">技能库</span>
        <div className="board-head-actions">
          <span className="chip">{shared.length + personal.length}</span>
          <button
            type="button"
            className="btn icon ghost board-close"
            aria-label="刷新技能库"
            title="刷新技能库"
            onClick={() => void refresh()}
          >
            <Icon name="refresh" />
          </button>
          <button
            type="button"
            className="btn icon ghost board-close"
            aria-label="关闭技能库面板"
            title="关闭面板，回到作战室"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
      </div>

      <div className="board-body skills-body">
        {error && <p className="form-error">{error}</p>}
        {notice && <p className="form-note">{notice}</p>}

        {mode.kind === "list" && (
          <>
            <div className="skills-toolbar">
              <div className="skills-tabs" role="tablist" aria-label="技能分类">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "shared"}
                className={`skills-tab${tab === "shared" ? " active" : ""}`}
                onClick={() => {
                  setTab("shared");
                  setConfirmingId(null);
                }}
              >
                共享技能
                <span className="chip">{shared.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "personal"}
                className={`skills-tab${tab === "personal" ? " active" : ""}`}
                onClick={() => {
                  setTab("personal");
                  setConfirmingId(null);
                }}
              >
                个人技能
                <span className="chip">{personal.length}</span>
              </button>
              </div>

              <div className="skills-toolbar-actions">
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() => {
                    setNotice(null);
                    setMode({ kind: "create", scope: tab });
                  }}
                >
                  <Icon name="plus" />
                  新建技能
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setNotice(null);
                    setMode({ kind: "import" });
                  }}
                >
                  <Icon name="import" />
                  导入
                </button>
              </div>
            </div>
            <p className="hint">{hint}</p>

            {!snapshot ? (
              <p className="hint">正在加载技能…</p>
            ) : skills.length === 0 ? (
              <p className="empty small">
                {tab === "shared"
                  ? "共享库还是空的。"
                  : "你还没有个人技能，可以新建一个，或导入现成的 SKILL.md。"}
              </p>
            ) : (
              <ul className="skill-list">
                {skills.map((skill) => (
                  <li key={skill.id} className="skill-card">
                    <div className="skill-card-head">
                      <span className="skill-name">{skill.name}</span>
                      <span className={`chip${skill.scope === "shared" ? " accent" : ""}`}>
                        {scopeLabel(skill.scope)}
                      </span>
                      {skill.builtin && <span className="chip">内置</span>}
                      {skill.imported && <span className="chip">导入</span>}
                      <span className="skill-owner">
                        {skill.builtin
                          ? "随系统预装"
                          : skill.imported
                            ? (skill.source ?? "导入自 SKILL.md")
                            : skill.scope === "shared"
                              ? `由 ${skill.ownerName ?? "管理员"} 维护`
                              : "仅自己可见"}
                      </span>
                    </div>
                    <p className="skill-desc">{skill.description}</p>
                    <div className="skill-foot">
                      <span className="skill-time">
                        更新于 {new Date(skill.updatedAt).toLocaleDateString()}
                      </span>
                      <div className="skill-actions">
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() => {
                            setNotice(null);
                            setMode({ kind: "view", skill });
                          }}
                        >
                          查看
                        </button>
                        {canManage(skill) && (
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() => {
                              setNotice(null);
                              setMode({ kind: "edit", skill });
                            }}
                          >
                            编辑
                          </button>
                        )}
                        {canManage(skill) &&
                          (confirmingId === skill.id ? (
                            <>
                              <button
                                type="button"
                                className="btn danger sm"
                                disabled={deleting}
                                onClick={() => void handleDelete(skill)}
                              >
                                {deleting ? "删除中…" : "确认删除"}
                              </button>
                              <button
                                type="button"
                                className="btn ghost sm"
                                onClick={() => setConfirmingId(null)}
                              >
                                取消
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="btn ghost sm danger"
                              onClick={() => {
                                setNotice(null);
                                setConfirmingId(skill.id);
                              }}
                            >
                              删除
                            </button>
                          ))}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {mode.kind === "view" && (
          <div className="skill-detail">
            <div className="skill-detail-head">
              <button type="button" className="btn ghost sm" onClick={backToList}>
                ← 返回列表
              </button>
              <span className="skill-name">{mode.skill.name}</span>
              <span className={`chip${mode.skill.scope === "shared" ? " accent" : ""}`}>
                {scopeLabel(mode.skill.scope)}
              </span>
              {mode.skill.builtin && <span className="chip">内置</span>}
              {canManage(mode.skill) && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => setMode({ kind: "edit", skill: mode.skill })}
                >
                  编辑
                </button>
              )}
            </div>
            <p className="skill-desc">{mode.skill.description}</p>
            {mode.skill.source && <p className="hint">来源：{mode.skill.source}</p>}
            <pre className="skill-read">{mode.skill.instructions}</pre>
          </div>
        )}

        {mode.kind === "import" && (
          <SkillImportView
            canManageShared={canManageShared}
            onCancel={backToList}
            onChanged={() => void refresh()}
            onImported={(results) => {
              const ok = results.filter((item) => item.ok);
              const failed = results.filter((item) => !item.ok);
              backToList();
              setNotice(
                ok.length
                  ? `已导入 ${ok.length} 个技能${failed.length ? `，${failed.length} 个未通过` : ""}`
                  : null,
              );
              setError(failed.length ? failed[0].error ?? "导入失败" : null);
              const importedScope = ok.find((item) => item.skill)?.skill?.scope;
              if (importedScope) setTab(importedScope);
              void refresh();
            }}
          />
        )}

        {(mode.kind === "create" || mode.kind === "edit") && (
          <SkillForm
            key={mode.kind === "edit" ? mode.skill.id : `new-${mode.scope}`}
            scope={mode.kind === "edit" ? mode.skill.scope : mode.scope}
            skill={mode.kind === "edit" ? mode.skill : undefined}
            onCancel={() =>
              setMode(mode.kind === "edit" ? { kind: "view", skill: mode.skill } : { kind: "list" })
            }
            onSaved={(skill, created) => {
              setMode({ kind: "list" });
              setNotice(created ? `已创建技能 ${skill.name}` : `已保存技能 ${skill.name}`);
              setError(null);
              void refresh();
            }}
          />
        )}
      </div>
    </div>
  );
}

interface PendingFile {
  filename: string;
  content: string;
}

const MAX_SKILL_MD_BYTES = 256 * 1024;
const MAX_IMPORT_FILES = 20;
/** React 的类型里没有这两个非标准的「选整个目录」属性。 */
const FOLDER_PICK_ATTRS = { webkitdirectory: "", directory: "" } as unknown as Record<string, string>;

/** 导入面板：SKILL.md 文件（可多选）或直接粘贴内容，逐条给出结果。 */
function SkillImportView({
  canManageShared,
  onCancel,
  onChanged,
  onImported,
}: {
  canManageShared: boolean;
  onCancel: () => void;
  onChanged: () => void;
  onImported: (results: SkillImportResult[]) => void;
}) {
  const [scope, setScope] = useState<SkillScope>(canManageShared ? "shared" : "personal");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [pasted, setPasted] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SkillImportResult[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  async function addPicked(picked: File[], fromFolder: boolean) {
    if (!picked.length) return;
    setError(null);
    const loaded: PendingFile[] = [];
    const skipped: string[] = [];
    for (const file of picked) {
      const path = file.webkitRelativePath || file.name;
      // 目录导入时一个目录就是一个技能：只收 SKILL.md，忽略 references/、scripts/ 等附属文件。
      if (fromFolder && !/(?:^|\/)SKILL\.md$/i.test(path)) continue;
      if (loaded.length + files.length >= MAX_IMPORT_FILES) {
        skipped.push("超出单次 20 份的上限");
        break;
      }
      if (file.size > MAX_SKILL_MD_BYTES) {
        skipped.push(`${path} 超过 256 KB`);
        continue;
      }
      try {
        loaded.push({ filename: path, content: await file.text() });
      } catch (err) {
        skipped.push(`${path} 读取失败：${messageOf(err)}`);
      }
    }
    if (loaded.length) setFiles((current) => [...current, ...loaded]);
    setResults(null);
    if (skipped.length) setError(`部分文件未加入：${skipped.join("；")}。`);
    else if (!loaded.length && fromFolder)
      setError("这个目录里没有 SKILL.md。OpenClaw 技能是一个装有 SKILL.md 的文件夹。");
  }

  function handlePick(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    void addPicked(picked, false);
  }

  function handlePickFolder(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    void addPicked(picked, true);
  }

  function removeFile(index: number) {
    setFiles((current) => current.filter((_, position) => position !== index));
    setResults(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const payload: PendingFile[] = [...files];
    if (pasted.trim()) payload.push({ filename: "pasted-SKILL.md", content: pasted });
    if (!payload.length) {
      setError("请选择至少一个 SKILL.md 文件，或把内容粘贴到文本框。");
      return;
    }
    if (payload.length > MAX_IMPORT_FILES) {
      setError(`单次最多导入 ${MAX_IMPORT_FILES} 份技能，请减少文件数量。`);
      return;
    }
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const response = await importSkills({
        scope,
        overwrite,
        files: payload.map((item) => ({ filename: item.filename, content: item.content })),
      });
      setResults(response.results);
      setPasted("");
      const imported = response.results.filter((item) => item.ok);
      if (imported.length > 0) onChanged();
      if (imported.length === response.results.length) {
        onImported(response.results);
      }
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="skill-form skill-import" onSubmit={(event) => void handleSubmit(event)}>
      <div className="skill-form-head">
        <span className="skill-form-title">导入技能</span>
        <button type="button" className="btn ghost sm" onClick={onCancel}>
          返回
        </button>
      </div>

      <p className="hint">
        支持 OpenClaw 风格的 SKILL.md：YAML frontmatter 里的 name / description 作为技能名与描述，
        正文作为完整说明。可以一次选多个文件，也可以直接粘贴内容。
      </p>

      <div className="skill-import-scope">
        <label className="radio">
          <input
            type="radio"
            name="skill-import-scope"
            checked={scope === "personal"}
            onChange={() => setScope("personal")}
          />
          导入到我的个人技能
        </label>
        <label className={`radio${canManageShared ? "" : " disabled"}`}>
          <input
            type="radio"
            name="skill-import-scope"
            disabled={!canManageShared}
            checked={scope === "shared"}
            onChange={() => setScope("shared")}
          />
          导入为共享技能{canManageShared ? "" : "（仅管理员）"}
        </label>
      </div>

      <div className="skill-import-drop">
        <input
          ref={fileInput}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          multiple
          hidden
          onChange={handlePick}
        />
        <input
          ref={folderInput}
          type="file"
          multiple
          hidden
          onChange={handlePickFolder}
          {...FOLDER_PICK_ATTRS}
        />
        <button type="button" className="btn sm" onClick={() => fileInput.current?.click()}>
          <Icon name="import" />
          选择 SKILL.md
        </button>
        <button type="button" className="btn sm" onClick={() => folderInput.current?.click()}>
          <Icon name="folder" />
          选择技能文件夹
        </button>
        <span className="hint">
          {files.length ? `已选 ${files.length} 个文件` : "单个文件，或整个技能文件夹"}
        </span>
      </div>

      {files.length > 0 && (
        <ul className="skill-import-files">
          {files.map((file, index) => (
            <li key={`${file.filename}-${index}`}>
              <span className="skill-import-file-name" title={`${file.content.length} 字符`}>
                {file.filename}
              </span>
              <span className="skill-import-file-size">{Math.round(file.content.length / 1024)} KB</span>
              <button type="button" className="btn ghost sm" onClick={() => removeFile(index)}>
                移除
              </button>
            </li>
          ))}
        </ul>
      )}

      <label className="field">
        <span>或粘贴内容</span>
        <textarea
          className="skill-instructions-input"
          rows={8}
          spellCheck={false}
          value={pasted}
          placeholder={"---\nname: weekly-report\ndescription: 生成本周进展汇报\n---\n\n1. 汇总本周任务…"}
          onChange={(event) => setPasted(event.target.value)}
        />
      </label>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={overwrite}
          onChange={(event) => setOverwrite(event.target.checked)}
        />
        同名技能直接覆盖（更新描述与说明）
      </label>

      {error && <p className="form-error">{error}</p>}

      {results && (
        <ul className="skill-import-results">
          {results.map((item, index) => (
            <li key={`${item.filename}-${index}`} className={item.ok ? "ok" : "failed"}>
              <span className="skill-import-state">{item.ok ? "✓" : "✕"}</span>
              <span className="skill-import-msg">
                <span>
                  {item.ok
                    ? `${item.skill?.name} · ${item.action === "updated" ? "已覆盖更新" : "已创建"}`
                    : `${item.filename}：${item.error ?? "导入失败"}`}
                </span>
                {item.warnings && item.warnings.length > 0 && (
                  <span className="skill-import-warnings">
                    {item.warnings.map((warning, position) => (
                      <em key={position}>{warning}</em>
                    ))}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="modal-actions">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "导入中…" : "开始导入"}
        </button>
        <button className="btn ghost" type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

function SkillForm({
  scope,
  skill,
  onCancel,
  onSaved,
}: {
  scope: SkillScope;
  skill?: SkillView;
  onCancel: () => void;
  onSaved: (skill: SkillView, created: boolean) => void;
}) {
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [instructions, setInstructions] = useState(skill?.instructions ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload = { name, description, instructions };
      if (skill) {
        const saved = await updateSkill(skill.id, payload);
        onSaved(saved, false);
      } else {
        const saved = await createSkill({ scope, ...payload });
        onSaved(saved, true);
      }
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="skill-form" onSubmit={(event) => void handleSubmit(event)}>
      <div className="skill-form-head">
        <span className="skill-form-title">
          {skill ? "编辑技能" : "新建技能"}
          <span className={`chip${scope === "shared" ? " accent" : ""}`}>{scopeLabel(scope)}</span>
        </span>
        <button type="button" className="btn ghost sm" onClick={onCancel}>
          返回
        </button>
      </div>

      <label className="field">
        <span>名称</span>
        <input
          autoFocus
          spellCheck={false}
          value={name}
          maxLength={48}
          disabled={Boolean(skill?.builtin)}
          placeholder="例如：weekly-report"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <p className="hint">
        {skill?.builtin
          ? "内置技能不能改名，可以修改描述和完整说明。"
          : "小写字母、数字或短横线，最长 48 位；同一范围内不能重名。"}
      </p>

      <label className="field">
        <span className="field-label">
          描述
          <em>{description.length}/160</em>
        </span>
        <input
          value={description}
          maxLength={160}
          placeholder="一句话说明这个技能解决什么问题，智能体据此判断是否调用。"
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>

      <label className="field">
        <span>完整说明</span>
        <textarea
          className="skill-instructions-input"
          rows={12}
          spellCheck={false}
          value={instructions}
          placeholder="# 技能标题&#10;&#10;1. 触发条件…&#10;2. 执行步骤…&#10;3. 输出格式…"
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>
      <p className="hint">
        智能体只在描述匹配时才调用 use_skill 读取这里的完整说明，所以描述要具体、说明要可执行。
      </p>

      {error && <p className="form-error">{error}</p>}

      <div className="modal-actions">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "保存中…" : skill ? "保存技能" : "创建技能"}
        </button>
        <button className="btn ghost" type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}
