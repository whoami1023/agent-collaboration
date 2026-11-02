import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { Member } from "../../src/core/types";
import {
  applyTemplate,
  createTemplate,
  deleteTemplate,
  fetchTemplates,
  updateTemplate,
  type SkillCategory,
  type SkillCategoryView,
  type TemplateInput,
  type TemplateSnapshot,
  type TemplateView,
} from "./api";
import { Icon } from "./icons";

type TemplateTab = "builtin" | "personal";
type CategoryFilter = SkillCategory | "all";

type TemplateMode =
  | { kind: "list" }
  | { kind: "view"; template: TemplateView }
  | { kind: "apply"; template: TemplateView }
  | { kind: "create"; copyFrom?: TemplateView }
  | { kind: "edit"; template: TemplateView };

const TITLE_MAX = 40;
const DESCRIPTION_MAX = 160;
const BRIEF_MAX = 800;
const NAME_MAX = 12;
const EMOJI_MAX = 8;
const VIBE_MAX = 40;
const WORKSTYLE_MAX = 8;
const WORKSTYLE_LINE_MAX = 200;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function scopeLabel(scope: TemplateView["scope"]): string {
  return scope === "builtin" ? "内置" : "个人";
}

function skillCount(template: TemplateView): number {
  return template.skillNames?.length ?? 0;
}

