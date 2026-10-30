import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import {
  createSkill,
  deleteSkill,
  fetchSkillFile,
  fetchSkills,
  importSkills,
  updateSkill,
  type SkillCategory,
  type SkillCategoryView,
  type SkillFileInput,
  type SkillFileView,
  type SkillImportResult,
  type SkillScope,
  type SkillSnapshot,
  type SkillView,
} from "./api";
import { Icon } from "./icons";

type SkillTab = "shared" | "personal";
type CategoryFilter = SkillCategory | "all";

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

const MAX_SKILL_MD_BYTES = 256 * 1024;
const MAX_IMPORT_ENTRIES = 200;
const MAX_SKILL_FILES = 40;
const SKILL_ENTRY_RE = /(?:^|\/)SKILL\.md$/i;
/** macOS/Windows 压缩与目录遍历产生的噪音文件，与服务端一致地丢弃。 */
const IGNORED_PATH_RE = /(^|\/)(?:__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$|\/\.)/i;

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 浏览器里的一个待上传文件：文本按 utf8 存，图片等二进制转 base64。 */
interface PendingFile {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  size: number;
}

async function readPendingFile(file: File, path: string): Promise<PendingFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return {
      path,
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "utf8",
      size: bytes.byteLength,
    };
  } catch {
    return { path, content: toBase64(bytes), encoding: "base64", size: bytes.byteLength };
  }
}

function pendingToInput(file: PendingFile): SkillFileInput {
  return { path: file.path, content: file.content, encoding: file.encoding };
}

/** 待导入清单按 SKILL.md 所在目录分组，与服务端一致地给出"几个技能、几个附带文件"。 */
function pendingSummary(entries: PendingFile[]): string {
  const roots = entries.filter((file) => SKILL_ENTRY_RE.test(file.path)).length;
  if (roots === 0) return `${entries.length} 个文件，缺少 SKILL.md`;
  const extras = entries.length - roots;
  return `${roots} 个技能${extras ? ` · ${extras} 个附带文件` : ""}`;
}

function pendingBytes(entries: { size: number }[]): number {
  return entries.reduce((sum, file) => sum + file.size, 0);
}

function viewedToInput(file: SkillFileView, content: string): SkillFileInput {
  return { path: file.path, content, encoding: file.encoding };
}

/** 打包成一个技能的目录里，SKILL.md 之外还能有脚本、参考资料、模板。 */
function fileCountLabel(skill: SkillView): string | null {
  const count = skill.files?.length ?? 0;
  if (count === 0) return null;
  const total = (skill.files ?? []).reduce((sum, file) => sum + file.size, 0);
  return `${count} 个附带文件 · ${formatBytes(total)}`;
}

/** 附带文件按目录分组展示，顺序和存储里一致（按路径排序）。 */
function filesOf(skill: SkillView): SkillFileView[] {
  return skill.files ?? [];
}

