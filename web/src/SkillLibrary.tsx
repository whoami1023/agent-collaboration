import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  createSkill,
  deleteSkill,
  fetchSkills,
  updateSkill,
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
  | { kind: "edit"; skill: SkillView };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function scopeLabel(scope: SkillScope): string {
  return scope === "shared" ? "共享" : "个人";
}

export default function SkillLibraryDialog({ onClose }: { onClose: () => void }) {
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
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal-card wide skills-card"
        role="dialog"
        aria-modal="true"
        aria-label="技能库"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <strong>技能库</strong>
            <span className="modal-sub">
              共享技能全员可用 · 个人技能只属于你 · 智能体先读说明再执行
            </span>
          </div>
          <button type="button" className="btn icon ghost" aria-label="关闭" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        <div className="modal-body">
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
                {(tab === "personal" || canManageShared) && (
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
                )}
              </div>
              <p className="hint">{hint}</p>

              {!snapshot ? (
                <p className="hint">正在加载技能…</p>
              ) : skills.length === 0 ? (
                <p className="empty small">
                  {tab === "shared" ? "共享库还是空的。" : "你还没有个人技能，可以新建一个。"}
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
                        <span className="skill-owner">
                          {skill.builtin
                            ? "随系统预装"
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
                <span
                  className={`chip${mode.skill.scope === "shared" ? " accent" : ""}`}
                >
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
    </div>
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
          <em>
            {description.length}/160
          </em>
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
