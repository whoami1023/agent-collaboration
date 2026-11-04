import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { Member } from "../../src/core/types";
import {
  MAIN_ROOM_ID,
  createRoom,
  deleteRoom,
  fetchPoolMembers,
  fetchRoomMembers,
  inviteRoomMember,
  kickRoomMember,
  updateRoom,
  type RoomInfo,
} from "./api";
import { Icon } from "./icons";

type RoomsTab = "list" | "members";

function initialOf(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "?";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 群聊区：房间列表 + 每间群聊的花名册。
 * 进入某间群后，主界面仍是同一套聊天/看板/归档，只是所有请求都带上了该房间的 `?room=`。
 */
export default function RoomsPanel({
  rooms,
  activeRoomId,
  onEnter,
  onClose,
  onChanged,
  initialTab = "list",
}: {
  rooms: RoomInfo[] | null;
  activeRoomId: string;
  onEnter: (roomId: string) => void;
  onClose: () => void;
  /** 新建/改名/删群或拉人/移人之后：外层重拉房间列表与当前房间视图。 */
  onChanged: () => Promise<void> | void;
  initialTab?: RoomsTab;
}) {
  const [tab, setTab] = useState<RoomsTab>(initialTab);
  const [pool, setPool] = useState<Member[] | null>(null);
  const [rosterRoomId, setRosterRoomId] = useState(
    activeRoomId === MAIN_ROOM_ID ? "" : activeRoomId,
  );
  const [roster, setRoster] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createTopic, setCreateTopic] = useState("");
  const [createMemberIds, setCreateMemberIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editTopic, setEditTopic] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const groups = useMemo(
    () => (rooms ?? []).filter((room) => room.kind === "group"),
    [rooms],
  );
  const currentRoom = rooms?.find((room) => room.id === activeRoomId) ?? null;
  const targetRoomId =
    rosterRoomId && groups.some((room) => room.id === rosterRoomId)
      ? rosterRoomId
      : (groups[0]?.id ?? "");

  const refreshPool = useCallback(async () => {
    try {
      setPool(await fetchPoolMembers());
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  const refreshRoster = useCallback(async (roomId: string) => {
    if (!roomId) {
      setRoster([]);
      return;
    }
    try {
      setRoster(await fetchRoomMembers(roomId));
    } catch (err) {
      setRoster([]);
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void refreshPool();
  }, [refreshPool]);

  // 面板已经打开时，从侧边栏「拉成员进群」进来也要切到成员页。
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (!targetRoomId) {
      setRoster(null);
      return;
    }
    void refreshRoster(targetRoomId);
  }, [targetRoomId, refreshRoster]);

  async function afterChange(message?: string) {
    if (message) setNotice(message);
    await onChanged();
    await refreshPool();
    if (targetRoomId) await refreshRoster(targetRoomId);
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy("create");
    setError(null);
    setNotice(null);
    try {
      const room = await createRoom({
        name: createName,
        topic: createTopic,
        memberIds: createMemberIds,
      });
      setCreating(false);
      setCreateName("");
      setCreateTopic("");
      setCreateMemberIds([]);
      await onChanged();
      onEnter(room.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  function openEdit(room: RoomInfo) {
    setEditingId(room.id);
    setEditName(room.name);
    setEditTopic(room.topic ?? "");
    setConfirmingId(null);
    setError(null);
  }

  async function handleRename(event: FormEvent) {
    event.preventDefault();
    if (!editingId || busy) return;
    setBusy("rename");
    setError(null);
    try {
      await updateRoom(editingId, { name: editName, topic: editTopic });
      setEditingId(null);
      await afterChange("已更新群聊信息。");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(room: RoomInfo) {
    if (busy) return;
    setBusy(`delete:${room.id}`);
    setError(null);
    try {
      await deleteRoom(room.id);
      setConfirmingId(null);
      if (rosterRoomId === room.id) setRosterRoomId("");
      // 删掉的正好是当前房间：外层会回落到作战室；否则只刷新列表。
      await onChanged();
      if (room.id !== activeRoomId) await afterChange(`已删除群聊「${room.name}」。`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleInvite(member: Member) {
    if (!targetRoomId || busy) return;
    setBusy(`invite:${member.id}`);
    setError(null);
    setNotice(null);
    try {
      await inviteRoomMember(targetRoomId, member.id);
      await afterChange(`已把 @${member.name} 拉进群。`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleKick(member: Member) {
    if (!targetRoomId || busy) return;
    const roomName = rooms?.find((room) => room.id === targetRoomId)?.name ?? "本群";
    if (
      !window.confirm(
        `把 @${member.name} 移出「${roomName}」？历史消息会保留，它在作战室与其他群聊里不受影响。`,
      )
    ) {
      return;
    }
    setBusy(`kick:${member.id}`);
    setError(null);
    setNotice(null);
    try {
      await kickRoomMember(targetRoomId, member.id);
      await afterChange(`已把 @${member.name} 移出群聊。`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  function toggleCreateMember(memberId: string) {
    setCreateMemberIds((current) =>
      current.includes(memberId)
        ? current.filter((id) => id !== memberId)
        : [...current, memberId],
    );
  }

  const rosterIds = new Set((roster ?? []).map((member) => member.id));
  const mainMember = (roster ?? pool ?? []).find((member) => member.role === "main");
  const inviteCandidates = (pool ?? []).filter((member) => !rosterIds.has(member.id));

  return (
    <div className="board-sheet skills-sheet rooms-sheet">
      <div className="board-head">
        <span className="section-label">群聊区</span>
        <div className="board-head-actions">
          <span className="chip">{groups.length}</span>
          <button
            type="button"
            className="btn icon ghost board-close"
            aria-label="关闭群聊区"
            title="关闭面板，回到聊天"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
      </div>

      <div className="board-body skills-body">
        {error && <p className="form-error">{error}</p>}
        {notice && <p className="form-note">{notice}</p>}

        <div className="skills-toolbar">
          <div className="skills-tabs" role="tablist" aria-label="群聊区视图">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "list"}
              className={`skills-tab${tab === "list" ? " active" : ""}`}
              onClick={() => setTab("list")}
            >
              群聊
              <span className="chip">{groups.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "members"}
              className={`skills-tab${tab === "members" ? " active" : ""}`}
              onClick={() => setTab("members")}
            >
              本群成员
            </button>
          </div>
          {tab === "list" && !creating && (
            <div className="skills-toolbar-actions">
              <button
                type="button"
                className="btn primary sm"
                onClick={() => {
                  setCreating(true);
                  setNotice(null);
                  setError(null);
                }}
              >
                <Icon name="plus" />
                新建群聊
              </button>
            </div>
          )}
        </div>

        {tab === "list" && (
          <>
            {creating && (
              <form className="rooms-create" onSubmit={(event) => void handleCreate(event)}>
                <div className="skill-form-head">
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => setCreating(false)}
                  >
                    <Icon name="back" />
                    返回列表
                  </button>
                  <span className="skill-form-title">新建群聊</span>
                </div>
                <label className="field">
                  <span>群聊名称</span>
                  <input
                    value={createName}
                    maxLength={40}
                    placeholder="例如：架构评审"
                    autoFocus
                    onChange={(event) => setCreateName(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>主题（可选）</span>
                  <input
                    value={createTopic}
                    maxLength={200}
                    placeholder="这个群主要讨论什么"
                    onChange={(event) => setCreateTopic(event.target.value)}
                  />
                </label>
                <div className="field">
                  <span>从成员池拉人（主智能体默认在场）</span>
                  <div className="rooms-pick">
                    {(pool ?? []).map((member) => {
                      const checked =
                        member.role === "main"
                          ? true
                          : createMemberIds.includes(member.id);
                      return (
                        <label
                          key={member.id}
                          className={`rooms-pick-item${checked ? " checked" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={member.role === "main"}
                            onChange={() => toggleCreateMember(member.id)}
                          />
                          <span className="member-avatar sm">{initialOf(member.name)}</span>
                          <span className="rooms-pick-name">@{member.name}</span>
                          <span className="rooms-pick-role">
                            {member.role === "main" ? "主智能体" : "成员"}
                          </span>
                        </label>
                      );
                    })}
                    {pool !== null && pool.length === 0 && (
                      <p className="hint">成员池还是空的：先回作战室「新建成员」。</p>
                    )}
                  </div>
                </div>
                <div className="cron-actions">
                  <button type="submit" className="btn primary sm" disabled={busy === "create"}>
                    {busy === "create" ? "正在创建…" : "创建并进入"}
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => setCreating(false)}
                  >
                    取消
                  </button>
                </div>
              </form>
            )}

            {!creating && !rooms ? (
              <p className="empty small">正在读取群聊…</p>
            ) : !creating && groups.length === 0 ? (
              <div className="skills-empty">
                <p className="empty small">
                  还没有群聊。新建一个群，把成员拉进来，就能像作战室一样讨论与派活；
                  每间群都有独立的聊天记录、任务卡与归档。
                </p>
              </div>
            ) : null}

            {!creating && rooms && (
              <ul className="room-list">
                {rooms.map((room) => {
                  const isMain = room.id === MAIN_ROOM_ID;
                  const isActive = room.id === activeRoomId;
                  return (
                    <li
                      key={room.id}
                      className={`room-card${isActive ? " active" : ""}${isMain ? " warroom" : ""}`}
                    >
                      {editingId === room.id ? (
                        <form className="room-edit" onSubmit={(event) => void handleRename(event)}>
                          <label className="field">
                            <span>群聊名称</span>
                            <input
                              value={editName}
                              maxLength={40}
                              autoFocus
                              onChange={(event) => setEditName(event.target.value)}
                            />
                          </label>
                          <label className="field">
                            <span>主题（可选）</span>
                            <input
                              value={editTopic}
                              maxLength={200}
                              onChange={(event) => setEditTopic(event.target.value)}
                            />
                          </label>
                          <div className="cron-actions">
                            <button
                              type="submit"
                              className="btn primary sm"
                              disabled={busy === "rename"}
                            >
                              保存
                            </button>
                            <button
                              type="button"
                              className="btn ghost sm"
                              onClick={() => setEditingId(null)}
                            >
                              取消
                            </button>
                          </div>
                        </form>
                      ) : (
                        <>
                          <div className="room-card-head">
                            <span className="room-card-icon">
                              <Icon name={isMain ? "chat" : "users"} size={15} />
                            </span>
                            <div className="room-card-title">
                              <strong>{isMain ? `${room.name}（作战室）` : room.name}</strong>
                              {room.topic && <span className="room-topic">{room.topic}</span>}
                            </div>
                            {isActive && <span className="room-active-pill">当前</span>}
                          </div>
                          <p className="room-card-meta">
                            <span>{room.memberCount} 位成员</span>
                            <span>{room.messageCount} 条消息</span>
                            <span>{room.taskCount} 张任务卡</span>
                            {room.runningCount > 0 && (
                              <span className="room-running">{room.runningCount} 运行中</span>
                            )}
                          </p>
                          <div className="cron-actions">
                            <button
                              type="button"
                              className="btn ghost sm"
                              disabled={isActive}
                              onClick={() => onEnter(room.id)}
                            >
                              {isActive ? "正在这里" : "进入"}
                            </button>
                            {!isMain && (
                              <button
                                type="button"
                                className="btn ghost sm"
                                onClick={() => openEdit(room)}
                              >
                                改名
                              </button>
                            )}
                            {!isMain &&
                              (confirmingId === room.id ? (
                                <span className="cron-confirm">
                                  确认删除？
                                  <button
                                    type="button"
                                    className="btn danger sm"
                                    disabled={busy === `delete:${room.id}`}
                                    onClick={() => void handleDelete(room)}
                                  >
                                    删除
                                  </button>
                                  <button
                                    type="button"
                                    className="btn ghost sm"
                                    onClick={() => setConfirmingId(null)}
                                  >
                                    取消
                                  </button>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="btn ghost sm"
                                  onClick={() => setConfirmingId(room.id)}
                                >
                                  删除
                                </button>
                              ))}
                          </div>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <p className="hint">
              每间群聊都有自己的聊天记录、任务卡与归档；成员档案、技能与文件工作区是全账号共享的。
              进入群后，界面与作战室完全相同。
            </p>
          </>
        )}

        {tab === "members" && (
          <>
            {groups.length === 0 ? (
              <div className="skills-empty">
                <p className="empty small">还没有群聊，先在「群聊」里新建一个。</p>
              </div>
            ) : (
              <>
                <label className="field">
                  <span>选择群聊</span>
                  <select
                    value={targetRoomId}
                    onChange={(event) => setRosterRoomId(event.target.value)}
                  >
                    {groups.map((room) => (
                      <option key={room.id} value={room.id}>
                        {room.name}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="rooms-section-head">
                  <span className="section-label">群里的成员</span>
                  <span className="chip">{roster?.length ?? 0}</span>
                </div>
                {roster === null ? (
                  <p className="empty small">正在读取花名册…</p>
                ) : (
                  <ul className="rooms-member-list">
                    {roster.map((member) => (
                      <li key={member.id} className="rooms-member">
                        <span className="member-avatar">
                          {initialOf(member.name)}
                          <span className={`status-dot ${member.status}`} />
                        </span>
                        <div className="rooms-member-main">
                          <span className="member-name">@{member.name}</span>
                          <span className="room-card-meta">
                            {member.role === "main"
                              ? "主智能体"
                              : member.status === "running"
                                ? "运行中"
                                : "成员"}
                          </span>
                        </div>
                        {member.role === "main" ? (
                          <span className="chip">常驻</span>
                        ) : (
                          <button
                            type="button"
                            className="btn ghost sm"
                            disabled={busy === `kick:${member.id}`}
                            onClick={() => void handleKick(member)}
                          >
                            移出
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                <div className="rooms-section-head">
                  <span className="section-label">成员池里还没进群的人</span>
                  <span className="chip">{inviteCandidates.length}</span>
                </div>
                {inviteCandidates.length === 0 ? (
                  <p className="hint">
                    成员池里的人都已经在群里了。要新增成员，回作战室「新建成员」。
                  </p>
                ) : (
                  <ul className="rooms-member-list">
                    {inviteCandidates.map((member) => (
                      <li key={member.id} className="rooms-member">
                        <span className="member-avatar sm">{initialOf(member.name)}</span>
                        <div className="rooms-member-main">
                          <span className="member-name">@{member.name}</span>
                          <span className="room-card-meta">
                            {member.role === "main"
                              ? "主智能体（作战室）"
                              : member.brief || "作战室成员"}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={busy === `invite:${member.id}`}
                          onClick={() => void handleInvite(member)}
                        >
                          拉进来
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <p className="hint">
                  拉人时从作战室的成员池复制一份档案进群，记忆与技能白名单跟着走；
                  移出只影响这个群，作战室与其他群聊不受影响。
                  {mainMember ? ` 主智能体 @${mainMember.name} 会一直留在群里。` : ""}
                </p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