export default function SkillLibraryPanel({ onClose }: { onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<SkillSnapshot | null>(null);
  const [tab, setTab] = useState<SkillTab>("shared");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [query, setQuery] = useState("");
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

  const categories = snapshot?.categories ?? [];
  const categoryById = new Map(categories.map((item) => [item.id, item]));
  const categoryLabel = (id: SkillCategory): string => categoryById.get(id)?.label ?? "其他";
  const normalizedQuery = query.trim().toLowerCase();
  const matching = skills.filter((skill) => {
    if (!normalizedQuery) return true;
    return (
      skill.name.toLowerCase().includes(normalizedQuery) ||
      skill.description.toLowerCase().includes(normalizedQuery) ||
      categoryLabel(skill.category).includes(query.trim())
    );
  });
  const countByCategory = new Map<SkillCategory, number>();
  for (const skill of matching) {
    countByCategory.set(skill.category, (countByCategory.get(skill.category) ?? 0) + 1);
  }
  // 只展示有内容的分类；当前选中的分类即使被搜索筛空也保留，避免筛选器突然消失。
  const chipCategories = categories.filter(
    (item) => (countByCategory.get(item.id) ?? 0) > 0 || categoryFilter === item.id,
  );
  const visibleSkills =
    categoryFilter === "all"
      ? matching
      : matching.filter((skill) => skill.category === categoryFilter);
  const groups =
    categoryFilter === "all"
      ? chipCategories.map((category) => ({
          category,
          items: matching.filter((skill) => skill.category === category.id),
        }))
      : [];

  const hint =
    tab === "shared"
      ? canManageShared
        ? "共享技能对全部账号的智能体可见，只有管理员可以新建、编辑或删除。"
        : "共享技能由管理员维护；你和你的智能体都可以直接使用。"
      : "个人技能只有你自己的主智能体与子成员能用，其他账号看不到。";

  const renderCard = (skill: SkillView) => (
    <li key={skill.id} className="skill-card">
      <div className="skill-card-head">
        <span className="skill-name">{skill.name}</span>
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
      <div className="skill-card-meta">
        <span className="chip skill-category-chip" title={categoryById.get(skill.category)?.hint}>
          {categoryLabel(skill.category)}
        </span>
        <span className={`chip${skill.scope === "shared" ? " accent" : ""}`}>
          {scopeLabel(skill.scope)}
        </span>
        {skill.builtin && <span className="chip">内置</span>}
        {skill.imported && <span className="chip">导入</span>}
        {fileCountLabel(skill) && <span className="chip">{fileCountLabel(skill)}</span>}
      </div>
      <p className="skill-desc">{skill.description}</p>
      <div className="skill-foot">
        <span className="skill-time">更新于 {new Date(skill.updatedAt).toLocaleDateString()}</span>
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
  );

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
                  setCategoryFilter("all");
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
                  setCategoryFilter("all");
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

            <div className="skills-filters">
              <label className="skills-search">
                <Icon name="search" />
                <input
                  value={query}
                  placeholder="搜索技能名称、描述或分类"
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query && (
                  <button
                    type="button"
                    className="skills-search-clear"
                    aria-label="清除搜索"
                    onClick={() => setQuery("")}
                  >
                    <Icon name="close" />
                  </button>
                )}
              </label>
              {snapshot && (
                <div className="skill-cats" aria-label="按分类筛选">
                  <button
                    type="button"
                    className={`skill-cat${categoryFilter === "all" ? " active" : ""}`}
                    aria-pressed={categoryFilter === "all"}
                    onClick={() => setCategoryFilter("all")}
                  >
                    全部
                    <span>{matching.length}</span>
                  </button>
                  {chipCategories.map((category) => (
                    <button
                      key={category.id}
                      type="button"
                      className={`skill-cat${categoryFilter === category.id ? " active" : ""}`}
                      aria-pressed={categoryFilter === category.id}
                      title={category.hint}
                      onClick={() => setCategoryFilter(category.id)}
                    >
                      {category.label}
                      <span>{countByCategory.get(category.id) ?? 0}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {!snapshot ? (
              <p className="hint">正在加载技能…</p>
            ) : skills.length === 0 ? (
              <p className="empty small">
                {tab === "shared"
                  ? "共享库还是空的。"
                  : "你还没有个人技能，可以新建一个，或导入现成的 SKILL.md。"}
              </p>
            ) : matching.length === 0 ? (
              <div className="skills-empty">
                <p className="empty small">没有匹配「{query.trim()}」的技能。</p>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => {
                    setQuery("");
                    setCategoryFilter("all");
                  }}
                >
                  清除筛选
                </button>
              </div>
            ) : visibleSkills.length === 0 ? (
              <div className="skills-empty">
                <p className="empty small">「{categoryLabel(categoryFilter as SkillCategory)}」下没有匹配的技能。</p>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setCategoryFilter("all")}
                >
                  查看全部分类
                </button>
              </div>
            ) : categoryFilter === "all" ? (
              <div className="skill-groups">
                {groups.map((group) => (
                  <section key={group.category.id} className="skill-group">
                    <div className="skill-group-head">
                      <span className="skill-group-title">{group.category.label}</span>
                      <span className="chip">{group.items.length}</span>
                      <span className="skill-group-hint">{group.category.hint}</span>
                    </div>
                    <ul className="skill-list">{group.items.map(renderCard)}</ul>
                  </section>
                ))}
              </div>
            ) : (
              <ul className="skill-list">{visibleSkills.map(renderCard)}</ul>
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
              <span className="chip skill-category-chip" title={categoryById.get(mode.skill.category)?.hint}>
                {categoryLabel(mode.skill.category)}
              </span>
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
            <SkillFilesView key={mode.skill.id} skill={mode.skill} />
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
            categories={categories}
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

/** React 的类型里没有这个非标准的「选整个目录」属性。 */
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
      if (IGNORED_PATH_RE.test(path)) continue;
      if (loaded.length + files.length >= MAX_IMPORT_ENTRIES) {
        skipped.push(`单次最多 ${MAX_IMPORT_ENTRIES} 个文件，其余请分批发起导入`);
        break;
      }
      if (file.size > MAX_SKILL_MD_BYTES) {
        skipped.push(`${path} 超过 256 KB`);
        continue;
      }
      try {
        loaded.push(await readPendingFile(file, path));
      } catch (err) {
        skipped.push(`${path} 读取失败：${messageOf(err)}`);
      }
    }
    const merged = new Map(files.map((file) => [file.path.toLowerCase(), file]));
    for (const file of loaded) merged.set(file.path.toLowerCase(), file);
    const combined = [...merged.values()];
    if (loaded.length) setFiles(combined);
    setResults(null);
    if (skipped.length) setError(`部分文件未加入：${skipped.join("；")}。`);
    else if (!combined.some((file) => SKILL_ENTRY_RE.test(file.path))) {
      setError(
        fromFolder
          ? "这个目录里没有 SKILL.md。技能是一个装有 SKILL.md 的文件夹，脚本与资料会随它一起导入。"
          : "没找到 SKILL.md：请直接选 SKILL.md，或改用「选择技能文件夹」。",
      );
    }
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

  function removeFile(path: string) {
    setFiles((current) => current.filter((file) => file.path !== path));
    setResults(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const payload: PendingFile[] = [...files];
    if (pasted.trim()) {
      payload.push({
        path: "pasted/SKILL.md",
        content: pasted,
        encoding: "utf8",
        size: new TextEncoder().encode(pasted).length,
      });
    }
    if (!payload.length) {
      setError("请选择技能文件夹或 SKILL.md，也可以把 SKILL.md 内容粘贴到文本框。");
      return;
    }
    if (payload.length > MAX_IMPORT_ENTRIES) {
      setError(`单次最多 ${MAX_IMPORT_ENTRIES} 个文件（含附带文件），请减少数量或分批发起导入。`);
      return;
    }
    if (!payload.some((file) => SKILL_ENTRY_RE.test(file.path))) {
      setError("待导入内容里没有 SKILL.md，无法识别技能。");
      return;
    }
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const response = await importSkills({
        scope,
        overwrite,
        files: payload.map((item) => ({
          filename: item.path,
          content: item.content,
          encoding: item.encoding,
        })),
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
        一个技能是一个文件夹：SKILL.md 是入口（frontmatter 的 name / description 作为技能名与描述，
        正文作为完整说明），scripts/、references/ 等附带文件会一起导入，智能体用 read_skill_file 读取。
        可以直接选整个技能文件夹、多选 SKILL.md，或粘贴内容。
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
          {files.length
            ? `${pendingSummary(files)} · ${formatBytes(pendingBytes(files))}`
            : "整个技能文件夹（含脚本、资料），或单个 SKILL.md"}
        </span>
      </div>

      {files.length > 0 && (
        <ul className="skill-import-files">
          {files.map((file) => (
            <li key={file.path}>
              <span
                className={`skill-import-file-name${
                  SKILL_ENTRY_RE.test(file.path) ? " entry" : ""
                }`}
                title={file.path}
              >
                {file.path}
                {SKILL_ENTRY_RE.test(file.path) && <em className="skill-file-tag">入口</em>}
                {file.encoding === "base64" && <em className="skill-file-tag">二进制</em>}
              </span>
              <span className="skill-import-file-size">{formatBytes(file.size)}</span>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => removeFile(file.path)}
              >
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
        同名技能直接覆盖（更新描述、说明与附带文件）
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

/** 详情里的附带文件清单：点开才按需拉正文，二进制只说明大小。 */
function SkillFilesView({ skill }: { skill: SkillView }) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const files = filesOf(skill);
  if (files.length === 0) return null;

  async function toggle(file: SkillFileView) {
    setError(null);
    if (openPath === file.path) {
      setOpenPath(null);
      setPreview(null);
      return;
    }
    setOpenPath(file.path);
    setPreview(null);
    setNote(null);
    if (file.encoding === "base64") {
      setNote(`二进制文件（${formatBytes(file.size)}），作战室内不预览正文。智能体可读取路径与大小。`);
      return;
    }
    setBusy(true);
    try {
      const content = await fetchSkillFile(skill.id, file.path);
      const text = content.content;
      const limit = 20000;
      setPreview(text.length > limit ? `${text.slice(0, limit)}\n…（共 ${text.length} 字符，已截断）` : text);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="skill-files-view">
      <div className="skill-files-head">
        <span className="field-label">
          附带文件
          <em>{files.length} 个 · {formatBytes(pendingBytes(files))}</em>
        </span>
        <span className="hint">智能体用 read_skill_file 按路径读取</span>
      </div>
      <ul className="skill-files-list">
        {files.map((file) => (
          <li key={file.path} className={`skill-file-row${openPath === file.path ? " open" : ""}`}>
            <button type="button" className="skill-file-toggle" onClick={() => void toggle(file)}>
              <span className="skill-import-file-name" title={file.path}>
                {file.path}
              </span>
              <span className="skill-import-file-size">
                {formatBytes(file.size)}
                {file.encoding === "base64" && <em className="skill-file-tag">二进制</em>}
              </span>
              <span className="skill-file-hint">{openPath === file.path ? "收起" : "查看"}</span>
            </button>
            {openPath === file.path && (
              <div className="skill-file-body">
                {error && <p className="form-error">{error}</p>}
                {busy && <p className="hint">正在读取…</p>}
                {note && <p className="hint">{note}</p>}
                {preview !== null && <pre className="skill-read">{preview}</pre>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SkillForm({
  scope,
  skill,
  categories,
  onCancel,
  onSaved,
}: {
  scope: SkillScope;
  skill?: SkillView;
  categories: SkillCategoryView[];
  onCancel: () => void;
  onSaved: (skill: SkillView, created: boolean) => void;
}) {
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [instructions, setInstructions] = useState(skill?.instructions ?? "");
  const [category, setCategory] = useState<SkillCategory>(skill?.category ?? "other");
  /** 库里已有且本次继续保留的附带文件：只带元信息，正文在保存时按需取回。 */
  const [kept, setKept] = useState<SkillFileView[]>(skill?.files ?? []);
  const [added, setAdded] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachInput = useRef<HTMLInputElement>(null);
  const attachFolderInput = useRef<HTMLInputElement>(null);

  async function addAttachments(picked: File[], fromFolder: boolean) {
    if (!picked.length) return;
    setError(null);
    const loaded: PendingFile[] = [];
    const skipped: string[] = [];
    let skippedEntryFiles = 0;
    for (const file of picked) {
      let path = file.webkitRelativePath || file.name;
      // 文件夹选择器给的路径带技能目录名，技能内部按目录根来存。
      if (fromFolder) path = path.split("/").slice(1).join("/") || path;
      if (IGNORED_PATH_RE.test(path)) continue;
      if (SKILL_ENTRY_RE.test(path)) {
        skippedEntryFiles += 1;
        continue;
      }
      if (loaded.length + kept.length + added.length >= MAX_SKILL_FILES) {
        skipped.push(`单个技能最多 ${MAX_SKILL_FILES} 个附带文件`);
        break;
      }
      if (file.size > MAX_SKILL_MD_BYTES) {
        skipped.push(`${path} 超过 256 KB`);
        continue;
      }
      try {
        loaded.push(await readPendingFile(file, path));
      } catch (err) {
        skipped.push(`${path} 读取失败：${messageOf(err)}`);
      }
    }
    if (loaded.length) {
      const byPath = new Map(added.map((file) => [file.path.toLowerCase(), file]));
      for (const file of loaded) byPath.set(file.path.toLowerCase(), file);
      setAdded([...byPath.values()]);
      setKept((current) =>
        current.filter((file) => !byPath.has(file.path.toLowerCase())),
      );
    }
    const notes: string[] = [];
    if (skippedEntryFiles) notes.push("SKILL.md 是技能说明本身，请写在下面的「完整说明」里，已自动跳过");
    if (skipped.length) notes.push(`部分文件未加入：${skipped.join("；")}`);
    setError(notes.length ? `${notes.join("；")}。` : null);
  }

  function handlePickFiles(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    void addAttachments(picked, false);
  }

  function handlePickFolder(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    void addAttachments(picked, true);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload = { name, description, instructions, category };
      let files: SkillFileInput[] | undefined;
      if (skill) {
        const retained = await Promise.all(
          kept.map(async (file) =>
            viewedToInput(file, (await fetchSkillFile(skill.id, file.path)).content),
          ),
        );
        files = [...retained, ...added.map(pendingToInput)];
      } else if (added.length) {
        files = added.map(pendingToInput);
      }
      if (skill) {
        onSaved(await updateSkill(skill.id, { ...payload, ...(files ? { files } : {}) }), false);
      } else {
        onSaved(await createSkill({ scope, ...payload, ...(files ? { files } : {}) }), true);
      }
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const attachmentCount = kept.length + added.length;

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
        <span>分类</span>
        <select value={category} onChange={(event) => setCategory(event.target.value as SkillCategory)}>
          {(categories.length > 0
            ? categories
            : [{ id: "other" as SkillCategory, label: "其他", hint: "尚未归类的技能" }]
          ).map((item) => (
            <option key={item.id} value={item.id}>
              {item.label} · {item.hint}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">分类只影响技能库的筛选与分组，不影响智能体调用。</p>

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

      <div className="skill-files-editor">
        <div className="skill-files-head">
          <span className="field-label">
            附带文件
            <em>{attachmentCount ? `已选 ${attachmentCount} 个` : "可选"}</em>
          </span>
          <input
            ref={attachInput}
            type="file"
            multiple
            hidden
            onChange={handlePickFiles}
          />
          <input
            ref={attachFolderInput}
            type="file"
            multiple
            hidden
            onChange={handlePickFolder}
            {...FOLDER_PICK_ATTRS}
          />
          <span className="skill-files-actions">
            <button type="button" className="btn ghost sm" onClick={() => attachInput.current?.click()}>
              <Icon name="import" />
              添加文件
            </button>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => attachFolderInput.current?.click()}
            >
              <Icon name="folder" />
              添加文件夹
            </button>
          </span>
        </div>
        {(kept.length > 0 || added.length > 0) && (
          <ul className="skill-files-list">
            {kept.map((file) => (
              <li key={file.path} className="skill-file-row">
                <span className="skill-import-file-name" title={file.path}>
                  {file.path}
                </span>
                <span className="skill-import-file-size">
                  {formatBytes(file.size)}
                  {file.encoding === "base64" && <em className="skill-file-tag">二进制</em>}
                </span>
                <button
                  type="button"
                  className="btn ghost sm danger"
                  onClick={() => setKept((current) => current.filter((item) => item.path !== file.path))}
                >
                  删除
                </button>
              </li>
            ))}
            {added.map((file) => (
              <li key={`${file.path}-new`} className="skill-file-row new">
                <span className="skill-import-file-name" title={file.path}>
                  {file.path}
                  <em className="skill-file-tag">新添加</em>
                </span>
                <span className="skill-import-file-size">
                  {formatBytes(file.size)}
                  {file.encoding === "base64" && <em className="skill-file-tag">二进制</em>}
                </span>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setAdded((current) => current.filter((item) => item.path !== file.path))}
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="hint">
          脚本、参考资料、模板会随技能一起保存，智能体用 read_skill_file 按路径读取。
          单个文件不超过 256 KB，一个技能最多 {MAX_SKILL_FILES} 个、合计 2 MB。
        </p>
      </div>

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