export default function TemplateLibraryPanel({
  onClose,
  onApplied,
  takenNames,
}: {
  onClose: () => void;
  onApplied: (member: Member, template: TemplateView) => void;
  takenNames: string[];
}) {
  const [snapshot, setSnapshot] = useState<TemplateSnapshot | null>(null);
  const [tab, setTab] = useState<TemplateTab>("builtin");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<TemplateMode>({ kind: "list" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await fetchTemplates());
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

  async function handleDelete(template: TemplateView) {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteTemplate(template.id);
      setNotice(`已删除模板「${template.title}」`);
      setConfirmingId(null);
      setMode({ kind: "list" });
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setDeleting(false);
    }
  }

  const builtin = snapshot?.builtin ?? [];
  const personal = snapshot?.personal ?? [];
  const templates = tab === "builtin" ? builtin : personal;
  const categories = snapshot?.categories ?? [];
  const availableSkills = snapshot?.availableSkills ?? [];
  const categoryById = new Map<string, SkillCategoryView>(categories.map((item) => [item.id, item]));
  const categoryLabel = (id: SkillCategory): string => categoryById.get(id)?.label ?? "其他";

  const trimmed = query.trim();
  const normalizedQuery = trimmed.toLowerCase();
  const matching = templates.filter((template) => {
    if (!normalizedQuery) return true;
    return (
      template.title.toLowerCase().includes(normalizedQuery) ||
      template.description.toLowerCase().includes(normalizedQuery) ||
      template.brief.toLowerCase().includes(normalizedQuery) ||
      categoryLabel(template.category).includes(trimmed)
    );
  });
  const countByCategory = new Map<SkillCategory, number>();
  for (const template of matching) {
    countByCategory.set(template.category, (countByCategory.get(template.category) ?? 0) + 1);
  }
  // 只展示有内容的分类；当前选中的分类即使被搜索筛空也保留，避免筛选器突然消失。
  const chipCategories = categories.filter(
    (item) => (countByCategory.get(item.id) ?? 0) > 0 || categoryFilter === item.id,
  );
  const visible =
    categoryFilter === "all"
      ? matching
      : matching.filter((template) => template.category === categoryFilter);
  const groups =
    categoryFilter === "all"
      ? chipCategories.map((category) => ({
          category,
          items: matching.filter((template) => template.category === category.id),
        }))
      : [];

  const hint =
    tab === "builtin"
      ? "内置模板随系统预装，覆盖各类分工；点「引用为成员」就能把它变成一个可 @ 的子智能体，要改动请先另存为个人模板。"
      : "个人模板只有你自己能用，可以按团队习惯新建、修改或删除。";

  const renderCard = (template: TemplateView) => (
    <li key={template.id} className="skill-card template-card">
      <div className="skill-card-head">
        {template.emoji && <span className="template-emoji">{template.emoji}</span>}
        <span className="template-name">{template.title}</span>
        <span className="skill-owner">
          {template.scope === "builtin" ? (template.source ?? "随系统预装") : "仅自己可见"}
        </span>
      </div>
      <div className="skill-card-meta">
        <span className="chip skill-category-chip" title={categoryById.get(template.category)?.hint}>
          {categoryLabel(template.category)}
        </span>
        <span className={`chip${template.scope === "builtin" ? " accent" : ""}`}>
          {scopeLabel(template.scope)}
        </span>
        <span className="chip">
          {skillCount(template) > 0 ? `限定 ${skillCount(template)} 个技能` : "不限技能"}
        </span>
        {template.vibe && <span className="chip">{template.vibe}</span>}
      </div>
      <p className="skill-desc">{template.description}</p>
      <div className="skill-foot">
        <span className="skill-time">建议成员名 @{template.suggestedName}</span>
        <div className="skill-actions">
          <button
            type="button"
            className="btn primary sm"
            onClick={() => {
              setNotice(null);
              setMode({ kind: "apply", template });
            }}
          >
            引用为成员
          </button>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              setNotice(null);
              setMode({ kind: "view", template });
            }}
          >
            查看
          </button>
          {template.scope === "personal" ? (
            <>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  setNotice(null);
                  setMode({ kind: "edit", template });
                }}
              >
                编辑
              </button>
              {confirmingId === template.id ? (
                <>
                  <button
                    type="button"
                    className="btn danger sm"
                    disabled={deleting}
                    onClick={() => void handleDelete(template)}
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
                    setConfirmingId(template.id);
                  }}
                >
                  删除
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                setNotice(null);
                setMode({ kind: "create", copyFrom: template });
              }}
            >
              另存为个人模板
            </button>
          )}
        </div>
      </div>
    </li>
  );

  return (
    <div className="board-sheet skills-sheet templates-sheet">
      <div className="board-head">
        <span className="section-label">模板库</span>
        <div className="board-head-actions">
          <span className="chip">{builtin.length + personal.length}</span>
          <button
            type="button"
            className="btn icon ghost board-close"
            aria-label="刷新模板库"
            title="刷新模板库"
            onClick={() => void refresh()}
          >
            <Icon name="refresh" />
          </button>
          <button
            type="button"
            className="btn icon ghost board-close"
            aria-label="关闭模板库面板"
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
              <div className="skills-tabs" role="tablist" aria-label="模板范围">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "builtin"}
                  className={`skills-tab${tab === "builtin" ? " active" : ""}`}
                  onClick={() => {
                    setTab("builtin");
                    setCategoryFilter("all");
                    setConfirmingId(null);
                  }}
                >
                  内置模板
                  <span className="chip">{builtin.length}</span>
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
                  我的模板
                  <span className="chip">{personal.length}</span>
                </button>
              </div>

              <div className="skills-toolbar-actions">
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() => {
                    setNotice(null);
                    setMode({ kind: "create" });
                  }}
                >
                  <Icon name="plus" />
                  新建模板
                </button>
              </div>
            </div>
            <p className="hint">{hint}</p>

            <div className="skills-filters">
              <label className="skills-search">
                <Icon name="search" />
                <input
                  value={query}
                  placeholder="搜索模板名称、描述或分类"
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
              <p className="hint">正在加载模板…</p>
            ) : templates.length === 0 ? (
              <p className="empty small">
                {tab === "personal"
                  ? "你还没有个人模板。可以先从内置模板「另存为个人模板」，再按团队习惯改。"
                  : "内置模板为空。"}
              </p>
            ) : matching.length === 0 ? (
              <div className="skills-empty">
                <p className="empty small">没有匹配「{trimmed}」的模板。</p>
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
            ) : visible.length === 0 ? (
              <div className="skills-empty">
                <p className="empty small">
                  「{categoryLabel(categoryFilter as SkillCategory)}」下没有匹配的模板。
                </p>
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
              <ul className="skill-list">{visible.map(renderCard)}</ul>
            )}
          </>
        )}

        {mode.kind === "view" && (
          <TemplateDetail
            template={mode.template}
            categoryLabel={categoryLabel(mode.template.category)}
            onBack={backToList}
            onApply={() => setMode({ kind: "apply", template: mode.template })}
            onEdit={
              mode.template.scope === "personal"
                ? () => setMode({ kind: "edit", template: mode.template })
                : undefined
            }
            onSaveAs={
              mode.template.scope === "builtin"
                ? () => setMode({ kind: "create", copyFrom: mode.template })
                : undefined
            }
          />
        )}

        {mode.kind === "apply" && (
          <TemplateApplyView
            key={mode.template.id}
            template={mode.template}
            categoryLabel={categoryLabel(mode.template.category)}
            takenNames={takenNames}
            onCancel={() => setMode({ kind: "view", template: mode.template })}
            onApplied={(member, template) => {
              setNotice(null);
              onApplied(member, template);
            }}
          />
        )}

        {(mode.kind === "create" || mode.kind === "edit") && (
          <TemplateForm
            key={
              mode.kind === "edit"
                ? mode.template.id
                : `new-${mode.copyFrom?.id ?? "blank"}`
            }
            template={mode.kind === "edit" ? mode.template : undefined}
            copyFrom={mode.kind === "create" ? mode.copyFrom : undefined}
            categories={categories}
            availableSkills={availableSkills}
            onCancel={() =>
              mode.kind === "edit"
                ? setMode({ kind: "view", template: mode.template })
                : backToList()
            }
            onSaved={(template, created) => {
              setMode({ kind: "list" });
              setTab("personal");
              setNotice(
                created
                  ? `已创建个人模板「${template.title}」，在「我的模板」里可以引用`
                  : `已保存模板「${template.title}」`,
              );
              setError(null);
              void refresh();
            }}
          />
        )}
      </div>
    </div>
  );
}

function TemplateDetail({
  template,
  categoryLabel,
  onBack,
  onApply,
  onEdit,
  onSaveAs,
}: {
  template: TemplateView;
  categoryLabel: string;
  onBack: () => void;
  onApply: () => void;
  onEdit?: () => void;
  onSaveAs?: () => void;
}) {
  return (
    <div className="skill-detail template-detail">
      <div className="skill-detail-head">
        <button type="button" className="btn ghost sm" onClick={onBack}>
          ← 返回列表
        </button>
        <span className="template-name">
          {template.emoji && <span className="template-emoji">{template.emoji}</span>}
          {template.title}
        </span>
        <span className="chip skill-category-chip">{categoryLabel}</span>
        <span className={`chip${template.scope === "builtin" ? " accent" : ""}`}>
          {scopeLabel(template.scope)}
        </span>
        <button type="button" className="btn primary sm" onClick={onApply}>
          引用为成员
        </button>
        {onEdit && (
          <button type="button" className="btn sm" onClick={onEdit}>
            编辑
          </button>
        )}
        {onSaveAs && (
          <button type="button" className="btn sm" onClick={onSaveAs}>
            另存为个人模板
          </button>
        )}
      </div>
      <p className="skill-desc">{template.description}</p>
      <h4 className="template-section-title">角色设定</h4>
      <pre className="skill-read">{template.brief}</pre>
      {template.workstyle && template.workstyle.length > 0 && (
        <>
          <h4 className="template-section-title">工作方式</h4>
          <ul className="template-workstyle">
            {template.workstyle.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </>
      )}
      <h4 className="template-section-title">可用技能</h4>
      {skillCount(template) > 0 ? (
        <ul className="template-skill-tags">
          {(template.skillNames ?? []).map((name) => (
            <li key={name}>
              <span className="chip">{name}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">不限制：生成的成员能看到技能库里的全部技能。</p>
      )}
      <p className="hint">
        {template.scope === "builtin"
          ? `来源：${template.source ?? "本项目内置"} · 标识 ${template.key}`
          : `标识 ${template.key} · 更新于 ${new Date(template.updatedAt).toLocaleString()}`}
      </p>
    </div>
  );
}

/** 建议名撞上已有成员时，往后加序号，尽量给一个能直接用的名字。 */
function freeSuggestedName(base: string, taken: string[]): string {
  const used = new Set(taken.map((name) => name.toLowerCase()));
  const trimmed = base.trim() || "成员";
  if (!used.has(trimmed.toLowerCase())) return trimmed;
  for (let index = 2; index <= 50; index += 1) {
    const candidate = `${trimmed}-${index}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return "";
}

function TemplateApplyView({
  template,
  categoryLabel,
  takenNames,
  onCancel,
  onApplied,
}: {
  template: TemplateView;
  categoryLabel: string;
  takenNames: string[];
  onCancel: () => void;
  onApplied: (member: Member, template: TemplateView) => void;
}) {
  const [name, setName] = useState(() => freeSuggestedName(template.suggestedName, takenNames));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("请先确定成员名，群里用 @名字 找它。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await applyTemplate(template.id, trimmedName);
      onApplied(result.member, result.template);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="skill-form template-apply" onSubmit={(event) => void submit(event)}>
      <div className="skill-form-head">
        <span className="skill-form-title">
          引用模板创建成员
          <span className="chip">{template.title}</span>
        </span>
        <button type="button" className="btn ghost sm" onClick={onCancel}>
          返回
        </button>
      </div>

      <p className="hint">
        模板的角色设定、工作方式与技能范围会一起带过去，写进这个成员自己的智能体文件；
        创建后仍然可以在「智能体文件」里逐条修改。
      </p>

      <label className="field">
        <span>成员名</span>
        <input
          autoFocus
          value={name}
          maxLength={NAME_MAX}
          placeholder="例如：调研员"
          onChange={(event) => setName(event.target.value)}
        />
        <small className="form-note">
          1-{NAME_MAX} 个中英文、数字、下划线或短横线；群里用 @名字 引用
        </small>
      </label>

      <div className="template-apply-preview">
        <h4 className="template-section-title">将带入的设定</h4>
        <pre className="skill-read">{template.brief}</pre>
        <ul className="template-apply-facts">
          <li>
            <span>分类</span>
            <em>{categoryLabel}</em>
          </li>
          {template.emoji && (
            <li>
              <span>Emoji</span>
              <em>{template.emoji}</em>
            </li>
          )}
          {template.vibe && (
            <li>
              <span>气质</span>
              <em>{template.vibe}</em>
            </li>
          )}
          <li>
            <span>工作方式</span>
            <em>
              {template.workstyle?.length
                ? `${template.workstyle.length} 条`
                : "使用默认的四条约定"}
            </em>
          </li>
          <li>
            <span>技能范围</span>
            <em>{skillCount(template) ? `${skillCount(template)} 个技能` : "不限（技能库全部）"}</em>
          </li>
        </ul>
        {template.workstyle && template.workstyle.length > 0 && (
          <ul className="template-workstyle">
            {template.workstyle.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        )}
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="modal-actions">
        <button className="btn primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? "创建中…" : "创建成员"}
        </button>
        <button className="btn ghost" type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

function TemplateForm({
  template,
  copyFrom,
  categories,
  availableSkills,
  onCancel,
  onSaved,
}: {
  template?: TemplateView;
  copyFrom?: TemplateView;
  categories: SkillCategoryView[];
  availableSkills: Array<{ name: string; description: string }>;
  onCancel: () => void;
  onSaved: (template: TemplateView, created: boolean) => void;
}) {
  const source = template ?? copyFrom;
  const [title, setTitle] = useState(source?.title ?? "");
  const [description, setDescription] = useState(source?.description ?? "");
  const [suggestedName, setSuggestedName] = useState(source?.suggestedName ?? "");
  const [category, setCategory] = useState<SkillCategory>(source?.category ?? "other");
  const [brief, setBrief] = useState(source?.brief ?? "");
  const [emoji, setEmoji] = useState(source?.emoji ?? "");
  const [vibe, setVibe] = useState(source?.vibe ?? "");
  const [workstyleText, setWorkstyleText] = useState((source?.workstyle ?? []).join("\n"));
  const [skillNames, setSkillNames] = useState<string[]>(source?.skillNames ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workstyleLines = workstyleText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  function toggleSkill(name: string) {
    setSkillNames((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (workstyleLines.length > WORKSTYLE_MAX) {
      setError(`工作方式最多 ${WORKSTYLE_MAX} 条，一行一条，现在写了 ${workstyleLines.length} 条。`);
      return;
    }
    const payload: TemplateInput = {
      title,
      description,
      brief,
      category,
      suggestedName,
      emoji,
      vibe,
      workstyle: workstyleLines,
      skillNames,
    };
    setBusy(true);
    setError(null);
    try {
      if (template) onSaved(await updateTemplate(template.id, payload), false);
      else onSaved(await createTemplate(payload), true);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const isCopy = Boolean(copyFrom) && !template;

  return (
    <form className="skill-form template-form" onSubmit={(event) => void submit(event)}>
      <div className="skill-form-head">
        <span className="skill-form-title">
          {template ? "编辑个人模板" : isCopy ? "另存为个人模板" : "新建个人模板"}
          <span className="chip">个人</span>
        </span>
        <button type="button" className="btn ghost sm" onClick={onCancel}>
          返回
        </button>
      </div>

      {isCopy && (
        <p className="hint">
          复制自内置模板「{copyFrom?.title}」，改完保存就是你自己的模板，不会影响内置模板。
        </p>
      )}

      <label className="field">
        <span className="field-label">
          模板名称
          <em>
            {title.length}/{TITLE_MAX}
          </em>
        </span>
        <input
          autoFocus
          value={title}
          maxLength={TITLE_MAX}
          placeholder="例如：深度调研员"
          onChange={(event) => setTitle(event.target.value)}
        />
        <small className="form-note">标题会用作模板标识（自动生成），成员名默认取「建议成员名」。</small>
      </label>

      <label className="field">
        <span className="field-label">
          一句话描述
          <em>
            {description.length}/{DESCRIPTION_MAX}
          </em>
        </span>
        <input
          value={description}
          maxLength={DESCRIPTION_MAX}
          placeholder="这个模板适合干什么，卡片上直接展示。"
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>

      <div className="template-field-row">
        <label className="field">
          <span>建议成员名</span>
          <input
            value={suggestedName}
            maxLength={NAME_MAX}
            placeholder="例如：调研员"
            onChange={(event) => setSuggestedName(event.target.value)}
          />
        </label>
        <label className="field">
          <span>分类</span>
          <select value={category} onChange={(event) => setCategory(event.target.value as SkillCategory)}>
            {(categories.length > 0
              ? categories
              : [{ id: "other" as SkillCategory, label: "其他", hint: "尚未归类的模板" }]
            ).map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} · {item.hint}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Emoji</span>
          <input
            value={emoji}
            maxLength={EMOJI_MAX}
            placeholder="🔍"
            onChange={(event) => setEmoji(event.target.value)}
          />
        </label>
        <label className="field">
          <span>气质</span>
          <input
            value={vibe}
            maxLength={VIBE_MAX}
            placeholder="例如：查证狂"
            onChange={(event) => setVibe(event.target.value)}
          />
        </label>
      </div>

      <label className="field">
        <span className="field-label">
          角色设定
          <em>
            {brief.length}/{BRIEF_MAX}
          </em>
        </span>
        <textarea
          className="skill-instructions-input"
          rows={8}
          spellCheck={false}
          value={brief}
          maxLength={BRIEF_MAX}
          placeholder="负责什么、边界在哪、产出长什么样、什么情况交给别人。"
          onChange={(event) => setBrief(event.target.value)}
        />
        <small className="form-note">
          引用模板时作为成员的功能描述，写进 SOUL.md 并进入它的运行提示词。
        </small>
      </label>

      <label className="field">
        <span className="field-label">
          工作方式
          <em>
            {workstyleLines.length}/{WORKSTYLE_MAX} 条
          </em>
        </span>
        <textarea
          className="skill-instructions-input"
          rows={5}
          spellCheck={false}
          value={workstyleText}
          placeholder={"先明确目标与验收标准再动手\n每步都留下可核对的证据\n不确定就说不确定，并给出下一步"}
          onChange={(event) => setWorkstyleText(event.target.value)}
        />
        <small className="form-note">一行一条，最多 {WORKSTYLE_MAX} 条、每条 {WORKSTYLE_LINE_MAX} 字；留空则使用默认约定。</small>
      </label>

      <div className="template-skills-picker">
        <div className="skill-files-head">
          <span className="field-label">
            可用技能
            <em>{skillNames.length === 0 ? "不限制" : `已选 ${skillNames.length} 个`}</em>
          </span>
          {skillNames.length > 0 && (
            <button type="button" className="btn ghost sm" onClick={() => setSkillNames([])}>
              清空
            </button>
          )}
        </div>
        {availableSkills.length === 0 ? (
          <p className="hint">技能库还是空的，先到「技能库」创建或导入技能。</p>
        ) : (
          <ul className="agent-skills-list" aria-label="模板可用技能">
            {availableSkills.map((skill) => (
              <li key={skill.name}>
                <label className="agent-skill-row">
                  <input
                    type="checkbox"
                    checked={skillNames.includes(skill.name)}
                    onChange={() => toggleSkill(skill.name)}
                  />
                  <span className="agent-skill-main">
                    <span className="agent-skill-name">{skill.name}</span>
                    <span className="agent-skill-desc">{skill.description}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <p className="hint">
          不勾选表示成员沿用技能库全部技能；勾选后只有这些技能会出现在它的提示词里，
          引用时已删除的技能会被自动忽略。
        </p>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="modal-actions">
        <button
          className="btn primary"
          type="submit"
          disabled={busy || !title.trim() || !description.trim() || !brief.trim()}
        >
          {busy ? "保存中…" : template ? "保存模板" : "创建模板"}
        </button>
        <button className="btn ghost" type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}
